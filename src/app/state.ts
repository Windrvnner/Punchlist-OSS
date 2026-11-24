import { distinguishingWords, type TwinFocus } from './dealLabel';
import type { Deal, Question, Finding, Tombstone, Member, Operation, DealId, QuestionId, FindingId, AuditEntry, Source, Folder, RecordKind, ClashKind } from '../domain/model';
import type { Item, ListRecord } from '../domain/checklist';
import type { CheckState, ModelThread, Research } from '../ports';
import type { PageView, SyncState, FolderSearch, FolderPlace, Seen } from '../ports';
import { control } from '../control';
import { readLogCells, holds } from '../domain/logWrite';
import type { ImportField } from '../domain/importExport';
// the one A to Z order every list a person picks from uses
import { byName, NO_WORKSTREAM, workstreamChoices } from '../domain/order';
import { addresser } from '../domain/suggest';
import { capabilities, type Capabilities } from './capabilities';

export type BootStage = 'session' | 'deals' | 'journal' | 'ready';

export interface Message { id: string; role: 'me' | 'ai'; text: string; sources?: Source[]; state: 'done' | 'pending' | 'failed'; at: string; /** files sent with this message */ attached?: { doc: string; docId: string }[]; /** what the chat agent did to find this answer */ research?: Research; /** the model service's conversation as this answer left it */ thread?: ModelThread }
/** The firm's name, which questions we ask and responses we give are stamped with: set in the control file (firm.name),
 * not in Settings. */
export const FIRM = control.firm.name;
/** `hideCols`: which Q&A columns are off. `qaOpen`: per deal, the question whose detail pane was left open (absent = the full table). `qaSeen`: see qaChanged. `landing`: the page a deal opens on. */
export interface Prefs { theme: 'system' | 'light' | 'dark'; model: string | null; hideCols: { priority: boolean; askedBy: boolean; response: boolean; status: boolean; respondedBy: boolean; responded: boolean }; qaOpen: Record<string, string>; /** per question, the Q&A log update it was last opened after: its Changed mark is seen */ qaSeen: Record<string, string>; landing: Landing; /** which sidebar groups are unfolded */ railOpen: Record<string, boolean> }
export const DEFAULT_PREFS: Prefs = { theme: 'system', model: null, hideCols: { priority: false, askedBy: false, response: false, status: false, respondedBy: true, responded: true }, qaOpen: {}, qaSeen: {}, landing: 'overview', railOpen: { live: true } };
/** The pages of a deal, in the order of its tabs. Settings offers every one of them as the page a deal opens on. */
export type Landing = 'overview' | 'findings' | 'checklist' | 'qa';
export const DEAL_PAGES: readonly [Landing, string, string][] = [['overview', 'Overview', 'overview'], ['findings', 'Findings', 'deal'], ['checklist', 'Checklist', 'checklist'], ['qa', 'Q&A', 'qa']];
/** The address of one page of a deal. */
export const pageHash = (page: Landing, dealId: string) => `${DEAL_PAGES.find((p) => p[0] === page)![2]}-${dealId}`;
/** The address a deal opens on: the page the person chose in Settings. */
export const dealHash = (prefs: Pick<Prefs, 'landing'>, dealId: string) => pageHash(prefs.landing, dealId);
/** A file waiting to go with the next message of one conversation (`conv` is that conversation's key). */
export interface Attachment {
  id: string; name: string; dealId: string; findingId?: string; conv: string;
  state: 'pending' | 'done'; doc?: string; docId?: string;
  /** its file could not be found when the message was to be sent: it must be attached again (#671) */
  missing?: boolean;
}
/** 'failed' can be retried; 'missing' is the backend saying the file is not in the deal's folders */
export type PageState = 'loading' | 'failed' | { kind: 'missing'; message: string } | PageView;

/** One version of a record in a clash. `data` is null when what was stored could not be read. */
export interface ConflictVersion {
  id: string; by: string; from: string; at: string;
  /** written on this PC */
  here?: boolean;
  /** this version is the record deleted (it has no data) */
  deleted?: boolean;
  data: Question | Finding | Deal | Item | ListRecord | null;
  /** exactly what was stored, kept so that nothing is lost when a version cannot be read */
  raw: unknown;
  /** of a question's version: every draft request its history held (`Version.drafts`) */
  drafts?: string[];
}
/** A record with versions nobody has chosen between. It belongs to that one record and to nothing else. */
/** `dealId` is '' for the firm's list, which belongs to no deal. */
export interface Conflict { kind: ClashKind; id: string; dealId: string; versions: ConflictVersion[] }

/** `sticky`: it stays until the person closes it, or the next change is made; `stays`: the next change does not take it away either */
export interface Toast {
  id: number;
  text: string;
  action?: { label: string; opId?: string; run?: () => void };
  sticky?: boolean;
  stays?: boolean;
  /** Kept on this PC across restarts until closed. */
  kept?: boolean;
  /** The full message to show on hover. */
  more?: string;
  /** The part of the message that gives way when it does not fit. */
  cut?: string;
  glyph?: 'done' | 'warn';
}

/** What kind of deal a new deal is, picked on the New deal form: its structure, sector and technology. */
export type DealKinds = { product?: string; sector?: string; technology?: string };

export interface UiState {
  route: { name: 'home' } | { name: 'overview'; dealId: DealId } | { name: 'deal'; dealId: DealId } | { name: 'checklist'; dealId: DealId } | { name: 'qa'; dealId: DealId } | { name: 'finding'; dealId: DealId; findingId: FindingId }
    | { name: 'chat'; dealId?: DealId; /** which conversation; none for the first one */ conv?: string } | { name: 'question'; dealId: DealId; questionId: QuestionId };
  /** index into the open conversation's document list; null = reading mode closed */
  doc: number | null;
  /** a document opened from a follow-up answer: shown on its own, outside the list and the stepping order */
  /** `back` is the page to return to when the document is closed, for one opened from a page that has no reader of its own;
   *  `backFocus` lists what to focus there, in order of preference (CSS selectors) */
  docAside: null | { doc: string; docId: string; loc: string; from: string; ask?: string; dealId?: string; back?: string; backFocus?: string[]; /** the checklist item it was opened for, named beside it */ item?: string };
  /** a finding or question open in the side pane beside the conversation; never at the same time as a document. A
   * question is opened from a suggestion under an answer, the message `answer` in this conversation */
  side: null | { kind: 'finding'; id: FindingId } | { kind: 'question'; id: QuestionId; answer: string };
  /** suggested open questions a person said "not this one" to, as `answer message id|question id`; kept on this PC (Store.putAway) */
  notThese: string[];
  /** what the model said, when a person asked, about whether an answer addresses the question suggested under it, as `answer message id|question id`; for this session only */
  verdicts: Record<string, 'asking' | 'failed' | { verdict: 'yes' | 'partly' | 'no'; why: string }>;
  /** the steps of answers still being worked on, by the pending message's id, as the backend last said them; for this session only */
  researching: Record<string, Research>;
  queueSearch: string;
  attachments: Attachment[];
  settings: boolean;
  /** the Add deal dialog (the sidebar's +) is open */
  addDeal: boolean;
  /** the deal whose "Remove from my deals" is being confirmed */
  removeDeal: DealId | null;
  /** the firm's checklist dialog (from Settings): its lists, or bringing one in, from scratch or in place of a list it has */
  firmChecklist: null | { step: 'lists' } | { step: 'import'; layer?: import('../domain/checklist').Layer; name?: string };
  palette: boolean;
  /** the import or export dialog that is open, if any (or the confirmation of Undo last import); its form state lives in the dialog */
  dialog: null | { kind: 'importQa' | 'exportQa' | 'exportFindings' | 'deleted' | 'importIssues' | 'placeKept' | 'closeSettled' | 'addUnresolved' | 'undoImport'; dealId: DealId } | { kind: 'resolveQa'; dealId: DealId; questionId: QuestionId };
  selectedQuestion: QuestionId | null;
  searchFocus: string | null;
  /** the checklist item open beside the list on the Checklist page */
  selectedChecklist: string | null;
  /** `changed` and `versions`: only the questions changed in the Q&A log, or in two versions (shown while there are any) */
  qaFilter: { status: 'open' | 'answered' | 'closed' | 'all' | 'changed' | 'versions'; workstream: string; text: string };
  toasts: Toast[];
  newDeal: null | { name: string; folders: { path: string; label: string; files: number; size: string }[]; error: string; busy: boolean; forDeal?: DealId; kinds?: DealKinds; counterparty?: string; /** a likely duplicate the form is asking about */ twin?: import('./dupes').TwinFound };
  /** `sure`: the name has been typed and the second pop-up, which asks once more, is showing */
  /** `seen`: what this PC had taken in as the first pop-up opened, given with the delete */
  deleteDeal: null | { dealId: DealId; typed: string; error: string; sure?: boolean; seen?: Seen };
  findingFilter: { status: 'open' | 'reassess' | 'closed' | 'all'; workstream: string; text: string; reviewed: '' | 'yes' | 'no' };
  /** which checklist items the Checklist page lists: all of them, or those that stand one way. `open` is the items not settled, `person` those resolved by a person, `gone` those whose finding was deleted. */
  checklistFilter: 'all' | 'finding' | 'gone' | 'gap' | 'open' | 'person' | 'satisfied' | 'off';
  reassessing: string[];
  /** deals whose indexing the backend is not running although the deal has not finished: shown as stopped, with Resume */
  indexStalled: string[];
  /** deals whose unfinished indexing the app will start again by itself: `away` while their folders cannot be reached, `retry` between tries after a run broke */
  indexWaiting: Record<string, 'away' | 'retry'>;
  /** what stopped a deal's last run of indexing, in the backend's words, when it said */
  indexWhy: Record<string, string>;
  batch: null | { dealId: DealId; total: number; done: number; stopping: boolean };
  confirmDraftAll: boolean;
  /** deals whose deal memo is being made: their Deal memo button spins */
  memoBusy: string[];
  /** deal folders that cannot be opened on this PC, once the app has looked for them for the time the control file gives; null while none are missing or before then */
  missingFolders: FolderSearch | null;
  /** the Locate deal folders dialog: each top folder a person has pointed at, what it found, and the last error */
  locate: null | { located: { top: string; picked: string; places: FolderPlace[] }[]; busy: boolean; error: string };
}

export interface State {
  can: Capabilities;
  boot: { stage: BootStage; error?: string };
  /** `down`: the backend out of reach (the bar at the top). `model`: the model service's last answer was that it could not be reached (the connection card's Intelligence row). */
  net: { down: boolean; model?: boolean };
  /** Intelligence sign-in, in the desktop app: `out` while nobody is signed in, when the app is read-only (decisions:
   *  "Intelligence sign-in"); which ways of signing in are offered. Absent where there is no sign-in (the browser demo). */
  signin?: { out: boolean; sso: boolean; apiKey: boolean };
  user: { name: string; initials: string } | null;
  models: { id: string; name: string }[];
  model: string;
  deals: Record<string, Deal>;
  dealLoad: Record<string, 'loading' | 'loaded' | 'failed'>;
  questions: Record<string, Question>;
  findings: Record<string, Finding>;
  tombstones: Record<string, Tombstone>; // by record id
  /** every loaded deal's checklist items, by id */
  items: Record<string, Item>;
  /** the firm's lists, one record each (`l_…`; domain/checklist listId), a bucket like the others */
  firmList: Record<string, ListRecord>;
  /** who has which deal in their list: every person's record on every deal, by id */
  members: Record<string, Member>;
  ops: Record<string, Operation>;
  audit: Record<string, AuditEntry[]>;
  gaps: Record<string, { title: string }[]>;
  /** per deal: when everything was last checked, the offer of a deeper check if the last one earned it, and a check that is running now */
  /** `at`: the last check that reached everything. `left`: what the latest check could not reach, and when it ran. `failedAt`: when the latest check stopped without finishing. Both are cleared by the next check that completes. */
  checks: Record<string, { at: string | null; offerDeep: { size: number; overturned: number } | null; busy?: 'quick' | 'deep'; left?: { items: number; findings: number; at: string; /** the documents have changed since that check, so only a check of everything will do */ changed?: boolean } | null; failedAt?: string | null; /** who else is in the check this PC is working, and how it is going (see checkingSays) */ checking?: CheckState['checking'] }>;
  /** how far the review of each deal has got, as the backend reports it: per folder, documents read and core documents read. Read-only; absent until asked for. */
  progress: Record<string, import('../ports').DealProgress>;
  /** every checklist item of each deal and how it stands, as the backend reports it. Read-only; absent until asked for. */
  checklists: Record<string, import('../ports').ChecklistRow[] | 'failed'>;
  /** local, per user: conversation threads by scope key, and preferences */
  threads: Record<string, Message[]>;
  prefs: Prefs;
  pages: Record<string, PageState>;
  /** ids of the documents loaded in the user's store right now (read-only, from the backend) */
  cached: Record<string, true>;
  /** a document's drafts, newest first (empty when it has none), by `${dealId}|${docId}`; read once, when it is first shown */
  drafts: Record<string, import('../ports').DraftRef[]>;
  /** every place a document sits, its first place first, by `${dealId}|${docId}`; read once, when it is first shown */
  places: Record<string, import('../ports').DocPlaceRef[]>;
  /** records with versions nobody has chosen between, by record id */
  conflicts: Record<string, Conflict>;
  /** what the backend reports about other PCs; null when it shares nothing */
  sync: SyncState | null;
  /** progress of indexing that is under way, by deal. Read from the backend and shown; saved to the deal only when it finishes. */
  indexing: Record<string, { folders: Folder[]; log: string[] }>;
  ui: UiState;
}

export const initialState = (can = capabilities()): State => ({
  can,
  boot: { stage: 'session' },
  net: { down: false },
  user: null,
  models: [],
  model: '',
  deals: {},
  dealLoad: {},
  questions: {},
  findings: {},
  tombstones: {},
  items: {},
  firmList: {},
  members: {},
  ops: {},
  audit: {},
  gaps: {},
  checks: {},
  progress: {},
  checklists: {},
  threads: {},
  prefs: DEFAULT_PREFS,
  pages: {},
  cached: {},
  drafts: {},
  places: {},
  conflicts: {},
  sync: null,
  indexing: {},
  ui: {
    route: { name: 'home' },
    doc: null,
    docAside: null,
    side: null,
    notThese: [],
    verdicts: {},
    researching: {},
    queueSearch: '',
    attachments: [],
    settings: false,
    addDeal: false,
    removeDeal: null,
    firmChecklist: null,
    palette: false,
    dialog: null,
    selectedQuestion: null,
    searchFocus: null,
    selectedChecklist: null,
    qaFilter: { status: 'open', workstream: '', text: '' },
    toasts: [],
    newDeal: null,
    deleteDeal: null,
    findingFilter: { status: 'open', workstream: '', text: '', reviewed: '' },
    checklistFilter: 'all',
    reassessing: [],
    indexStalled: [],
    indexWaiting: {},
    indexWhy: {},
    batch: null,
    confirmDraftAll: false,
    memoBusy: [],
    missingFolders: null,
    locate: null,
  },
});

export const dealQuestions = (s: State, dealId: string): Question[] =>
  Object.values(s.questions).filter((q) => q.dealId === dealId).sort((a, b) => a.n - b.n);

/** One past the highest number the deal has used, counting deleted questions too: a number is never handed out twice. */
export const nextQuestionNumber = (s: State, dealId: string): number =>
  Math.max(0, ...dealQuestions(s, dealId).map((q) => q.n), ...Object.values(s.tombstones).filter((t) => t.kind === 'question' && t.dealId === dealId).map((t) => Number((t.snapshot as { n?: number } | undefined)?.n) || 0)) + 1;

export const dealFindings = (s: State, dealId: string) =>
  Object.values(s.findings).filter((f) => f.dealId === dealId).sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || a.id.localeCompare(b.id));

/** Why a deal cannot be deleted just now, or null: changes to it from another PC are still held back, and deleting it
 * would lose them. */
export const deleteWaits = (s: Pick<State, 'sync' | 'deals'>, dealId: string): string | null => {
  const w = s.sync?.waiting.find((x) => x.deals.includes(dealId)); if (!w) return null;
  return `${s.deals[dealId]?.name ?? 'This deal'} can’t be deleted while changes to it from ${w.from.length === 1 ? w.from[0] : 'other PCs'} are still arriving`;
};

/** Is a document open beside the conversation? */
export const isReading = (ui: UiState): boolean => ui.doc != null || ui.docAside != null;

/** A finding named in a sentence. Findings have no number; they are named by their title. */
export const findingName = (title: string | undefined): string => (title ? `The finding “${title.length > 60 ? title.slice(0, 59).trimEnd() + '…' : title}”` : 'This finding');

/** What a record in a clash is called when the app has to name it. */
export function conflictLabel(s: State, c: Conflict): string {
  const d = (c.versions.find((v) => v.data)?.data ?? null) as any;
  if (c.kind === 'item') { const t: string = s.items[c.id]?.text ?? d?.text ?? ''; return t ? `The checklist item “${t.length > 60 ? t.slice(0, 59).trimEnd() + '…' : t}”` : 'This checklist item'; }
  if (c.kind === 'firmList') { const l = s.firmList[c.id] ?? d; return l?.layer === 'broad' || !l?.name ? 'The general list' : `The ${l.name} list`; }
  return c.kind === 'question' ? `Q${s.questions[c.id]?.n ?? d?.n ?? ''}` : c.kind === 'finding' ? findingName(s.findings[c.id]?.title ?? d?.title) : (s.deals[c.id]?.name ?? d?.name ?? 'This deal');
}
/** The window's records of one kind, by id, or null for a kind it does not keep (the journal, history). The one table of kinds. */
export function bucketOf(s: Pick<State, 'deals' | 'questions' | 'findings' | 'tombstones' | 'items' | 'firmList' | 'members'>, kind: string): Record<string, any> | null {
  return kind === 'deal' ? s.deals : kind === 'question' ? s.questions : kind === 'finding' ? s.findings : kind === 'tombstone' ? s.tombstones : kind === 'item' ? s.items : kind === 'firmList' ? s.firmList : kind === 'member' ? s.members : null;
}
export type BucketKind = Exclude<RecordKind, 'op' | 'audit'>;

export const versionsWord = (n: number) => (n === 2 ? 'Two versions' : `${n} versions`);

/**
 * A question in two versions (option A), as the Q&A list marks it: changed on two PCs (`conflicts`), or changed
 * both in the app and in the deal's Q&A log since the app last wrote it (the log's `kept`). The words the list shows, or ''.
 */
export function qaVersions(s: Pick<State, 'conflicts' | 'deals'>, q: Question): string {
  if (s.conflicts[q.id]) return versionsWord(s.conflicts[q.id].versions.length);
  return Object.keys(qaKept(s, q)).length ? versionsWord(2) : '';
}
/**
 * The cells of a question in two versions with the Q&A log (the last update's `kept`): each field and what the log says.
 * A cell the app has since been brought to say the same (a person typed it, or an import took it in) is left out.
 */
export function qaKept(s: Pick<State, 'deals'>, q: Question): Record<string, string> {
  const last = s.deals[q.dealId]?.qaLogs[0]?.last; const kept = last?.kept?.[q.id]; if (!kept) return {};
  // a cell a person has chosen for since that update (Resolve; the question's own logPick) is settled
  const chosen = q.logPick?.of === last!.at ? q.logPick.sent : {};
  // compared in the app's terms, so a log that writes Open as "Outstanding" or a date as 11/20/2026 is not taken for a difference
  const read = readLogCells(q, kept);
  return Object.fromEntries(Object.entries(kept).filter(([k]) => !(k in chosen) && !holds(q, k, read[k])));
}
/**
 * The fields of a question the app took in from the Q&A log at its last update (the log's `changed`) that this person has not
 * seen yet: opening the question is seeing them (`seen`: per question, the update it was last opened after).
 */
export function qaChanged(s: Pick<State, 'deals' | 'prefs'>, q: Question): string[] {
  const last = s.deals[q.dealId]?.qaLogs[0]?.last; const f = last?.changed?.[q.id];
  return f && s.prefs.qaSeen[q.id] !== last!.at ? Object.keys(f) : [];
}
/** the workstream a question is filtered under: its own, or "No workstream" */
export const qaWorkstream = (r: Pick<Question, 'workstream'>) =>
  (r.workstream.trim() ? r.workstream : NO_WORKSTREAM);
/** The Q&A workstream filter's choices: the workstreams A to Z, then "No workstream" once, last. */
export const qaWorkstreamChoices = (rows: Pick<Question, 'workstream'>[]) =>
  [...workstreamChoices(rows.map((r) => r.workstream)).filter((w) => w !== NO_WORKSTREAM), NO_WORKSTREAM];
/** The workstream a question added under the Q&A filter `chosen` takes: that one, or none under "No workstream". */
export const workstreamForNew = (chosen: string) => (chosen === NO_WORKSTREAM ? '' : chosen);
/** whether a question is in the Q&A list under the filter `F` (the open one is shown besides: see qa.tsx) */
export function qaListed(s: Pick<State, 'conflicts' | 'deals' | 'prefs'>, r: Question, F: State['ui']['qaFilter']): boolean {
  const st = F.status === 'all' || (F.status === 'changed' ? qaChanged(s, r).length > 0 : F.status === 'versions' ? !!qaVersions(s, r) : statusesOf(s, r).includes(F.status));
  const words = !F.text || `${r.text} ${r.response} ${r.askedBy} ${r.n}`.toLowerCase().includes(F.text.toLowerCase());
  return st && (!F.workstream || qaWorkstream(r) === F.workstream) && words;
}
/** a question's statuses: its own, and while it is in two versions, each version's too, so it is listed under either version's status */
function statusesOf(s: Pick<State, 'conflicts' | 'deals'>, r: Question): string[] {
  const pc = s.conflicts[r.id]?.versions.map((v) => (v.data as Question | null)?.status ?? '') ?? [];
  const kept = qaKept(s, r); const log = kept.status ? readLogCells(r, { status: kept.status }).status.toLowerCase() : undefined;   // the log's status in the app's terms
  return [r.status, ...pc, ...(log ? [log] : [])];
}
/** a Q&A filter choice as a plain status filter, for what filters by status only (export, the conversation's queue) */
export const qaStatusOnly = (status: State['ui']['qaFilter']['status']) => (status === 'changed' || status === 'versions' ? 'all' : status);

/**
 * Two PCs that have not yet seen each other's changes can each give a new question the same number. Both records are
 * kept. This says which numbers are held twice, so both rows can be marked and a person can renumber one. Nothing is
 * renumbered on its own.
 */
export function sharedNumbers(s: State, dealId: string): Set<number> {
  const seen = new Set<number>(); const twice = new Set<number>();
  for (const q of Object.values(s.questions)) if (q.dealId === dealId) { if (seen.has(q.n)) twice.add(q.n); seen.add(q.n); }
  return twice;
}

/** What a deal's ask box invites. A name too long to fit the box is left out of it rather than cut. */
export const askAbout = (name: string) => (name.length > 40 ? 'Ask about this deal…' : `Ask about ${name}…`);
/** What the ask box says when the question goes across the person's deals: on Home and in the conversation it opens, the same words. */
// Home never names one deal, even when the person has only one: a deal's own ask box says "Ask about …", and Home must
// not read like it
export const askAcross = (names: string[]) => (names.length === 1 ? 'Ask across your deals…' : 'Ask across your deals, or about one of them…');

/** The heading a finding is listed under: its workstream, or "No workstream" when the model left it blank. */
export { NO_WORKSTREAM };
// the name with spaces at its ends taken off, so " Legal" and "Legal" are one group; the workstream filter compares it too, so the
// two always agree, and "No workstream" can be chosen there. A workstream actually named "No workstream" joins the empty ones.
export const workstreamHead = (f: Pick<Finding, 'workstream'>) => f.workstream.trim() || NO_WORKSTREAM;
/** The workstreams a list of findings is headed by, as the Findings filter and the export offer them: A to Z, then "No workstream" when any has none. */
export const findingWorkstreams = (fs: Pick<Finding, 'workstream'>[]) => [...new Set(fs.map(workstreamHead))].sort((a, b) => Number(a === NO_WORKSTREAM) - Number(b === NO_WORKSTREAM) || byName(a, b));
/** Where a workstream's group comes: A to Z whatever the names are, with "No workstream" last. */
const groupRank = (w: string): [number, string] => [w === NO_WORKSTREAM ? 1 : 0, w];
/**
 * A deal's findings in the order the Findings list shows them: grouped by workstream, and in each group those
 * marked for an update first, then as they stand. The list and the queue beside an open finding both use this, so
 * "10 of 12" in the queue is the tenth row of the list.
 */
export const listedFindings = (s: State, dealId: string): Finding[] =>
  dealFindings(s, dealId).map((f, i) => ({ f, i, g: groupRank(workstreamHead(f)) }))
    .sort((a, b) => a.g[0] - b.g[0] || byName(a.g[1], b.g[1]) || Number(b.f.updated && b.f.status === 'open') - Number(a.f.updated && a.f.status === 'open') || a.i - b.i).map((x) => x.f);
/**
 * How a checklist item stands (linking design, sections 10 and 12). The backend says what the check came to; for an
 * item whose check raised a finding, the finding as it stands now decides: open, or in two versions, keeps the item
 * Flagged; closed by a person makes it Resolved by a person; deleted makes it Finding deleted, still to resolve. Until the deal's records
 * are loaded, or when the finding cannot be found at all, the item stays as the check left it.
 */
export type ItemKind = 'finding' | 'gone' | 'gap' | 'open' | 'person' | 'satisfied';
export interface ItemStanding { kind: ItemKind; finding?: Finding; /** the finding's versions, when it has more than one */ versions?: Conflict; /** the deleted finding, which can be restored */ gone?: Tombstone }
export function itemStanding(s: Pick<State, 'findings' | 'tombstones' | 'conflicts' | 'dealLoad'>, dealId: string, r: import('../ports').ChecklistRow): ItemStanding {
  if (r.result !== 'finding') return { kind: r.result === 'unsettled' || r.result === 'unchecked' ? 'open' : r.result };
  const id = r.findingId; const finding = id ? s.findings[id] : undefined;
  if (!id || s.dealLoad[dealId] !== 'loaded') return { kind: 'finding', finding };
  if (s.conflicts[id]) return { kind: 'finding', finding, versions: s.conflicts[id] };
  if (finding) return { kind: finding.status === 'closed' ? 'person' : 'finding', finding };
  const gone = s.tombstones[id];
  return gone?.kind === 'finding' ? { kind: 'gone', gone } : { kind: 'finding' };
}

/**
 * The open questions whose checklist item the documents or a person have since settled (decisions: "Close this
 * question"; linking design, section 13; mock-up link-qa-settled counts open questions). A question belongs to an item it
 * was asked for, or to the item whose check raised the finding it was asked about. Only Satisfied and Resolved-by-a-person
 * items count. Left out, and named: a question in two versions (closing it would choose between them), a question about a
 * finding still open, and a satisfied item whose place no longer opens. `where` says what settled it: the place, or the closed finding.
 */
export interface Settled { q: Question; item: string; where: string }
export function settledQuestions(s: Pick<State, 'questions' | 'findings' | 'tombstones' | 'conflicts' | 'dealLoad' | 'checklists' | 'items'>, dealId: string): { close: Settled[]; left: { q: Question; why: string }[] } {
  const rows = s.checklists[dealId]; const out = { close: [] as Settled[], left: [] as { q: Question; why: string }[] };
  if (!Array.isArray(rows) || s.dealLoad[dealId] !== 'loaded') return out;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const q of dealQuestions(s as State, dealId)) {
    if (q.status !== 'open') continue;
    const f = q.linkedFinding ? s.findings[q.linkedFinding] : undefined;
    // a turned-off item's last result stays in the rows, but it is no longer checked for the deal (as on the Checklist page)
    const r = byId.get(q.linkedItem?.id ?? '') ?? (f?.itemId ? byId.get(f.itemId) : undefined); if (!r || s.items[r.id]?.off) continue;
    const st = itemStanding(s, dealId, r); if (st.kind !== 'satisfied' && st.kind !== 'person') continue;
    const src = r.sources?.[0];
    // a question about a finding, asked from the finding or from its flagged item, is settled only when a person has closed
    // that finding, whatever a later check says of the item
    const why = s.conflicts[q.id] ? `${versionsWord(s.conflicts[q.id].versions.length)}: choose one first`
      : f && f.status !== 'closed' ? 'Its finding is still open'
      : st.kind === 'satisfied' && !f && !src ? 'Its document is no longer here' : '';   // "satisfied" always rests on a place that opens
    if (why) { out.left.push({ q, why }); continue; }
    out.close.push({ q, item: r.text, where: st.kind === 'person' || f ? 'finding closed' : `${src!.doc}, ${src!.loc}` });
  }
  return out;
}

/**
 * What "Add all unresolved to Q&A" offers (linking design, section 13): each gap, and each open finding, that no question
 * has been asked about yet, and for each, the open question with no response and no link that may already ask it (by the
 * telling words they share; at most one each, and each question offered once). A finding in two versions is left out, and so is a turned-off item, with the findings raised on it.
 */
export interface Unresolved { key: string; kind: 'gap' | 'finding'; what: string; need: string; itemId?: string; findingId?: string; workstream: string }
export function unresolvedPoints(s: Pick<State, 'questions' | 'findings' | 'tombstones' | 'conflicts' | 'dealLoad' | 'checklists' | 'items'>, dealId: string): { points: Unresolved[]; links: { point: string; q: Question }[] } {
  const qs = dealQuestions(s as State, dealId); const rows = s.checklists[dealId];
  const askedItems = new Set(qs.map((q) => q.linkedItem?.id).filter(Boolean)); const askedFindings = new Set(qs.map((q) => q.linkedFinding).filter(Boolean));
  const points: Unresolved[] = [];
  for (const f of dealFindings(s as State, dealId)) {
    // a finding raised on an item since turned off is not asked about, as its pane offers no Ask
    if (f.status !== 'open' || s.conflicts[f.id] || askedFindings.has(f.id) || (f.itemId && (askedItems.has(f.itemId) || s.items[f.itemId]?.off))) continue;
    // a finding says no more than its title of what would settle it
    const need = '';
    points.push({ key: 'f:' + f.id, kind: 'finding', what: f.title, need, findingId: f.id, workstream: f.workstream });
  }
  if (Array.isArray(rows)) for (const r of rows) {
    if (askedItems.has(r.id) || s.items[r.id]?.off || itemStanding(s, dealId, r).kind !== 'gap') continue;      // a turned-off item's last result stays in the rows
    points.push({ key: 'i:' + r.id, kind: 'gap', what: r.text, need: r.need ?? '', itemId: r.id, workstream: '' });
  }
  const pool = qs.filter((q) => q.status === 'open' && !q.response.trim() && !q.linkedItem && !q.linkedFinding && !s.conflicts[q.id] && q.text.trim());
  const taken = new Set<string>(); const links: { point: string; q: Question }[] = [];
  const likely = addresser(pool);
  for (const p of points) { const q = likely(`${p.what} ${p.need}`).find((x) => !taken.has(x.id)); if (q) { taken.add(q.id); links.push({ point: p.key, q }); } }
  return { points, links };
}

/** A checklist item as a finding or a question names it: its id, its wording, and whether it is turned off. */
export interface NamedItem { id: string; text: string; off: boolean }

/** The deal's checklist item with this id, from its records or, for a deal with none of its own, its check's rows. */
export function namedItem(s: Pick<State, 'checklists' | 'items'>, dealId: string, id: string): NamedItem | null {
  const record = s.items[id];
  if (record?.dealId === dealId) return { id, text: record.text, off: !!record.off };
  const rows = s.checklists[dealId];
  const row = Array.isArray(rows) ? rows.find((r) => r.id === id) : undefined;
  return row ? { id, text: row.text, off: false } : null;
}

/**
 * The checklist item a finding was raised on (linking design, section 6): the one it names (`itemId`) or, for a
 * finding that does not name it, the item whose check line names the finding.
 */
export function findingItem(s: Pick<State, 'checklists' | 'items'>, f: Finding): NamedItem | null {
  if (f.itemId) return namedItem(s, f.dealId, f.itemId);
  const rows = s.checklists[f.dealId];
  const row = Array.isArray(rows) ? rows.find((r) => r.findingId === f.id) : undefined;
  return row ? namedItem(s, f.dealId, row.id) : null;
}

/** How many of the deal's turned-off checklist items a finding still open was raised on (linking design, section 12). */
export function offFindingCount(s: Pick<State, 'items' | 'findings'>, dealId: string): number {
  const off = new Set(Object.values(s.items).filter((it) => it.dealId === dealId && it.off).map((it) => it.id)); if (!off.size) return 0;
  return new Set(Object.values(s.findings).filter((f) => f.dealId === dealId && f.status === 'open' && f.itemId && off.has(f.itemId)).map((f) => f.itemId)).size;
}

/** Whether the Findings filter shows this finding. A finding with two versions needs a decision, so no filter hides it. */
export const findingListed = (s: Pick<State, 'conflicts'>, f: Finding, FF: State['ui']['findingFilter']): boolean =>
  !!s.conflicts[f.id] || ((FF.status === 'all' || (FF.status === 'reassess' ? f.status === 'open' && f.updated : f.status === FF.status)) && (!FF.workstream || workstreamHead(f) === FF.workstream) && (!FF.reviewed || (FF.reviewed === 'yes') === !!f.reviewed) && (!FF.text || f.title.toLowerCase().includes(FF.text.toLowerCase())));

/**
 * What tells a deal from another of the same name: its counterparty and the day it was created, as "Northwind LP · Nov
 * 15, 2026". Empty when no other deal has its name.
 */
/** The form of a deal's name that dealTwin compares: two deals whose keys match share a name. */
export const dealNameKey = (n: string) => n.trim().toLocaleLowerCase('en-US');
/**
 * What tells each deal of one name from the others (`group`: every deal with that name), worked out for the whole group at
 * once: `full` is its counterparty and the day it was made; `short`, where room is short (the sidebar), only what this deal
 * has and its twins do not: its counterparty, else the day it was made, else both.
 */
export function dealTwins(group: Deal[]): Map<string, { full: string; short: string }> {
  const out = new Map<string, { full: string; short: string }>(); if (group.length < 2) { for (const d of group) out.set(d.id, { full: '', short: '' }); return out; }
  const day = (x: Deal) => { const made = new Date(x.createdAt); return isNaN(+made) ? '' : made.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
  const rows = group.map((d) => ({ d, cp: d.counterparty.trim(), day: day(d) }));
  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const cps = new Map<string, number>(), days = new Map<string, number>(); for (const r of rows) { if (r.cp) count(cps, dealNameKey(r.cp)); if (r.day) count(days, r.day); }
  for (const { d, cp, day: dd } of rows) {
    const full = [cp, dd].filter(Boolean).join(' · ');
    out.set(d.id, { full, short: cp && cps.get(dealNameKey(cp)) === 1 ? cp : dd && days.get(dd) === 1 ? dd : full });
  }
  return out;
}

/** Group names once for a screen that may need labels for many deals. */
export function dealTwinLabels(deals: Iterable<Deal>) {
  const named = new Map<string, Deal[]>();
  for (const deal of deals) {
    const key = dealNameKey(deal.name);
    const matches = named.get(key) ?? [];
    matches.push(deal);
    named.set(key, matches);
  }
  const labels = new Map<string, ReturnType<typeof dealTwins>>();
  function labelFor(deal: Deal, short: 'focus'): TwinFocus | undefined;
  function labelFor(deal: Deal, short?: boolean): string;
  function labelFor(deal: Deal, short: boolean | 'focus' = false): string | TwinFocus | undefined {
    const key = dealNameKey(deal.name);
    const matches = named.get(key);
    if (!matches || matches.length < 2) return short === 'focus' ? undefined : '';
    let group = labels.get(key);
    if (!group) {
      group = dealTwins(matches);
      labels.set(key, group);
    }
    const label = group.get(deal.id);
    if (!label) return short === 'focus' ? undefined : '';
    if (short === 'focus') return distinguishingWords(label.short, [...group.values()].map((twin) => twin.short));
    return short ? label.short : label.full;
  }
  return labelFor;
}

export function dealTwin(s: Pick<State, 'deals'>, d: Deal, short = false): string {
  const k = dealNameKey(d.name); const group = [d, ...Object.values(s.deals).filter((x) => x.id !== d.id && dealNameKey(x.name) === k)];
  const t = dealTwins(group).get(d.id); return (short ? t?.short : t?.full) ?? '';
}

/**
 * A deal's name as a confirmation or notice says it: with the sidebar's short line in brackets when another deal shares
 * the name, as "Project Kestrel (Wingtip)"; the name alone otherwise (#27). A notice splits its text at " · " into
 * title and body, so a line holding both counterparty and day joins them with a comma instead.
 */
export function dealLabel(s: Pick<State, 'deals'>, d: Deal): string {
  const twin = dealTwin(s, d, true).replaceAll(' · ', ', ');
  return twin ? `${d.name} (${twin})` : d.name;
}
