/**
 * Domain shapes. zod schemas are the single source of truth; the TypeScript
 * types are derived from them. Everything that enters from outside (storage,
 * services, import files) is parsed through these before it touches state.
 *
 * Ids are opaque ULIDs with a kind prefix: d_ q_ f_ doc_ op_. An imported
 * question's id is made from what it is instead (derivedId.ts), in the same
 * shape. A display number (Question.n) is data, never identity.
 */
import { z } from 'zod';
import { control } from '../control';

const ISO = z.string().min(20); // full ISO 8601 timestamp
const YMD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, 'not a calendar date');
const YMDorBlank = z.union([z.literal(''), YMD]);

export function isRealDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export const id = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
export const DealId = id('d');
export const QuestionId = id('q');
export const FindingId = id('f');
export const DocumentId = id('doc');
export const OpId = id('op');
export type DealId = z.infer<typeof DealId>;
export type QuestionId = z.infer<typeof QuestionId>;
export type FindingId = z.infer<typeof FindingId>;
export type OpId = z.infer<typeof OpId>;

/** Common envelope fields carried by every stored record. */
const Record = z.object({
  rev: z.number().int().nonnegative(),
  createdAt: ISO,
  updatedAt: ISO,
});

/**
 * A citation. `loc` is as precise as the backend can honestly be: for PDF and Word documents that is a
 * page ("p. 41") of the PDF rendering the app displays, never a clause or passage; for a spreadsheet it
 * is a sheet and cell ("Revenue!D14"). `quote` is the short passage the backend used to confirm the page;
 * the app stores it untouched and does not display or highlight it. `dealId` is needed only on answers that
 * range across deals, so the page can be fetched from the right one. `reading` marks a page of a blackline: what it
 * shows of a change is the model's reading, to be checked on the page.
 */
export const Source = z.object({ doc: z.string().min(1), loc: z.string(), docId: z.string().min(1), version: z.string().optional(), quote: z.string().max(32_767).optional(), dealId: z.string().optional(), reading: z.literal(true).optional(), precedent: z.literal(true).optional() });   // what the backend sends is cut to these fields: a source's other keys are dropped, also on a record from a newer build
export type Source = z.infer<typeof Source>;
/** What identifies a cited document: its id. */
export const docKey = (s: { docId: string }): string => s.docId;

export const Folder = z.object({
  path: z.string().min(1),
  label: z.string(),
  files: z.number().int().nonnegative(),
  size: z.string(),
  indexed: z.number().int().nonnegative().default(0),
  reviewed: z.number().int().nonnegative().default(0),
});
export type Folder = z.infer<typeof Folder>;

/**
 * The deal's Q&A log: one per deal, the consolidated log of every party's questions, and the team's own
 * file, `file` in `folder` on their NAS or drive; the app keeps no copy. `sheet`, `headerRow` and `mapping` say where its
 * table is, and `last` what the last update wrote: its archive copy of the version replaced, and, by question id, each
 * field's value as the app wrote it (`sent`), the cells left in two versions (`kept`) and the cells taken in from the log (`changed`).
 */
export const QaLog = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
  folder: z.string().min(1),
  sheet: z.string(),
  headerRow: z.number().int().positive(),
  mapping: z.record(z.string(), z.number().int().nonnegative().nullable()),
  last: z.object({
    archive: z.string(), at: z.string(), by: z.string(), sent: z.record(z.string(), z.record(z.string(), z.string())),
    /** cells in two versions, by question id and field: what the log says where both it and the app changed the cell since the app last wrote it; a person chooses */
    kept: z.record(z.string(), z.record(z.string(), z.string())).default({}),
    /** cells changed in the log that the app took in, by question id and field: what the app held before (the "was" a person is shown) */
    changed: z.record(z.string(), z.record(z.string(), z.string())).default({}),
  }).optional(),
});
export type QaLog = z.infer<typeof QaLog>;

/** The firm's workstreams, from the control file (firm.workstreams). A record may carry another (an imported log keeps
 * the other side's own categories, and a name the firm takes off its list stays on the records that have it). Lists show
 * them A to Z through `workstreamChoices` (src/domain/order.ts), never in this order. */
export const WORKSTREAMS: readonly string[] = control.firm.workstreams;

export const DealGroup = z.enum(['live', 'monitor', 'pitch', 'closed']);
export const DealStage = z.enum(['indexing', 'ready']);

/**
 * Deal, Question, Finding and Tombstone keep fields this build does not know (`loose`): a newer build on another PC may
 * have added some, and this build writes them back as they were whenever it changes the record.
 */
export const Deal = Record.extend({
  id: DealId,
  name: z.string().min(1),
  counterparty: z.string().default(''),
  target: z.string().default(''),
  /** the kind of financing, in the firm's own words; with the sector it says which checklists apply */
  product: z.string().default(''),
  sector: z.string().default(''),
  /** what is built or operated (the technology); with the structure (`product`) and the sector it says which checklists apply */
  technology: z.string().default(''),
  side: z.string().default(''),
  milestone: z.string().default(''), // e.g. "FC Dec 12"
  group: DealGroup.default('live'),
  stage: DealStage.default('indexing'),
  folders: z.array(Folder).default([]),
  /**
   * folders a person took off the deal: kept with their counts, so the Folders dialog lists each one under Removed and
   * Restore brings it back without indexing it again. `at` is where it stood among the deal's folders, removed ones counted.
   */
  removed: z.array(Folder.extend({ at: z.number().int().nonnegative() })).default([]),
  log: z.array(z.string()).default([]),
  /** the counterparties' Q&A logs, by name */
  qaLogs: z.array(QaLog).default([]),
}).loose();
export type Deal = z.infer<typeof Deal>;

/**
 * One person's place on one deal: a deal shows for the people who created it or added it (decisions: Storage). Each
 * person has a record of their own per deal, so two people adding the same deal never make two versions of one record.
 * `person` is the name the app knows the person by; `on` is false once it is taken back with Undo.
 */
export const Member = Record.extend({
  id: z.string().regex(/^m_d_[0-9A-HJKMNP-TV-Z]{26}_.+$/),
  dealId: DealId,
  person: z.string().min(1),
  on: z.boolean(),
}).loose();
export type Member = z.infer<typeof Member>;
/** the id of a person's record on a deal: the deal and the person's name, so every PC names it the same way */
export const memberId = (dealId: string, person: string): string => `m_${dealId}_${encodeURIComponent(person.trim().toLowerCase())}`;
/** The person's own record on a new deal, written with the deal itself (CreateDeal, and a deal's recovered copy). */
export const firstMember = (dealId: string, person: string, at: string): Member => ({ id: memberId(dealId, person), rev: 0, createdAt: at, updatedAt: at, dealId, person, on: true });
/**
 * Where a person's files attached on Home are kept: with their own conversations, in no deal. The documents
 * service keeps them as it keeps a deal's attachments, under this id in place of a deal's; every PC names it the same way.
 * Letters, digits and _ only, since it is part of file names.
 */
export function ownFilesId(person: string): string {
  const t = person.trim().toLowerCase(); let a = 0x811c9dc5, b = 0x01000193;    // two 32-bit FNV-1a runs with different seeds: 64 bits, so two people's ids do not meet
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15); }
  return `me_${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}
/** Is this id a person's own files (ownFilesId) rather than a deal? */
export const isOwnFiles = (id: string | undefined): boolean => !!id && id.startsWith('me_');

export const QuestionStatus = z.enum(['open', 'answered', 'closed']);
export type QuestionStatus = z.infer<typeof QuestionStatus>;
export const Priority = z.enum(['', 'High', 'Medium', 'Low']);

export const DraftStatus = z.enum(['pending', 'found', 'none', 'failed']);
export const Draft = z.object({
  status: DraftStatus,
  text: z.string().default(''),
  sources: z.array(Source).default([]),
  /** hash of the question text the draft was produced for; a mismatch makes it stale */
  forWording: z.string(),
  opId: OpId.optional(),
  /** when the draft was asked for: a pending draft from another PC is given up only once it is long past */
  at: ISO.optional(),
}).loose();
export type Draft = z.infer<typeof Draft>;

export const Provenance = z.object({
  origin: z.enum(['ai', 'chat', 'human']),
  sources: z.array(Source).default([]),
  actor: z.string(),
  at: ISO,
}).loose();
export type Provenance = z.infer<typeof Provenance>;

export const Question = Record.extend({
  id: QuestionId,
  dealId: DealId,
  n: z.number().int().positive(),
  text: z.string(),
  askedBy: z.string().default(''),
  received: YMDorBlank.default(''),
  workstream: z.string().default(''),
  priority: Priority.default(''),
  status: QuestionStatus.default('open'),
  response: z.string().default(''),
  respondedBy: z.string().default(''),
  responded: YMDorBlank.default(''),
  provenance: Provenance.optional(),
  linkedFinding: FindingId.optional(),
  /** the checklist item it was asked for (Ask the counterparty on a gap or a flagged item, Add all unresolved); linking design, section 6 */
  linkedItem: z.object({ id: z.string().min(1) }).loose().optional(),
  draft: Draft.optional(),
  /**
   * A person's choice between this question's two versions with the Q&A log (Resolve), until the next update writes it into
   * the file: the update it answers (`of`, that update's `last.at`) and the cells to record as holding the app's. Kept on the
   * question, not the deal's log record, so each choice is a small write of its own and two PCs resolving different
   * questions never touch one record.
   */
  logPick: z.object({ of: z.string(), sent: z.record(z.string(), z.string()) }).optional(),
}).loose();
export type Question = z.infer<typeof Question>;

export const FindingStatus = z.enum(['open', 'closed']);
export type FindingStatus = z.infer<typeof FindingStatus>;

/**
 * a point of an issues list a finding is on: the list (`doc`, the id of the file it came in, made from the file's bytes, so
 * every PC gives the same file the same id and a revised list saved under the same name another), the file's name
 * as shown (`list`), the point's number there as the list writes it, its words, and when the list was brought in (`at`,
 * bookkeeping between PCs: two PCs that import the same list mark a finding alike, whenever they did it)
 */
export const ListPoint = z.object({ doc: z.string().min(1), list: z.string(), n: z.string(), text: z.string(), at: ISO.optional() }).loose();
export type ListPoint = z.infer<typeof ListPoint>;

export const Finding = Record.extend({
  id: FindingId,
  dealId: DealId,
  title: z.string().min(1),
  workstream: z.string(),
  status: FindingStatus.default('open'),
  raisedAt: ISO,
  /** when a person last closed it; absent while open, and on a record closed before the date was kept */
  closedAt: ISO.optional(),
  body: z.array(z.string()).default([]),
  sources: z.array(Source).default([]),
  origin: z.enum(['ai', 'chat', 'human']),
  raisedBy: z.string().optional(),
  note: z.string().default(''),
  reviewed: z.object({ by: z.string(), at: ISO }).loose().nullable().default(null),
  /** something has happened since the last assessment that a person should look at: the finding is one to reassess */
  updated: z.boolean().default(false),
  /** what that was, in a few plain words; empty when not marked, or on a record marked before the reason was kept */
  updatedWhy: z.string().default(''),
  /**
   * When the mark came from responses to questions: which questions, by id. The reason is then worded from their numbers as
   * they are now, so that a question that is renumbered is still the one named. `updatedWhy` keeps the words as first written.
   */
  updatedOn: z.object({ questions: z.array(z.string()) }).loose().optional(),
  /** the checklist item whose check raised it, when one did */
  itemId: z.string().optional(),
  /**
   * A person has rewritten the detail: words with no marker after them are theirs and cite nothing. Without it, a detail
   * with no markers at all (an answer saved as a finding) is shown as supported by all its sources.
   */
  ownWords: z.boolean().optional(),
  /** the model wrote the title (a finding made from an issues list's point): shown marked as AI until a person rewrites it */
  aiTitle: z.boolean().optional(),
  /** the model chose the workstream (the same import): bookkeeping between two PCs' imports until a person changes it */
  aiWorkstream: z.boolean().optional(),
  /** a closed finding of the same title that this one was raised after: a person settled that one, and this is a new problem */
  earlier: z.string().optional(),
  /** the points of issues lists it is on: the list (its file's id and name), the point's number there, and its words */
  onLists: z.array(ListPoint).optional(),
}).loose();
export type Finding = z.infer<typeof Finding>;
/** The reason written on a finding that a check on request marked. The backend writes exactly this; the app says it with the date. */
export const CHECK_REASON = 'Check of everything';

export const Tombstone = z.object({
  /** question, finding or deal today; a newer build may note others, which this build keeps and does not list */
  kind: z.string(),
  dealId: DealId,
  id: z.string(),
  title: z.string().default(''),
  at: ISO,
  actor: z.string(),
  /** the record as it was, so Undo can put it back */
  snapshot: z.unknown(),
  /** the issues list (its file's id) whose removal deleted it: that removal's Undo puts it back, whichever PC's removal stands */
  removedWith: z.string().optional(),
}).loose();
export type Tombstone = z.infer<typeof Tombstone>;

export const AuditKind = z.enum([
  'created', 'edited', 'status', 'response', 'responseWithdrawn', 'note', 'document',
  'reviewed', 'unreviewed', 'reassessed', 'deleted', 'restored', 'undone',
  'resolved', // a person chose between versions written on different PCs
]);
export type AuditKind = z.infer<typeof AuditKind>;
export const AuditEntry = z.object({
  at: ISO,
  actor: z.string(),
  kind: AuditKind,
  opId: OpId,
  recordId: z.string(),
  dealId: DealId,
  field: z.string().optional(),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
  ref: z.object({ questionId: QuestionId.optional(), findingId: FindingId.optional(), doc: z.string().optional() }).optional(),
  text: z.string().optional(),
  /** set on entries written by Undo: the operation they reverse */
  undoes: OpId.optional(),
});
export type AuditEntry = z.infer<typeof AuditEntry>;

export const OperationState = z.enum(['pending', 'succeeded', 'failed', 'interrupted', 'discarded']);
export const Operation = z.object({
  id: OpId,
  command: z.string(),
  input: z.unknown(),
  /** record ids this operation writes; used for sequencing and for Undo's rev check */
  targets: z.array(z.string()),
  dealId: DealId.optional(),
  state: OperationState,
  /** the window that started it: its pending work is interrupted only once that window is gone */
  window: z.string().optional(),
  startedAt: ISO,
  settledAt: ISO.optional(),
  error: z.string().optional(),
  /** inverse command, as data, stored only on success */
  inverse: z.object({ command: z.string(), input: z.unknown() }).optional(),
  /** revs of each existing target when this operation started: a retry is refused if any has changed since */
  baseRevs: z.record(z.string(), z.number()).optional(),
  /** revs of each target after this operation committed */
  resultRevs: z.record(z.string(), z.number()).optional(),
  /** when each target was last changed by this operation (its `updatedAt`): a revision number starts again when a record is deleted and restored, so the number alone cannot tell that it has changed since */
  resultAt: z.record(z.string(), z.string()).optional(),
  /**
   * What each record this operation wrote or removed was right after it, keyed by kind and id ("tombstone/q_…"): its rev and
   * time stamp (`updatedAt`, or a tombstone's `at`, with a fingerprint of the tombstone: two PCs can delete at the same moment), or null when the operation removed it. A tombstone shares its record's id,
   * so a key of id alone cannot tell the two apart. Undo refuses when any of them is not as it was.
   */
  results: z.record(z.string(), z.object({ rev: z.number().optional(), at: z.string().optional(), sig: z.string().optional() }).nullable()).optional(),
  undoneBy: OpId.optional(),
  /** a key derived from the UI gesture; a duplicate while pending is dropped */
  idempotencyKey: z.string().optional(),
});
export type Operation = z.infer<typeof Operation>;

/** Stored envelope: what the repository reads and writes. */
export const Envelope = z.object({ schema: z.number().int(), kind: z.string(), rev: z.number().int().nonnegative(), updatedAt: z.string(), data: z.unknown() });
export type Envelope = z.infer<typeof Envelope>;
export const CURRENT_SCHEMA = 1;
/**
 * The schema a record's content needs: the lowest that can carry it. A record is marked with this, not with the schema of
 * the build that wrote it, so that an older build is kept off only the records it would get wrong. Every record needs 1
 * today; the release that adds fields older builds must not change raises CURRENT_SCHEMA and says here which records need it.
 */
export function schemaOf(_kind: string, _data: unknown): number { return 1; }

/** `item`: one checklist item of a deal; `firmList`: the firm's checklist, one record (src/domain/checklist.ts); `member`: a person's place on a deal */
export type RecordKind = 'deal' | 'question' | 'finding' | 'tombstone' | 'op' | 'audit' | 'item' | 'firmList' | 'member';
export const schemaFor: Record<Exclude<RecordKind, 'audit' | 'item' | 'firmList' | 'member'>, z.ZodTypeAny> = {
  deal: Deal, question: Question, finding: Finding, tombstone: Tombstone, op: Operation,
};
/** the kinds a person can have two versions of, and choose between */
export const CLASH_KINDS = ['deal', 'question', 'finding', 'item', 'firmList'] as const;
export type ClashKind = typeof CLASH_KINDS[number];

/** Stable hash of a question's wording so a draft knows what it answered. */
export function wordingHash(text: string): string {
  let h = 2166136261;
  for (const ch of text.trim().replace(/\s+/g, ' ')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16);
}

/**
 * The calendar date of a moment, as the person at this machine sees it (YYYY-MM-DD). Timestamps are
 * stored in UTC; cutting the first ten characters off one gives tomorrow's date on a North American evening.
 */
export function localYmd(iso: string): string {
  const d = new Date(iso); if (isNaN(+d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
