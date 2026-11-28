/**
 * The shapes the third-party reports sweep works with (reports.ts): the lines it writes to a deal's check log, the
 * findings it compares a report with, and the kit of services the backend gives it.
 */
import type { DocRecord } from './documents';
import type { Sent, Cited, Unusable } from './agentKit';
import type { Source } from '../domain/model';
import type { ChangeShare } from './limits';
import { word } from './lenient';

/** a report read through, as written to the check log */
export interface ReadLine {
  doc: string;
  /** who wrote the report, in a few words */
  advisor: string;
  /** each issue it raised, with the finding written for it or the one that covers it */
  issues: ReadIssue[];
  /** an earlier draft whose issues this one was compared with */
  from?: string;
  /** findings of that draft's issues this one no longer raises */
  dropped?: string[];
  /** issues the last try gave with no page that opens, so not raised: counted, so none is lost without a trace */
  unplaced?: number;
  /**
   * the report's pages not yet added to findings that cover its issues (one in two versions waits for a person's
   * choice): added by a later sweep
   */
  owe?: Owed[];
}

/** pages of a report owed to a finding's sources */
export interface Owed { finding: string; sources: Source[] }

/** what the sweep writes to the deal's check log, one kind per line */
export interface ReportLine {
  /** documents whose paths the fast model was shown, and which of them it said are reports, or could not tell */
  sorted?: { docs: string[]; reports: string[]; unsure: string[] };
  /** a document the fast model looked at, as it could not tell from its path */
  looked?: { doc: string; report: boolean };
  read?: ReadLine;
  /** an owed page added to its finding, or no longer needed (the finding is gone) */
  cited?: { doc: string; finding: string };
  /** a look or a read that could not finish for want of a usable reply: after `TRIES` it is not asked again */
  tried?: { doc: string; step: 'look' | 'read' };
}

export interface ReadIssue { title: string; finding?: string; covered?: string }

/** a finding on the deal, as a report's issues are compared with it */
export interface Known {
  id: string;
  title: string;
  closed?: boolean;
  /** a person deleted it: an issue it covers is not raised again */
  deleted?: boolean;
}

/** a finding to write, as the sweep has it from the model */
export interface Issue {
  title: string;
  workstream: string;
  body: string[];
  sources: Source[];
  /** a closed finding on the same issue: a person settled that one, and the advisor raises it again */
  earlier?: string;
}

/** one call to the model */
export interface AskInput {
  kind: string;
  model: string;
  prompt: string;
  files?: string[];
  system?: string;
  split?: boolean;
  unusable?: Unusable;
}

/** a document put in the service's store: its file id, listing line and what was sent */
export interface SentDoc { files: string[]; listing: string; sent: Sent[] }

export interface ReportKit {
  dealId: string;
  /** the documents that may be reports: not a blackline, an earlier draft, another project's or a closed folder's */
  docs: DocRecord[];
  /** an earlier draft of a document, by the newest draft's id */
  earlier: Map<string, string[]>;
  /** the deal's check log, as written so far */
  lines: () => Promise<ReportLine[]>;
  say: (line: ReportLine) => Promise<void>;
  /** of these keys, the ones this PC now holds: none another PC is working on */
  claim: (keys: string[]) => Promise<string[]>;
  release: (keys: string[]) => Promise<void>;
  /** a document's path from the data room's own folder, as the model is shown it */
  where: (rec: DocRecord) => string;
  models: { fast: string; standard: string };
  /**
   * Read a reply as JSON. The initial parsed reply is sent back once if `correction` gives a reason.
   * Returns null when it cannot be read. Throws on service failure or with `code: 'cutoff'` and `partial` on a cut.
   */
  ask: (
    input: AskInput,
    keys: string[],
    correction?: (reply: Record<string, unknown>) => string | undefined,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * a reply naming an id it was not shown (the documents sent, and with `shown` those ids), or citing a document it
   * was not given, as `ask` refuses it (#1162)
   */
  unusable: (sent: Sent[], keys: string[], shown?: readonly string[]) => Unusable;
  /**
   * put a document in the service's store, listed for a prompt with its tracked changes as `share` leaves them
   * (#1381); null when it cannot be sent from this PC
   */
  send: (rec: DocRecord, share: ChangeShare) => Promise<SentDoc | null>;
  /** keep the citations that name the document sent and a page it has, and renumber the markers to match */
  fit: (text: string, cited: Cited[] | undefined, sent: Sent[]) => { text: string; sources: Source[] };
  workstreams: readonly string[];
  workstreamOf: (w: unknown) => string;
  fitParas: (p: string[]) => string[];
  /** the deal's findings, open, closed and deleted */
  findings: () => Promise<Known[]>;
  /**
   * write a new finding under this id; false when it could not be written. An id already there, or one a person
   * deleted, is not written again
   */
  raise: (id: string, issue: Issue) => Promise<boolean>;
  /**
   * add these places in the report to a finding's sources, past any it has: an advisor's report is always a source of
   * the issue it raises. False when it could not be written now
   */
  cite: (id: string, sources: Source[]) => Promise<boolean>;
  /** mark an open finding "May be out of date" with this reason */
  mark: (id: string, why: string) => Promise<void>;
  /** a finding's fixed id: the same on every PC for the same report and issue */
  idFor: (doc: string, title: string, n: number) => string;
  system: string;
}

/** paths shown to the fast model in one call when sorting */
export const SORT_PART = 150;
/** looks or reads of one document that could not finish before it is left alone, as describing a document is */
export const TRIES = 3;

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code;
/** a reply the service cut off: it carries what came back as `partial` */
export const isCut = (e: unknown) => codeOf(e) === 'cutoff';
/** the service could not be reached, or this PC is signed out: the whole sweep stops */
export const isUnreachable = (e: unknown) => codeOf(e) === 'unreachable';
/**
 * A failure that asking again later will not change: the document is too long for the model. The try is counted, and
 * the sweep goes on to the next report.
 */
export const isTooLong = (e: unknown) => codeOf(e) === 'toolong';
export const yes = (x: unknown) => x === true || ['true', 'yes'].includes(word(x));
