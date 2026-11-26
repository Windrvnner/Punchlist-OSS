/** What the chat agent (agent.ts) is given: the AI runners it works through, its options and the question. */
import type { Result } from '../domain/result';
import type { ModelThread, ResearchStep } from '../ports';
import type { Source } from '../domain/model';
import type { DocRecord } from './documents';
import type { ToolSpec } from './service';
import type { QaRecord } from './qaRow';

/** a document a model was given, with the tag it is cited by (D1, D2 …) */
export interface Sent { tag: string; dealId: string; rec: DocRecord }
/** a document of a deal, before it is given a tag */
export interface DealDoc { dealId: string; rec: DocRecord }
/** a citation as a model writes it */
export interface Cited {
  doc?: unknown;
  document?: unknown;
  page?: unknown;
  cell?: unknown;
  sheet?: unknown;
  quote?: unknown;
}
export type Ask = { kind: string; model: string; system?: string; prompt: string; files?: string[] };
/** one turn of a kept conversation, as `talk` takes it */
export type TalkAsk = Ask & {
  conversation?: string;
  tools?: ToolSpec[];
  results?: { id: string; text: string }[];
  tried?: number;
};
/** what a turn of a kept conversation gives back */
export type Talked = { reply: Record<string, unknown> | null; conversation: string; tokens?: number; calls?: string[] };
/** the documents in a folder a person named, as `folder` finds them */
export type FolderFound = { folders: string[]; docs: DealDoc[]; near: string[] };
/** what the search helper read: its reply and the documents it gave the model */
export type Looked = Result<{ reply: Record<string, unknown>; sent: Sent[] }>;
export type FindingRecord = { title: string; body: string[]; status: string };
/** a question of the Q&A log as the store holds it (qaRow.ts) */
export type QuestionRecord = QaRecord;

/** what the agent needs of the AI runners (ai.ts), which make it */
export interface AgentKit {
  models(): Promise<{ fast: string }>;
  /**
   * ask and read one JSON object, repairing it once if need be; null when it cannot be read. Throws when the service
   * fails.
   */
  askJson(input: Ask, keys: string[], shape: string): Promise<Record<string, unknown> | null>;
  records(dealId: string): DocRecord[];
  /**
   * the documents in the folder a person named, in the order to read them for `what`; `near` are folders that are
   * there, when none answers to the name
   */
  folder(deals: string[], said: string, what: string): Promise<FolderFound>;
  /**
   * the chat's document search as fixed pages: every document of these deals that answers to a word of the query, best
   * first by the keyword ranking, the deals taken in turn
   */
  ranking(deals: string[], query: string): Promise<DealDoc[]>;
  /** the search helper's reading of one page of that ranking, on the service, as it is: no pick, one round */
  readPage(deals: string[], model: string, ask: string, docs: DealDoc[]): Promise<Looked>;
  /** the words of a text as a search compares them; with `dealId`, the deal's short names given their long form too */
  words(text: string, dealId?: string): Set<string>;
  /** put documents in the store and list them for a prompt to `model`; `got` are those really there */
  send(sent: Sent[], model: string): Promise<{ files: string[]; listing: string; got: Sent[] }>;
  /** keep the citations that can be stood behind, renumbering the markers in the text */
  fit(text: string, cited: Cited[] | undefined, sent: Sent[], withDeal: boolean): { text: string; sources: Source[] };
  /** a document's path from its deal's folder, as prompts show it */
  where(rec: DocRecord): string;
  /** each blackline of a deal, by id, with its clean draft: a blackline is read with its clean draft */
  cleanDrafts?(dealId: string): Map<string, DocRecord>;
  /** null when the deal's records cannot be read just now: the agent is told so, never that the deal has none */
  findings(dealId: string): Promise<FindingRecord[] | null>;
  questions(dealId: string): Promise<QuestionRecord[] | null>;
  dealName(dealId: string): Promise<string>;
  /**
   * the deal's catch-up: two short paragraphs on what matters most in its open findings (ai.ts dealBrief), in plain
   * words with no finding links; none when it has no open findings
   */
  brief(dealId: string): Promise<Result<string[]>>;
  /**
   * Optional: one turn of a conversation the model service keeps, read as askJson reads a reply and repaired once in
   * the same conversation; `conversation` left out starts a new one. Throws with `code: 'gone'` when the service no
   * longer has it.
   */
  talk?(input: TalkAsk, keys: string[], shape: string): Promise<Talked>;
  /** how to call tools for this model; a turn with tools or results the model refuses throws with `code: 'tools'` */
  toolMode?(model: string): ToolMode;
  /**
   * the model refused a way of calling tools: it is called the next way down from now on; `sure` false: only if it
   * happens again
   */
  steppedDown?(model: string, to: ToolMode, sure?: boolean): void;
  /**
   * how many times a failed call may be asked again (decisions: Retries): 0 when retries are off
   */
  retries?(): number;
  /** put a conversation's transcript in the service's store, where the model can search it; the file's id */
  keepTranscript?(text: string): Promise<string>;
  /** take a file out of the service's store; one already gone is not an error */
  drop?(fileId: string): Promise<void>;
  /** the rules every answer keeps: citations, no ids, plain math */
  rules: string;
  now(): number;
}
/**
 * how the chat agent calls its tools: the JSON block in the reply, tool calls with results as a message, or tool calls
 * and tool results
 */
export type ToolMode = 'inline' | 'hybrid' | 'native';
export interface AgentOptions {
  /** about how many turns the main session takes before it is asked to answer with what it has (25) */
  turns?: number;
  /** most documents attached in one read, and in one batch of a folder review (8) */
  width?: number;
  /** a folder of more documents than this is read only once the person has agreed (200) */
  folderDocs?: number;
  /** findings or questions one search of them gives a page (control.limits.searchPage: 25) */
  searchPage?: number;
  /**
   * tokens at which a kept conversation is compacted (control.limits.compactAt: 125k), or that for each model, so that
   * a conversation never outgrows what one call may send
   */
  compactAt?: number | ((model: string) => number);
}
/**
 * `history` is the conversation's last messages as text; `transcript` all of it, for a compaction; `thread` the
 * service's conversation as the last answer left it
 */
export interface AgentQuestion {
  deals: string[];
  withDeal: boolean;
  model: string;
  message: string;
  about: string;
  history: string;
  must: Record<string, string[]>;
  runId?: string;
  thread?: ModelThread;
  transcript?: string;
  /** the conversation this question is in, as the window names it: what a folder read carries on in */
  conversation?: string;
}
/** an answer being worked on: its steps so far, when it started, and whether the person has stopped it */
export type Run = { steps: ResearchStep[]; t0: number; stopped: boolean };
/** the error code a service or the agent's own tools threw with, if any */
export const codeOf = (error: unknown) => (error as { code?: string })?.code;
