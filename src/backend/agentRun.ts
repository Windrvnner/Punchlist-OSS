/**
 * One answer of the chat agent (agent.ts) as it is worked out: the documents a model was given, cited by id, the
 * steps the window shows, what each tool found for the main session, and the read tool, which attaches documents to
 * the main session's next turn.
 */
import type { ModelThread, ResearchStep } from '../ports';
import type { Source } from '../domain/model';
import type { DocRecord } from './documents';
import type { AgentKit, AgentQuestion, DealDoc, Run, Sent } from './agentKit';
import { oneLine } from './agentPrompts';
import { questionIdsIn } from './qaRow';
import { docHandle } from './recordIds';
import { batchesOf, sameDoc } from './agentBatches';

/** a document's key across deals, as a folder read keeps what it has read */
export const dealDocKey = (doc: { dealId: string; rec: DocRecord }) => `${doc.dealId}|${doc.rec.docId}`;
/** whether a source cites this document */
export const cites = (source: Source, doc: Sent) => source.dealId === doc.dealId && source.docId === doc.rec.docId;
/** a source as a step shows it: where it is and the words it quotes */
export const foundAt = (source: Source) =>
  ({ where: `${source.doc}, ${source.loc}`, quote: source.quote ? `“${oneLine(source.quote)}”` : '' });
/** a text's [n] markers as the main session reads them: the id and place of the source each one names */
export const withPlaces = (text: string, ids: string[], sources: Source[]) =>
  text.replace(/\[(\d+)\]/g, (_m, n) => `[${ids[+n - 1] ?? '?'} ${sources[+n - 1]?.loc ?? ''}]`);

/** How a turn would change the run if the model accepts these attachments. */
export interface ReadAttachment {
  got: Sent[];
  opened: Sent[];
  shown: Sent[];
  done: string[];
  missing: string[];
}

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
  /** documents the conversation opened that are no longer here: kept with it */
  readonly gone: ModelThread['opened'] = [];
  /** the documents attached to the main session's turns, until the next read */
  whole: Sent[] = [];
  /** what each tool found, in order: what the main session is told it has done so far */
  readonly done: string[] = [];
  /** the result of the read whose files have yet to be attached */
  private readResult: number | undefined;
  /** ids the model can request in a read after the files were deferred or unavailable */
  private readonly readTargets = new Set<string>();
  /** the searches made in this run, so that the same one is not made twice */
  readonly searched = new Set<string>();
  /** what the main session has learned so far, as it last wrote it */
  notes = '';
  /**
   * how many characters the model holds once the turn is sent again: the agent sets it, counting a kept conversation's
   * tokens (#480)
   */
  held: () => number = () => 0;
  /**
   * `pages`: how many a search gives at a time, documents (`width`) and findings or questions (`searchPage`), as the
   * agent's limits set them; `chars`: the most characters a page of findings or questions may hold (half of
   * `limit`, so that a page asked for by number is cut the same each time); `limit`: the characters a turn's prompt
   * may hold before the conversation is compacted
   */
  constructor(
    readonly kit: AgentKit,
    readonly question: AgentQuestion,
    readonly progress: Run,
    readonly pages: { width: number; searchPage: number; chars: number; limit: number },
  ) {
    if (kit.talk) this.keepOpened(question.thread?.opened ?? []);
  }

  /**
   * whether the run's prompts name each document with its deal (#1162): whenever the conversation may span deals (asked
   * on Home), however many it spans now, so that a later turn names a document by the id it was first shown by
   */
  get spansDeals(): boolean {
    return this.question.withDeal;
  }

  /** the id a document is cited by in this run's prompts */
  idOf(doc: DealDoc): string {
    return docHandle(doc, this.spansDeals);
  }

  get steps(): ResearchStep[] {
    return this.progress.steps;
  }

  /** a kept conversation already showed the model some documents: they may still be cited, by their ids */
  private keepOpened(opened: ModelThread['opened']): void {
    const deals = this.question.deals;
    for (const kept of opened) {
      const rec = deals.includes(kept.dealId)
        ? this.kit.records(kept.dealId).find((r) => r.docId === kept.docId)
        : undefined;
      if (!rec) {
        this.gone.push(kept);
        continue;
      }
      const doc = { dealId: kept.dealId, rec };
      if (!this.opened.some((x) => sameDoc(x, doc))) this.opened.push(doc);
    }
  }

  /** a document a model is given in this run, opened if it was not yet */
  open(dealId: string, rec: DocRecord): Sent {
    let sent = this.opened.find((x) => sameDoc(x, { dealId, rec }));
    if (!sent) {
      sent = { dealId, rec };
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

  /** the ids of the documents these sources cite, '?' for one not given to a model */
  idsOf(sources: Source[]): string[] {
    return sources.map((s) => {
      const doc = this.opened.find((x) => cites(s, x));
      return doc ? this.idOf(doc) : '?';
    });
  }

  /**
   * the most characters one tool result may add to the turn's prompt: half of what is left of the room before the
   * conversation is compacted, so earlier results and the next one together stay within it (#480)
   */
  room(): number {
    return (this.pages.limit - this.held()) / 2;
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
    const picked: DealDoc[] = [];
    const missing: string[] = [];
    for (const name of named) {
      // a name is tried as the model wrote it first, so a document whose own name starts or ends with a bracket or
      // quote is found; only when nothing matches is the model's wrapping quote or bracket taken off
      const said = name.trim();
      const unwrapped = said.replace(/^["'`[]+|["'`\]]+$/g, '');
      const open = this.opened.find((x) => this.idOf(x) === name);
      const doc = open ?? (this.canRequest(name)
        ? recs.find((x) => this.idOf(x) === name)
        : this.byPath(said, recs) ?? this.byPath(unwrapped, recs));
      if (doc) picked.push(doc);
      else missing.push(unwrapped);
    }
    const deferred = this.readBatch(picked, width);
    const notFound = missing.length
      ? `Not found: ${missing.join('; ')}. Name a document by its id or its unique path as listed.`
      : '';
    return [deferred, notFound].filter(Boolean).join('\n');
  }

  /** attach the first batch of resolved documents and report any that still need a read */
  readBatch(picked: DealDoc[], width: number): string {
    const unique = [...new Map(picked.map((doc) => [dealDocKey(doc), doc])).values()];
    const batch = batchesOf(unique, this.kit.cleanDrafts, width)[0]?.recs ?? [];
    this.whole = batch;
    this.readResult = this.done.length;
    const deferred = unique.filter((doc) => !batch.some((picked) => sameDoc(doc, picked)));
    return deferred.length
      ? `Ask to read the remaining documents by id in another batch.\n${this.readList(deferred)}` : '';
  }

  /** The prompt and reply validator use the same proposed attachments, even on a fresh retry (#1430). */
  attachment(got: Sent[]): ReadAttachment {
    const inCall = (doc: Sent) => got.some((s) => sameDoc(doc, s));
    const newlyOpened = got.filter((doc) => !this.opened.some((s) => sameDoc(doc, s)));
    const opened = [...this.opened, ...newlyOpened];
    const shown = opened.filter((s) => !this.quiet.has(s) || inCall(s));
    const done = [...this.done];
    if (this.readResult === undefined) return { got, opened, shown, done, missing: [] };
    const missing = this.whole.filter((doc) => !inCall(doc));
    const attached = got.length ? `Attached for reading ${got.map((s) => this.idOf(s)).join(', ')}.`
      : 'No document was attached.';
    const unavailable = missing.length ? `These files could not be attached.\n${this.readLines(missing)}` : '';
    done[this.readResult] = [attached, done[this.readResult], unavailable].filter(Boolean).join('\n');
    return { got, opened, shown, done, missing: missing.map((doc) => this.idOf(doc)) };
  }

  /** Only an accepted turn may add files to the citation list, count and read steps (#12, #1213). */
  attached(attachment: ReadAttachment): void {
    this.whole = attachment.got;
    const result = this.readResult;
    if (result === undefined) return;
    this.readResult = undefined;
    this.done[result] = attachment.done[result];
    for (const id of attachment.missing) this.readTargets.add(id);
    for (const s of this.whole) {
      this.open(s.dealId, s.rec);
      const pages = s.rec.pages ? `${s.rec.pages} pages` : '';
      this.steps.push({ kind: 'read', text: `Reviewed ${s.rec.name}`, result: pages, done: true });
    }
  }

  /** whether a tool result gave the model an id to request in another read */
  canRequest(handle: unknown): boolean {
    return typeof handle === 'string' && this.readTargets.has(handle);
  }

  /** name an unread file by its existing id, even when another file has the same display path */
  private readList(docs: DealDoc[]): string {
    for (const doc of docs) this.readTargets.add(this.idOf(doc));
    return this.readLines(docs);
  }

  private readLines(docs: DealDoc[]): string {
    return docs.map((doc) => `- ${this.idOf(doc)} (${this.kit.where(doc.rec)})`).join('\n');
  }

  /** a unique document named by its whole path or its whole file name, in any case */
  private byPath(said: string, recs: DealDoc[]): DealDoc | undefined {
    const low = said.toLowerCase();
    const matches = recs.filter(({ rec }) =>
      this.kit.where(rec).toLowerCase() === low || rec.name.toLowerCase() === low);
    return matches.length === 1 ? matches[0] : undefined;
  }
}
