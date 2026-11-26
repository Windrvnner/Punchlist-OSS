/**
 * The AI runners: the app's AiService, the first pass, and what follows from new documents and new responses.
 *
 * All of them work the same way. Choose the few documents worth reading, make sure they are in the model service's store,
 * ask one question as text and read one answer as text. The model service searches the documents it is given with its
 * own tools; nothing here chooses passages. The answer must be JSON in a shape given in the prompt; anything in it that
 * cannot be checked against what we hold (a document we did not send, a page the document does not have) is dropped
 * rather than passed on.
 *
 * Which model:
 *   - the fast model does the cheap sorting: which documents a call should read, what a document is (asked only of
 *     documents that are read), where the table is in a spreadsheet;
 *   - the standard model does the answering the backend chooses a model for: the first pass, a reassessment, the brief,
 *     whether an answer addresses a question;
 *   - the thorough model is a fallback only. When the standard model's reply cannot be used it is sent back to the
 *     standard model with what is wrong with it, to be put right; the thorough model is asked only if that fails too;
 *   - a chat answer uses the model the person chose; a draft goes to the standard model.
 *
 * Reading as little as possible:
 *   - indexing asks no model and uploads nothing. Each document is known by its path and by the words it uses most,
 *     which the document service counts on the PC;
 *   - `core.ts` works out a deal's core documents on each PC without a model or cap. Deal-specific short names are
 *     learned from paths without a model. The expectation is that core documents settle most of what is asked;
 *   - the best 100 core documents are described up front; other documents are described the first time a call is given
 *     them. A description is a summary and search terms, written once and kept;
 *   - one call is given a handful of documents, eight unless set otherwise: more than about ten and answers get worse.
 *     More documents means more calls, not bigger ones;
 *   - which handful is settled in two steps. A keyword search ranks the deal's files against what is being asked: no
 *     model, the same answer every time. Then the fast model picks from the top hundred of that ranking, each shown by
 *     path and summary (or its most-used words, if it has not been described) with the best core documents marked. If
 *     it cannot be asked, the top of the ranking is read as it stands;
 *   - a further document is read only when the answering model says what is missing;
 *   - the deal brief is asked for again only when the findings have changed; gaps cost no call at all.
 *
 * What it costs is counted: every call to the model service is tallied by what it was for and which model took it, and
 * each run reports its tally through `usage` when it ends.
 *
 * Nothing here asks the person a question part-way: every call and every run ends with a result or a failure.
 */
import { withoutDraftCredits } from './draftReply';
import { MODEL_TEXT_MAX, fitText, fitParas } from '../domain/importExport';
import { withoutMarkers } from '../domain/cite';
import { ok, fail, type Failure, type Result } from '../domain/result';
import type { AiService, Repository, CheckSummary, CheckState, DealProgress, ChecklistRow, PhraseItem } from '../ports';
import { WORKSTREAMS, CHECK_REASON, type Provenance, type Question, type Source } from '../domain/model';
import type { ConverseInput, Conversed, ModelService } from './service';
import type { ToolMode } from './agent';
import { withSignInCap } from './signInToken';
import type { StoreKeeper } from './storeKeeper';
import type { DocRecord, Review } from './documents';
import type { Folder } from './logRepository';
import { appendOwn, dealFiles, healOwn, wholeLines } from './ownFile';
import { createHash } from 'node:crypto';
import { ListRecord, Item, firmOf, orderItems, key } from '../domain/checklist';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ulid } from 'ulid';
import {
  readJson, unfinished, list as listOf, strings, prose, PARAGRAPH_SEAM, int, pageOf, word, isObject,
} from './lenient';
import type { LineRead } from '../domain/listRead';
import { cutOff, isCutOff, isTooLong, tokensOf, tooLong, TOO_LONG_REPLY, TOO_LONG_ASK } from './limits';
import { UNREAD_REPLY, UNUSABLE_REPLY, UNREACHED, CUT_ON_IT, CUT_BEFORE_IT, UNUSABLE_ON_IT } from './limits';
import { inParts, partSize, type PartReply, type PartsDone } from './parts';
import { tokens, fold, indexWords } from './words';
import type { WordIndex } from './wordIndex';
import { families, roomPath } from './families';
import { foldersOf, matchFolders, inside } from './folderList';
import { cleanDrafts, againstOf, otherProject, isBlackline, type Against } from './blacklines';
import { coreSet, shortNamesIn, BEST as CORE_BEST } from './core';
import { sweep as sweepReports, type ReportLine } from './reports';
import {
  ReportSweeps, knownFindings, raiseFinding, citeFinding, reportFindingId, reportCandidates,
} from './reportsKit';
import { docFamilies } from './related';
import type { ChangeList } from './convert';
import { chatAgent, type AgentKit, type Sent, type Cited } from './agent';
import { AI_DRAFTED, questionIdsIn, questionsForIds, responseHeader } from './qaRow';
import { citesUnsent, docHandle, docsUnusable, namesOnlyShown, sentAs, unknownIds, unknownInPairs } from './recordIds';
import type { DealDoc, Looked, Unusable } from './agentKit';
import {
  RATINGS, riskGroups, keyRisksOf, unratedFindings, type Grouped, type Rating, type RiskGroup,
} from '../domain/memo';
import { SERVICE, control } from '../control';
import { view, openRounds, serves, factsOf, finishedAt, need, undone, blockOf, unitOf, owner, findingIdFor, docsHash, isItem, itemOf, findingOf, counts, Observer, type View, type RoundState, type RoundKind, type RoundDef, type Piece, type RLine, type PieceFacts } from './rounds';
import { retrier, type RetryOptions } from './retry';

/** One thing the first pass checks. `id` is the checklist's own and must stay the same from run to run. */
export interface ChecklistItem { id: string; text: string; /** its section and subsection headings, where its list has them: they help match it to documents (core.ts) */ heads?: string }
/**
 * What a deal is checked against. It is written by the firm and supplied from outside this code, in four layers: one
 * broad list for every deal, and one each for the deal's structure (`product`), sector and technology.
 */
export interface Checklist { broad: ChecklistItem[]; product: ChecklistItem[]; sector: ChecklistItem[]; /** the list for the deal's technology, when the firm keeps one */ technology?: ChecklistItem[] }

/** what the runners need of the document service */
export interface AiDocs {
  records(dealId: string): DocRecord[];
  wanted(dealId: string, docIds: string[]): Promise<{ docId: string; name: string; read: () => Uint8Array | Promise<Uint8Array> }[]>;
  /** which of these documents cannot be read on this PC just now though they have not left the deal (their folder cannot be reached, or the file is locked); without it, none */
  away?(dealId: string, docIds: string[]): string[];
  /** of these documents, those out of reach because a folder they are in may not be opened by this person, with that folder; without it, none */
  shut?(dealId: string, docIds: string[]): Map<string, string>;
  /** folders inside the deal's folders that a PC could not open and whose files no PC has read: no check is complete while there are any */
  unread?(dealId: string): string[];
  /** keep what the fast model said a document is; without it no document is described */
  describe?(dealId: string, docId: string, review: Review): void;
  /** note a failed try to describe a document, so that every PC counts it; without it the tries are counted for this run of the app only */
  undescribed?(dealId: string, docId: string): void;
  /** this PC's index of every word in each document; without it a document is found by its path, most-used words and summary */
  wordIndex?: WordIndex;
  /** whether this PC is indexing the deal's folders now; without it, never */
  indexing?(dealId: string): boolean;
  /** a Word file's tracked changes, read from the file; without it the model is told only how many there are */
  changes?(dealId: string, docId: string): Promise<Result<ChangeList>>;
}
/** What one kind of call cost in a run: how many calls, how many documents they were given, and the characters sent and received (the documents' own text is not counted: the model service reads those itself). */
export interface UsageLine { kind: string; model: string; calls: number; docs: number; sent: number; received: number }
/**
 * One run's calls. `run` is what was run: firstPass, checkAll, responses, describe, reports (third-party reports read
 * for their issues), core (a large core choice, in the background), answer, draft, reassess, dealBrief, memo, layout,
 * issuesList.
 */
export interface UsageEntry { run: string; dealId?: string; at: string; calls: UsageLine[] }
export interface AiOptions {
  /** a deal's core documents, given instead of worked out (tests that are about something else) */
  coreFor?: (dealId: string) => string[];
  /** the synonyms library the core set is worked out with (default: control.lists.synonyms); with no checklist, its groups stand in for items (core.ts) */
  library?: string[][];
  /** `converse`, where the service has it, makes a chat one conversation there; `upload` and `remove` then keep its transcript at a compaction */
  service: Pick<ModelService, 'complete' | 'models'> & Partial<Pick<ModelService, 'converse' | 'upload' | 'remove' | 'outputLimit' | 'inputLimit'>>;
  docs: AiDocs; keeper: Pick<StoreKeeper, 'ensure'>; repo: Repository;
  /** tell the window about a finding the first pass wrote */
  announce?: (kind: 'finding', id: string) => void;
  /** what each run cost in calls, told when the run ends; a run that made no call tells nothing */
  usage?: (entry: UsageEntry) => void;
  /** why a document outside the core set was read: called once per branch-out */
  trace?: (entry: { dealId: string; reason: string; docs: string[] }) => void;
  /** The deal's checklist, in its four layers. Without it the first pass checks nothing and there are no gaps. */
  checklist?: (deal: { id: string; name: string; product: string; sector: string } & Record<string, unknown>) => Checklist | Promise<Checklist>;
  /** where the outcome of each checklist item is kept, so that every PC on the deal shows the same gaps; in memory without it */
  shared?: Pick<Folder, 'list' | 'read' | 'append'> & Partial<Pick<Folder, 'size'>>;
  /** this PC's own folder: a copy of its check log is kept there, so lines the sync client loses can be put back */
  local?: Folder;
  installId?: string;
  /** this PC's name as the others see it, said beside the work it has claimed (see `claim`) */
  label?: string;
  /** the person at this PC, so the others can say who is doing a check with them */
  person?: () => string;
  /** how many documents one call is given (default: control.limits.docsPerCall) */
  width?: number;
  /** how many of the best-ranked documents the fast model picks from (default: control.limits.shortlist) */
  shortlist?: number;
  /** most calls one search run of the chat agent, or of the checks, makes (default: control.limits.searchCalls) */
  searchCalls?: number;
  /** a folder of more documents than this is read by the chat agent only once the person agrees (default: control.limits.folderDocs) */
  folderDocs?: number;
  /** findings or questions one search of them gives the chat agent a page (default: control.limits.searchPage) */
  searchPage?: number;
  /** how blacklines are read (default: control.blackline.pipeline): A, the model cannot see strike-through and colors; B, it can */
  blackline?: 'A' | 'B';
  /** about how many turns the chat agent takes before it answers with what it has (default: control.limits.chatTurns) */
  turns?: number;
  /** tokens at which a chat's kept conversation is compacted (default: control.limits.compactAt) */
  compactAt?: number;
  /** how the chat agent calls its tools in a kept conversation (default: control.models.toolCalls) */
  toolCalls?: ToolMode;
  /** how many checklist items are checked in one call (default: control.limits.itemsPerCall) */
  batch?: number;
  clock?: () => string; newId?: () => string;
  /** whether this PC's own check file is in sync with the shared folder (the shell asks Windows); in touch without it */
  inTouch?: () => boolean | Promise<boolean>;
  /** the times rounds work by (docs/architecture.md, Checks, and how PCs share them); the defaults are the design's, tests give short ones */
  timing?: Partial<Timing>;
  /** this PC's clock in milliseconds, for judging who is live; read from `clock` without it */
  now?: () => number;
  /** how a failed or empty AI call is asked again (src/backend/retry.ts); the control file's values unless set, tests give short waits */
  retry?: RetryOptions;
}
/**
 * The times two or more PCs share a deal's checks by. `lapse`: a PC seen doing nothing for this long has gone, and a PC
 * out of sync with the shared folder for this long stops its part, so the two happen together (Issues
 * 204). `renew`: how often a member says it is still there. `watch`: how often a member looks at the log. `retryFirst`
 * and `retryMax`: the spacing of retries.
 */
export interface Timing {
  lapse: number;
  renew: number;
  watch: number;
  retryFirst: number;
  retryMax: number;
  /** how long a check keeps the person waiting while it cannot reach the model service */
  giveUp: number;
  /** after that, how often it tries again in the background */
  retryEvery: number;
}
/** the design's times, from the control file; tests give short ones through `timing` */
export const TIMING: Timing = {
  lapse: control.timings.roundLapse, renew: control.timings.roundRenew, watch: control.timings.roundWatch,
  retryFirst: control.timings.roundRetryFirst, retryMax: control.timings.roundRetryMax, giveUp: control.timings.modelWait, retryEvery: control.timings.modelRetryEvery,
};


/** filler words left out when a question is matched to documents (the control file's list) */
const STOP = new Set(control.lists.searchFiller.map((w) => w.toLowerCase()));   // matched against words in lower case
/** words never matched when the core set is worked out: both filler lists (core.ts) */
const CORE_FILLER = new Set([...control.lists.searchFiller, ...control.lists.indexFiller].map((w) => w.toLowerCase()));
const ASK_WORDS = new Set(control.lists.askWords.map((w) => w.toLowerCase()));
/** the library's abbreviations, each with the first long name in its group: searched as their long forms too, as a deal's own short names are */
const libraryShort: Record<string, string> = Object.fromEntries((control.lists.synonyms as string[][]).flatMap((g) => { const long = g.find((m) => /\s/.test(m) || !/^[A-Z][A-Z0-9&]*[A-Z0-9]s?$/.test(m)); return long ? g.filter((m) => m !== long && /^[A-Z][A-Z0-9&]*[A-Z0-9]s?$/.test(m)).map((m) => [m, long]) : []; }));
const SHEET = /\.(xlsx|xlsm|xlsb|xls|ods|csv)$/i;
/** the whole numbers from `from` up to, not including, `to` */
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
/** where a document is in the data room: its folder by the folder's own name (not the path to it on this PC), then its path inside */
const where = roomPath;
/** the object in a reply, however loosely the model wrote it: see lenient.ts. `keys` are the fields that were asked for. */
const json = <T = Record<string, unknown>>(reply: string, ...keys: string[]): T | null => readJson(reply, keys) as T | null;
/**
 * A Satisfied result whose every place has left the deal (or, recorded without places, every document read for it):
 * "Satisfied" always rests on a place that opens, so it shows as not settled, and the next check reads the item again
 * rather than glancing at it
 */
const unmoored = (l: { result?: string; where?: { docId: string }[]; docs?: string[] } | undefined, has: (docId: string) => boolean) =>
  // the places it was settled on decide, when it has any; the documents it was read against count only for a result recorded without places
  l?.result === 'ok' && (l.where?.length ? !l.where.some((x) => has(x.docId)) : !l.docs?.some(has));
/**
 * Whether a reply's JSON was finished: 'closed', 'open' when the service stopped partway (whatever it said of why), or
 * 'none' when the reply holds no JSON to speak of. The JSON starts at the object that holds `key`, or at a list of
 * objects, so brackets in words before it are not taken for it. A reply that ends as a list of objects ends is closed
 * whatever is inside it (a stray quote in a text would otherwise hide the end).
 */
const jsonEnd = (raw: string, key: string): 'closed' | 'open' | 'none' => {
  const named = raw.search(new RegExp(`\\{\\s*"${key}"\\s*:`)); const from = named >= 0 ? named : raw.search(/\[\s*\{/);
  if (from < 0) return 'none';
  // words after the JSON are not its end: looked at up to the last bracket
  if (/\}\s*\]\s*\}?$/.test(raw.slice(from, Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']')) + 1))) return 'closed';
  let depth = 0, quoted = false;
  for (let k = from; k < raw.length; k++) {
    const ch = raw[k];
    if (quoted) { if (ch === '\\') k++; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if ((ch === '}' || ch === ']') && --depth === 0) return 'closed';
  }
  return 'open';
};
const UNMOORED = 'The documents it was settled on are no longer in this deal.';
const failure = (e: unknown, what: string) => { const code = (e as { code?: string })?.code; return fail<never>(code === 'unreachable' ? { kind: 'unreachable', message: (e as { signedOut?: boolean }).signedOut ? (e as Error).message : `${SERVICE} could not be reached.` } : { kind: 'failed', message: code === 'spent' ? (e as Error).message.replace(/\.$/, '') : code === 'cutoff' ? TOO_LONG_REPLY : code === 'toolong' ? TOO_LONG_ASK : what }); };   // a search out of calls says so; signed out, it says that rather than blame the service
/** A run in parts that stopped: a reply that could not be read says so, anything else is a failed call. */
const stoppedOn = (stopped: unknown) => (stopped as { code?: string }).code === 'unread'
  ? fail<never>({ kind: 'failed', message: UNREAD_REPLY })
  : failure(stopped, UNREACHED);
/** sent after a prompt whose reply was cut off at the length limit, to ask for the whole reply again in less room */
const SHORTER = 'Your reply to this was cut off at the length limit. Send the whole reply again in the same form, about half as long: keep what matters most and say less about the rest.';

/** how a pick introduces the files it lists (#1162) */
const PICK_INTRO = 'These are files from the data room of a project-finance deal, the likeliest first. Each is given '
  + 'by its id, then its full path from the root of the data room, with a short description where there is one, or '
  + 'else the words it uses most. The deal\'s core documents are marked *.';

const RULES = `Answer only from the documents you are given. Reply with one JSON object and nothing else.
Cite like this: put [1], [2] … after each sentence that rests on a document, and list the sources in the same order:
"sources": [{"doc": "its id", "page": 12, "quote": "a few words from that page"}]. \
For a spreadsheet give "cell": "Sheet name!B12" in place of "page".
Cite pages only: no clause, section or paragraph numbers. A sentence with no document behind it gets no marker. Never cite a document you were not given.
Never refer to a finding by an id or a code: say what it is about in words.
A calculation may use plain symbols (+ − × ÷ * / = %) without writing them out in words, like this: "CFADS / debt service = 41.2m / 31.2m = 1.32x". No LaTeX or other math markup: no \\frac, \\times, ^{…} or _{…}, and no $ around a formula.
Keep any one piece of text you write (a response, a finding's detail) under ${MODEL_TEXT_MAX.toLocaleString('en-US')} \
characters: each goes into one spreadsheet cell.`;

type Outcome = 'ok' | 'finding' | 'gap' | 'unsettled';
/** why an item was left unsettled when the documents chosen for it could not be read here */
const AWAY = 'The documents chosen for it could not be opened on this PC.';
/** whether a reason is that one: its documents' folder could not be reached, whichever files it names */
const isAway = (why: string | undefined) => !!why && (why.startsWith(AWAY.slice(0, -1)) || /^The folders? .+ could not be opened on this PC\.$/.test(why));
/** One line of a deal's checklist results: what the first pass made of one item, or that a run got to the end. */
/**
 * `run` names the deal's set of documents when the item was checked, `docs` are the ones it was checked against, and
 * `need` is what a gap said would settle it. A `done` line lists the checklist and the deal's documents as they were.
 * Older builds wrote a `core` line with the fast model's choice of core documents; it is no longer read (core.ts).
 * `n` puts the lines in order: each is one more than the highest this PC had read, so a later line comes later
 * whatever the clock on the PC that wrote it says.
 */
interface CheckLine extends RLine {
  v: 1;
  at: string;
  item?: string;
  text?: string;
  result?: Outcome;
  finding?: string;
  run?: string;
  docs?: string[];
  need?: string;
  /** For a satisfied item, the places it was settled on. */
  where?: { docId: string; loc: string; quote?: string }[];
  /** For an unsettled item, what stopped it. */
  why?: string;
  /** What the search looked for to settle the item and how many documents answered each search. */
  trail?: { q: string; n: number }[];
  /** `done` is when the round finished, the same whichever PC writes it. */
  full?: FullCheck & { round?: string; done?: string };
  heard?: Heard;
  core?: unknown;
  /** Work this PC has taken on. The claim lapses at `until` unless renewed. */
  claim?: Claim;
  release?: { keys: string[]; pc: string };
  /** A mark that waits for a person to choose between a finding's versions. */
  owed?: Owed;
  /** A mark owed earlier was written or is no longer needed. */
  paid?: Pick<Owed, 'finding' | 'why' | 'round'>;
  /** The memo's rating holds while the finding's words (`key`) stay the same. */
  rated?: { id: string; key: string; rating: Rating }[];
  n?: number;
}
/** a check log line may also say what the third-party reports sweep did (reports.ts) */
interface CheckLine { report?: ReportLine }
/** Paid work a PC has taken on for a deal: a run of checks, or describing documents. Another PC that sees it live leaves that work alone. */
interface Claim { keys: string[]; pc: string; label?: string; until: string }
/** how long a claim holds without being renewed, and how often a long run renews it */
const CLAIM_MS = control.timings.describeLapse, RENEW_MS = control.timings.describeRenew;
interface MarkEvidence {
  questions?: string[];
  round?: string;
}
/** A mark written by the next run on any PC after a person chooses between the finding's versions. */
interface Owed extends MarkEvidence {
  finding: string;
  why: string;
}
/** That a response on a question linked to no finding has been looked at: `said` names the response's wording, `findings` are the open findings it was judged able to change, and `against` every open finding it has been set against, so that it is set against each once. */
interface Heard { question: string; said: string; findings: string[]; against?: string[] }
/** That everything on a deal was checked: by the first pass getting to the end for the first time, or by a check of everything, quick or deep. */
interface FullCheck { mode: 'first' | 'quick' | 'deep'; items: number; findings: number; sample?: { size: number; overturned: number } }
/** more than this share of a spot check overturned, and a check of everything by the standard model is offered */
const OVERTURNED = 0.2;
/**
 * a deal shows another deal as holding its documents from `ALSO_LEAST` of them and `SHARE` of them, the `ALSO_MAX`
 * best, worked out again after `ALSO_MS`; a document `SHARED_BY` other deals hold is shared, not counted
 */
const ALSO_LEAST = 10, SHARE = 0.6, SHARED_BY = 3, ALSO_MS = 10 * 60_000, ALSO_MAX = 2;
/** a folder holding less than this part of this deal's documents is not judged on its own */
const FOLDER_PART = 0.25;
const ARRIVALS = 100;                                              // new documents put to the fast model in one question
const UNSAVED = 'The finding it raised could not be saved.';
const GAPS_AT_ONCE = 4;                                             // items handed to the chat agent in one of its runs when a check fills its gaps
const SECOND_LOOKS = 5;                                            // items whose second look is asked for in one question to the fast model
const TRAIL = 8;                                                   // searches an item's result keeps, the latest
const deeper = (f: FullCheck | undefined) => (f?.mode === 'quick' && f.sample && f.sample.size > 0 && f.sample.overturned / f.sample.size > OVERTURNED ? f.sample : null);
/** `weak` is a reply on an item that cannot be used: `why` says what is wrong with it, in words fit to send back, and `said` is what was sent */
/** `where` are the places an "ok" rests on (none when the fast model was only asked whether an item still stands). On a weak reply, `why` is what the model is told and `reason` what a person is told if the item ends up not settled. */
/** A workstream the model proposes is taken only from the firm's list, in its spelling; anything else is left blank for
 * a person to fill. */
export const workstreamOf = (w: unknown) => (typeof w === 'string' ? WORKSTREAMS.find((x) => x.toLowerCase() === w.trim().toLowerCase()) ?? '' : '');
/** what the model is told when it checks checklist items against documents; `redo` holds why its last replies failed */
type Redo = Map<string, { why: string; said?: unknown }>;
/**
 * A checklist item as a check prompt lists it: by its permanent id, never a running number its words could be
 * confused with, and its words; parts are sized by this line, id included (#1162)
 */
const checkLine = (it: ChecklistItem) => `${it.id}: ${it.text}`;
function checkPrompt(listing: string, items: ChecklistItem[], quick: boolean, redo?: Redo) {
  const where = quick ? '' : ' Add "where": the one or two places that show it, each naming a document you were given, '
    + 'by its id, and its page (or sheet and cell for a spreadsheet), with a short "quote" of the words there.';
  const finding = '"finding" when they do not: what a lender needs is wrong, '
    + 'missing from a document that should have it, or differs between documents. Write it up: a one-line "title", '
    + `a "workstream" (one of ${WORKSTREAMS.join(' | ')}, or "" when unsure), `
    + 'a "body" of one or two paragraphs with [n] markers, and "sources" citing each place that shows it '
    + '(one place is enough when it shows in only one). Number each item’s markers from [1].';
  const more = '"more" when these documents do not settle it: none of them deals with it, '
    + 'or they only report what other documents say (a report that says the permits are in place is not the permits). '
    + 'Add "need": a few words describing the documents that would settle it.';
  const okShape = quick ? '' : ', "where": [{"doc": "its id", "page": 12, "quote": "…"}]';
  const shape = `Reply as JSON: {"items": [{"id": "its id", "result": "ok"${okShape}}, `
    + '{"id": "its id", "result": "finding", "title": "…", "workstream": "…", "body": ["…"], "sources": [...]}, '
    + '{"id": "its id", "result": "more", "need": "…"}]}';
  const asked = items.map(checkLine).join('\n');
  return `Documents:\n${listing}\n\nCheck each of these checklist items, each with its id, against the documents:\n`
    + `${asked}\n\n`
    + `Give each item one "result":\n"ok" when the documents satisfy it.${where}\n${finding}\n${more}\n${shape}`
    + secondLook(items, redo);
}

/** a second look names each item whose first reply could not be used, with why and what was sent */
function secondLook(items: ChecklistItem[], redo?: Redo) {
  if (!redo) return '';
  const fixes = items.map((it) => {
    const r = redo.get(it.id);
    if (!r) return '';
    return `${it.id}: ${r.why}${r.said !== undefined ? ` You sent: ${JSON.stringify(r.said)}` : ''}`;
  }).filter(Boolean).join('\n');
  return `\n\nThis is a second look. Your first replies on these items could not be used. Put each right:\n${fixes}`;
}

type Seen =
  | { kind: 'ok'; where: Source[] }
  | { kind: 'none'; need: string }
  | {
    kind: 'weak'; why: string; said?: unknown; reason?: string;
    /** cut off or too long even alone: not asked again in this look */
    last?: boolean;
    /** not asked at all: asked again as a first look */
    unasked?: boolean;
  }
  | { kind: 'finding'; title: string; workstream: string; body: string[]; sources: Source[] };
const JSON_ONLY = 'Reply with one JSON object and nothing else.';
/** the words the two answer judgements share: whether an answer addresses a question, and which one (#1120) */
const answerFromDocs = (answer: string) => `This answer was written from the deal's documents:\n${answer}`;
const GIVES_WHAT_ASKED = 'does it give what the question asks for?';
/** the prompt showing open questions by their permanent ids, never their numbers, to match an answer to one (#1120) */
function suggestPrompt(answer: string, questions: { id: string; text: string }[]) {
  const listed = questions.map((q) => `${q.id}: ${q.text.replace(/\s+/g, ' ')}`).join('\n');
  return [
    `These open questions were asked on a project-finance deal, each with its id:\n${listed}\n`,
    `${answerFromDocs(answer)}\n`,
    `Which one of these open questions does the answer address: for which ${GIVES_WHAT_ASKED} Name the one it`
      + ' addresses most fully by its id, or "none" if it addresses none of them.',
    'Reply as JSON: {"question": "<an id above>" | "none"}',
  ].join('\n');
}
/** the id a reply names among the ids shown, or null for "none" (the reply was checked by `namesOneShown`) */
const namedId = (text: string, shown: readonly string[]) =>
  questionIdsIn(text).find((id) => shown.includes(id)) ?? null;
/**
 * Whether a reply to the open-question match can be used: it names an id that was shown and none that was not, or says
 * "none". Any other reply is a failed one, asked again (#1105).
 */
const namesOneShown = (text: string, shown: readonly string[]) =>
  namesOnlyShown(text, shown) && (namedId(text, shown) !== null || /\bnone\b/i.test(text));
/** the rules for a draft from earlier responses alone, when no document bears on the question */
const PRIOR_RULES = 'Answer only from the earlier responses you are given: choose those that answer the question as it is asked. Reply with one JSON object and nothing else. Cite no documents: give "sources": [].';
/**
 * A finding's id written into the words of a summary, outside a {words|id} link, is taken out: people never see a
 * finding named by an id. "(f_…)" goes whole; a bare id becomes "this finding".
 */
export function unid(text: string, ids: Set<string>): string {
  const out: string[] = []; let last = 0;
  for (const m of text.matchAll(/\{[^{}|]+\|[^{}]*\}/g)) { out.push(scrub(text.slice(last, m.index)), m[0]); last = m.index! + m[0].length; }
  out.push(scrub(text.slice(last))); return out.join('');
  function scrub(t: string) {
    for (const id of ids) { const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); t = t.replace(new RegExp(`\\s*\\((?:finding\\s+)?${e}\\)`, 'g'), '').replace(new RegExp(`(?:the\\s+)?(?:finding\\s+)?${e}`, 'gi'), 'this finding'); }
    return t;
  }
}

/** A memo reply naming a finding by any id but one it was shown, in its words or in `named`: asked again (#1162) */
const memoUnusable = (shown: string[], named: (text: string) => unknown[]) => (text: string) =>
  !namesOnlyShown(text, shown) || unknownIds(named(text), shown).length > 0;
/** the ids a ratings reply rates */
const ratedIds = (text: string) => listOf(json(text, 'ratings')?.ratings).filter(isObject).map((row) => row.id);
/** the ids a grouping reply puts in its risks */
const groupedIds = (text: string) =>
  listOf(json(text, 'risks')?.risks).filter(isObject).flatMap((row) => listOf(row.findings));
/** the ids a brief's links name: {a few words|its id} */
const linkedIds = (text: string) => strings(json(text, 'paragraphs')?.paragraphs)
  .flatMap((p) => [...p.matchAll(/\{[^{}|]+\|([^{}]*)\}/g)].map((m) => m[1]));

/** Ignore malformed entries individually so a usable group beside one still stands (#658). */
function memoGroupRows(value: unknown, ids: Set<string>): RiskGroup[] {
  return listOf(value).filter(isObject).map((row) => ({
    title: unid(prose(row.title)[0] ?? '', ids),
    findings: strings(row.findings),
  })).filter((group) => group.findings.length);
}

const withoutMemoMarks = (text: string, space = '') => text.replace(/\s*\[\d+\]/g, space)
  .replace(/\{([^{}|]+)\|[^{}]*\}/g, '$1');
const MEMO_RISK_WORDS = 200;
const MEMO_RISK_TEXT_CHARS = 4_000;
const MEMO_RISK_TOKEN_CHARS = 256;
const MEMO_RISK_SHAPE = '{"paragraphs": ["one paragraph per string, with [n] markers"], "sources": [...]}';

/** Count paragraph breaks inside strings, including the separator used to fit citations across paragraphs (#659). */
function memoRiskParagraphs(value: unknown): string[] {
  return prose(value).flatMap((paragraph) => paragraph.split(/\r?\n[^\S\r\n]*\r?\n|\u0000/))
    .filter((paragraph) => paragraph.trim());
}

/** Bound the write-up even when malformed text fits the word count (#659). */
function memoRiskFits(paragraphs: string[], ids: Set<string>): boolean {
  if (!paragraphs.length || paragraphs.length > 2) return false;
  const text = paragraphs.join(' ');
  // Control characters discarded by the document builder can hide unbroken text (#659).
  const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
  if (text.length > MEMO_RISK_TEXT_CHARS || invalidText.test(text)) return false;
  const scrubbed = paragraphs.map((paragraph) => unid(paragraph, ids));
  // Citation fitting can join adjacent text when it removes an invalid marker (#659).
  const withoutCitations = scrubbed.map((paragraph) => withoutMemoMarks(paragraph)).join(' ');
  // Only ordinary document whitespace can separate printed words (#659).
  const oversized = (value: string) => value.split(/[ \t\r\n]+/).some((token) => token.length > MEMO_RISK_TOKEN_CHARS);
  if (oversized(text) || oversized(withoutCitations)) return false;
  const prose = scrubbed.map((paragraph) => withoutMemoMarks(paragraph, ' ')).join(' ');
  const words = prose.match(/\S+/g) ?? [];
  return words.length > 0 && words.length <= MEMO_RISK_WORDS;
}

/** A Check verdict, or null when the reply gives none of the three. */
function verdictOf(reply: { verdict?: unknown } | null): 'yes' | 'partly' | 'no' | null {
  const verdict = word(reply?.verdict);
  return verdict === 'yes' || verdict === 'partly' || verdict === 'no' ? verdict : null;
}

/** A reconciled answer, or '' when the reply is empty or asks a person to fill something in. */
function mergedText(reply: { text?: unknown } | null): string {
  const text = prose(reply?.text)[0] ?? '';
  return /\[[^\]]*(confirm|tbc|tbd|check)[^\]]*\]/i.test(text) ? '' : text;
}

function readCorrection(
  prompt: string, reply: Record<string, unknown> | null, again: { wrong: string; maxEcho?: number },
): string {
  if (!reply) return prompt;
  const previous = JSON.stringify(reply);
  const echo = previous.length <= (again.maxEcho ?? Infinity) ? `\n\nYou replied:\n${previous}` : '';
  return `${prompt}${echo}\n\nThat cannot be used: ${again.wrong}. Send the whole reply again, put right.`;
}

/** Send unusable write-ups through the document reader's retry policy (#659). */
function memoRiskReadOptions(escalate: string, advises: (text: string) => boolean, ids: Set<string>) {
  const usable = (reply: Record<string, unknown>) => {
    const paragraphs = memoRiskParagraphs(reply.paragraphs);
    return memoRiskFits(paragraphs, ids) && !paragraphs.some(advises);
  };
  const wrong = 'it is empty, contains oversized text, gives advice or a judgment, or exceeds '
    + `the limit of two paragraphs and ${MEMO_RISK_WORDS} words`;
  // Keep an oversized reply from making the correction request too long (#659).
  return { escalate, usable, wrong, maxEcho: MEMO_RISK_TEXT_CHARS, retrySharedModel: true };
}

/**
 * LaTeX-style notation in a text, which the model is told not to write (plain symbols such as
 * + − × ÷ * / = % are fine): the pieces found, none when there are none. A $ before a figure is money, not notation:
 * only $ around a formula counts.
 */
export function notation(text: string): string[] {
  const found = [
    /\$\$[\s\S]+?\$\$/g,                                    // $$ … $$
    /\$[^$\n]*[\\^_{}][^$\n]*\$/g,                          // $ … $ around something with markup in it
    /\\[a-zA-Z]+(?:\{[^}]*\})*/g,                           // \frac{a}{b}, \times, \text{…}
    /\\[()[\]]/g,                                           // \( \) \[ \]
    /[A-Za-z0-9)\]}]+\s*[\^_]\s*\{[^}]*\}/g,                // x^{2}, DSCR_{min}
  ].flatMap((re) => text.match(re) ?? []);
  return [...new Set(found)];
}
const unreachable = (e: unknown) => (e as { code?: string })?.code === 'unreachable';
/** a call that waited for a sign-in as long as it may (src/backend/signInToken.ts): the service may be fine, nobody is signed in to it */
const signedOutErr = (e: unknown) => !!(e as { signedOut?: boolean } | undefined)?.signedOut;
/** what a check asked for ends with when this PC is signed out: never that the service cannot be reached */
const SIGNED_OUT = `Waiting for ${SERVICE} sign-in. The check resumes once someone signs in.`;

/** The first-page summary describes any known High risks and discloses unresolved ratings (#661). */
function memoSummaryPrompt(
  facts: string,
  openCount: number,
  unratedCount: number,
  risks: Grouped[],
  describeFinding: (id: string) => string,
): string {
  const highs = risks.filter((risk) => risk.rating === 'High');
  let riskInstructions = unratedCount ? 'state that there are open findings with unresolved ratings. ' : '';
  if (highs.length) {
    const lines = highs.map((risk) => `- ${risk.title}: ${risk.findings.map(describeFinding).join(' ')}`);
    const highInstructions = `each of these High risks in one sentence:\n${lines.join('\n')}\n`;
    riskInstructions = riskInstructions ? `${riskInstructions}Summarize ${highInstructions}` : highInstructions;
  } else if (!riskInstructions) {
    riskInstructions = openCount ? 'that no open risk is rated High. ' : 'that it has no open findings. ';
  }
  const deal = facts ? ` (${facts})` : '';
  const ratingInstructions = unratedCount ? 'Describe the issues in facts. Leave rating labels to the counts. ' : '';
  return `Write the summary of a deal memo for a managing director at an investment bank, about this deal${deal}: `
    + 'two paragraphs, at most 170 words in all. First what the project and the financing are, with the figures '
    + 'the documents give (size, capacity, location, sponsor, offtake, structure, timetable). '
    + `Then ${riskInstructions}${ratingInstructions}`
    + 'Facts only: no advice, no recommendation, no next steps, and no judgment of how the deal or the work is going. '
    + 'Name no person. Never write an id.';
}

export function nodeAi(o: AiOptions) {
  const clock = o.clock ?? (() => new Date().toISOString()); const L = control.limits; const width = o.width ?? L.docsPerCall; const batch = Math.max(1, o.batch ?? L.itemsPerCall); const shortlist = Math.max(1, o.shortlist ?? L.shortlist);
  let offered: Awaited<ReturnType<ModelService['models']>> | null = null;
  const models = async () => (offered ??= await o.service.models());
  // ── the words a search compares ─────────────────────────────────────────────────────────────────────────────────────
  const kept = (t: string) => tokens(t).filter((w) => !STOP.has(w)).map(fold);
  /** a short name as a search compares it: "O&M" and "PPAs" as "om" and "ppa" */
  const shortKey = (k: string) => fold(tokens(k).join(''));
  /** each deal's short names, as the fast model saw them in its file paths (see `coreOf`), read from its latest core line by `lines` */
  const shorts = new Map<string, { from: unknown; map: Map<string, string[]> }>();
  /**
   * The words of a text as they are compared: the word index's split (`indexWords`), with the search's filler words
   * left out, and, with `dealId`, every short name the deal's files use given its long form as well.
   */
  const words = (t: string, dealId?: string): Set<string> => {
    const long = dealId ? shorts.get(dealId)?.map : undefined;
    const out = new Set<string>();
    for (const w of indexWords(t, STOP)) {
      out.add(w);
      for (const x of long?.get(w) ?? []) out.add(x);
    }
    return out;
  };

  // ── what it costs ───────────────────────────────────────────────────────────────────────────────────────────────────
  type Tally = Map<string, UsageLine>;
  const total: Tally = new Map(); const runs = new AsyncLocalStorage<Tally>();
  const count = (kind: string, input: { model: string; prompt: string; files?: string[] }, reply: string) => {
    for (const t of [total, runs.getStore()]) { if (!t) continue; const k = `${kind}|${input.model}`; const l = t.get(k) ?? { kind, model: input.model, calls: 0, docs: 0, sent: 0, received: 0 }; l.calls++; l.docs += input.files?.length ?? 0; l.sent += input.prompt.length; l.received += reply.length; t.set(k, l); }
  };
  /** Run something as one run for the usage log. */
  async function logged<T>(run: string, dealId: string | undefined, go: () => Promise<T>): Promise<T> {
    const tally: Tally = new Map();
    try { return await runs.run(tally, go); }
    finally { if (tally.size) { try { o.usage?.({ run, ...(dealId ? { dealId } : {}), at: clock(), calls: [...tally.values()].map((l) => ({ ...l })) }); } catch { /* the log is not worth failing a run for */ } } }
  }
  /** a call: what it is for (`kind`, for the usage log), and with `split`, a caller that asks about less when a reply is cut off rather than for a shorter reply */
  // `unusable`: a reply its caller cannot use however it reads, asked again as an empty one is (#1105)
  type Ask = Parameters<ModelService['complete']>[0] & { kind: string; split?: boolean; unusable?: Unusable };
  /** the most tokens one reply from this model may hold, and one call to it may send, as the service says (limits.ts) */
  const outLimit = (model: string) => o.service.outputLimit?.(model) ?? control.limits.outputTokens;
  const inLimit = (model: string) => o.service.inputLimit?.(model) ?? control.limits.inputTokens;
  /**
   * The calls a search run may still make (control.limits.searchCalls): a call past them is refused, and the run returns what
   * it has; a pick that is refused falls back to the keyword ranking, which needs no call. Describing a document and
   * choosing a deal's core documents are not part of the search (the one goes on in the background, the other is done
   * once per deal and kept), so neither is counted.
   */
  /** about how many tokens each of some texts adds to a request: their average, for sizing a part to the input limit (parts.ts) */
  const tokensEach = (texts: readonly string[]) => (texts.length ? Math.ceil(texts.reduce((n, t) => n + tokensOf(t), 0) / texts.length) + 4 : 0);
  /** calls a search may still make (control.limits.searchCalls), each try counted */
  const budget = new AsyncLocalStorage<{ left: number }>();
  /** counts one call against a search's calls; refuses it when they are spent (a search in a budget only) */
  const spend = (b: { left: number } | undefined) => {
    if (!b || b.left-- > 0) return;
    throw Object.assign(new Error('This search made as many calls as one search may.'), { code: 'spent' });
  };
  /** every call to the model is asked again quietly when it fails or comes back empty (src/backend/retry.ts) */
  const retried = retrier(o.retry);
  /**
   * a reply that failed: nothing in it, or what its caller cannot use (#1105); asked again (retry.ts). One that stops
   * before its end is left to the cut-off handling (`whole`), since its last citation may itself be cut short (#1162)
   */
  const failedReply = async (text: string, unusable?: Unusable) =>
    !text.trim() || (!!unusable && !unfinished(text) && await unusable(text));
  const complete = async ({ kind, split: _split, unusable, ...input }: Ask): Promise<string> => {
    const b = kind === 'describe' ? undefined : budget.getStore();
    // each try is counted in the usage log and against a search's calls, since each is paid for; a search out of calls is not asked again
    return retried(async () => {
      spend(b);
      let reply = ''; try { reply = await o.service.complete(input); return reply; } finally { count(kind, input, String(reply ?? '')); }
    }, (r) => failedReply(String(r ?? ''), unusable));
  };
  /**
   * Ask, and read the reply. A reply that cannot be read even loosely is sent back once to the model that wrote it, with
   * no documents, to be sent again as valid JSON; what comes back is read the same way. Null when neither can be read.
   * Throws when the service fails. `kind` says what the call is for, for the usage log. With `fix` false there is no
   * second call. A first attempt always has one, since it is the cheapest cure: no documents go with it. The attempts
   * that follow a failed first attempt have none, so that one failure is not paid for three times over.
   */
  /** checklist items sent in one call when a list is brought in */
  const CHECKLIST_BATCH = 120;
  /** what `phrase` has phrased for a deal in a run that then failed, by point, so asking again asks only for the rest */
  const phraseKept = new Map<string, Map<string, string>>();
  // points that failed alone, per deal, by their key: asking again (Retry) puts them last, after the points that were only
  // held up beside them, so those come back first; they are still split and asked alone like any other
  const phraseFailed = new Map<string, Set<string>>();
  /** a point `phrase` is asked to put as a question, by its record id (ports: AiService.phrase) */
  type PhrasePoint = PhraseItem;
  /** a point's key, by which `phraseKept` and `phraseFailed` know it from one run to the next */
  const phraseKey = (x: PhrasePoint) => JSON.stringify([x.kind, x.what, x.need]);
  /** a point as one line of a `phrase` call: its kind, what is unresolved, and what would settle it */
  const phraseLine = (x: PhrasePoint) =>
    `[${x.kind}] ${x.what.replace(/\s+/g, ' ')}${x.need ? ` — needed: ${x.need.replace(/\s+/g, ' ')}` : ''}`;
  /** a point as a `phrase` call lists it: by its record id, never a per-prompt label, so parts count the id (#1162) */
  const phrasePromptLine = (x: PhrasePoint) => `${x.id}: ${phraseLine(x)}`;
  /** what one `phrase` call asks, each point named by its record id */
  const phrasePrompt = (points: PhrasePoint[]) => [
    'These are unresolved points in the due diligence of a project-finance deal: checklist items no document'
      + ' settles yet ("gap"), and open findings ("finding"). Each starts with its id.',
    ...points.map(phrasePromptLine),
    '',
    'Write one question for the counterparty for each point, asking plainly for the document or confirmation that'
      + ' would settle it. One or two sentences each, polite and specific, in the deal team\'s voice; keep every name'
      + ' and figure; say nothing about how the point was found. Give every point a question, with that point\'s id.',
    `Reply as JSON: {"items": [{"id": "${points[0].id}", "text": "…"}]}`,
  ].join('\n');
  /** why a `phrase` reply brought no question back, as the run's failure says it when no point gets one */
  const phraseWhy = (cut: boolean, reply: { items?: unknown } | null) => {
    if (cut) return `${SERVICE}’s reply was cut off, so nothing was added`;
    if (reply && Array.isArray(reply.items)) return `${SERVICE} left a point without a question, so nothing was added`;
    return `${SERVICE}’s reply could not be read, so nothing was added`;
  };
  /** the entries of a `phrase` reply: each one's place in the call, by its id exactly (#1162), and its text */
  const phraseEntries = (reply: { items?: unknown } | null, ids: string[]) => {
    const at = new Map(ids.map((id, m) => [id, m]));
    return (listOf(reply?.items) as { id?: unknown; text?: unknown }[]).map((x) => ({
      m: typeof x?.id === 'string' ? at.get(x.id) : undefined,
      text: typeof x?.text === 'string' && x.text.trim() ? x.text : '',   // as the model wrote it (#1215)
    }));
  };
  /** the places a reply gives more than one question: such a question is not known to belong to either */
  const givenTwice = (items: { m?: number }[]) =>
    new Set(items.filter((x, j) => x.m !== undefined && items.findIndex((y) => y.m === x.m) !== j).map((x) => x.m));
  /**
   * A `phrase` reply that names a point by an id it was not shown, in its words or as an entry's id, is asked again
   * (#1162); an entry with no id is left to `phraseGot`, as before
   */
  const phraseUnusable = (ids: string[]) => (text: string) => {
    const entries = listOf(readJson(text, ['items'])?.items) as { id?: unknown }[];
    const named = entries.filter((x) => isObject(x) && x.id !== undefined).map((x) => x.id);
    return !namesOnlyShown(text, ids) || unknownIds(named, ids).length > 0;
  };
  /**
   * Whether the entries of a `phrase` reply name an id the call did not show, as `phraseUnusable` reads them; the
   * last entry of a cut reply is left out, since it may be cut short, its id with it (#1162)
   */
  const namesUnshown = (reply: { items?: unknown } | null, cut: boolean, unusable: (text: string) => boolean) => {
    const entries = listOf(reply?.items);
    return unusable(JSON.stringify({ items: cut ? entries.slice(0, -1) : entries }));
  };
  /**
   * The questions of a `phrase` reply, by place in the call: only an entry with one of the call's ids is kept, even
   * for a point asked alone, so stray text is never taken for a question; the last entry of a cut reply may be cut
   * short, so it is left out
   */
  const phraseGot = (items: { m?: number; text: string }[], cut: boolean) => {
    const twice = givenTwice(items);
    const got = new Map<number, string>();
    let last = -1;
    for (const x of items) {
      if (x.m === undefined || !x.text) continue;
      last = x.m;
      if (!twice.has(x.m)) got.set(x.m, fitText(x.text));
    }
    if (cut) got.delete(last);
    return got;
  };
  /**
   * One `phrase` call: the questions that came back whole, by place in `points`, whether the reply was cut off, and
   * why, when none came back. Each point is named by its record id, not a running number, and a question is
   * taken only for an id of this call, so a reply that leaves a point out, or puts two in another order, cannot move a
   * question onto another point. A reply cut off, whether the service says so or its JSON is left open, keeps what
   * came before its last entry; a whole reply with a stray quote in it is read as whole. Any other error is thrown.
   */
  async function askPhrase(model: string, points: PhrasePoint[]) {
    const ids = points.map((x) => x.id);
    const prompt = phrasePrompt(points);
    const unusable = phraseUnusable(ids);
    let raw = '';
    let cut = false;
    try {
      raw = String(await complete({ kind: 'phrase', model, system: JSON_ONLY, prompt, unusable }) ?? '');
    } catch (e) {
      if (!isCutOff(e)) throw e;
      cut = true;
      raw = (e as { text?: string }).text ?? '';
    }
    const reply = json<{ items?: unknown }>(raw, 'items');
    if (jsonEnd(raw, 'items') === 'open') cut = true;
    // a reply still naming an id it was not shown when its tries ran out brings nothing: the part fails (#1162)
    const none = new Map<number, string>();
    if (namesUnshown(reply, cut, unusable)) return { got: none, cut: false, why: phraseWhy(false, null) };
    const got = phraseGot(phraseEntries(reply, ids), cut);
    return { got, cut, why: got.size ? '' : phraseWhy(cut, reply) };
  }
  /** some points of a `phrase` run, by kind (gaps, then findings), leaving out a kind with none */
  const phraseByKind = (points: PhrasePoint[], part: number[]) =>
    (['gap', 'finding'] as const).map((kind) => part.filter((k) => points[k].kind === kind)).filter((l) => l.length);
  /**
   * A part whose whole reply brought nothing, to ask again: split by kind when it holds both (so a model that fails
   * every finding fails only parts of findings), otherwise in halves; nothing for a single point, offered for Retry
   */
  const splitPhrasePart = (points: PhrasePoint[], part: number[]) => {
    const kinds = phraseByKind(points, part);
    if (kinds.length > 1) return kinds;
    const half = Math.ceil(part.length / 2);
    return part.length > 1 ? [part.slice(0, half), part.slice(half)] : [];
  };
  /**
   * One `phrase` run: its points, what came back for them so far (`out`: a question, null for Retry, or not yet), the
   * deal's kept questions and points that failed alone, the lists still to ask, and why the last reply brought nothing
   */
  type PhraseRun = {
    points: PhrasePoint[];
    had: Map<string, string>;
    failed: Set<string>;
    out: (string | null | undefined)[];
    queue: number[][];
    leftOut: number[];
    why: string;
  };
  /** a `phrase` run: points kept from a failed run are not asked; points that failed alone before are asked last */
  const phraseRunFor = (dealId: string, points: PhrasePoint[]): PhraseRun => {
    const had = phraseKept.get(dealId) ?? new Map<string, string>();
    phraseKept.set(dealId, had);
    const failed = phraseFailed.get(dealId) ?? new Set<string>();
    phraseFailed.set(dealId, failed);
    const out = points.map((x) => had.get(phraseKey(x)));
    const todo = range(0, points.length).filter((k) => out[k] === undefined);
    const was = (k: number) => failed.has(phraseKey(points[k]));
    const queue = [todo.filter((k) => !was(k)), todo.filter(was)].filter((l) => l.length);
    return { points, had, failed, out, queue, leftOut: [], why: '' };
  };
  /**
   * One part of a `phrase` run asked, for inParts: a cut reply is handed to it (parts.ts); what a whole reply leaves
   * is asked again: the points it left out with those the rest of the list leaves (keepPhrased), a part that brought
   * nothing split (splitPhrasePart); a single point that brought nothing is offered for Retry (null)
   */
  const askPhrasePart = async (run: PhraseRun, model: string, part: number[]): Promise<PartReply<string>> => {
    const reply = await askPhrase(model, part.map((k) => run.points[k]));
    run.why = reply.why || run.why;
    const alone = part.length === 1 && !reply.got.size;
    if (alone) run.failed.add(phraseKey(run.points[part[0]]));      // asked last by a later run
    if (reply.cut) return { got: reply.got, cut: range(0, part.length).filter((m) => !reply.got.has(m)) };
    if (alone) run.out[part[0]] = null;
    if (reply.got.size) run.leftOut.push(...part.filter((_, m) => !reply.got.has(m)));
    else run.queue.push(...splitPhrasePart(run.points, part));
    return { got: reply.got };
  };
  /** what one list of a `phrase` run brought back (inParts), kept in the run */
  const keepPhrased = (run: PhraseRun, list: number[], done: PartsDone<string>) => {
    for (const [at, text] of done.got) {
      const key = phraseKey(run.points[list[at]]);
      run.out[list[at]] = text;
      run.had.set(key, text);
      run.failed.delete(key);
    }
    for (const at of done.left) run.out[list[at]] = null;      // cut off even alone (parts.ts): offered for Retry
    // not asked, as three points in a row were cut off alone (parts.ts): asked again as a list of their own
    if (done.unasked.length) run.queue.push(done.unasked.map((at) => list[at]));
    // the points the list's whole replies left out, asked again together, a list for each kind, in parts as any list
    run.queue.push(...phraseByKind(run.points, run.leftOut));
    run.leftOut = [];
  };
  /**
   * items asked about in one call of the duplicate check: a list of deal size is asked about whole, in one call (2,400
   * items is about 50k tokens), as the model then compares each item with every other; asked in parts of 120 it found
   * far fewer of the repeats in a test list
   */
  const SAME_BATCH = 3000;
  /** parts of the duplicate check asked at once */
  const SAME_AT_ONCE = 4;
  /** points titled and compared with the findings in one call: a list of deal size (a few hundred points) is one call */
  const ISSUES_BATCH = 400;
  const MEMO_RATE_BATCH = 40;   // open findings rated in one call for the deal memo
  /** a reply's text with its white space collapsed */
  const clean = (t: unknown) => String(t ?? '').replace(/\s+/g, ' ').trim();
  /** the findings an issues-list call shows, from and to: a share of them, or all when there is no share */
  type FindingShare = [number, number];
  /** the ids of the findings an issues-list call shows (#1162) */
  const shownFindingIds = (findings: { id: string }[], share?: FindingShare) =>
    findings.slice(...(share ?? [0, findings.length])).map((f) => f.id);
  /** what a point repeats: an earlier point, or a finding by its id, exactly, among those its call showed (#1162) */
  const sameOf = (findings: { id: string }[], said: unknown, k: number, share?: FindingShare) => {
    const point = /^P\s*(\d+)$/i.exec(clean(said));
    if (point) return +point[1] >= 1 && +point[1] <= k ? { point: +point[1] - 1 } : undefined;
    return typeof said === 'string' && shownFindingIds(findings, share).includes(said) ? { finding: said } : undefined;
  };
  /**
   * An issues-list reply whose "same" names a finding its call did not show, asked again (#1162); none ("") and an
   * earlier point are not finding ids
   */
  const sameUnusable = (findings: { id: string }[], share?: FindingShare) => (text: string) => {
    const shown = shownFindingIds(findings, share);
    const rows = listOf(json<{ points?: unknown }>(text, 'points')?.points).filter(isObject);
    const named = rows.map((row) => row.same).filter((v) => clean(v) !== '' && !/^P\s*\d+$/i.test(clean(v)));
    return !namesOnlyShown(text, shown) || unknownIds(named, shown).length > 0;
  };

  /**
   * An issues list's points, read from its file in one call, as every other document is read: the model gives each
   * point with the words the list gives it and the number or reference the list gives it (#1026). The reply is
   * not paged, checked against the file's text or matched to it. A reply that cannot be read is asked for again
   * (`tried`); one cut off at the length limit fails the read, as it does anywhere else.
   */
  async function readIssuePoints(
    name: string, fileId: string, model: Ask['model'], tried: <T>(ask: () => Promise<T>) => Promise<T>,
  ): Promise<Result<{ n: string; text: string }[]>> {
    const prompt = [
      `${name} is an issues list: the points one party raises on a deal's documents. List every point of it, in order.`,
      'For each: "n": its number or reference as the list writes it ("" when it has none); "text": the point, in the',
      'list\'s own words exactly as written. Never reword, shorten or merge. Leave out headings, introductions',
      'and notes that raise no point.',
      'Reply as JSON: {"points": [{"n": "1", "text": "…"}]}',
    ].join('\n');
    const ask: Ask = { kind: 'issuesList', split: true, model, system: JSON_ONLY, files: [fileId], prompt };
    try {
      // a reply that is not an object with its points is asked for again (`tried`), as every other read is
      const reply = await tried(async () => {
        const got = await askJson<{ points?: unknown }>(ask, ['points']);
        if (!got || !Array.isArray(got.points)) throw Object.assign(new Error(UNREAD_REPLY), { code: 'unread' });
        return got.points as { n?: unknown; text?: unknown }[];
      });
      // the list's own words, number and point alike, are the reply's as given, inner spacing and line breaks
      // included: only their edges are trimmed, as the import command trims them too (#1026)
      const edges = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
      return ok(reply.map((p) => ({ n: edges(p?.n), text: edges(p?.text) })).filter((p) => p.text));
    } catch (e) {
      if ((e as { code?: string })?.code === 'unread') return fail({ kind: 'failed', message: UNREAD_REPLY });
      return failure(e, 'The file could not be read');
    }
  }
  /** a reply read as JSON, or none (`unusable`) when its caller cannot use it once its tries ran out (#1105) */
  async function usableJson<T>(text: string, keys: string[], unusable?: Unusable) {
    if (unusable && await unusable(text)) return { got: null, unusable: true };
    return { got: json<T>(text, ...keys), unusable: false };
  }
  async function askJson<T = Record<string, unknown>>(input: Ask, keys: string[], shape?: string, fix = true): Promise<T | null> {
    const raw = await whole(input, keys);
    const read = await usableJson<T>(raw, keys, input.unusable);
    if (read.got || read.unusable || !fix || !String(raw ?? '').trim()) return read.got;
    let fixed: string;
    try { fixed = await complete({ kind: 'fix', model: input.model, system: JSON_ONLY, prompt: `The reply below was meant to be one JSON object${shape ? ` in this shape: ${shape}` : ` with these fields: ${keys.join(', ')}`}. It cannot be read as written. Send it again as valid JSON, changing nothing else. If it is not an answer at all, reply {}.\n\n${raw}` }); }
    catch (e) { if (isCutOff(e)) throw cutReply(e, keys); if (unreachable(e)) throw e; return null; }
    if (unfinished(fixed)) throw cutReply(cutOff('The repaired reply stopped before its end', fixed), keys);
    return (await usableJson<T>(fixed, keys, input.unusable)).got;
  }
  /**
   * A reply cut off at the output limit, whether the service said so or its JSON stops partway (limits.ts, decisions:
   * Cut-off output): `code: 'cutoff'`, with `partial`, what could be read before the cut. The last entry of a list in it
   * may itself be cut short, so a caller keeps only the entries before it.
   */
  const cutReply = (e: unknown, keys: string[]) => Object.assign(e as Error, { code: 'cutoff', partial: json((e as { text?: string }).text ?? '', ...keys) });
  /**
   * The text of a reply that came to its end. A reply cut off at the output limit is asked for once more, shorter, unless
   * the caller asks about less instead (`split`); one cut off still throws (`cutReply`). A cut reply is never sent on to
   * be repaired, as its repair would read as whole.
   */
  async function whole(input: Ask, keys: string[]): Promise<string> {
    for (let shorter = false; ; shorter = true) {
      let raw: string;
      try { raw = await complete(shorter ? { ...input, prompt: `${input.prompt}\n\n${SHORTER}` } : input); }
      catch (e) { if (!isCutOff(e)) throw e; if (input.split || shorter) throw cutReply(e, keys); continue; }
      if (!unfinished(raw)) return raw;
      if (input.split || shorter) throw cutReply(cutOff('The reply stopped before its end', raw), keys);
    }
  }

  /**
   * One turn of a conversation the model service keeps, read as askJson reads a reply. A reply that cannot be read is
   * sent back once in the same conversation, to be sent again as valid JSON. Throws when the service fails, and with
   * `code: 'gone'` when it no longer has the conversation.
   */
  /** `tried`: tries a turn already had in the conversation it failed in, before the chat asked it again as a new one (agent.ts) */
  type Talk = Ask & ConverseInput & { tried?: number };
  /** a turn's reply as text: its text, or the tool calls it made */
  const conversedText = (r: Conversed) => r.text || JSON.stringify(r.calls ?? '');
  /** a turn its caller still cannot use fails as an empty one in a conversation does, to be asked again (#1105) */
  async function refuseUnusable(r: Conversed, unusable?: Unusable): Promise<void> {
    if (unusable && await unusable(conversedText(r))) throw new Error('The reply could not be used.');
  }
  // Only a turn that begins a conversation is asked again, and as a new one: in a kept conversation the failed or empty turn
  // may already be part of it (North keeps it), and asking there again would send the turn, and its documents, twice, or an
  // empty turn some services refuse. Not a turn that answers tool calls either: its failure is how a model says it does not
  // take tool results (talkJson steps down to sending them in the message).
  const converse = async ({ kind, tried, unusable, ...input }: Talk) => {
    // the gap filler's turns are limited by limits.chatTurns; a turn inside a search budget still counts against it
    const b = budget.getStore();
    const once = async () => {
      spend(b);
      let reply = '';
      try {
        const r = await o.service.converse!(input);
        reply = conversedText(r);
        return r;
      } finally {
        count(kind, input, String(reply ?? ''));
      }
    };
    if (input.results?.length || input.conversation) return once();
    const failed = async (r: Conversed) => (!String(r.text ?? '').trim() && !r.calls?.length)
      || (!!unusable && await unusable(conversedText(r)));
    return retried(once, failed, tried);
  };
  /** models that refused a way of calling tools in this run of the app, and the way they stepped down to */
  const stepped = new Map<string, ToolMode>();
  /** models and the step down that one unclear refusal suggested, until the model takes tool results again */
  const doubted = new Set<string>();
  /** a turn's reply: the first tool it called, as the JSON block would name it ("answer" is the answer itself), or its text read as that block */
  const replyOf = (r: Conversed, keys: string[]) => { const c = r.calls?.[0]; return c ? (c.name === 'answer' ? c.args : { ...c.args, tool: c.name }) : json(r.text, ...keys); };
  const out = (r: Conversed, reply: Record<string, unknown> | null, tokens = r.tokens) => ({ reply, conversation: r.conversation, ...(tokens !== undefined ? { tokens } : {}), ...(r.calls?.length ? { calls: r.calls.map((c) => c.id) } : {}) });
  async function talkJson(input: Talk, keys: string[], shape: string): Promise<{ reply: Record<string, unknown> | null; conversation: string; tokens?: number; calls?: string[] }> {
    let r: Conversed;
    // a turn cut off at the output limit, said so or stopping partway, is asked once more for a shorter reply, as askJson does
    for (let shorter = false; ; shorter = true) {
      try { r = await converse(shorter ? { ...input, prompt: `${input.prompt}\n\n${SHORTER}` } : input); }
      catch (e) {
        if (isCutOff(e)) { if (shorter) throw cutReply(e, keys); continue; }
        // the way of calling tools is refused: tool results that fail (North answers a role:tool message with a 500), or tools
        // refused as a bad request (400, 422). Any other error is the service's own and fails the turn as it is.
        const { code, status } = (e ?? {}) as { code?: string; status?: number };
        if (input.tools && !unreachable(e) && code !== 'gone' && code !== 'toolong' && code !== 'spent' && (input.results?.length || status === 400 || status === 422)) throw Object.assign(e as Error, { code: 'tools' });
        throw e;
      }
      if (!unfinished(r.text ?? '')) break;
      if (shorter) throw cutReply(cutOff('The reply stopped before its end', r.text), keys);
    }
    if (input.results?.length) doubted.delete(`${input.model}\nhybrid`);   // the model took tool results: an earlier passing 500 is forgotten
    await refuseUnusable(r, input.unusable);
    const got = replyOf(r, keys);
    // an empty turn inside a conversation: failed, not answered. The chat asks it again as a new conversation (agent.ts;
    // decisions: Retries), since only a turn that begins one is asked again here
    if (!got && input.conversation && !String(r.text ?? '').trim() && !r.calls?.length) throw new Error('The reply was empty.');
    if (got || !String(r.text ?? '').trim()) return out(r, got);
    try {
      const f = await converse({ kind: 'fix', model: input.model, conversation: r.conversation, prompt: `Your reply cannot be read as one JSON object in this shape: ${shape}. Send it again as valid JSON, changing nothing else.`, ...(input.tools ? { tools: input.tools } : {}) });
      if (unfinished(f.text ?? '')) throw cutReply(cutOff('The repaired reply stopped before its end', f.text), keys);   // a cut repair is never shown either
      await refuseUnusable(f, input.unusable);
      return out(f, replyOf(f, keys), f.tokens ?? r.tokens);
    } catch (e) { if (unreachable(e)) throw e; return out(r, null); }
  }

  // ── what a document is: asked only of documents that are read ───────────────────────────────────────────────────────
  /** What a document is, said by the fast model from the document itself. Null when its reply cannot be used. Throws when the service fails. */
  async function review(doc: DocRecord, fileId: string): Promise<Review | null> {
    const reply = await askJson<{ summary?: unknown; keywords?: unknown }>({ kind: 'describe', model: (await models()).fast, system: JSON_ONLY, files: [fileId],
      // 'licence' is the UK spelling on purpose: other parties name documents that way, and search must find them
      prompt: `Describe the document ${doc.name}.\n"summary": two or three sentences: what it is, the parties, its date, what it covers.\n"keywords": up to thirty terms someone would search for to find it. Include the other words people use for the same things (for a permit: consent, license, licence, approval), since it is found by these words.\nReply as JSON: {"summary": "…", "keywords": ["…"]}` }, ['summary', 'keywords']);
    if (!reply || typeof reply.summary !== 'string' || !reply.summary.trim()) return null;
    const keywords = typeof reply.keywords === 'string' ? reply.keywords.split(/[,;\n]/) : reply.keywords;
    return { summary: reply.summary, keywords: strings(keywords).slice(0, 30) };
  }
  const AT_ONCE = 4;                                                             // documents described at a time
  const TRIES = 3;                                                               // a document the model cannot describe is asked about this many times, and then left alone for good
  const REST_MS = 60_000;                                                        // and not before a rest after each failure that grows fivefold: a minute, then five
  const asked = new Set<string>();                                               // documents queued or being described now
  const failed = new Map<string, { tries: number; at: string }>();               // failures seen by this run of the app, for when there is nowhere shared to count them
  const waiting = new Map<string, { ids: string[]; run: Promise<void> | null }>();
  /**
   * Have these documents described, if they have not been: in the background, a few at a time, as a run of its own in
   * the usage log. Nothing waits for it unless it asks to (`described`).
   *
   * A document the model gives nothing usable for, or that cannot be sent, is tried again only when it is next read,
   * and only after a rest: a minute after the first failure, five after the second. After the third it is not asked
   * about again, on any PC: it is still found by its path and its words. A service that cannot be reached is not a
   * failure of the document: the round stops, and what was left is queued again the next time it is read.
   */
  function describeSoon(dealId: string, docIds: string[]) {
    if (!o.docs.describe) return;
    const recs = new Map(o.docs.records(dealId).map((r) => [r.docId, r])); const key = (id: string) => `${dealId}/${id}`; const now = Date.parse(clock());
    const due = (r: DocRecord) => { const mine = failed.get(key(r.docId)); const f = mine && (!r.undescribed || mine.tries > r.undescribed.tries) ? mine : r.undescribed; return !f || (f.tries < TRIES && now - Date.parse(f.at) >= REST_MS * 5 ** (f.tries - 1)); };
    const add = docIds.filter((id, i, all) => { const r = recs.get(id); return all.indexOf(id) === i && !!r && r.summary === undefined && !asked.has(key(id)) && due(r); }); if (!add.length) return;
    for (const id of add) asked.add(key(id));
    const miss = (id: string, was?: DocRecord) => { const k = key(id); failed.set(k, { tries: Math.max(failed.get(k)?.tries ?? 0, was?.undescribed?.tries ?? 0) + 1, at: clock() }); try { o.docs.undescribed?.(dealId, id); } catch { /* counted here all the same */ } };
    const q = waiting.get(dealId) ?? { ids: [], run: null }; waiting.set(dealId, q); q.ids.push(...add);
    q.run ??= runs.exit(() => logged('describe', dealId, async () => {
      await null;                                                                // so that `q.run` is set before anything below can clear it
      try { while (q.ids.length) {
        const group = q.ids.splice(0, AT_ONCE);
        try {
          const at = new Map(o.docs.records(dealId).map((r) => [r.docId, r])); const open = group.filter((id) => at.get(id) && at.get(id)!.summary === undefined);   // another PC may have described it meanwhile
          // and another PC may be describing it now: it is left to that PC, and asked about again the next time it is read
          const elsewhere = o.shared ? await claimedElsewhere(dealId, open.map((id) => `describe:${id}`)) : new Map<string, string>(); const todo = open.filter((id) => !elsewhere.has(`describe:${id}`));
          if (o.shared) await claim(dealId, todo.map((id) => `describe:${id}`));
          await Promise.all(todo.map(async (id) => {
            let r: Review | null = null; let fileId: string | undefined;
            try { fileId = (await o.keeper.ensure(await o.docs.wanted(dealId, [id])))[id]; } catch (e) { if (unreachable(e)) throw e; }                      // could not be sent: a failed try for this one, and no other
            if (fileId) { try { r = await review(at.get(id)!, fileId); } catch (e) { if (unreachable(e)) throw e; } }
            if (r) o.docs.describe!(dealId, id, r); else miss(id, at.get(id));
          }));
          for (const id of group) asked.delete(key(id));
          if (o.shared) await release(dealId, todo.map((id) => `describe:${id}`)).catch(() => undefined);
        } catch {                                                                // the service cannot be reached, or a description could not be kept: stop here
          for (const id of [...group, ...q.ids.splice(0)]) asked.delete(key(id)); break;
        }
      } } finally { q.run = null; }                                              // cleared in the same step as the queue is seen empty: a document queued after that starts a new round
    }).catch(() => undefined));
  }
  // ── third-party reports: every issue an outside advisor raises is a finding (reports.ts) ──
  const writes = { repo: o.repo, clock, announce: o.announce };
  const reportSweeps = new ReportSweeps({
    later: (work) => later(work),
    sweep: (dealId) => logged('reports', dealId, () => reports(dealId)),
    unreachable,
    retryEvery: () => T.retryEvery,
  });
  /** sweep a deal's reports in the background, after a check gets to the end and after a first pass */
  const reportsSoon = (dealId: string) => reportSweeps.soon(dealId);
  /** this PC's claims on a deal's report work: only another PC's claim keeps it out */
  async function claimReports(dealId: string, keys: string[]) {
    if (!o.shared) return keys;
    const elsewhere = await claimedElsewhere(dealId, keys);
    const free = keys.filter((k) => !elsewhere.has(k));
    await claim(dealId, free);
    return free;
  }
  async function reports(dealId: string) {
    const all = o.docs.records(dealId);
    if (!all.length) return;
    let shut = new Map<string, string>();
    try { shut = o.docs.shut?.(dealId, all.map((r) => r.docId)) ?? shut; } catch { /* none known */ }
    const { docs, earlier } = reportCandidates(all, { where, shut, blacklines: cleanOf(dealId) });
    const m = await models();
    await sweepReports({
      dealId, docs, earlier, where, system: RULES, models: { fast: m.fast, standard: m.standard },
      workstreams: WORKSTREAMS, workstreamOf, fitParas,
      lines: async () => (await lines(dealId)).flatMap((l) => (l.report ? [l.report] : [])),
      say: async (report) => { await say(dealId, { report }); },
      claim: (keys) => claimReports(dealId, keys),
      release: async (keys) => { if (o.shared) await release(dealId, keys).catch(() => undefined); },
      ask: (input, keys) => askJson(input, keys),
      unusable: (sent, keys, shown) => docsUnusable(sent, false, keys, where, shown),
      send: async (rec, model) => {
        const r = await send(sentOf(dealId, [rec]), model);
        return r.got.length ? { files: r.files, listing: r.listing, sent: r.got } : null;
      },
      fit: (text, cited, sent) => fit(text, cited, sent, false, true),
      findings: () => knownFindings(o.repo, dealId),
      raise: (id, issue) => raiseFinding(writes, dealId, id, issue),
      cite: (id, add) => citeFinding(writes, id, add),
      mark: async (id, why) => { await mark(id, why); },
      idFor: (doc, title, n) => reportFindingId(dealId, doc, title, n),
    });
  }

  /** resolves when the documents of a deal that were waiting to be described have been */
  const described = (dealId: string): Promise<void> => waiting.get(dealId)?.run ?? Promise.resolve();

  /** how well a document's record answers to these words: its folder and name, the words it uses most, and what the fast model said of it if it has been described */
  const score = (d: DocRecord, q: Set<string>, dealId: string) => { const have = words(`${where(d)} ${d.name} ${(d.words ?? []).join(' ')} ${d.summary ?? ''} ${(d.keywords ?? []).join(' ')}`, dealId); let n = 0; for (const w of q) if (have.has(w)) n++; return n; };
  /**
   * How well each of a deal's documents answers to these words, by document id. With this PC's word index: name and folder
   * path 10, title 4, body by BM25, each word by how rare it is; what the fast model said of a document
   * (summary and search terms) counts as its title does. Without the index, the count of words its record answers to.
   */
  const scores = (dealId: string, recs: DocRecord[], q: Set<string>): Map<string, number> => {
    const ix = o.docs.wordIndex; if (!ix) return new Map(recs.map((r) => [r.docId, score(r, q, dealId)]));
    const by = ix.score(dealId, q, recs.map((r) => ({ docId: r.docId, named: words(`${where(r)} ${r.name}`, dealId) })));
    const told = ix.score(dealId, q, recs.filter((r) => r.summary || r.keywords?.length || !ix.has(dealId, r.docId)).map((r) => ({ docId: r.docId, named: words(`${r.summary ?? ''} ${(r.keywords ?? []).join(' ')} ${ix.has(dealId, r.docId) ? '' : (r.words ?? []).join(' ')}`, dealId) })), true);
    // `told` is scored on those words alone (not the index's title and body again), as if they were the name (10); the summary and search terms count as the title (4). A document this PC has not read yet is found by its shared most-used words too.
    for (const [id, n] of told) by.set(id, (by.get(id) ?? 0) + (n * 4) / 10);
    return by;
  };
  /** a document as a list shows it: its full path, whether it is an earlier draft (with `dealId`), then its summary, or failing that the words it uses most */
  const shown = (r: DocRecord, most = 12, dealId?: string) => { const newest = dealId ? earlier.get(dealId)?.get(r.docId) : undefined; return `${where(r)}${newest ? ` (an earlier draft; the newest is ${newest})` : ''}${r.summary ? ` — ${r.summary.replace(/\s+/g, ' ')}` : r.words?.length ? ` — words: ${r.words.slice(0, most).join(', ')}` : ''}`; };

  /**
   * A deal's core documents, most important first, worked out on this PC with no model and no cap (core.ts):
   * each checklist item's best matches by file name, folder and most-used words, with its headings and the searches
   * already kept for it, and the synonyms library; the best 100 first, which are described up front. Every PC works out
   * the same set from the same shared records, so nothing is written; a check keeps the set it started with
   * (`RoundDef.core`). Of the drafts of one document only the newest is core, and a blackline counts through its clean
   * draft. The deal's short names (the library's abbreviations, and those its own paths spell out) are taken in here too.
   */
  let cores = new Map<string, { key: string; ids: string[]; best: number }>();
  async function coreOf(dealId: string, quiet = false): Promise<string[]> {
    const all = o.docs.records(dealId); if (!all.length) return [];
    if (o.coreFor) { const ids = o.coreFor(dealId); if (!quiet) describeSoon(dealId, ids.slice(0, CORE_BEST)); return ids; }
    // Overview's figures go by the set already worked out, if any: the searches kept on items change with every result of a check, and the set is worked out again when a check or question next needs it
    const had = cores.get(dealId); if (quiet && had) return had.ids;
    // a document in a folder this person may not open is never core: core documents are kept out of every choice there, so an item that names one waits for it as its own.
    // It stays among the documents the set is worked out from, giving its place to none, so the rest of the set is the same as for a person who can open the folder.
    let shut = new Map<string, string>(); try { shut = o.docs.shut?.(dealId, all.map((r) => r.docId)) ?? shut; } catch { /* none known */ }
    let items: ChecklistItem[] = [];
    try { items = runList.get(dealId) ?? (await dealItems(dealId)) ?? (o.checklist ? merge(await o.checklist({ id: dealId, name: '', product: '', sector: '' })) : []); } catch { /* no checklist to read now: the library stands in for it */ }
    let latest = new Map<string, CheckLine>(); try { for (const l of await lines(dealId)) if (l.item && l.result) latest.set(l.item, l); } catch { /* no kept searches */ }
    const searchesOf = (it: ChecklistItem) => { const l = latest.get(it.id); return l && l.text === it.text ? (l.trail ?? []).map((t) => t.q) : []; };
    const input = items.map((it) => ({ id: it.id, text: it.text, ...(it.heads ? { heads: it.heads } : {}), searches: searchesOf(it) }));
    const docs = all.map((r) => ({ docId: r.docId, path: where(r), ...(r.words ? { words: r.words } : {}), ...(r.seen ? { seen: r.seen } : {}) }));
    const pairs = cleanOf(dealId); const clean = [...pairs].filter(([, c]) => c !== false).sort();
    const key = createHash('sha256').update(JSON.stringify([docs.slice().sort((x, y) => (x.docId < y.docId ? -1 : x.docId > y.docId ? 1 : 0)), input, clean, [...shut.keys()].sort()])).digest('hex').slice(0, 24);
    if (had?.key === key) { if (!quiet) describeSoon(dealId, had.ids.slice(0, had.best)); return had.ids; }
    // the deal's own short names sit beside the library and never replace one of its names
    const learned = shortNamesIn(docs.map((d) => d.path)); learnShort(dealId, { ...learned, ...libraryShort }, key);
    const library = o.library ?? (control.lists.synonyms as string[][]); const known = new Set(library.flat());
    const groups = [...library, ...Object.entries(learned).filter(([k]) => !known.has(k)).map(([k, v]) => [k, v])];
    // an earlier draft gives its place to the newest; a blackline to its clean draft, or to none when that is unclear; a closed document to none
    const standIn = new Map<string, string | null>();
    for (const f of families(docs)) for (const d of f.drafts.slice(1)) standIn.set(d.docId, f.drafts[0].docId);
    // complete families (part 2): a series takes one place, its newest member's; schedules, exhibits and amendments come in with their agreement; no blackline is in either
    const L = control.lists; const fams = docFamilies({ docs, skip: new Set(pairs.keys()), library: groups, filler: CORE_FILLER, relation: L.relationWords, instrument: L.instrumentWords, series: L.seriesWords, part: L.partWords });
    // a series any of whose members is already a draft of another (monthly reports in dated folders) is left to its drafts, so the two never point at each other
    const drafted = new Set([...standIn].flatMap(([a, b]) => [a, b ?? a]));
    for (const s of fams.series) if (!s.some((id) => drafted.has(id))) for (const id of s.slice(1)) standIn.set(id, s[0]);
    for (const [id, c] of clean) standIn.set(id, c as string | null);
    // a blackline with no clean draft here (standalone, or made on another project) takes no place; one with a clean draft stands in for it above, and precedents are left out by core.ts
    for (const [id, c] of cleanOf(dealId)) if (c === false) standIn.set(id, null);
    for (const id of shut.keys()) standIn.set(id, null);
    const set = coreSet({ docs, items: input, standIn, library: groups, filler: CORE_FILLER, ask: ASK_WORDS, families: fams });
    cores.set(dealId, { key, ids: set.ids, best: set.best }); if (cores.size > 200) cores = new Map([...cores].slice(-100));
    if (!quiet) describeSoon(dealId, set.ids.slice(0, set.best));
    return set.ids;
  }
  /** the core documents marked for the fast model when it picks: the best 100, which come first in the set */
  const starred = (core: string[]) => new Set(core.slice(0, CORE_BEST));
  /** take in a deal's short names, as `words` reads them */
  function learnShort(dealId: string, short: Record<string, string>, from: unknown = short) {
    if (shorts.get(dealId)?.from === from) return;
    shorts.set(dealId, { from, map: new Map(Object.entries(short).map(([k, v]) => [shortKey(k), kept(v)])) });
  }
  /**
   * The deal's files ranked against some words, best first: by how many of the words a file's path, most-used words,
   * summary and search terms answer to; then core documents, the more important first; then by path. Nothing here asks a model.
   */
  /**
   * each deal's earlier drafts, by id, with where the newest draft is: said beside them when a list is shown to the fast model.
   * One map per deal, replaced whole by each ranking, so rankings of several deals side by side keep each other's marks.
   */
  const earlier = new Map<string, Map<string, string>>();
  /**
   * Drafts of one document (families.ts): the newest is read first, and the earlier drafts come straight after it, newest
   * first, never hidden. An earlier draft whose newest is not in the list keeps its own place.
   */
  function draftsInOrder(dealId: string, all: DocRecord[], order: DocRecord[]): DocRecord[] {
    const marks = new Map<string, string>(); earlier.set(dealId, marks); const fams = families(all.map((r) => ({ docId: r.docId, path: where(r), ...(r.seen ? { seen: r.seen } : {}) }))); if (!fams.length) return order;
    const byId = new Map(order.map((r) => [r.docId, r])); const after = new Map<string, DocRecord[]>(); const moved = new Set<string>(); const at = new Map(all.map((r) => [r.docId, r]));
    for (const f of fams) {
      const [newest, ...rest] = f.drafts; for (const d of rest) marks.set(d.docId, where(at.get(newest.docId)!));
      if (!byId.has(newest.docId)) continue;
      const kept = rest.map((d) => byId.get(d.docId)).filter((r): r is DocRecord => !!r); after.set(newest.docId, kept); for (const r of kept) moved.add(r.docId);
    }
    return order.flatMap((r) => (moved.has(r.docId) ? [] : [r, ...(after.get(r.docId) ?? [])]));
  }
  /** each blackline of a deal, by id, with its clean draft's id; null when that is unclear, false when it stands alone (blacklines.ts) */
  const cleanOf = (dealId: string) => kindsOf(dealId).pairs;
  /**
   * A deal's blacklines, what each was compared against, and its documents of another project (docs/other-project-documents-design.md),
   * worked out again only when the deal's documents change: every ranking and every answer asks for them.
   */
  const SECONDARY_AHEAD = 2;
  let kinds = new Map<string, { key: string; pairs: Map<string, string | null | false>; against: Map<string, Against>; precedents: Set<string>; secondary: Set<string> }>();
  function kindsOf(dealId: string, recs = o.docs.records(dealId)) {
    const key = recs.map((r) => `${r.docId}|${r.folder}|${r.rel}|${r.name}|${r.seen ?? ''}|${(r.copies ?? []).map((c) => `${c.folder}/${c.rel}`).join('|')}|${r.cover?.length ?? ''}`).join('\n');
    const had = kinds.get(dealId); if (had?.key === key) return had;
    const pairs = cleanDrafts(recs); const against = againstOf(recs, pairs);
    // another project's documents: those of them that are blacklines are told and tagged as blacklines
    const precedents = new Set(recs.filter((r) => !pairs.has(r.docId) && !isBlackline(r) && otherProject(r)).map((r) => r.docId));
    // never a main source: another project's documents, and a blackline not shown to be against this deal's own earlier draft
    const secondary = new Set([...precedents, ...[...against].filter(([, a]) => a !== 'own').map(([id]) => id)]);
    const k = { key, pairs, against, precedents, secondary }; kinds.set(dealId, k); if (kinds.size > 50) kinds = new Map([...kinds].slice(-25));
    return k;
  }
  /** whether a source cited from these documents is one of this deal's own, which may be a main source */
  const mainIn = (sent: Sent[], x: Source) => { const sec = new Map<string, Set<string>>(); const of = (d: string) => sec.get(d) ?? (sec.set(d, kindsOf(d).secondary), sec.get(d)!); return sent.some((s) => s.rec.docId === x.docId && (!x.dealId || x.dealId === s.dealId) && !of(s.dealId).has(x.docId)); };
  /** whether a source is never a main one: another project's document, or a blackline not shown to be against this deal's own draft */
  const secondary = (dealId: string, docId: string) => kindsOf(dealId).secondary.has(docId);
  /**
   * each blackline of a deal, by id, with its clean draft's record, worked out once for a whole list: pairing each of
   * many documents on its own would look the deal's blacklines up again for every one of them
   */
  function cleanDraftsOf(dealId: string): Map<string, DocRecord> {
    const all = new Map(o.docs.records(dealId).map((r) => [r.docId, r]));
    const out = new Map<string, DocRecord>();
    for (const [id, c] of cleanOf(dealId)) {
      const clean = c ? all.get(c) : undefined;
      if (clean) out.set(id, clean);
    }
    return out;
  }
  /** these documents, each blackline's clean draft put just before it when it is not there already */
  function withClean(dealId: string, recs: DocRecord[]): DocRecord[] {
    const cleans = cleanDraftsOf(dealId);
    if (!cleans.size) return recs;
    const out: DocRecord[] = [];
    for (const r of recs) {
      const clean = cleans.get(r.docId);
      if (clean && !recs.includes(clean) && !out.includes(clean)) out.push(clean);
      out.push(r);
    }
    return out;
  }
  /** `hits`: only the documents that answer to the words at all, so a search sorts its hits, not the whole data room */
  /** `pre`: the deal's records and blackline pairs, when a caller ranking many searches at once has them already */
  function ranked(dealId: string, what: string, not: Set<string>, core: string[], hits = false, pre?: { all: DocRecord[]; bl: ReturnType<typeof cleanOf> }): DocRecord[] {
    // a blackline whose clean draft is unclear is not read for its changes; a standalone one is
    const q = words(what, dealId); const rank = new Map(core.map((id, i) => [id, i])); const all = pre?.all ?? o.docs.records(dealId); const bl = pre?.bl ?? cleanOf(dealId); const recs = all.filter((r) => !not.has(r.docId) && bl.get(r.docId) !== null); const s = scores(dealId, recs, q);
    const order = recs.map((r) => ({ r, n: s.get(r.docId) ?? 0, at: where(r) })).filter((x) => !hits || x.n > 0)
      .sort((x, y) => y.n - x.n || (rank.get(x.r.docId) ?? Infinity) - (rank.get(y.r.docId) ?? Infinity) || (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).map((x) => x.r);
    return draftsInOrder(dealId, all, aside(dealId, order, all));
  }
  /**
   * Sources that are never a main one take at most `SECONDARY_AHEAD` places among this deal's own documents: the rest
   * follow all of them, in their order, so a data room with a hundred blacklines or a precedents folder never crowds the
   * deal's own documents out of a call, and nothing is left out of the ranking (docs/other-project-documents-design.md).
   */
  function aside(dealId: string, order: DocRecord[], all?: DocRecord[]): DocRecord[] {
    const sec = kindsOf(dealId, all).secondary; if (!sec.size) return order;
    const ahead: DocRecord[] = []; const after: DocRecord[] = []; let n = 0;
    for (const r of order) (sec.has(r.docId) && n++ >= SECONDARY_AHEAD ? after : ahead).push(r);
    return [...ahead, ...after];
  }
  /** the ranking as a pick lists it: each file by its docId, a core document marked *, then its path (#1162) */
  function pickListing(list: DocRecord[], core: string[], dealId: string): string {
    const isCore = starred(core);
    return list.map((r) => `${r.docId}${isCore.has(r.docId) ? ' *' : ''}: ${shown(r, 12, dealId)}`).join('\n');
  }
  /** the files a pick's reply names by docId, in its order, each once, `most` at most */
  function pickedFrom(list: DocRecord[], named: unknown, most: number): DocRecord[] {
    const byId = new Map(list.map((r) => [r.docId, r]));
    const ids = [...new Set(listOf(named))].filter((id): id is string => typeof id === 'string');
    return ids.map((id) => byId.get(id)).filter((r): r is DocRecord => !!r).slice(0, most);
  }
  /**
   * The fast model's pick from a listing of `list`; null when it could not be asked or its reply cannot be read.
   * `items`: the ids of the checklist items a pick for several items is keyed by.
   */
  async function askPick(list: DocRecord[], listed: string, items?: string[]): Promise<{ read?: unknown } | null> {
    const prompt = `${PICK_INTRO}\n${listed}`;
    const model = (await models()).fast;
    const unusable = pickUnusable(list, items);
    const input: Ask = { kind: 'pick', split: true, model, system: JSON_ONLY, unusable, prompt };
    try {
      return await askJson<{ read?: unknown }>(input, ['read']);
    } catch (e) {
      if (unreachable(e)) throw e;
      return null;
    }
  }
  /**
   * A pick whose reply names a file, or keys a checklist item of `items`, by an id it was not shown is a failed reply,
   * asked again (#1162)
   */
  const pickUnusable = (list: DocRecord[], items?: string[]) => (text: string) => {
    const read = json<{ read?: unknown }>(text, 'read')?.read;
    const named = isObject(read) ? Object.values(read).flatMap(listOf) : listOf(read);
    const keyed = items && isObject(read) ? unknownIds(Object.keys(read), items) : [];
    return unknownIds(named, list.map((r) => r.docId)).length > 0 || keyed.length > 0;
  };
  /**
   * What to read for something, in two steps: the keyword ranking, then the fast model's pick from the top of it, each
   * file shown by its full path and summary with core documents marked. `room` at most, none if nothing bears on it.
   * `rankBy` is the words to rank by when `what` says more than them. Null when the model could not be asked or its
   * reply could not be read; the caller then goes by the ranking alone. `found` are documents a search found for it
   * they head the list, and the ranking fills the rest.
   */
  async function pick(dealId: string, what: string, not: Set<string>, room: number, core: string[], rankBy = what, found: DocRecord[] = []): Promise<DocRecord[] | null> {
    // what searches found heads the list, still with two at most of the sources that are never a main one ahead
    const list = aside(dealId, headed(found, ranked(dealId, rankBy, not, core), not)); if (!list.length || room < 1) return [];
    const ask = `Which of them should be read for this?\n${what}\n\nChoose up to ${room}, the most useful first. `
      + 'Start from the core documents, and choose another only when this needs it. If none of them bears on it, '
      + 'choose none.\nReply as JSON: {"read": ["an id", "another id"]}';
    const reply = await askPick(list, `${pickListing(list, core, dealId)}\n\n${ask}`);
    if (!reply || !('read' in reply)) return null;
    return pickedFrom(list, reply.read, room);
  }
  /**
   * The chat's document search as fixed pages (#1102): the keyword ranking as `top` gives it with no room set, only the
   * documents that answer to a word of the query, best first, across deals in turn as `folderList` takes them. A page
   * of it is cut as a folder read's batches are (agentFolder.ts `batchesOf`).
   */
  async function searchRanking(deals: string[], query: string): Promise<DealDoc[]> {
    const per = await Promise.all(deals.map(async (dealId) =>
      top(dealId, query, new Set(), Infinity, await coreOf(dealId), false).map((rec) => ({ dealId, rec }))));
    return interleave(per);
  }
  /** one page of the chat's document search, read by the helper under a search's budget of calls (`budgetOf`) */
  function readSearchPage(budgetOf: { left: number }, deals: string[], model: string, ask: string,
    docs: DealDoc[]): Promise<Looked> {
    const shape = '{"text": "what they say, with [n] markers", "sources": [...]}';
    return budget.run(budgetOf, () => read('search', deals, model, ask, '', {}, shape, undefined, docs));
  }
  /**
   * The documents in a folder a person named, in the order to read them for something, across the deals asked
   * about, ranked by code alone: by how many of the words a file answers to; then the deal's core documents, the more
   * important first; then by path; each document's earlier drafts straight after it. No model is asked (#286). A
   * blackline whose clean draft is unclear is left out, as everywhere else. `near` are the data room's folders a level
   * or two down, when the name matches none, so that the model can name one that is there.
   */
  async function folderList(deals: string[], said: string, what: string): Promise<{ folders: string[]; docs: { dealId: string; rec: DocRecord }[]; near: string[] }> {
    const q = words(what);
    const folders: string[] = []; const per: { dealId: string; rec: DocRecord }[][] = []; const near = new Set<string>();
    for (const dealId of deals) {
      const all = o.docs.records(dealId); const dirs = foldersOf(all.map(where)); const found = matchFolders(dirs, said);
      if (!found.length) { for (const d of dirs) if (d.split('/').length <= 2) near.add(d); continue; }
      folders.push(...found);
      const bl = cleanOf(dealId); const recs = all.filter((r) => inside(where(r), found) && bl.get(r.docId) !== null); if (!recs.length) continue;
      const core = await coreOf(dealId); const rank = new Map(core.map((id, i) => [id, i])); const s = scores(dealId, recs, q);
      const order = draftsInOrder(dealId, all, recs.map((r) => ({ r, n: s.get(r.docId) ?? 0, at: where(r) }))
        .sort((x, y) => y.n - x.n || (rank.get(x.r.docId) ?? Infinity) - (rank.get(y.r.docId) ?? Infinity) || (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).map((x) => x.r));
      per.push(order.map((rec) => ({ dealId, rec })));                                         // the ranking is the order (#286)
    }
    // across deals, in turn: each deal's first, then each deal's second, and so on
    const docs: { dealId: string; rec: DocRecord }[] = []; for (let i = 0; per.some((p) => i < p.length); i++) for (const p of per) if (i < p.length) docs.push(p[i]);
    return { folders, docs, near: folders.length ? [] : [...near].sort().slice(0, 40) };
  }
  /**
   * The same two steps for several things at once, when each needs documents of its own: one ranking against all of
   * them, and one question to the fast model, which says for each which files to read, `each` at most and none if none
   * bears on it. One call in place of one per thing. Null when the model could not be asked or its reply could not be
   * read; the caller then goes by the ranking, thing by thing. `found` are the documents a search found for each thing
   * they head the list, each thing is told which they are, and the ranking fills the rest.
   */
  async function pickFor(dealId: string, things: { id: string; what: string; rankBy: string }[], not: Set<string>, each: number, core: string[], found?: Map<string, DocRecord[]>): Promise<Map<string, DocRecord[]> | null> {
    const list = headed(found ? interleave(things.map((t) => found.get(t.id) ?? [])) : [], ranked(dealId, things.map((t) => t.rankBy).join(' '), not, core), not); const out = new Map<string, DocRecord[]>(things.map((t) => [t.id, []]));
    const hint = (t: { id: string }) => {
      const at = (found?.get(t.id) ?? []).filter((r) => list.includes(r)).map((r) => r.docId);
      return found?.has(t.id) ? ` (its searches found ${at.length ? at.join(', ') : 'none of them'})` : '';
    };
    if (!list.length || each < 1 || !things.length) return out;
    // each item is shown by its permanent id, never a running number its words could be confused with (#1162)
    const asked = things.map((t) => `${t.id}: ${t.what.replace(/\n/g, ' ')}${hint(t)}`).join('\n');
    const ask = `Which of them should be read for each of these?\n${asked}\n\nFor each, choose up to ${each}, the most `
      + 'useful first. If none of the files bears on one, choose none for it.\n'
      + `Reply as JSON: {"read": {"${things[0].id}": ["an id", "another id"]}}`;
    const ids = things.map((t) => t.id);
    const reply = await askPick(list, `${pickListing(list, core, dealId)}\n\n${ask}`, ids);
    if (!reply || !('read' in reply) || !reply.read || typeof reply.read !== 'object') return null;
    const picked = (v: unknown) => pickedFrom(list, v, each);
    // one list for all of them: each is given it
    if (Array.isArray(reply.read)) {
      for (const t of things) out.set(t.id, picked(reply.read));
      return out;
    }
    for (const [k, v] of Object.entries(reply.read as Record<string, unknown>)) {
      if (out.has(k)) out.set(k, picked(v));
    }
    return out;
  }
  /**
   * Without the fast model's pick: the top of the ranking as it stands. Only files that answer to the words, and, when
   * `withCore`, core documents after them.
   */
  function top(dealId: string, what: string, not: Set<string>, room: number, core: string[], withCore: boolean): DocRecord[] {
    const q = words(what, dealId); const isCore = withCore ? starred(core) : new Set<string>(); const list = ranked(dealId, what, not, core); const s = scores(dealId, list, q);
    return list.filter((r) => (s.get(r.docId) ?? 0) > 0 || isCore.has(r.docId)).slice(0, Math.max(0, room));
  }
  /** documents a search found, first, then the ranking, with none twice and none of `not`: the list the fast model picks from, `shortlist` long */
  const headed = (found: DocRecord[], rest: DocRecord[], not: Set<string>) => [...new Set([...found, ...rest])].filter((r) => !not.has(r.docId)).slice(0, shortlist);
  /** several lists as one, taking each list's first, then each one's second, and so on: no list crowds out the others */
  const interleave = <T,>(lists: T[][]): T[] => { const out: T[] = []; for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && !out.includes(l[i])) out.push(l[i]); return out; };

  // ── the checks' search agent ───────────────────────────────────────────────────────────────────────────────────
  /**
   * Finding the documents for checklist items, as the chat agent's search helper does: the fast model says what to search
   * for, in the words the documents are likely to use (their usual names, defined terms, abbreviations), and each search
   * runs on the word index with no model. Searches that find nothing are put once more in other words. What was searched
   * for, and how many documents answered, is the item's search trail, kept on its result and shown on a gap.
   *
   * Calls are counted per search run (`searchCalls`). A search that cannot be made (the budget is spent, or
   * the fast model's reply cannot be read) returns null, and the caller picks documents as it did before searches:
   * a failed search is never taken to mean that nothing was found, so it never makes a gap by itself.
   * Throws only when the service cannot be reached.
   */
  type Trail = { q: string; n: number }[];
  const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
  /** words a model gives in place of a search when it has none ("None", "not applicable", "TBD"); a search of only these, or of nothing the index keeps, is no search */
  // folded as the index folds words (`kept`), so each entry matches the form a reply's words take; "n" and "a" are the
  // words of "N/A" and "n.a.", which `kept` keeps whatever their length
  const NO_SEARCH = new Set([
    'additional', 'a', 'applicable', 'applies', 'apply', 'available', 'cannot', 'cant', 'empty', 'extra', 'find',
    'found', 'further', 'given', 'idea', 'keyword', 'keywords', 'missing', 'more', 'n', 'na', 'nan', 'necessary',
    'need', 'needed', 'needs', 'neither', 'never', 'nil', 'no', 'non', 'none', 'nor', 'not', 'nothing', 'null',
    'other', 'others', 'pass', 'pending', 'placeholder', 'provided', 'queries', 'query', 'relevant', 'require',
    'required', 'requires', 'result', 'results', 'search', 'searched', 'searches', 'searching', 'skip', 'skipped',
    'specific', 'sure', 'tba', 'tbc', 'tbd', 'term', 'terms', 'unable', 'unclear', 'undefined', 'unknown', 'unsure',
    'word', 'words'
  ].map(fold));
  const isSearch = (x: string) => kept(x).some((w) => !NO_SEARCH.has(w));
  const SEARCHES = 3;                                                            // searches the fast model may give one item at a time
  const FOUND = 12;                                                              // documents one item's searches put at the head of the pick list
  /** a checklist item for a search, and the searches already made for it that found nothing */
  const triedLine = (t: { id: string; what: string }, tried?: Map<string, Trail>) => {
    const done = tried?.get(t.id) ?? [];
    const before = done.length ? ` (searched already, finding nothing: ${done.map((x) => `"${x.q}"`).join(', ')})` : '';
    // each item is shown by its permanent id, never a running number its words could be confused with (#1162)
    return `${t.id}: ${t.what.replace(/\s+/g, ' ')}${before}`;
  };
  /** what the fast model is asked for the searches for some checklist items; `tried`, when it is asked once more */
  const queryPrompt = (them: { id: string; what: string }[], tried?: Map<string, Trail>) => {
    const again = tried ? ' Each has been searched for already and nothing answered: search in other words.' : '';
    return [
      'These are items of a due diligence checklist for a project-finance deal, each with its id:',
      ...them.map((t) => triedLine(t, tried)),
      '',
      'The documents in the data room are searched by the words in their file names, folder names and text. For each'
        + ` item, write up to ${SEARCHES} short searches, a few words each, for the documents that would settle it: the`
        + ' names such documents usually have, and the words and defined terms they use. If you have no search for an'
        + ` item, give it an empty list.${again}`,
      `Reply as JSON: {"queries": {"${them[0].id}": ["…", "…"]}}`,
    ].join('\n');
  };
  /** a search reply naming an item, in its words or as a key, by an id it was not shown is asked again (#1162) */
  const queryUnusable = (ids: string[]) => (text: string) => {
    const queries = readJson(text, ['queries'])?.queries;
    return !namesOnlyShown(text, ids) || (isObject(queries) && unknownIds(Object.keys(queries), ids).length > 0);
  };
  async function searchFor(
    dealId: string, things: { id: string; what: string }[], not: Set<string>, core: string[],
  ): Promise<{ found: Map<string, DocRecord[]>; trails: Map<string, Trail> } | null> {
    if (!things.length) return { found: new Map(), trails: new Map() };
    const ask = async (them: typeof things, tried?: Map<string, Trail>): Promise<Map<string, string[]> | null> => {
      let reply: { queries?: unknown } | null;
      const input: Ask = { kind: 'query', model: (await models()).fast, system: JSON_ONLY,
        prompt: queryPrompt(them, tried), unusable: queryUnusable(them.map((t) => t.id)) };
      try { reply = await askJson(input, ['queries'], undefined, false); }
      catch (e) { if (unreachable(e)) throw e; return null; }                  // out of calls for this search, or the call failed: no search
      if (!reply?.queries || typeof reply.queries !== 'object' || Array.isArray(reply.queries)) return null;
      const out = new Map<string, string[]>();
      // a "search" with no word the index can look for ("N/A", "-", only filler words), or only placeholders ("None", "TBD"), is how a model gives none: it is not counted as one
      for (const [k, v] of Object.entries(reply.queries as Record<string, unknown>)) {
        const t = them.find((x) => x.id === k);
        const said = strings(v).map((x) => cut(x.replace(/\s+/g, ' ').trim(), 60));
        if (t) out.set(t.id, said.filter((x) => isSearch(x)).slice(0, SEARCHES));
      }
      return out;
    };
    // a search's count is of every document that answers to it, read already or not, so a trail never says nothing answered when something did
    const run = (q: string, pre: { all: DocRecord[]; bl: ReturnType<typeof cleanOf> }) => { const all = ranked(dealId, q, new Set(), core, true, pre); return { n: all.length, got: all.filter((r) => !not.has(r.docId)) }; };
    const found = new Map<string, DocRecord[]>(); const trails = new Map<string, Trail>(); const hits = new Map<string, DocRecord[][]>();
    // each search takes some milliseconds at data-room scale, so the backend yields between them rather than hold the app for a whole reply's searches
    const take = async (said: Map<string, string[]>, them: typeof things) => { const pre = { all: o.docs.records(dealId), bl: cleanOf(dealId) }; for (const t of them) for (const q of said.get(t.id) ?? []) { await new Promise<void>((r) => setImmediate(r)); const { n, got } = run(q, pre); (hits.get(t.id) ?? hits.set(t.id, []).get(t.id)!).push(got); trails.set(t.id, [...(trails.get(t.id) ?? []), { q, n }]); } };
    return budget.run({ left: o.searchCalls ?? control.limits.searchCalls }, async () => {
      const first = await ask(things); if (!first) return null;
      await take(first, things);
      // an item the reply gave no searches for was not searched: it is left out of `found`, and is picked for as before
      const given = (said: Map<string, string[]> | null, t: (typeof things)[number]) => !!said?.get(t.id)?.length;
      const none = things.filter((t) => given(first, t) && !(hits.get(t.id) ?? []).some((l) => l.length));
      // once more in other words; an item whose second search cannot be made, or is given none, is left out of `found` too
      const again = none.length ? await ask(none, trails) : null; if (again) await take(again, none);
      for (const t of things) if (given(first, t) && (!none.includes(t) || given(again, t))) found.set(t.id, interleave(hits.get(t.id) ?? []).slice(0, FOUND));
      return { found, trails };
    });
  }
  /** the documents a question starts with: what it must have, then the fast model's pick from the ranking, or failing that the top of the ranking */
  async function start(dealId: string, question: string, must: string[], room: number, core: string[], skip: string[] = []): Promise<DocRecord[]> {
    // what it must have counts against the call's room too: the first `room` of them, in the order given (attachments come first)
    const recs = o.docs.records(dealId); const given = must.map((id) => recs.find((r) => r.docId === id)).filter((r): r is DocRecord => !!r).filter((r, i, all) => all.indexOf(r) === i).slice(0, Math.max(0, room));
    const not = new Set([...given.map((r) => r.docId), ...skip]);
    return withClean(dealId, [...given, ...((await pick(dealId, question, not, room - given.length, core)) ?? top(dealId, question, not, room - given.length, core, true))]);
  }
  /** a draft's tracked changes as prompt lines, and the tokens they take */
  type ChangeLines = { lines: string[]; used: number };
  /**
   * A Word file's tracked changes as prompt lines: each changed passage as it was and as it reads now, with who changed
   * what and when. They are listed while their tokens fit in `room`, what is left of the prompt's budget for tracked
   * changes, and the rest is counted (#1092). `used` is the tokens the listed passages took.
   */
  async function changesOf(dealId: string, id: string, docId: string, room: number): Promise<ChangeLines> {
    const none: ChangeLines = { lines: [], used: 0 };
    if (!o.docs.changes) return none;
    let r: Result<ChangeList>; try { r = await o.docs.changes(dealId, docId); } catch { return none; }
    if (!r.ok || !r.value.passages.length) return none;
    const out = [`  The changes in ${id}, read from the file itself (these are fact, not a reading):`];
    let used = 0, left = 0;
    for (const p of r.value.passages) {
      const who = p.changes.map((c) => `${c.kind}${c.text ? ` "${c.text.replace(/\s+/g, ' ').trim()}"` : ''}${c.by ? ` by ${c.by}` : ''}${c.at ? ` on ${c.at.slice(0, 10)}` : ''}`).join('; ');
      const line = `  - was: "${p.before.replace(/\s+/g, ' ').trim()}" / now: "${p.after.replace(/\s+/g, ' ').trim()}" (${who})`;
      const tokens = tokensOf(line);
      if (used + tokens > room) {
        left++;
        continue;
      }
      out.push(line);
      used += tokens;
    }
    if (left) out.push(`  - and ${left} more changed passage${left === 1 ? '' : 's'}, not listed here.`);
    if (!r.value.complete) out.push('  Some changes are in parts of the file this list does not reach.');
    return { lines: out, used };
  }
  /**
   * What the model is told of a blackline: the clean draft is the truth for the deal's terms,
   * and a change it reports from the blackline is its reading of the markup, cited to the blackline's page. With
   * pipeline A the markup's strike-through and colors may not reach it, so deleted words can read as kept ones.
   */
  function blacklineLine(s: Sent, mine: Sent[], cleanId: string | null | false, against: Against,
    idOf: (x: Sent) => string): string {
    const id = idOf(s);
    const clean = cleanId ? mine.find((x) => x.rec.docId === cleanId) : undefined; const rec = cleanId ? o.docs.records(s.dealId).find((r) => r.docId === cleanId) : undefined;
    // a standalone blackline: no clean draft is in the data room, so what it shows is never taken as the deal's terms
    const of = clean
      ? `its clean draft is ${idOf(clean)}. ${idOf(clean)} is what the deal's terms are`
      : rec
        ? `its clean draft is ${where(rec)}, which is not given here. The terms are what that clean draft says`
      : cleanId === false
        ? 'no clean draft of it was found by its cover or name. '
          + 'What it shows is not confirmed as the deal\'s terms: say so wherever you rely on it'
        : 'which clean draft it goes with is not clear. The terms are what a clean draft says';
    const sees = (o.blackline ?? control.blackline.pipeline) === 'A' ? ' Its strike-through and colors may not come through to you, so deleted words can read as if they were kept: be careful which wording is the new one.' : ' Struck-through words are deleted and colored words are inserted.';
    // what it was compared against (docs/other-project-documents-design.md): only this deal's own earlier draft makes its changes the deal's
    const vs = against === 'own' ? '' : against === 'other' && cleanId === false
      ? ` ${id} was made on another project: neither side of it is this deal's. Use it only to compare, and cite it `
        + 'only beside a document of this deal.'
      : against === 'other'
        ? ` ${id} compares this deal's draft with another project's document. Its deleted wording is the other `
          + 'project\'s, not an earlier draft of this deal: never report a deletion or insertion as a change made in '
          + 'this deal.'
      : ` ${id} compares its clean draft with another document, which may be an earlier draft of this deal or another `
        + 'project\'s. Do not report a difference as a change made in this deal unless a draft of this deal shows it.';
    const alone = against === 'own' ? '' : ` By itself it never shows that a finding is put right or that its problem is back.`;
    const compared = against === 'own' ? 'drafts' : 'documents';
    return `  ${id} is a blackline: a comparison of two ${compared} with the changes marked, made by a comparison `
      + `tool; ${of}. Read ${id} only for what changed, and give each change as what ${id} appears to show, citing `
      + `its page.${sees}${vs}${alone}`;
  }
  /**
   * Put these documents in the store and describe them for the prompt. `got` are the ones that are really there: a
   * document whose file cannot be found on this PC is left out, and nothing may be recorded as read from it. `model`
   * is the one the prompt goes to: the drafts' tracked changes share one budget, the share of its input limit that a
   * part may fill, drawn on in the order the drafts are listed (#1092). `spansDeals`: the prompt spans several deals,
   * so each document is named with its deal (#1162).
   */
  async function send(sent: Sent[], model: string, spansDeals = false):
    Promise<{ files: string[]; listing: string; got: Sent[] }> {
    const files: string[] = []; const lines: string[] = []; const got: Sent[] = [];
    const idOf = (s: Sent) => docHandle(s, spansDeals);
    let changesRoom = Math.floor((inLimit(model) * control.limits.partShare) / 100);
    for (const dealId of new Set(sent.map((s) => s.dealId))) {
      const mine = sent.filter((s) => s.dealId === dealId); const ids = await o.keeper.ensure(await o.docs.wanted(dealId, mine.map((s) => s.rec.docId)));
      describeSoon(dealId, mine.map((s) => s.rec.docId));                          // a document that is read is worth describing: once, and not waited for
      for (const s of mine) {
        const id = ids[s.rec.docId]; if (!id) continue; files.push(id); got.push(s);
        const rec = o.docs.records(dealId).find((r) => r.docId === s.rec.docId) ?? s.rec;          // a Word file's pages are counted when it is first sent, just now
        lines.push(`${idOf(s)}: ${where(rec)}${rec.pages ? ` (${rec.pages} pages)` : ''}`);
        // a draft's pages show its tracked changes as markup: say so, and send the changes themselves, read from the
        // file, which are fact
        if (rec.tracked) {
          lines.push(`  ${idOf(s)} has ${rec.tracked} tracked changes. Its pages show them as markup, `
            + 'so its wording is proposed, not agreed.');
          const changes = await changesOf(dealId, idOf(s), rec.docId, changesRoom);
          lines.push(...changes.lines);
          changesRoom -= changes.used;
        }
        const k = kindsOf(dealId);
        const against = k.against.get(rec.docId) ?? 'own';
        if (k.pairs.has(rec.docId)) lines.push(blacklineLine(s, mine, k.pairs.get(rec.docId) ?? null, against, idOf));
        // another project's document (docs/other-project-documents-design.md): read, never a main source
        else if (k.precedents.has(rec.docId)) {
          lines.push(`  ${idOf(s)} is another project's document, not this deal's. Its terms are never this deal's: `
            + 'use it only to compare, and cite it only beside a document of this deal. By itself it never shows that '
            + 'a finding is put right or that its problem is back.');
        }
      }
    }
    return { files, listing: lines.join('\n'), got };
  }
  /** those of some documents that can be put in the store from this PC. A store that cannot take them is none of them; only a service that cannot be reached throws. */
  /** `unsent`, when given, is filled with the ids of those that could not be put in the store, so a reason names only them */
  async function sendable(dealId: string, docs: DocRecord[], unsent?: string[]): Promise<DocRecord[]> {
    if (!docs.length) return [];
    let ids: Record<string, string>;
    try { ids = await o.keeper.ensure(await o.docs.wanted(dealId, docs.map((r) => r.docId))); }
    catch (e) { if (unreachable(e)) throw e; return []; }   // nothing was sent, but not for any one file: the reason names none
    const missing = docs.filter((r) => !ids[r.docId]).map((r) => r.docId); unsent?.push(...missing);
    // A document whose folder cannot be reached just now is still one of the deal's. What was chosen is then not all there
    // to read, and nothing is settled on the part that is: none of them, so the caller writes "could not be checked".
    if (awayAmong(dealId, missing)) return [];
    return docs.filter((r) => !!ids[r.docId]);
  }
  /** whether, of the documents meant to be sent, one that was not is one whose folder cannot be reached just now */
  const lostSome = (sent: Sent[], got: Sent[]) => got.length < sent.length && [...new Set(sent.map((s) => s.dealId))].some((d) => awayAmong(d, sent.filter((s) => s.dealId === d && !got.includes(s)).map((s) => s.rec.docId)));
  /** the reason an item could not be checked when some of its documents cannot be read just now, naming them (the first three, then how many more) */
  const awayWhy = (dealId: string, docIds: string[]) => {
    const ids = docIds.length ? [...new Set(o.docs.away?.(dealId, [...new Set(docIds)]) ?? [])] : []; if (!ids.length) return AWAY;
    const listOf = (all: string[]) => { const shown = all.slice(0, 3); const more = all.length - shown.length; return more ? `${shown.join(', ')} and ${more} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0]; };
    // out of reach because a folder may not be opened by this person: the folder is named, not each file in it
    const shut = o.docs.shut?.(dealId, ids) ?? new Map<string, string>(); const folders = [...new Set(shut.values())].filter(Boolean);
    if (folders.length && shut.size === ids.length) return `The folder${folders.length === 1 ? '' : 's'} ${listOf(folders)} could not be opened on this PC.`;
    const names = new Map(o.docs.records(dealId).map((r) => [r.docId, r.name])); const all = [...new Set(ids.map((id) => names.get(id) ?? '').filter(Boolean))]; if (!all.length) return AWAY;
    return `${AWAY.slice(0, -1)}: ${listOf(all)}.`;
  };
  /** whether any of these documents, which could not be sent, is one whose folder cannot be reached just now */
  const awayAmong = (dealId: string, docIds: string[]) => docIds.length > 0 && (o.docs.away?.(dealId, docIds).length ?? 0) > 0;
  /** Keep the sources we can stand behind, in order, and renumber the markers in the text to match. */
  function fit(text: string, cited: Cited[] | undefined, sent: Sent[], withDeal: boolean, once = false): { text: string; sources: Source[] } {
    const seen = new Map<string, Map<string, string | null | false>>(); const blacklines = (dealId: string) => { let m = seen.get(dealId); if (!m) { m = cleanOf(dealId); seen.set(dealId, m); } return m; };
    const pre = new Map<string, Set<string>>(); const precedents = (dealId: string) => pre.get(dealId) ?? (pre.set(dealId, kindsOf(dealId).precedents), pre.get(dealId)!);
    const sources: Source[] = []; const renumber = new Map<number, number>(); const placed = new Map<string, number>();
    (listOf(cited) as Cited[]).forEach((c, i) => {
      const s = sentAs(c?.doc ?? c?.document, sent, where); if (!s) return;
      let loc: string;
      if (SHEET.test(s.rec.name)) { const cell = typeof c.cell === 'string' ? (c.cell.includes('!') || typeof c.sheet !== 'string' ? c.cell : `${c.sheet}!${c.cell}`).trim() : ''; if (!/^[^!]+!\$?[A-Za-z]{1,3}\$?\d+$/.test(cell)) return; loc = cell; }
      // a Word or PowerPoint file has its pages counted only when it is first sent, so the record is read again for them
      else { const pages = s.rec.pages ?? o.docs.records(s.dealId).find((r) => r.docId === s.rec.docId)?.pages; const page = pageOf(c.page); if (page === null || page < 1 || (pages !== undefined && page > pages)) return; loc = `p. ${page}`; }
      // `once`: the same place cited again is one source, its marker pointing at the first and its quote kept when the first had none
      // (a finding may stand on one place). Answers keep each citation, since two passages may share a page.
      // A cell is the same place however it is written ("Sheet1!$B$2", "sheet1!b2"); a quote of only spaces is no quote.
      const key = `${s.dealId}|${s.rec.docId}|${loc.replace(/\$/g, '').toLowerCase()}`; const at = once ? placed.get(key) : undefined;
      if (at) { const had = sources[at - 1]; const q = typeof c.quote === 'string' ? c.quote : ''; if (!had.quote?.trim() && q.trim()) had.quote = q; renumber.set(i + 1, at); return; }
      placed.set(key, sources.length + 1); renumber.set(i + 1, sources.length + 1);
      sources.push({ doc: s.rec.name, loc, docId: s.rec.docId, ...(typeof c.quote === 'string' && c.quote ? { quote: c.quote } : {}), ...(withDeal ? { dealId: s.dealId } : {}), ...(blacklines(s.dealId).has(s.rec.docId) ? { reading: true } : precedents(s.dealId).has(s.rec.docId) ? { precedent: true } : {}) } as Source);   // a blackline's page is the model's reading of it; another project's document is tagged so
    });
    const out = String(text ?? '')
      .replace(/\s*\[(\d+)\]/g, (_m, n) => (renumber.has(+n) ? ` [${renumber.get(+n)}]` : ''))
      .replace(/\{([^{}|]+)\|[^{}]*\}/g, '$1')
      .replace(/ \[(\d+)\](?: ?\[\1\])+/g, once ? ' [$1]' : '$&');
    return { text: out, sources };
  }
  const dealIds = async (): Promise<string[]> => { const r = await o.repo.list('deal', '_'); return r.ok ? r.value.map((l) => l.id) : []; };
  /**
   * The other deals that hold most of this deal's documents: the same files, by content, in another deal's data room,
   * found as this deal's folders are indexed. Documents `SHARED_BY` or more other deals hold too, such as a precedents folder many
   * deals read, are left out: what is counted is this
   * deal's own (`of`). Another deal must hold at least `ALSO_LEAST` of them and `SHARE` of them, and `SHARE` of each of this
   * deal's folders large enough to judge (`ALSO_LEAST` documents and `FOLDER_PART` of them), so one folder shared with a
   * single deal does not make the two look alike, while a small folder of the team's own does not hide a copy. The `ALSO_MAX` best. Worked out again only when this deal's documents
   * change in number, or after `ALSO_MS`, since it reads every deal's documents.
   */
  type Also = { dealId: string; docs: number; of: number };
  const alsoMemo = new Map<string, { n: number; at: number; deals: Also[] }>();
  async function alsoIn(dealId: string, mine: { docId: string; folder: string }[]): Promise<Also[]> {
    const had = alsoMemo.get(dealId); if (had && had.n === mine.length && Date.now() - had.at < ALSO_MS) return had.deals;
    const deals: Also[] = [];
    if (mine.length >= ALSO_LEAST) {
      const ids = new Set(mine.map((r) => r.docId)); const held = new Map<string, Set<string>>();   // other deal → which of this deal's documents it holds
      for (const id of await dealIds()) if (id !== dealId) { const h = new Set<string>(); for (const r of o.docs.records(id)) if (ids.has(r.docId)) h.add(r.docId); if (h.size >= ALSO_LEAST) held.set(id, h); }
      const times = new Map<string, number>(); for (const h of held.values()) for (const d of h) times.set(d, (times.get(d) ?? 0) + 1);
      const own = mine.filter((r) => (times.get(r.docId) ?? 0) < SHARED_BY);
      const folders = new Map<string, string[]>(); for (const r of own) (folders.get(r.folder) ?? folders.set(r.folder, []).get(r.folder)!).push(r.docId);
      for (const [id, h] of held) {
        const docs = own.filter((r) => h.has(r.docId)).length;
        const each = [...folders.values()].every((f) => f.length < ALSO_LEAST || f.length < own.length * FOLDER_PART || f.filter((d) => h.has(d)).length >= f.length * SHARE);
        if (docs >= ALSO_LEAST && docs >= own.length * SHARE && each) deals.push({ dealId: id, docs, of: own.length });
      }
    }
    deals.sort((a, b) => b.docs - a.docs); deals.splice(ALSO_MAX);
    alsoMemo.set(dealId, { n: mine.length, at: Date.now(), deals }); return deals;
  }
  const record = async <T>(kind: 'finding' | 'question', id: string): Promise<T | null> => { const r = await o.repo.get(kind, id); return r.ok && r.value ? (r.value.envelope.data as T) : null; };
  /** a deal's findings or questions; null when they cannot be read just now (a deal not read yet while the folder is out of reach) */
  const live = async <T>(kind: 'finding' | 'question', dealId: string): Promise<T[] | null> => { const r = await o.repo.list(kind, dealId); return r.ok ? r.value.map((l) => l.envelope.data as T) : null; };
  /** what the chat agent is made of: the main session's turns, with search (the helper below reads on the fast model) and read; the checks reuse it to fill their gaps (`fill`) */
  const agentKit: AgentKit = {
    models, records: (d) => o.docs.records(d), words, send, fit, where, cleanDrafts: cleanDraftsOf, rules: RULES,
    now: () => Date.now(),
    askJson: (input, keys, shape) => askJson(input, keys, shape),
    folder: (deals, said, what) => folderList(deals, said, what),
    // a chat is one conversation on a service that keeps them (decisions: Long conversations); its transcript, at a compaction, is a file of its own, which the store's upkeep never touches (storeKeeper.ts)
    ...(o.service.converse ? {
      talk: talkJson,
      toolMode: (model: string) => stepped.get(model) ?? o.toolCalls ?? control.models.toolCalls,
      // a refusal that could also be a passing error (a 500 on a turn of tool results) holds for the run only when it comes twice with no tool results taken between
      steppedDown: (model: string, to: ToolMode, sure = true) => { const k = `${model}\n${to}`; if (sure || doubted.has(k)) stepped.set(model, to); else doubted.add(k); },
      retries: retried.retries,
      ...(o.service.upload ? { keepTranscript: (text: string) => o.service.upload!({ name: `conversation-${Date.now().toString(36)}.txt`, bytes: new TextEncoder().encode(text) }) } : {}),
      ...(o.service.remove ? { drop: (fileId: string) => o.service.remove!(fileId) } : {}),
    } : {}),
    ranking: searchRanking,
    readPage: (deals, model, ask, docs) =>
      readSearchPage({ left: o.searchCalls ?? control.limits.searchCalls }, deals, model, ask, docs),
    findings: async (d) => (await live<{ title?: string; body?: string[]; status?: string }>('finding', d))?.map((f) => ({ title: String(f.title ?? ''), body: strings(f.body), status: String(f.status ?? 'open') })) ?? null,
    questions: (d) => live('question', d),
    dealName: async (d) => { const r = await o.repo.get('deal', d); return String((r.ok && (r.value?.envelope.data as { name?: string } | undefined)?.name) || 'another deal'); },
    // the chat's catch-up tool reuses the deal brief, its finding links put back to their words
    brief: async (d) => {
      const r = await service.dealBrief(d);
      return r.ok ? ok(r.value.paragraphs.map((p) => withoutMemoMarks(p))) : r;
    },
  };
  // a kept conversation is compacted by 80% of what one call to its model may send at most, leaving room for the turn's own question and documents
  const compactAt = (model: string) =>
    Math.min(o.compactAt ?? control.limits.compactAt, Math.floor((inLimit(model) * control.limits.compactShare) / 100));
  const agentOpts = {
    turns: o.turns ?? control.limits.chatTurns, width, compactAt,
    folderDocs: o.folderDocs ?? control.limits.folderDocs, searchPage: o.searchPage ?? control.limits.searchPage,
  };
  /** the chat agent */
  const agent = chatAgent(agentKit, agentOpts);

  /** A memo correction that does not fit goes to Thorough with the original request (#659). */
  async function askCorrection(input: Ask, keys: string[], shape: string) {
    try {
      return await askJson(input, keys, shape, false);
    } catch (error) {
      if (input.kind === 'memoRisk' && isTooLong(error)) return null;
      throw error;
    }
  }

  /**
   * One JSON reply that `usable` accepts: one it rejects is sent back once with what is wrong, as `draft` does (#1058).
   * The send-back is read as written, with no second reading; the caller decides what a reply still unusable means.
   */
  async function askSentBack<T extends Record<string, unknown>>(
    ask: Ask, keys: string[], usable: (reply: T | null) => boolean, wrong: string,
  ): Promise<T | null> {
    const reply = await askJson<T>(ask, keys);
    if (usable(reply)) return reply;
    const prompt = readCorrection(ask.prompt, reply, { wrong });
    return askJson<T>({ ...ask, prompt }, keys, undefined, false);
  }

  function readCanRetry(model: string, again: { escalate: string; retrySharedModel?: boolean } | undefined): boolean {
    return !!again && (model !== again.escalate || again.retrySharedModel === true);
  }

  /**
   * What a read sends first: a page of the chat's document search as it is, with no pick and no second round
   * (#1102); or else, for a draft or a reassessment, one deal's documents, what it must have and then the pick.
   */
  async function firstRead(deals: string[], lookFor: string, must: Record<string, string[]>,
    core: Record<string, string[]>, page?: DealDoc[]): Promise<{ dealId: string; recs: DocRecord[] }[]> {
    if (page) return page.map((x) => ({ dealId: x.dealId, recs: [x.rec] }));
    const dealId = deals[0];
    return [{ dealId, recs: await start(dealId, lookFor, must[dealId] ?? [], width, core[dealId]) }];
  }
  /**
   * One question, read from documents, in up to two rounds: the second only if the model says what is missing and
   * something answers to it. With `again`, a reply that cannot be used is sent back to the same model with what is
   * wrong with it (`wrong`), to be put right; and only if that fails too, the question goes once to the `escalate` model.
   * A reply its `unusable` names (one naming a question id it was not shown) is asked again as an empty one is, and
   * fails the read if it is still unusable when its tries run out (#1105).
   */
  async function read(
    kind: string, deals: string[], model: string, ask: string, lookFor: string, must: Record<string, string[]>,
    shape: string,
    again?: {
      escalate: string; usable: (reply: Record<string, unknown>) => boolean; wrong: string; shown?: string[];
    },
    page?: DealDoc[],
  ): Promise<Result<{ reply: Record<string, unknown>; sent: Sent[] }>> {
    const keys = [...shape.matchAll(/"([a-z]+)":/g)].map((m) => m[1]).concat('need');                // the fields this question asks for
    const sent: Sent[] = [];
    const add = (dealId: string, recs: DocRecord[]) => {
      for (const rec of withClean(dealId, recs)) {
        if (!sent.some((s) => s.rec.docId === rec.docId && s.dealId === dealId)) sent.push({ dealId, rec });
      }
    };
    const core: Record<string, string[]> = {};
    await Promise.all(deals.map(async (d) => { core[d] = await coreOf(d); }));
    try { for (const x of await firstRead(deals, lookFor, must, core, page)) add(x.dealId, x.recs); }
    catch (e) { return failure(e, 'The documents could not be read'); }
    if (!sent.length) return ok({ reply: {}, sent });
    let using = model;
    let pool: Sent[] | undefined;
    let canRetry = readCanRetry(model, again);
    // checked on every reply, whether or not it can be sent back: it names only the ids it was shown, and cites only
    // the documents it was given (#1105, #1162)
    const unusable = docsUnusable(sent, deals.length > 1, keys, where, again?.shown);
    for (let round = 1; ; round++) {
      let reply: Record<string, unknown> | null;
      try {
        const { files, listing, got } = await send(sent, using, deals.length > 1);
        // a finding is not reassessed on part of what was chosen while the rest is out of reach
        if (kind === 'reassess' && lostSome(sent, got)) return fail({ kind: 'failed', message: 'The documents for this could not be opened on this PC' });
        if (got.length < sent.length) sent.splice(0, sent.length, ...got);        // what could not be opened on this PC was not read, and cannot be cited
        if (!sent.length) return fail({ kind: 'failed', message: 'The documents for this could not be opened on this PC' });
        const inAll = deals.reduce((sum, d) => sum + o.docs.records(d).length, 0);
        const prompt = `Documents:\n${listing}\n\nThese are ${sent.length} of the ${inAll} documents in ${deals.length > 1 ? 'these data rooms' : 'the data room'}: the ones chosen as likeliest to bear on this. You have not seen the others, so do not say what the data room as a whole does or does not contain; say what these documents show.\n\n${ask}\n\nReply as JSON: ${shape}${round === 1 ? ' If a document you were not given is needed to answer, add "need": ["a few words describing it"].' : ''}`;
        reply = await askJson({ kind, model: using, system: RULES, files, prompt, unusable }, keys, shape);
        if (again && canRetry && (!reply || !again.usable(reply))) {
          const correction = readCorrection(prompt, reply, again);
          const sendBack = { kind, model: using, system: RULES, files, prompt: correction, unusable };
          reply = await askCorrection(sendBack, keys, shape);
          if (!reply || !again.usable(reply)) {
            canRetry = false;
            using = again.escalate;
            reply = await askJson({ kind, model: using, system: RULES, files, prompt, unusable }, keys, shape, false);
          }
        }
      } catch (e) {
        // a request the service refuses as too long is asked again with the likeliest half of the documents, down to one (limits.ts)
        // one too long even alone is left out, and the others are tried without it
        if (isTooLong(e) && sent.length > 1) { pool ??= [...sent]; sent.splice(Math.ceil(sent.length / 2)); round--; continue; }
        if (isTooLong(e) && sent.length === 1 && pool) { const bad = sent[0]; pool = pool.filter((x) => x !== bad); if (pool.length) { sent.splice(0, sent.length, ...pool); round--; continue; } }
        return failure(e, 'The documents could not be read');
      }
      if (!reply) return fail({ kind: 'failed', message: UNREAD_REPLY });
      const need = prose(reply.need);
      if (round > 1 || !need.length || page) return ok({ reply, sent });
      // The second round stays within `width` documents too, however many deals are asked about. Priority: what the
      // question must have (attachments, a finding's own documents) is kept; what the model still needs takes up to
      // half the call in all, shared between deals in turn, best first; the first round's other documents fill the
      // rest, strongest (earliest chosen) first.
      const have = new Set(sent.map((s) => s.rec.docId));
      const half = Math.ceil(width / 2);
      const room = Math.max(1, Math.ceil(half / deals.length));
      const extras: { d: string; recs: DocRecord[] }[] = [];
      try { for (const d of deals) { const extra = (await pick(d, `${lookFor}\nWhat has been read does not settle it. Still needed: ${need.join('; ')}`, have, room, core[d], `${lookFor} ${need.join(' ')}`)) ?? top(d, need.join(' '), have, room, core[d], false); if (extra.length) extras.push({ d, recs: extra }); } }
      catch (e) { return failure(e, 'The documents could not be read'); }
      const required = new Set(deals.flatMap((d) => (must[d] ?? []).map((id) => `${d}|${id}`)));
      const first = sent.splice(0);
      const kept = first.filter((x) => required.has(`${x.dealId}|${x.rec.docId}`)); const rest = first.filter((x) => !required.has(`${x.dealId}|${x.rec.docId}`));
      const taken: { d: string; rec: DocRecord }[] = []; const budget = Math.min(half, width - kept.length);
      for (let i = 0; taken.length < budget && extras.some((x) => i < x.recs.length); i++) for (const x of extras) if (i < x.recs.length && taken.length < budget) taken.push({ d: x.d, rec: x.recs[i] });
      if (!taken.length) { sent.push(...first); return ok({ reply, sent }); }    // nothing answers to what it asked for, or no room: its first answer stands
      for (const d of deals) { const docs = taken.filter((t) => t.d === d).map((t) => t.rec.docId); if (docs.length) o.trace?.({ dealId: d, reason: need.join('; '), docs }); }
      for (const x of [...kept, ...rest.slice(0, Math.max(0, width - kept.length - taken.length))]) add(x.dealId, [x.rec]);
      for (const t of taken) add(t.d, [t.rec]);
    }
  }

  /** Read the memo summary from its documents, or from the deal facts when none are available. */
  async function readMemoSummary(
    dealId: string, tiers: { standard: string; thorough: string }, prompt: string, facts: string,
    parasOf: (reply: { paragraphs?: unknown } | null) => string[],
    advises: (text: string) => boolean,
  ): Promise<Result<string[]>> {
    async function withoutDocuments(): Promise<string[]> {
      const question = `${prompt}\nReply as JSON: {"paragraphs": ["…"]}`;
      let summary: string[] = [];
      const attempts = [[tiers.standard, false], [tiers.standard, true], [tiers.thorough, false]] as const;
      for (const [model, again] of attempts) {
        const correction = again && summary.length
          ? `\n\nYou wrote:\n${summary.join('\n')}\n\nThat gives advice or a judgment. Write it again with facts only.`
          : '';
        summary = parasOf(await askJson<{ paragraphs?: unknown }>({
          kind: 'memoSummary', model, system: JSON_ONLY, prompt: question + correction,
        }, ['paragraphs']));
        if (summary.length && !summary.some(advises)) break;
      }
      return summary;
    }

    const options = {
      escalate: tiers.thorough,
      usable(reply: Record<string, unknown>) {
        const paragraphs = parasOf(reply);
        return paragraphs.length > 0 && !paragraphs.some(advises);
      },
      wrong: 'it is empty, or it gives advice or a judgment: write it again with facts only',
    };
    try {
      const fromDocs = await read('memoSummary', [dealId], tiers.standard, prompt,
        `${facts} project description capacity sponsor offtake financing structure`, {},
        '{"paragraphs": ["…", "…"], "sources": [...]}', options);
      if (!fromDocs.ok && fromDocs.error.kind === 'unreachable') {
        const stopped = Object.assign(new Error(fromDocs.error.message), { code: 'unreachable' });
        return failure(stopped, `${SERVICE} did not answer`);
      }
      const summary = fromDocs.ok && fromDocs.value.sent.length
        ? parasOf(fromDocs.value.reply)
        : await withoutDocuments();
      // the memo opens with its one-page summary: one that is empty or still advises fails the memo (#1065)
      if (!summary.length || summary.some(advises)) return fail({ kind: 'failed', message: UNREAD_REPLY });
      return ok(summary);
    } catch (e) {
      return failure(e, 'The summary could not be written');
    }
  }

  // ── the checklist and what the first pass made of each item ──────────────────────────────────────────────────────────
  const held = new Map<string, string>();                                       // the results, when there is no shared folder to keep them in
  /** the checklist as read at the start of a first pass or a check on a deal, kept while it runs so it is read once */
  const runList = new Map<string, ChecklistItem[]>();
  /** run `go` with the deal's checklist read once, at its start */
  async function withList<R>(dealId: string, list: ChecklistItem[], go: () => Promise<R>): Promise<R> { const had = runList.get(dealId); runList.set(dealId, list); try { return await go(); } finally { if (had) runList.set(dealId, had); else runList.delete(dealId); } }
  const checksName = (dealId: string) => `checks-${o.installId ?? 'local'}-${dealId}.jsonl`;
  /**
   * One cached reader per deal (docs/architecture.md, Checks, and how PCs share them): a file whose size has not changed is not read; one that has
   * grown is parsed only from where the last read stopped. A file that has shrunk, or whose last read did not stop at
   * the end of a line (as after the sync client put back an older copy and the lines were healed), is read whole again,
   * and with it the deal's whole log, so nothing is lost or counted twice.
   */
  const readers = new Map<string, { files: Map<string, { len: number; bytes: number }>; rows: { l: CheckLine; i: number }[]; once: Set<string>; next: number }>();
  /** what a reader keeps of each line it has read: a hash, not the line, which could hold the whole text of the file */
  const lineKey = (l: string) => createHash('sha256').update(l).digest('base64');
  const freshReader = () => ({ files: new Map<string, { len: number; bytes: number }>(), rows: [] as { l: CheckLine; i: number }[], once: new Set<string>(), next: 0 });
  /** every line written about a deal's checklist, by any PC, oldest first */
  async function lines(dealId: string): Promise<CheckLine[]> {
    if (o.shared?.size) healOwn(o.shared as Pick<Folder, 'append' | 'read' | 'size'>, o.local, checksName(dealId));
    let r = readers.get(dealId) ?? freshReader(); readers.set(dealId, r);
    const take = (text: string, from = 0) => { for (const row of wholeLines(text, from, r.once, lineKey)) { if (!row.trim()) continue; try { const l = JSON.parse(row) as CheckLine; if (l?.v === 1 && typeof l.at === 'string') r.rows.push({ l, i: r.next++ }); } catch { /* a line cut short by a crash or a sync is skipped */ } } };   // a line in a file and in a conflict copy of it counts once
    if (!o.shared) { r = freshReader(); readers.set(dealId, r); take(held.get(checksName(dealId)) ?? ''); }
    else {
      const names = dealFiles(await o.shared.list(), 'checks', dealId);          // each PC's own, and any conflict copy, whose lines are read like any other
      for (let pass = 0; pass < 2; pass++) {
        let whole = [...r.files.keys()].some((n) => !names.includes(n));          // a file gone (a conflict copy cleared away): its lines must go too
        for (const name of whole ? [] : names) {
          const had = r.files.get(name); const size = o.shared.size?.(name) ?? -2;
          if (had && size >= 0 && size === had.bytes) continue;                    // unchanged: not read
          const text = o.shared.read(name) ?? '';
          if (had && (text.length < had.len || (had.len > 0 && text.charCodeAt(had.len - 1) !== 10))) { whole = true; break; }
          const upto = text.lastIndexOf('\n') + 1; take(text, had?.len ?? 0); r.files.set(name, { len: upto, bytes: upto === text.length ? size : -1 });   // with a line still being written, read again next time
        }
        if (!whole) break;
        r = freshReader(); readers.set(dealId, r);                                // read the deal's whole log again
      }
    }
    seen.set(dealId, r.rows.reduce((top, x) => Math.max(top, x.l.n ?? 0), seen.get(dealId) ?? 0));
    const out = [...r.rows].sort((x, y) => (x.l.n ?? 0) - (y.l.n ?? 0) || (x.l.at < y.l.at ? -1 : x.l.at > y.l.at ? 1 : x.i - y.i)).map((x) => x.l);
    return out;
  }
  const seen = new Map<string, number>();                                       // the highest `n` read or written for each deal
  /** while a batch of a round runs: throws if this PC slept or rejoined since it took the batch, so nothing is written from it (see `guard`) */
  const guards = new Map<string, () => Promise<void>>();
  async function say(dealId: string, line: Omit<CheckLine, 'v' | 'at' | 'n'>, unguarded = false) {
    // only what a batch settles is held back when the PC has slept or rejoined: lines that say who is in a round, and what it is, are always written
    const settles = line.item || line.glanced || line.verified || line.sample || line.skipped;
    if (!unguarded && settles) await guards.get(dealId)?.();
    if (!seen.has(dealId)) await lines(dealId);
    const n = (seen.get(dealId) ?? 0) + 1; seen.set(dealId, n);
    const at = clock(); const text = JSON.stringify({ v: 1, at, n, pc: o.installId ?? 'local', ...line }) + '\n'; const name = checksName(dealId);
    if (o.shared) appendOwn(o.shared, o.local, name, text); else held.set(name, (held.get(name) ?? '') + text);
    return at;
  }
  /**
   * Work another PC has claimed on a deal and not yet released, as of now: its name, by key. Claims are read from the
   * deal's shared check log; each PC's own lines are in its own order, so the latest claim or release of each PC counts.
   */
  async function claimedElsewhere(dealId: string, keys: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>(); if (!o.shared) return out;
    const me = o.installId ?? 'local'; const now = Date.parse(clock()); const state = new Map<string, { until: number; label: string } | null>();   // pc/key → live claim
    for (const l of await lines(dealId)) {
      if (l.claim && l.claim.pc !== me) for (const k of l.claim.keys) state.set(`${l.claim.pc}\u0000${k}`, { until: Date.parse(l.claim.until), label: l.claim.label ?? 'another PC' });
      if (l.release && l.release.pc !== me) for (const k of l.release.keys) state.set(`${l.release.pc}\u0000${k}`, null);
    }
    for (const [pk, c] of state) { const k = pk.slice(pk.indexOf('\u0000') + 1); if (c && c.until > now && keys.includes(k)) out.set(k, c.label); }
    return out;
  }
  async function claim(dealId: string, keys: string[]) { if (o.shared && keys.length) await say(dealId, { claim: { keys, pc: o.installId ?? 'local', ...(o.label ? { label: o.label } : {}), until: new Date(Date.parse(clock()) + CLAIM_MS).toISOString() } }); }
  async function release(dealId: string, keys: string[]) { if (o.shared && keys.length) await say(dealId, { release: { keys, pc: o.installId ?? 'local' } }); }
  /**
   * Run `go` as work claimed for this deal (`key`), so that two PCs never run it at once: when another PC holds a live
   * claim, `busy` says so instead. A long run renews its claim; a run that ends releases it; a PC that stops part-way
   * leaves a claim that lapses by itself.
   */
  const claimed = <A, R>(key: string, busy: (a: A, who: string) => Promise<R> | R, go: (a: A) => Promise<R>) => async (a: A): Promise<R> => {
    const d = dealOf(a); if (!d || !o.shared) return go(a);
    const other = (await claimedElsewhere(d, [key])).get(key); if (other) return busy(a, other);
    await claim(d, [key]); const timer = setInterval(() => void claim(d, [key]).catch(() => undefined), RENEW_MS); (timer as { unref?: () => void }).unref?.();
    // signed out mid-run: fail after the cap and let go of the claim, so another PC's run is not held until someone signs in here
    try { return await withSignInCap(T.giveUp, () => go(a)); } finally { clearInterval(timer); await release(d, [key]).catch(() => undefined); }
  };

  /**
   * The latest outcome of each item. A later line takes the place of an earlier one, except within one round: there,
   * of two lines on the same item, the one that counts is the same on every PC (see `counts`), so a late duplicate
   * changes nothing unless it carries an effect.
   */
  const keep = (latest: Map<string, CheckLine>, l: CheckLine, group: (id?: string) => string | undefined = (id) => id) => { if (!l.item || !l.result) return; const cur = latest.get(l.item); latest.set(l.item, cur && cur.round && group(cur.round) === group(l.round) ? counts(cur, l, (y) => y.result === 'finding') : l); };
  /** which round each round's lines count for: itself, or the round it was merged into */
  const groupsOf = (all: CheckLine[]) => { const into = new Map<string, string>(); for (const l of all) if (l.merged) into.set(l.merged.round, l.merged.into); return (id?: string) => { let x = id; for (let i = 0; x && into.has(x) && i < 50; i++) x = into.get(x); return x; }; };
  /** the latest outcome of each item, and the items of the last run that got to the end */
  async function outcomes(dealId: string, all?: CheckLine[]) {
    const latest = new Map<string, CheckLine>(); let done: string[] | undefined; let known: string[] | undefined; let full: (FullCheck & { at: string; round?: string }) | undefined;
    const rows = all ?? await lines(dealId); const group = groupsOf(rows);
    let fullPc: string | undefined;
    for (const l of rows) { if (l.full) { if (!(full && l.full.round && full.round === l.full.round && (fullPc ?? '') <= (l.pc ?? ''))) { full = { ...l.full, at: l.full.done ?? l.at }; fullPc = l.pc; } } else if (l.done) { done = l.done.items; known = l.done.docs ?? known; } else keep(latest, l, group); }
    return { latest, done, known, full };
  }
  const gapsOf = (latest: Map<string, CheckLine>, done: string[] | undefined) => (done ?? [...latest.keys()]).map((id) => latest.get(id)).filter((l): l is CheckLine => l?.result === 'gap').map((l) => ({ title: l.text ?? '' }));
  /**
   * The deal's own items, when it has any (linking design, section 5): those not turned off, in the order of the firm's
   * list. Null for a deal with none, which is then checked against the checklist the backend was given, as before.
   */
  async function dealItems(dealId: string): Promise<ChecklistItem[] | null> {
    const its = await o.repo.list('item', dealId); if (!its.ok) throw new Error(its.error.message);
    if (!its.value.length) return null;
    const firm = await o.repo.list('firmList'); const lists = firm.ok ? firm.value.flatMap((l) => { const r = ListRecord.safeParse({ ...(l.envelope.data as object), rev: l.rev }); return r.success ? [r.data] : []; }) : [];
    const items = its.value.flatMap((l) => { const r = Item.safeParse({ ...(l.envelope.data as object), rev: l.rev }); return r.success ? [r.data] : []; });
    return orderItems(items.filter((it) => !it.off), firmOf(lists)).map((it) => { const heads = [it.section, it.subsection].filter(Boolean).join(' / '); return { id: it.id, text: it.text, ...(heads ? { heads } : {}) }; });
  }
  /**
   * The items a deal's Checklist shows and counts, in order: its own items that are on, when it has any, so a list swap or
   * an item turned off shows at once, and an item added that no check has reached yet is listed as not checked (linking
   * design, section 5: "Rows come from the item records; an item with no line is Not checked"). A deal with no items of
   * its own shows what its last check covered.
   */
  async function shownItems(dealId: string, latest: Map<string, CheckLine>, done: string[] | undefined): Promise<{ id: string; text?: string }[]> {
    const own = await dealItems(dealId);
    return own ?? (done ?? [...latest.keys()]).map((id) => ({ id }));
  }
  /** the four layers as one list, broad first; an item worded the same as an earlier one is checked once */
  function merge(c: Checklist): ChecklistItem[] {
    const seenText = new Set<string>(); const seenId = new Set<string>(); const out: ChecklistItem[] = [];
    for (const raw of [...(c?.broad ?? []), ...(c?.product ?? []), ...(c?.sector ?? []), ...(c?.technology ?? [])]) {
      const { id, text } = givenItem(raw);
      const wording = key(text);
      if (!id || !text.trim() || seenId.has(id) || seenText.has(wording)) continue;
      seenId.add(id);
      seenText.add(wording);
      out.push({ id, text });
    }
    return out;
  }
  /** an item's id (a handle, its edge white space dropped) and its wording as given; anything not text is empty */
  function givenItem(it: { id?: unknown; text?: unknown } | undefined): { id: string; text: string } {
    const id = typeof it?.id === 'string' ? it.id.trim() : '';
    const text = typeof it?.text === 'string' ? it.text : '';
    return { id, text };
  }
  /** the rows of a check reply: a list of items, or the same keyed by item id: {"i_…": {…}} */
  const checkRows = (items: unknown): Record<string, unknown>[] => (Array.isArray(items) ? items
    : Object.entries(items as Record<string, unknown>)
      .map(([id, v]) => (v && typeof v === 'object' ? { id, ...(v as object) } : { id, result: v })));
  /**
   * A check reply its caller cannot use (retry.ts): it cites a document it was not given, or names an item, in its
   * words or as a row's id, by an id it was not shown (#1162)
   */
  const checkUnusable = (sent: Sent[], items: ChecklistItem[]) => {
    const ids = items.map((it) => it.id);
    const docs = docsUnusable(sent, false, ['items'], where, ids);
    return (text: string) => {
      const said = readJson(text, ['items'])?.items;
      const rows = isObject(said) || Array.isArray(said) ? checkRows(said) : [];
      return docs(text) || unknownIds(rows.map((r) => r?.id), ids).length > 0;
    };
  };
  /**
   * Ask one model about some checklist items against some documents. Null when its reply cannot be read at all. Throws
   * when the service fails. With `redo`, the items are ones whose first replies could not be used: each is sent back with
   * what was wrong with it, to be put right.
   */
  async function check(items: ChecklistItem[], sent: Sent[], model: string, redo?: Map<string, { why: string; said?: unknown }>, fix = true): Promise<(Map<string, Seen> & { cut?: ChecklistItem[] }) | null> {
    const { files, listing, got } = await send(sent, model);
    // the folder of one of them stopped answering since they were chosen: the items are not settled on the rest
    if (lostSome(sent, got)) { const why = awayWhy(sent[0].dealId, sent.filter((x) => !got.includes(x)).map((x) => x.rec.docId)); return new Map(items.map((it) => [it.id, { kind: 'weak' as const, why, reason: why }])); }
    if (!got.length) return null; sent = got;
    // The fast model's quick look only says whether an item still stands as recorded; the standard and thorough models settle
    // items, and an item is settled as satisfied only on a place a person can open.
    const quick = model === (await models()).fast;
    // a reply cut off at the length limit keeps the items that came back whole: the caller asks about the rest in smaller parts
    let reply: { items?: unknown } | null; let cut = false;
    try {
      // a reply naming a document it was not given, or an item it was not shown, is asked again (#1162)
      const asked: Ask = { kind: quick ? 'glance' : 'check', split: true, model, system: RULES, files,
        prompt: checkPrompt(listing, items, quick, redo), unusable: checkUnusable(sent, items) };
      reply = await askJson<{ items?: unknown }>(asked, ['items'], undefined, fix && !redo);
    }
    catch (e) { if (!isCutOff(e)) throw e; cut = true; reply = (e as { partial?: { items?: unknown } | null }).partial ?? null; }
    if (cut && !reply) return Object.assign(new Map<string, Seen>(), { cut: items });
    if (!reply || !reply.items || typeof reply.items !== 'object') return null;
    const all = checkRows(reply.items);
    const rows = cut ? all.slice(0, -1) : all;                                     // the last item before a cut may itself be cut short
    // a whole item before the cut that cites a document it was not given makes the reply unusable, as it does a whole
    // reply: the items are asked again, never kept without that citation (#1162)
    if (cut && citesUnsent(rows, sent, false, where)) return null;
    const out: Map<string, Seen> & { cut?: ChecklistItem[] } = new Map<string, Seen>();
    for (const r of rows) {
      const it = items.find((x) => x.id === r?.id);
      if (!it || out.has(it.id)) continue;
      const result = word(r.result);
      if (result === 'ok') {
        const where = fit('', r.where as Cited[], sent, false).sources;
        // a blackline's pages are the model's reading of a change, and another project's document is not this deal's:
        // alone they never settle an item
        if (!quick && where.length && where.every((x) => x.reading || x.precedent)) { out.set(it.id, { kind: 'none', need: `a document of this deal that shows it, not only a blackline or another project's document: ${it.text}` }); continue; }
        const why = 'As "ok" it needs "where": at least one place that shows it, naming a document you were given, '
          + 'by its id, and a page that document has (or a sheet and cell for a spreadsheet).';
        const reason = 'It was found satisfied, but no page that shows it could be pointed to.';
        out.set(it.id, quick || where.length ? { kind: 'ok', where } : { kind: 'weak', why, said: r, reason });
      }
      else if (result === 'more') out.set(it.id, { kind: 'none', need: prose(r.need).join('; ') || it.text });
      else if (result === 'finding') {
        const title = typeof r.title === 'string' ? r.title : ''; const paras = prose(r.body);
        const fitted = fit(paras.join(PARAGRAPH_SEAM), r.sources as Cited[], sent, false, true);
        // another project's document, or a blackline not shown to be against this deal's own draft, never raises a
        // finding by itself
        if (fitted.sources.length && !fitted.sources.some((x) => mainIn(sent, x))) { out.set(it.id, { kind: 'none', need: `a document of this deal that shows it, not only another project's document or a blackline against one: ${it.text}` }); continue; }
        // a finding stands on one source we can open: what matters most is often said in a single place
        const needsCitation = 'it needs at least one citation naming a document you were given, by its id, '
          + 'and a page that document has (or a sheet and cell for a spreadsheet), and none of yours do';
        const short = [
          !title.trim() && 'it has no title',
          !paras.length && 'it has no body',
          !fitted.sources.length && needsCitation,
        ].filter(Boolean);
        const body = fitParas(fitted.text.split(PARAGRAPH_SEAM).filter((p) => p.trim()));
        const workstream = workstreamOf(r.workstream);
        const raised: Seen = { kind: 'finding', title, workstream, body, sources: fitted.sources };
        const unsupported = 'A finding was raised on it that could not be supported from a place in the documents.';
        const weak: Seen = { kind: 'weak', why: `As a finding ${short.join(', ')}.`, said: r, reason: unsupported };
        out.set(it.id, !short.length ? raised : weak);
      } else out.set(it.id, { kind: 'weak', why: 'Its "result" has to be "ok", "finding" or "more".', said: r });
    }
    if (cut) { out.cut = items.filter((it) => !out.has(it.id)); return out; }
    for (const it of items) if (!out.has(it.id)) out.set(it.id, { kind: 'weak', why: 'It was missing from your reply.' });
    return out;
  }

  /** a response already given on the deal, to a question that reads like the one being drafted for */
  type Alike = { id: string; n: number; text: string; response: string; by: string; ai: boolean };
  type AlikeQuestion = Pick<Question, 'id'> & Partial<Pick<Question,
    'n' | 'text' | 'response' | 'askedBy' | 'status' | 'provenance'>>;
  const ALIKE = 5;                                                               // earlier responses one draft is shown at most
  const ALIKE_SHARE = 0.5;                                                       // of the question's weight in words, how much another question must share to be shown
  /** the words of a text as `words` gives them for the deal (its short names given their long form), and with each hyphenated word also written whole, so "lock-up" and "lockup" meet */
  const alikeWords = (t: string, dealId: string) => new Set([...words(t, dealId), ...words(t.replace(/(\p{L})[-\u2010\u2011\u2013](?=\p{L})/gu, '$1'), dealId)]);
  /** A spacing-only edit can move the boundary without changing the quoted characters (#287). */
  function draftCitationStart(response: string, prefixLength: number | undefined): number {
    if (prefixLength === undefined) return 0;
    let left = prefixLength;
    for (const token of response.matchAll(/\S+/g)) {
      if (left < token[0].length) return token.index + left;
      left -= token[0].length;
    }
    return response.length;
  }
  /** Only an accepted draft keeps markers for that question's sources (#287). */
  function priorResponse(response: string, provenance?: Provenance): string {
    if (provenance?.origin !== 'ai') return fitText(response);
    const sources = provenance.sources ?? [];
    const start = draftCitationStart(response, sources[0]?.draftCitationPrefixLength);
    const quoted = response.slice(0, start);
    return fitText(quoted + withoutMarkers(response.slice(start), sources.length));
  }
  /** A draft's own markers can share numbers with literal brackets in the earlier responses (#287). */
  function draftSources(sources: Source[], quotation: string): Source[] {
    if (withoutMarkers(quotation, sources.length) === quotation) return sources;
    const draftCitationPrefixLength = quotation.replace(/\s/g, '').length;
    return sources.map((source) => ({ ...source, draftCitationPrefixLength }));
  }
  /**
   * The responses on a deal to questions that read like this one, likeliest first: every other question a person marked
   * Answered or Closed (a typed response leaves a question open until a person marks it, so it may not have been given yet),
   * ranked by the words they share, each word weighed by how rare it is in the deal's questions, so "lock-up" counts
   * for more than "provide". A thousand questions take a few milliseconds; no model is asked. Deleted questions are not
   * listed (their records are gone from the deal), and nor is the question itself.
   */
  async function alike(dealId: string, questionId: string, text: string): Promise<Alike[]> {
    const mine = alikeWords(text, dealId); if (!mine.size) return [];
    const questions = await live<AlikeQuestion>('question', dealId) ?? [];
    const log = questions.filter((q) => q.id !== questionId && q.text?.trim());
    const sets = log.map((q) => alikeWords(q.text!, dealId)); const df = new Map<string, number>();
    for (const set of sets) for (const w of set) if (mine.has(w)) df.set(w, (df.get(w) ?? 0) + 1);     // how rare a word is, counted over the whole log
    const weight = (w: string) => Math.log(1 + (log.length + 1) / ((df.get(w) ?? 0) + 1)); let whole = 0; for (const w of mine) whole += weight(w);
    const given = (q: (typeof log)[number]) => !!q.response?.trim() && (q.status === 'answered' || q.status === 'closed') && typeof q.n === 'number';
    return log.map((q, k) => { if (!given(q)) return { q, share: 0 }; let got = 0; for (const w of mine) if (sets[k].has(w)) got += weight(w); return { q, share: got / whole }; })
      .filter((x) => x.share >= ALIKE_SHARE).sort((a, b) => b.share - a.share || a.q.n! - b.q.n!).slice(0, ALIKE)
      .map(({ q }) => ({
        id: q.id,
        n: q.n!,
        text: q.text!,
        response: priorResponse(q.response!, q.provenance),
        by: (q.askedBy ?? '').trim(),
        ai: q.provenance?.origin === 'ai',
      }));
  }
  const one = (t: string) => t.replace(/\s+/g, ' ').trim();
  /** what a draft is told of earlier responses: each named only by its question's id, never its number (#286, #1105) */
  function priorResponses(earlier: Alike[]): string {
    if (!earlier.length) return '';
    const shown = earlier.map((q) => {
      const by = q.by ? `, submitted by ${q.by}` : '';
      const response = `Response to ${q.id}${q.ai ? AI_DRAFTED : ''}: “${one(q.response)}”`;
      return `${q.id}${by}: “${one(q.text)}”\n${response}`;
    });
    const use = 'If one of them answers this question as it is asked, name it in "reused": it is put in the draft '
      + 'word for word, credited to whoever asked it. Earlier responses are named only by their ids. Do not '
      + 'repeat or restate one in "text": write there only what the documents add, with [n] markers, or nothing. '
      + 'Use none that answers a different question, however alike the words.';
    return `\nResponses already given on this deal to questions that read like it:\n${shown.join('\n')}\n${use}`;
  }
  /**
   * A draft's reply that can be used: its text fits one Excel cell, and it names only earlier responses it was shown,
   * in "reused" and in "text"; one that names another question id is a failed reply, asked again (#1105)
   */
  function draftCheck(earlier: Alike[], escalate: string) {
    const ids = earlier.map((q) => q.id);
    const reusedShown = (reply: Record<string, unknown>) =>
      listOf(reply.reused).every((x) => ids.includes(String(x).trim()));
    const usable = (reply: Record<string, unknown>) =>
      prose(reply.text).join('\n\n').length <= MODEL_TEXT_MAX && reusedShown(reply);
    const wrong = `"text" must be under ${MODEL_TEXT_MAX.toLocaleString('en-US')} characters, and "reused" `
      + 'may name only the earlier responses above, by their ids: put it right';
    const unusable = (text: string) => !namesOnlyShown(text, ids);
    return { escalate, usable, wrong, shown: ids, unusable };
  }
  let briefs = new Map<string, { key: string; paragraphs: string[] }>();
  const service: AiService = {
    async answer(i) {
      const deals = i.dealId ? [i.dealId] : [...(i.dealIds ?? await dealIds())]; const must: Record<string, string[]> = {}; let about = '';
      // on Home, the person's own attached files are searched beside their deals, and what goes with this message is read from the first turn
      if (!i.dealId && i.files) { deals.push(i.files); must[i.files] = (i.attachments ?? []).map((a) => a.docId).filter((x): x is string => !!x); }
      if (i.dealId) {
        must[i.dealId] = (i.attachments ?? []).map((a) => a.docId).filter((x): x is string => !!x);
        if (i.findingId) { const f = await record<{ title: string; body: string[]; sources: Source[] }>('finding', i.findingId); if (f) { about = `This is about the finding "${f.title}": ${f.body.join(' ')}`; must[i.dealId].push(...f.sources.map((s) => s.docId).filter((x): x is string => !!x)); } }
        if (i.questionId) { const q = await record<{ text: string }>('question', i.questionId); if (q) about = `This is about the question "${q.text}".`; }
      }
      if (!deals.some((d) => o.docs.records(d).length)) return ok({ text: i.dealId ? 'No documents have been indexed for this deal yet.' : 'No documents have been indexed yet.', sources: [] });
      const said = (list: typeof i.history) => list.map((m) => `${m.role === 'me' ? 'Person' : 'You'}: ${m.text}`).join('\n');
      const history = said(i.history.slice(-6));
      // the chat agent works it out in turns, with search and read (agent.ts); how much was read goes back with the answer, so that "none" is never taken to mean none in the whole data room
      return agent.answer({ deals, withDeal: !i.dealId, model: i.model, message: i.message, about, history, must, ...(i.runId ? { runId: i.runId } : {}), ...(i.conversation ? { conversation: i.conversation } : {}), ...(i.thread ? { thread: i.thread } : {}), ...(o.service.converse && i.history.length ? { transcript: said(i.history) } : {}) });
    },
    async research(runId) { return ok(agent.progress(runId)); },
    async stop(runId) { return ok(agent.stop(runId)); },
    // A draft goes to the standard model: only the main conversation uses the model the person chose.
    async draft(i) {
      // Responses already given to questions like this one, from any party: the deal's Q&A log is searched by words, with no model
      const earlier = await alike(i.dealId, i.questionId, i.questionText);
      if (!o.docs.records(i.dealId).length && !earlier.length) return ok({ status: 'none', text: '', sources: [] });
      let m: Awaited<ReturnType<typeof models>>; try { m = await models(); } catch (e) { return failure(e, `${SERVICE} did not answer`); }
      const asAnswered = (q: Alike) => `As answered ${q.by ? `to ${q.by} ` : ''}(Q${q.n})`;
      const prior = priorResponses(earlier);
      const ask = `Draft a response to this question from the documents: ${i.questionText}${prior}\nIf ${earlier.length ? 'neither the documents nor those responses answer' : 'the documents do not answer'} it, say so with "status": "none" and nothing else.\nThe response must be under ${MODEL_TEXT_MAX.toLocaleString('en-US')} characters (it goes into one Excel cell); if it would be longer, cut it down to what matters.`;
      const reusedShape = earlier.length ? ', "reused": ["the id of an earlier response it uses"]' : '';
      const fields = '"status": "found" | "none", "text": "the response, with [n] markers", "sources": [...]';
      const shape = `{${fields}${reusedShape}}`;
      const again = draftCheck(earlier, m.thorough);
      let r = await read('draft', [i.dealId], m.standard, ask, i.questionText, {}, shape, again);
      if (r.ok && !r.value.sent.length && earlier.length) {
        // no document bears on it, but earlier responses may: they are asked about on their own
        // the system rules say to answer from the earlier responses here, since there are no documents; a reply too long is sent back once to be cut down
        const prompt = `No document in the data room was found to bear on this.\n\n${ask}\n\nReply as JSON: ${shape}`;
        try {
          const keys = ['status', 'text', 'reused'];
          const input = { kind: 'draft', model: m.standard, system: PRIOR_RULES, prompt, unusable: again.unusable };
          let reply = await askJson(input, keys, shape);
          const correction = `${prompt}\n\nYou replied:\n${JSON.stringify(reply)}\n\n`
            + `That cannot be used: ${again.wrong}. Send the whole reply again, put right.`;
          if (reply && !again.usable(reply)) {
            reply = await askJson({ ...input, prompt: correction }, keys, shape, false);
          }
          r = reply ? ok({ reply, sent: [] }) : fail({ kind: 'failed', message: UNREAD_REPLY });
        } catch (e) { return failure(e, `${SERVICE} did not answer`); }
      }
      if (!r.ok) return r;
      const out = fit(prose(r.value.reply.text).join('\n\n'), r.value.reply.sources as Cited[], r.value.sent, false);
      // in the order the model named them; a reply escalated past its retry may still name one never shown: not reused
      const reused = [...new Set(listOf(r.value.reply.reused).map((x) => String(x).trim()))]
        .map((id) => earlier.find((q) => q.id === id))
        .filter((q): q is Alike => !!q);
      if (word(r.value.reply.status) !== 'found') return ok({ status: 'none', text: '', sources: [] });
      // the earlier responses the model chose go in word for word, each credited: nothing is added to another party's answer, or turned round.
      // What the documents add follows, as the model wrote it, with any credit of its own taken out, so a difference between the two stays in sight.
      const quoted = reused.map((q) => `${asAnswered(q)}: ${q.response}`);
      // a sentence of the model's that names an earlier response by its id is a credit in its own words: dropped, with
      // any source only it cited. The model never sees question numbers, so a quarter (Q3 2027) is never one (#286).
      // a draft rests only on this deal's own documents: another project's, or a blackline against one, never answers
      // by itself
      const none = { text: '', sources: [] as typeof out.sources };
      const credited = earlier.map((q) => q.id);
      const ownReply = out.sources.some((x) => mainIn(r.value.sent, x)) ? withoutDraftCredits(out, credited) : none;
      const kept = ownReply.text;
      const own = kept.charAt(0).toUpperCase() + kept.slice(1);
      if (!quoted.length && !own) return ok({ status: 'none', text: '', sources: [] });             // a draft rests on a document it cites or on an earlier response it names
      const quotation = quoted.join('\n\n');
      return ok({
        status: 'found',
        text: [quotation, own].filter(Boolean).join('\n\n'),
        sources: own ? draftSources(ownReply.sources, quotation) : [],
      });
    },
    async reassess(i) {
      const f = await record<{ title: string; body: string[]; sources: Source[] }>('finding', i.findingId); if (!f) return fail({ kind: 'notFound', message: 'No such finding' });
      let m: Awaited<ReturnType<typeof models>>; try { m = await models(); } catch (e) { return failure(e, `${SERVICE} did not answer`); }
      const parasOf = (reply: Record<string, unknown>) => prose(reply.body)
        .flatMap((p) => p.split(/\n\s*\n/)).filter((p) => p.trim());
      const said = await respondedOn(i.dealId, i.findingId);
      const ask = 'Reassess this finding against the documents as they stand now.\n'
        + `Title: ${f.title}\nAs written: ${f.body.join(' ')}${responsesText(said)}`;
      const own = { [i.dealId]: f.sources.map((s) => s.docId).filter((x): x is string => !!x) };
      const shape = '{"body": ["one paragraph per string, with [n] markers"], "sources": [...]}';
      // a reply that names a question id it was not shown is a failed reply, asked again (#1105)
      const shown = said.map((q) => q.id);
      const usable = (reply: Record<string, unknown>) => parasOf(reply).length > 0;
      const again = { escalate: m.thorough, usable, wrong: '"body" has no paragraphs in it', shown };
      const about = `${f.title} ${f.body.join(' ')}`;
      const r = await read('reassess', [i.dealId], m.standard, ask, about, own, shape, again);
      if (!r.ok) return r;
      if (!r.value.sent.length) return fail({ kind: 'failed', message: 'None of this finding’s documents are indexed, so there is nothing to reassess it against' });
      // the responses it was shown by id are named by their questions' numbers before the finding is kept (#1105)
      const numbers = new Map(said.flatMap((q) => (q.n === undefined ? [] : [[q.id, q.n] as const])));
      const paras = parasOf(r.value.reply).map((p) => questionsForIds(p, numbers));
      if (!paras.length) return fail({ kind: 'failed', message: UNREAD_REPLY });
      // a finding: a place cited twice is one source, as when it was raised
      const out = fit(paras.join(PARAGRAPH_SEAM), r.value.reply.sources as Cited[], r.value.sent, false, true);
      // a finding stays as written unless one of this deal's own documents bears it out
      if (!out.sources.some((x) => mainIn(r.value.sent, x))) return fail({ kind: 'failed', message: out.sources.length ? 'Only another project’s documents or a blackline against one bear on it, so it stays as written' : 'No page of the deal’s documents bears it out, so it stays as written' });
      return ok({ body: out.text.split(PARAGRAPH_SEAM).filter((p) => p.trim()), sources: out.sources });
    },
    async dealBrief(dealId) {
      const all = await o.repo.list('finding', dealId);
      // findings that cannot be read are not an outage of the model service: the chat's catch-up goes on (#1017)
      if (!all.ok) return fail({ kind: 'failed', message: all.error.message });
      const open = all.value.map((l) => ({ rev: l.rev, ...(l.envelope.data as { id: string; title: string; workstream: string; status: string; body: string[] }) })).filter((f) => f.status === 'open');
      if (!open.length) return ok({ paragraphs: [] });
      const key = open.map((f) => `${f.id}:${f.rev}`).join('|'); const had = briefs.get(dealId); if (had?.key === key) return ok({ paragraphs: had.paragraphs });       // nothing changed: not asked again
      const ids = new Set(open.map((f) => f.id));
      const parasOf = (reply: { paragraphs?: unknown } | null) => prose(reply?.paragraphs)
        .flatMap((p) => p.split(/\n\s*\n/)).filter((p) => p.trim()).slice(0, 2)
        // a link to a finding that is not there becomes plain words
        .map((p) =>
          p
            .replace(/\{([^{}|]+)\|([^{}]*)\}/g, (_m, phrase, id) =>
              ids.has(String(id).trim()) ? `{${phrase}|${String(id).trim()}}` : phrase,
            )
            .replace(/\s*\[\d+\]/g, ''),
        )
        // an id written outside a link is never shown
        .map((p) => unid(p, ids));
      let paragraphs: string[];
      try {
        const m = await models(); const prompt = `These are the open findings on a deal:\n${open.map((f) => `${f.id} (${f.workstream}): ${f.title}. ${f.body.join(' ').replace(/\s*\[\d+\]/g, '')}`).join('\n')}\n\nWrite two short paragraphs for someone opening the deal: what matters most and why. To point at a finding, write {a few of your own words|its id}. Never write an id anywhere else.\nReply as JSON: {"paragraphs": ["…", "…"]}`;
        // a link naming a finding by an id it was not shown is a failed reply, asked again (#1162)
        const unusable = memoUnusable([...ids], linkedIds);
        const brief = (model: string, text: string, fix = false) => askJson<{ paragraphs?: unknown }>(
          { kind: 'brief', model, system: JSON_ONLY, prompt: text, unusable }, ['paragraphs'], undefined, fix);
        const firstTry = await brief(m.standard, prompt, true);
        paragraphs = parasOf(firstTry);
        const putRight = `${prompt}\n\nYou replied:\n${JSON.stringify(firstTry)}\n\nThat cannot be used: `
          + '"paragraphs" has no paragraphs in it. Send the whole reply again, put right.';
        if (!paragraphs.length) paragraphs = parasOf(await brief(m.standard, firstTry ? putRight : prompt));
        if (!paragraphs.length) paragraphs = parasOf(await brief(m.thorough, prompt));
      } catch (e) { return failure(e, 'The summary could not be written'); }
      if (!paragraphs.length) return fail({ kind: 'failed', message: UNREAD_REPLY });
      briefs.set(dealId, { key, paragraphs }); if (briefs.size > 100) briefs = new Map([...briefs].slice(-50));
      return ok({ paragraphs });
    },
    /**
     * The deal memo's summary and ratings. Each open finding is rated High, Medium or Low against the control file's
     * definitions; a rating is kept in the deal's check log, which every PC reads, and holds until the finding's words
     * change, so two memos agree. The summary is facts only: a reply that advises is sent back once, then to the thorough
     * model; one that still advises, or a summary that cannot be written, fails the memo (#1065).
     * The open findings are then grouped into risks, and each key risk is written up from its findings' documents;
     * the summary says what the project is, read from the core documents.
     */
    async memo(dealId) {
      const all = await o.repo.list('finding', dealId); if (!all.ok) return all;
      const open = all.value.map((l) => l.envelope.data as { id: string; title: string; workstream: string; status: string; body: string[]; raisedAt?: string; sources?: Source[] }).filter((f) => f.status === 'open');
      const plain = (f: (typeof open)[number]) => `${f.title}. ${f.body.join(' ').replace(/\s*\[\d+\]/g, '')}`;
      const keyOf = (f: (typeof open)[number]) => createHash('sha256').update(JSON.stringify([f.title, f.workstream, f.body])).digest('hex').slice(0, 16);
      const ratings: Record<string, Rating> = {}; const kept = new Map<string, { key: string; rating: Rating }>();
      try { for (const l of await lines(dealId)) for (const x of l.rated ?? []) kept.set(x.id, x); } catch { /* an unreadable log: rate afresh */ }
      for (const f of open) { const k = kept.get(f.id); if (k && k.key === keyOf(f) && RATINGS.includes(k.rating)) ratings[f.id] = k.rating; }
      const ids = new Set(open.map((f) => f.id)); const d = control.memo;
      // with no open finding there is nothing to rate, but the memo still opens with what the deal is
      let m: Awaited<ReturnType<typeof models>>; try { m = await models(); } catch (e) { return failure(e, `${SERVICE} did not answer`); }
      try {
        // a rating of a finding by an id the part did not show is a failed reply, asked again (#1162)
        const rateUnusable = (fs: typeof open) => memoUnusable(fs.map((f) => f.id), ratedIds);
        const ratePrompt = (fs: typeof open) => 'Rate each of these open findings on a deal as High, Medium or Low '
          + `risk, by these definitions and nothing else:\nHigh: ${d.high}.\nMedium: ${d.medium}.\nLow: ${d.low}.\n\n`
          + `${fs.map((f) => `${f.id} (${f.workstream}): ${plain(f)}`).join('\n')}\n\n`
          + 'Reply as JSON, with every finding above once: '
          + '{"ratings": [{"id": "its id", "rating": "High" | "Medium" | "Low"}]}';
        const ask = (model: string, fs: typeof open) => askJson<{ ratings?: unknown }>({ kind: 'memoRatings',
          split: true, model, system: JSON_ONLY, unusable: rateUnusable(fs), prompt: ratePrompt(fs) }, ['ratings']);
        let rateRoom = Infinity;                                                   // the part size a cut-off has shown, carried to the next model's pass
        for (const model of [m.standard, m.standard, m.thorough]) {
          const fs = unratedFindings(open, ratings);
          if (!fs.length) break;
          // a deal with many findings is rated a part at a time, as the checks are: parts that fit the output limit, halved
          // after a cut-off, keeping the ratings that came whole (parts.ts). One left unrated is asked again by the next model.
          const size = Math.min(rateRoom, partSize({ cap: MEMO_RATE_BATCH, out: control.limits.ratingReplyTokens, outLimit: outLimit(model), in: tokensEach(fs.map((f) => `${f.title} ${f.body.join(' ')}`)), inLimit: inLimit(model) }));
          const done = await inParts(fs, size, async (part) => {
            let reply: { ratings?: unknown } | null; let cut = false;
            try { reply = await ask(model, part); } catch (e) { if (!isCutOff(e)) throw e; cut = true; reply = (e as { partial?: { ratings?: unknown } | null }).partial ?? null; }
            const rows = listOf(reply?.ratings).map((x) => x as { id?: unknown; rating?: unknown }); const got = new Map<number, Rating>();
            for (const x of cut ? rows.slice(0, -1) : rows) {
              const r = RATINGS.find((k) => k.toLowerCase() === String(x.rating ?? '').trim().toLowerCase());
              // the finding by its id, exactly (#1162)
              const k = part.findIndex((f) => f.id === x.id);
              if (r && k >= 0 && !got.has(k)) got.set(k, r);
            }
            return { got, ...(cut ? { cut: part.map((_, k) => k).filter((k) => !got.has(k)) } : {}) };
          });
          if (done.size < size) rateRoom = done.size;
          if (done.stopped !== undefined && !isCutOff(done.stopped) && !isTooLong(done.stopped)) throw done.stopped;
          for (const [k, r] of done.got) if (!ratings[fs[k].id]) ratings[fs[k].id] = r;
        }
        const fresh = open.filter((f) => ratings[f.id] && (kept.get(f.id)?.key !== keyOf(f) || kept.get(f.id)?.rating !== ratings[f.id]));   // only what is new is written
        if (fresh.length) await say(dealId, { rated: fresh.map((f) => ({ id: f.id, key: keyOf(f), rating: ratings[f.id] })) }, true);
      } catch (e) { return failure(e, 'The ratings could not be worked out'); }
      // the model's own advice, to the reader or to the deal's own side. A document's terms or recommendation, reported, is a fact:
      // "the borrower should maintain a DSCR of 1.20x" passes, "the lenders should insist on it" does not.
      const advises = (t: string) => /\b((we|you|lenders?|investors?|the (lenders?|bank|investors?|buyer|team|deal team)) (should|ought to|must|need to)|we (recommend|suggest|advise|urge)|(is|are) (recommended|advisable|advised)|it would be (prudent|advisable|wise)|consider (asking|requiring|seeking|obtaining|negotiating))\b/i.test(t);
      // Grouping or write-up failures fall back to the findings. An unreachable service stops the memo.
      let groups: RiskGroup[] = [];
      if (open.length > 1) {
        try {
          const rows = open.map((f) => `${f.id} (${f.workstream || 'no workstream'}, ${ratings[f.id] ?? 'unrated'}): ${f.title}`);
          // a risk naming a finding by an id it was not shown is a failed reply, asked again (#1162)
          const unusable = memoUnusable([...ids], groupedIds);
          const prompt = 'These are the open findings on a deal, each with its workstream and risk rating:\n'
            + `${rows.join('\n')}\n\nGroup them into the deal's risks for a memo to a senior banker. A risk is one `
            + 'underlying problem for the deal; findings that are evidence of the same problem, or that bear on the '
            + 'same term, figure or approval, go together, even across workstreams. A finding unlike any other is a '
            + 'risk on its own. Put every finding in exactly one risk. Give each risk a short plain title of your own '
            + '(at most 12 words) that says what the problem is, as a fact, with no judging words.\n'
            + 'Reply as JSON: {"risks": [{"title": "…", "findings": ["id", "id"]}]}';
          const input: Ask = { kind: 'memoGroups', model: m.standard, system: JSON_ONLY, unusable, prompt };
          const reply = await askJson<{ risks?: unknown }>(input, ['risks']);
          groups = memoGroupRows(reply?.risks, ids);
        } catch (e) { if (unreachable(e)) return failure(e, `${SERVICE} did not answer`); groups = []; }
      }
      const byId = new Map(open.map((f) => [f.id, f]));
      const grouped = riskGroups(open.map((f) => ({ id: f.id, title: f.title, raisedAt: f.raisedAt ?? '' })), ratings, groups);
      const { key } = keyRisksOf(grouped, d.keyRisks);
      // Write-ups use findings and documents only. Q&A responses and responder names stay out.
      const writeUp = async (g: (typeof key)[number]): Promise<RiskGroup> => {
        const fs = g.findings.map((id) => byId.get(id)!);
        const ask = `Write up this risk on the deal for a deal memo read by a managing director at an investment bank. It is rated ${g.rating} (${g.rating === 'High' ? d.high : g.rating === 'Medium' ? d.medium : d.low}) and brings together these findings:\n${fs.map((f) => `- ${f.title} (${f.workstream || 'no workstream'}): ${plain(f).slice(f.title.length + 2)}`).join('\n')}\n\nWrite one or two paragraphs, at most 200 words in all, of plain banker's prose: what the issue is; the evidence, with the figures, terms and dates the documents give, each sentence cited; and which figures, terms or dates elsewhere in the deal's documents it touches (the base case, the financing terms, the timetable, or closing), named as the documents give them. Facts only: no advice, no recommendation, no next steps, no mitigants, no judging or comparative words (such as weak, loose, overstated or adequate), and no conclusions of your own beyond what the documents say. Do not say what is still open or which questions were asked: the memo adds the questions still unanswered after it. Name no person. Never write an id.`;
        const options = memoRiskReadOptions(m.thorough, advises, ids);
        const sourceIds = fs.flatMap((f) => (f.sources ?? []).map((s) => s.docId)).filter((id): id is string => !!id);
        const r = await read('memoRisk', [dealId], m.standard, ask, fs.map(plain).join(' '), { [dealId]: sourceIds },
          MEMO_RISK_SHAPE, options);
        if (!r.ok) { if (r.error.kind === 'unreachable') throw Object.assign(new Error(r.error.message), { code: 'unreachable' }); return g; }
        if (!options.usable(r.value.reply) || !r.value.sent.length) return g;
        const paras = memoRiskParagraphs(r.value.reply.paragraphs).map((p) => unid(p, ids)).filter((p) => p.trim());
        const out = fit(paras.join(PARAGRAPH_SEAM), r.value.reply.sources as Cited[], r.value.sent, false, true);
        return { ...g, body: out.text.split(PARAGRAPH_SEAM).filter((p) => p.trim()), sources: out.sources };
      };
      const written = new Map<(typeof key)[number], RiskGroup>();
      try { for (let k = 0; k < key.length; k += 3) await Promise.all(key.slice(k, k + 3).map(async (g) => { written.set(g, await writeUp(g)); })); }   // three at a time
      catch (e) { if (unreachable(e)) return failure(e, `${SERVICE} did not answer`); }
      const risks: RiskGroup[] = grouped.map((g) => { const w = written.get(g); return { title: g.title, findings: g.findings, ...(w?.body?.length ? { body: w.body, sources: w.sources } : {}) }; });

      const got = await o.repo.get('deal', dealId); const deal = got.ok && got.value ? got.value.envelope.data as { name: string; counterparty?: string; product?: string; sector?: string; technology?: string } : null;
      const facts = deal ? [deal.name, deal.counterparty, deal.product, deal.sector, deal.technology].filter(Boolean).join('; ') : '';
      const unrated = unratedFindings(open, ratings).length;
      const prompt = memoSummaryPrompt(facts, open.length, unrated, grouped, (id) => {
        const finding = byId.get(id)!;
        return `(${finding.workstream || 'no workstream'}) ${plain(finding)}`;
      });
      const parasOf = (reply: { paragraphs?: unknown } | null) => prose(reply?.paragraphs)
        .map((p) => unid(withoutMemoMarks(p), ids)).filter((p) => p.trim()).slice(0, 2);
      const summary = await readMemoSummary(dealId, m, prompt, facts, parasOf, advises);
      if (!summary.ok) return summary;
      return ok({ summary: summary.value, ratings, risks });
    },
    /** Checklist items with no document behind them, as the first pass left them. No model is asked. */
    async gaps(dealId) {
      try { const { latest, done } = await outcomes(dealId); return ok(gapsOf(latest, done)); }
      catch { return fail({ kind: 'failed', message: 'The checklist results could not be read' }); }
    },
    /**
     * Whether an answer addresses a question: the standard model judges from the two texts, with no documents.
     * A verdict that is not one of the three is sent back once with what is wrong (decisions: AI and models; #1058).
     */
    async addresses(i) {
      const prompt = [
        `This question was asked on a project-finance deal:\n${i.question}\n\n`,
        `${answerFromDocs(i.answer)}\n\n`,
        `Does the answer address the question: ${GIVES_WHAT_ASKED} `,
        'Say "yes" if it does, "partly" if it gives some of it, "no" if it does not. ',
        'Add "why": one short sentence, under twenty words, saying what it gives or leaves out.\n',
        'Reply as JSON: {"verdict": "yes" | "partly" | "no", "why": "…"}',
      ].join('');
      const keys = ['verdict', 'why'];
      const wrong = '"verdict" is not "yes", "partly" or "no"';
      let reply: { verdict?: unknown; why?: unknown } | null;
      try {
        const ask = { kind: 'addresses', model: (await models()).standard, system: JSON_ONLY, prompt } as const;
        reply = await askSentBack(ask, keys, (r) => !!verdictOf(r), wrong);
      } catch (e) { return failure(e, UNREACHED); }
      const verdict = verdictOf(reply);
      if (!verdict) return fail({ kind: 'failed', message: UNREAD_REPLY });
      // one short line on the card, however much it wrote
      return ok({ verdict, why: prose(reply!.why)[0] ?? '' });
    },
    /**
     * Which open questions an answer addresses (#1120): the standard model reads the answer and the questions, each by
     * its permanent id, in one call where they fit, else in parts (`inParts`). Every question any part names is kept,
     * as its id. A reply naming an id it was not shown is a failed reply and is asked again (#1105).
     */
    async suggestQuestion(i) {
      try {
        const model = (await models()).standard;
        const lines = i.questions.map((q) => `${q.id}: ${q.text}`);
        // the reply is one id however many questions are shown, so only the input limit sizes a part
        const size = partSize({
          cap: i.questions.length, out: 1, outLimit: Infinity, in: tokensEach(lines), inLimit: inLimit(model),
        });
        const done = await inParts(i.questions, size, async (part) => {
          const ids = part.map((q) => q.id);
          const prompt = suggestPrompt(i.answer, part);
          const unusable = (text: string) => !namesOneShown(text, ids);
          const reply = await askJson<{ question?: unknown }>(
            { kind: 'suggestQuestion', model, system: JSON_ONLY, prompt, unusable }, ['question'],
          );
          if (!reply) throw new Error(UNREAD_REPLY);
          const named = namedId(String(reply.question ?? ''), ids);
          return { got: new Map(named === null ? [] : [[0, named]]) };
        });
        // what the parts that were asked named is kept even when a later part could not be asked; parts are in order
        const named = [...done.got].sort(([a], [b]) => a - b).map(([, id]) => id);
        if (named.length || done.stopped === undefined) return ok(named);
        return failure(done.stopped, UNREACHED);
      } catch (e) { return failure(e, UNREACHED); }
    },
    /** One answer from two versions. An empty reply, or one with a note to confirm, is sent back once (#1058). */
    async merge(i) {
      const prompt = [
        `This question was asked on a project-finance deal:\n${i.question}\n\n`,
        `Two people answered it differently.\nFirst version:\n${i.app}\n\nSecond version:\n${i.log}\n\n`,
        'Write one answer that reconciles them: every fact from both, each said once, in plain sentences, ',
        "as a lender's counsel would write it. Where the two disagree, keep the more specific statement ",
        '(a date, a figure, a document reference) and leave the other out. ',
        'Do not put the two versions one after the other, do not mention that there were two versions, ',
        'and add no notes, brackets, placeholders or anything for a person to confirm.\n',
        'Reply as JSON: {"text": "…"}',
      ].join('');
      const wrong = '"text" is empty or holds a bracketed note for a person to confirm';
      let reply: { text?: unknown } | null;
      try {
        const ask = { kind: 'merge', model: (await models()).fast, system: JSON_ONLY, prompt } as const;
        reply = await askSentBack(ask, ['text'], (r) => !!mergedText(r), wrong);
      } catch (e) { return failure(e, UNREACHED); }
      const text = mergedText(reply);
      if (!text) return fail({ kind: 'failed', message: UNUSABLE_REPLY });
      return ok({ text });
    },
    async reword(i) {
      // in parts of up to CHECKLIST_BATCH, fewer when the output limit is small, and halved after a cut-off (parts.ts); a
      // reply lists only the items it rewords, so those up to the last whole one it named are done, and the rest are asked again
      let fast: string; try { fast = (await models()).fast; } catch (e) { return failure(e, UNREACHED); }
      const done = await inParts(i.items, partSize({ cap: CHECKLIST_BATCH, out: control.limits.rewordReplyTokens, outLimit: outLimit(fast), in: tokensEach(i.items), inLimit: inLimit(fast) }), async (part) => {
        let reply: { items?: unknown } | null; let cut = false;
        // the items come as texts with no record ids, so they are numbered per prompt (#1162)
        try { reply = await askJson({ kind: 'reword', split: true, model: fast, system: JSON_ONLY, prompt: `These are items of a due diligence checklist for project-finance deals. Each will be checked against a deal's documents, so each should say plainly one thing that must be true.\n${part.map((t, n) => `${n + 1}: ${t.replace(/\s+/g, ' ')}`).join('\n')}\n\nPropose new wording only for an item that is unclear (shorthand, an abbreviation a reader may not know, a bare noun) or that joins two conditions (with "and", ";" or "/"). Keep its meaning exactly: add nothing, drop nothing, keep every figure. Write each item as one plain sentence saying what must be true. An item that joins two conditions becomes two or more items in "texts", one condition each; add "(if applicable)" only to one that may not apply to every deal, such as "Wetlands delineation complete (if applicable)" for a site that may have no wetlands, never to every item. Leave out every item that reads well already. "why": a few words on what was unclear.\nReply as JSON: {"items": [{"n": 3, "text": "…", "why": "…"}, {"n": 5, "texts": ["…", "…"], "why": "…"}]}` }, ['items']); }
        catch (e) { if (!isCutOff(e)) throw e; cut = true; reply = (e as { partial?: { items?: unknown } | null }).partial ?? null; }
        if (!cut && (!reply || !Array.isArray(reply.items))) {
          throw Object.assign(new Error(UNREAD_REPLY), { code: 'unread' });
        }
        const rows = listOf(reply?.items) as { n?: unknown; text?: unknown; texts?: unknown; why?: unknown }[]; const kept = cut ? rows.slice(0, -1) : rows;
        const got = new Map<number, { text: string; why: string; also?: string[] }>(); let last = 0; let inOrder = true;
        for (const x of kept) {
          // an item split in two comes as "texts"; one reworded as "text"
          const n = int(x?.n);
          const given = Array.isArray(x?.texts) ? prose(x.texts) : typeof x?.text === 'string' ? [x.text] : [];
          const texts = given.map((t) => fitText(t)).filter((t) => t.trim());
          if (n === null || n < 1 || n > part.length) continue; if (n <= last) inOrder = false; last = Math.max(last, n);
          const unchanged = texts.length === 1 && texts[0].trim() === part[n - 1].trim();
          if (!texts.length || unchanged || got.has(n - 1)) continue;
          got.set(n - 1, { text: texts[0], why: prose(x.why)[0] ?? '', ...(texts.length > 1 ? { also: texts.slice(1) } : {}) });
        }
        // a cut reply listed in order has dealt with every item up to its last whole one; out of order, every item it did not reword is asked again
        return { got, ...(cut ? { cut: inOrder ? range(last, part.length) : range(0, part.length).filter((k) => !got.has(k)) } : {}) };
      });
      // a reply that cannot be read, or an item whose reply is cut off even alone, fails the whole review, so nothing half-asked is shown
      if (done.stopped !== undefined) return stoppedOn(done.stopped);
      return ok([...done.got].sort((a, b) => a[0] - b[0]).map(([at, r]) => ({ at, ...r })));
    },
    async readList(i) {
      // What each line of a list is. The standard model reads it (the thorough one when asked, for lines left
      // unplaced): accuracy matters more than cost here. Lines go in parts sized from the model's limits,
      // each with the six lines before it for context; a reply lists the lines in order, so after a cut-off the lines past
      // its last whole one are asked again. Nothing is checked here: the app checks each reading against its line.
      let model: string;
      try {
        const m = await models();
        model = i.thorough ? m.thorough : m.standard;
      } catch (e) { return failure(e, UNREACHED); }
      const lines = i.lines.map((l) => l.replace(/\s+$/, ''));
      const wanted = (i.only ?? lines.map((_, k) => k + 1)).filter((n) => n >= 1 && n <= lines.length && lines[n - 1].trim());
      if (!wanted.length) return ok([]);
      const KINDS = new Set(['section', 'subsection', 'item', 'more', 'columns', 'left']);
      const done = await inParts(wanted, partSize({ cap: 200, out: control.limits.readLineTokens, outLimit: outLimit(model), in: tokensEach(wanted.map((n) => lines[n - 1])), inLimit: inLimit(model) }), async (part) => {
        // each asked line with the six before it; lines asked far apart (asked again) do not bring the lines between them
        const asked = new Set(part); const near = new Set<number>(); for (const n of part) for (let m = Math.max(1, n - 6); m <= n; m++) near.add(m);
        const shown = [...near].sort((a, b) => a - b).map((n, k, all) => `${k && all[k - 1] !== n - 1 ? '…\n' : ''}${n}${asked.has(n) ? ':' : ' (context only):'} ${lines[n - 1]}`).join('\n');
        let reply: { lines?: unknown } | null; let cut = false;
        try { reply = await askJson({ kind: 'readList', split: true, model, system: JSON_ONLY, prompt: `A firm's due diligence checklist for project-finance deals was pasted or imported as the numbered lines below. A table's row has its cells joined by " | ".\n${shown}\n\nSay what each line not marked "context only" is, one entry per line, in order, leaving none out:\n- "section" or "subsection": a heading that the items under it belong to;\n- "item": one thing to check; "text" is the item's words exactly as the line has them, with its leading number, letter or bullet as it is (for a table row, the cell that holds the item; "section" and "subsection" the row's own cells for those, left out when the cell is blank, as a blank cell takes the one above);\n- "more": the rest of the item on the line above (a long item wrapped onto the next line);\n- "columns": a table's heading row;\n- "left": anything else (a title, a note, a page number or footer, a date).\nNever reword, shorten or merge: take the words as they are.\nReply as JSON: {"lines": [{"n": 3, "k": "section", "text": "Site and real estate"}, {"n": 4, "k": "item", "text": "Title report for the whole site"}, {"n": 5, "k": "more"}, {"n": 6, "k": "left"}]}` }, ['lines']); }
        catch (e) { if (!isCutOff(e)) throw e; cut = true; reply = (e as { partial?: { lines?: unknown } | null }).partial ?? null; }
        if (!cut && (!reply || !Array.isArray(reply.lines))) {
          throw Object.assign(new Error(UNREAD_REPLY), { code: 'unread' });
        }
        const rows = listOf(reply?.lines) as Record<string, unknown>[]; const kept = cut ? rows.slice(0, -1) : rows;
        const got = new Map<number, LineRead>(); let last = -1;
        const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');   // only checked against the line, never kept
        for (const x of kept) {
          const n = int(x?.n); const at = n === null ? -1 : part.indexOf(n); const k = String(x?.k ?? '');
          if (at < 0 || !KINDS.has(k) || got.has(at)) continue; last = Math.max(last, at);
          const r: LineRead = { n: n!, k: k as LineRead['k'] };
          if (text(x.text)) r.text = text(x.text); if (text(x.section)) r.section = text(x.section); if (text(x.subsection)) r.subsection = text(x.subsection);
          got.set(at, r);
        }
        return { got, ...(cut ? { cut: range(last + 1, part.length) } : {}) };
      });
      // a reply that cannot be read or a part cut off even alone fails the read, so a person never sees half a list as all of it
      if (done.stopped !== undefined) return stoppedOn(done.stopped);
      return ok([...done.got.values()].sort((a, b) => a.n - b.n));
    },
    async phrase(i) {
      // One question for the counterparty per point, in parts sized to the fast model's limits (parts.ts; decisions:
      // docs/decisions.md line 167; #1109), each call asked again only by the shared
      // quiet retry (`complete`). A reply cut off is dealt with as everywhere else (parts.ts): the points that came
      // back whole are kept, and a point cut off even alone is offered for Retry (null). What a whole reply leaves is
      // asked again (askPhrasePart), down to single points; a single point that brings nothing is offered for Retry.
      // Points that failed alone in an earlier run of the deal are asked last. Any other error from the service fails
      // the run; questions that came back are kept through it (phraseKept), so asking again pays only for the rest.
      let fast: string;
      try { fast = (await models()).fast; } catch (e) { return failure(e, UNREACHED); }
      const run = phraseRunFor(i.dealId, i.items);
      const size = partSize({
        cap: CHECKLIST_BATCH, out: control.limits.phraseReplyTokens, outLimit: outLimit(fast),
        in: tokensEach(i.items.map(phrasePromptLine)), inLimit: inLimit(fast),
      });
      for (let list = run.queue.shift(); list; list = run.queue.shift()) {
        const done = await inParts(list, size, (part) => askPhrasePart(run, fast, part));
        keepPhrased(run, list, done);
        if (done.stopped !== undefined && !isCutOff(done.stopped)) return failure(done.stopped, UNREACHED);
      }
      for (const x of i.items) run.had.delete(phraseKey(x));      // the caller holds these now; another run's are left
      // not one question came back
      if (run.out.length && run.out.every((t) => t === null)) return fail({ kind: 'failed', message: run.why });
      return ok(run.out as (string | null)[]);
    },
    async sameMeaning(i) {
      // The whole list and the general list go to the model in one call, which says which items ask for the same thing as
      // another. Only a list longer than SAME_BATCH is asked about in parts, each shown the items after it and the general
      // list (a pair with an earlier item was asked about in that item's part). A reply that cannot be read, as one too
      // long to arrive whole, is asked for again for half the items at a time; whatever answered is kept. Items whose
      // call was not answered are listed as missed. With `only`, just those items are asked about again, shown every item
      // after the first of them and the general list: an earlier item that answered was shown them already.
      const n = i.items.length; const total = n + i.against.length;
      const asked = i.only ? [...new Set(i.only)].filter((a) => Number.isInteger(a) && a >= 0 && a < n).sort((a, b) => a - b) : range(0, n);
      const parts = Array.from({ length: Math.ceil(asked.length / SAME_BATCH) }, (_, k) => {
        const mine = asked.slice(k * SAME_BATCH, (k + 1) * SAME_BATCH); const own = new Set(mine);
        return { mine, rest: range(mine[0] + 1, total).filter((g) => !own.has(g)) };
      });
      const text = (g: number) => (g < n ? i.items[g] : i.against[g - n]).replace(/\s+/g, ' ');
      const out: { a: number; b: number; inAgainst: boolean; why: string }[] = []; const seen = new Set<string>();
      let answered = false, stop: 'unreachable' | 'failed' | null = null; const missed = { unreachable: 0, failed: 0 }; const lost: number[] = [];
      const ask = async (part: { mine: number[]; rest: number[] }, halves: number): Promise<void> => {
        if (stop) { missed[stop] += part.mine.length; lost.push(...part.mine); return; }     // a half begun after another part's service error
        const { mine } = part; const shown = [...mine, ...part.rest];
        let reply: { pairs?: unknown } | null = null; let cut = false;
        // the items come as texts with no record ids, so they are numbered per prompt (#1162)
        try { reply = await askJson({ kind: 'sameMeaning', split: true, model: (await models()).fast, system: JSON_ONLY, prompt: `These are items of a due diligence checklist for project-finance deals. Items 1 to ${mine.length} are being brought in; the others are already listed.\n${shown.map((g, k) => `${k + 1}: ${text(g)}`).join('\n')}\n\nWhich of items 1 to ${mine.length} ask for exactly the same thing as another item, so that checking one settles the other? Be strict: only pairs you are sure of, each named once. Two items on the same subject that ask for different things are not a pair (an executed agreement and its terms are different things). "why": a few words on what both ask for.\nReply as JSON: {"pairs": [{"a": 2, "b": 9, "why": "…"}]}` }, ['pairs']); }
        // An error from the service would most likely come again, and a service that does not answer may take the
        // connector's whole wait each time: no more parts are begun, and those not begun are counted as missed with it
        catch (e) {
          // a reply cut off at the service's length limit is asked for again for fewer items, below, keeping the pairs that
          // came whole before the cut. A request too long to send is not: every part is shown the whole list after its first item.
          if (!isCutOff(e)) { const why = unreachable(e) ? 'unreachable' : 'failed'; stop ??= why; missed[why] += mine.length; lost.push(...mine); return; }
          cut = true; const partial = listOf((e as { partial?: { pairs?: unknown } | null }).partial?.pairs).slice(0, -1); if (partial.length) answered = true; take(partial);
        }
        if (cut || !reply || !Array.isArray(reply.pairs)) {
          // a reply too long to arrive whole is the likeliest cause, and half as many items give a shorter one; the first
          // half is shown the second, so a pair between them is still asked about (and if the first half fails, its items
          // are listed as missed, to be asked about again against everything)
          if (halves > 0 && mine.length > 1) { const h = Math.ceil(mine.length / 2); await ask({ mine: mine.slice(0, h), rest: [...mine.slice(h), ...part.rest] }, halves - 1); await ask({ mine: mine.slice(h), rest: part.rest }, halves - 1); return; }
          missed.failed += mine.length; lost.push(...mine); return;
        }
        answered = true; take(reply.pairs as unknown[]);
        /** the pairs a reply names, each mapped back to its places in the whole list, once */
        function take(pairs: unknown[]) {
          for (const p of pairs as { a?: unknown; b?: unknown; why?: unknown }[]) {
            let a = int(p?.a), b = int(p?.b); if (a === null || b === null || a === b || a < 1 || b < 1 || a > shown.length || b > shown.length) continue;
            if (a > mine.length) [a, b] = [b, a]; if (a > mine.length) continue;          // at least one must be an item brought in
            const x = shown[a - 1], y = shown[b - 1]; const pair = { a: x, b: y < n ? y : y - n, inAgainst: y >= n };
            if (!pair.inAgainst && pair.b < pair.a) [pair.a, pair.b] = [pair.b, pair.a];
            const k = `${pair.a}:${pair.b}:${pair.inAgainst}`; if (seen.has(k)) continue; seen.add(k);
            out.push({ ...pair, why: prose(p.why)[0] ?? '' });
          }
        }
      };
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(SAME_AT_ONCE, parts.length) }, async () => { while (next < parts.length && !stop) await ask(parts[next++], 3); }));
      const stopped = stop as 'unreachable' | 'failed' | null;    // set by the parts as they ran
      if (stopped) for (const p of parts.slice(next)) { missed[stopped] += p.mine.length; lost.push(...p.mine); }
      // items not compared are said to be so for the likelier of the two reasons, and listed, so they can be asked about again
      const items = lost.length; const kind = missed.unreachable >= missed.failed ? 'unreachable' as const : 'failed' as const;
      if (items && !answered) {
        return fail({ kind, message: kind === 'unreachable' ? `${SERVICE} could not be reached.` : UNREAD_REPLY });
      }
      // parts answer in any order: the pairs come back in the order of the list, whatever it was
      out.sort((p, q) => p.a - q.a || Number(p.inAgainst) - Number(q.inAgainst) || p.b - q.b);
      return ok({ pairs: out, ...(items ? { missed: { kind, at: lost.sort((a, b) => a - b) } } : {}) });
    },
    async issuesList(i) {
      // Two steps. The list is read from its file in one call, each point in the list's own words. Then the points
      // are sorted into workstreams and compared with the deal's findings and each other, with no file: the whole
      // list in one call, as the checklist's duplicate check is asked, in parts only for a list longer than
      // ISSUES_BATCH. A reply that cannot be read is asked for again for half as many points. Nothing is half
      // done: a point that cannot be read or sorted fails the whole, to be asked again.
      // a call that fails (a timeout, a server error) is asked again twice by every call's own retry (retry.ts), which
      // also covers that case, so it is not asked again here too; only a reply that cannot be read is (`unread`), twice
      const tried = async <T>(ask: () => Promise<T>): Promise<T> => { for (let k = 0; ; k++) { try { return await ask(); } catch (e) { if ((e as { code?: string })?.code !== 'unread' || k >= 2) throw e; } } };
      let fileId: string | undefined;
      try { fileId = (await o.keeper.ensure(await o.docs.wanted(i.dealId, [i.doc.docId])))[i.doc.docId]; } catch (e) { return failure(e, 'The file could not be read'); }
      if (!fileId) return fail({ kind: 'failed', message: 'The file could not be read' });
      const fast = (await models()).fast;
      const got = await readIssuePoints(i.doc.doc, fileId, fast, tried);
      if (!got.ok) return got;
      const read = got.value;
      if (!read.length) return fail({ kind: 'failed', message: 'No points were found in it' });
      // a point the list numbers nothing is known by its place
      const points = read.map((p, k) => ({ ...p, n: p.n || String(k + 1) }));
      const fs = i.findings.map((f) => `${f.title.replace(/\s+/g, ' ')}${f.text ? `: ${clean(f.text.replace(/\s*\[\d+\]/g, ''))}` : ''}`);
      const ws = new Map(i.workstreams.map((w) => [w.toLowerCase(), w]));
      const sorted = new Map<number, { title: string; workstream: string; same?: { finding: string } | { point: number } }>();
      // A part's call holds its own points, every point before them (an earlier point it may repeat) and the findings, so
      // it grows with the list and the deal. It is sized to the input limit, in steps taken only when the fuller
      // form does not fit: the earlier points by their opening words (level 1), the findings by their titles (2), then
      // the findings a share at a time, one call for each share (3), with the part's own points halved when even that
      // leaves too little room. The part's own points are always given whole, so a part fits whatever the list's length
      // and the deal's, and the calls grow only with the words sent.
      const budget = Math.floor((inLimit(fast) * control.limits.partShare) / 100);
      const titles = i.findings.map((f) => f.title.replace(/\s+/g, ' '));
      const opening = (t: string) => { const w = t.split(' '); return w.length > 12 ? `${w.slice(0, 12).join(' ')}…` : t; };
      type Share = [number, number];                                                       // findings from, to (level 3)
      const promptOf = (mine: number[], level: number, share?: Share) => {
        const upto = mine[mine.length - 1] + 1; const own = new Set(mine);
        // each finding by its id (#1162)
        const byId = (t: string, k: number) => `${i.findings[k].id}: ${t}`;
        const shown = level >= 3
          ? titles.slice(share![0], share![1]).map((t, k) => byId(t, share![0] + k))
          : (level >= 2 ? titles : fs).map(byId);
        const findingsHead = `These are the findings already raised on a deal${level >= 3
          ? `, ${share![1] - share![0]} of ${titles.length}, by their titles`
          : level >= 2 ? ', by their titles' : ''}`;
        const pointsHead = `These are points of an issues list brought in${level >= 1 && upto > mine.length
          ? ', those not asked about here by their opening words' : ''}`;
        // a point read from the list is no saved record: it keeps its per-prompt label (#1162)
        const pointLines = range(0, upto)
          .map((k) => `P${k + 1}: ${level === 0 || own.has(k) ? points[k].text : opening(points[k].text)}`);
        const asked = mine.length === upto ? 'the points' : `points ${mine.map((k) => `P${k + 1}`).join(', ')}`;
        return `${findingsHead}:\n${shown.join('\n') || '(none)'}\n\n${pointsHead}:\n${pointLines.join('\n')}\n\n`
          + `For each of ${asked}: "workstream": one of ${i.workstreams.join(', ')}; `
          + '"same": the id of the finding, or the earlier point (P2), that raises the same issue, so that settling '
          + 'one settles the other, or "" when none does. Be strict: only when you are sure. Two points on the same '
          + 'clause that ask for different things are not the same.\n'
          + 'Reply as JSON: {"points": [{"p": 1, "workstream": "Legal", "same": ""}]}';
      };
      // a finding's line in a share, counted with the id it is shown by (#1162)
      const lineTokens = (f: number) => tokensOf(`${i.findings[f].id}: ${titles[f]}\n`);
      // the points whose "same" came from a call that showed either side shorter than it is: each is confirmed below
      const loose = new Set<number>();
      // `from`: the fullest form still to try, raised when the service refused a fuller one as too long though it was
      // counted to fit. A part that fits in no form is halved; one point that fits in none ends the import.
      const ask = async (mine: number[], halves: number, from = 0, share?: Share): Promise<boolean> => {
        const halved = async () => { const h = Math.ceil(mine.length / 2); return (await ask(mine.slice(0, h), halves, from, share)) && ask(mine.slice(h), halves, from, share); };
        const level = share ? 3 : [0, 1, 2].find((l) => l >= from && tokensOf(promptOf(mine, l)) <= budget);
        if (level === undefined) {
          // the findings a share at a time, each share as many titles as the room left beside the points allows
          const room = budget - tokensOf(promptOf(mine, 3, [0, 0]));
          if (room < budget / 4) { if (mine.length > 1) return halved(); throw tooLong(TOO_LONG_ASK); }
          let at = 0;
          while (at < titles.length) {
            let to = at, used = 0;
            while (to < titles.length && (to === at || used + lineTokens(to) <= room)) used += lineTokens(to++);
            if (!(await ask(mine, halves, 3, [at, to]))) return false;
            at = to;
          }
          return true;
        }
        let reply: { points?: unknown } | null = null; const own = new Set(mine);
        const prompt = promptOf(mine, level, share);
        const input: Ask = { kind: 'issuesList', split: true, model: fast, system: JSON_ONLY, prompt,
          unusable: sameUnusable(i.findings, share) };
        try { reply = await tried(() => askJson(input, ['points'])); }
        catch (e) {
          if (isTooLong(e)) { if (level < 2) return ask(mine, halves, level + 1); if (mine.length > 1) return halved(); }
          if ((e as { code?: string })?.code !== 'cutoff') throw e;
        }
        const missing = new Set(mine);
        type Sorted = { p?: unknown; workstream?: unknown; same?: unknown };
        if (reply && Array.isArray(reply.points)) for (const r of reply.points as Sorted[]) {
          const k = (int(r?.p) ?? 0) - 1;
          // none of the firm's: left blank for a person, as a new finding's is (decisions)
          const workstream = ws.get(clean(r?.workstream).toLowerCase()) ?? '';
          if (!own.has(k)) continue;
          // the finding's title is the point's own text, never a model's wording (#1026)
          const title = points[k].text;
          const same = sameOf(i.findings, r?.same, k, share);
          // a point asked about with several shares keeps its first title, and the first thing any share says it repeats
          const had = sorted.get(k);
          if (!had) sorted.set(k, { title, workstream, ...(same ? { same } : {}) }); else if (!had.same && same) had.same = same;
          // confirmed below whenever either side was shown shorter than it is: a point or finding by opening words or title
          if (same && level >= 1 && sorted.get(k)!.same === same) loose.add(k);
          missing.delete(k);
        }
        if (!missing.size) return true;
        // a reply cut off, or one that left points out: those points are asked about again, half as many at a time
        if (halves <= 0) return false;
        const left = [...missing]; const h = Math.ceil(left.length / 2);
        return (await ask(left.slice(0, h), halves - 1, from, share)) && (left.length > h ? ask(left.slice(h), halves - 1, from, share) : true);
      };
      const parts = Array.from({ length: Math.ceil(points.length / ISSUES_BATCH) }, (_, k) => range(k * ISSUES_BATCH, Math.min(points.length, (k + 1) * ISSUES_BATCH)));
      try {
        let next = 0, whole = true;
        await Promise.all(Array.from({ length: Math.min(SAME_AT_ONCE, parts.length) }, async () => { while (whole && next < parts.length) { try { whole = (await ask(parts[next++], 3)) && whole; } catch (e) { whole = false; throw e; } } }));
        if (!whole) return fail({ kind: 'failed', message: UNREAD_REPLY });
      } catch (e) { return failure(e, UNREAD_REPLY); }
      // A "same" named from opening words or titles may be the wrong one: two points can open
      // alike and ask opposite things, as can a revised point and the finding its first version made. Each is confirmed in a call that shows both in full, a part at a time (parts.ts); one not confirmed, or
      // cut off even alone, is not joined, and its point becomes a finding of its own. A call that fails fails the import.
      const full = (f: { title: string; text?: string }) => `${f.title.replace(/\s+/g, ' ')}${f.text ? `: ${clean(f.text.replace(/\s*\[\d+\]/g, ''))}` : ''}`;
      const byId = new Map(i.findings.map((f) => [f.id, f]));
      const pairs = [...loose].sort((a, b) => a - b).map((k) => { const same = sorted.get(k)!.same!; return { k, a: points[k].text, b: 'finding' in same ? `the finding ${full(byId.get(same.finding)!)}` : `the earlier point ${points[same.point].text}` }; });
      if (pairs.length) {
        const done = await inParts(pairs, partSize({ cap: ISSUES_BATCH, out: 8, outLimit: outLimit(fast), in: tokensEach(pairs.map((p) => `${p.a} ${p.b}`)), inLimit: inLimit(fast) }), async (part) => {
          const reply = await tried(async () => {
            // a pair is not a saved record, so the pairs are numbered per prompt (#1162)
            const r = await askJson<{ same?: unknown }>({ kind: 'issuesList', split: true, model: fast, system: JSON_ONLY, prompt: `Each pair below is a point of an issues list brought in on a deal (A), and a finding already raised on the deal or an earlier point of the same list (B), each in full.\n\n${part.map((p, n) => `Pair ${n + 1}\nA: ${p.a}\nB: ${p.b}`).join('\n\n')}\n\nWhich pairs raise the same issue, so that settling one settles the other? Be strict: only when you are sure. Two points on the same clause that ask for different things are not the same.\nReply as JSON: {"same": [1, 3]}` }, ['same']);
            if (!r || !Array.isArray(r.same)) throw Object.assign(new Error(UNREAD_REPLY), { code: 'unread' });
            return r;
          });
          const yes = new Set((reply.same as unknown[]).map(int)); return { got: new Map(part.map((_, n) => [n, yes.has(n + 1)])) };
        });
        if (done.stopped && !isCutOff(done.stopped)) return failure(done.stopped, UNREAD_REPLY);
        pairs.forEach((p, n) => { if (done.got.get(n) !== true) delete sorted.get(p.k)!.same; });
      }
      return ok({ points: points.map((p, k) => ({ ...p, ...sorted.get(k)! })) });
    },
    async layout(i) {
      let reply: { sheet?: unknown; headerRow?: unknown; fields?: unknown } | null;
      try { reply = await askJson({ kind: 'layout', model: (await models()).fast, system: JSON_ONLY, prompt: `A spreadsheet called ${i.fileName} holds a table of questions and answers somewhere. These are the first rows of each sheet, with their row numbers:\n${i.sheets.map((s) => `Sheet "${s.name}":\n${s.rows.map((r, n) => `${s.first + n}: ${r.map((c) => c.replace(/\s+/g, ' ')).join(' | ')}`).join('\n')}`).join('\n\n')}\n\nSay which sheet, which row holds the headings, and which heading is which of these fields: ${i.fields.join(', ')}. Use a heading's own text exactly, and leave out a field that has no heading.\nReply as JSON: {"sheet": "…", "headerRow": 6, "fields": {"text": "Question", …}}` }, ['sheet', 'headerRow', 'fields']); }
      catch (e) { return failure(e, 'The file could not be read'); }
      const headerRow = int(reply?.headerRow); const sheet = i.sheets.find((s) => s.name === reply?.sheet) ?? i.sheets.find((s) => typeof reply?.sheet === 'string' && s.name.trim().toLowerCase() === reply.sheet.trim().toLowerCase()); const row = sheet && headerRow !== null ? sheet.rows[headerRow - sheet.first] : undefined;
      if (!sheet || !row) return fail({ kind: 'failed', message: 'No table found' });
      const fields: Record<string, string> = {}; const on = new Set(row.map((c) => c.trim()));
      for (const [k, v] of Object.entries((reply!.fields && typeof reply!.fields === 'object' ? reply!.fields : {}) as Record<string, unknown>)) if (i.fields.includes(k) && typeof v === 'string' && on.has(v.trim())) fields[k] = v.trim();       // only headings that are really in that row
      return Object.keys(fields).length ? ok({ sheet: sheet.name, headerRow: headerRow!, fields }) : fail({ kind: 'failed', message: 'No table found' });
    },
  };

  type Asked = { id: string; n?: number; text?: string; response?: string; respondedBy?: string; responded?: string; linkedFinding?: string; provenance?: { origin?: string } };
  const saidOf = (q: Asked) => createHash('sha256').update(String(q.response ?? '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
  /** the questions with their responses, each labeled by its id, never its number (#1105) */
  const responseLines = (qs: Asked[]) => qs.map((q) => {
    const asked = `${q.id}: ${String(q.text ?? '').replace(/\s+/g, ' ').trim()}`;
    return `${asked}\n${responseHeader(q)}: ${q.response!.replace(/\s+/g, ' ').trim()}`;
  }).join('\n');
  /** a deal's questions that have a response, by number */
  // (called only for a deal already read: after its findings were listed, or for a finding read by id, which reads its deal)
  async function answered(dealId: string): Promise<Asked[]> {
    const r = await o.repo.list('question', dealId); if (!r.ok) return [];
    return r.value.map((l) => ({ ...(l.envelope.data as Omit<Asked, 'id'>), id: l.id })).filter((q) => !!q.response?.trim()).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  }
  /**
   * What has been said in answer to the questions that bear on a finding, for the prompt: the questions linked to it,
   * and the questions linked to no finding whose response was judged able to change it (see `responses`). A response is
   * new information about a finding just as a document is, but it is not a document and cannot be cited as one.
   * `also` are responses to include whatever is recorded.
   */
  async function respondedOn(dealId: string, findingId: string, also: Asked[] = []): Promise<Asked[]> {
    const all = await answered(dealId); let heard = new Set<string>();
    try { heard = new Set((await lines(dealId)).filter((l) => l.heard?.findings?.includes(findingId)).map((l) => l.heard!.question)); } catch { /* the linked ones still count */ }
    const said = all.filter((q) => q.linkedFinding === findingId || (!q.linkedFinding && heard.has(q.id)) || also.some((a) => a.id === q.id));
    return said;
  }
  /** those responses for the prompt (`respondedOn`), each named by its question's id */
  async function responsesOn(dealId: string, findingId: string, also: Asked[] = []): Promise<string> {
    return responsesText(await respondedOn(dealId, findingId, also));
  }
  /** responses for the prompt, each named by its question's id, which code puts back as its number (questionsForIds) */
  function responsesText(said: Asked[]): string {
    if (!said.length) return '';
    const heading = '\n\nResponses received on the questions asked about this finding:';
    const named = 'A response is not a document: refer to it as "response <id>", with the id its question is shown '
      + 'by, and give it no [n] marker.';
    return `${heading}\n${responseLines(said)}\nTake these into account. ${named}`;
  }
  const sentOf = (dealId: string, docs: DocRecord[]): Sent[] => docs.map((rec) => ({ dealId, rec }));
  /** a finding as the checks see it; `closed`: a person closed it, and documents may bring that into question */
  type Raised = { id: string; rev: number; title: string; body: string[]; sources: Source[]; closed?: true };
  /**
   * Whether a finding still stands as written, going by the documents now (its own, any given in `also`, and what the
   * pick adds) and by the responses that bear on it, with any given in `heard`. Null when there is nothing to read it against, none of it can be opened on this PC, or the reply cannot be used. Throws when the service fails.
   */
  async function verify(dealId: string, f: Raised, model: string, core: string[], also: string[] = [], heard: Asked[] = []): Promise<{ stands: boolean; why: string } | null> {
    const docs = await sendable(dealId, await start(dealId, `${f.title} ${f.body.join(' ')}`, [...also, ...f.sources.map((x) => x.docId).filter((x): x is string => !!x)]   /* what prompted the re-check first: the cap never drops it */, width, core)); if (!docs.length) return null;
    const sent = sentOf(dealId, docs); const { files, listing, got } = await send(sent, model);
    if (!got.length || lostSome(sent, got)) return null;                        // a folder stopped answering since they were chosen: not judged on the rest
    // a closed finding is asked the other way round: "stands" is whether it stays closed
    const ask = f.closed ? `This finding was raised on the deal earlier, and a person has closed it.\nTitle: ${f.title}\nAs written: ${f.body.join(' ').replace(/\s*\[\d+\]/g, '')}\n\nGoing by the documents as they are now, does it stay closed? It does not if a document now shows the problem again, shows it was not settled, or makes it worse.\nReply as JSON: {"stands": true, "why": "one line"}`
      : `This finding was raised on the deal earlier.\nTitle: ${f.title}\nAs written: ${f.body.join(' ').replace(/\s*\[\d+\]/g, '')}${await responsesOn(dealId, f.id, heard)}\n\nGoing by the documents as they are now, and any responses above, does it still stand as written? It does not if a document or a response now says otherwise, settles it, or makes it worse.\nReply as JSON: {"stands": true, "why": "one line"}`;
    const reply = await askJson<{ stands?: unknown; why?: unknown }>({ kind: 'verify', model, system: JSON_ONLY, files, prompt: `Documents:\n${listing}\n\n${ask}` }, ['stands', 'why']);
    const said = typeof reply?.stands === 'boolean' ? reply.stands : ['true', 'yes'].includes(word(reply?.stands)) ? true : ['false', 'no'].includes(word(reply?.stands)) ? false : null;
    return said === null ? null : { stands: said, why: typeof reply!.why === 'string' ? reply!.why : '' };
  }
  /**
   * Mark an open finding as one to reassess, with the reason in a few plain words. This is the one thing the backend
   * writes on a finding a person may have touched: it changes no word of the finding and nothing a person set.
   */
  /** A checklist item has been reworded since its finding was raised: the finding, if it is open, is marked for a person to look at; nothing is checked and nothing new is raised. */
  const REWORDED = 'The checklist item it was raised on has been reworded';
  async function markReworded(x: { reworded: () => ChecklistItem[]; latest: Map<string, CheckLine>; renote: (it: ChecklistItem) => Promise<void> }, marked: string[]) {
    for (const it of x.reworded()) { const id = x.latest.get(it.id)!.finding!; if (await mark(id, REWORDED) && !marked.includes(id)) marked.push(id); await x.renote(it); }
  }
  async function mark(id: string, why: string, evidence: MarkEvidence = {}, closedToo = false): Promise<boolean> {
    const r = await tryMark(id, why, evidence, true, closedToo);
    if (r.kind === 'waits') {
      await owe(r.dealId, { finding: id, why, ...evidence });
      return false;
    }
    return r.kind === 'marked';
  }
  const markKey = (mark: Pick<Owed, 'finding' | 'why' | 'round'>) =>
    JSON.stringify([mark.finding, mark.why, mark.round]);
  /** what is owed on a deal: each mark not yet paid, once (a mark owed again after it was paid is owed again) */
  function owedOf(all: CheckLine[]): Owed[] {
    const out = new Map<string, Owed>();
    for (const { owed, paid } of all) {
      if (paid) out.delete(markKey(paid));
      if (!owed) continue;
      const key = markKey(owed);
      const had = out.get(key);
      const questions = had?.questions || owed.questions
        ? [...new Set([...(had?.questions ?? []), ...(owed.questions ?? [])])]
        : undefined;
      out.set(key, questions ? { ...owed, questions } : owed);
    }
    return [...out.values()];
  }
  async function owe(dealId: string, owed: Owed) {
    const key = markKey(owed);
    const pending = owedOf(await lines(dealId)).find((mark) => markKey(mark) === key);
    if (pending && (owed.questions ?? []).every((id) => pending.questions?.includes(id))) return;
    await say(dealId, { owed });
  }
  /** Write the marks owed on a deal whose findings now have one version; a finding still in two versions keeps waiting. Throws as `mark` does. */
  async function payOwed(dealId: string, marked: string[]) {
    for (const owed of owedOf(await lines(dealId))) {
      const { finding, why, round } = owed;
      const result = await tryMark(finding, why, owed);
      if (result.kind === 'waits') continue;
      if (result.kind === 'marked' && !marked.includes(finding)) marked.push(finding);
      await say(dealId, { paid: { finding, why, ...(round ? { round } : {}) } });
    }
  }
  type MarkResult = { kind: 'marked' | 'nothing' } | { kind: 'waits'; dealId: string };
  type MarkableFinding = Record<string, unknown> & { updatedOn?: { questions?: string[] } };

  function previousMark(
    finding: MarkableFinding, why: string, evidence: MarkEvidence, sameQuestions: boolean,
  ): 'marked' | 'nothing' | undefined {
    const current = finding.updated === true ? 'marked' : 'nothing';
    // A different check round is new evidence even when it gives the same display reason (#326).
    if (evidence.round) return finding.markedRound === evidence.round ? current : undefined;
    if (current === 'nothing') return undefined;
    // A response leaves a mark for another reason as it is.
    if (evidence.questions && !finding.updatedOn) return 'marked';
    return finding.updatedWhy === why && sameQuestions ? 'marked' : undefined;
  }

  function nextMark(finding: MarkableFinding, why: string, evidence: MarkEvidence) {
    const { updatedOn, ...data } = finding;
    const existing = updatedOn?.questions ?? [];
    const questions = evidence.questions ? [...new Set([...existing, ...evidence.questions])] : undefined;
    const kind = previousMark(finding, why, evidence, !questions || questions.length === existing.length);
    if (kind) return { kind };
    // Keep the fields of a record from a newer build too.
    return {
      data: {
        ...data,
        updated: true,
        updatedWhy: why,
        updatedAt: clock(),
        ...(questions ? { updatedOn: { questions } } : {}),
        ...(evidence.round ? { markedRound: evidence.round } : {}),
      },
    };
  }
  async function markFailure(error: Failure, id: string, dealId: string): Promise<MarkResult> {
    if (error.kind === 'rejected') {
      const current = await o.repo.get('finding', id);
      if (current.ok && current.value?.conflict?.length) return { kind: 'waits', dealId };
    }
    // A failed write must leave the check unfinished so it can retry.
    throw Object.assign(new Error(`The finding could not be marked: ${error.message}`), { kind: error.kind });
  }
  /** A closed finding is marked only by a check of it, as one that may need reopening. */
  const canMark = (status: unknown, closedToo: boolean) => (status ?? 'open') === 'open'
    || (closedToo && status === 'closed');
  /** `waits`: the finding has versions nobody has chosen between, so no mark can go on it yet. */
  async function tryMark(
    id: string, why: string, evidence: MarkEvidence, again = true, closedToo = false,
  ): Promise<MarkResult> {
    const stored = await o.repo.get('finding', id);
    if (!stored.ok || !stored.value) return { kind: 'nothing' };
    const { conflict, rev, envelope } = stored.value;
    const finding = envelope.data as MarkableFinding;
    const dealId = String(finding.dealId);
    if (conflict?.length) return { kind: 'waits', dealId };
    if (!canMark(finding.status, closedToo)) return { kind: 'nothing' };
    const next = nextMark(finding, why, evidence);
    if (next.kind) return { kind: next.kind };
    const result = await o.repo.transaction({
      writes: [{ kind: 'finding', id, data: next.data, expectedRev: rev, keepsSchema: true }],
    });
    if (result.ok) {
      o.announce?.('finding', id);
      return { kind: 'marked' };
    }
    if (result.error.kind === 'conflict' && again) return tryMark(id, why, evidence, false, closedToo);
    return markFailure(result.error, id, dealId);
  }

  /**
   * Everything a run over one deal's checklist and findings works with, read once at its start. With `round`, what it
   * writes belongs to that round: result lines carry its id and its documents, a finding it raises takes the round's
   * fixed id, and `prior` is how each item stood before the round began.
   */
  async function open(dealId: string, round?: RoundState) {
    // (the checklist is read once for a first pass or a check, and kept while it runs: see `runList`)
    const deal = await o.repo.get('deal', dealId); if (!deal.ok || !deal.value) return fail<never>({ kind: 'notFound', message: 'No such deal' });
    const about = deal.value.envelope.data as { name?: string; product?: string; sector?: string } & Record<string, unknown>; const recs = o.docs.records(dealId);
    let list: ChecklistItem[];
    try { list = runList.get(dealId) ?? (await dealItems(dealId)) ?? (o.checklist ? merge(await o.checklist({ ...about, id: dealId, name: String(about.name ?? ''), product: String(about.product ?? ''), sector: String(about.sector ?? '') })) : []); }
    catch { return fail<never>({ kind: 'failed', message: 'The checklist could not be read' }); }
    const [have, tombs] = [await o.repo.list('finding', dealId), await o.repo.list('tombstone', dealId)]; if (!have.ok) return have; if (!tombs.ok) return tombs;
    let m: Awaited<ReturnType<typeof models>>; let latest: Map<string, CheckLine>; let done: string[] | undefined; let known: string[] | undefined;
    let everChecked = false;
    let prior = new Map<string, CheckLine>();
    try { m = await models(); const all = await lines(dealId); const was = await outcomes(dealId, all); ({ latest, done, known } = was); everChecked = !!was.full; prior = round ? (await outcomes(dealId, all.filter((l) => !(l.round && round.ids.has(l.round))))).latest : latest; } catch (e) { return failure(e, 'The check could not start'); }
    // An item whose id has changed but whose wording has not (the checklist was brought in again) is the same item. What was
    // recorded under the old id is carried to the new one, without asking anything, so that it is not checked again and
    // cannot raise its finding a second time. Only an old id that is no longer on the list is carried from.
    { const ids = new Set(list.map((it) => it.id)); const same = (t: string) => t.trim().toLowerCase().replace(/\s+/g, ' ');
      const left = new Map<string, CheckLine>(); for (const [id, l] of latest) if (!ids.has(id) && l.text && l.result) left.set(same(l.text), l);
      for (const it of list) { if (latest.has(it.id)) continue; const l = left.get(same(it.text)); if (!l) continue; left.delete(same(it.text));
        const { v: _v, at: _at, n: _n, ...rest } = l; const line = { ...rest, item: it.id, text: it.text };
        try { await say(dealId, line); } catch (e) { return failure(e, 'The checklist results could not be saved'); }
        latest.set(it.id, { ...l, ...line }); } }
    const here = recs.map((r) => r.docId).sort(); const run = round?.def.docs ?? docsHash(here); const current = new Set(here);
    const fresh = known ? recs.filter((r) => !known!.includes(r.docId)) : recs;       // what has arrived since a run last got to the end
    const settled = new Set([...have.value, ...tombs.value].map((l) => l.id));
    const findings: Raised[] = have.value.map((l) => ({ rev: l.rev, ...(l.envelope.data as { id: string; title: string; body?: string[]; sources?: Source[]; status?: string }) })).filter((f) => (f.status ?? 'open') === 'open').map((f) => ({ id: f.id, rev: f.rev, title: f.title, body: f.body ?? [], sources: f.sources ?? [] }));
    const closed: Raised[] = have.value.map((l) => ({ rev: l.rev, ...(l.envelope.data as { id: string; title: string; body?: string[]; sources?: Source[]; status?: string }) })).filter((f) => f.status === 'closed').map((f) => ({ id: f.id, rev: f.rev, title: f.title, body: f.body ?? [], sources: f.sources ?? [], closed: true as const }));
    /** an item whose finding a person now owns, live or deleted: the first pass does not look at it again */
    const owned = (it: ChecklistItem) => { const l = latest.get(it.id); return l?.result === 'finding' && !!l.finding && settled.has(l.finding); };
    /**
     * Why an item would be looked at in a run of the first pass, if at all.
     *   'new'   it has never been settled: it is new, reworded, or was left unsettled. It gets the full check.
     *   'gone'  it was satisfied against a document that is no longer in the data room.
     *   'word'  a document has arrived whose path, summary or search terms share a word with it (or with what a gap
     *           said it needed). Used only when the fast model cannot say what the new documents affect.
     * Null for everything else: what is settled and untouched is not asked about again, and an item with a finding,
     * live or deleted, is a person's to reassess.
     */
    const why = (it: ChecklistItem): 'new' | 'gone' | 'word' | null => {
      const l = latest.get(it.id); if (!l) return 'new';
      if (owned(it)) return null;                                                      // a person's, however the item is worded now: a reworded item is not checked into a second finding (see `reworded`)
      if (l.text !== it.text || l.result === 'unsettled') return 'new';
      if (l.run === run) return null;                                                  // already checked against the documents as they are now                                     // a person's, or already checked against the documents as they are now
      if (l.result !== 'gap' && (l.docs ?? []).some((id) => !current.has(id))) return 'gone';   // a document going cannot fill a gap, but it can undo what was satisfied
      const q = words(`${it.text} ${l.need ?? ''}`, dealId); return fresh.some((r) => score(r, q, dealId) > 0) ? 'word' : null;
    };
    /**
     * The findings each checklist item has raised, and what a new problem from that item does. A finding is matched
     * by the item it was raised on (`itemId`), never by its title: the model words a title differently from run to run, and
     * two different problems can be worded alike.
     *   open (or in two versions): it is the same finding, and the item's line names it;
     *   closed only: a person settled that one; a new problem is a new finding, which names the earlier one;
     *   deleted: a person said it is not a finding, so that item does not raise one again.
     * Another item's problem is always its own finding, however it is worded.
     */
    const taken = new Map<string, { id: string; state: 'open' | 'closed' }>(); const deleted = new Set<string>();
    const rank = { open: 2, closed: 1 } as const;
    const know = (item: unknown, id: string, state: 'open' | 'closed') => { if (typeof item !== 'string' || !item) return; const had = taken.get(item); if (!had || rank[state] > rank[had.state]) taken.set(item, { id, state }); };
    const learn = (fs: typeof have.value, ts: typeof tombs.value) => {
      for (const l of fs) { const d = l.envelope.data as { id: string; itemId?: string; status?: string }; know(d.itemId, d.id, (d.status ?? 'open') === 'open' || l.conflict?.length ? 'open' : 'closed'); }
      for (const l of ts) { const d = l.envelope.data as { kind?: string; snapshot?: { itemId?: unknown } }; const item = d.snapshot?.itemId; if ((d.kind ?? 'finding') === 'finding' && typeof item === 'string') deleted.add(item); }
    };
    learn(have.value, tombs.value);
    const written: string[] = [];
    const readFor = new Map<string, Set<string>>(); const needOf = new Map<string, string>();
    /** each item's search trail in this check */
    const trailOf = new Map<string, Trail>();
    // a gap already searched for on these same documents is not searched again: nothing has arrived that a search could find (cost)
    // (and worded the same: a reworded item is searched for afresh, and never shows the old wording's searches)
    const searched = (it: ChecklistItem) => { const l = prior.get(it.id); return l?.result === 'gap' && l.run === run && l.text === it.text && !!l.trail?.length; };
    const trailed = (trails: Map<string, Trail> | undefined) => { for (const [id, t] of trails ?? []) trailOf.set(id, [...(trailOf.get(id) ?? []), ...t]); };
    /** items a full check would leave open, held back for the chat agent's search while `holding` (see `fill`) */
    const held = new Map<string, { it: ChecklistItem; result: Outcome; why?: string }>(); let holding = false;
    /** while the agent's documents are read against held items: what the check left each as, written again if they leave it open */
    const kept = new Map<string, { result: Outcome; why?: string; need?: string }>();
    const note = async (it: ChecklistItem, result: Outcome, finding?: string, more: { where?: Source[] | CheckLine['where']; why?: string } = {}) => {
      if (holding && ((result === 'gap' && !searched(it)) || (result === 'unsettled' && !isAway(more.why) && more.why !== UNSAVED))) { held.set(it.id, { it, result, ...(more.why ? { why: more.why } : {}) }); return; }
      const was = kept.get(it.id);
      // a problem found whose finding could not be saved is not hidden behind the old result
      if (was && (result === 'gap' || (result === 'unsettled' && more.why !== UNSAVED))) { result = was.result; more = was.why ? { why: was.why } : {}; if (was.need) needOf.set(it.id, was.need); else needOf.delete(it.id); }
      const where = result === 'ok' ? (more.where ?? []).flatMap((x) => (x.docId ? [{ docId: x.docId, loc: x.loc, ...(x.quote ? { quote: x.quote } : {}) }] : [])) : [];
      // the documents a satisfied item was settled on count among those it was read against, so that one of them going is noticed
      const line = { item: it.id, text: it.text, result, run, ...(round ? { round: round.def.id } : {}), docs: [...new Set([...(readFor.get(it.id) ?? []), ...where.map((x) => x.docId)])], ...(result === 'gap' && needOf.get(it.id) ? { need: needOf.get(it.id) } : {}), ...(finding ? { finding } : {}), ...(where.length ? { where } : {}), ...(result === 'unsettled' && more.why ? { why: more.why } : {}), ...(trailOf.get(it.id)?.length ? { trail: trailOf.get(it.id)!.slice(-TRAIL) } : result === 'gap' && searched(it) ? { trail: prior.get(it.id)!.trail } : {}) };
      await say(dealId, line); latest.set(it.id, { v: 1, at: '', ...line });
    };
    /** the findings there are now, live and deleted: another run, on this PC or another, may have written since this one started */
    const lookAgain = async () => {
      const [h, t] = [await o.repo.list('finding', dealId), await o.repo.list('tombstone', dealId)]; if (!h.ok || !t.ok) return;
      learn(h.value, t.value);
    };
    const raise = async (it: ChecklistItem, f: Extract<Seen, { kind: 'finding' }>) => {
      await lookAgain();
      if (deleted.has(it.id)) return note(it, 'finding');                          // this item's finding was deleted by a person: not written again
      const same = taken.get(it.id);
      if (same?.state === 'open') return note(it, 'finding', same.id);              // the same finding: this item's line names it, so the row is flagged with it
      // In a round the finding's id is fixed by the round, so two PCs that raise it write one record. One
      // already there (raised by another PC, or by this one before a restart) is named, not written again.
      const fixed = round ? findingIdFor(dealId, round.def.docs, it.id) : undefined;
      if (fixed) { const mine = latest.get(it.id); if (mine?.result === 'finding' && mine.finding && mine.round && round!.ids.has(mine.round)) return note(it, 'finding', mine.finding); const had = await o.repo.get('finding', fixed); if (had.ok && had.value) return note(it, 'finding', fixed); }
      await guards.get(dealId)?.();
      const id = fixed ?? `f_${(o.newId ?? ulid)()}`; const now = clock();
      // a closed finding never takes a new problem; the new one names it
      const data = {
        id, dealId, rev: 0, createdAt: now, updatedAt: now, title: f.title, workstream: f.workstream, status: 'open',
        raisedAt: now, body: f.body, sources: f.sources, origin: 'ai', note: '', reviewed: null, updated: false,
        itemId: it.id, ...(same?.state === 'closed' ? { earlier: same.id } : {}),
      };
      const w = await o.repo.transaction({ writes: [{ kind: 'finding', id, data, expectedRev: null }], index: { dealId, add: [{ kind: 'finding', id }] } });
      if (!w.ok) { if (fixed) { const had = await o.repo.get('finding', fixed); if (had.ok && had.value) return note(it, 'finding', fixed); } return note(it, 'unsettled', undefined, { why: UNSAVED }); }
      know(it.id, id, 'open'); written.push(id); await note(it, 'finding', id); o.announce?.('finding', id);
    };
    /** by model, carried through the run: the most items a call's reply has fitted, and the most documents a call's request has, once a cut-off or a refusal has shown them smaller; and how many items in a row were cut off even alone (parts.ts), so a model whose every reply is cut is not asked on and on */
    const room = new Map<string, { items: number; docs: number; stuck: number; whole?: boolean }>();
    /** by model, the documents the service refused as too long even alone, in this run: not sent to that model again (another model may take a longer request) */
    const tooLong = new Map<string, Set<string>>();
    /**
     * What the model says of some items: an item left out had a reply that could not be read, or a call that failed. Only
     * a service that cannot be reached stops the run. The items go in parts that fit the service's limits (parts.ts): a
     * reply cut off keeps what came back whole, and the rest are asked again in smaller parts; an item cut off even
     * alone comes back weak, not to be asked again in this look.
     *
     * A request refused as too long is asked again with half the documents, the likeliest first. What that settles
     * stands; an item it leaves open ("more") is then asked against the documents left out, a handful of that size at a
     * time, so no item is called a gap on documents it was not shown. A document too long even alone is left out for
     * the rest of the run, and an item still open that was given one is left weak, saying so, rather than called a gap.
     */
    const ask = async (items: ChecklistItem[], docs: DocRecord[], model: string, redo?: Map<string, { why: string; said?: unknown }>, fix = true): Promise<Map<string, Seen>> => {
      const out = new Map<string, Seen>(); const r = room.get(model) ?? { items: Infinity, docs: Infinity, stuck: 0 }; room.set(model, r);
      const tooLongAlone = tooLong.get(model) ?? new Set<string>(); tooLong.set(model, tooLongAlone);
      const open = new Map<string, Extract<Seen, { kind: 'none' }>>();           // items no handful has settled yet, with what the first said they need
      let pending = items; let rest = docs.filter((d) => !tooLongAlone.has(d.docId));
      while (pending.length && rest.length) {
        let using = rest.slice(0, r.docs); const todo = pending;
        const replyEach = model === m.fast ? control.limits.glanceReplyTokens : control.limits.checkReplyTokens;
        const inEach = tokensEach(todo.map(checkLine));
        const replyRoom = { out: replyEach, outLimit: outLimit(model) };
        const size = Math.min(r.items,
          partSize({ cap: todo.length, ...replyRoom, in: inEach, inLimit: inLimit(model) }));
        const done = await inParts(todo, size, async (part) => {
          for (;;) {
            try {
              const seen = await check(part, sentOf(dealId, using), model, redo, fix);
              return { got: new Map(part.flatMap((it, k) => (seen?.has(it.id) ? [[k, seen.get(it.id)!] as const] : []))), ...(seen?.cut ? { cut: seen.cut.map((it) => part.indexOf(it)) } : {}) };
            } catch (e) {
              if (!isTooLong(e)) throw e;
              // fewer items would not shorten it much: the documents are halved, and one too long alone ends this handful
              if (using.length <= 1) throw Object.assign(e as Error, { code: 'doctoolong' });
              using = using.slice(0, Math.ceil(using.length / 2)); r.docs = using.length;
            }
          }
        }, r);
        if (unreachable(done.stopped)) throw done.stopped;
        const alone = (done.stopped as { code?: string } | undefined)?.code === 'doctoolong';
        if (done.size < size && !alone) r.items = done.size;                       // only a size a cut-off shrank is carried on
        const next: ChecklistItem[] = []; const left = new Set(done.left);
        for (const [k, v] of done.got) { if (v.kind === 'none') { if (!open.has(todo[k].id)) open.set(todo[k].id, v); next.push(todo[k]); } else { open.delete(todo[k].id); out.set(todo[k].id, v); } }
        // an item this handful gave no answer on (a reply that could not be read) is left out, to be asked again, whatever an earlier handful said of it
        todo.forEach((it, k) => { if (!done.got.has(k) && !left.has(k)) open.delete(it.id); });
        if (alone) {
          // the halving may all have been that document's doing: it is left out, and the items still open are asked against the others afresh, from full size
          tooLongAlone.add(using[0].docId); rest = docs.filter((d) => !tooLongAlone.has(d.docId)); r.docs = Infinity; pending = [...next, ...done.left.map((k) => todo[k])]; continue;
        }
        if (isCutOff(done.stopped)) {
          for (const k of done.left) {
            open.delete(todo[k].id);
            out.set(todo[k].id, {
              kind: 'weak',
              last: true,
              why: 'Your reply on it was cut off at the length limit.',
              reason: CUT_ON_IT,
            });
          }
          // items not asked because the replies before them kept being cut off: weak, not last, so they are asked again (`settle`), with no reason that is not theirs
          for (const k of done.unasked) {
            open.delete(todo[k].id);
            out.set(todo[k].id, { kind: 'weak', unasked: true, why: 'It was not asked yet.', reason: CUT_BEFORE_IT });
          }
        } else if (done.stopped !== undefined) { for (const it of todo) if (!out.has(it.id)) open.delete(it.id); break; }   // a call that failed: its items are left out, as before, not held to what an earlier handful said
        const used = new Set(using.map((d) => d.docId)); rest = rest.filter((d) => !used.has(d.docId)); pending = next;
      }
      // open after every handful it could be shown: it needs other documents, unless one it was given could not be sent at all
      const unsent = docs.filter((d) => tooLongAlone.has(d.docId)).length; const weakLong: Seen = { kind: 'weak', last: true, why: 'A document for it was too long to send.', reason: `A document it was to be checked against was too long to send to ${SERVICE}.` };
      for (const it of items) { const o2 = open.get(it.id); if (out.has(it.id)) continue; if (unsent === docs.length || (unsent && o2)) out.set(it.id, weakLong); else if (o2) out.set(it.id, o2); }
      return out;
    };
    /**
     * Put some items to the standard model against a handful of documents. Those whose reply cannot be used are sent
     * back to it with what was wrong, to be put right; and those it fails twice go once to the thorough model. Returns
     * the items that say other documents would settle them, unless this is their last look.
     */
    const settle = async (items: ChecklistItem[], docs: DocRecord[], last: boolean): Promise<{ it: ChecklistItem; need: string }[]> => {
      for (const it of items) { const had = readFor.get(it.id) ?? new Set<string>(); for (const r of docs) had.add(r.docId); readFor.set(it.id, had); }   // `docs` are documents that are in the store: see `work`
      const weakOne: Extract<Seen, { kind: 'weak' }> = { kind: 'weak', why: 'Your reply could not be read.' }; const seen = await ask(items, docs, m.standard);
      const lost = (x: Seen) => x.kind === 'weak' && isAway(x.reason);        // its documents' folder stopped answering: not the model's doing, so it is not asked again
      const again = (x: Seen) => x.kind === 'weak' && !x.last && !lost(x);         // cut off or too long even alone: asking again would be too
      const weak = items.filter((it) => again(seen?.get(it.id) ?? weakOne));
      // an item never asked is asked as a first look, with repair on; one whose reply could not be used is told what was wrong
      const unasked = weak.filter((it) => (seen?.get(it.id) as { unasked?: boolean } | undefined)?.unasked); const worn = weak.filter((it) => !unasked.includes(it));
      // asked afresh: when the model's replies were coming back whole before it stopped, a run of long items stopped it, and
      // that must not stop this look before it reaches the items after them; when a probe has since found nothing whole,
      // every reply is being cut, and the count stands, so this look costs one probe
      const std = room.get(m.standard); if (unasked.length && std?.whole) std.stuck = 0;
      const second = new Map<string, Seen>([...(unasked.length ? await ask(unasked, docs, m.standard) : []), ...(worn.length ? await ask(worn, docs, m.standard, new Map(worn.map((it) => { const w = (seen?.get(it.id) ?? weakOne) as Extract<Seen, { kind: 'weak' }>; return [it.id, { why: w.why, said: w.said }]; }))) : [])]);
      const weaker = weak.filter((it) => again(second?.get(it.id) ?? weakOne)); const third = weaker.length ? await ask(weaker, docs, m.thorough, undefined, false) : null;
      const wanting: { it: ChecklistItem; need: string }[] = [];
      for (const it of items) {
        let s: Seen = seen?.get(it.id) ?? weakOne; if (again(s)) s = second?.get(it.id) ?? weakOne; if (again(s)) s = third?.get(it.id) ?? weakOne;
        if (s.kind === 'ok') await note(it, 'ok', undefined, { where: s.where }); else if (s.kind === 'finding') await raise(it, s);
        else if (s.kind === 'none') { needOf.set(it.id, s.need); if (last) await note(it, 'gap'); else wanting.push({ it, need: s.need }); }
        else await note(it, 'unsettled', undefined, { why: s.reason ?? UNUSABLE_ON_IT });
      }
      return wanting;
    };
    /**
     * Documents this person may not open: those in a closed folder, and a blackline whose clean draft is in one (it is
     * never sent without it). Found over the whole deal the first time a batch's chosen documents cannot all be read and one
     * of them is in such a folder, and again if another closes; null until then.
     *
     * Documents are chosen for a batch of items together, so one closed document would hold back every item in the batch.
     * When the choice takes one in, each item's own documents are asked for instead, a few items to a question to the fast
     * model (`pickFor`): an item whose own include one waits as "could not be checked", naming the folder, and the rest are
     * checked on their own documents. Closed core documents are not offered: they would hold back every item. A document
     * out of reach for any other reason (a drive that dropped) still holds back all the items it was chosen for.
     */
    let shutDocs: Set<string> | null = null; let shutFound: string[] = [];
    const closedIn = (chosen: DocRecord[], docs: DocRecord[]): boolean => {
      if (!o.docs.shut || !chosen.length) return false;
      // One of the closed documents found can be opened now (of two closed folders, one opened, say), whether or not it was
      // chosen this time: all are looked for again below. The folders on the way are listed; no file is opened.
      if (shutDocs && o.docs.shut(dealId, shutFound).size < shutFound.length) { shutDocs = null; shutFound = []; }
      if (chosen.some((r) => shutDocs?.has(r.docId))) return true;
      if (docs.length) return false;
      const away = o.docs.away?.(dealId, chosen.map((r) => r.docId)) ?? []; if (!away.length || !o.docs.shut(dealId, away).size) return false;
      const found = new Set(o.docs.shut(dealId, o.docs.records(dealId).map((r) => r.docId)).keys()); shutFound = [...found];
      for (const [bl, clean] of cleanOf(dealId)) if (clean && found.has(clean)) found.add(bl);
      shutDocs = found; return chosen.some((r) => found.has(r.docId));
    };
    /** the core documents that are not closed to this person */
    const openOf = (core: string[]) => (shutDocs?.size ? core.filter((id) => !shutDocs?.has(id)) : core);
    /** and those that are: they are not offered at all */
    const shutCore = (core: string[]) => (shutDocs?.size ? core.filter((id) => shutDocs?.has(id)) : []);
    /** the reason an item waits on these closed documents: a blackline is out of reach through its clean draft, which names the folder */
    const shutWhy = (ids: string[]) => awayWhy(dealId, toClean(ids));
    /** these documents, a blackline out of reach through its clean draft given as that draft */
    const toClean = (ids: string[]) => { const pairs = cleanOf(dealId); return ids.map((id) => { const c = pairs.get(id); return c && shutDocs?.has(c) ? c : id; }); };
    /**
     * Each item's own documents, when what was chosen for the batch takes in a closed one: the items whose own include one
     * (`held`, with them), and each other item's own (`own`, a clean draft with its blackline). An item the fast model gives
     * nothing for, or every item if it cannot be asked, goes by the ranking: that holds back more items, never fewer.
     */
    const ownChoice = async (group: ChecklistItem[], core: string[], given = false) => {
      const no = shutDocs ?? new Set<string>(); const each = Math.max(1, Math.floor(width / 4)); const open = openOf(core); const skip = new Set(shutCore(core)); const own = new Map<string, DocRecord[]>();
      // items started from the documents they were settled on have those as their own: nothing is asked
      if (given) for (const it of group) own.set(it.id, withClean(dealId, settledOn(it)));
      else for (let k = 0; k < group.length; k += SECOND_LOOKS) {
        const part = group.slice(k, k + SECOND_LOOKS); const said = await pickFor(dealId, part.map((it) => ({ id: it.id, what: it.text, rankBy: it.text })), skip, each, open);
        for (const it of part) { const got = said?.get(it.id); own.set(it.id, withClean(dealId, got?.length ? got : top(dealId, it.text, skip, each, open, false))); }
      }
      const held: [ChecklistItem, string[]][] = []; const clear: ChecklistItem[] = [];
      for (const it of group) { const lost = (own.get(it.id) ?? []).filter((r) => no.has(r.docId)).map((r) => r.docId); if (lost.length) held.push([it, lost]); else clear.push(it); }
      return { held, clear, own };
    };
    /** items in rounds whose own documents together fit in one handful */
    const pack = (items: ChecklistItem[], own: Map<string, DocRecord[]>) => {
      const rounds: { items: ChecklistItem[]; docs: DocRecord[] }[] = []; let cur: { items: ChecklistItem[]; docs: DocRecord[] } = { items: [], docs: [] };
      for (const it of items) {
        const mine = own.get(it.id) ?? []; const more = mine.filter((r) => !cur.docs.includes(r));
        if (cur.items.length && cur.docs.length + more.length > width) { rounds.push(cur); cur = { items: [], docs: [] }; }
        cur.items.push(it); cur.docs.push(...more);
      }
      if (cur.items.length) rounds.push(cur);
      return rounds;
    };
    /**
     * These items in rounds on their own documents, put in the store. A document that cannot be reached now for another
     * reason (a drive that dropped) holds back only the items whose own include it (`lost`, with them); the rest of its
     * round go in rounds of their own, and if one of those cannot be sent either, its items wait too.
     */
    const sendOwn = async (items: ChecklistItem[], own: Map<string, DocRecord[]>) => {
      const rounds: { items: ChecklistItem[]; chosen: DocRecord[]; docs: DocRecord[]; unsent: string[] }[] = []; const lost: [ChecklistItem, string[]][] = [];
      for (const r of pack(items, own)) {
        const unsent: string[] = []; const docs = await sendable(dealId, r.docs, unsent); if (!r.docs.length || docs.length) { rounds.push({ items: r.items, chosen: r.docs, docs, unsent }); continue; }
        const gone = new Set(o.docs.away?.(dealId, unsent) ?? []); const rest: ChecklistItem[] = [];
        for (const it of r.items) { const ids = (own.get(it.id) ?? []).map((x) => x.docId).filter((id) => gone.has(id)); if (ids.length || !gone.size) lost.push([it, ids.length ? ids : unsent]); else rest.push(it); }
        for (const r2 of pack(rest, own)) { const u2: string[] = []; const d2 = await sendable(dealId, r2.docs, u2); if (r2.docs.length && !d2.length) { for (const it of r2.items) lost.push([it, u2]); } else rounds.push({ items: r2.items, chosen: r2.docs, docs: d2, unsent: u2 }); }
      }
      return { rounds, lost };
    };
    /**
     * The items a closed folder does not hold back, read together in one call as a group is: on the documents chosen for
     * the group that are not closed, and as many of each item's own as still fit in the handful, whole. Each item's second
     * look brings what did not fit. Only if those cannot all be sent (a drive that dropped) are the items taken apart, each
     * on its own documents (`sendOwn`).
     */
    const sendClear = async (items: ChecklistItem[], own: Map<string, DocRecord[]>, chosen: DocRecord[]) => {
      if (!items.length) return { rounds: [], lost: [] as [ChecklistItem, string[]][] };
      const docs = chosen.filter((r) => !shutDocs?.has(r.docId));
      // by id: the records may have been read again since the group's choice (another PC wrote), as new objects
      for (const it of items) { const more = (own.get(it.id) ?? []).filter((r) => !docs.some((x) => x.docId === r.docId)); if (docs.length + more.length <= width) docs.push(...more); }
      const unsent: string[] = []; const sent = await sendable(dealId, docs, unsent);
      if (!docs.length || sent.length) return { rounds: [{ items, chosen: docs, docs: sent, unsent }], lost: [] as [ChecklistItem, string[]][] };
      return sendOwn(items, own);
    };
    /**
     * The documents a group of items is checked against first: what their searches found heads the fast model's pick
     * list, and the ranking of their words fills it; a search that cannot be made picks as before.
     */
    const found = async (group: ChecklistItem[], core: string[], skip: string[] = []): Promise<DocRecord[]> => {
      // `skip`: closed core documents, never offered (see `shutDocs`)
      const text = group.map((it) => it.text).join('\n'); const fresh = group.filter((it) => !searched(it)); const not = new Set(skip);
      const things = fresh.map((it) => ({ id: it.id, what: it.text }));
      const s = fresh.length ? await searchFor(dealId, things, not, core) : null;
      trailed(s?.trails);
      if (!s) return start(dealId, text, [], width, core, skip);
      return withClean(dealId, (await pick(dealId, text, not, width, core, text, interleave(group.map((it) => s.found.get(it.id) ?? [])))) ?? top(dealId, text, not, width, core, true));
    };
    /**
     * Items a check can start from the documents they were settled on: satisfied items, worded as they were, whose
     * documents are here, the places they were settled on first. They are packed into calls of one handful of documents
     * and `batch` items at most; `rest` have nothing to start from and are searched for.
     */
    const byId = new Map(recs.map((r) => [r.docId, r]));
    /** the documents a satisfied item, worded as it was, was settled on and that are here, the places it was settled on first */
    const settledOn = (it: ChecklistItem): DocRecord[] => { const l = prior.get(it.id); return l?.result === 'ok' && l.text === it.text ? [...new Set((l.where ?? []).map((x) => x.docId))].map((id) => byId.get(id)).filter((r): r is DocRecord => !!r).slice(0, width) : []; };
    const packed = (items: ChecklistItem[]) => {
      const packs: { items: ChecklistItem[]; docs: DocRecord[] }[] = []; const rest: ChecklistItem[] = [];
      for (const it of items) {
        const mine = settledOn(it);
        if (!mine.length) { rest.push(it); continue; }
        const p = packs.find((x) => x.items.length < batch && new Set([...x.docs, ...mine]).size <= width);
        if (p) { p.items.push(it); for (const r of mine) if (!p.docs.includes(r)) p.docs.push(r); } else packs.push({ items: [it], docs: [...mine] });
      }
      return { packs: packs.map((p) => ({ items: p.items, docs: withClean(dealId, p.docs) })), rest };
    };
    /**
     * Filling gaps (docs/core-documents-design.md, part 4): items a full check would leave as gaps, or not settled for
     * any reason but a folder out of reach, are held back (`note`, while `holding`) and handed a few at a time to the
     * chat agent (agent.ts), unchanged, with its own search, read, folder and brief tools: it searches and reads as
     * often as it needs. The documents its answer cites are then read against those items by `settle`, as on their last
     * look, so the outcome is written as the check writes any other, except that the agent only ever adds to what the
     * check found: an item those documents still leave open (they may have been cited for another item of the run) is
     * written as the check left it (`kept`). An item's first line in a round is the one that counts (rounds.ts,
     * `counts`), which is why nothing is written for a held item until the agent has had its turn.
     *
     * The limit: the agent's own ceilings hold (about `limits.chatTurns` turns a run, `limits.searchCalls` a search),
     * as in a chat; it runs outside any call budget, so each of its searches has `limits.searchCalls` of its own. A run
     * that has failed hands no more items over. A gap already searched for on these documents and
     * wording (`searched`) is not held, so not handed over again.
     */
    const filler = chatAgent(agentKit, agentOpts);
    let filling = true;
    const fill = async () => {
      const open = [...held.values()]; held.clear(); const byId = new Map(o.docs.records(dealId).map((r) => [r.docId, r]));
      for (let k = 0; k < open.length; k += GAPS_AT_ONCE) {
        const part = open.slice(k, k + GAPS_AT_ONCE); let docs: DocRecord[] = [];
        if (filling) {
          // the items are numbered in the chat message only to list them; nothing is mapped back by number (#1162)
          const listed = part.map(({ it }, i) => { const need = needOf.get(it.id); const tried = (trailOf.get(it.id) ?? []).filter((t) => !t.n).map((t) => `"${t.q}"`); return `${i + 1}. ${it.text.replace(/\s+/g, ' ')}${need ? ` Still needed: ${need}` : ''}${tried.length ? ` (searched already, finding nothing: ${tried.join(', ')})` : ''}`; }).join('\n');
          const message = 'These items of the due diligence checklist were not settled by the documents first chosen '
            + `for them:\n${listed}\n\n`
            + 'Find the documents in the data room that settle each item: those that show it is met, or that show a '
            + 'problem with it. Search in the words and names such documents would use, and read the likeliest. Answer '
            + 'by saying, item by item, what you found, citing the documents; say so for an item nothing in the data '
            + 'room settles.';
          const r = await filler.answer({
            deals: [dealId], withDeal: false, model: m.standard, about: '', history: '', must: {}, message,
          });
          if (!r.ok && r.error.kind === 'unreachable') throw Object.assign(new Error(r.error.message), { code: 'unreachable' });
          if (!r.ok) filling = false;                                              // a model whose replies cannot be used is not asked on and on in this check
          // at most half a handful cited, so that each with its clean draft still fits in one: a cited blackline is never cut off its own clean draft
          else docs = await sendable(dealId, withClean(dealId, [...new Set(r.value.sources.map((x) => x.docId))].map((id) => (id ? byId.get(id) : undefined)).filter((x): x is DocRecord => !!x).slice(0, Math.max(1, Math.floor(width / 2)))));
        }
        if (docs.length) { for (const x of part) kept.set(x.it.id, { ...x, need: needOf.get(x.it.id) }); try { await settle(part.map((x) => x.it), docs, true); } finally { kept.clear(); } }
        else for (const x of part) await note(x.it, x.result, undefined, x.why ? { why: x.why } : {});   // as the check left it
      }
    };
    /**
     * The full check of some items by the standard model: core documents first, then whatever an item says would
     * settle it. Documents that were chosen but cannot be opened on this PC are not read, and an item with nothing
     * left to read it against is left unsettled: it is not satisfied and it is not a gap.
     *
     * The second look is asked for a few items at a time: one question to the fast model says which documents each of
     * them needs, and items share a call to the standard model as long as their documents fit in one handful.
     */
    const work = async (todo: ChecklistItem[], core: string[], recorded = false, fills = true) => {
      const each = Math.max(1, Math.floor(width / 4));                             // documents one item may bring to a second look: a quarter of a handful, so that four items share a call
      // Check again starts from each satisfied item's recorded documents; the others are searched for
      const { packs, rest } = recorded ? packed(todo) : { packs: [], rest: todo };
      const groups = [...packs, ...Array.from({ length: Math.ceil(rest.length / batch) }, (_x, k) => ({ items: rest.slice(k * batch, (k + 1) * batch), docs: undefined }))];
      for (const { items: group, docs: from } of groups) {
        await fill();                                                              // 3. what the last group left open goes to the chat agent's search, before more is held
        holding = fills;
        try {
        // 1. against the item's own documents, or the documents its searches found and the ranking, core ones first
        const chosen = from ?? await found(group, openOf(core), shutCore(core)); const unsent: string[] = []; const docs = await sendable(dealId, chosen, unsent);
        // a document an item was settled on that has left this PC's copy (not one out of reach just now): the items are searched for instead
        if (from && unsent.length && !awayAmong(dealId, unsent)) { groups.push({ items: group, docs: undefined }); continue; }
        let rounds = [{ items: group, chosen, docs, unsent }];
        if (closedIn(chosen, docs)) {                                              // a closed document among them: each item's own (see `shutDocs`)
          const own = await ownChoice(group, core, !!from); for (const [it, ids] of own.held) await note(it, 'unsettled', undefined, { why: shutWhy(ids) });
          const sent = await sendClear(own.clear, own.own, chosen); for (const [it, ids] of sent.lost) await note(it, 'unsettled', undefined, { why: awayWhy(dealId, ids) });
          rounds = sent.rounds;
        }
        for (const r of rounds) {
          if (r.chosen.length && !r.docs.length) { const why = awayWhy(dealId, r.unsent); for (const it of r.items) await note(it, 'unsettled', undefined, { why }); continue; }
          const wanting = r.docs.length ? await settle(r.items, r.docs, false) : r.items.map((it) => (needOf.set(it.id, it.text), { it, need: it.text }));
          await second(wanting, new Set(r.docs.map((x) => x.docId)), core, each);
        }
        } catch (e) { held.clear(); throw e; } finally { holding = false; }
      }
      await fill();
    };
    /**
     * 2. against the documents an item says would settle it: whatever in the data room answers to them, past those it was
     * read against (`looked`). An item nothing answers to is a gap. Closed core documents are not offered (see `shutDocs`).
     */
    const second = async (wanting: { it: ChecklistItem; need: string }[], looked: Set<string>, core: string[], each: number) => {
      const open = openOf(core); let round: ChecklistItem[] = []; let extra: DocRecord[] = [];
      const go = async () => { if (round.length) await settle(round, extra, true); round = []; extra = []; };
      const thing = (w: { it: ChecklistItem; need: string }) => ({ id: w.it.id, what: `${w.it.text} Still needed: ${w.need}`, rankBy: `${w.it.text} ${w.need}` });
      // searched for, all of them in one question: an item none of whose searches found a document is a gap, with its trail;
      // an item whose search could not be made, or that was searched for already on these documents, is picked for as before
      const s = await searchFor(dealId, wanting.filter((w) => !searched(w.it)).map(thing), looked, open);
      trailed(s?.trails);
      const none = (id: string) => !!s && s.found.has(id) && !s.found.get(id)!.length;         // searched for, twice, and nothing answered
      for (let k = 0; k < wanting.length; k += SECOND_LOOKS) {
        const part = wanting.slice(k, k + SECOND_LOOKS); const things = part.map(thing);
        const said = await pickFor(dealId, things.filter((t) => !none(t.id)), looked, each, open, s?.found);
        for (const w of part) {
          const got = none(w.it.id) ? [] : said ? said.get(w.it.id) ?? [] : top(dealId, w.need, looked, each, open, false);
          if (!got.length) { await note(w.it, 'gap'); continue; }
          const unsent: string[] = []; const here = await sendable(dealId, got, unsent);
          if (!here.length) { await note(w.it, 'unsettled', undefined, { why: awayWhy(dealId, unsent) }); continue; }
          o.trace?.({ dealId, reason: `${w.it.text}: ${w.need}`, docs: here.map((r) => r.docId) });
          const more = here.filter((r) => !extra.includes(r)); if (extra.length + more.length > width) await go();       // a call is never given more than a handful: the rest go in the next one
          extra.push(...here.filter((r) => !extra.includes(r))); round.push(w.it);
        }
      }
      await go();
    };
    /**
     * The quick look at settled items by the fast model: does each still come out as recorded? Those that do are
     * `passed`; the rest are `flagged` for the standard model. With `record`, a pass is written down with the
     * documents it was read against, so the same look is not taken again while nothing changes.
     */
    const glance = async (items: ChecklistItem[], core: string[], record = false) => {
      const passed: ChecklistItem[] = []; const flagged: ChecklistItem[] = []; const looks: { item: string; same: boolean; was?: Outcome }[] = [];
      // each satisfied item is looked at against the documents it was settled on; the others are searched for
      const { packs, rest } = packed(items);
      const groups = [...packs, ...Array.from({ length: Math.ceil(rest.length / batch) }, (_x, k) => ({ items: rest.slice(k * batch, (k + 1) * batch), docs: undefined }))];
      for (const { items: group, docs: from } of groups) {
        const chosen = from ?? await found(group, openOf(core), shutCore(core)); const unsent: string[] = []; const docs = await sendable(dealId, chosen, unsent);
        if (from && unsent.length && !awayAmong(dealId, unsent)) { groups.push({ items: group, docs: undefined }); continue; }      // as in `work`
        let rounds = [{ items: group, chosen, docs }];
        // as in `work`: an item whose own documents are closed to this person is looked at in full there, where it waits
        if (closedIn(chosen, docs)) {
          const own = await ownChoice(group, core, !!from); const sent = await sendClear(own.clear, own.own, chosen);
          for (const [it] of [...own.held, ...sent.lost]) { const was = prior.get(it.id)?.result; flagged.push(it); looks.push({ item: it.id, same: false, ...(was ? { was } : {}) }); }
          rounds = sent.rounds;
        }
        for (const r of rounds) {
          // a pause that a run of long items caused, while replies were coming back whole, is cleared for each new handful, as in `settle`
          const fast = room.get(m.fast); if (fast?.whole) fast.stuck = 0;
          const seen = r.docs.length ? await ask(r.items, r.docs, m.fast) : null;
          for (const it of r.items) {
            const l = prior.get(it.id); const was = l?.result; const now = seen?.get(it.id)?.kind; const same = (was === 'ok' && now === 'ok') || (was === 'gap' && (now === 'none' || !r.chosen.length));
            (same ? passed : flagged).push(it); looks.push({ item: it.id, same, ...(was ? { was } : {}) });
            if (same && record) { readFor.set(it.id, new Set(r.docs.map((x) => x.docId))); if (l?.need) needOf.set(it.id, l.need); await note(it, was as Outcome, undefined, was === 'ok' ? { where: l?.where } : {}); }   // still satisfied: the places it was settled on stand
          }
        }
      }
      return { passed, flagged, looks };
    };
    /** write that the run got to the end, and with `full` that it was a check of everything */
    const finish = async (full?: FullCheck) => {
      const ids = list.map((it) => it.id);
      if (!done || done.join('\n') !== ids.join('\n') || (known ?? []).join(',') !== here.join(',') || written.length || full) await say(dealId, { done: { items: ids, docs: here } });
      done = ids;
      return full ? say(dealId, { full }) : undefined;
    };
    /** settled by an earlier run that never got to the end, against documents that are not the ones there now: to be looked at again, since nothing says what has arrived since */
    const stale = (it: ChecklistItem) => { const l = latest.get(it.id); return !!l && l.text === it.text && l.result !== 'unsettled' && !owned(it) && l.run !== run; };
    /** items worded differently from when their finding was raised: the finding is a person's, so the item is not checked again; `renote` records the new wording */
    const reworded = () => list.filter((it) => owned(it) && latest.get(it.id)!.text !== it.text);
    const renote = async (it: ChecklistItem) => { const l = latest.get(it.id)!; readFor.set(it.id, new Set(l.docs ?? [])); await note(it, 'finding', l.finding); };
    return ok({ about, recs, list, m, latest, prior, known, fresh, current, findings, closed, owned, why, stale, written, work, glance, finish, reworded, renote, here, have: have.value, tombs: tombs.value, gaps: () => gapsOf(latest, done), unsettled: () => list.filter((it) => latest.get(it.id)?.result === 'unsettled').map((it) => it.id), first: !known, everChecked });
  }
  /**
   * Which of a deal's open findings and settled items some new documents could affect, and for each finding which of
   * the new documents it is: the fast model's view, knock-on effects included. A hundred arrivals to a question, so a
   * large folder arriving is several questions and not one too long to answer, and the findings and items in parts
   * sized to the input limit (parts.ts). Null when it cannot say.
   */
  async function affects(arrived: DocRecord[], findings: Raised[], items: ChecklistItem[]): Promise<{ findings: Map<string, DocRecord[]>; items: Set<string> } | null> {
    const out = { findings: new Map<string, DocRecord[]>(), items: new Set<string>() };
    if (!arrived.length || (!findings.length && !items.length)) return out;
    const fast = (await models()).fast;
    const lines = [...findings.map(findingLine), ...items.map(itemLine)];
    // the fast model names each one it could change, so its reply grows as a quick look's does (#1162)
    const size = partSize({ cap: lines.length, out: control.limits.glanceReplyTokens, outLimit: outLimit(fast),
      in: tokensEach(lines), inLimit: inLimit(fast) });
    for (let at = 0; at < arrived.length; at += ARRIVALS) {
      const part = arrived.slice(at, at + ARRIVALS);
      for (let from = 0; from < lines.length; from += size) {
        const these = findings.slice(from, from + size);
        const theseItems = items.slice(Math.max(0, from - findings.length), Math.max(0, from + size - findings.length));
        const reply = await askAffected(part, these, theseItems, fast);
        if (!reply) return null;
        takeAffected(strings(reply.affected), part, these, theseItems, out);
      }
    }
    return out;
  }
  /** the values an affects reply gives under "affected" */
  const affectedIn = (text: string) => listOf(json<{ affected?: unknown }>(text, 'affected')?.affected);
  /** a finding as the affects prompt lists it: by its id, with its title */
  const findingLine = (f: Raised) => `${f.id}: ${f.title}${f.closed ? ' (closed)' : ''}`;
  /** a settled checklist item as the affects prompt lists it: by its id, with its words */
  const itemLine = (it: ChecklistItem) => `${it.id}: ${it.text}`;
  /** the affects prompt for some arrivals, findings and items, each listed by its permanent id (#1162) */
  function affectsPrompt(part: DocRecord[], findings: Raised[], items: ChecklistItem[]) {
    const closed = findings.some((f) => f.closed)
      ? ', and findings a person has closed, marked (closed), which new documents may bring into question' : '';
    const arrivals = part.map((r) => `${r.docId}: ${shown(r)}`).join('\n');
    const blocks = [
      `These documents have just arrived in the data room of a project-finance deal:\n${arrivals}`,
      ...(findings.length ? [`These are the deal's open findings${closed}:\n${findings.map(findingLine).join('\n')}`]
        : []),
      ...(items.length ? [`These are the checklist items already settled:\n${items.map(itemLine).join('\n')}`] : []),
    ];
    const question = 'Which of them could the new documents change? Think of knock-on effects, not only of matching '
      + 'words: a contract that ends changes everything that rested on it. Name each by its id, with the id of the new '
      + 'document that could change it.';
    return `${blocks.join('\n\n')}\n\n${question}\nReply as JSON: {"affected": ["<finding or item id> <document id>"]}`;
  }
  /**
   * The fast model's answer on some arrivals, findings and items, or null when it cannot say. A reply naming any id it
   * was not shown, on either side of a pair, is a failed reply, asked again (#1162).
   */
  async function askAffected(part: DocRecord[], findings: Raised[], items: ChecklistItem[], model: string) {
    const targets = [...findings.map((f) => f.id), ...items.map((it) => it.id)];
    const docIds = part.map((r) => r.docId);
    const unusable = (text: string) => !namesOnlyShown(text, [...targets, ...docIds])
      || unknownInPairs(affectedIn(text), targets, docIds).length > 0;
    const prompt = affectsPrompt(part, findings, items);
    const input: Ask = { kind: 'affects', split: true, model, system: JSON_ONLY, prompt, unusable };
    let reply: { affected?: unknown } | null;
    try {
      reply = await askJson<{ affected?: unknown }>(input, ['affected']);
    } catch (e) {
      if (unreachable(e)) throw e;
      return null;
    }
    return reply && 'affected' in reply ? reply : null;
  }
  /** each pair of a usable affects reply, mapped back by exact id: a finding with the arrivals beside it, or an item */
  function takeAffected(pairs: string[], part: DocRecord[], findings: Raised[], items: ChecklistItem[],
    out: { findings: Map<string, DocRecord[]>; items: Set<string> }) {
    for (const pair of pairs) {
      const [target, ...docIds] = pair.split(' ');
      const by = part.filter((r) => docIds.includes(r.docId));
      if (items.some((it) => it.id === target)) out.items.add(target);
      if (!findings.some((f) => f.id === target)) continue;
      const had = out.findings.get(target) ?? [];
      for (const r of by) if (!had.includes(r)) had.push(r);
      out.findings.set(target, had);
    }
  }

  const extras = {
    /**
     * The first pass, run when a deal's folders finish indexing: check the documents against the deal's checklist.
     *   - An item the documents do not satisfy becomes a finding, and only with a source we can open (one is enough).
     *   - An item with no document behind it becomes a gap: what the model read does not settle it, and nothing in the
     *     data room answers to the documents it said would, or those do not settle it either.
     *   - An item the documents satisfy leaves nothing to see.
     * Core documents are read first; another document is read when an item needs it, which includes the documents a
     * core document only reports on. No call is given more than a handful of documents. The standard model does the
     * checking. Items whose reply cannot be used are sent back to it, and what it fails twice goes once to the
     * thorough model. An item that is still not settled is left unsettled and is tried again on the next run.
     *
     * When documents arrive after a run has finished, the pass follows the change through, as cheaply as it can without
     * leaving anything out. The fast model says which settled items and open findings the arrivals could affect, and
     * for each finding which arrival (if it cannot say, a shared word decides). Every one it names is looked at, by
     * the fast model first; only what that doubts goes to the standard model, which settles the item again or marks
     * the finding for a person to reassess. A finding is looked at with the arrival that was named beside it, and the
     * reason on its mark names that document. There is no cap on how many: the cost is kept down by who does the
     * looking, not by leaving some unlooked at. A finding that cites a document no longer in the data room is marked
     * without any call. No word of a finding is changed, and nothing written here sets off another round.
     *
     * A run always gets to the end unless the service cannot be reached, and then the next run carries on from where it
     * stopped: what the stopped run settled is looked at again, by the fast model first, if the documents are no longer
     * the ones it was settled against. What is settled is not asked about again unless something that bears on it has
     * changed (see `why`), and an item with a finding is never looked at again here: a person reassesses or deletes a
     * finding, and a deleted one stays deleted.
     *
     * "Everything checked" is written the first time a run ends with every item settled, and not before: a run that
     * leaves items unsettled says so in what it returns, and says nothing about everything.
     */
    async firstPass(dealId: string): Promise<Result<{ written: string[]; gaps: { title: string }[]; unsettled: string[]; marked: string[]; /** the PC that started the round this one joined, by its name, when it was another */ elsewhere?: string }>> {
      return pass(dealId);
    },
    /**
     * Check everything on a deal again, on a person's asking: every checklist item and every open finding against the
     * documents as they are now.
     *
     * The quick check: the fast model goes over everything. Whatever it does not confirm is put to the standard model
     * before anything changes: an item gets its full check, and a finding is marked for a person to reassess if the
     * standard model agrees it no longer stands. Then a sample of what the fast model passed, a tenth of each block
     * rounded up, is checked by the standard model too. Where they disagree the standard model's answer stands; and if
     * it overturns more than one in five of the sample, `offerDeep` says so.
     *
     * The deep check (`deep`): the standard model on everything, no sample.
     *
     * Either way no word of a finding is changed: a finding is only marked.
     *
     * It says what it could not check: the items left unsettled and the findings no model gave a usable answer on
     * (`unchecked`). Only when there are none is "everything checked" written, and `at` given; otherwise `at` is null
     * and the date of the last complete check stands. With no checklist item and no open finding there is nothing to
     * check, and it is refused.
     *
     * The check is a round (see `request`): other PCs on the deal share it, and it ends when the round ends.
     */
    async checkAll(input: { dealId: string; deep?: boolean; only?: 'left' }): Promise<Result<CheckSummary>> {
      return request(input.dealId, input.only === 'left' ? 'rest' : input.deep ? 'deep' : 'quick');
    },
    /**
     * How far the review of a deal has got, from what is recorded: no model is asked.
     *
     * A document counts as read when it was given to the model in a check of a checklist item that came to a result
     * (satisfied, a finding or a gap). Being indexed is not being read, and neither is being described by the fast
     * model. For each of the deal's folders: its documents, how many of them have been read, how many are core, and
     * how many of the core ones have been read, and how many of its files are copies of a document counted elsewhere. For the checklist: how its items stand.
     */
    async progress(dealId: string): Promise<Result<DealProgress>> {
      try {
        const all = await lines(dealId); const read = new Set<string>(); const latest = new Map<string, CheckLine>(); let done: string[] | undefined; let core: string[] = [];
        const group = groupsOf(all);
        for (const l of all) { if (l.item) { keep(latest, l, group); if (l.result && l.result !== 'unsettled') for (const id of l.docs ?? []) read.add(id); } else if (l.done) done = l.done.items; }
        core = await coreOf(dealId, true);   // worked out as a check would, with nothing described for it
        const isCore = new Set(core); const folders = new Map<string, { folder: string; files: number; read: number; core: number; coreRead: number; copies?: number }>();
        const entry = (folder: string) => { const f = folders.get(folder) ?? { folder, files: 0, read: 0, core: 0, coreRead: 0 }; folders.set(folder, f); return f; };
        for (const r of o.docs.records(dealId)) {
          const f = entry(r.folder); f.files++; if (read.has(r.docId)) f.read++; if (isCore.has(r.docId)) { f.core++; if (read.has(r.docId)) f.coreRead++; }
          // a document's other places are copies: each is counted where it sits, and the document itself only at its first place
          for (const c of r.copies ?? []) { const g = entry(c.folder); g.copies = (g.copies ?? 0) + 1; }
        }
        const has = new Set(o.docs.records(dealId).map((r) => r.docId)); const items = (await shownItems(dealId, latest, done)).map(({ id }) => { const l = latest.get(id); return unmoored(l, (d) => has.has(d)) ? 'unsettled' : l?.result; }); const count = (r: Outcome) => items.filter((x) => x === r).length;
        const also = await alsoIn(dealId, o.docs.records(dealId));
        return ok({ folders: [...folders.values()], ...(also.length ? { alsoIn: also } : {}), checklist: { items: items.length, satisfied: count('ok'), findings: count('finding'), gaps: count('gap'), unsettled: items.length - count('ok') - count('finding') - count('gap') } });
      } catch { return fail({ kind: 'failed', message: 'The checklist results could not be read' }); }
    },
    /**
     * Every checklist item of a deal and how it stands, from what is recorded: no model is asked. The items are the ones
     * `progress` counts, in the same order, so the two always agree. An item no check has reached is `unchecked`. The
     * documents named are the ones read for the item when it came to its result; a check that came to none names none,
     * and a document the deal no longer has is left out. On a gap, one with no readable text is named apart, as not read.
     */
    async checklist(dealId: string): Promise<Result<ChecklistRow[]>> {
      try {
        const latest = new Map<string, CheckLine>(); let done: string[] | undefined;
        const all = await lines(dealId); const group = groupsOf(all);
        for (const l of all) { if (l.item) keep(latest, l, group); else if (l.done) done = l.done.items; }
        const recs = o.docs.records(dealId); const name = new Map(recs.map((r) => [r.docId, r.name]));
        // a document with no readable text (a scan, most often) was given but could not be read: a gap never counts it as checked
        const textless = new Set(recs.filter((r) => r.words !== undefined && !r.words.length).map((r) => r.docId));
        return ok((await shownItems(dealId, latest, done)).map(({ id, text }) => {
          const l0 = latest.get(id); const l = l0 && unmoored(l0, (d) => name.has(d)) ? { ...l0, result: 'unsettled' as const, why: UNMOORED } : l0; const settled = !!l?.result && l.result !== 'unsettled';
          const given = settled ? (l!.docs ?? []).filter((d) => name.has(d)) : []; const gap = l?.result === 'gap'; const unread = gap ? given.filter((d) => textless.has(d)) : [];
          return { id, text: l?.text ?? text ?? '', result: !l?.result ? 'unchecked' as const : l.result === 'ok' ? 'satisfied' as const : l.result,
            ...(l?.result === 'finding' && l.finding ? { findingId: l.finding } : {}), ...(l?.result === 'gap' && l.need ? { need: l.need } : {}),
            docs: given.filter((d) => !unread.includes(d)).map((d) => ({ docId: d, name: name.get(d)! })), ...(unread.length ? { unread: unread.map((d) => ({ docId: d, name: name.get(d)! })) } : {}),
            ...(l?.result === 'ok' && l.where?.some((x) => name.has(x.docId)) ? { sources: l.where.filter((x) => name.has(x.docId)).map((x) => ({ doc: name.get(x.docId)!, docId: x.docId, loc: x.loc, ...(x.quote ? { quote: x.quote } : {}) })) } : {}),
            ...(l?.result === 'unsettled' && l.why ? { why: l.why } : {}), ...(l?.result && l.at ? { at: l.at } : {}), ...(gap && l?.trail?.length ? { searched: l.trail } : {}) };
        }));
      } catch { return fail({ kind: 'failed', message: 'The checklist results could not be read' }); }
    },
    /** When everything on the deal was last checked, and whether that check's sample suggests a deeper one. No model is asked. */
    async checked(dealId: string): Promise<Result<CheckState>> {
      try { const all = await lines(dealId); const { full, latest } = await outcomes(dealId, all); const ended = await endedNote(dealId); const checking = await checkingNow(dealId);
        // what the latest check left out and is still not settled, and whether the documents have changed since
        const lo = leftOf(view(all), latest); const end = lo?.round.end?.kind === 'done' ? lo.round.end.at : '';
        const left = lo && (lo.items.length || lo.findings.length) ? { items: lo.items.length, findings: lo.findings.length, at: end, changed: lo.round.def.docs !== docsHash(o.docs.records(dealId).map((r) => r.docId)) } : null;
        return ok({ at: full?.at ?? null, offerDeep: deeper(full), left, ...(ended ? { ended } : {}), ...(checking ? { checking } : {}) }); }
      catch { return fail({ kind: 'failed', message: 'The checklist results could not be read' }); }
    },
    /**
     * Follow through the responses received on questions that are linked to no finding. (A response on a question
     * linked to a finding marks that finding in the app, with no model.) Such a response is treated as a new document
     * is: one call of the fast model, for the responses and the open findings that have not been set against each
     * other, says which findings they could change, knock-on effects included. Each finding it names is looked at with
     * the response beside it, by the fast model first; only what that doubts goes to the standard model, and a finding
     * the standard model agrees no longer stands is marked for a person to reassess, with the question's number as the
     * reason. No word of a finding is changed.
     *
     * A response is set against each open finding once: a response reworded is a new one, and a finding raised later is
     * a new finding to set it against. A look that gave no usable answer is not counted as a look: that response and
     * that finding are tried again the next time. Called whenever a deal's questions may have new responses, and after
     * a run that raised findings; with nothing new it costs nothing.
     */
    responses(dealId: string): Promise<Result<{ heard: string[]; marked: string[] }>> { return hear(dealId); },
  };
  const HEARD_AT_ONCE = 50;
  /**
   * The fast model's question on responses tied to no finding: which of the open findings `listed` each could change.
   * Each question is named by its id, never by its number (#1105), and each finding by its id (#1162).
   */
  async function askAffects(group: Asked[], listed: Raised[]): Promise<{ affected?: unknown } | null> {
    const intro = 'These responses have been received to questions asked on a project-finance deal. '
      + 'None of the questions is tied to a finding.';
    const open = listed.map((f) => `${f.id}: ${f.title}`).join('\n');
    const question = 'Which findings could a response change? Think of knock-on effects, not only of matching words. '
      + 'Pair each finding with the question whose response bears on it; if no finding is touched, give an empty list.';
    const prompt = `${intro}\n${responseLines(group)}\n\nThese are open findings on the deal:\n${open}\n\n${question}\n`
      + 'Reply as JSON: {"affected": ["<finding id> <question id>"]}';
    const model = (await models()).fast;
    // a reply naming a question or finding id it was not shown is a failed reply, asked again (#1105, #1162)
    const questions = group.map((q) => q.id);
    const findings = listed.map((f) => f.id);
    const unusable = (text: string) => !namesOnlyShown(text, [...questions, ...findings])
      || unknownInPairs(affectedIn(text), findings, questions).length > 0;
    const input: Ask = { kind: 'affects', split: true, model, system: JSON_ONLY, prompt, unusable };
    return askJson<{ affected?: unknown }>(input, ['affected']);
  }
  async function hear(dealId: string): Promise<Result<{ heard: string[]; marked: string[] }>> {
    const marked: string[] = [];
    try {
      await payOwed(dealId, marked);
      const past = new Map<string, { findings: Set<string>; against: Set<string> }>(); const keyOf = (q: Asked) => `${q.id}|${saidOf(q)}`;
      for (const l of await lines(dealId)) if (l.heard) { const k = `${l.heard.question}|${l.heard.said}`; const p = past.get(k) ?? { findings: new Set<string>(), against: new Set<string>() }; for (const id of l.heard.findings ?? []) p.findings.add(id); for (const id of l.heard.against ?? []) p.against.add(id); past.set(k, p); }
      const have = await o.repo.list('finding', dealId); if (!have.ok) return have;
      const findings: Raised[] = have.value.map((l) => ({ rev: l.rev, ...(l.envelope.data as { id: string; title: string; body?: string[]; sources?: Source[]; status?: string }) })).filter((f) => (f.status ?? 'open') === 'open').map((f) => ({ id: f.id, rev: f.rev, title: f.title, body: f.body ?? [], sources: f.sources ?? [] }));
      const todo = (q: Asked) => findings.filter((f) => !past.get(keyOf(q))?.against.has(f.id));          // the open findings this response has not been set against
      const fresh = (await answered(dealId)).filter((q) => !q.linkedFinding && typeof q.n === 'number' && todo(q).length > 0); if (!fresh.length) return ok({ heard: [], marked });
      const bearsOn = new Map<string, Asked[]>();                                // finding → the responses said to bear on it
      for (let at = 0; at < fresh.length; at += HEARD_AT_ONCE) {
        const group = fresh.slice(at, at + HEARD_AT_ONCE); const listed = findings.filter((f) => group.some((q) => todo(q).includes(f)));
        const reply = await askAffects(group, listed);
        if (!reply || !('affected' in reply)) return fail({ kind: 'failed', message: 'The responses could not be looked at' });      // nothing is recorded, so they are looked at the next time
        for (const t of strings(reply.affected)) {
          const [id, ...asked] = t.split(' ');
          const f = listed.find((x) => x.id === id);
          if (!f) continue;
          const named = group.filter((q) => asked.includes(q.id));
          const qs = bearsOn.get(f.id) ?? []; for (const q of (named.length ? named : group).filter((y) => todo(y).includes(f))) if (!qs.includes(q)) qs.push(q); if (qs.length) bearsOn.set(f.id, qs);       // a finding named with no question we know: every response in the call is put beside it
        }
      }
      const unsure = new Set<string>();                                          // findings no model gave a usable answer on: not counted as looked at
      if (bearsOn.size) {
        const m = await models(); const core = await coreOf(dealId);
        for (const [id, qs] of bearsOn) {
          const f = findings.find((x) => x.id === id)!;
          let v: Awaited<ReturnType<typeof verify>> = null; try { v = await verify(dealId, f, m.fast, core, [], qs); } catch (e) { if (unreachable(e)) throw e; }
          if (v?.stands) continue;
          let sure: Awaited<ReturnType<typeof verify>> = null; try { sure = await verify(dealId, f, m.standard, core, [], qs); } catch (e) { if (unreachable(e)) throw e; }
          if (!sure) { unsure.add(id); continue; }
          const ns = qs.map((q) => `Q${q.n}`);
          if (!sure.stands && await mark(id, `Response received on ${ns.slice(0, 3).join(', ')}${ns.length > 3 ? ` and ${ns.length - 3} more` : ''}`, { questions: qs.map((q) => q.id) })) marked.push(id);
        }
      }
      for (const q of fresh) {
        const was = past.get(keyOf(q)); const named = [...bearsOn].filter(([, qs]) => qs.includes(q)).map(([id]) => id);
        await say(dealId, { heard: { question: q.id, said: saidOf(q), findings: [...new Set([...(was?.findings ?? []), ...named])], against: [...new Set([...(was?.against ?? []), ...todo(q).map((f) => f.id).filter((id) => !(named.includes(id) && unsure.has(id)))])] } });
      }
      return ok({ heard: fresh.map((q) => q.id), marked });
    } catch (e) {
      return unreachable(e) ? failure(e, '') : fail({ kind: 'failed', message: 'The responses could not be looked at' });
    }
  }


  // ── two or more PCs sharing a deal's checks: rounds (docs/architecture.md, Checks, and how PCs share them) ──────────────────────────────────────────
  //
  // A first pass or a check of everything is a round. The PC that starts it writes `opening`, prepares (the marks that
  // need no model, the `affects` call, the core), and writes the round's pieces once (`plan`). Every PC on the deal that
  // has the work to do joins it (`member`) and works the pieces it owns: blocks of items and single findings, shared out
  // by rendezvous over the live members, worked out afresh before every batch. A PC's run returns when it owns nothing
  // undone; a watcher keeps it a member, takes over the pieces of a member that has gone, and retries its own. Whoever
  // sees every piece done writes `done` (and `full`). Liveness is judged by each PC's own clock (`Observer`).
  const T: Timing = { ...TIMING, ...(o.timing ?? {}) };
  // the runs that write a deal's checklist results and findings take turns on a deal, on this PC: two at once would each raise the same findings
  const lanes = new Map<string, Promise<void>>();
  const inLane = <R>(dealId: string, go: () => Promise<R>): Promise<R> => { const run = (lanes.get(dealId) ?? Promise.resolve()).then(go); lanes.set(dealId, run.then(() => undefined, () => undefined)); return run; };
  const me = o.installId ?? 'local';
  /** this PC as the others name it: the person at it, and the PC's own name */
  const whoAmI = () => { let who = ''; try { who = o.person?.() ?? ''; } catch { /* unnamed */ } return { ...(o.label ? { label: o.label } : {}), ...(who ? { who } : {}) }; };
  const nowMs = o.now ?? (() => Date.parse(clock()));
  /** how often a PC waiting on the log looks again */
  const poll = Math.min(T.watch, 500);
  const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); (t as { unref?: () => void }).unref?.(); });
  const STALE = Object.assign(new Error('This PC slept or rejoined since it took this work'), { kind: 'stale' });
  const NOT_SYNCING = 'This PC is not syncing with the Punchlist folder, so it has stopped its part of the check. You will be told how the check ended once syncing resumes.';
  const NOT_STARTED = 'This PC is not syncing with the Punchlist folder, so the check has not started yet. It starts once syncing resumes.';
  const COULD_NOT = 'The check could not finish';
  const SERVICE_AWAY = `${SERVICE} can’t be reached. The check resumes once ${SERVICE} is back.`;
  /** what this PC is doing in a deal's round */
  interface Mine {
    round: string;
    epoch: number;
    lastRenew: number;
    rejoin: boolean;
    timer: ReturnType<typeof setInterval> | null;
    running: Promise<unknown> | null;
    ticking: boolean;
    tries: number;
    failingSince?: number;
    nextTry?: number;
    /** the last batch failed because nobody is signed in to the model service, not because it is out of reach */
    signedOut?: boolean;
    noOwnerSince?: number;
    left: boolean;
    /** this round was merged into another: the entry, and the epoch, this PC went on with there (#795) */
    merged?: { st: Mine; epoch: number };
  }
  const mine = new Map<string, Mine>();
  /** set once this backend closes */
  let closing = false;
  /** this PC's own heartbeat, to tell a sleep from a long wait on the model: when it last beat, and last woke */
  const awake = { beat: nowMs(), woke: Number.NEGATIVE_INFINITY };
  /** a beat; a gap longer than a lapse since the last one was a sleep */
  function beat() {
    const now = nowMs();
    if (now - awake.beat > T.lapse) awake.woke = now;
    awake.beat = now;
  }
  const heart = setInterval(beat, T.watch);
  (heart as { unref?: () => void }).unref?.();
  /** the most merges followed from one round to the round it ended in, in case the lines ever loop */
  const MERGES_MAX = 50;
  const preparing = new Set<string>();                                           // openings this PC is preparing now
  const background = new Set<Promise<unknown>>();
  const later = (go: () => Promise<unknown>) => { const p = go().catch(() => undefined); background.add(p); void p.finally(() => background.delete(p)); };
  const observers = new Map<string, Observer>();
  const observerOf = (dealId: string) => {
    let ob = observers.get(dealId);
    if (!ob) { const name = `quiet-${dealId}.json`; ob = new Observer(nowMs, o.local ? { read: () => o.local!.read(name), write: (t) => o.local!.write(name, t) } : undefined); observers.set(dealId, ob); }
    return ob;
  };
  // ── in touch with the shared folder ──
  let outSince: number | undefined;
  async function inTouch(): Promise<boolean> {
    let t = true; try { t = (await o.inTouch?.()) ?? true; } catch { /* taken as in touch */ }
    if (!t) outSince ??= nowMs();
    else if (outSince !== undefined) { outSince = undefined; for (const st of mine.values()) { st.epoch++; st.rejoin = true; } }   // back in touch: a new epoch, and the log is read again
    return t;
  }
  const outTooLong = () => outSince !== undefined && nowMs() - outSince >= T.lapse;
  async function look(dealId: string) { const all = await lines(dealId); const touch = await inTouch(); const ob = observerOf(dealId); ob.observe(all, !touch); return { all, v: view(all), ob, touch }; }
  // ── who is there ──
  /** the members of a round this PC sees as live: this PC only while it is working the round */
  const liveIn = (dealId: string, R: RoundState, ob: Observer) => [...R.members.keys()].filter((pc) => !R.left.has(pc) && (pc === me ? mine.get(dealId)?.round === R.def.id && !mine.get(dealId)!.left : ob.live(pc, T.lapse)));
  /** the live members that may own pieces: those that hold the round's documents */
  const ownersIn = (dealId: string, R: RoundState, ob: Observer) => liveIn(dealId, R, ob).filter((pc) => R.members.get(pc)?.ok);
  const othersIn = (dealId: string, R: RoundState, ob: Observer) => liveIn(dealId, R, ob).some((pc) => pc !== me);
  /** the units of a round held under a claim by each PC; a claim counts while its writer is live, whatever its `until` says */
  function heldIn(v: View, R: RoundState): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>(); const pre = `${R.def.id}:`;
    for (const l of v.lines as CheckLine[]) {
      if (l.claim) for (const k of l.claim.keys) if (k.startsWith(pre)) { const s = out.get(k.slice(pre.length)) ?? new Set<string>(); s.add(l.claim.pc); out.set(k.slice(pre.length), s); }
      if (l.release) for (const k of l.release.keys) if (k.startsWith(pre)) out.get(k.slice(pre.length))?.delete(l.release.pc);
    }
    return out;
  }
  /** whether every document a round was set up on is still on the deal (none deleted or taken off), so it can be finished; the wait while indexing is `ready` in `looseEnds` */
  const holds = (dealId: string, R: RoundState) => { const here = new Set(o.docs.records(dealId).map((r) => r.docId)); return here.size > 0 && R.def.docList.every((id) => here.has(id)); };
  /** a round, or an opening, that nobody is working any more: written off as abandoned, unless `spare` says this PC is to take the round over */
  async function buryDead(dealId: string, v: View, ob: Observer, spare?: (R: RoundState) => boolean) {
    for (const R of openRounds(v)) if (!liveIn(dealId, R, ob).length && !spare?.(R)) { await say(dealId, { abandoned: { round: R.def.id } }); R.end = { kind: 'abandoned' }; }
    for (const [id, op] of v.openings) if (!op.ended && !v.rounds.has(id) && (op.by === me ? !preparing.has(id) : !ob.live(op.by, T.lapse))) { await say(dealId, { abandoned: { round: id } }); op.ended = true; }
  }
  const liveOpening = (v: View) => [...v.openings.entries()].find(([id, op]) => !op.ended && !v.rounds.has(id));
  // ── the work ──
  type Todo = { p: Piece; nd: NonNullable<ReturnType<typeof need>>; u: string; i: number; block: number };
  /** what this PC owns and has still to do in a round, now */
  function myWork(dealId: string, v: View, R: RoundState, ob: Observer) {
    const facts = factsOf(v, R); const blocks = blockOf(R); const owners = ownersIn(dealId, R, ob); const held = heldIn(v, R); const todo: Todo[] = [];
    if (!owners.includes(me)) return { facts, todo, owners };
    R.pieces.forEach((p, i) => {
      const nd = need(R, facts, p); if (!nd || nd === 'wait') return;
      const u = unitOf(blocks, p); let who = owner(u, owners);
      // a member that owns undone pieces, holds no claim on them and has written no piece line in the round for a lapse has gone, for these pieces
      if (who && who !== me && nowMs() - ob.lastWork(R.def.id, who) >= T.lapse && !held.get(u)?.has(who)) who = owner(u, owners.filter((x) => x !== who));
      if (who !== me || [...(held.get(u) ?? [])].some((pc) => pc !== me && liveIn(dealId, R, ob).includes(pc))) return;
      todo.push({ p, nd, u, i, block: blocks.get(p.key) ?? 0 });
    });
    return { facts, todo, owners };
  }
  /**
   * The next batch: the stages run in today's order across everything this PC holds (the full checks, the looks, the
   * full checks of what the looks flagged, the findings by the fast model then the standard, the sample), so a stage is
   * never split into one call per block. Blocks are taken from a starting point of this PC's own when it shares the round,
   * so two PCs that briefly both think they own everything start far apart; alone, it starts at the first.
   */
  function pickBatch(R: RoundState, todo: Todo[], facts: Map<string, PieceFacts>, owners: number): Todo[] {
    // a finding's two looks come one after the other, as today: the fast model, and the standard where it doubts
    const rank = (t: Todo) => t.nd === 'check' ? (t.p.stage === 'check' || R.def.kind === 'deep' ? 1 : 3) : t.nd === 'glance' ? 2 : t.nd === 'fast' ? 4 : t.nd === 'standard' ? (R.def.kind === 'quick' && facts.get(t.p.key)?.fast?.stands === true ? 7 : 4) : t.nd === 'sample' ? 6 : 9;
    const n = Math.max(1, ...todo.map((t) => t.block + 1)); const from = owners > 1 ? createHash('sha256').update(`${me}\u0000${R.def.id}`).digest().readUInt32BE(0) % n : 0;
    const sorted = [...todo].sort((a, b) => rank(a) - rank(b) || (isItem(a.p) ? (a.block - from + n) % n - (b.block - from + n) % n : 0) || a.i - b.i);
    const first = sorted[0]; const r = rank(first);
    if (first.nd === 'glance') return sorted.filter((t) => t.nd === 'glance' && t.u === first.u);
    if (first.nd === 'check' || first.nd === 'sample') return sorted.filter((t) => rank(t) === r).slice(0, batch);
    return [first];
  }
  type Ctx = Extract<Awaited<ReturnType<typeof open>>, { ok: true }>['value'];
  /** One batch: what it writes belongs to the round; effects (a finding, a mark) are written before the line that says the piece is done. */
  async function runBatch(dealId: string, R: RoundState, ts: Todo[], x: Ctx, facts: Map<string, PieceFacts>) {
    const nd = ts[0].nd; const core = R.def.core.ids;
    if (isItem(ts[0].p)) {
      const on: ChecklistItem[] = [];
      for (const t of ts) { const it = x.list.find((y) => y.id === itemOf(t.p)); if (it) on.push(it); else await say(dealId, { skipped: { round: R.def.id, key: t.p.key, why: 'It is no longer on the checklist' } }); }
      if (!on.length) return;
      if (nd === 'check') await x.work(on, core, R.def.kind !== 'first');
      else if (nd === 'glance') { const g = await x.glance(on, core, R.def.kind === 'first'); await say(dealId, { glanced: { round: R.def.id, items: g.looks } }); }
      else if (nd === 'sample') { await x.work(on, core, true, false); for (const it of on) { const before = facts.get(`item:${it.id}`)?.glance?.was; const after = x.latest.get(it.id)?.result; await say(dealId, { sample: { round: R.def.id, key: `item:${it.id}`, ...(before ? { before } : {}), ...(after ? { after } : {}) } }); } }
      return;
    }
    const p = ts[0].p; const f = x.findings.find((y) => y.id === findingOf(p)) ?? x.closed.find((y) => y.id === findingOf(p));
    if (!f) { await say(dealId, { skipped: { round: R.def.id, key: p.key, why: 'It is no longer on the deal' } }); return; }
    const also = p.also ?? []; let v: Awaited<ReturnType<typeof verify>> = null;
    try { v = await verify(dealId, f, nd === 'fast' ? x.m.fast : x.m.standard, core, also); } catch (e) { if (unreachable(e)) throw e; }
    let marked = false;
    if (nd === 'standard' && v && !v.stands) {
      const why = R.def.kind === 'first' ? (also.length ? `${x.recs.find((r) => r.docId === also[0])?.name ?? 'A document'} arrived` : null) : CHECK_REASON;
      if (why) {
        await guards.get(dealId)?.();
        // a closed one is marked as one that may need reopening
        marked = await mark(f.id, why, { round: R.def.id }, !!f.closed);
      }
    }
    await say(dealId, { verified: { round: R.def.id, stage: nd === 'fast' ? 'fast' : 'standard', findings: [{ finding: f.id, stands: v ? v.stands : null, marked }] } });
  }
  /**
   * Before anything from a batch is written: has this PC slept, or rejoined, since it took the batch? A merge of its
   * round into another is neither: the batch's lines count for the kept round, so they are written (#795).
   */
  async function guard(dealId: string, took: Mine, epoch: number, takenAt: number) {
    const { st, want } = followMerges(took, epoch);
    if (closing || st.left) throw STALE;                   // this PC has left the round (it closed, or gave up)
    if (mine.get(dealId) !== st) {                         // the round has ended, or this PC has moved on from it
      // it slept since it took the batch (it no longer renews there), or a later round began
      beat();
      const slept = awake.woke > takenAt;
      if (took === st || slept || st.epoch !== want || !await lastRound(dealId, st.round)) throw STALE;
      return;
    }
    if (nowMs() - st.lastRenew > T.lapse) { st.epoch++; st.rejoin = true; }
    if (st.epoch !== want) throw STALE;
  }
  /** the entry a batch's lines now count for, through any merges since it was taken, and the epoch it must have */
  function followMerges(took: Mine, epoch: number) {
    let st = took;
    let want = epoch;
    for (; st.merged; st = st.merged.st) {
      if (st.epoch !== want) throw STALE;                  // it slept, or rejoined, before the merge
      want = st.merged.epoch;
    }
    return { st, want };
  }
  /**
   * Whether the round a merged batch's lines count for, once it has ended, is still the deal's latest: the batch is
   * written then, and not once a later round has begun, whose results it would otherwise take the place of (#795).
   */
  async function lastRound(dealId: string, roundId: string) {
    const v = view(await lines(dealId));
    let R = v.rounds.get(roundId);
    for (let i = 0; R?.end?.kind === 'merged' && i < MERGES_MAX; i++) R = v.rounds.get(R.end.into);
    const kept = R;
    return !!kept && ![...v.rounds.values()].some((x) => !kept.ids.has(x.def.id) && x.n > kept.n) && !liveOpening(v);
  }
  /** say this PC is still in the round; after a gap longer than a lapse (it slept) that is a new epoch */
  async function renew(dealId: string, R: RoundState) {
    const st = mine.get(dealId); if (!st) return;
    if (nowMs() - st.lastRenew > T.lapse) st.epoch++;
    const have = new Set(o.docs.records(dealId).map((r) => r.docId)); const needs = [...R.def.core.ids, ...R.pieces.flatMap((p) => p.also ?? [])];
    st.lastRenew = nowMs(); st.rejoin = false;
    await say(dealId, { member: { round: R.def.id, pc: me, ...whoAmI(), epoch: st.epoch, ok: needs.every((id) => have.has(id)) } });
  }
  /** this PC in round R; `merged`: the round it was in has just been merged into R, which `R.ids` may not show yet */
  async function join(dealId: string, R: RoundState, merged = false) {
    const st = mine.get(dealId);
    if (st && st.round === R.def.id && !st.left) { if (st.rejoin) await renew(dealId, R); return; }
    if (st?.timer) clearInterval(st.timer);
    // until its member line is written, the next look writes it
    const next: Mine = {
      round: R.def.id, epoch: (st?.epoch ?? 0) + 1, lastRenew: nowMs(), rejoin: true,
      timer: null, running: null, ticking: false, tries: 0, left: false,
    };
    if (st && (merged || R.ids.has(st.round))) linkMerged(st, next);
    mine.set(dealId, next);
    await renew(dealId, R);
    const timer = setInterval(() => void tick(dealId), T.watch); (timer as { unref?: () => void }).unref?.(); mine.get(dealId)!.timer = timer;
  }
  /**
   * A batch still out in a round merged into another writes there (#795), unless this PC slept first: then that is a
   * new epoch, as `renew` would make it, and the batch is stale.
   */
  function linkMerged(st: Mine, next: Mine) {
    if (nowMs() - st.lastRenew > T.lapse) st.epoch++;
    st.merged = { st: next, epoch: next.epoch };
  }
  function stopWatch(dealId: string) { const st = mine.get(dealId); if (st?.timer) clearInterval(st.timer); mine.delete(dealId); }
  /** This PC's share of a round: batch after batch of what it owns, until it owns nothing undone. Runs in the deal's lane. */
  async function share(dealId: string, roundId: string): Promise<'done' | 'ended' | 'out'> {
    return withSignInCap(T.giveUp, () => shareRun(dealId, roundId));   // signed out mid-check: fail and let go of the pieces, not hold them
  }
  async function shareRun(dealId: string, roundId: string): Promise<'done' | 'ended' | 'out'> {
    let x: Ctx | undefined; let xFor = -1;                                       // opened once a run, again when the round's pieces change (a merge)
    for (;;) {
      const { v, ob, touch } = await look(dealId); const R = v.rounds.get(roundId); if (!R || R.end) return 'ended';
      const st = mine.get(dealId); if (!st || st.round !== roundId || st.left) return 'ended';
      if (st.rejoin) await renew(dealId, R);
      if (!touch && outTooLong() && othersIn(dealId, R, ob)) return 'out';
      const { facts, todo, owners } = myWork(dealId, v, R, ob);
      if (!todo.length) { await finishIfDone(dealId, v, R); return 'done'; }
      const ts = pickBatch(R, todo, facts, owners.length); const units = [...new Set(ts.map((t) => `${R.def.id}:${t.u}`))];
      await claim(dealId, units);
      const epoch = st.epoch;
      const takenAt = nowMs();
      try {
        if (!x || xFor !== R.pieces.length) { const c = await open(dealId, R); if (!c.ok) throw Object.assign(new Error(c.error.message), { kind: c.error.kind, code: c.error.kind === 'unreachable' ? 'unreachable' : undefined }); x = c.value; xFor = R.pieces.length; }
        guards.set(dealId, () => guard(dealId, st, epoch, takenAt));
        await runBatch(dealId, R, ts, x, facts);
        serviceAnswered(st);
      } catch (e) { if (e !== STALE) throw e; }
      finally { guards.delete(dealId); await release(dealId, units).catch(() => undefined); }
    }
  }
  /**
   * A share that failed (most often, the model service cannot be reached). For the first two minutes it is tried again
   * soon: five seconds after the first failure, twice as long after each. Then the person's request ends, saying the
   * check will carry on by itself, and it is tried again every five minutes for as long as the app is open. The PC
   * stays in the round: if others are in it, they take its pieces once it has shown no work for a lapse. A batch that
   * failed for want of a sign-in has already kept the person waiting the whole two minutes (`withSignInCap`), so that
   * wait counts: the request ends now rather than after two minutes more.
   */
  async function failedShare(_dealId: string, st: Mine, e?: unknown) {
    const now = nowMs(); st.tries++; st.signedOut = signedOutErr(e); st.failingSince ??= st.signedOut ? now - T.giveUp : now;
    st.nextTry = now - st.failingSince < T.giveUp ? Math.min(now + Math.min(T.retryFirst * 2 ** (st.tries - 1), T.retryMax), st.failingSince + T.giveUp) : now + T.retryEvery;
    // signed out with no other PC working the round: try again soon rather than after the long wait, backing off from five seconds to
    // a minute, so the check carries on soon after someone signs in, as the line says. A try mostly waits on the sign-in, up to
    // the cap; once single sign-on has given up it fails at once, and the backoff keeps its claim lines in the shared log to one pair a
    // minute. With others in the round it keeps the long wait, so its pieces stay unclaimed long enough for them to take over.
    if (st.signedOut) { try { const { v, ob } = await look(_dealId); const R = v.rounds.get(st.round); if (R && !R.end && !othersIn(_dealId, R, ob)) st.nextTry = now + Math.min(T.retryFirst * 2 ** (st.tries - 1), T.retryMax); } catch { /* the long wait stands */ } }
  }
  /** while the person is still kept waiting: until when; after that, nothing (the check carries on by itself) */
  const retryUntil = (st: Mine) => (st.failingSince !== undefined && nowMs() - st.failingSince < T.giveUp ? new Date(st.failingSince + T.giveUp).toISOString() : undefined);
  const awayLong = (st: Mine | undefined) => !!st && st.failingSince !== undefined && nowMs() - st.failingSince >= T.giveUp;
  /**
   * The model service answered: the outage, if there was one, is over. Said after each batch, not only once the whole
   * share is done, so a long share that resumed after a short outage is not later reported as out of reach (#131).
   */
  function serviceAnswered(st: Mine) {
    st.tries = 0;
    st.failingSince = undefined;
    st.nextTry = undefined;
    st.signedOut = false;
  }
  function runShare(dealId: string, st: Mine, kind: RoundKind) {
    if (st.running) return st.running;
    const go = inLane(dealId, () => logged(kind === 'first' ? 'firstPass' : 'checkAll', dealId, () => share(dealId, st.round)))
      .then(() => serviceAnswered(st), (e) => failedShare(dealId, st, e));
    st.running = go.finally(() => { st.running = null; });
    return st.running;
  }
  /** The watcher: every few seconds, outside the lane. */
  async function tick(dealId: string) {
    const st = mine.get(dealId); if (!st || st.ticking) return; st.ticking = true;
    try {
      const { v, ob, touch } = await look(dealId); const R = v.rounds.get(st.round); if (!R) return;
      if (R.end?.kind === 'merged') {
        const W = v.rounds.get(R.end.into);
        if (W && !W.end) await join(dealId, W, true);
        else stopWatch(dealId);
        return;
      }
      if (R.end) { stopWatch(dealId); afterEnd(dealId, v, R, ob); return; }
      if (st.left) { if (!othersIn(dealId, R, ob)) await say(dealId, { abandoned: { round: R.def.id } }); stopWatch(dealId); return; }
      if (st.rejoin || nowMs() - st.lastRenew >= T.renew) await renew(dealId, R);
      // two rounds of the same kind open at once: the lower id is kept, and this one is merged into it, its own pieces with it
      const W = openRounds(v).find((y) => y !== R && y.def.kind === R.def.kind && y.def.id < R.def.id);
      if (W && (R.def.by === me || !ob.live(R.def.by, T.lapse))) {
        const extra = R.pieces.filter((p) => !W.pieces.some((q) => q.key === p.key));
        await say(dealId, { merged: { round: R.def.id, into: W.def.id, extra } });
        await join(dealId, W, true);
        return;
      }
      // a round no member that holds its documents can work, for a lapse, is abandoned
      if (!ownersIn(dealId, R, ob).length) { st.noOwnerSince ??= nowMs(); if (nowMs() - st.noOwnerSince >= T.lapse) { await say(dealId, { abandoned: { round: R.def.id } }); stopWatch(dealId); } return; }
      st.noOwnerSince = undefined;
      if (await finishIfDone(dealId, v, R)) return;
      if (st.running || (st.nextTry && nowMs() < st.nextTry) || (!touch && outTooLong())) return;
      if (myWork(dealId, v, R, ob).todo.length) void runShare(dealId, st, R.def.kind);
    } catch { /* the next tick tries again */ }
    finally { st.ticking = false; }
  }
  /**
   * The round is finished when every piece is done. Whoever sees that first reads the log again and writes `done`
   * (and `full` when everything was checked), and hears the responses if the round raised findings. Two PCs may both
   * write it; both say the same. True when the round has ended.
   */
  async function finishIfDone(dealId: string, v: View, R: RoundState): Promise<boolean> {
    if (R.end) return true; if (undone(R, factsOf(v, R)).length) return false;
    const v2 = view(await lines(dealId)); const R2 = v2.rounds.get(R.def.id); if (!R2 || R2.end) return true;
    const facts = factsOf(v2, R2); if (undone(R2, facts).length) return false;
    const c = await open(dealId, R2); if (!c.ok) return false; const x = c.value; const t = tally(dealId, R2, facts);
    await say(dealId, { done: { items: x.list.map((it) => it.id), docs: R2.def.docList, round: R2.def.id, unchecked: t.unchecked } });
    // a folder in the data room that no PC could open has never been read: a check is not of everything while there is one
    const full: FullCheck | undefined = o.docs.unread?.(dealId).length ? undefined : R2.def.kind === 'first' ? (!x.everChecked && x.list.length && !x.unsettled().length ? { mode: 'first', items: x.list.length, findings: x.findings.length } : undefined)
      : t.unchecked.items || t.unchecked.findings ? undefined
      : R2.def.kind === 'rest' ? completes(dealId, v2, R2)
      : { mode: R2.def.kind, items: t.items, findings: t.findings, ...(t.sample ? { sample: t.sample } : {}) };
    const at = finishedAt(v2, R2); if (full) await say(dealId, { full: { ...full, round: R2.def.id, ...(at ? { done: at } : {}) } });
    if (t.raised.length) later(() => entries.responses(dealId));               // a finding raised now may already be answered by a response given earlier
    reportsSoon(dealId);                       // every issue an outside advisor raises is a finding
    return true;
  }
  /**
   * A check of what was left out that left nothing out completes the check it followed: together they checked
   * everything, as long as the documents are the same, so the date moves as it would have then, with that check's
   * counts and spot check.
   */
  function completes(dealId: string, v: View, R: RoundState): FullCheck | undefined {
    let S: RoundState | undefined = R; for (let i = 0; S?.def.kind === 'rest' && i < 50; i++) S = S.def.of ? v.rounds.get(S.def.of) : undefined;
    if (!S || S.def.kind === 'first' || S.def.kind === 'rest' || S.def.docs !== R.def.docs) return undefined;
    const t = tally(dealId, S, factsOf(v, S)); return { mode: S.def.kind, items: t.items, findings: t.findings, ...(t.sample ? { sample: t.sample } : {}) };
  }
  /** what a round came to, from its lines */
  function tally(dealId: string, R: RoundState, facts: Map<string, PieceFacts>) {
    const items = R.pieces.filter(isItem); const fs = R.pieces.filter((p) => !isItem(p)); let size = 0, overturned = 0, unread = 0;
    for (const p of items) { const s = facts.get(p.key)?.sample?.sample; if (!s) continue; size++; if (!s.after || s.after === 'unsettled') unread++; else if (s.after !== s.before) overturned++; }
    if (R.def.kind === 'quick') for (const p of fs) { const x = facts.get(p.key); if (x?.fast?.stands !== true || !x.standard) continue; size++; if (x.standard.stands === null) unread++; else if (x.standard.marked) overturned++; }
    const raised = items.filter((p) => { const l = facts.get(p.key)?.result; return l?.result === 'finding' && l.finding === findingIdFor(dealId, R.def.docs, itemOf(p)); });
    return {
      items: items.length, findings: fs.length, raised,
      unchecked: { items: items.filter((p) => facts.get(p.key)?.result?.result === 'unsettled').length, findings: fs.filter((p) => facts.get(p.key)?.standard?.stands === null).length },
      marks: (R.def.marked ?? []).length + fs.filter((p) => facts.get(p.key)?.standard?.marked).length,
      sample: R.def.kind === 'quick' ? { size: size - unread, overturned } : null,
    };
  }
  /**
   * The latest check (quick, deep, or of what was left out) that got to the end, and what it left out that is still
   * not settled: its items whose latest outcome is unsettled, and its findings no model gave a usable answer on. Read
   * from the lines alone, so it costs no model call.
   */
  function leftOf(v: View, latest: Map<string, CheckLine>) {
    const L = [...v.rounds.values()].filter((r) => r.def.kind !== 'first' && r.end?.kind === 'done').sort((a, b) => b.n - a.n)[0]; if (!L) return null;
    const facts = factsOf(v, L);
    return { round: L, items: L.pieces.filter((p) => isItem(p) && latest.get(itemOf(p))?.result === 'unsettled'), findings: L.pieces.filter((p) => !isItem(p) && facts.get(p.key)?.standard?.stands === null) };
  }
  /** What a person who asked is told when the round has ended. */
  function summaryOf(dealId: string, v: View, R: RoundState): CheckSummary {
    // two PCs may both write `full` for a round: the one that counts is the same on every PC, as for any line written twice
    const t = tally(dealId, R, factsOf(v, R)); const full = (v.lines as CheckLine[]).filter((l) => l.full && l.full.round && R.ids.has(l.full.round)).reduce<CheckLine | undefined>((a, l) => (!a || (l.pc ?? '') < (a.pc ?? '') ? l : a), undefined);
    const kind = R.def.kind === 'deep' ? 'deep' : 'quick';
    const unread = full ? [] : o.docs.unread?.(dealId) ?? [];                      // what kept it from being complete, when that was a closed folder
    return { at: full ? full.full?.done ?? full.at : null, items: t.items, findings: t.findings, toReassess: t.marks, newFindings: t.raised.length, sample: t.sample, offerDeep: !!deeper({ mode: kind, items: t.items, findings: t.findings, ...(t.sample ? { sample: t.sample } : {}) }), unchecked: t.unchecked, ...(unread.length ? { unread } : {}) };
  }
  /** after a round ends: documents this PC has that the round did not cover get a first pass of their own; a check someone wanted whose PC has gone is started */
  function afterEnd(dealId: string, v: View, R: RoundState, ob: Observer) {
    if (R.end?.kind === 'done' && o.docs.records(dealId).some((r) => !R.def.docList.includes(r.docId))) later(() => entries.firstPass(dealId));
    for (const w of v.wanted) if (w.by !== me && !ob.live(w.by, T.lapse) && !met(v, w)) { later(() => request(dealId, w.kind === 'deep' || w.kind === 'rest' ? w.kind : 'quick')); break; }
  }
  /** a `wanted` is met by a round of a kind that serves it, started after it was written */
  const met = (v: View, w: View['wanted'][number]) => [...v.rounds.values()].some((r) => r.n > w.n && serves(r.def.kind, w.kind));
  /** a live opening or open round of the same kind as `id`'s, with a lower id: the one to join instead */
  const rivalOf = (dealId: string, v: View, ob: Observer, kind: RoundKind, id: string, known: Set<string>) => {
    for (const R of openRounds(v)) if (R.def.kind === kind && R.def.id < id && liveIn(dealId, R, ob).length) return R.def.id;
    for (const [oid, op] of v.openings) if (!op.ended && !v.rounds.has(oid) && op.kind === kind && oid < id && op.by !== me && ob.live(op.by, T.lapse)) return oid;
    // one opened by another PC at the same time as this one, already ended by its round line or its `done`: it did what this one is preparing to do
    for (const [oid, op] of v.openings) if (!known.has(oid) && op.kind === kind && oid < id && op.by !== me && (v.rounds.has(oid) || v.lines.some((l) => l.done?.opening === oid))) return oid;
    return undefined;
  };
  /** what a round of `kind` would work, from how things stand now; the marks that need no model are made here */
  async function prepare(dealId: string, kind: RoundKind, x: Ctx, marked: string[]): Promise<Piece[]> {
    await payOwed(dealId, marked); await markReworded(x, marked);
    const item = (it: ChecklistItem, stage: Piece['stage'], reason: string): Piece => ({ key: `item:${it.id}`, text: it.text, reason, stage });
    if (kind === 'first') {
      if (!x.recs.length || (!x.list.length && !x.findings.length)) return [];
      const must = x.list.filter((it) => x.why(it) === 'new'); let revisit: ChecklistItem[] = []; let look: { f: Raised; also: DocRecord[] }[] = [];
      if (x.first) revisit = x.list.filter(x.stale);                                                      // an earlier run stopped part-way, and the documents have changed since
      else {
        // a finding whose document has gone: no model is needed to see that
        for (const f of x.findings) if (f.sources.some((src) => src.docId && !x.current.has(src.docId)) && await mark(f.id, 'A document it cites is no longer in the data room')) marked.push(f.id);
        revisit = x.list.filter((it) => x.why(it) === 'gone');
        if (x.fresh.length) {
          const settledItems = x.list.filter((it) => !x.owned(it) && x.why(it) !== 'new' && !!x.latest.get(it.id)); const open = x.findings.filter((f) => !marked.includes(f.id));
          const hit = await affects(x.fresh, [...open, ...x.closed], settledItems);
          const nearTo = (f: Raised) => { const q = words(`${f.title} ${f.body.join(' ')}`, dealId); return x.fresh.map((r) => ({ r, n: score(r, q, dealId) })).sort((a, b) => b.n - a.n); };
          revisit = [...revisit, ...(hit ? [...hit.items].map((id) => settledItems.find((it) => it.id === id)!) : x.list.filter((it) => x.why(it) === 'word'))].filter((it, i, all) => all.indexOf(it) === i);
          // each finding with the arrivals named beside it. Where the model named the finding and no arrival, the arrivals that words cannot place
          // (a scan has none) come first, then the nearest in words; where it could not say at all, the nearest in words
          const blind = x.fresh.filter((r) => !r.words?.length && !r.summary);
          look = hit ? [...hit.findings].map(([id, by]) => { const f = [...open, ...x.closed].find((y) => y.id === id)!; return { f, also: (by.length ? by : [...blind, ...nearTo(f).map((y) => y.r).filter((r) => !blind.includes(r))]).slice(0, 3) }; })
            : open.filter((f) => nearTo(f).some((y) => y.n > 0)).map((f) => ({ f, also: nearTo(f).slice(0, 3).map((y) => y.r) }));
        }
      }
      return [...must.map((it) => item(it, 'check', x.why(it) ?? 'new')), ...revisit.filter((it) => !must.includes(it)).map((it) => item(it, 'revisit', x.why(it) ?? 'touched')), ...look.map(({ f, also }) => ({ key: `finding:${f.id}`, also: also.map((r) => r.docId) }))];
    }
    if (kind === 'rest') {
      // only what the latest check left out, and only while the documents are the ones it checked
      const lo = leftOf(view(await lines(dealId)), x.latest); if (!lo || lo.round.def.docs !== docsHash(x.here)) return [];
      const open = new Set([...x.findings, ...x.closed].map((f) => f.id));
      const its = lo.items.map((p) => x.list.find((it) => it.id === itemOf(p))).filter((it): it is ChecklistItem => !!it && !x.owned(it));
      return [...its.map((it) => item(it, 'check', 'left out')), ...lo.findings.filter((p) => open.has(findingOf(p))).map((p) => ({ key: p.key }))];
    }
    const items = x.list.filter((it) => !x.owned(it)); const findings = [...x.findings, ...x.closed].map((f) => ({ key: `finding:${f.id}` }));   // closed findings are checked too
    if (kind === 'deep') return [...items.map((it) => item(it, 'check', 'deep')), ...findings];
    const there = new Set(x.here); const settled = (it: ChecklistItem) => { const l = x.latest.get(it.id); return !!l && l.text === it.text && (l.result === 'ok' || l.result === 'gap') && !unmoored(l, (d) => there.has(d)); };
    return [...items.map((it) => (settled(it) ? item(it, 'glance', 'settled') : item(it, 'check', 'unsettled'))), ...findings];
  }
  /**
   * Start a round: `opening`, the preparation, then the round line. A round of the same kind that another PC opened
   * meanwhile with a lower id is joined instead (`yielded`); with nothing to work and no mark made, the opening ends
   * with today's `done` line, so the arrivals are recorded and a PC waiting on it goes on at once (`empty`).
   */
  async function begin(dealId: string, kind: RoundKind, given?: { x: Ctx; n: number }): Promise<{ round?: string; yielded?: string; empty?: true; mine?: boolean; busy?: true }> {
    // taking its turn in the lane, it looks once more: a round or an opening that appeared meanwhile is for the caller to join or wait on
    let known: Set<string>;                                                        // the openings this PC had seen when it began: any other is one opened at the same time
    { const { v, ob } = await look(dealId); await buryDead(dealId, v, ob); if (openRounds(v).some((r) => !r.end) || liveOpening(v)) return { busy: true }; known = new Set(v.openings.keys()); }
    if (given && (seen.get(dealId) ?? 0) !== given.n) given = undefined;          // the state read earlier is used only if nothing has been written since
    // a first pass with nothing to do (no document has arrived, no item is new or touched, nothing is owed) writes nothing at all
    if (kind === 'first') {
      const c0 = given ? ok(given.x) : await open(dealId); if (c0.ok) { const x = c0.value; given = { x, n: seen.get(dealId) ?? 0 };
        const quiet = !x.fresh.length && !x.list.some((it) => { const w = x.why(it); return w === 'new' || w === 'gone'; }) && !(x.first && x.list.some(x.stale)) && !x.reworded().length && !x.findings.some((f) => f.sources.some((src) => src.docId && !x.current.has(src.docId))) && !owedOf(await lines(dealId)).length;
        if (quiet) return { empty: true }; } }
    const id = `r_${ulid()}_${me}`; preparing.add(id);                 // with this PC's id, so two PCs never open rounds of the same id
    await say(dealId, { opening: { id, kind, by: me, ...whoAmI() } });
    const timer = setInterval(() => void say(dealId, { opening: { id, kind, by: me, ...whoAmI() } }).catch(() => undefined), T.renew); (timer as { unref?: () => void }).unref?.();
    try {
      const c = given ? ok(given.x) : await open(dealId); if (!c.ok) throw Object.assign(new Error(c.error.message), { code: c.error.kind === 'unreachable' ? 'unreachable' : undefined, kind: c.error.kind });
      const x = c.value; const marked: string[] = [];
      const pieces = await prepare(dealId, kind, x, marked);
      const core = pieces.length ? await coreOf(dealId) : []; if (pieces.length) await described(dealId);
      const { v, ob } = await look(dealId);
      const rival = rivalOf(dealId, v, ob, kind, id, known);
      if (rival) { await say(dealId, { merged: { round: id, into: rival, extra: [] } }); return { yielded: rival, mine: pieces.length > 0 }; }
      if (!pieces.length && !marked.length) { await say(dealId, { done: { items: x.list.map((it) => it.id), docs: x.here, opening: id } }); return { empty: true }; }
      const of = kind === 'rest' ? leftOf(v, x.latest)?.round.def.id : undefined;
      const def: RoundDef = { id, kind, by: me, ...whoAmI(), docs: docsHash(x.here), docList: x.here, core: { key: docsHash(core), ids: core }, block: batch, pieces, ...(marked.length ? { marked } : {}), ...(of ? { of } : {}) };
      await say(dealId, { plan: def });
      const made = (await look(dealId)).v.rounds.get(id); if (made) await join(dealId, made);   // a member at once, so no PC (this one included) takes the round for one nobody is in
      return { round: id };
    } catch (e) { await say(dealId, { abandoned: { round: id } }).catch(() => undefined); throw e; }
    finally { clearInterval(timer); preparing.delete(id); }
  }
  /** the result of a first pass, from the log as it stands: what this call wrote (lines after `since`), and the gaps and unsettled items as they are */
  async function passResult(dealId: string, R: RoundState | undefined, elsewhere?: string, since = 0) {
    const all = await lines(dealId); const { latest, done } = await outcomes(dealId, all); const ids = R?.ids ?? new Set<string>();
    const ours = all.filter((l) => (l.n ?? 0) > since && l.pc === me);
    const written = [...new Set(ours.flatMap((l) => (l.item && l.result === 'finding' && l.finding && l.round && ids.has(l.round) && l.finding === findingIdFor(dealId, R!.def.docs, l.item) ? [l.finding] : [])))];
    const marked = [...new Set([...ours.flatMap((l) => (l.plan && ids.has(l.plan.id) ? l.plan.marked ?? [] : [])), ...ours.flatMap((l) => (l.verified && ids.has(l.verified.round) ? l.verified.findings.filter((x) => x.marked).map((x) => x.finding) : []))])];
    const list = done ?? [...latest.keys()];
    return ok({ written, gaps: gapsOf(latest, done), unsettled: list.filter((id) => latest.get(id)?.result === 'unsettled'), marked, ...(elsewhere ? { elsewhere } : {}) });
  }
  /** what an earlier round of the same first-pass call wrote */
  type Earlier = { written: string[]; marked: string[]; elsewhere?: string };
  type PassResult = Awaited<ReturnType<typeof passResult>>;
  /** keeps what a round joined and finished in a first-pass call wrote, for the pass that follows */
  function keepEarlier(earlier: Earlier, outcome: PassResult, elsewhere: string | undefined) {
    if (!outcome.ok) return;
    earlier.written.push(...outcome.value.written);
    earlier.marked.push(...outcome.value.marked);
    earlier.elsewhere ??= elsewhere;
  }
  /** a first pass's result with what an earlier round of the same call wrote added to it */
  function withEarlier(outcome: PassResult, earlier: Earlier): PassResult {
    if (!outcome.ok) return outcome;
    const written = [...new Set([...earlier.written, ...outcome.value.written])];
    const marked = [...new Set([...earlier.marked, ...outcome.value.marked])];
    return ok({ ...outcome.value, written, marked });
  }
  /** whether a round this PC joined is done while this PC holds documents it did not cover */
  async function doneShort(dealId: string, R: RoundState) {
    const more = o.docs.records(dealId).some((r) => !R.def.docList.includes(r.docId));
    if (!more) return false;
    const { v } = await look(dealId);
    return v.rounds.get(R.def.id)?.end?.kind === 'done';
  }
  /**
   * The first pass, run when a deal's folders finish indexing (see the comment on `extras.firstPass` for what it checks).
   * It joins a round that is open, of any kind, writing `due` if this PC has documents the round does not cover; or it
   * starts one. It returns when this PC's share is done; the round's results show as the lines arrive. A round it
   * joined that is done by then, over fewer documents than this PC has, is followed by a first pass over the rest in
   * the same call, so the new documents are not left to the watcher, which a close would lose
   */
  async function pass(dealId: string) {
    indexed.add(dealId);
    return logged('firstPass', dealId, async () => {
      const c0 = await open(dealId); if (!c0.ok) return c0; const n0 = seen.get(dealId) ?? 0; if (!c0.value.recs.length || (!c0.value.list.length && !c0.value.findings.length)) return ok({ written: [] as string[], gaps: [] as { title: string }[], unsettled: [] as string[], marked: [] as string[] });
      let first = true;                                                          // the state read at the start is used to prepare, unless the pass has had to wait
      await lines(dealId); const since = seen.get(dealId) ?? 0;                    // this call's lines come after this
      // what a round joined and finished in this call wrote, added to the result of the pass that follows it
      const before: Earlier = { written: [], marked: [] };
      const result = async (R: RoundState | undefined, elsewhere?: string) => {
        const outcome = await passResult(dealId, R, elsewhere ?? before.elsewhere, since);
        return withEarlier(outcome, before);
      };
      return withList(dealId, c0.value.list, async () => { for (;;) {
        // A round nobody else is working is taken over, whoever started it, when this PC holds its documents: the same
        // rule as the look over deals (`holds`), so a round this PC took over in the background, or is running
        // itself, is not written off here
        const resume = (R: RoundState) => holds(dealId, R);
        const { v, ob } = await look(dealId); await buryDead(dealId, v, ob, resume);
        let R = openRounds(v).find((r) => !r.end);
        if (R && !liveIn(dealId, R, ob).some((pc) => pc !== me) && !resume(R)) { await say(dealId, { abandoned: { round: R.def.id } }); if (mine.get(dealId)?.round === R.def.id) stopWatch(dealId); R = undefined; }
        if (R) {
          await join(dealId, R);
          const mineNow = o.docs.records(dealId).map((r) => r.docId); if (mineNow.some((id) => !R.def.docList.includes(id))) await say(dealId, { due: { round: R.def.id, by: me, docs: docsHash(mineNow) } });
          const st = mine.get(dealId)!; try { await inLane(dealId, () => share(dealId, R.def.id)); } catch (e) { await failedShare(dealId, st, e); if (signedOutErr(e)) return fail({ kind: 'rejected', message: SIGNED_OUT }); if (unreachable(e)) return failure(e, ''); }
          const elsewhere = R.def.by !== me ? R.def.label ?? 'another PC' : undefined;
          if (await doneShort(dealId, R)) {
            keepEarlier(before, await passResult(dealId, R, elsewhere, since), elsewhere);
            continue;                                    // and a first pass over the documents it did not cover
          }
          return result(R, elsewhere);
        }
        if (liveOpening(v)) { await sleep(poll); continue; }
        let b: Awaited<ReturnType<typeof begin>>;
        try { b = await inLane(dealId, async () => begin(dealId, 'first', first ? (first = false, { x: c0.value, n: n0 }) : undefined)); } catch (e) { return unreachable(e) ? failure(e, '') : fail({ kind: 'failed', message: 'The first pass could not finish: the checklist results could not be saved' }); }
        if (b.empty) return result(undefined);
        if (b.yielded || b.busy) continue;
        const R2 = (await look(dealId)).v.rounds.get(b.round!)!;
        const st = mine.get(dealId)!; try { await inLane(dealId, () => share(dealId, R2.def.id)); } catch (e) { await failedShare(dealId, st, e); if (signedOutErr(e)) return fail({ kind: 'rejected', message: SIGNED_OUT }); if (unreachable(e)) return failure(e, ''); }
        return result(R2);
      } });
    });
  }
  /**
   * Loose ends on the deals this PC has, while the app is open: a checklist round that every PC in it has left or
   * gone quiet on (for a lapse, by this PC's clock), and an opening whose PC has gone quiet. This PC takes such a round
   * over and finishes it, whoever started it, when it holds every document the round was set up on (it may hold more),
   * once it has indexed the deal; when it does not hold them (`holds`), the round is written off, and a first pass is
   * started afresh, which skips whatever is already settled. A check of everything nobody is waiting for any more is
   * not started again. Reading the log costs no model call; a PC with nothing to pick up does nothing else.
   */
  let looking = false;
  /** deals this PC has indexed: a first pass runs once a deal's folders are indexed, so these are the deals it has run for */
  const indexed = new Set<string>();
  async function looseEnds() {
    if (looking || outTooLong()) return; looking = true;
    try {
      for (const dealId of await dealIds()) {
        // once a run of the app, each deal's reports are swept
        if (!o.docs.indexing?.(dealId) && o.docs.records(dealId).length) reportSweeps.once(dealId);
        if (mine.has(dealId)) continue;                                            // in a round already: its own watcher looks after it
        const { v, ob } = await look(dealId);
        const ready = indexed.has(dealId) && !o.docs.indexing?.(dealId);              // not while indexing: the documents may be known, but not yet searchable here
        for (const R of openRounds(v)) {
          if (liveIn(dealId, R, ob).length) continue;                              // someone is on it
          if (holds(dealId, R) && !ready) continue;      // taken over once this PC has indexed the deal
          // any PC with the deal finishes it, when it holds every document the round was set up on: what it has besides
          // is noted as `due`, as for a PC that joins part-way, and a first pass follows it once the round is done (`afterEnd`)
          if (holds(dealId, R)) {
            const here = o.docs.records(dealId).map((r) => r.docId); await join(dealId, R); const more = here.some((id) => !R.def.docList.includes(id));
            if (more) await say(dealId, { due: { round: R.def.id, by: me, docs: docsHash(here) } });
            const st = mine.get(dealId); if (st) void runShare(dealId, st, R.def.kind);
            break;
          }
          await say(dealId, { abandoned: { round: R.def.id } }); if (R.def.kind === 'first') later(() => entries.firstPass(dealId));
        }
        for (const [id, op] of v.openings) if (!op.ended && !v.rounds.has(id) && op.by !== me && !ob.live(op.by, T.lapse)) { await say(dealId, { abandoned: { round: id } }); if (op.kind === 'first') later(() => entries.firstPass(dealId)); }
      }
    } catch { /* looked at again next time */ }
    finally { looking = false; }
  }
  let watchAll: ReturnType<typeof setInterval> | null = null;
  /** a note, kept on this PC, of a request that ended while it was out of touch: how it ended is told once back in touch */
  const noteName = (dealId: string) => `ended-${dealId}.json`;
  const waitingOn = new Map<string, Someone>();                                  // deals where this PC's check waits behind another PC's round: who is running it
  const notes = new Map<string, string>();                                       // where the notes are kept when this PC has no local folder (tests)
  const keepNote = (dealId: string, n: { round?: string; wanted?: string; kind: RoundKind }) => { try { if (o.local) o.local.write(noteName(dealId), JSON.stringify(n)); else notes.set(dealId, JSON.stringify(n)); } catch { /* best effort */ } };
  /**
   * A person's check of everything. It joins an open round that serves it; behind a round of another kind it writes
   * `wanted` and waits; otherwise it starts one. Then this PC works its share, and the request waits, outside the lane,
   * for the round to end: `done` gives the summary, `merged` is followed, `abandoned` says the check could not finish.
   */
  async function request(dealId: string, kind: 'quick' | 'deep' | 'rest', restarts = 0): Promise<Result<CheckSummary>> {
    const mark = { stalled: false }; const r = await checkOnce(dealId, kind, mark);
    // a round that stalled under a check the person is still waiting on carries on by itself, as the first pass does, rather than
    // ending "could not finish" for the person to press again, by the same rule as the first pass; twice at most, so a check that cannot finish ends
    // it is asked again as it was asked: "the rest" stays the rest, and is refused as usual if the documents have changed since
    if (!r.ok && mark.stalled && restarts < 2) return request(dealId, kind, restarts + 1);
    return r;
  }
  /** `mark.stalled` is set when the request ends because its round was written off, one mark per request */
  async function checkOnce(dealId: string, kind: 'quick' | 'deep' | 'rest', mark: { stalled: boolean }): Promise<Result<CheckSummary>> {
    return logged('checkAll', dealId, async () => {
      const c = await open(dealId); if (!c.ok) return c; const x = c.value; const n0 = seen.get(dealId) ?? 0;
      if (!x.recs.length) return fail({ kind: 'rejected', message: 'No documents have been indexed for this deal yet' });
      if (!x.list.filter((it) => !x.owned(it)).length && !x.findings.length) return fail({ kind: 'rejected', message: 'There is nothing to check yet: this deal has no checklist items and no open findings' });
      if (kind === 'rest') {
        const lo = leftOf(view(await lines(dealId)), x.latest);
        if (!lo || (!lo.items.length && !lo.findings.length)) return fail({ kind: 'rejected', message: 'The last check left nothing out' });
        if (lo.round.def.docs !== docsHash(x.here)) return fail({ kind: 'rejected', message: 'The documents have changed since the last check. Press Check again to check everything' });
      }
      return withList(dealId, x.list, async () => {
      let want: string | undefined; let roundId: string | undefined; let first = true;
      for (;;) {
        if (want && outTooLong()) { waitingOn.delete(dealId); keepNote(dealId, { wanted: want, kind }); return fail({ kind: 'rejected', message: NOT_STARTED }); }
        const { v, ob } = await look(dealId); await buryDead(dealId, v, ob, (R) => serves(R.def.kind, kind) && holds(dealId, R));   // a left round that does what was asked is finished, not paid for again
        const R = openRounds(v).find((r) => !r.end);
        if (R && serves(R.def.kind, kind)) { waitingOn.delete(dealId); roundId = R.def.id; await join(dealId, R); break; }
        if (R || liveOpening(v)) { { const by = R ? { who: R.def.who, label: R.def.label } : { who: liveOpening(v)?.[1].who, label: liveOpening(v)?.[1].label }; waitingOn.set(dealId, someone(by, [whoAmI().who, by.who])); } if (!want) { want = `w_${ulid()}_${me}`; await say(dealId, { wanted: { id: want, kind, by: me, ...whoAmI() } }); } await sleep(poll); continue; }
        let b: Awaited<ReturnType<typeof begin>>;
        waitingOn.delete(dealId);
        try { b = await inLane(dealId, async () => begin(dealId, kind, first ? (first = false, { x, n: n0 }) : undefined)); } catch (e) { return unreachable(e) ? failure(e, '') : fail({ kind: 'failed', message: COULD_NOT }); }
        if (b.round) { roundId = b.round; break; }
        // yielded to another PC's round of the same kind, or (with no piece at all) nothing to do: look again
        if (b.empty) return fail({ kind: 'rejected', message: 'There is nothing to check yet: this deal has no checklist items and no open findings' });
      }
      const st = mine.get(dealId)!; try { await inLane(dealId, () => share(dealId, roundId!)); } catch (e) { await failedShare(dealId, st, e); }
      return waitEnd(dealId, roundId!, kind, mark);
      });
    });
  }
  async function waitEnd(dealId: string, roundId: string, kind: RoundKind, mark?: { stalled: boolean }): Promise<Result<CheckSummary>> {
    let id = roundId;
    for (;;) {
      const { v, ob } = await look(dealId); const R = v.rounds.get(id);
      if (R?.end?.kind === 'merged') { id = R.end.into; continue; }
      if (R?.end?.kind === 'done') return ok(summaryOf(dealId, v, R));
      if (!R || R.end?.kind === 'abandoned') { if (mark) mark.stalled = true; return fail({ kind: 'failed', message: COULD_NOT }); }
      const st = mine.get(dealId);
      if (st?.left && st.round === id) { if (!othersIn(dealId, R, ob)) await say(dealId, { abandoned: { round: id } }); return fail({ kind: 'failed', message: COULD_NOT }); }
      // the model service has been out of reach for two minutes: the person is not kept waiting; the check carries on by itself, and how it ended is told then
      if (st && st.round === id && awayLong(st)) { keepNote(dealId, { round: id, kind }); return fail({ kind: 'rejected', message: st.signedOut ? SIGNED_OUT : SERVICE_AWAY }); }
      if (outTooLong() && othersIn(dealId, R, ob)) { keepNote(dealId, { round: id, kind }); return fail({ kind: 'rejected', message: NOT_SYNCING }); }
      if (!st || st.round !== id) await join(dealId, R);
      await sleep(poll);
    }
  }
  /** How a request that ended out of touch came out, once this PC is back in touch; told once. */
  async function endedNote(dealId: string): Promise<CheckState['ended']> {
    let n: { round?: string; wanted?: string; kind: RoundKind } | null = null; try { const t = o.local ? o.local.read(noteName(dealId)) : notes.get(dealId); n = t ? JSON.parse(t) : null; } catch { n = null; }
    if (!n || !(await inTouch())) return undefined;
    const v = view(await lines(dealId)); let id = n.round;
    if (n.wanted) { const w = v.wanted.find((y) => y.id === n!.wanted); const R = w ? [...v.rounds.values()].filter((r) => r.n > w.n && serves(r.def.kind, w.kind)).sort((a, b) => a.n - b.n)[0] : undefined; id = R?.def.id; }
    const forget = () => { try { if (o.local) o.local.write(noteName(dealId), ''); else notes.delete(dealId); } catch { /* told again next time */ } };
    // a check wanted while out of touch that no round has met, with none under way that could still meet it: once back in
    // touch it is started (in place of an older "told it did not start")
    if (n.wanted && !id) { if (openRounds(v).some((r) => !r.end) || liveOpening(v)) return undefined; forget(); return n.kind === 'first' ? undefined : { restart: n.kind }; }
    let R = id ? v.rounds.get(id) : undefined; while (R?.end?.kind === 'merged') R = v.rounds.get(R.end.into);
    if (!R?.end) return undefined;
    forget();
    return R.end.kind === 'done' ? { summary: summaryOf(dealId, v, R) } : { failed: COULD_NOT };
  }
  /** another PC in a round, as the person is told of it: the person at it, that PC's device id, and whether a second PC in the check (this one included) has the same person name */
  type Someone = { who?: string; pc: string; same: boolean };
  const someone = (m: { label?: string; who?: string }, names: (string | undefined)[]): Someone => ({ ...(m.who ? { who: m.who } : {}), pc: m.label ?? 'another PC', same: !!m.who && names.filter((x) => x === m.who).length > 1 });
  /** what the person is shown while a round runs: who else is in it, who went quiet and since when, and whether this PC is retrying */
  async function checkingNow(dealId: string): Promise<CheckState['checking']> {
    const st = mine.get(dealId); if (!st) return waitingOn.has(dealId) ? { with: [], quiet: [], waitingFor: waitingOn.get(dealId)! } : undefined;
    const { v, ob } = await look(dealId); const R = v.rounds.get(st.round); if (!R || R.end) return undefined;
    const others = [...R.members.entries()].filter(([pc]) => pc !== me && !R.left.has(pc)); const names = [whoAmI().who, ...others.map(([, m]) => m.who)];
    const quiet = others.filter(([pc]) => !ob.live(pc, T.lapse)).map(([pc, m]) => ({ ...someone(m, names), since: new Date(ob.quietSince(pc) ?? nowMs()).toISOString() }));
    return { with: others.filter(([pc]) => ob.live(pc, T.lapse)).map(([, m]) => someone(m, names)), quiet, ...(st.failingSince !== undefined && st.signedOut ? { signIn: true } : {}), ...(retryUntil(st) ? { retryUntil: retryUntil(st)! } : {}), ...(awayLong(st) ? { away: true } : {}) };
  }


  // every entry that can ask a model is one run in the usage log
  const dealOf = (a: unknown) => (typeof a === 'string' ? a : (a as { dealId?: string } | null | undefined)?.dealId);
  const asRun = <A, R>(run: string, go: (a: A) => Promise<R>) => (a: A): Promise<R> => logged(run, dealOf(a), () => go(a));
  const inTurn = <A, R>(go: (a: A) => Promise<R>) => (a: A): Promise<R> => inLane(dealOf(a) ?? '', () => go(a));
  /** the entries other parts of this file call as the app does: hearing responses is claimed across PCs and takes its turn in the lane */
  const entries = {
    // a first pass is also when a deal's reports are swept, so a deal already checked, or a sweep that never
    // finished, is taken up
    firstPass: (dealId: string) => pass(dealId).then((r) => { if (r.ok) reportsSoon(dealId); return r; }),
    responses: inTurn(claimed('hear', (_d: string) => ok({ heard: [], marked: [] }), asRun('responses', extras.responses))),
  };
  return {
    ...service, ...extras,
    answer: asRun('answer', service.answer), draft: asRun('draft', service.draft), reassess: asRun('reassess', service.reassess), dealBrief: asRun('dealBrief', service.dealBrief), memo: asRun('memo', service.memo!), layout: asRun('layout', service.layout!), issuesList: asRun('issuesList', service.issuesList!),
    // the first pass and the check are rounds, shared by the PCs on the deal (see `pass` and `request`); hearing responses is claimed, so no two PCs hear the same responses
    firstPass: entries.firstPass,
    checkAll: extras.checkAll,
    responses: entries.responses,
    /** wait until nothing this PC started in the background is still running (for tests and an orderly close) */
    async settled() { for (;;) { const run = [...background, ...[...mine.values()].map((m) => m.running).filter(Boolean)]; if (!run.length) return; await Promise.allSettled(run); } },
    /** Start looking out for loose ends on this PC's deals (see `looseEnds`): the shell, and the backend put together for tests, call this once the app is open. */
    watchDeals() { if (!watchAll) { watchAll = setInterval(() => void looseEnds(), T.watch); (watchAll as { unref?: () => void }).unref?.(); } },
    /** stop watching every round, and say so: the others take this PC's pieces at once. Resolves when those lines are written. */
    close(): Promise<void> {
      if (watchAll) { clearInterval(watchAll); watchAll = null; }
      reportSweeps.close();
      closing = true;                          // nothing more from a batch still out, whichever round it counts for
      clearInterval(heart);
      const said: Promise<unknown>[] = [];
      for (const [dealId, st] of [...mine]) {
        if (st.timer) clearInterval(st.timer);
        mine.delete(dealId);
        said.push(say(dealId, { left: { round: st.round, pc: me } }, true).catch(() => undefined));
      }
      return Promise.allSettled(said).then(() => undefined);
    },
    /** every call made since the app started, by what it was for and which model took it */
    usage: (): UsageLine[] => [...total.values()].map((l) => ({ ...l })),
    /** resolves when the documents of a deal that were waiting to be described have been */
    described,
  };
}
