/**
 * The app's storage, kept as change files in a folder that a sync client (OneDrive) carries between PCs.
 *
 *   shared folder   changes-<install id>-<deal id or _>-<number>.jsonl
 *                       An installed copy appends to its own files and reads everyone's. Each deal has its own files, so a
 *                       deal nobody is working on is never synced again; `_` holds the deals themselves and the list of them.
 *                       A file that reaches the size limit is left as it is and the next number is started, so the file
 *                       that changes on each save, and has to be carried by the sync client, stays small.
 *   local folder    install.json    this copy's random id, and the shared folder it is for (another folder, another id)
 *                   changes-…       a full copy of each of its own change files, outside the synced folder
 *                   ops.json        the undo journal, which stays on this PC (on the desktop ops-<id>.json, one for each shared folder)
 *
 * No file is ever written by two PCs, so the sync client has nothing to reconcile. A file that turns up twice (a cloned
 * install, a restored folder, a conflict copy) is read like any other: lines are told apart by what they say, not by
 * the file they are in. How lines become records is in changeLog.ts.
 */
import type { Repository, Transaction, Loaded, Version, SyncState, Recovered, Write, Delete, Seen } from '../ports';
import { CURRENT_SCHEMA, CLASH_KINDS, Envelope, schemaOf, type AuditEntry, type ClashKind, type RecordKind } from '../domain/model';
import { ok, fail, type Result, type Failure } from '../domain/result';
import { Combined, isLine, recKey, type Line, type RecChange, type RecState } from './changeLog';
import type { Ver } from './changeLines';
import { shareOwn, wholeLines } from './ownFile';
import { LocalChanges } from './localChanges';
import { recoveredWriteClashes } from './recoveredWrite';
import { changedOnto, recoveredDeal, recoveredId, recoveredIds, remap, type Had } from '../domain/recovered';

/** A folder, as much of one as this needs. `size` is in bytes, -1 for no such file. `append` and `write` may throw; a full disk throws with code ENOSPC. */
export interface Folder { list(): string[]; size(name: string): number; read(name: string): string | null; append(name: string, text: string): void; write(name: string, text: string): void }

/** a held change made this long ago whose base has still not come is taken as lost: the day after which a wait no
 * longer lights the avatar */
const STUCK_AFTER = 24 * 60 * 60_000;
/** and it must have been held in this run of the app this long, for what is still syncing to arrive */
const SETTLE_FIRST = 15 * 60_000;
/** why a deal cannot be deleted while changes to it are still to arrive */
export const WAITING_DELETE = 'Changes to this deal from another PC are still arriving. Delete it once they have.';
/** why a change to a deal that has been deleted is not written: it would go with the deal, unseen */
export const DEAL_DELETED = 'This deal has been deleted. Make the change in its recovered copy.';
export const DEAL_GONE = 'This deal has been deleted.';

export interface LogRepositoryOptions {
  shared: Folder; local: Folder;
  /** this PC's name as the others will see it beside its changes */
  label: string;
  /** the person at this PC, for changes that carry no history entry of their own */
  user: () => string;
  clock?: () => string;
  newId?: () => string;
  /** a change file this big is finished with and the next one started (default 1 MB) */
  segmentBytes?: number;
  /**
   * Who this install belongs to: the machine's own id and the Windows user (the shell gives `MachineGuid` and the user's SID).
   * Kept beside the install id; when it differs at start, the folder was copied from another PC and a new install id is taken.
   */
  machine?: () => string;
  /**
   * The shared folder, as the shell names it. Kept beside the install id; when it differs at start, a person has connected
   * another folder, and this PC starts there as a new install: nothing it kept for the last folder (its copies of its own
   * files, its undo journal) is put into the new one.
   */
  place?: string;
  /** where the undo journal (`ops.json`) is kept, if not in `local`: the browser demo keeps it where all its tabs share it */
  journal?: Pick<Folder, 'read' | 'write'>;
  /** whether this PC's files are in touch with the shared folder (OneDrive running, the folder reachable): the shell asks Windows */
  inTouch?: () => boolean | Promise<boolean>;
}

/** What install.json holds (see `LogRepository.install`). */
type Installed = { id?: string; machine?: string; place?: string; ids?: Record<string, string>; lastIds?: Record<string, string>; lost?: true };
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isTexts = (v: unknown): v is Record<string, string> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isText);
/**
 * install.json read whole, or what is still whole in it. A file that does not parse (cut off by a crash or a full
 * disk, or written over in part) is searched for each field it holds: a text field (`"id":"…"`) or a map of them
 * (`"ids":{…}`) that is whole is kept, the rest is left out. A field of the wrong shape is left out too.
 */
function readInstalled(text: string): { saved: Installed; damaged: boolean } {
  let raw: unknown; try { raw = JSON.parse(text); } catch { raw = undefined; }
  const parsed = !!raw && typeof raw === 'object' && !Array.isArray(raw);
  const saved: Installed = {}; let damaged = !parsed;
  const field = (k: keyof Installed): unknown => {
    if (parsed) return (raw as Record<string, unknown>)[k];
    const m = new RegExp(`"${k}"\\s*:\\s*("(?:[^"\\\\\\n]|\\\\.)*"|\\{(?:"(?:[^"\\\\\\n]|\\\\.)*"|[^{}"])*\\})`).exec(text);   // the first, as a parse would see the top-level one: it is written first
    try { return m ? JSON.parse(m[1]) : undefined; } catch { return undefined; }
  };
  for (const k of ['id', 'machine', 'place'] as const) { const v = field(k); if (isText(v)) saved[k] = v; else if (v !== undefined) damaged = true; }
  for (const k of ['ids', 'lastIds'] as const) { const v = field(k); if (isTexts(v)) saved[k] = v; else if (v !== undefined) damaged = true; }
  if (parsed ? (raw as Installed).lost === true : /"lost"\s*:\s*true/.test(text)) saved.lost = true;
  return { saved, damaged };
}
/** what this PC keeps about itself, and a spare copy of it (see `installed`) */
const INSTALL = 'install.json', SPARE = 'install.spare.json';
/** the install id in a change file's name (`changes-<id>-<deal>-<number>.jsonl`), or null */
const idOfFile = (name: string) => /^changes-(.+)-[A-Za-z0-9_]+-\d{4,}\.jsonl$/.exec(name)?.[1] ?? null;

/** A file's whole lines under an id (one cut off, or ended by healing a torn write, is passed over). */
function linesOf(text: string, id: string): { l: string; at: string }[] {
  return text.split('\n').flatMap((l) => {
    try {
      const x = JSON.parse(l);
      return isLine(x) && x.pc === id ? [{ l, at: x.at }] : [];
    } catch {
      return [];
    }
  });
}

/** Whether a folder record (`place-<id>.json`) marks its id as left after a copy was found (#29). */
function leftIn(record: string | null): boolean {
  try {
    return JSON.parse(record ?? 'null')?.left === true;
  } catch {
    return false;
  }
}

const AUDIT_KEEP = 200;
const CHANGE_FILE = /^changes-.+\.jsonl$/;
/** a change file's deal (or `_`), from its name; a name of any other shape (a sync client's conflict copy, say) is null */
const SCOPE = /^changes-.+-([A-Za-z0-9_]+)-(\d{4,})\.jsonl$/;
/**
 * Records that are only ever written with the deals, in `_`, which is read at start: the deals themselves, who has which deal
 * (members are indexed under `_`, so start-up reads them together) and the firm's checklist (it names no deal).
 */
/** the kinds of record kept in the change files (the undo journal's `op` is not) */
const KINDS: readonly RecordKind[] = ['deal', 'question', 'finding', 'tombstone', 'item', 'firmList', 'member'];
const ONLY_IN_DEALS: ReadonlySet<RecordKind> = new Set<RecordKind>(['deal', 'member', 'firmList']);
const bytes = (text: string) => new TextEncoder().encode(text).length;
/** the part of the files that holds the deals themselves and the list of them */
const GLOBAL = '_';

const full = (e: any) => e?.code === 'ENOSPC' || e?.name === 'QuotaExceededError' || /ENOSPC|no space|quota/i.test(String(e?.message));

/** what a read or write of the undo journal is told while the file has not been read yet and will not open */
const UNOPENED = { kind: 'failed' as const, message: 'The undo journal can’t be opened just now. Try again in a moment.' };
/**
 * The undo journal: a few hundred small entries (kind `op`) in one local file, `ops.json`, rewritten whole when one changes,
 * so a transaction on it is all-or-nothing. Each entry has a rev, and a write names the rev it read or is refused, as a
 * record's is. The file is looked at again for every call, so windows that share it (the browser demo's tabs) see each
 * other's entries. Each entry is kept under `dil/1/op/<id>`.
 */
class Journal {
  constructor(private folder: Pick<Folder, 'read' | 'write'>, private clock: () => string, private file = 'ops.json') {}
  /** the file as last read or written, and its entries with each one's text: read again only when the file has changed. `damaged`: it did not read whole */
  private last: { text: string | null; map: Map<string, { env: Envelope; json: string }>; damaged?: boolean } | null = null;
  /** the damaged text last kept aside (see keepAside) */
  private aside: string | null = null;
  private all() {
    // A read refused for a moment (another program holding the file) is not an empty journal: what was last read or written
    // stands, and with nothing read yet the journal is not written over at all (see `transaction`), so no entry is lost.
    let text: string | null = null; this.unread = false;
    try { text = this.folder.read(this.file); } catch { this.unread = true; if (this.last) return this.withOwed(new Map(this.last.map)); }
    if (this.last?.text !== text || this.unread) {
      const { map, damaged } = readJournal(text);
      if (this.unread) return map;                                     // nothing read yet: empty for now, and not kept
      this.last = { text, map, damaged };
      if (damaged) this.keepAside();                                   // tried again before the next write if it fails now
    }
    return this.withOwed(new Map(this.last.map));
  }
  /**
   * A journal that does not read whole (cut off by a crash or a full disk, or written over in part by another program) is
   * read for every entry in it that is whole, and a copy of it as it was is kept beside it before the journal is written
   * again (`ops-<id>.damaged-<when>.json`), so nothing in it is lost to the next write. Returns why the copy could
   * not be kept, or null once it is (or there is nothing to keep).
   */
  private keepAside(): unknown {
    const text = this.last?.text;
    if (text == null || !this.last?.damaged || this.aside === text) return null;
    try {
      if (text.trim()) {                                               // an empty file has nothing in it to keep
        const stem = `${this.file.replace(/\.json$/, '')}.damaged-${this.clock().replace(/[:.]/g, '-')}`;
        let name = `${stem}.json`; for (let n = 2; this.folder.read(name) != null; n++) name = `${stem}-${n}.json`;
        this.folder.write(name, text);
      }
      this.aside = text; return null;
    } catch (e) { return e; }
  }
  /** set while the file could not be read just now */
  private unread = false;
  static needsReceipt(data: unknown): boolean {
    const state = (data as { state?: unknown } | null)?.state;
    return state === 'pending' || state === 'interrupted';
  }

  /** an entry found settled at start whose write has not gone through yet reads as settled, until the file says so itself */
  private withOwed(map: Map<string, { env: Envelope; json: string }>) {
    for (const [id, env] of this.owed) {
      const current = map.get(id)?.env;
      if (current && current.rev === env.rev - 1 && Journal.needsReceipt(current.data)) {
        map.set(id, { env, json: JSON.stringify(env) });
      } else this.owed.delete(id);
    }
    return map;
  }
  /**
   * Entries found settled at start (`landed`) whose journal could not be written then (busy, disk full). They are read as
   * succeeded meanwhile, so the window does not mark them interrupted and offer a Retry that would do them twice, and are
   * written with the next write of the journal that goes through.
   */
  private owed = new Map<string, Envelope>();
  private loaded(id: string, env: Envelope): Loaded { return { kind: 'op', id, rev: env.rev, envelope: env }; }
  /** the entries still marked pending: actions that had not settled when the journal was last written */
  pending(): string[] {
    return [...this.all()].filter(([, entry]) => Journal.needsReceipt(entry.env.data)).map(([id]) => id);
  }
  /** Mark these pending entries as succeeded: their change is in this PC's change file. A journal that cannot be written now writes them later (see owed). */
  landed(ids: string[], writeNow = true) {
    const map = this.all(); const now = this.clock();
    for (const id of ids) {
      const e = map.get(id)?.env;
      if (!e || !Journal.needsReceipt(e.data)) continue;
      const data = { ...(e.data as object), state: 'succeeded', settledAt: now };
      this.owed.set(id, { schema: schemaOf('op', data), kind: 'op', rev: e.rev + 1, updatedAt: now, data });
    }
    if (writeNow && this.owed.size) void this.transaction({ writes: [] }, true);
  }
  /** whether the journal can be read, now or as last read: false while it has not been read yet and is refused */
  readable() { this.all(); return !(this.unread && !this.last); }
  async get(id: string): Promise<Result<Loaded | null>> { const m = this.all(); if (this.unread && !this.last) return fail(UNOPENED); const e = m.get(id); return ok(e ? this.loaded(id, e.env) : null); }
  async list(): Promise<Result<Loaded[]>> { const m = this.all(); if (this.unread && !this.last) return fail(UNOPENED); return ok([...m].map(([id, e]) => this.loaded(id, e.env))); }
  /** Why the journal would refuse `tx` as it stands, or null: the checks of `transaction`, with nothing written. */
  refusal(tx: Pick<Transaction, 'writes' | 'deletes'>, map = this.all()): Failure | null {
    if (this.unread && tx.writes.some(({ expectedRev }) => typeof expectedRev === 'number')) return UNOPENED;
    for (const w of tx.writes) {
      const cur = map.get(w.id)?.env;
      if (cur && cur.schema > CURRENT_SCHEMA && !w.keepsSchema) return { kind: 'rejected', message: NEWER };
      if (w.expectedRev === null && cur) return { kind: 'conflict', message: CHANGED, recordId: w.id, actual: cur.rev };
      if (typeof w.expectedRev === 'number' && (cur?.rev ?? 0) !== w.expectedRev) return { kind: 'conflict', message: CHANGED, recordId: w.id, expected: w.expectedRev, actual: cur?.rev ?? 0 };
    }
    for (const d of tx.deletes ?? []) {
      const cur = map.get(d.id)?.env;
      if (cur && cur.schema > CURRENT_SCHEMA) return { kind: 'rejected', message: NEWER };
      if (d.expectedRev !== null && (cur?.rev ?? 0) !== d.expectedRev) return { kind: 'conflict', message: CHANGED, recordId: d.id, expected: d.expectedRev, actual: cur?.rev ?? 0 };
    }
    return null;
  }
  async transaction(
    tx: Pick<Transaction, 'writes' | 'deletes'>, fresh = false,
  ): Promise<Result<Record<string, number>>> {
    const map = this.all(); const revs: Record<string, number> = {};
    // Recovering one receipt must never replace another window's newer journal entries with this cache (#565).
    if (this.unread && (fresh || !this.last)) return fail(UNOPENED);
    const no = this.refusal(tx, map); if (no) return fail(no);
    // a damaged journal is written over only once a copy of it is kept aside
    const notKept = this.keepAside(); if (notKept) return fail(full(notKept) ? { kind: 'storageFull', message: 'The disk is full' } : UNOPENED);
    const now = this.clock();
    for (const w of tx.writes) {
      const cur = map.get(w.id)?.env; const rev = (cur?.rev ?? 0) + 1; revs[w.id] = rev;
      const env: Envelope = { schema: Math.max(w.keepsSchema ? cur?.schema ?? 0 : 0, schemaOf('op', w.data)), kind: 'op', rev, updatedAt: now, data: w.data };
      map.set(w.id, { env, json: JSON.stringify(env) });
    }
    for (const d of tx.deletes ?? []) map.delete(d.id);
    const saved = this.writeEntries(map);
    return saved.ok ? ok(revs) : saved;
  }

  private writeEntries(map: Map<string, { env: Envelope; json: string }>): Result<void> {
    // put together from each entry's text, so a write costs the entries it changes, not all of them
    const text = `{${[...map].map(([id, e]) => `${JSON.stringify(OP + id)}:${e.json}`).join(',')}}`;
    try {
      this.folder.write(this.file, text);
    } catch (error) {
      return fail(full(error) ? { kind: 'storageFull', message: 'The disk is full' }
        : { kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
    this.last = { text, map };
    return ok(undefined);
  }
}
const OP = 'dil/1/op/';

/**
 * The entries of a journal file's text, and whether any part of it could not be read. A file that does not parse (cut off
 * part way, or with bytes written over) is searched for each `"dil/1/op/<id>":{…}` that is whole, so a damaged entry costs
 * only itself. An entry that is there twice reads as its last, as a parse would.
 */
function readJournal(text: string | null): { map: Map<string, { env: Envelope; json: string }>; damaged: boolean } {
  const map = new Map<string, { env: Envelope; json: string }>(); let damaged = false;
  const take = (k: string, v: unknown) => { try { const env = Envelope.parse(v); map.set(k.slice(OP.length), { env, json: JSON.stringify(env) }); return true; } catch { return false; } };
  if (text == null) return { map, damaged };
  let raw: unknown; try { raw = JSON.parse(text); } catch { raw = undefined; }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (!k.startsWith(OP) || !take(k, v)) damaged = true;    // a damaged entry is left out, and the file kept aside
    return { map, damaged };
  }
  const key = `"${OP}`;
  for (let at = text.indexOf(key); at >= 0;) {
    let next = at + key.length;
    const k = stringEnd(text, at);
    if (k > 0) {
      let i = k; while (/\s/.test(text[i] ?? '')) i++;
      if (text[i] === ':') {
        i++; while (/\s/.test(text[i] ?? '')) i++;
        const end = objectEnd(text, i);
        // an entry that lost a closing brace runs on into the entries after it: it is left out, so they are read for themselves
        if (end > 0 && !keyAt(text, text.indexOf(key, i), end)) { try { if (take(JSON.parse(text.slice(at, k)), JSON.parse(text.slice(i, end)))) next = end; } catch { /* not a whole entry */ } }
      }
    }
    at = text.indexOf(key, next);
  }
  return { map, damaged: true };
}
/** whether an entry's key (`"dil/1/op/…":`) starts at or after `at`, before `end`. A key of that shape inside an entry's own data would count too; no action's data has one. */
function keyAt(text: string, at: number, end: number) {
  for (; at >= 0 && at < end; at = text.indexOf(`"${OP}`, at + 1)) {
    let i = stringEnd(text, at); if (i < 0) continue;
    while (/\s/.test(text[i] ?? '')) i++;
    if (text[i] === ':') return true;
  }
  return false;
}
/** the index just past the end of the JSON string that opens at `at`, or -1 when it does not end */
function stringEnd(text: string, at: number) {
  for (let i = at + 1; i < text.length; i++) { if (text[i] === '\\') i++; else if (text[i] === '"') return i + 1; else if (text[i] === '\n') return -1; }
  return -1;
}
/** the index just past the end of the JSON object that opens at `at`, or -1 when there is none or it does not end */
function objectEnd(text: string, at: number) {
  if (text[at] !== '{') return -1;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { i = stringEnd(text, i) - 1; if (i < 0) return -1; }
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) return i + 1;
  }
  return -1;
}

/** A record last written by a newer build of the app is not changed by this one: it would drop or contradict what the newer build knows. */
/** what a read or write is told when a deal's files are needed and the shared folder cannot be listed just now */
const UNREADABLE = { kind: 'unreachable' as const, message: 'The Punchlist folder cannot be read' };
/**
 * what they are told when the folder can be read but one of the files needed cannot be opened just now (a sync client holding
 * it): not "unreachable", which the window takes for being offline, since nothing is wrong with the connection
 */
const LOCKED = { kind: 'failed' as const, message: 'Part of the Punchlist folder can’t be opened just now. Try again in a moment.' };
const NEWER = 'This was last changed on a newer version of Punchlist. Update this PC to change it.';
// Said on screen as they are (an Undo's refusal, say), so they name no record id: the failure carries it as `recordId`.
// A held draft's notice tells the two apart by the word "versions" (store.ts, sayHeld), so TWO_VERSIONS keeps it.
const TWO_VERSIONS = 'Another PC changed this at the same time, and nobody has chosen between the two versions yet, so nothing was changed';
const CHANGED = 'Changed on another PC since it was read, so nothing was changed';
/**
 * Is this a kind whose versions a person is asked to choose between? Only those refuse a write while the choice is open.
 * A deletion note or a person's own list of deals can have two versions too (a record deleted on two PCs writes two
 * notes), but no screen offers a choice between them, so refusing would shut the record for good: a deleted record could
 * never be restored, and a delete beside an edit could never be chosen between. A write to such a kind is
 * taken when the writer had seen every version there is (`seen` on the write); it is based on all of them, so it
 * replaces them all, on every PC. One that had not seen them all is refused as a conflict, to be read again first.
 */
const asksAPerson = (kind: RecordKind) => (CLASH_KINDS as readonly string[]).includes(kind);
/** what a person is told when this install's folder turns out to have been copied from another PC */
export const COPIED = 'This copy of Punchlist was copied from another PC, which is also using it. Restart Punchlist here to carry on: it will start under a name of its own.';

export class LogRepository implements Repository {
  private changes: LocalChanges;
  readonly id: string;
  /** the start-up settle of the journal, while it waits for the journal to open (see the constructor) */
  private settle: (() => void) | null = null;
  private settleNow() { if (this.settle && this.ops.readable()) { const f = this.settle; this.settle = null; f(); } }
  /** set when another install is found writing under this one's id: nothing more is written until the app is started again */
  private cloned = false;
  /** the id this install had before it took a new one in the same folder (a copy found): its journal was carried over, and its lines may settle entries in it */
  private previous: string | null = null;
  /**
   * For each shared folder where this install took a new id (a copy found), the id it had there before. Kept in install.json
   * until the new id is used in that folder, whenever that is, and after: so the undo journal goes with it however the PC
   * gets back to the folder (a change of folder first, a failed start), and lines under the last id still settle its entries.
   */
  private lastIds: Record<string, string> = {};
  /** set once what this PC kept about itself was lost: the ids it had in other folders may be gone with it, so each is looked for in its own change files there */
  private lost = false;
  /** every line this install has written, as text, from its own copy: a line under its id that is not here was written by another install */
  private ownLines = new Set<string>();
  /** per deal (or `_`): the number of the file this copy is appending to, and that file's size */
  private segment = new Map<string, { n: number; size: number }>();
  private view = new Combined();
  private seq = 0;
  private read = new Map<string, number>();                 // file name → how much of it has been taken in
  private ops: Journal;
  private clock: () => string;
  private watchers = new Set<(change: { kind: RecordKind | 'sync'; id: string }) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSync = '';
  private outSince: string | null = null;                   // when this PC's files were found out of touch with the shared folder, while they still are (kept in touch.json, so a restart does not reset it)

  /** this PC's install id in each shared folder it has used, so going back to one carries on under the id it had there */
  private ids: Record<string, string> = {};

  /**
   * Start-up reads the deals first and each deal's files in the background; an opened deal jumps the queue (decisions:
   * Storage). The deals and the list of them (`_`), and any file whose deal its name does not tell, are read before the
   * constructor returns. Each deal's files are then read one deal at a time, between other work. A deal asked for before
   * its turn (opened in the window, read by a check, written to) is read at once, so nothing is ever judged or shown from
   * a deal only partly read.
   */
  private readScopes = new Set<string>();
  /** deals whose files have not been read yet, in the order they will be */
  private pending: string[] = [];
  /** set once every deal has been read: from then on every file is read as it changes */
  private allRead = false;
  private stepTimer: ReturnType<typeof setTimeout> | null = null;
  /** background reads that failed in a row (see nextStep) */
  private misses = 0;
  private whenAllRead: Promise<void>; private doneReading!: () => void;

  constructor(private o: LogRepositoryOptions) {
    this.clock = o.clock ?? (() => new Date().toISOString());
    this.whenAllRead = new Promise((r) => { this.doneReading = r; });
    const { saved, lost, texts } = this.installed();
    let id = saved.id ?? ''; const machine = saved.machine; let copied = false;
    this.ids = { ...(saved.place && id ? { [saved.place]: id } : {}), ...(saved.ids ?? {}) };
    const here = o.machine?.();
    this.lastIds = { ...(saved.lastIds ?? {}) }; this.lost = lost || !!saved.lost;
    // a folder copied to another PC, or to another Windows user, is a new install: it must not write under the first one's ids.
    // The id it had in each folder is kept, so its undo journal there is taken over by the new id.
    // A folder's id that never got its journal (it was taken when a copy was found, and the PC was copied again before it went
    // back there) leaves the id before it in place, whose journal still holds that folder's Undo.
    if (here && machine && machine !== here) {
      const j = o.journal ?? o.local;
      for (const [p, i] of Object.entries(this.ids)) if (!this.lastIds[p] || j.read(`ops-${i}.json`) != null) this.lastIds[p] = i;
      id = ''; this.ids = {}; copied = true; this.lost = false;           // a new install: what it finds is the first PC's
    }
    // another shared folder: this PC's id there (a new one the first time), so what it wrote in the last folder stays out of this one
    if (id && o.place && saved.place && saved.place !== o.place) id = this.ids[o.place] ?? '';
    // No id known for this folder, and what this PC kept about itself lost, now or before: the id its own change files
    // there give, so it carries on under it with its undo journal
    if (!id && !copied && this.lost) id = this.ownId(saved) ?? '';
    if (!id) id = (o.newId ?? (() => globalThis.crypto.randomUUID()))();
    this.id = id; if (o.place) this.ids[o.place] = id;
    // The undo journal (with its interrupted actions and the saves still to be written) goes with the install to its new id in
    // this folder: copied before install.json is written, and only if the new id has none yet, so a start that fails here has
    // changed nothing and the next one does it again. No app on this PC is writing the last id's journal by now.
    const carry = o.place ? this.lastIds[o.place] : undefined;
    if (carry && carry !== id) {
      const j = o.journal ?? o.local;
      if (j.read(`ops-${id}.json`) == null) { const text = j.read(`ops-${carry}.json`); if (text != null) j.write(`ops-${id}.json`, text); }
      this.previous = carry;
      this.keepPlaceRecord(carry, true);
    }
    const now = this.install(id);
    this.keepPlaceRecord(id);
    this.keepInstall(JSON.stringify(now), texts);
    this.changes = new LocalChanges(o.local, id);
    this.ownLines = new Set(this.changes.ownLines(id));
    this.seq = this.changes.seq;
    // the number of its last line, from its own copy of every deal's files: a change written before a deal is read must not
    // reuse a number. A line starts {"v":1,"schema":…,"pc":"<id>","seq":N, so the first "seq" in it is the line's own
    for (const l of this.ownLines) { const m = /"seq":(\d+)/.exec(l); if (m) this.seq = Math.max(this.seq, Number(m[1])); }
    // The undo journal speaks of one folder's records: undone in another folder, it would write them there. On the desktop
    // (which names its shared folder) each folder's install id has a journal file of its own, so a change of folder moves
    // nothing, and no step of one can lose Undo. The browser demo's tabs share one journal.
    this.ops = new Journal(o.journal ?? o.local, this.clock, o.place ? `ops-${id}.json` : 'ops.json');
    if (o.inTouch) try { const t = JSON.parse(o.local.read('touch.json') ?? '{}'); if (typeof t?.outSince === 'string') this.outSince = t.outSince; } catch { /* in touch, as far as is known */ }
    this.restore();
    // The journal entries left pending by the last run whose change is in this PC's own copy: the action was cut off after its
    // line was written and before its entry was settled (the line is put back in the shared folder from that copy just above).
    // Each is marked succeeded, so it is not offered for a Retry that would do it twice. Read from the copy kept here,
    // not the shared files, since a deal's files are read only later, in the background.
    // A journal that cannot be read just now (another program holding it) is settled at its first good read instead, before
    // anything reads or writes an entry, so the window never takes such an entry for interrupted.
    const settle = () => this.settleWrittenOperations();
    if (this.ops.readable()) settle(); else this.settle = settle;
    // where each of its own files has got to
    const own = `changes-${id}-`;
    for (const name of o.shared.list()) {
      const m = name.startsWith(own) ? /^([A-Za-z0-9_]+)-(\d+)\.jsonl$/.exec(name.slice(own.length)) : null;
      if (!m) continue;                                                           // anything else (a copy left by a sync conflict, say) is read but never appended to
      const n = Number(m[2]); const cur = this.segment.get(m[1]); if (!cur || n > cur.n) this.segment.set(m[1], { n, size: Math.max(0, o.shared.size(name)) });
    }
    // the deals and the list of them are read now (a file of them that will not open is tried again, and meanwhile reads and
    // changes are refused rather than going by part of the list); each deal's own files follow in the background
    this.refresh(false);
    this.readScope(GLOBAL);
    // except a file under this PC's own id that is not as it was kept here: another PC copied from this one may be writing in
    // it, and that must be found before this one writes anything. One that matches its copy holds nothing new.
    try { for (const n of o.shared.list()) if (n.startsWith(own) && CHANGE_FILE.test(n) && !this.isRead(this.scopeOf(n)) && o.shared.size(n) !== o.local.size(n)) this.readFiles([n], new Set()); } catch { /* looked at again when the deal is read */ }
    this.lastSync = JSON.stringify(this.syncNow());
    this.nextStep();
  }

  /**
   * The deal a change file belongs to, from its name: `_` for the deals themselves, and for a name that does not say for sure.
   * A sync client's copy of a file gets a suffix (`…-d1-0001-LAPTOP-2024.jsonl`); a name with the deal and number shape twice
   * could be either, so it is read with the deals at start rather than taken for a deal of its own.
   */
  private scopeOf(name: string): string {
    const m = SCOPE.exec(name); if (!m) return GLOBAL;
    const pc = name.slice('changes-'.length, name.length - `-${m[1]}-${m[2]}.jsonl`.length);
    return /-[A-Za-z0-9_]+-\d{4}$/.test(pc) ? GLOBAL : m[1];       // (an install id ends in 12 characters, never in a number of 4)
  }
  private isRead(scope: string) { return this.allRead || this.readScopes.has(scope); }
  /** Read one deal's files in the background, then the next, until every deal has been read. */
  private nextStep() {
    if (this.stepTimer || this.closed) return;
    if (!this.pending.length) { this.finishReading(); return; }
    this.stepTimer = setTimeout(() => {
      this.stepTimer = null; if (this.closed) return;
      const scope = this.pending[0];
      // A deal that cannot be read just now (the folder cannot be listed, or one of its files will not open) goes to the back
      // and the next is read. Once every deal left has failed in a row, they are tried again on the next look (the watch, or
      // a read that needs one), not in a busy loop.
      if (scope !== undefined && !this.readScope(scope)) {
        this.pending = [...this.pending.filter((x) => x !== scope), scope];
        if (++this.misses >= this.pending.length) { this.misses = 0; return; }
      } else this.misses = 0;
      if (this.watchers.size) this.tellSync();                          // a clash in that deal shows as soon as it is read
      this.nextStep();
    }, 0);
    (this.stepTimer as { unref?: () => void }).unref?.();
  }
  private finishReading() {
    if (this.allRead) return;
    this.allRead = true; this.pending = [];
    const released = this.letGoStuck();                                // a line is judged once the deals it touches are read (see judged)
    this.doneReading();
    this.tell(released);
    if (this.watchers.size) this.tellSync();
  }
  private tell(keys: Iterable<string>) { for (const k of keys) { const i = k.indexOf('/'); for (const w of this.watchers) w({ kind: k.slice(0, i) as RecordKind, id: k.slice(i + 1) }); } }
  /**
   * Read a deal's files now, ahead of its turn; false when the shared folder cannot be listed, and the deal stays unread. The
   * deal's own records are not announced, since every way of reading them comes here first; a record read before (a deal, the
   * list of them, a record of a deal already read) that changes with it is, so the window takes in the new version. That
   * happens when a change was held back because part of it was built on this deal's lines (a deal's edit that also changes
   * its checklist items, say).
   */
  private readScope(scope: string, names?: string[]): boolean {
    if (this.isRead(scope)) return true;
    // the deals' own files come first: a sync client's copy of a deal's file whose name does not say its deal is read with them
    if (scope !== GLOBAL && !this.readScope(GLOBAL, names)) return false;
    let mine: string[];
    try { mine = (names ?? this.o.shared.list()).filter((n) => CHANGE_FILE.test(n) && this.scopeOf(n) === scope); } catch { this.miss = UNREADABLE; return false; }
    const changed = new Set<string>(); const whole = this.readFiles(mine, changed);
    if (!whole) this.miss = LOCKED;
    // A file of the deal that cannot be opened just now leaves the deal unread: a read of it fails, not as unreachable (the window
    // offers Retry) and a change to it is refused, rather than either going by part of it. The files that did open
    // are kept, so a later try opens only the rest. There is no giving up: a deal read without one of its files would show
    // as complete when it is not, and a change made to it then could clash or repeat a question's number.
    if (!whole) { this.tellEarlier(changed, scope); return false; }
    this.readScopes.add(scope); this.pending = this.pending.filter((s) => s !== scope);
    this.tellEarlier(changed, scope);
    return true;
  }
  /** why the last read of a deal failed: the folder could not be listed, or one of its files would not open */
  private miss: typeof UNREADABLE | typeof LOCKED = UNREADABLE;
  /** announce the records, among those a deal's files changed, that were read before the deal (see readScope) */
  private tellEarlier(changed: Set<string>, scope: string) {
    this.tell([...changed].filter((k) => {
      const i = k.indexOf('/'); const kind = k.slice(0, i) as RecordKind;
      return ONLY_IN_DEALS.has(kind) || this.dealsOfRecord(kind, k.slice(i + 1)).some((d) => this.scopeName(d) !== scope && this.isRead(this.scopeName(d)));
    }));
  }
  /** Read every deal not read yet, now: for a caller that needs them all (a record whose deal is not known, say). False when the folder cannot be listed or a file will not open (`miss` says which). */
  private readAll(): boolean {
    if (this.allRead) return true;
    let names: string[]; try { names = this.o.shared.list(); } catch { this.miss = UNREADABLE; return false; }
    if (this.stepTimer) { clearTimeout(this.stepTimer); this.stepTimer = null; }
    for (const n of names) { const s = this.scopeOf(n); if (CHANGE_FILE.test(n) && !this.isRead(s) && !this.pending.includes(s)) this.pending.push(s); }
    // one that cannot be read ends this: the call fails anyway, and the others are read in the background meanwhile
    let all = true; for (const scope of [...this.pending]) if (!this.readScope(scope, names)) { all = false; break; }
    if (!all) { this.nextStep(); return false; }                        // a deal with a file that would not open: tried again in the background
    this.finishReading();
    return true;
  }
  /** The deals a record is in, as far as what has been read tells: its own `dealId`, and the deals that list it. */
  private dealsOfRecord(kind: RecordKind, id: string): string[] {
    const out = new Set(this.view.dealsOf(kind, id));
    for (const h of this.view.state(kind, id).heads) { const d = (h.data as { dealId?: unknown } | undefined)?.dealId; if (typeof d === 'string') out.add(d); }
    return [...out];
  }
  /**
   * Make sure a record is read in full before it is looked at: its deal's files are read now if they have not been. A record
   * not found at all may be in a deal not read yet, so every deal is read. False when the folder cannot be listed or a file will not open.
   */
  private readFor(kind: RecordKind, id: string): boolean {
    if (this.allRead) return true;
    if (ONLY_IN_DEALS.has(kind)) return this.readScope(GLOBAL);
    const deals = this.dealsOfRecord(kind, id);
    if (!this.view.state(kind, id).heads.length && !deals.length) return this.readAll();
    return deals.every((d) => this.readScope(this.scopeName(d)));
  }
  /** the file scope a deal's changes are written under (as `commit` names it): an id that cannot go in a file name is kept in `_` */
  private scopeName(dealId: string) { return /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(dealId) ? dealId : GLOBAL; }

  /**
   * What this PC kept about itself: install.json, or its spare copy (install.spare.json, written just before it, so
   * one of the two is whole whatever moment a crash or a full disk cuts a write off). A file that will not open just now,
   * with no whole spare, fails the start, which is tried again, rather than being taken for a new install. A damaged file is
   * kept aside as it was (`install.damaged-<when>.json`) before it is written again, and the start fails while no copy can
   * be kept; with neither file whole, what is whole in each is read, and `lost` is set: an id that is then not known for
   * this shared folder is looked for in this PC's own change files (`ownId`, in the constructor).
   */
  private installed(): { saved: Installed; lost: boolean; texts: (string | null)[] } {
    const o = this.o; const texts: (string | null)[] = []; let refused: unknown = null;
    const read = [INSTALL, SPARE].map((name) => {
      let text: string | null = null; try { text = o.local.read(name); } catch (e) { refused ??= e; texts.push(undefined as never); return null; }
      texts.push(text); return text == null ? null : { name, text, ...readInstalled(text) };
    });
    const whole = read.find((r) => r && !r.damaged);
    if (!whole && refused) throw refused;                               // will not open just now: nothing is taken for lost
    // kept aside before it is written over; a damaged spare of a whole install.json that cannot be kept just now (a full disk)
    // does not hold up the start, since install.json holds all of it (the spare is written first, so it is never behind)
    for (const r of read) if (r?.damaged) { try { this.keepAside(r.name, r.text); } catch (e) { if (r.name !== SPARE || whole?.name !== INSTALL) throw e; } }
    if (whole) return { saved: whole.saved, lost: false, texts };
    // neither there, or nothing whole in either and no change files kept here (cut off at the very first write): a new install
    const kept = () => { try { return o.local.list().some((n) => CHANGE_FILE.test(n)); } catch { return true; } };
    if (!read.some((r) => r && Object.keys(r.saved).length) && !kept()) return { saved: {}, lost: false, texts };
    // neither is whole: what is whole in one of them, install.json first, so that its ids and folders are never mixed with
    // the other's (which may be a write behind); the machine, the same in both, from either
    const [main, spare] = read; const one = main && (main.saved.id || main.saved.ids) ? main : (spare ?? main);
    const saved: Installed = { ...one?.saved }; saved.machine ??= main?.saved.machine ?? spare?.saved.machine;
    if (!saved.machine) delete saved.machine;
    // an id whose folder was lost with the damage may be another folder's: it is not taken for this one's
    if (o.place && !saved.place) delete saved.id;
    // this folder's id as the map of them still gives it, when the one at the top was lost
    if (o.place && !saved.id && saved.ids?.[o.place]) { saved.id = saved.ids[o.place]; saved.place = o.place; }
    return { saved, lost: true, texts };
  }
  /** Keep a damaged file's text aside before it is written again, once: a start tried again does not keep another copy. Throws when it cannot be kept. */
  private keepAside(name: string, text: string) {
    const o = this.o; if (!text.trim()) return;                        // an empty file has nothing in it to keep
    const base = name.replace(/\.json$/, '');
    if (o.local.list().some((n) => n.startsWith(`${base}.damaged-`) && o.local.read(n) === text)) return;
    const stem = `${base}.damaged-${this.clock().replace(/[:.]/g, '-')}`;
    let file = `${stem}.json`; for (let n = 2; o.local.read(file) != null; n++) file = `${stem}-${n}.json`;
    o.local.write(file, text);
  }
  /** Write what install.json holds: its spare first, so that one of the two is whole whenever a write is cut off. */
  private keepInstall(text: string, was: (string | null)[] = []) {
    // with install.json as it should be, a spare that cannot be written just now (held by a virus scanner) is written next time
    if (was[1] !== text) { try { this.o.local.write(SPARE, text); } catch (e) { if (was[0] !== text) throw e; } }
    if (was[0] !== text) this.o.local.write(INSTALL, text);
  }
  /**
   * This PC's id in this shared folder, from its own change files, when what it kept about itself is lost. An id is
   * taken only when it is recorded for this folder (`place-<id>.json`, on the desktop, which names its folder), with a copy
   * kept here of every file it has in the folder, and no whole line there under that id that the copies here do not hold:
   * its lines are written here first, so such a line is another PC writing under that id (this local folder was copied from
   * it). An id it is known to use in another folder, or to have left behind in one, is passed over. Of several, the one
   * that wrote here last.
   */
  private ownId(saved: Installed): string | null {
    const o = this.o;
    const not = new Set([...Object.entries(saved.ids ?? {}).filter(([p]) => p !== o.place).map(([, i]) => i), ...Object.values(saved.lastIds ?? {}), ...(saved.place && saved.place !== o.place && saved.id ? [saved.id] : [])]);
    // with a named folder, only an id recorded for it (place-<id>.json): its files and lines cannot tell a copy of the folder from it
    const mine = (i: string) => { if (!o.place) return true; try { return JSON.parse(o.local.read(`place-${i}.json`) ?? 'null')?.place === o.place; } catch { return false; } };
    const kept = new Map<string, string[]>(); for (const n of o.local.list()) { const i = idOfFile(n); if (i && !not.has(i)) kept.set(i, [...(kept.get(i) ?? []), n]); }
    for (const i of [...kept.keys()]) if (!mine(i)) kept.delete(i);
    if (!kept.size) return null;
    const there = new Map<string, string[]>(); for (const n of o.shared.list()) { const i = idOfFile(n); if (i && kept.has(i)) there.set(i, [...(there.get(i) ?? []), n]); }
    const found: [string, string][] = [];
    for (const [i, names] of kept) {
      const shared = there.get(i) ?? [];
      if (!shared.length) {
        if (this.placedOnThisMachine(i)) found.push([i, this.latestKeptAt(names, i)]);
        continue;
      }
      if (shared.some((n) => !names.includes(n))) continue;
      let here = '', ahead = false;
      for (const n of names) {
        if (!shared.includes(n)) continue;
        const held = new Set(linesOf(o.local.read(n) ?? '', i).map((x) => x.l));
        // will not open just now: the start fails, and is tried again
        const theirs = linesOf(o.shared.read(n) ?? '', i);
        if (theirs.some((x) => !held.has(x.l))) ahead = true;
        for (const x of theirs) if (x.at > here) here = x.at;
      }
      if (!ahead) found.push([i, here]);
    }
    return found.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0))[0]?.[0] ?? null;
  }

  /**
   * An id with no file left in the shared folder (#29): nothing there can tell a copy of this local folder from
   * this PC, so it is taken only when its folder record names this machine and Windows user. A copy on another PC
   * takes a new id.
   */
  private placedOnThisMachine(id: string): boolean {
    const here = this.o.machine?.();
    if (!this.o.place || !here) return false;
    try {
      const record = this.o.local.read(`place-${id}.json`);
      return JSON.parse(record ?? 'null')?.machine === here && !leftIn(record);
    } catch {
      return false;
    }
  }

  /**
   * Which folder an id is for, kept apart from install.json, so an id found again after install.json is lost is only
   * ever taken in its own folder: a copy of the folder holds the same files under it. Its machine is kept too, so an id
   * with no file left in the shared folder can still be taken back on this PC (#29). An id left after a copy was found
   * is marked, and the mark is never dropped, so it is never taken back that way: the copy may still be writing under
   * it. Tried again at each start until it is there (the left id while it is the last id in this folder).
   */
  private keepPlaceRecord(id: string, left = false) {
    const here = this.o.machine?.();
    if (!this.o.place) return;
    try {
      const name = `place-${id}.json`;
      const kept = this.o.local.read(name);
      const machine = here ? { machine: here } : {};
      const mark = left || leftIn(kept) ? { left: true } : {};
      const record = JSON.stringify({ place: this.o.place, ...machine, ...mark });
      if (kept !== record) this.o.local.write(name, record);
    } catch { /* the next start */ }
  }

  /** When an id last wrote, from the copies of its files kept here (#29). */
  private latestKeptAt(names: string[], id: string): string {
    let latest = '';
    for (const name of names) {
      for (const { at } of linesOf(this.o.local.read(name) ?? '', id)) if (at > latest) latest = at;
    }
    return latest;
  }

  /** What install.json holds: the current id, whose machine it is, its shared folder, the id used in each folder, and the last id in each folder where it took a new one. */
  private install(id: string) {
    const here = this.o.machine?.();
    return { id, ...(here ? { machine: here } : {}), ...(this.o.place ? { place: this.o.place, ids: { ...this.ids, [this.o.place]: id } } : {}), ...(Object.keys(this.lastIds).length ? { lastIds: this.lastIds } : {}), ...(this.lost ? { lost: true as const } : {}) };
  }

  /** Settle only confirmed complete lines, including work carried from a previous install. */
  private settleWrittenOperations(): void {
    const pending = new Set(this.ops.pending());
    if (!pending.size) return;
    const written = new Set<string>();
    const previous = this.previous;
    const take = (raw: string, owner: string) => {
      let line: unknown;
      try {
        line = JSON.parse(raw);
      } catch {
        return;
      }
      if (isLine(line) && line.pc === owner && line.op && pending.has(line.op)) written.add(line.op);
    };
    for (const raw of this.ownLines) take(raw, this.id);
    if (previous) {
      for (const raw of this.changes.ownLines(previous)) take(raw, previous);
      if (written.size < pending.size) try {
        for (const name of this.o.shared.list()) {
          if (!name.startsWith(`changes-${previous}-`) || !CHANGE_FILE.test(name)) continue;
          try {
            for (const raw of wholeLines(this.o.shared.read(name) ?? '')) take(raw, previous);
          } catch { /* An unavailable file leaves its operations pending. */ }
        }
      } catch { /* An unavailable folder leaves its operations pending. */ }
    }
    this.ops.landed([...written]);
  }

  /**
   * If the synced copy of one of this PC's own files has lost lines (a restore, a rollback), put them back from the copy kept
   * here: this install's files, and those of an earlier id already in this folder (after a copied folder was found). A copy
   * kept for another shared folder is not in this one, so it is never put here.
   */
  private restore() {
    const own = `changes-${this.id}-`;
    let names: string[] = []; try { names = this.o.local.list().filter((n) => CHANGE_FILE.test(n) && (n.startsWith(own) || this.o.shared.size(n) >= 0)); } catch { return; }
    for (const name of names) this.changes.heal(this.o.shared, name, true);
  }
  /**
   * A line under this install's id that this install never wrote: the folder it keeps its id in was copied, and another PC is
   * writing as this one. Nothing more is written here; the next start takes a new id, and the person is told.
   */
  private copiedHere() {
    if (this.cloned) return; this.cloned = true;
    // the next start takes the new id, and this one's undo journal with it
    if (this.o.place) this.lastIds[this.o.place] = this.id;
    this.keepPlaceRecord(this.id, true);
    try { this.keepInstall(JSON.stringify(this.install((this.o.newId ?? (() => globalThis.crypto.randomUUID()))()))); } catch { /* the check runs again at the next start */ }
  }
  /** Tell whoever is watching about a record written here by something other than the window (the first pass writing a finding). */
  announce(kind: RecordKind, id: string) { for (const w of this.watchers) w({ kind, id }); }
  /** set by close: a change that arrives later (a check finishing after the shared folder was changed) is refused, not written */
  private closed = false;
  /** Stop: later changes are refused, and this resolves when every change already started has been written (or refused). */
  close(): Promise<void> { this.closed = true; this.watchers.clear(); if (this.timer) { clearInterval(this.timer); this.timer = null; } if (this.stepTimer) { clearTimeout(this.stepTimer); this.stepTimer = null; } this.doneReading(); return this.queue.then(() => undefined); }
  /** Resolves once every deal's files have been read (the deals themselves are read before the constructor returns), or on close. */
  ready(): Promise<void> { return this.whenAllRead; }

  /**
   * This PC's own files: when the synced copy of one has lost lines that the copy kept here holds (a sync client put back an older
   * copy, say), they are put back. Checked at every look at the shared folder and before every write, not only at start.
   * Only a size that differs is looked into, so this costs nothing while the two agree. A last line with no line end is part of
   * a write that failed: it is ended, and read as damaged.
   */
  private healAll() {
    let own: string[] = [];
    try {
      own = this.o.local.list().filter((name) => name.startsWith(`changes-${this.id}-`) && CHANGE_FILE.test(name));
    } catch { return; }
    for (const name of own) this.changes.heal(this.o.shared, name);
  }

  /** Read whatever has arrived in the shared folder since last time. Returns the records that changed. */
  private refresh(tell = true): string[] {
    this.healAll(); this.lookAtTouch();
    const changed = new Set<string>();
    let names: string[] = []; try { names = this.o.shared.list().filter((n) => CHANGE_FILE.test(n)); } catch { if (tell) this.tellSync(); return []; }
    // a deal not read yet waits its turn (a new one, from another PC, joins the queue); its files are read whole when it comes
    const now: string[] = [];
    this.listed = new Set(names.map((n) => this.scopeOf(n)));
    for (const name of names) { const s = this.scopeOf(name); if (this.isRead(s)) now.push(name); else if (!this.pending.includes(s)) this.pending.push(s); }
    this.readFiles(now, changed);
    for (const k of this.letGoStuck()) changed.add(k);
    if (!this.allRead) this.nextStep();
    if (tell) {
      this.tell(changed);
      this.tellSync();
    }
    return [...changed];
  }
  /** Take in whatever these files hold that has not been taken in; the records changed are added to `changed`. */
  /** Returns false when one of them could not be opened (a sync client holding it for a moment, say); the others are still taken in. */
  private readFiles(names: string[], changed: Set<string>, writeReceipts = true): boolean {
    let whole = true;
    for (const name of names) {
      let text: string | null = null;
      try {
        if (this.o.shared.size(name) === this.read.get(name)) continue;
        text = this.o.shared.read(name);
      } catch {
        whole = false;
        continue;
      }
      if (text == null) continue;
      if (this.readChangeLines(text, changed, writeReceipts)) this.read.set(name, bytes(text));
      else whole = false;
    }
    return whole;
  }

  private readChangeLines(text: string, changed: Set<string>, writeReceipts: boolean): boolean {
    let whole = true;
    // Incomplete lines stay outside the view. A damaged complete line is skipped.
    for (const raw of wholeLines(text)) {
      let line: unknown;
      try { line = JSON.parse(raw); } catch { continue; }
      if (!isLine(line)) continue;
      const own = line.pc === this.id;
      if (own && !this.readOwnLine(line, raw, writeReceipts)) {
        whole = false;
        continue;
      }
      for (const key of this.view.add(line, own && this.ownLines.has(raw))) changed.add(key);
    }
    return whole;
  }

  private readOwnLine(line: Line, raw: string, writeReceipt: boolean): boolean {
    this.seq = Math.max(this.seq, line.seq);
    if (this.changes.sharedIsPending(raw)) {
      if (!this.changes.confirm(raw)) return false;
      this.ownLines.add(raw);
      if (line.op) this.ops.landed([line.op], writeReceipt);
    }
    if (!this.ownLines.has(raw)) this.copiedHere();
    return true;
  }
  /** when this run of the app first found each held line held, by its PC and number */
  private heldSince = new Map<string, number>();
  /**
   * Let go of the held lines that are stuck: the change was made more than a day ago and is still waiting here, so what it
   * was built on is lost (its PC's file put back to an older copy after that PC stopped being used, say), not slow. Each
   * is taken in as it is and stands beside the current version as a choice; the deal can be deleted again. A line
   * must also have been held here for a while in this run, so that a PC back after a week away first takes in what syncs.
   */
  private letGoStuck(): string[] {
    const held = this.view.waiting().filter(({ line }) => this.judged(line)); if (!held.length) { this.heldSince.clear(); return []; }
    const now = Date.parse(this.clock()); const key = (l: Line) => `${l.pc}:${l.seq}`; const still = new Set<string>();
    for (const { line } of held) { const k = key(line); still.add(k); if (!this.heldSince.has(k)) this.heldSince.set(k, now); }
    for (const k of [...this.heldSince.keys()]) if (!still.has(k)) this.heldSince.delete(k);
    // the change's age is read from the time its own PC wrote on it: a PC whose clock ran a day fast would have its changes let
    // go after the settle alone. Nothing is lost even then, since the change becomes a choice, so the plain reading is kept
    return this.view.release((l) => this.judged(l) && now - Date.parse(l.at) >= STUCK_AFTER && now - (this.heldSince.get(key(l)) ?? now) >= SETTLE_FIRST);
  }
  /**
   * Whether a held line can be judged: every deal it touches has been read. A deal not read yet may hold what the line was
   * built on, so until then it is neither reported as waiting nor let go. Judged line by line, so that a deal that cannot be
   * read just now holds up only the lines about it (a record's versions are in its deal's files or with the deals).
   */
  private judged(line: Line): boolean {
    if (this.allRead) return true;
    if (!this.isRead(GLOBAL)) return false;
    // a record whose deal is not known (a delete that names none) may be in any deal: every deal must be read first
    if (line.recs.some((r) => !ONLY_IN_DEALS.has(r.kind as RecordKind) && typeof (r.data as { dealId?: unknown } | undefined)?.dealId !== 'string' && !this.view.dealsOf(r.kind, r.id).length)) return false;
    // a deal with no files here yet has nothing to read: what the line waits for is not here, so it is waited for
    return this.view.dealsOfLine(line).every((d) => this.isRead(this.scopeName(d)) || !this.listed.has(this.scopeName(d)));
  }
  /** the deals (and `_`) that had files at the last look at the folder */
  private listed = new Set<string>();
  /** Tell whoever is watching when the sync state has changed. */
  private tellSync() { const now = JSON.stringify(this.syncNow()); if (now !== this.lastSync) { this.lastSync = now; for (const w of this.watchers) w({ kind: 'sync', id: '' }); } }
  /** Ask the shell whether this PC is in touch with the shared folder; an answer that comes later counts from the next look. */
  private lookAtTouch() {
    const take = (inTouch: boolean) => {
      const next = inTouch ? null : this.outSince ?? this.clock(); if (next === this.outSince) return;
      this.outSince = next; try { this.o.local.write('touch.json', JSON.stringify({ outSince: next })); } catch { /* kept for this run only */ }
    };
    try { const r = this.o.inTouch?.(); if (typeof r === 'boolean') take(r); else void r?.then(take, () => undefined); } catch { /* taken as unchanged */ }
  }

  private syncNow(): SyncState {
    const { clashes } = this.view.attention(); const unseen = this.unseenNow();
    const dealOf = (st: RecState) => (st.kind === 'deal' ? st.id : (st.heads[0]?.data as { dealId?: string } | undefined)?.dealId ?? this.view.dealsOf(st.kind, st.id)[0]);
    // held-back lines, by the PC whose change they wait for (a version's id starts with the install that wrote it). How long a
    // wait has lasted is judged from when the held change was made: what it was built on was written before that and is still
    // not here, so it is the same on every start of the app, and on every PC.
    const waiting = new Map<string, SyncState['waiting'][number]>(); const held = this.view.waiting().filter(({ line }) => this.judged(line));
    const named = new Map(held.map(({ line }) => [line.pc, line.from]));          // a PC only known by its held lines
    for (const { line, missing } of held) for (const pc of new Set(missing.map((b) => b.split('.')[0]))) {
      const w = waiting.get(pc) ?? { pc, label: this.view.pcs.get(pc)?.label ?? named.get(pc) ?? null, from: [], changes: 0, since: line.at, deals: [] };
      for (const d of this.view.dealsOfLine(line)) if (!w.deals.includes(d)) w.deals.push(d);
      w.changes++; if (!w.from.includes(line.from)) w.from.push(line.from); if (line.at > w.since) w.since = line.at; waiting.set(pc, w);   // the newest: one old held change does not make a fresh wait quiet
    }
    return {
      self: { id: this.id, label: this.o.label, ...(this.cloned ? { note: COPIED } : {}) },
      peers: [...this.view.pcs.entries()].filter(([pc]) => pc !== this.id).map(([pc, p]) => ({ id: pc, label: p.label, by: p.by, lastChangeAt: p.lastChangeAt })).sort((a, b) => (a.id < b.id ? -1 : 1)),
      waiting: [...waiting.values()].sort((a, b) => (a.pc < b.pc ? -1 : 1)),
      ...(this.outSince ? { outOfTouchSince: this.outSince } : {}),
      // a clash in a deal not read yet is told once it is read: a change in a file still to open may have settled it
      clashes: clashes.flatMap((st) => { const d = dealOf(st); return d && this.isRead(this.scopeName(d)) && (CLASH_KINDS as readonly string[]).includes(st.kind) ? [{ dealId: d, kind: st.kind as ClashKind, id: st.id }] : []; }),
      ...(unseen.length ? { unseen } : {}),
    };
  }
  /**
   * The deals another PC deleted while this PC had changes to them that it had not seen, and that this PC has not kept as a
   * copy yet. Judged once the deal's files are read here: this PC's own lines about it are in them.
   */
  private unseenNow(): NonNullable<SyncState['unseen']> {
    return this.view.purgedDeals().flatMap((d) => {
      if (!this.isRead(GLOBAL) || !this.isRead(this.scopeName(d)) || this.view.known('deal', recoveredId(d, this.id))) return [];
      const u = this.view.unseenWork(d, this.id); if (!u) return [];
      const name = (this.view.lastHad('deal', d)[0]?.data as { name?: unknown } | undefined)?.name;
      return [{ dealId: d, name: typeof name === 'string' ? name : '', by: u.line.by, from: u.line.from, at: u.line.at, changes: u.lines }];
    });
  }

  /**
   * Keep a deal another PC deleted, with this PC's changes the other had not seen, as a new deal holding everything this PC had
   * of it (domain/recovered.ts). Two lines: the records first, filed under the copy, then the copy itself, in the
   * person's list. Asked again after the first line only (the app stopped between them), the records already written are
   * the same records (their ids are made from the copy's), so only what is missing is written. Once the copy is there it is
   * never made again, even after a person deletes it.
   */
  recover(dealId: string, o: { name: string; person: string }): Promise<Result<Recovered>> {
    if (this.closed) return Promise.resolve(fail({ kind: 'failed', message: 'Punchlist is starting again on the Punchlist folder' }));
    const run = this.queue.then(() => this.recoverNow(dealId, o));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async recoverNow(dealId: string, o: { name: string; person: string }): Promise<Result<Recovered>> {
    this.refresh();
    // the copy's own files too: records written by a try cut off before the copy itself (and the app started again since) are found there
    const copyId = recoveredId(dealId, this.id);
    if (!this.readScope(GLOBAL) || !this.readScope(this.scopeName(dealId)) || !this.readScope(this.scopeName(copyId))) return fail(this.miss);
    const done = this.view.known('deal', copyId);
    if (!done && !this.view.unseenWork(dealId, this.id)) return fail({ kind: 'rejected', message: 'Nothing of this deal is left to keep' });
    // the deal as this PC had it; versions of it nobody had chosen between come too, as a choice in the copy
    const [deal, ...dealAlongside] = this.view.lastHad('deal', dealId).map((v) => v.data as Record<string, unknown>);
    if (!deal) return fail({ kind: 'notFound', message: 'Deal not found', recordId: dealId });
    const copy = recoveredDeal({ dealId, copyId, deal, dealAlongside, had: this.hadOf(dealId), name: o.name, person: o.person, at: this.clock() });
    const ids = Object.fromEntries(copy.ids);
    if (done) return ok({ dealId: copyId, ids });
    const left = copy.records.filter((r) => !this.view.known(r.kind, r.id));
    if (left.length) {
      // each record's history comes with it, under its new id
      const oldOf = new Map([...copy.ids].map(([was, now]) => [now, was]));
      const history = [...new Set([copyId, ...left.map((r) => r.id)])].flatMap((id) => { const was = oldOf.get(id); return was ? this.view.history(was, AUDIT_KEEP).map((e) => remap(e, copy.ids)) : []; });   // a question and its Recently deleted entry share an id: one history
      const r = await this.commit({ by: o.person, writes: left.map((x) => ({ kind: x.kind, id: x.id, data: x.data, expectedRev: null, ...(x.alongside.length ? { alongside: x.alongside } : {}), ...(x.deletedAlongside ? { deletedAlongside: true } : {}) })),
        index: { dealId: copyId, add: left.map((x) => ({ kind: x.kind, id: x.id })) }, ...(history.length ? { audit: history } : {}) });
      if (!r.ok) return r;
    }
    const member = copy.member as { id: string };
    const r = await this.commit({ by: o.person, writes: [{ kind: 'deal', id: copyId, data: copy.deal, expectedRev: null, ...(copy.dealAlongside.length ? { alongside: copy.dealAlongside } : {}) }, { kind: 'member', id: member.id, data: member, expectedRev: null }],
      index: { dealId: GLOBAL, add: [{ kind: 'deal', id: copyId }, { kind: 'member', id: member.id }] } });
    return r.ok ? ok({ dealId: copyId, ids }) : r;
  }
  /** everything filed under a deal, as this PC had it: each record's current versions, null for a version that deletes it */
  private hadOf(dealId: string): Had[] {
    return this.view.filedUnder(dealId).map(({ kind, id }) => ({ kind, id, versions: this.view.state(kind, id, true).heads.map((v) => (v.del ? null : v.data)) }));
  }
  async sync(): Promise<Result<SyncState>> { this.refresh(); return ok(this.syncNow()); }
  async seen(): Promise<Result<Seen>> { return ok(this.view.seenNow()); }

  /** `asHad`: as this PC had it, though its deal has been deleted (a change to it written before this PC's copy is made) */
  private loaded(kind: RecordKind, id: string, asHad = false): Loaded | null {
    const st = this.view.state(kind, id, asHad); if (!st.heads.length || (st.heads.length === 1 && st.heads[0].del)) return null;
    const h = st.heads[0]; const envelope = { schema: Math.max(...st.heads.map((v) => v.schema)), kind, rev: st.rev, updatedAt: h.at, data: h.data };
    if (st.heads.length === 1) {
      const alike = st.tips.length > 1 ? st.tips.flatMap((t) => { const v = this.view.version(t); return v && !v.del ? [{ by: v.by, from: v.from, ...(v.pc === this.id ? { here: true as const } : {}) }] : []; }) : [];
      return { kind, id, rev: st.rev, envelope, ...(alike.length > 1 ? { alike } : {}) };
    }
    // a deleted version carries the copy its deletion note kept, so a person choosing sees the words that were deleted
    const held = (v: (typeof st.heads)[number]) => (this.view.lineMate(v, 'tombstone', id)?.data as { snapshot?: unknown } | undefined)?.snapshot;
    const conflict: Version[] = st.heads.map((v) => ({ id: v.ver, by: v.by, from: v.from, at: v.at, data: v.del ? undefined : v.data, ...(v.del ? { deleted: true, ...(held(v) ? { held: held(v) } : {}) } : {}), ...(v.pc === this.id ? { here: true } : {}) }));
    if (kind === 'question') for (const [i, v] of st.heads.entries()) conflict[i].drafts = this.draftsIn(v);
    return { kind, id, rev: st.rev, envelope, conflict };
  }
  /** every draft request held anywhere in a version's history, back through each version it was based on (#22) */
  private draftsIn(head: Ver): string[] {
    const visited = new Set<string>();
    const drafts = new Set<string>();
    const todo = [head.ver];
    while (todo.length) {
      const ver = todo.pop()!;
      const version = visited.has(ver) ? undefined : this.view.version(ver);
      visited.add(ver);
      if (!version) continue;
      const opId = (version.data as { draft?: { opId?: unknown } } | undefined)?.draft?.opId;
      if (typeof opId === 'string') drafts.add(opId);
      todo.push(...version.base);
    }
    return [...drafts];
  }
  /** a record as it stands, read at once, for a caller that cannot wait; not for ops */
  peek(kind: Exclude<RecordKind, 'op'>, id: string): Loaded | null { this.readFor(kind, id); return this.loaded(kind, id); }
  async get(kind: RecordKind, id: string): Promise<Result<Loaded | null>> {
    if (kind === 'op') {
      this.settleNow();
      return this.readJournalOperation(id);
    }
    if (!this.readFor(kind, id)) return fail(this.miss);
    return ok(this.loaded(kind, id));
  }
  async list(kind: RecordKind, dealId?: string): Promise<Result<Loaded[]>> {
    if (kind === 'op') { this.settleNow(); return this.ops.list(); }
    // one deal's records: that deal is read first, if it has not been; every record of a kind: every deal is
    // (a deal's records are written to its own files, or with the deals in `_` when the same change is about the deals)
    if (!(dealId !== undefined ? this.readScope(this.scopeName(dealId)) : ONLY_IN_DEALS.has(kind) ? this.readScope(GLOBAL) : this.readAll())) return fail(this.miss);
    const ids = dealId !== undefined ? this.view.index(dealId).filter((e) => e.kind === kind).map((e) => e.id) : this.view.ids(kind);
    return ok(ids.map((id) => this.loaded(kind, id)).filter((x): x is Loaded => !!x));
  }
  /** a record's history is written with its changes, in its deal's files; the record is not named by kind here, so every deal is read */
  async audit(recordId: string): Promise<Result<AuditEntry[]>> {
    // a deal that cannot be read just now fails this only when the record may be in it: not for a record of a deal that is read
    if (!this.readAll() && !KINDS.some((k) => { const ds = this.dealsOfRecord(k, recordId); return this.view.state(k, recordId).heads.length > 0 && ds.every((d) => this.isRead(this.scopeName(d))); })) return fail(this.miss);
    return ok(this.view.audit(recordId, AUDIT_KEEP));
  }

  /**
   * One change at a time. A change is checked against what is there, then waits on this PC's own store, then is written
   * under the next number: two started together would both pass the checks and take the same number, and one would be
   * lost. The second waits until the first is written, and is checked against it.
   */
  private queue: Promise<unknown> = Promise.resolve();
  transaction(tx: Transaction): Promise<Result<Record<string, number>>> {
    if (this.closed) return Promise.resolve(fail({ kind: 'failed', message: 'Punchlist is starting again on the Punchlist folder' }));
    const run = this.queue.then(() => this.commit(tx));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Uncertain appends are settled from the files that could hold the receipt (#565). */
  private async readJournalOperation(id: string, writeReceipt = false): Promise<Result<Loaded | null>> {
    const read = await this.ops.get(id);
    if (!this.changes.hasPending || !read.ok || !read.value) return read;
    if (!Journal.needsReceipt(read.value.envelope.data)) return read;
    const pending = this.changes.pendingFiles(id);
    if (!pending.size) return read;

    let names: string[];
    try { names = this.o.shared.list(); } catch { return fail(UNREADABLE); }
    const changed = new Set<string>();
    const files = names.filter((name) => pending.has(name));
    // A getter can remember the confirmed receipt. Only a queued write can persist it here (#565).
    const loaded = this.readFiles(files, changed, writeReceipt);
    this.tell(changed);
    const recorded = await this.ops.get(id);
    if (!loaded && recorded.ok && Journal.needsReceipt(recorded.value?.envelope.data)) return fail(LOCKED);
    return recorded;
  }

  /** A local journal change still checks for a shared append before replacing its receipt (#565). */
  private async saveJournal(tx: Transaction) {
    if (this.changes.hasPending) {
      for (const write of tx.writes) {
        const state = (write.data as { state?: unknown } | null)?.state;
        if (write.expectedRev === null || state === 'interrupted') continue;
        const current = await this.readJournalOperation(write.id, true);
        if (!current.ok) return current;
      }
    }
    return this.ops.transaction(tx);
  }

  /** Durable ownership is kept before append; only observed shared lines may recover a failed save. */
  private appendChange(file: string, text: string, seq: number): Result<void> {
    const localFailure = (error: unknown) => fail<void>(full(error)
      ? { kind: 'storageFull', message: 'The disk is full' }
      : { kind: 'failed', message: 'This PC’s own copy of the changes cannot be written to' });
    this.seq = seq;
    try { this.changes.append(file, text); }
    catch (error) { return localFailure(error); }
    try { shareOwn(this.o.shared, this.o.local, file, text, true); }
    catch (error) {
      return fail(full(error) ? { kind: 'storageFull', message: 'The disk is full' }
        : { kind: 'unreachable', message: 'The Punchlist folder cannot be written to' });
    }
    try { this.changes.finish(text); }
    catch (error) { return localFailure(error); }
    return ok(undefined);
  }

  private async commit(asked: Transaction): Promise<Result<Record<string, number>>> {
    let tx = asked;
    this.settleNow();
    // the undo journal stays on this PC: its entries are written to the local store and never to the change file
    const opTx: Transaction = { writes: tx.writes.filter((w) => w.kind === 'op'), deletes: (tx.deletes ?? []).filter((d) => d.kind === 'op') };
    let writes = tx.writes.filter((w) => w.kind !== 'op'); let deletes = (tx.deletes ?? []).filter((d) => d.kind !== 'op');
    const local = opTx.writes.length + opTx.deletes!.length > 0;
    const shared = writes.length || deletes.length || tx.audit?.length || tx.index || tx.purgeDeal || tx.reopen?.length;
    if (!shared) return this.saveJournal(opTx);
    // a deal deleted says what this PC had taken in when the person began deleting it (the window asked then: `seen`), or else
    // before this change: never lines that arrived since, which the person never saw
    const seen = tx.purgeDeal ? tx.seen ?? this.view.seenNow() : undefined;
    this.refresh();                                                    // judge against everything that has arrived
    if (!this.readForChange(writes, deletes, tx)) return fail(this.miss);   // including every deal it touches, read now if it has not been
    if (this.cloned) return fail({ kind: 'rejected', message: COPIED });
    // a whole deal is not removed while changes to it from another PC are still held back: they would be lost unseen
    if (tx.purgeDeal && this.view.waiting().some(({ line }) => this.view.dealsOfLine(line).includes(tx.purgeDeal!))) return fail({ kind: 'rejected', message: WAITING_DELETE });
    // a change to a deal deleted on another PC would go with it, unseen: it goes to this PC's copy of the deal instead
    const toCopy = this.toCopy(tx, writes, deletes); if (!toCopy.ok) return toCopy;
    const { asHad, moved } = toCopy.value; ({ writes, deletes, tx } = toCopy.value);
    const had = (kind: RecordKind, id: string) => asHad.has(recKey(kind, id));
    const reopen = new Map((tx.reopen ?? []).map((r) => [recKey(r.kind, r.id), r]));
    // 1. the same checks, in the same order, as the store this replaces
    for (const w of writes) {
      if (reopen.has(recKey(w.kind, w.id))) continue;                // undo of a choice: checked where the choice is withdrawn, below
      const cur = this.loaded(w.kind, w.id, had(w.kind, w.id));
      if (cur && cur.envelope.schema > CURRENT_SCHEMA && !w.keepsSchema) return fail({ kind: 'rejected', message: NEWER });
      if (cur?.conflict && asksAPerson(w.kind)) {
        if (!w.resolves) return fail({ kind: 'rejected', message: TWO_VERSIONS });
        if (!cur.conflict.every((v) => w.resolves!.includes(v.id))) return fail({ kind: 'conflict', message: CHANGED, recordId: w.id });
      }
      else if (cur?.conflict && !cur.conflict.every((v) => w.seen?.includes(v.id))) return fail({ kind: 'conflict', message: CHANGED, recordId: w.id });
      if (w.expectedRev === null && cur) return fail({ kind: 'conflict', message: CHANGED, recordId: w.id, actual: cur.rev });
      // the deal itself, as this PC had it, is deleted underneath (its delete is one of its versions): its rev is not judged
      if (typeof w.expectedRev === 'number' && !(w.kind === 'deal' && had(w.kind, w.id)) && (cur?.rev ?? 0) !== w.expectedRev) return fail({ kind: 'conflict', message: CHANGED, recordId: w.id, expected: w.expectedRev, actual: cur?.rev ?? 0 });
    }
    for (const d of deletes) {
      const cur = this.loaded(d.kind, d.id, had(d.kind, d.id));
      if (cur && cur.envelope.schema > CURRENT_SCHEMA) return fail({ kind: 'rejected', message: NEWER });
      if (cur?.conflict && asksAPerson(d.kind)) {
        if (!d.resolves) return fail({ kind: 'rejected', message: TWO_VERSIONS });
        if (!cur.conflict.every((v) => d.resolves!.includes(v.id))) return fail({ kind: 'conflict', message: CHANGED, recordId: d.id });
      }
      else if (cur?.conflict && !cur.conflict.every((v) => d.seen?.includes(v.id))) return fail({ kind: 'conflict', message: CHANGED, recordId: d.id });
      if (d.expectedRev !== null && (cur?.rev ?? 0) !== d.expectedRev) return fail({ kind: 'conflict', message: CHANGED, recordId: d.id, expected: d.expectedRev, actual: cur?.rev ?? 0 });
    }
    // 2. one line for the whole transaction
    const seq = this.seq + 1; const recs: RecChange[] = []; const retract: string[] = [];
    // A version's id names this install and line, plus a random part: a copied install that has not been found out yet writes
    // under the same id and line number, and two versions sharing an id would leave every PC keeping whichever it read first.
    const tag = globalThis.crypto.randomUUID().slice(0, 8); const ver = () => `${this.id}.${seq}.${recs.length}.${tag}`;
    for (const w of writes) {
      const again = reopen.get(recKey(w.kind, w.id));
      if (again) {                                                     // undo of a choice: withdraw the version that made it, so the versions it chose between stand again
        const st = this.view.state(w.kind, w.id); const chosen = st.heads.length === 1 ? st.heads[0] : null;
        if (!chosen || !again.versions.every((v) => chosen.base.includes(v.id))) return fail({ kind: 'conflict', message: CHANGED, recordId: w.id });
        retract.push(chosen.ver); continue;
      }
      const was = w.keepsSchema ? this.loaded(w.kind, w.id, had(w.kind, w.id))?.envelope.schema : undefined;
      const base = w.beside
        ? this.view.basesBeside(w.kind, w.id, had(w.kind, w.id))
        : this.view.bases(w.kind, w.id, had(w.kind, w.id));
      recs.push({
        kind: w.kind, id: w.id, ver: ver(), base, data: w.data,
        schema: Math.max(was ?? 0, schemaOf(w.kind, w.data)),
      });
      // more versions of a new record, made with no knowledge of each other: they stand beside it as a choice (a copy of a clash)
      if (w.expectedRev === null) for (const data of w.alongside ?? []) recs.push({ kind: w.kind, id: w.id, ver: ver(), base: [], data, schema: schemaOf(w.kind, data) });
      if (w.expectedRev === null && w.deletedAlongside) recs.push({ kind: w.kind, id: w.id, ver: ver(), base: [], del: true });
    }
    this.markForwardedChanges(recs, moved);
    for (const d of deletes) recs.push({ kind: d.kind, id: d.id, ver: ver(), base: this.view.bases(d.kind, d.id, had(d.kind, d.id)), del: true, ...(d.undoesImport ? { undoesImport: true as const } : {}) });
    const line: Line = { v: 1, schema: CURRENT_SCHEMA, pc: this.id, seq, at: this.clock(), by: tx.by ?? tx.audit?.[0]?.actor ?? this.o.user(), from: this.o.label, recs,
      ...(tx.audit?.length ? { audit: tx.audit } : {}), ...(tx.index ? { index: tx.index } : {}), ...(retract.length ? { retract } : {}),
      // a deal deleted says what this PC had seen of everyone's changes, so a PC with changes it had not seen keeps them
      ...(tx.purgeDeal ? { purge: tx.purgeDeal, seen } : {}),
      ...(opTx.writes.length ? { op: opTx.writes[opTx.writes.length - 1].id } : {}) };   // the Store puts the entry it settles last (an Undo also writes the entry it undoes, first)
    // 3. The journal entry that travels with it stays on this PC. It is checked before anything shared is written and written
    // after: it says the action succeeded, which is not so until the line is in both copies. A save that fails, or is cut off,
    // leaves the entry as it was (pending), and the next start offers the action for Retry.
    const revs: Record<string, number> = {};
    if (local) { const no = this.ops.refusal(opTx); if (no) return fail(no); }
    const text = JSON.stringify(line) + '\n'; const size = bytes(text);
    // which file: the deal's own, unless the change is to a deal itself or to the list of deals
    const dealOf = (kind: RecordKind, id: string, data: unknown) => (data as { dealId?: string } | null | undefined)?.dealId ?? (this.view.state(kind, id).heads[0]?.data as { dealId?: string } | undefined)?.dealId;
    const aboutDeals = tx.index?.dealId === GLOBAL || !!tx.purgeDeal || [...writes, ...deletes].some((r) => r.kind === 'deal');
    const deal = aboutDeals ? GLOBAL : tx.index?.dealId ?? writes.map((w) => dealOf(w.kind, w.id, w.data)).find(Boolean) ?? deletes.map((d) => dealOf(d.kind, d.id, null)).find(Boolean) ?? tx.audit?.[0]?.dealId ?? GLOBAL;
    const scope = /^[A-Za-z0-9][A-Za-z0-9_]*$/.test(deal) ? deal : GLOBAL;        // the id goes into a file name; anything unexpected is kept with the general changes
    const limit = this.o.segmentBytes ?? 1_000_000; let seg = this.segment.get(scope) ?? { n: 1, size: 0 };
    if (seg.size > 0 && seg.size + size > limit) seg = { n: seg.n + 1, size: 0 };          // this file is finished with; it will never change again
    const file = `changes-${this.id}-${scope}-${String(seg.n).padStart(4, '0')}.jsonl`;
    // The copy kept on this PC is written first: a line that is in the shared file is always in it too, so it can be put back if the
    // sync client loses it. A line this PC cannot keep is not written at all. (The look at the shared folder at the top of
    // every write has already put back anything lost, so the new line goes after the lines it follows.)
    const appended = this.appendChange(file, text, seq);
    if (!appended.ok) return appended;
    this.segment.set(scope, { n: seg.n, size: seg.size + size });
    this.seq = seq; this.view.add(line, true); this.read.set(file, (this.read.get(file) ?? 0) + size); this.ownLines.add(text.slice(0, -1));
    // each record's rev under the id it was asked by: as this PC had it, or its copy's
    for (const w of asked.writes) if (w.kind !== 'op') { const to = moved.get(w.id) ?? w.id; revs[w.id] = this.view.state(w.kind, to, had(w.kind, w.id)).rev; }
    if (local) await this.noteAppendedOperation(opTx, line.op, revs);
    this.lastSync = JSON.stringify(this.syncNow());
    // a change to a deal deleted elsewhere is work the deleting PC never saw: the window is told, so it keeps the copy
    if (asHad.size) for (const w of this.watchers) w({ kind: 'sync', id: '' });
    if (moved.size) this.tell([...writes, ...deletes].map((r) => recKey(r.kind, r.id)));   // the copy's records changed: a window showing them reads them again
    return ok(revs);
  }

  /** Use the confirmed change line if the journal cannot take its receipt yet (#565). */
  private async noteAppendedOperation(tx: Transaction, id: string | undefined, revs: Record<string, number>) {
    const saved = await this.ops.transaction(tx).catch(() => null);
    if (saved?.ok) Object.assign(revs, saved.value);
    // The Store will try the journal again with its complete result and Undo data.
    else if (id) this.ops.landed([id], false);
  }

  /** Forwarded saves must remain distinguishable from edits made directly in the recovered copy. */
  private markForwardedChanges(records: RecChange[], moved: Map<string, string>): void {
    const originals = new Map([...moved].map(([original, copy]) => [copy, original]));
    for (const record of records) {
      const original = originals.get(record.id);
      if (original && !record.del) record.recoveredFrom = original;
    }
  }

  /** Rebase only fields that no direct edit in the copy has touched, including changes later reverted. */
  private copyWrite(write: Write, to: string, ids: Map<string, string>, reopened: boolean): Result<Write> {
    const now = this.loaded(write.kind, to);
    if ((!now && this.view.known(write.kind, to)) || now?.conflict || write.resolves || write.beside || reopened) {
      return fail({ kind: 'rejected', message: DEAL_DELETED });
    }
    const before = this.view.lastHad(write.kind, write.id)[0]?.data;
    const heads = this.view.state(write.kind, to).tips.map((id) => this.view.version(id)!);
    if (recoveredWriteClashes({
      originalId: write.id, had: before, wrote: write.data, heads, version: (id) => this.view.version(id),
    })) return fail({ kind: 'rejected', message: DEAL_DELETED });
    return ok({
      kind: write.kind, id: to, data: changedOnto(before, write.data, now?.envelope.data, ids), expectedRev: 'any',
    });
  }

  /**
   * A change to a record of a deal another PC deleted. Refused where this PC deleted the deal. Where this PC's copy of the
   * deal holds the record already (or the copy is made, for a record new to it), the change goes to the copy: only the fields
   * it changes, laid over the copy's record as it is now, under the copy's ids. Before that, it is written to the record as
   * this PC had it (`asHad`), and the copy, made next, takes it. `moved` is each record's id in the copy, by the id it was asked by.
   */
  private toCopy(tx: Transaction, writes: Write[], deletes: Delete[]): Result<{ tx: Transaction; writes: Write[]; deletes: Delete[]; asHad: Set<string>; moved: Map<string, string> }> {
    const asHad = new Set<string>(); const moved = new Map<string, string>(); const ids = new Map<string, string>(); const worked = new Set<string>();
    for (const r of [...writes, ...deletes]) for (const d of this.view.goneWith(r.kind, r.id, ('data' in r ? r.data as { dealId?: unknown } | null : null)?.dealId)) {
      if (this.view.deletedBy(d).includes(this.id)) return fail({ kind: 'rejected', message: DEAL_GONE });
      const copyId = recoveredId(d, this.id);
      if (!this.readScope(this.scopeName(copyId))) return fail(this.miss);
      const made = this.view.known('deal', copyId);
      if (!worked.has(d)) { worked.add(d); for (const [was, now] of recoveredIds(d, copyId, this.hadOf(d))) if (was !== d || made) ids.set(was, now); }
      // a record new to the deal takes the id it would have had in the copy
      const to = r.kind === 'deal' ? copyId : ids.get(r.id) ?? recoveredIds(d, copyId, [{ kind: r.kind, id: r.id, versions: ['data' in r ? r.data : null] }]).get(r.id);
      if (to && (made || this.view.known(r.kind, to))) moved.set(r.id, to); else asHad.add(recKey(r.kind, r.id));
    }
    if (!moved.size) return ok({ tx, writes, deletes, asHad, moved });
    const map = new Map([...ids, ...moved]); const reopened = new Set((tx.reopen ?? []).map((r) => recKey(r.kind, r.id)));
    const w2: Write[] = []; const d2: Delete[] = [];
    for (const w of writes) {
      const to = moved.get(w.id); if (!to) { w2.push(w); continue; }
      const copied = this.copyWrite(w, to, map, reopened.has(recKey(w.kind, w.id)));
      if (!copied.ok) return copied;
      w2.push(copied.value);
    }
    for (const d of deletes) {
      const to = moved.get(d.id); if (!to) { d2.push(d); continue; }
      const heads = this.view.state(d.kind, to).tips.map((id) => this.view.version(id)!);
      if (recoveredWriteClashes({
        originalId: d.id, deleting: true, heads, version: (id) => this.view.version(id),
        // A forwarded delete's companion tombstone already records its original id.
        forwardedDeletion: (version) => this.view.lineMate(version, 'tombstone', to)?.recoveredFrom === d.id,
      })) return fail({ kind: 'rejected', message: DEAL_DELETED });
      const now = this.loaded(d.kind, to); if (!now) continue;          // deleted in the copy already
      if (now.conflict || d.resolves) return fail({ kind: 'rejected', message: DEAL_DELETED });
      d2.push({ kind: d.kind, id: to, expectedRev: null });
    }
    // what is filed, and the history written, go with the records: under the copy, once it is made
    return ok({ tx: { ...tx, ...(tx.index ? { index: remap(tx.index, map) } : {}), ...(tx.audit ? { audit: remap(tx.audit, map) } : {}) }, writes: w2, deletes: d2, asHad, moved });
  }

  /**
   * Before a change is checked and written, every deal it touches is read, so it is judged against all of that deal's changes
   * and built on its latest versions (a change built on part of a record's history would stand as a needless choice beside
   * it). A record with no deal known (one not found, with no `dealId` of its own) may be in a deal not read yet: every deal is.
   */
  private readForChange(writes: Transaction['writes'], deletes: NonNullable<Transaction['deletes']>, tx: Transaction): boolean {
    if (this.allRead) return true;
    if (!this.readScope(GLOBAL)) return false;                         // every change may be judged against the deals, or written with them
    const deals = new Set<string>();
    if (tx.index?.dealId) deals.add(tx.index.dealId);
    if (tx.purgeDeal) deals.add(tx.purgeDeal);
    for (const a of tx.audit ?? []) if (a.dealId) deals.add(a.dealId);
    for (const w of writes) { const d = (w.data as { dealId?: unknown } | null | undefined)?.dealId; if (typeof d === 'string') deals.add(d); }
    for (const d of deals) if (!this.readScope(this.scopeName(d))) return false;
    for (const r of [...writes, ...deletes]) {
      // a deal, or who has it, is in `_`, but a change to it may be held back on that deal's own lines (an edit to the deal
      // that also changed its checklist items): the deal is read, so the change is built on its latest version
      if (r.kind === 'deal' && !this.readScope(this.scopeName(r.id))) return false;
      if (ONLY_IN_DEALS.has(r.kind)) { for (const d of this.dealsOfRecord(r.kind, r.id)) if (!this.readScope(this.scopeName(d))) return false; continue; }
      const known = this.dealsOfRecord(r.kind, r.id);
      if (!known.length && !this.view.state(r.kind, r.id).heads.length && typeof (('data' in r ? r.data : null) as { dealId?: unknown } | null)?.dealId !== 'string') return this.readAll();
      for (const d of known) if (!this.readScope(this.scopeName(d))) return false;
    }
    return true;
  }

  /** Changes made on other PCs are found by looking: sync clients do not reliably say when a file has changed. */
  watch(onChange: (change: { kind: RecordKind | 'sync'; id: string }) => void, everyMs = 5000): () => void {
    this.watchers.add(onChange);
    if (!this.timer) { this.timer = setInterval(() => this.refresh(), everyMs); (this.timer as any).unref?.(); }
    return () => { this.watchers.delete(onChange); if (!this.watchers.size && this.timer) { clearInterval(this.timer); this.timer = null; } };
  }
}
