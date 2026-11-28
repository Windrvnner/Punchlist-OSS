/**
 * A deal's Q&A log: one consolidated log per deal, every party's questions in it, "Submitted by"
 * saying whose each is. The log is the team's own file on their NAS or drive, which people edit with or without the app;
 * the app records its location and mapped headers. The first spreadsheet imported into a deal is its log. A later
 * lender's list only adds and updates questions. An update reads the log as it is now and writes into it what the app
 * holds (logWrite), the version it replaces going to the folder's archive. A deal with no log imported gets one in the
 * app's own layout at its first update, in a folder a person picks. Replying to one party is an export filtered by
 * Submitted by, not a write into their file.
 */
import { dialogReportsFailure, resumeQaImportStep } from './qaImportJournal';
import type { Store } from './store';
import { localYmd, type QaLog, type Question } from '../domain/model';
import { dealQuestions, dealTwin, qaChanged, qaKept } from './state';
import { logHolds, matchRows, cellValue, readLogCells, holds, type LogWrite } from '../domain/logWrite';
import {
  KeepQaLog, SetQaLogFolder, RecordQaLogExport, ChooseQaVersion, TakeFromQaLog, fileTaken,
} from './commands/qaLogs';
import { windowsPath as samePath } from '../domain/sheets';
import { questionsSheet, suggestMapping, type Mapping, type ImportField } from '../domain/importExport';
import { ok, fail, invalid, rejected, type Failure, type Result } from '../domain/result';
import { logHeaders } from '../domain/qaLogLayout';
import { readLinkedLog, writeLinkedLog, type PlaceKept } from './qaLogFile';

export { keptRowTaken, NEW_KEPT_ROW, LEAVE_KEPT_OUT, type PlaceKept } from './qaLogFile';

/** a log's name: its file's name without the extension, and without " - vCurrent" */
export const logName = (file: string) => {
  const name = file.replace(/\.[^.]+$/, '').replace(/\s+-\s+vCurrent$/i, '');
  return name.trim() ? name : 'Q&A log';
};

/** the deal's log, if it has one */
export const logOf = (store: Store, dealId: string): QaLog | undefined => store.get().deals[dealId]?.qaLogs[0];

/** Opening a changed question marks its current log update seen and forgets marks from older updates. */
export function markQaLogSeen(store: Store, questionId: string) {
  const state = store.get();
  const updateOf = (id: string) => state.deals[state.questions[id]?.dealId]?.qaLogs[0]?.last?.at;
  const at = updateOf(questionId);
  const question = state.questions[questionId];
  if (at === undefined || !question || !qaChanged(state, question).length) return;
  const current = Object.fromEntries(Object.entries(state.prefs.qaSeen).filter(([id, when]) => updateOf(id) === when));
  store.setPrefs({ qaSeen: { ...current, [questionId]: at } });
}

/** a file's folder and name, from its full path ("X:\Deals\Proseware\Q&A log.xlsx") */
const placeOf = (full: string) => { const i = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/')); return i > 0 ? { folder: full.slice(0, i), file: full.slice(i + 1) } : null; };

/**
 * What an imported file can be to the deal's log, by where the file is (`path`, which only the desktop app knows):
 * 'same' when it is the deal's log already, 'new' when the deal has none and this file could be it, null otherwise.
 * A file in one of the deal's own document folders (the data room) is a document, never the log the app writes into.
 */
export function logChoice(store: Store, dealId: string, path: string | null): 'same' | 'new' | null {
  const at = path ? placeOf(path) : null; if (!store.services.qaLogs || !at) return null;   // the browser demo keeps no log
  const had = logOf(store, dealId); if (had) return samePath(had.folder) === samePath(at.folder) && samePath(had.file) === samePath(at.file) ? 'same' : null;
  const inside = (f: string) => { const a = samePath(at.folder), b = samePath(f); return a === b || a.startsWith(`${b}\\`); };
  return store.get().deals[dealId]?.folders.some((f) => inside(f.path)) ? null : 'new';
}

/** One file is one deal's Q&A log: why `path` can't be imported into this deal, or null when it can (#38) */
export function logTakenBy(store: Store, dealId: string, path: string | null): string | null {
  const at = path ? placeOf(path) : null;
  return at ? fileTaken(store.get(), dealId, at.file, at.folder, 'Choose another file') : null;
}

/**
 * After an import, keep the chosen log and record its cells through their own journal entries (#270).
 * The import has its own notice and Undo.
 */
export async function keepImportedLog(
  store: Store, dealId: string,
  t: {
    path: string | null; sheet: string; headerRow: number; columns: string[]; cols?: number[];
    mapping: Mapping; make: boolean; rows: string[][];
  },
  key?: string,
): Promise<Result<void>> {
  if (!t.path) return ok(undefined);
  const opts = { ...dialogReportsFailure, quiet: true, idempotencyKey: key };
  const kept = await resumeQaImportStep(store, key, KeepQaLog.name, async () => {
    const choice = logChoice(store, dealId, t.path);
    if (!choice || (choice === 'new' && !t.make)) return ok(undefined);
    const at = placeOf(t.path!)!;
    const { sheet, headerRow, mapping } = t;
    const name = logOf(store, dealId)?.name ?? logName(at.file);
    const log = { name, file: at.file, folder: at.folder, sheet, headerRow, mapping, headers: logHeaders(t) };
    return store.dispatch(KeepQaLog, { dealId, log }, opts);
  });
  if (!kept.ok) return kept;
  return resumeQaImportStep(store, key, RecordQaLogExport.name, async () => {
    const state = store.get();
    const deal = state.deals[dealId];
    const log = deal?.qaLogs[0];
    if (!log || logChoice(store, dealId, t.path) !== 'same') return ok(undefined);
    const questions = dealQuestions(state, dealId);
    const holds = logHolds({ rows: t.rows }, t.mapping, questions);
    // The new snapshot includes cell choices made since the previous update.
    const now = withPicks(log, questions);
    const savedCells = Object.entries(holds).map(([id, cells]) => [id, { ...now.sent[id], ...cells }]);
    const sent = { ...now.sent, ...Object.fromEntries(savedCells) };
    const last = {
      archive: log.last?.archive ?? '', at: store.services.clock.now(), by: store.get().user?.name ?? '',
      sent, kept: now.kept, changed: log.last?.changed ?? {},
    };
    // A retained snapshot includes the Resolve choices on these questions.
    const source = key ? {
      dealRev: deal.rev, questions: Object.fromEntries(questions.map(({ id, rev }) => [id, rev])),
    } : undefined;
    return store.dispatch(RecordQaLogExport, { dealId, name: log.name, last, source }, opts);
  });
}

/**
 * What the log holds of the app's (the last update's `sent`), with each choice made since in Resolve folded in (a
 * question's `logPick` for that update), and the cells still in two versions (`kept`) less those chosen for: the record
 * as it stands once the choices are counted.
 */
export function withPicks(log: QaLog, qs: Question[]): { sent: Record<string, Record<string, string>>; kept: Record<string, Record<string, string>> } {
  const sent: Record<string, Record<string, string>> = { ...(log.last?.sent ?? {}) }; const kept: Record<string, Record<string, string>> = { ...(log.last?.kept ?? {}) };
  for (const q of qs) {
    if (!q.logPick || q.logPick.of !== log.last?.at) continue;
    sent[q.id] = { ...sent[q.id], ...q.logPick.sent };
    if (kept[q.id]) { const rest = Object.fromEntries(Object.entries(kept[q.id]).filter(([k]) => !(k in q.logPick!.sent))); if (Object.keys(rest).length) kept[q.id] = rest; else delete kept[q.id]; }
  }
  return { sent, kept };
}

/** a question's cells as the log writes them, in the app's terms (readLogCells), dated by the app's clock */
const readCells = (store: Store, q: Question, cells: Record<string, string>) => readLogCells(q, cells, localYmd(store.services.clock.now()));

/** which of a question's cells in two versions the person picked: the app's, the log's, or a merged response (with the app's other cells) */
export type VersionPick = 'app' | 'log' | 'merged';

/**
 * A person resolves a question in two versions: the app's version, the log's, or a merged response. The
 * log's version is taken into the app as the import reads it (a status of "Outstanding" as Open, say), and recorded as
 * what the log holds of the app's, so the next update leaves those cells alone. The app's version (or the merged
 * response) is written into the log at the next update, where the log still says what the person was shown; a cell
 * changed in the file again since stays in two versions, as the person never saw that change. A merged response used as
 * the AI drafted it (`drafted`) keeps the AI's label; once a person changes its words it is theirs. `pick` may name
 * a version per field (`fields`: Status or Priority, say, where the person chose the other side's). One step with Undo.
 */
export async function chooseVersion(store: Store, dealId: string, questionId: string, pick: VersionPick, o: { merged?: string; drafted?: string; fields?: Record<string, 'app' | 'log'>; /** the update whose versions the person was shown (its `last.at`) */ seen?: string } = {}): Promise<Result<{ opId: string }>> {
  const s = store.get(); const q = s.questions[questionId]; const log = logOf(store, dealId);
  if (!q || q.dealId !== dealId || !log) return fail({ kind: 'notFound', message: 'Question not found' });
  const shown = qaKept(s, q); if (!Object.keys(shown).length) return fail({ kind: 'rejected', message: `Q${q.n} is no longer in two versions` });
  // an update since the person was shown the versions may have changed them: they look again before choosing
  if (o.seen !== undefined && o.seen !== log.last?.at) return fail({ kind: 'rejected', message: 'The Q&A log was updated since. Look at the versions again' });
  const side = (k: string) => o.fields?.[k] ?? (pick === 'log' ? 'log' : 'app');
  const theirs = Object.fromEntries(Object.entries(shown).filter(([k]) => side(k) === 'log' && !(pick === 'merged' && k === 'response')));
  const set = readCells(store, q, theirs);
  if (pick === 'merged') set.response = o.merged ?? '';
  // Every cell shown is recorded as what the log holds of the app's. The file is not read again here (a full read of the
  // workbook per choice, and none at all while the drive is out of reach): the next update settles it. Where the cell still
  // says what was shown, the app's goes in; where someone changed it again since, it is neither, and stays in two versions.
  const r = await store.dispatch(ChooseQaVersion, { dealId, questionId, of: log.last!.at, set, sent: shown, ...(pick === 'merged' && o.drafted !== undefined && o.merged === o.drafted ? { origin: 'ai' as const } : {}) }, { quiet: true });
  return r.ok ? ok({ opId: r.value.opId }) : r;
}

/** a folder, from the folder picker; null when the person cancels */
async function pickFolder(store: Store): Promise<Result<string | null>> {
  const pick = store.services.fs.pickFolders; if (!pick) return fail({ kind: 'rejected', message: 'Folders can only be chosen in the desktop app' });
  const r = await pick(); if (!r.ok) return r; return ok(r.value[0] || null);
}

/** where the log is now, when it has moved: the folder picker, for a person to choose; null when they cancel */
export async function chooseLogFolder(store: Store, dealId: string): Promise<Result<string | null>> {
  const log = logOf(store, dealId); if (!log) return fail({ kind: 'notFound', message: 'This deal has no Q&A log yet' });
  const r = await pickFolder(store); if (!r.ok || !r.value) return r;
  const set = await store.dispatch(SetQaLogFolder, { dealId, name: log.name, folder: r.value }); return set.ok ? ok(r.value) : set;
}

/** a deal with no log imported: one is made in the app's own layout (as Export writes it), in a folder a person picks */
async function startLog(store: Store, dealId: string): Promise<Result<QaLog | null>> {
  const files = store.services.qaLogs!; const d = store.get().deals[dealId]; if (!d) return fail({ kind: 'notFound', message: 'Deal not found' });
  const folder = await pickFolder(store); if (!folder.ok || !folder.value) return folder.ok ? ok(null) : folder;
  const grid = questionsSheet(dealQuestions(store.get(), dealId)); const w = await store.services.sheets.write('Q&A log', grid); if (!w.ok) return w;
  const twin = dealTwin(store.get(), d, true).replace(/[\\/:*?"<>|]/g, ' ');   // a deal that shares its name says which it is, so the two logs' files differ
  const name = `${d.name}${twin ? ` (${twin})` : ''} Q&A log`; const made = await files.create({ folder: folder.value, file: `${name}.${w.value.ext}`, bytes: w.value.bytes }); if (!made.ok) return made;
  const columns = grid[0].map(String);
  const log = {
    name, file: made.value.file, folder: folder.value, sheet: 'Q&A log', headerRow: 1,
    mapping: suggestMapping(columns), headers: logHeaders({ columns }),
  };
  const r = await store.dispatch(KeepQaLog, { dealId, log }, { quiet: true });
  return r.ok ? ok(logOf(store, dealId)!) : r;
}

export type ExportOutcome =
  | {
      status: 'written';
      archive: string;
      added: number;
      answered: number;
      updated: number;
      /** questions that took in cells changed in the log */
      changed: number;
      /** questions in two versions */
      kept: number[];
      keptText: Record<string, Record<string, string>>;
      /**
       * questions where an edit kept aside and the log each changed a cell, the log's value kept,
       * and not in two versions
       */
      clashed: number[];
      /**
       * edits kept aside filed in the archive with some of their changes not in the log,
       * nor reported in `kept` or `clashed`
       */
      unmerged: number;
      created?: true;
    }
  | { status: 'later'; by?: string }
  | { status: 'canceled' };

/** what the update compared for each question it takes cells for, so a later edit is never replaced (#40) */
function comparedValues(qs: Question[], taken: Record<string, Record<string, string>>) {
  const byId = new Map(qs.map((q) => [q.id, q] as const));
  return Object.fromEntries(Object.entries(taken).flatMap(([id, cells]) => {
    const q = byId.get(id);
    return q ? [[id, Object.fromEntries(Object.keys(cells).map((k) => [k, cellValue(q, k as ImportField)]))]] : [];
  }));
}

/** Take against the same questions used to plan the update, even if one was deleted during the save (#1392). */
async function takeLogEdits(
  store: Store,
  dealId: string,
  questions: Question[],
  taken: LogWrite['taken'],
  tracking: Record<'held' | 'now' | 'kept' | 'changed', LogWrite['sent']>,
) {
  const before = questions.filter((question) => taken[question.id]);
  const set = Object.fromEntries(before.map((question) => [
    question.id, readCells(store, question, taken[question.id]),
  ]));
  const expect = comparedValues(questions, taken);
  const result = await store.dispatch(TakeFromQaLog, { dealId, set, expect }, { quiet: true });
  if (!result.ok) return result;

  const { held, now, kept, changed } = tracking;
  for (const previous of before) {
    const id = previous.id;
    const question = store.get().questions[id];
    for (const [field, value] of Object.entries(taken[id])) {
      if (question && holds(question, field, set[id][field])) {
        (changed[id] ??= {})[field] = cellValue(previous, field as ImportField);
        continue;
      }
      if (question) (kept[id] ??= {})[field] = value;
      // Only applied takes become the last-written value. A deleted question can be restored later.
      const prior = held[id]?.[field];
      now[id] = { ...now[id] };
      if (prior === undefined) delete now[id][field];
      else now[id][field] = prior;
    }
  }
  return result;
}

/**
 * Bring the deal's log up to date with everything the app holds (logWrite), in the file itself. A failure after the log was
 * saved still says how many kept edits it filed not fully merged.
 */
type ExportResult = Result<ExportOutcome> & { unmerged?: number };

export function exportQaLog(store: Store, dealId: string, place?: PlaceKept): Promise<ExportResult> {
  return runLogUpdate(store, dealId, fail(rejected('Q&A log is being updated')),
    () => writeQaLog(store, dealId, place));
}

async function writeQaLog(store: Store, dealId: string, place?: PlaceKept): Promise<ExportResult> {
  const files = store.services.qaLogs; if (!files) return fail({ kind: 'rejected', message: 'Q&A logs are updated from the desktop app' });
  let log = logOf(store, dealId); let created = false;
  if (!log) {
    const s = await startLog(store, dealId);
    if (!s.ok) return s;
    if (!s.value) return ok({ status: 'canceled' });
    log = s.value;
    created = true;
  }
  // an edit a save kept aside comes in with the log: the table read has it, and its steps are saved with the update's
  const read = await readLinkedLog(files, log, true);
  if (!read.ok) return read;
  await store.loadDeal(dealId);                                                   // a retry may come while another deal is open
  const qs = dealQuestions(store.get(), dealId);
  // what the log holds of ours: the last update's record, with each choice made since in Resolve (kept on its question)
  const held = withPicks(log, qs).sent; const chosen = new Set(qs.filter((q) => q.logPick && q.logPick.of === log.last?.at).map((q) => q.id));
  const sent = new Map(Object.entries(held));
  const written = await writeLinkedLog(files, log, read.value, qs, sent, place);
  if (!written.ok) return written;
  if (written.value.status !== 'written') return ok(written.value);
  const { table, mapping, plan, kept, archive } = written.value;
  // a row where they and the log each changed a cell is reported as kept as in the file: the log's value stayed
  const asked = new Set<number>(); const clash: number[] = [];                    // clash rows with a question in the app, and their numbers
  if (kept?.clashes.length) {
    const at = new Map([...matchRows(table, mapping, qs, sent)].map(([id, i]) => [i, id]));
    const byId = new Map(qs.map((q) => [q.id, q.n]));
    for (const i of kept.clashes) { const n = byId.get(at.get(i) ?? ''); if (n === undefined) continue; asked.add(i); if (!clash.includes(n)) clash.push(n); }
    clash.sort((a, b) => a - b);
  }
  // An edit filed with some of its changes not in the log, and not reported above (a clash on a row the app has no question
  // for), is counted in the notice, so nobody's words go unnoticed. One the archive refuses now stays in the
  // folder marked so, and the update that files it counts it.
  const left = (f: { left?: true; clashes?: number[] }) => !!f.left || !!f.clashes?.some((i) => !asked.has(i));
  // Filed once the log is saved, even when what follows fails: merged again later, an edit would undo what people did since.
  // The kept edits are in the log now, as far as they can be: each goes to the archive, then from the folder.
  let filed: Promise<number> | undefined;
  const settle = () => (filed ??= (async () => {
    const done = kept?.files.length ? await files.settle?.({ folder: log.folder, file: log.file, kept: kept.files.map((f) => ({ name: f.name, hash: f.hash, ...(left(f) ? { left: true } : {}) })) }) : undefined;
    const gone = new Set(done?.ok ? done.value.gone : []);
    return (kept?.files ?? []).filter((f) => gone.has(f.name) && left(f)).length;
  })());
  const settleThen = async <E extends object>(r: E): Promise<E & { unmerged?: number }> => { const unmerged = await settle(); return unmerged ? { ...r, unmerged } : (r as E & { unmerged?: number }); };
  // what the log now holds of ours, for the next update; a question the log has no row for keeps what was sent before
  const now: Record<string, Record<string, string>> = { ...held, ...plan.sent };
  // the cells only the log changed are the latest: the app takes them, in one step, and marks the questions Changed with
  // what each cell held before. One the app cannot take as it is (an Answered status with no response,
  // say) is left in two versions, its cell recorded as before, so the next update never writes over it.
  const keptText = { ...plan.keptText }; const changed: Record<string, Record<string, string>> = {};
  if (Object.keys(plan.taken).length) {
    const took = await takeLogEdits(store, dealId, qs, plan.taken, { held, now, kept: keptText, changed });
    if (!took.ok) return settleThen(took);
  }
  // a choice that reached this PC while the file was being saved (made here, or on another PC) answers the update this one
  // replaces: it is counted now, as the next update writes it, rather than asked again
  for (const q of dealQuestions(store.get(), dealId)) {
    if (chosen.has(q.id) || !q.logPick || q.logPick.of !== log.last?.at) continue;
    for (const [k, v] of Object.entries(q.logPick.sent)) {
      if (keptText[q.id]?.[k] !== undefined && keptText[q.id][k] !== v) continue;   // changed in the file again since the person saw it: still theirs
      now[q.id] = { ...now[q.id], [k]: v }; if (keptText[q.id]) { delete keptText[q.id][k]; if (!Object.keys(keptText[q.id]).length) delete keptText[q.id]; }
    }
  }
  // the cells the update left as the log has them are in two versions until a person chooses (Resolve); this update's
  // reading replaces the last one's, so a cell settled in the file since is no longer listed
  const rec = await store.dispatch(RecordQaLogExport, { dealId, name: log.name, last: { archive, at: store.services.clock.now(), by: store.get().user?.name ?? '', sent: now, kept: keptText, changed } }, { quiet: true });
  const unmerged = await settle();
  if (!rec.ok) return unmerged ? { ...rec, unmerged } : rec;                       // filed all the same, so still said
  const versions = dealQuestions(store.get(), dealId).filter((q) => keptText[q.id]).map((q) => q.n);
  // a question where an edit kept aside clashed with the log is said as kept as in the file, unless it is in two versions
  const clashed = clash.filter((n) => !versions.includes(n));
  const { added, answered, updated } = plan;
  return ok({
    status: 'written', archive, added, answered, updated, changed: Object.keys(changed).length,
    kept: versions, keptText, clashed, unmerged, ...(created ? { created: true as const } : {}),
  });
}

type WrittenLog = Extract<ExportOutcome, { status: 'written' }>;
type UpdateCounts = Pick<WrittenLog, 'added' | 'answered' | 'updated' | 'changed' | 'unmerged'>;
type RetryLog = () => Promise<QaLogUpdateOutcome>;

export type QaLogUpdateOutcome =
  | { kind: 'busy' | 'canceled' }
  | { kind: 'failed'; error: Failure; unmerged: number }
  | { kind: 'retrying'; by?: string; retry: RetryLog }
  | { kind: 'retryLimit'; minutes: number; retry: RetryLog }
  | { kind: 'created'; unmerged: number }
  | { kind: 'updated'; counts: UpdateCounts; versions: number; clashed: number;
      action?: { kind: 'resolve' } | { kind: 'show'; questionId: string } };

type UpdateOptions = {
  place?: PlaceKept;
  /** Offers the outcome to the caller, also for background attempts. A waiting notice may supply its dismissal. */
  announce?: (outcome: QaLogUpdateOutcome) => (() => void) | undefined;
};
type WaitingUpdate = { timer: ReturnType<typeof setTimeout>; tries: number; dismiss?: () => void };
type LogUpdates = { running: Map<string, Promise<void>>; waiting: Map<string, WaitingUpdate> };
const logUpdates = new WeakMap<Store, LogUpdates>();
const RETRY_MS = 30_000;
const LOG_RETRIES = 40;

async function runLogUpdate<T>(store: Store, dealId: string, busy: T, run: (updates: LogUpdates) => Promise<T>) {
  let updates = logUpdates.get(store);
  if (!updates) {
    updates = { running: new Map(), waiting: new Map() };
    logUpdates.set(store, updates);
  }
  if (updates.running.has(dealId)) return busy;
  let finished!: () => void;
  updates.running.set(dealId, new Promise((resolve) => { finished = resolve; }));
  try {
    return await run(updates);
  } finally {
    updates.running.delete(dealId);
    finished();
  }
}

function writtenOutcome(store: Store, dealId: string, written: WrittenLog): QaLogUpdateOutcome {
  const { created, unmerged, changed, added, answered, updated, kept, clashed } = written;
  if (created) return { kind: 'created', unmerged };
  const questions = dealQuestions(store.get(), dealId);
  const clash = questions.find((question) => clashed.includes(question.n));
  const versions = questions.some((question) => kept.includes(question.n)) ? kept.length : 0;
  const action = versions ? { kind: 'resolve' as const }
    : clash ? { kind: 'show' as const, questionId: clash.id } : undefined;
  return { kind: 'updated', counts: { unmerged, changed, added, answered, updated }, versions,
    clashed: clash ? clashed.length : 0, action };
}

/** Update now, then retry a busy file every half minute for up to 20 minutes. */
export function updateQaLog(store: Store, dealId: string, options: UpdateOptions = {}): Promise<QaLogUpdateOutcome> {
  return attemptQaLog(store, dealId, options, false);
}

function waitForLog(store: Store, dealId: string, options: UpdateOptions,
  updates: LogUpdates, tries: number, by?: string): QaLogUpdateOutcome {
  const retry = () => updateQaLog(store, dealId, options);
  if (tries >= LOG_RETRIES) return { kind: 'retryLimit', minutes: RETRY_MS * LOG_RETRIES / 60_000, retry };
  const queued: WaitingUpdate = {
    timer: setTimeout(() => void retryWhenIdle(store, dealId, options, updates, queued), RETRY_MS),
    tries: tries + 1,
  };
  updates.waiting.set(dealId, queued);
  return { kind: 'retrying', by, retry };
}

/** A direct export can still be writing when a retry is due. Keep the retry and its notice until the write finishes. */
async function retryWhenIdle(store: Store, dealId: string, options: UpdateOptions,
  updates: LogUpdates, queued: WaitingUpdate) {
  while (updates.waiting.get(dealId) === queued) {
    const running = updates.running.get(dealId);
    if (!running) {
      await attemptQaLog(store, dealId, options, true);
      return;
    }
    await running;
  }
}

async function attemptQaLog(store: Store, dealId: string, options: UpdateOptions, automatic: boolean) {
  const result = await runLogUpdate<QaLogUpdateOutcome>(store, dealId, { kind: 'busy' }, async (updates) => {
    const queued = updates.waiting.get(dealId);
    if (queued) {
      clearTimeout(queued.timer);
      updates.waiting.delete(dealId);
      queued.dismiss?.();
    }
    // A background retry never starts a replacement log if the deal or its log has since gone.
    if (automatic && !logOf(store, dealId)) return { kind: 'canceled' };
    const result = await writeQaLog(store, dealId, options.place);
    let outcome: QaLogUpdateOutcome;
    if (!result.ok) outcome = { kind: 'failed', error: result.error, unmerged: result.unmerged ?? 0 };
    else if (result.value.status === 'written') outcome = writtenOutcome(store, dealId, result.value);
    else if (result.value.status === 'canceled') outcome = { kind: 'canceled' };
    else outcome = waitForLog(store, dealId, options, updates, queued?.tries ?? 0, result.value.by);
    const dismiss = options.announce?.(outcome);
    const next = updates.waiting.get(dealId);
    if (next) next.dismiss = dismiss;
    return outcome;
  });
  if (result.kind === 'busy' && !automatic) options.announce?.(result);
  return result;
}
