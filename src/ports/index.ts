/**
 * Ports: the seams between the application and the outside world. The demo
 * ships adapters for the browser; the production backend ships its own
 * adapters for the same interfaces. Nothing above this file knows which is
 * in use. Every method returns a Result rather than throwing.
 */
import type { Result } from '../domain/result';
import type { RecordKind, Envelope, Source, Folder, AuditEntry } from '../domain/model';
import type { SheetEdit } from '../domain/sheets';
import type { KeptAsk } from '../domain/keptMerge';

/**
 * expectedRev: number = optimistic check; null = must not exist yet; 'any' = overwrite without a check.
 * `resolves` is set when a person chose between versions of this record: the ids of every version the write replaces.
 */
/**
 * `keepsSchema`: the write is the stored record as it is, with known fields added or changed (the backend's `updated` mark).
 * It is allowed on a record from a newer build, and the record keeps that build's schema.
 */
/**
 * `seen`: for a kind nobody is shown a choice for (a deletion note, a person's own list of deals), the versions the writer
 * had in front of it when the record had more than one. A write to such a record that has gained a version the writer did
 * not see is refused as a conflict, so a window that had not yet read another PC's deletion note cannot set it aside.
 * `alongside`, `deletedAlongside`: on a new record only, more versions of it that stand beside `data` as a choice (other data,
 * or the record deleted): a copy of a record that had two
 */
/** the lines taken in, by PC, as runs of line numbers */
export type Seen = Record<string, [number, number][]>;
export interface Write {
  kind: RecordKind; id: string; data: unknown; expectedRev: number | null | 'any'; resolves?: string[]; keepsSchema?: boolean; seen?: string[]; alongside?: unknown[]; deletedAlongside?: boolean;
  /** written beside the record's current version, not after it: the two stand as two versions for a person to choose between (a version brought back from Deleted while the record is there) */
  beside?: boolean;
}
/** `resolves` as on Write: a person chose the deleted version of a record that had two; the ids of every version it replaces. */
/** `undoesImport`: the delete takes back a question an import made, so the same question imported on another PC still stands */
export interface Delete { kind: RecordKind; id: string; expectedRev: number | null; resolves?: string[]; /** as on Write */ seen?: string[]; undoesImport?: true }

/**
 * One of two or more versions of a record that were written on different PCs, neither knowing of the other.
 * `by` is the person, `from` the PC's name, `at` when it was written, and `here` is true for the one written on this PC.
 * The backend never chooses between them.
 */
/** `deleted`: this version is the record deleted, by someone who had not seen the other version; it has no data. */
export interface Version {
  id: string; by: string; from: string; at: string; data: unknown; here?: boolean; deleted?: boolean;
  /** of a deleted version: the record as the deleting PC had it (the copy in the deletion note written with the delete), so a person sees what was deleted */
  held?: unknown;
  /** of a question's version: every draft request its history held, so a choice can tell a draft it never saw (#22) */
  drafts?: string[];
}

export interface Transaction {
  writes: Write[];
  deletes?: Delete[];
  /**
   * Read-only preconditions: each record must still be at this rev (0 when it does not exist) at commit, or the whole
   * transaction is refused with a conflict. Nothing is written to these records (#88).
   */
  expects?: { kind: RecordKind; id: string; rev: number }[];
  audit?: AuditEntry[];
  /** index membership changes: record ids filed under a deal. `remove` goes with a delete of the same record in the same transaction; on its own it takes nothing off, since a filed record is listed until it is deleted */
  index?: { dealId: string; add?: { kind: RecordKind; id: string }[]; remove?: { kind: RecordKind; id: string }[] };
  /** remove everything filed under this deal in the same transaction: its questions, findings and tombstones, their history, and its index */
  purgeDeal?: string;
  /** with `purgeDeal`: what this PC had taken in when the person began deleting the deal (`Repository.seen`), so work that arrives while they confirm is kept on the PC that made it */
  seen?: Seen;
  /** Undo of a choice between versions: these versions stand again, unchosen. The record is written in the same transaction. */
  reopen?: { kind: RecordKind; id: string; versions: Version[] }[];
  /** who made the change, where its history entries do not say (they are a copy of others' history, say); else the first entry's actor */
  by?: string;
}

/**
 * `conflict` is present only while the record has versions nobody has chosen between. It lists them in an order every PC
 * agrees on (oldest first), and `envelope.data` is then the first of them. A record in this state takes no write except
 * one that `resolves` every listed version. One record's versions never affect another record.
 */
/** `alike`: where versions written on several PCs, each without knowing of the others, say the same and so are one, who wrote each */
export interface Loaded { kind: RecordKind; id: string; rev: number; envelope: Envelope; conflict?: Version[]; alike?: { by: string; from: string; here?: true }[] }

/** What a backend that shares records between PCs can say about the others. */
export interface SyncState {
  /** this PC, as the others see it */
  self: { id: string; label: string; /** something the person must know about this PC, said on every page until it clears: a copied install, say */ note?: string };
  /** every other PC whose changes this one has read; `lastChangeAt` is the time of the newest change of theirs that has arrived */
  peers: { id: string; label: string; by: string; lastChangeAt: string | null }[];
  /**
   * Changes from other PCs that have arrived but are held back, because they were built on a change from `pc` that has
   * not arrived yet; they are taken in the moment it does. Nothing is blocked meanwhile. `label` is that PC's name, null when
   * nothing of its has arrived; `from` names the PCs that made the held changes; `since`: when the newest of them was made (the change it waits on is older still).
   */
  waiting: { pc: string; label: string | null; from: string[]; changes: number; since: string; /** the deals the held changes are about */ deals: string[] }[];
  /** since when this PC's files have been out of touch with the shared folder (OneDrive not running, the folder out of reach); absent while in touch */
  outOfTouchSince?: string;
  /** every record, in any deal, that has versions nobody has chosen between. Each is marked where it is shown once its deal is open. */
  clashes?: { dealId: string; kind: import('../domain/model').ClashKind; id: string }[];
  /**
   * Deals another PC deleted while this PC had changes to them that the deleting PC had not seen, until `recover` has
   * kept them: `name` is the deal's name here, `by` and `from` who deleted it and on which PC, `at` when, `changes` how many
   * of this PC's changes it had not seen.
   */
  unseen?: { dealId: string; name: string; by: string; from: string; at: string; changes: number }[];
}

/** What `recover` made: the copy's deal id, and each record's id in it by its id in the deleted deal. */
export interface Recovered { dealId: string; ids: Record<string, string> }

export interface Repository {
  get(kind: RecordKind, id: string): Promise<Result<Loaded | null>>;
  /** every record of a kind, optionally limited to one deal's index */
  list(kind: RecordKind, dealId?: string): Promise<Result<Loaded[]>>;
  /** all-or-nothing; rejects with conflict/storageFull/unreachable */
  transaction(tx: Transaction): Promise<Result<Record<string, number> /* id → new rev */>>;
  audit(recordId: string): Promise<Result<AuditEntry[]>>;
  /** fires when another tab or user changed a record; `{kind: 'sync'}` when what sync() reports has changed */
  watch(onChange: (change: { kind: RecordKind | 'sync'; id: string }) => void): () => void;
  /** Optional: only a backend that shares records between PCs has anything to report. Asking also means "look again now". */
  sync?(): Promise<Result<SyncState>>;
  /**
   * Optional, with `sync`. Keep a deal listed in `SyncState.unseen` as a new deal named `name`, in `person`'s list, holding
   * everything this PC had of it. Done once: asked again, it gives the copy already made.
   */
  recover?(dealId: string, o: { name: string; person: string }): Promise<Result<Recovered>>;
  /** what this PC has taken in of every PC's changes, now: taken when a person begins deleting a deal, and given with the delete */
  seen?(): Promise<Result<Seen>>;
}

export interface AiService {
  /**
   * `read`, where the backend gives it, is how many documents the answer was read from, out of how many the deal (or deals) hold.
   * `research`, where the backend gives it, is what it did to find the answer (the chat agent's steps), shown above the answer.
   * `runId` names this answer while it is being worked on, so that `research` can be asked how far it has got.
   */
  /** `dealIds`: asked across deals, only these (the person's own deals); every deal in the shared folder when left out */
  /** `thread`: the conversation the model service keeps for this chat, from the last answer; the answer gives back the one to keep next */
  answer(input: { dealId?: string; dealIds?: string[]; /** asked on Home: where the person's own attached files are kept (ownFilesId) */ files?: string; findingId?: string; questionId?: string; message: string; history: { role: 'me' | 'ai'; text: string }[]; model: string; attachments?: DocumentRef[]; runId?: string; thread?: ModelThread; /** the conversation, as the window names it: a folder read carries on within it */ conversation?: string }): Promise<Result<{ text: string; sources: Source[]; read?: { docs: number; of: number }; research?: Research; thread?: ModelThread }>>;
  /**
   * Optional. The steps an answer still being worked on has taken so far (the `runId` it was asked with), for the
   * "Researching" view; null when no answer by that name is being worked on. Read-only and cheap: no model call.
   */
  research?(runId: string): Promise<Result<Research | null>>;
  /**
   * Optional. The person stops an answer still being worked on (the `runId` it was asked with): nothing new is started,
   * and the answer comes back at once from what was found so far. False when no answer by that name is being worked on.
   */
  stop?(runId: string): Promise<Result<boolean>>;
  draft(input: { dealId: string; questionId: string; questionText: string }): Promise<Result<{ status: 'found' | 'none'; text: string; sources: Source[] }>>;
  reassess(input: { dealId: string; findingId: string }): Promise<Result<{ body: string[]; sources: Source[] }>>;
  /** Two short paragraphs on a deal's findings. A phrase may be marked {phrase|findingId} to link it. */
  dealBrief(dealId: string): Promise<Result<{ paragraphs: string[] }>>;
  /** Checklist items with no document behind them. */
  gaps(dealId: string): Promise<Result<{ title: string }[]>>;
  /**
   * Optional. The deal memo's model-written parts: a short summary of facts (may be empty), and a rating of each
   * open finding, by id, against the control file's definitions. A rating holds until the finding's words change. An open
   * finding the model could not rate is left out, and the memo lists it unrated.
   */
  memo?(dealId: string): Promise<Result<{ summary: string[]; ratings: Record<string, import('../domain/memo').Rating>; /** the open findings grouped into risks, the key ones written up (domain/memo `RiskGroup`); absent from a service that does not group them */ risks?: import('../domain/memo').RiskGroup[] }>>;
  /**
   * Optional. Whether an answer from a conversation addresses a question on the deal, asked only when a
   * person presses the button on a suggested open question. The backend judges from the two texts, with no documents,
   * and chooses the model. Only a verdict for the person to read, `why` in one short sentence: it changes nothing.
   */
  addresses?(input: { dealId: string; question: string; answer: string }): Promise<Result<{ verdict: 'yes' | 'partly' | 'no'; why: string }>>;
  /**
   * Optional. One response that reconciles two versions of a question's response (the app's and the Q&A log's):
   * every fact from both, said once, as one answer. Where they disagree, the more specific (a date, a figure, a document
   * reference) stands. Never the two pasted together, and never a note, bracket or placeholder for a person to fill in. It
   * is a draft only: the person reads it, can change it, and chooses whether to use it. No model is named: the fast model's job.
   */
  merge?(input: { dealId: string; question: string; app: string; log: string }): Promise<Result<{ text: string }>>;
  /**
   * Optional. Given the top of each sheet of a spreadsheet, propose where the Q&A table is: which sheet, which row holds the
   * headings, and which heading is which field (by the heading's own text). It is a proposal only: the app checks it against
   * the file, shows it in the import dialog, and the person can change every part before importing.
   *
   * The backend decides how to ask: from `sheets` (the top rows as text, which keeps exact row numbers), or by uploading
   * `bytes` the way other documents are. No model is named: this is a small job for the backend's cheapest model.
   */
  layout?(input: { fileName: string; bytes: Uint8Array; sheets: SheetPreview[]; fields: string[] }): Promise<Result<{ sheet: string; headerRow: number; fields: Record<string, string> }>>;
  /**
   * Optional. Clearer wording for checklist items that are unclear or ask two things at once, as a checklist is brought in
   *. `at` is the item's place in `items`; an item that reads well is left out. An item that joins two
   * conditions comes back as two or more items: `text` and then `also`, each "(if applicable)" only
   * where it may not apply to every deal. Proposals only: each is shown beside its wording and used only if a person
   * checks it. No model is named: this is the fast model's job.
   */
  reword?(input: { items: string[] }): Promise<Result<{ at: number; text: string; why: string; also?: string[] }[]>>;
  /**
   * Optional. What each line of a list is, as a firm's list is brought in: a section or subsection heading, an item
   * (its words as the line has them, numbering and bullets left off), the rest of the item above it, a table's heading row,
   * or not an item. Lines are numbered from 1; `only` asks about just those lines, the others given for context.
   * `thorough` asks the thorough model, for lines the standard model's readings left unplaced. Proposals only: the app
   * checks each reading against its line and accounts for every line (domain/listRead).
   */
  readList?(input: { lines: string[]; only?: number[]; thorough?: boolean }): Promise<Result<import('../domain/listRead').LineRead[]>>;
  /**
   * Optional. Questions for the counterparty, one for each thing `items` lists as unresolved on a deal: a checklist item
   * with no document that settles it (`need` says what would), or an open finding (`what` is its title, `need` its next
   * step). Each question asks plainly for what would settle it, in the deal team's voice. A reply cut off or
   * missing items is asked for again in smaller parts; an item that gets no question even when asked alone is null, for
   * the dialog to name, and the run fails only when no item got one (linking design, section 13). The fast model's job.
   */
  phrase?(input: { dealId: string; items: { kind: 'gap' | 'finding'; what: string; need: string }[] }): Promise<Result<(string | null)[]>>;
  /**
   * Optional. Pairs of checklist items that ask for the same thing, as a checklist is brought in: within `items`, and between
   * an item of `items` and one of `against` (the general list, when a structure, sector or technology list is brought in).
   * Strict: only pairs the model is sure of. Nothing is removed unless a person checks it. The list is asked about in
   * one call where it can be, and in parts where it cannot (a very long list, or a reply too long for the service): when
   * some parts could not be asked and others were, the pairs found are kept and `missed` lists the items that were not
   * compared (`at`), and why. `only` asks about just those items again, so that no pair is left unasked.
   */
  sameMeaning?(input: { items: string[]; against: string[]; only?: number[] }): Promise<Result<{ pairs: { a: number; b: number; inAgainst: boolean; why: string }[]; missed?: { kind: 'unreachable' | 'failed'; at: number[] } }>>;
  /**
   * Optional. The points of an issues list, read from a file a person attached to the deal (`doc`): a PDF, a Word
   * file or an email. Each point keeps its own number on the list (`n`, as the list writes it, or its place when the list
   * numbers nothing) and its words as written (`text`), with a short title and one of `workstreams` for the finding it
   * becomes. `same` names what the point already raises: one of `findings` (by id) or an earlier point (by its place in
   * `points`). Only what the model is sure of is named. The whole list is compared in one call where it can be, as
   * `sameMeaning` does. Proposals only: nothing is recorded until a person imports. No model is named: the fast model's job.
   */
  issuesList?(input: { dealId: string; doc: DocumentRef; findings: { id: string; title: string; text: string }[]; workstreams: readonly string[] }): Promise<Result<{ points: IssuePoint[] }>>;
  /**
   * Optional. Check everything on a deal again, because a person asked: every checklist item and every open finding
   * against the documents as they are now. The quick check uses the cheapest model throughout, has the standard model
   * confirm whatever it flags, and has it check a sample of what it passed. `deep` uses the standard model on everything.
   * A finding is never rewritten: one that may no longer stand is marked (`updated`, with `updatedWhy`) for a person to
   * reassess. New findings and marks reach the app through `watch`, as the first pass's do.
   */
  checkAll?(input: { dealId: string; deep?: boolean; /** only what the latest check left out, while the documents are the ones it checked */ only?: 'left' }): Promise<Result<CheckSummary>>;
  /** Optional. When everything on the deal was last checked, and whether that check's sample suggests the deep one. Read-only and cheap: no model call. */
  checked?(dealId: string): Promise<Result<CheckState>>;
  /**
   * Optional. Told whenever a response may have been recorded on one of the deal's questions. The backend follows
   * through the responses on questions linked to no finding: it works out which open findings such a response could
   * change and marks for reassessment those that no longer stand (`heard` are the questions it looked at this time,
   * `marked` the findings). A response it has looked at is not looked at again, so telling it twice costs nothing.
   * The marks reach the app through `watch`. A response on a question linked to a finding marks that finding in the
   * app itself.
   */
  responses?(dealId: string): Promise<Result<{ heard: string[]; marked: string[] }>>;
  /** Optional. How far the review of a deal has got, from what is recorded. Read-only and cheap: no model call. */
  progress?(dealId: string): Promise<Result<DealProgress>>;
  /** Optional. Every checklist item of a deal and how it stands, from what is recorded. Read-only and cheap: no model call. */
  checklist?(dealId: string): Promise<Result<ChecklistRow[]>>;
}
/**
 * One step the chat agent took: a search of the documents, findings or Q&A, or documents given to it whole. `text` says
 * what it did, in the past tense ("Searched documents for “lock-up”", "Read Credit agreement.pdf"); `result` says what
 * came of it in a few words ("214 listed · 5 opened · 3 passages", "p. 41"); `found` are the passages a search
 * returned, each with where it is. `done` is false only for the step being taken now.
 */
/**
 * The conversation the model service keeps for a chat (decisions: Long conversations), kept with each answer so
 * that the next question carries it on, on whichever PC asks it. `tags` are the documents the model was shown in it, by
 * the tag it cites them by, so that a later answer numbers on from them. `transcript` is the file in the service's store
 * that holds the conversation as it was when it was last compacted. `call` is the tool call the answer was given by, when
 * the model called tools natively: the next question answers it first.
 */
export interface ModelThread { id: string; model: string; tokens: number; tags: { tag: string; dealId: string; docId: string }[]; transcript?: string; call?: string }
export interface ResearchStep { /** 'stop': the person stopped the answer */ kind: 'search' | 'read' | 'stop'; text: string; result: string; done: boolean; found?: { where: string; quote: string }[] }
/** What the chat agent did for one answer: its steps, in order, how long it took in all (milliseconds), and how many of the deal's (or deals') documents a model was given (`read.docs` of `read.of`). */
export interface Research { steps: ResearchStep[]; ms: number; read?: { docs: number; of: number } }
/**
 * One checklist item as it stands. `satisfied`, `finding` and `gap` are results a check came to; `unsettled` is a check
 * that could not come to one; `unchecked` is an item no check has reached. `findingId` is the finding an item came to,
 * `need` what a gap said would settle it, and `docs` the documents that were read for the item when it came to its result.
 */
/**
 * `sources` are the places a satisfied item was settled on: the document, the page (or sheet and cell) and the passage,
 * so that a person can open the page and see it. `why` says what stopped an item that could not be checked. `at` is when
 * the item was last checked. A backend that does not give them is shown without them; nothing is made up in their place.
 */
export interface ChecklistRow { id: string; text: string; result: 'satisfied' | 'finding' | 'gap' | 'unsettled' | 'unchecked'; findingId?: string; need?: string; docs: { docId: string; name: string }[]; /** on a gap: documents given for it that have no readable text (scans, most often), so were not read and are not in `docs` */ unread?: { docId: string; name: string }[]; sources?: { doc: string; docId: string; loc: string; quote?: string }[]; why?: string; at?: string; /** on a gap: what the check's search looked for, and how many documents answered each */ searched?: { q: string; n: number }[] }
/**
 * `read` counts documents that were given to the model in a check of a checklist item that came to a result. Indexed
 * is not read, and described is not read. `folder` is the folder's path as the deal lists it. `unsettled` are checklist
 * items with no result yet.
 */
export interface DealProgress {
  folders: { folder: string; files: number; read: number; core: number; coreRead: number; /** files here that are copies of a document already counted (its first place), so not counted again */ copies?: number }[];
  checklist: { items: number; satisfied: number; findings: number; gaps: number; unsettled: number };
  /** other deals whose data rooms hold most of this deal's documents, the same files by content; `docs` of this deal's are there. Most first. */
  alsoIn?: { dealId: string; docs: number; of: number }[];
}
/** What a check of everything did. `sample` is the spot check: how many of the cheap model's passes the standard model looked at, and how many it overturned. */
/**
 * `unchecked` is what the check could not check: checklist items left unsettled, and findings no model gave a usable
 * answer on. Only when both are zero was everything checked, and only then is `at` given; otherwise it is null and
 * the date of the last complete check stands. A backend that leaves `unchecked` out is taken to have checked everything.
 */
export interface CheckSummary { at: string | null; items: number; findings: number; toReassess: number; newFindings: number; sample: { size: number; overturned: number } | null; offerDeep: boolean; unchecked?: { items: number; findings: number }; /** folders in the data room this PC could not open and no PC has read, as paths inside their deal folder: while there are any the check is not complete */ unread?: string[] }
/** `at` is null until everything has been checked once. `offerDeep` is the spot check that overturned more than one in five, if the last check was a quick one and it did. */
/**
 * Another PC working on a deal, as the person is told of it: the person signed in at it (`who`, as the model service's
 * whoami gives it, such as "jdoe") and the PC's own name (`pc`, its device id). `same` says another PC in the check,
 * this one included, has the same person name, so the device id is needed to tell them apart.
 */
export interface Someone { who?: string; pc: string; same: boolean }
export interface CheckState {
  at: string | null; offerDeep: { size: number; overturned: number } | null;
  /** what the latest check left out that is still not settled, when it ended, and whether the documents have changed since; null when it left nothing out. A backend that leaves it out is not asked to check only those. */
  left?: { items: number; findings: number; at: string; changed: boolean } | null;
  /** a check this PC was asked for that ended while it was out of sync with the shared folder, as it came out; told once */
  ended?: {
    summary?: CheckSummary;
    failed?: string;
    /** a check asked for while out of sync that no round took up: the window starts it now, as asked */
    restart?: 'quick' | 'deep' | 'rest';
  };
  /** while this PC works a round: the other PCs working it, those that went quiet and since when, and until when it is trying again after a failure */
  checking?: { with: Someone[]; quiet: (Someone & { since: string })[]; retryUntil?: string; /** the model service has been out of reach for longer than a person is kept waiting: the check carries on by itself when it is back */ away?: boolean; /** a check asked for here, waiting for another PC's round to finish first */ waitingFor?: Someone; /** this PC's part waits for someone to sign in to the model service */ signIn?: boolean };
}
/** The first rows of one sheet, cells cut short: enough to see where a table starts. `first` is the sheet row number of rows[0]. */
export interface SheetPreview { name: string; first: number; rows: string[][] }

/**
 * How one indexing run spent its time, given once it has finished. `brought` files were read from the data room in this
 * run (copied to this PC first when it has a working folder, read where they are when it has none), `atOnce` at a time;
 * `bytes` is the number of bytes that came across, not the sizes in the listing. `known` needed no reading: already
 * recorded, or known from this session not to turn into pages. `readMs` is the time during which at least one file was
 * being copied across (0 when files are read where they are). `workMs` is the time spent converting and reading pages
 * and words on this PC, including any wait for another conversion; it runs in parallel with the reading, so the two can
 * add up to more than `totalMs`.
 */
export interface IndexTiming { files: number; brought: number; known: number; bytes: number; totalMs: number; readMs: number; workMs: number; atOnce: number }

export interface DocumentService {
  scanFolder(path: string): Promise<Result<{ files: number; size: string }>>;
  /** start indexing; progress is read back through poll() */
  index(dealId: string, folders: Folder[]): Promise<Result<void>>;
  /**
   * How far indexing has got, for every folder of the deal this PC has been asked to index, whichever run covered it.
   * With nothing ever asked here: no folders, `done` true. `done` is true only when no asked folder is unfinished.
   * `stopped` is set when indexing is not running but had not finished (the app was closed part-way, or the run
   * failed): `folders` then says how far each had got when it stopped, so that the app can say so and offer to resume.
   */
  poll(dealId: string): Promise<Result<{ folders: Folder[]; log: string[]; done: boolean; stopped?: boolean; /** with `stopped`: what stopped the last run, in words for a person, when that is known */ why?: string; timing?: IndexTiming }>>;
  /**
   * Look at the folders this PC has indexed for a deal again: each is listed, nothing opened, and compared with what
   * the last run read. When anything was added, changed or removed, indexing starts on that folder and is followed through
   * poll(), as any run. `same` when nothing changed or no folder could be listed; `running` when a run is under way;
   * `unknown` for a deal this PC has never been asked to index. Left out, folders are read only when indexing is asked for.
   * `quietUntil` (ms since 1970): a check of everything starts by then, so a run this look starts that ends before it starts
   * no first pass of its own (the check reads the new documents).
   */
  freshen?(dealId: string, opts?: { quietUntil?: number }): Promise<Result<'same' | 'running' | 'unknown'>>;
  /**
   * One page of one document, for reading mode. The document is addressed by id. It may no longer be in the store: the backend fetches it from the data
   * room again, by its recorded location or else by content hash. `notFound` means no such file exists.
   */
  page(dealId: string, doc: DocumentRef, loc: string): Promise<Result<PageView>>;
  /** index one file into the deal; returns its id and the name it is indexed under */
  attach(dealId: string, file: { name: string; bytes: Uint8Array }): Promise<Result<{ doc: string; docId: string }>>;
  /**
   * A deal deleted on another PC has been kept here as a copy: the files attached on the deal become the copy's too
   * (#117). Left out, a copy has no attached files of its own.
   */
  carryAttached?(fromDealId: string, toDealId: string): Promise<Result<void>>;
  /** Of these documents, those whose file this PC can't send now (#671). Left out, every document is sendable. */
  unsendable?(dealId: string, docIds: string[]): Promise<Result<string[]>>;
  /** ids of the documents loaded in this user's store right now, across all deals. Read-only; changes as the store rotates. */
  cached(): Promise<Result<string[]>>;
  /**
   * The drafts of the document's family, newest first, the document itself among them; empty when it is
   * in no family. `date` is the one read from its folder's name, if any; `folder` is its folder inside the data room.
   */
  drafts(dealId: string, docId: string): Promise<Result<DraftRef[]>>;
  /**
   * Every place the document sits in the deal's folders, its first place first: more than one when the same file is in several
   * places, none when the deal no longer has it. `folder` is its folder inside the data room.
   */
  places(dealId: string, docId: string): Promise<Result<DocPlaceRef[]>>;
  /**
   * Where the deals' folders are on this PC. Each folder not at the path its deal records is looked for at the paths
   * this PC has learned (from folders located here before) and under this person's profile; one found there, with every
   * recorded document there and those checked the same, is used from then on without asking. What is still missing comes back grouped by the top
   * folder a person can point at (`tops`), with how many were placed by this call.
   */
  findFolders(dealIds: string[]): Promise<Result<FolderSearch>>;
  /**
   * A person pointed `top` at `picked`: every missing folder of these deals that this places, here or by the rule it
   * teaches (`X:\Deals\2026` at `\\server\deals\2026` means `X:\` is `\\server\deals`), and whose documents checked
   * are the same there (it may have changed since it was read, and is read again once used). Nothing is saved: the person confirms with placeFolders. `notFound` when `picked` cannot be opened.
   */
  locateTop(dealIds: string[], top: string, picked: string): Promise<Result<FolderPlace[]>>;
  /** Use these places from now on, on this PC, each checked once more; returns how many were saved. What they teach is kept for findFolders. */
  placeFolders(places: FolderPlace[]): Promise<Result<number>>;
  /**
   * The deals among `dealIds` whose data room these folders hold: most of a fixed sample of their files matched by
   * name and size, confirmed by fingerprinting a few. Best first; empty when none. Asked before a new deal is created.
   */
  sameRoom?(paths: string[], dealIds: string[]): Promise<Result<RoomMatch[]>>;
}
export interface FolderPlace { dealId: string; folder: string; local: string }
/** `tops` holds every folder to locate: those missing and those that read as empty (`empty`), which are there with nothing in them */
export interface FolderSearch { placed: number; missing: number; tops: { top: string; folders: { dealId: string; folder: string }[] }[]; empty?: { dealId: string; folder: string }[] }
/** a deal holding the same data room: `matched` of the new folders' `files` (precedents folders not counted) */
export interface RoomMatch { dealId: string; files: number; matched: number }
export interface DocumentRef { doc: string; docId: string }
/** One point of an issues list, as `issuesList` reads it. `same`: the finding (`finding`, by id) or the earlier point (`point`, its place in the list) it repeats. */
export interface IssuePoint { n: string; text: string; title: string; workstream: string; same?: { finding: string } | { point: number } }
export interface DocPlaceRef { folder: string; name: string }
export interface DraftRef { doc: string; docId: string; date: string | null; folder: string }
/** `pages` is the document's page count when it is known, for stepping through its pages in reading mode */
export type PageView = { kind: 'pdf'; url: string | null; page: number; pages?: number } | { kind: 'sheet'; name: string; cols: string[]; rows: { r: number; cells: string[] }[]; cell?: string };

/** LocalStore key for typed draft maps. A null value clears the saved drafts. */
export const KEPT_TEXT_KEY = 'kept-drafts';

/** Per-user, per-machine data that is not a record: preferences, and a cache of conversation threads (their home is the person's files in the shared folder; see ConversationStore). Never part of a transaction. */
export interface LocalStore {
  read(key: string): unknown | null;
  write(key: string, value: unknown): Result<void>;
  /** called when another window of the same person changed a key; returns a function that stops listening */
  watch?(onChange: (key: string) => void): () => void;
}

/** One named part of an import, such as its file, model reading, choices or check marks. */
export interface KeptImportPart { key: string; part: string; value: unknown }
export type KeptImportChange = KeptImportPart | { key: string; drop: true };
export type KeptImportRead = KeptImportPart[] | 'memory' | 'unavailable';

/** Per-machine storage for import drafts. A write commits all its parts together in call order. */
export interface KeptImports {
  /** Memory fallback permits submission only when there is no store. An unavailable store cannot checkpoint. */
  read(onLateOpen: () => void): Promise<KeptImportRead>;
  /** Replace is used when a blocked connection opens after the app has continued with its own snapshot. */
  write(changes: readonly KeptImportChange[], replace?: boolean): Promise<boolean>;
}

/** Existing kept maps for Checklist questions. Record IDs follow a deal when it is recovered as a copy. */
export interface ChecklistDraftMaps {
  texts: Map<string, string>;
  targets: Map<string, string>;
  movedId: (id: string) => string;
}

/** One message of a conversation, as it is kept. An answer still waiting (`pending`) is never kept in the synced folder; the window's local store keeps it, so another window shows it waiting. */
export interface KeptMessage { id: string; role: 'me' | 'ai'; text: string; sources?: Source[]; state: 'done' | 'pending' | 'failed'; at: string; attached?: { doc: string; docId: string }[]; /** what the chat agent did for this answer */ research?: Research; /** the model service's conversation as this answer left it */ thread?: ModelThread }
/**
 * A person's conversations, kept where every PC they use can read them, so a conversation started at the office carries on
 * at home. The desktop backend keeps them in the synced folder (`conversationLog.ts`). Optional: without it,
 * conversations stay in this window's `local` store only (`localConversations` in app/threads.ts). Nobody else's
 * conversations are returned. The Store reads conversations only through this port.
 */
export interface ConversationStore {
  /** every conversation of the person signed in, by conversation key, oldest message first */
  load(): Promise<Result<Record<string, KeptMessage[]>>>;
  /**
   * keep a conversation's messages: those not kept yet, or changed since (an answer retried); the synced folder leaves out any
   * still waiting. `failed` means nothing was kept anywhere; `storageFull` or `unreachable` from the synced folder means they are
   * kept on this PC and shared later.
   */
  save(key: string, messages: KeptMessage[]): Promise<Result<void>>;
  /** another PC added to the person's conversations; returns a function that stops listening */
  watch?(onChange: () => void): () => void;
}

export interface FileSystem {
  /** native folder picker when the shell has one; null means use the browser input */
  pickFolders: null | (() => Promise<Result<string[]>>);
  pathFor: null | ((file: File) => string);
  /** hand a file to the person: a save dialog in the shell (which they may cancel), a download in the browser */
  save(name: string, bytes: Uint8Array, mime: string): Promise<Result<'saved' | 'canceled'>>;
  /**
   * Optional: a save dialog offering one file as more than one kind (the deal memo: Word or PDF), opened before the
   * file is made, so canceling it costs nothing. `name` has no extension, and the first kind is the default. Gives the
   * kind picked and an id for `writePicked`, or null when canceled
   */
  pickSave?(name: string, kinds: { label: string; ext: string }[]): Promise<Result<{ id: string; ext: string } | null>>;
  /** Optional: write the file to the place picked with `pickSave` (once) */
  writePicked?(id: string, bytes: Uint8Array): Promise<Result<'saved'>>;
  /** Optional: open a file written with `writePicked` in the app the PC opens its kind with */
  openPicked?(id: string): Promise<Result<'opened'>>;
}

/** Spreadsheets in and out, and the deal memo out. In the app LibreOffice does them all (backend/spreadsheets); the browser stand-in reads and writes CSV. */
export interface SpreadsheetCodec {
  /**
   * `lines[i]` is the sheet row number of `rows[i]` (the header is row 1 of a sheet that starts at the top); blank rows are
   * left out of `rows`. `opts.sheet` and `opts.headerRow` (a sheet row number) are the person's own choice; without them
   * the reader picks the sheet and finds the heading row, and reports both so the person can see and change them.
   */
  read(bytes: Uint8Array, fileName: string, opts?: { sheet?: string; headerRow?: number }): Promise<Result<{ columns: string[]; /** the sheet column of each column */ cols?: number[]; rows: string[][]; lines?: number[]; sheets?: string[]; sheet?: string; headerRow?: number; lastRow?: number; previews?: SheetPreview[] }>>;
  /** an export: the file's bytes, and the kind of file they make */
  write(sheetName: string, rows: (string | number)[][]): Promise<Result<{ bytes: Uint8Array; ext: 'xlsx' | 'csv' }>>;
  /** Optional: a document's text as lines, for a list brought in from a Word file, an OpenDocument or RTF text, or a PDF. Without it only spreadsheets and plain text can be brought in. */
  text?(bytes: Uint8Array, fileName: string): Promise<Result<string>>;
  /** Optional: the deal memo, given as an OpenDocument text in one file (domain/memoDoc), as a Word file and a PDF. Without it the memo is saved as that file. */
  document?(fodt: string): Promise<Result<{ docx: Uint8Array; pdf: Uint8Array }>>;
}

/**
 * A deal's Q&A log, the file itself where the team keeps it (a NAS, a drive): people edit it there, with or without the app,
 * and the app keeps no copy of its own. `folder` and `file` say where it is.
 */
export interface QaLogFiles {
  /**
   * the log's table as it is now, read as an import reads it (SpreadsheetCodec.read); `stamp` names the bytes read. With
   * `kept` (an update; `text`, `n` and `by`: the question, number and Submitted by columns' places in `columns`), edits a save kept aside in the log's folder are brought in: the table is the log with
   * `kept.steps` made, which the update saves along with its own; `kept.clashes` are rows (indexes into `rows`) with a cell
   * both they and the log changed, where the log's value stays; `kept.files` go, by `settle`, once the update is saved, each
   * with `left` when some of its changes were not brought in, `clashes`, its own rows of `kept.clashes`, and `steps` when some
   * of `kept.steps` are its.
   */
  read(at: { folder: string; file: string }, opts: { sheet: string; headerRow: number; kept?: { text: number; n?: number; by?: number } }): Promise<Result<{ columns: string[]; cols: number[]; rows: string[][]; lines: number[]; lastRow: number; stamp: string; kept?: { files: { name: string; hash: string; left?: true; clashes?: number[]; steps?: true }[]; steps: SheetEdit[]; clashes: number[]; /** rows that read alike, for the person to say where each goes */ ask?: (KeptAsk & { file: string })[] } }>>;
  /**
   * the kept edits an update brought in (`read`'s `kept.files`), once it is saved: each first to the archive, then from the
   * folder. One the archive refuses now is marked as brought in, so it is never merged again, and goes at a later update.
   */
  settle?(req: { folder: string; file: string; kept: { name: string; hash: string; left?: boolean }[] }): Promise<Result<{ gone: string[] }>>;
  /**
   * Write `steps` into the log, which must still be the file read (`stamp`): the version it replaces goes to the folder's
   * archive first. "later": the file is open somewhere (Excel), or changed since it was read; nothing was written.
   */
  save(req: { folder: string; file: string; sheet: string; steps: SheetEdit[]; stamp: string }): Promise<Result<{ status: 'written'; archive: string } | { status: 'later'; by?: string }>>;   // by: who has it open, when their lock file names them
  /** a new log in `folder`, under `file` or, if that name is taken, the first free "name (2).ext"; the name it got */
  create(req: { folder: string; file: string; bytes: Uint8Array }): Promise<Result<{ file: string }>>;
}

export interface Session {
  /** retry: start-up's Retry was pressed, so a closed single sign-on window opens again (only then) */
  load(o?: { retry?: boolean }): Promise<Result<{
    user: { name: string; initials: string }; lastSeen: string;
    models: { id: string; name: string }[]; defaultModel: string;
  }>>;
}

export interface SharedFolderStatus {
  path: string | null;
  found: string[];
  suggested: string | null;
  missing?: string;
}

export interface SharedFolderChoice { path: string; inOneDrive: boolean }

/**
 * Desktop only: the team's shared folder on this PC. Until a person connects one, the app shows only the screen that asks
 * for it (ui/connect.tsx); nothing is saved before that. Settings shows it with Change.
 */
export interface SharedPlace {
  /**
   * The folder in use (null until one is connected), the Punchlist folders on this PC that already hold the team's
   * records (looked for afresh on each call), the Punchlist folder in OneDrive to suggest when there are none (null
   * without OneDrive), and why the folder in use cannot be opened, if it cannot.
   */
  get(): Promise<Result<SharedFolderStatus>>;
  /** the folder picker; null when the person cancels. `inOneDrive` is false for a folder OneDrive does not sync. */
  pick(): Promise<Result<SharedFolderChoice | null>>;
  /** use this folder from now on, on this PC: the app starts again on it */
  use(path: string): Promise<Result<void>>;
}

export interface SignInStatus {
  signedIn: boolean;
  sso: boolean;
  apiKey: boolean;
  firstSetup?: boolean;
  problem?: string;
}

/**
 * Signing in to Intelligence, in the desktop app; absent in the browser demo. Which ways are offered come from the
 * control file (signIn.sso, signIn.apiKey); `status` says which, so the screen shows only those.
 */
export interface AiSignIn {
  /** whether a token or key is held on this PC that has not expired, which ways of signing in are offered, and why
   * single sign-on stopped opening by itself when the provider kept refusing its token. `firstSetup`: this PC has never
   * signed in, so the window shows only the sign-in page until it does (decisions: "Intelligence sign-in"). */
  status(): Promise<Result<SignInStatus>>;
  /** single sign-on: the provider's sign-in page in the app's own window; the token is taken from the SSO site's cookie */
  signIn(): Promise<Result<void>>;
  /** use an API key the person pasted, once the service has accepted it; it is kept like a token from single sign-on.
   *  A refused key fails as `invalid`, no answer as `unreachable`; either way the key in use stays. */
  paste(token: string): Promise<Result<void>>;
}

export interface Clock { now(): string }
export interface Ids { next(prefix: 'd' | 'q' | 'f' | 'doc' | 'op'): string }

export interface Services {
  repo: Repository;
  ai: AiService;
  docs: DocumentService;
  fs: FileSystem;
  sheets: SpreadsheetCodec;
  session: Session;
  local: LocalStore;
  /** where conversations are kept for every PC the person uses; without it they stay in `local` */
  conversations?: ConversationStore;
  /** the desktop app's shared folder; absent in the browser demo */
  place?: SharedPlace;
  /** signing in to Intelligence; absent in the browser demo */
  signin?: AiSignIn;
  /** each deal's Q&A log, the team's own file where it lives; absent where there are no files (the browser demo) */
  qaLogs?: QaLogFiles;
  clock: Clock;
  ids: Ids;
}
