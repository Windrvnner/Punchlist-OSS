/**
 * The chat agent's folder tool (agent.ts): a whole folder read for something, a batch of `width` documents at a
 * time on the fast model, a few batches at once, the most important first. The whole folder is read, never part of it
 *, and a large one only once the person has agreed.
 */
import { strings } from './lenient';
import { folderKey } from './folderList';
import type { AgentRun } from './agentRun';
import { cites, dealDocKey, foundAt, sameDoc, withPlaces } from './agentRun';
import { codeOf, type Cited, type DealDoc, type Run, type Sent } from './agentKit';
import type { ResearchStep } from '../ports';
import { batchAsk, noun, oneLine, quoted, shorten } from './agentPrompts';

/** batches of a folder review read at the same time */
const AT_ONCE = 3;
/**
 * the most characters one folder read tells the main session of what it found: well inside a model's context however
 * large the folder
 */
const FOLDER_TEXT = 24_000;
/** about how many characters listing one document to cite adds to the main session's prompt */
const LISTING_CHARS = 60;
/** how many conversations the agent keeps folder reads and asks for */
const KEPT = 30;

/**
 * what a conversation has had read of a folder for something, by document, and whether the person agreed to it being
 * read whole
 */
type Place = { read: Set<string>; agreed: boolean };
/** a folder as listed for this run, by the folder's own name (or names, `; `-separated) */
type FolderList = { label: string; docs: DealDoc[] };
/** one batch of a folder read: its documents, and the places in the folder of the first and last it reads */
type Batch = { first: number; last: number; recs: DealDoc[] };
/** what a batch found, for the main session */
type BatchFinding = { at: string; tags: string; text: string; places: string; got: Sent[] };
/** one batch being read: its step, and the documents tagged for it, with those tagged before it */
type BatchReading = { index: number; batch: Batch; at: string; step: ResearchStep; sent: Sent[]; had: Set<Sent> };

/** keep the last few of a map, the most recent last */
function keepRecent<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > KEPT) map.delete(map.keys().next().value!);
}

/** what the agent keeps of folder reads from one answer to the next, for the app's run */
export class FolderMemory {
  /**
   * What each conversation has had read of each folder, for each thing (by document), and whether the person agreed to
   * a large one being read whole: so that "read on" in the same conversation carries on, and a new conversation reads
   * afresh. The last 30, for the app's run.
   */
  readonly places = new Map<string, Place>();
  /**
   * the large folders each conversation has asked the person about, by folder alone, with what it was to be read for
   * and the answer that asked
   */
  readonly asks = new Map<string, { lookFor: string; run: Run }>();
}

/** the folder tool for one answer */
export class FolderReader {
  /** the folder lists made in this run, by the folder as asked for and as found, each with what it was read for */
  private readonly lists = new Map<string, FolderList>();

  constructor(
    private readonly run: AgentRun,
    private readonly memory: FolderMemory,
    private readonly limits: { width: number; folderDocs: number },
  ) {}

  /**
   * Read a whole folder for something, a batch of `width` documents at a time, the most important first; what was
   * found, for the prompt. A folder read for the same thing before in this conversation reads only what was not read
   * then (documents added since included); for something else, or in another conversation, it is read again. More
   * than `folderDocs` documents still to read are read only when the person has `agreed`. What goes back is bounded
   * (`FOLDER_TEXT`): batches that found nothing are counted, not listed, and past the bound a batch that found
   * something gives its places only. Throws only when the service cannot be reached.
   */
  async read(said: string, lookFor: string, agreed: boolean): Promise<string> {
    const look = oneLine(lookFor).toLowerCase();
    const mark = this.run.steps.length;
    const folder = await this.list(said, lookFor);
    if (typeof folder === 'string') return folder;
    // the person agreeing to what they were asked: "all" holds for the folder they were asked about, read for what it
    // was asked for, however the model words it now
    const where = this.whereKey(folder.label);
    const ask = this.memory.asks.get(where);
    const yes = agreed && !!ask && ask.run !== this.run.progress;
    if (yes && oneLine(ask!.lookFor).toLowerCase() !== look) {
      this.run.steps.splice(mark);
      return this.read(said, ask!.lookFor, true);
    }
    // what this conversation has had read of this folder for this, by document: the list is made afresh each time, so
    // documents added since join it
    const key = `${where}|${look}`;
    const place = this.memory.places.get(key) ?? { read: new Set<string>(), agreed: false };
    keepRecent(this.memory.places, key, place);
    const total = folder.docs.length;
    const todo = folder.docs.filter((x) => !place.read.has(dealDocKey(x)));
    const toRead = todo.length;
    const readBefore = total - toRead;
    if (!toRead) {
      return `You have had all ${total} documents in ${folder.label} read for ${quoted(lookFor)} in this conversation `
        + 'already: what they say is above or in an earlier answer.';
    }
    const earlier = readBefore
      ? ` ${readBefore} of its documents were read for this earlier in this conversation; these are the other `
        + `${toRead}.`
      : '';
    // a large folder is read whole only once the person has said to: the app asks once, and takes "all" only in a later
    // answer than the one that asked; agreed, reading on does not ask again
    if (toRead > this.limits.folderDocs && !place.agreed) {
      if (!yes) {
        keepRecent(this.memory.asks, where, { lookFor, run: this.run.progress });
        return this.askFirst(folder.label, total, readBefore, toRead, earlier);
      }
      place.agreed = true;
      this.memory.asks.delete(where);
    }
    const pass = new FolderPass(this.run, { label: folder.label, lookFor, toRead }, this.batches(todo));
    // when it throws, nothing of it reached an answer: nothing is kept as read
    await pass.readAll();
    // a batch that failed is not kept as read, so reading on takes it again
    for (const id of pass.readNow) place.read.add(id);
    const summary = pass.summary();
    if (pass.stoppedEarly()) {
      return `The person stopped the reading of ${folder.label} for ${quoted(lookFor)} after ${pass.readCount} of `
        + `${toRead} documents, the most important first.${earlier} The rest were not read: if asked to read on, `
        + `use the folder tool with the same folder and lookFor, and it reads the ones not read yet.\n${summary}`;
    }
    const which = readBefore ? `the other ${toRead}` : `all ${toRead}`;
    return `You had ${which} documents in ${folder.label} read for ${quoted(lookFor)}, the most important first; `
      + `${pass.readCount} were read.${earlier}\n${summary}`;
  }

  /**
   * The folder's documents in the order to read them, listed once a run for the folder as asked for and for what it is
   * read for; or what to tell the main session when the folder is not there or has no documents.
   */
  private async list(said: string, lookFor: string): Promise<FolderList | string> {
    const look = oneLine(lookFor).toLowerCase();
    const asked = `${folderKey(said) || oneLine(said).toLowerCase()}|${look}`;
    const listed = this.lists.get(asked);
    if (listed) return listed;
    const step = this.run.step({ kind: 'search', text: `Listed the documents in ${quoted(said)} by priority` });
    const got = await this.run.kit.folder(this.run.question.deals, said, lookFor);
    if (!got.docs.length) {
      Object.assign(step, { result: got.folders.length ? 'no documents' : 'no such folder', done: true });
      if (got.folders.length) return `The folder ${got.folders.join('; ')} has no documents that can be read.`;
      const near = got.near.length ? ` The data room's folders include: ${got.near.join('; ')}.` : '';
      return `No folder answers to ${quoted(said)}.${near} Name a folder that is there, or search instead.`;
    }
    const label = got.folders.join('; ');
    // the same folder by another name is the same list
    const folder = this.lists.get(`${label}|${look}`) ?? { label, docs: got.docs };
    this.lists.set(asked, folder);
    this.lists.set(`${label}|${look}`, folder);
    Object.assign(step, { result: `${got.docs.length} ${noun(got.docs.length, 'document')}`, done: true });
    return folder;
  }

  /** the conversation (or, outside one, this run), the deals and the folder: what an ask and a place are kept by */
  private whereKey(label: string): string {
    const { question, progress } = this.run;
    const conversation = question.conversation ?? `run ${question.runId ?? progress.t0}`;
    return `${conversation}|${[...question.deals].sort().join(',')}|${label}`;
  }

  /** what the main session is told when a large folder waits for the person to agree */
  private askFirst(label: string, total: number, readBefore: number, toRead: number, earlier: string): string {
    const notYet = readBefore ? `, ${toRead} of them not read yet` : '';
    const which = readBefore ? `the other ${toRead}` : `all ${toRead} of them`;
    return `${label} has ${total} documents${notYet}, more than the ${this.limits.folderDocs} that are read without `
      + `asking.${earlier} Nothing more has been read. Answer now, with no tool, by asking the person whether to read `
      + `${which}, saying how many there are. If they agree, use the folder tool with the same folder and lookFor and `
      + '"all": true.';
  }

  /**
   * The batches: `width` documents each, a blackline with its clean draft (which may be outside the folder), counted
   * by their places in the folder.
   */
  private batches(todo: DealDoc[]): Batch[] {
    const { kit } = this.run;
    const batches: Batch[] = [];
    for (let i = 0; i < todo.length; i++) {
      const doc = todo[i];
      const recs = kit.withClean ? kit.withClean(doc.dealId, [doc.rec]) : [doc.rec];
      const pair = recs.map((rec) => ({ dealId: doc.dealId, rec }));
      let current = batches.at(-1);
      const notIn = (batch: Batch) => pair.filter((p) => !batch.recs.some((y) => sameDoc(y, p)));
      const full = !!current && current.recs.length > 0
        && current.recs.length + notIn(current).length > this.limits.width;
      if (!current || full) {
        current = { first: i + 1, last: i + 1, recs: [] };
        batches.push(current);
      }
      current.recs.push(...notIn(current));
      current.last = i + 1;
    }
    return batches;
  }
}

/** one folder read: its batches, read a few at a time, and what they found */
class FolderPass {
  /** what was opened before this read: still listed, whatever it finds */
  private readonly before: Set<Sent>;
  /** what this read was given and could read: kept for the conversation only if the read ends without failing */
  readonly readNow = new Set<string>();
  /** how many documents the batches read */
  readCount = 0;
  /** what each batch found, in the batches' order, whichever finishes first */
  private readonly findings: (BatchFinding | undefined)[] = [];
  /** the batches that found nothing */
  private quietBatches = 0;
  /** why each batch that could not be read was not, in the batches' order */
  private readonly failed: string[] = [];
  /** the next batch to start */
  private nextBatch = 0;
  private fast = '';

  /** `toRead`: how many of the folder's documents this read is of, not counting the clean drafts paired with them */
  constructor(
    private readonly run: AgentRun,
    private readonly folder: { label: string; lookFor: string; toRead: number },
    private readonly batches: Batch[],
  ) {
    this.before = new Set(run.opened);
  }

  /** whether the person stopped the read before every batch was started */
  stoppedEarly(): boolean {
    return this.nextBatch < this.batches.length;
  }

  /**
   * A few batches at a time, in order; a service that cannot be reached, or the person stopping it, starts no more.
   * Throws what the first batch to fail for good threw.
   */
  async readAll(): Promise<void> {
    this.fast = (await this.run.kit.models()).fast;
    let broke: unknown = null;
    const worker = async () => {
      while (!broke && !this.run.progress.stopped && this.nextBatch < this.batches.length) {
        const index = this.nextBatch++;
        try {
          await this.readBatch(index);
        } catch (e) {
          broke ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, this.batches.length) }, worker));
    if (broke) throw broke;
  }

  /**
   * One batch, read on the fast model; what it found is kept in `findings`, in the batch's place. Its two calls are
   * awaited here and nowhere deeper, so that batches read side by side interleave as they always have.
   */
  private async readBatch(index: number): Promise<void> {
    const { kit } = this.run;
    const reading = this.startBatch(index);
    try {
      const { files, listing, got } = await kit.send(reading.sent);
      if (!got.length) return this.notRead(reading, 'they could not be opened on this PC', 'could not be opened');
      const ask = { kind: 'folder', model: this.fast, system: kit.rules, files, prompt: this.ask(reading, listing) };
      const reply = await kit.askJson(ask, ['text', 'sources'], '{"text": "…", "sources": […]}');
      if (!reply) return this.notRead(reading, 'the reply on them could not be read', 'could not be read');
      this.keep(reading, got, reply);
    } catch (e) {
      const code = codeOf(e);
      if (code === 'unreachable') throw e;
      const why = code === 'toolong' ? 'they were too long to send together'
        : code === 'cutoff' ? 'the reply on them was cut off'
        : 'they could not be read';
      this.notRead(reading, why, 'could not be read');
    }
  }

  /** a batch's step, and its documents tagged to be listed to the model */
  private startBatch(index: number): BatchReading {
    const batch = this.batches[index];
    const at = batch.first === batch.last ? `Document ${batch.first}` : `Documents ${batch.first}–${batch.last}`;
    const text = `Reviewed ${at.toLowerCase()} of ${this.folder.toRead} in ${quoted(this.folder.label)}`;
    const step = this.run.step({ kind: 'read', text });
    // tagged to be listed to the model; a document it was not given after all loses its new tag and is not counted
    const had = new Set(this.run.opened);
    const sent = batch.recs.map((x) => this.run.tagOf(x.dealId, x.rec));
    return { index, batch, at, step, sent, had };
  }

  /** what a batch asks of the fast model */
  private ask(reading: BatchReading, listing: string): string {
    const { label, lookFor, toRead } = this.folder;
    const { first, last } = reading.batch;
    return batchAsk({ listing, first, last, count: toRead, label }, lookFor, this.run.question.message);
  }

  /** what a batch the fast model read found: kept for the main session, and its documents counted as read */
  private keep(reading: BatchReading, got: Sent[], reply: Record<string, unknown>): void {
    const { kit } = this.run;
    const { batch, step } = reading;
    this.untagNew(reading, got);
    this.readCount += got.length;
    for (const x of batch.recs) if (got.some((g) => sameDoc(g, x))) this.readNow.add(dealDocKey(x));
    const { text, sources } = kit.fit(strings(reply.text).join(' '), reply.sources as Cited[], got, true);
    const tags = this.run.tagsOf(sources);
    // a document that said nothing on this is not listed to the model again; one cited is
    for (const s of got) {
      if (sources.some((x) => cites(x, s))) this.run.quiet.delete(s);
      else if (!reading.had.has(s)) this.run.quiet.add(s);
    }
    if (sources.length) step.found = sources.map(foundAt);
    if (!sources.length) {
      this.quietBatches++;
      finish(step, 'nothing on this');
      return;
    }
    this.findings[reading.index] = {
      at: reading.at,
      tags: got.map((x) => x.tag).join(', '),
      text: shorten(withPlaces(text, tags, sources), 1200),
      places: [...new Set(sources.map((x, i) => `${tags[i]} ${x.loc}`))].join(', '),
      got,
    };
    finish(step, `${sources.length} ${noun(sources.length, 'passage')}`);
  }

  /** a batch that could not be read: its documents lose their new tags, and why is told to the main session */
  private notRead(reading: BatchReading, why: string, result: string): void {
    this.untagNew(reading, []);
    this.failed[reading.index] = `${reading.at.toLowerCase()} (${why})`;
    finish(reading.step, result);
  }

  /** the documents tagged for this batch that were new to it and the model was not given lose their tags */
  private untagNew(reading: BatchReading, keep: Sent[]): void {
    for (const s of reading.sent) if (!keep.includes(s) && !reading.had.has(s)) this.run.untag(s);
  }

  /** what the batches found, bounded, with what found nothing and what could not be read */
  summary(): string {
    const found = this.boundedFindings();
    const said = found.length ? `What they say:\n${found.join('\n')}` : 'None of them says anything about it.';
    const quiet = this.quietBatches && found.length
      ? `\n${this.quietBatches} ${noun(this.quietBatches, 'batch', 'batches')} said nothing about it; their documents `
        + 'are not listed, but can be read by path.'
      : '';
    const failed = this.failed.some(Boolean) ? `\nNot read: ${this.failed.filter(Boolean).join('; ')}.` : '';
    return `${said}${quiet}${failed}`;
  }

  /**
   * What was found, bounded: in full for the first half of the room, then by its places alone; a batch past the room
   * is counted, and its documents are not listed to the model, so the prompt stays bounded however large the folder.
   */
  private boundedFindings(): string[] {
    let used = 0;
    let over = 0;
    const lines: string[] = [];
    for (const finding of this.findings) {
      if (!finding) continue;
      const full = `${finding.at}: ${finding.tags}. ${finding.text}`;
      const short = `${finding.at}: passages at ${finding.places}.`;
      const newDocs = finding.got.filter((x) => !this.before.has(x));
      const listing = newDocs.length * LISTING_CHARS;
      const line = used + full.length + listing <= FOLDER_TEXT / 2 ? full
        : used + short.length + listing <= FOLDER_TEXT ? short
        : '';
      if (line) {
        lines.push(line);
        used += line.length + listing;
      } else {
        over++;
        for (const x of newDocs) this.run.quiet.add(x);
      }
    }
    if (over) {
      const batches = `${over} more ${noun(over, 'batch', 'batches')}`;
      lines.push(`${batches} found passages, past what fits here: search the folder for what they hold.`);
    }
    return lines;
  }
}

/** a step done, with its result */
function finish(step: ResearchStep, result: string): void {
  Object.assign(step, { result, done: true });
}
