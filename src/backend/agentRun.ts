/**
 * One answer of the chat agent (agent.ts) as it is worked out: the documents a model was given and their tags, the
 * steps the window shows, what each tool found for the main session, and the read tool, which attaches documents to
 * the main session's next turn.
 */
import type { ModelThread, ResearchStep } from '../ports';
import type { Source } from '../domain/model';
import type { DocRecord } from './documents';
import type { AgentKit, AgentQuestion, DealDoc, Run, Sent } from './agentKit';
import { oneLine } from './agentPrompts';
import { questionIdsIn } from './qaRow';

/** a document's key across deals, as a folder read keeps what it has read */
export const dealDocKey = (doc: { dealId: string; rec: DocRecord }) => `${doc.dealId}|${doc.rec.docId}`;
/** whether two documents are the same document of the same deal */
export const sameDoc = (a: { dealId: string; rec: DocRecord }, b: { dealId: string; rec: DocRecord }) =>
  a.dealId === b.dealId && a.rec.docId === b.rec.docId;
/** whether a source cites this document */
export const cites = (source: Source, doc: Sent) => source.dealId === doc.dealId && source.docId === doc.rec.docId;
/** a source as a step shows it: where it is and the words it quotes */
export const foundAt = (source: Source) =>
  ({ where: `${source.doc}, ${source.loc}`, quote: source.quote ? `“${oneLine(source.quote)}”` : '' });
/** a text's [n] markers as the main session reads them: the tag and place of the source each one names */
export const withPlaces = (text: string, tags: string[], sources: Source[]) =>
  text.replace(/\[(\d+)\]/g, (_m, n) => `[${tags[+n - 1] ?? '?'} ${sources[+n - 1]?.loc ?? ''}]`);

export class AgentRun {
  /** every document a model was given in this conversation: what may be cited */
  readonly opened: Sent[] = [];
  /** those given in this run: what "N of M documents searched" counts */
  readonly touched = new Set<Sent>();
  /**
   * documents a folder read gave a model that said nothing on it: not listed to the main session, to keep its prompt
   * small (they can still be cited or read by path)
   */
  readonly quiet = new Set<Sent>();
  /** tags of documents no longer here: kept, so that their numbers are not used again */
  readonly gone: ModelThread['tags'] = [];
  /** the documents attached to the main session's turns, until the next read */
  whole: Sent[] = [];
  /** what each tool found, in order: what the main session is told it has done so far */
  readonly done: string[] = [];
  /** the searches made in this run, so that the same one is not made twice */
  readonly searched = new Set<string>();
  /** what the main session has learned so far, as it last wrote it */
  notes = '';
  /** the number of the next tag */
  private nextTag = 1;

  /**
   * `pages`: how many a search gives at a time, documents (`width`) and findings or questions (`searchPage`), as the
   * agent's limits set them; `chars`: the most characters a page of findings or questions may hold (agent.ts
   * `pageChars`)
   */
  constructor(
    readonly kit: AgentKit,
    readonly question: AgentQuestion,
    readonly progress: Run,
    readonly pages: { width: number; searchPage: number; chars: number },
  ) {
    if (kit.talk) this.keepTags(question.thread?.tags ?? []);
  }

  get steps(): ResearchStep[] {
    return this.progress.steps;
  }

  /**
   * A kept conversation already showed the model some documents, by tag: they keep their tags, and new ones number
   * on from them.
   */
  private keepTags(tags: ModelThread['tags']): void {
    const deals = this.question.deals;
    for (const kept of tags) {
      const number = /^D(\d+)$/.exec(kept.tag);
      if (!number) continue;
      this.nextTag = Math.max(this.nextTag, +number[1] + 1);
      const rec = deals.includes(kept.dealId)
        ? this.kit.records(kept.dealId).find((r) => r.docId === kept.docId)
        : undefined;
      if (!rec) {
        this.gone.push(kept);
        continue;
      }
      const doc = { dealId: kept.dealId, rec };
      const known = this.opened.some((x) => x.tag === kept.tag || sameDoc(x, doc));
      if (!known) this.opened.push({ tag: kept.tag, ...doc });
    }
  }

  /** a document a model is given in this run: its tag, a new one if it has none yet */
  tagOf(dealId: string, rec: DocRecord): Sent {
    let sent = this.opened.find((x) => sameDoc(x, { dealId, rec }));
    if (!sent) {
      sent = { tag: `D${this.nextTag++}`, dealId, rec };
      this.opened.push(sent);
    }
    this.touched.add(sent);
    this.quiet.delete(sent);
    return sent;
  }

  /**
   * The number each question named in `texts` has now in the run's deals, by its record id, so that a question
   * renumbered since the model was shown it is named by its new number; a question no longer there has none (#1105)
   */
  async questionNumbers(texts: string[]): Promise<Map<string, number>> {
    const numbers = new Map<string, number>();
    const named = questionIdsIn(texts.join('\n'));
    if (!named.length) return numbers;
    for (const dealId of this.question.deals) {
      for (const record of (await this.kit.questions(dealId)) ?? []) {
        if (named.includes(record.id) && record.n !== undefined) numbers.set(record.id, record.n);
      }
    }
    return numbers;
  }

  /** a document tagged for a model that was not given it after all: it loses its tag and is not counted */
  untag(sent: Sent): void {
    this.opened.splice(this.opened.indexOf(sent), 1);
    this.touched.delete(sent);
  }

  /** the tags of the documents these sources cite, '?' for one not given to a model */
  tagsOf(sources: Source[]): string[] {
    return sources.map((s) => this.opened.find((x) => cites(s, x))?.tag ?? '?');
  }

  /** the documents listed to the main session: those opened, less the quiet ones */
  shown(): Sent[] {
    return this.opened.filter((s) => !this.quiet.has(s));
  }

  /** a new step, shown as being worked on */
  step(s: Omit<ResearchStep, 'done' | 'result'>): ResearchStep {
    const made: ResearchStep = { ...s, result: '', done: false };
    this.steps.push(made);
    return made;
  }

  /** the read tool: attach documents to the main session from its next turn; what it found, for the prompt */
  read(named: string[], width: number): string {
    const recs = this.question.deals.flatMap((dealId) =>
      this.kit.records(dealId).map((rec) => ({ dealId, rec })));
    const picked: Sent[] = [];
    const missing: string[] = [];
    for (const name of named) {
      // a name is tried as the model wrote it first, so a document whose own name starts or ends with a bracket or
      // quote is found; only when nothing matches is the model's wrapping quote or bracket taken off
      const said = name.trim();
      const unwrapped = said.replace(/^["'`[]+|["'`\]]+$/g, '');
      const tag = /^d\s*(\d+)$/i.exec(unwrapped);
      const sent = tag ? this.opened.find((x) => x.tag === `D${+tag[1]}`)
        : this.byPath(said, recs) ?? this.byPath(unwrapped, recs);
      if (sent && !picked.includes(sent)) picked.push(sent);
      else if (!sent) missing.push(unwrapped);
    }
    const paired = this.withCleanDrafts(picked);
    this.whole = paired.slice(0, width);
    for (const s of this.whole) this.touched.add(s);
    for (const s of this.whole) {
      const pages = s.rec.pages ? `${s.rec.pages} pages` : '';
      this.steps.push({ kind: 'read', text: `Reviewed ${s.rec.name}`, result: pages, done: true });
    }
    const attached = this.whole.length
      ? `You asked to read ${this.whole.map((s) => s.tag).join(', ')}: they are attached to this message.`
      : 'No document was attached.';
    const capped = picked.length > width ? ` Only the first ${width} were attached: ${width} at most at a time.` : '';
    const notFound = missing.length
      ? ` Not found: ${missing.join('; ')}. Name a document by its tag or its path as listed.`
      : '';
    return `${attached}${capped}${notFound}`;
  }

  /** a document named by its whole path or its whole file name, in any case; anything else is not found */
  private byPath(said: string, recs: DealDoc[]): Sent | undefined {
    const low = said.toLowerCase();
    const found = recs.find((x) => this.kit.where(x.rec).toLowerCase() === low || x.rec.name.toLowerCase() === low);
    return found ? this.tagOf(found.dealId, found.rec) : undefined;
  }

  /** these documents with each blackline's clean draft put just before it, each once */
  private withCleanDrafts(picked: Sent[]): Sent[] {
    if (!this.kit.cleanDrafts) return picked;
    const deals = new Set(picked.map((s) => s.dealId));
    const cleans = new Map([...deals].map((dealId) => [dealId, this.kit.cleanDrafts!(dealId)]));
    const paired = picked.flatMap((s) => {
      const clean = cleans.get(s.dealId)?.get(s.rec.docId);
      return clean ? [this.tagOf(s.dealId, clean), s] : [s];
    });
    return paired.filter((s, i, all) => all.indexOf(s) === i);
  }
}
