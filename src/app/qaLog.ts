/**
 * A deal's Q&A log: one consolidated log per deal, every party's questions in it, "Submitted by"
 * saying whose each is. The log is the team's own file on their NAS or drive, which people edit with or without the app;
 * the app keeps no copy, only where the file is. The first spreadsheet imported into a deal is its log; a later import (one
 * lender's list) only adds and updates questions. An update reads the log as it is now and writes into it what the app
 * holds (logWrite), the version it replaces going to the folder's archive. A deal with no log imported gets one in the
 * app's own layout at its first update, in a folder a person picks. Replying to one party is an export filtered by
 * Submitted by, not a write into their file.
 */
import type { Store } from './store';
import { localYmd, type QaLog, type Question } from '../domain/model';
import { dealQuestions, dealTwin, qaChanged, qaKept } from './state';
import { logWrite, logHolds, matchRows, cellValue, readLogCells, holds } from '../domain/logWrite';
import {
  KeepQaLog, SetQaLogFolder, RecordQaLogExport, ChooseQaVersion, TakeFromQaLog, fileTaken, windowsPath as samePath,
} from './commands/qaLogs';
import { questionsSheet, suggestMapping, type Mapping, type ImportField } from '../domain/importExport';
import { ok, fail, invalid, type Result } from '../domain/result';
import { cell, type KeptAsk } from '../domain/keptMerge';
import type { SheetEdit } from '../domain/sheets';
import type { QaLogFiles } from '../ports';

/** a log's name: its file's name without the extension, and without " - vCurrent" */
export const logName = (file: string) => file.replace(/\.[^.]+$/, '').replace(/\s+-\s+vCurrent$/i, '').trim() || 'Q&A log';

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
 * After an import: a file becomes the deal's log only when a person said so in the import (`make`); the
 * deal's log imported again keeps where its table is. Any other file only brought questions in. Quietly: the import
 * has its own notice and Undo.
 */
export async function keepImportedLog(store: Store, dealId: string, t: { path: string | null; sheet: string; headerRow: number; mapping: Mapping; make: boolean; rows: string[][] }): Promise<Result<void>> {
  const choice = logChoice(store, dealId, t.path); if (!choice || (choice === 'new' && !t.make)) return ok(undefined);
  const at = placeOf(t.path!)!; const had = logOf(store, dealId);
  const r = await store.dispatch(KeepQaLog, { dealId, log: { name: had?.name ?? logName(at.file), file: at.file, folder: at.folder, sheet: t.sheet, headerRow: t.headerRow, mapping: t.mapping } }, { quiet: true });
  if (!r.ok) return r;
  // What the file holds is recorded as what the app last wrote: the questions now say what it says, so a cell a person
  // later changes in the app is the app's to bring up to date, and one someone changes in the file is theirs (logWrite).
  const log = logOf(store, dealId)!; const qs = dealQuestions(store.get(), dealId); const holds = logHolds({ rows: t.rows }, t.mapping, qs);
  // the record is dated anew, so a choice made in Resolve since the last update is folded in here, or it would be asked again
  const now = withPicks(log, qs);
  const rec = await store.dispatch(RecordQaLogExport, { dealId, name: log.name, last: { archive: log.last?.archive ?? '', at: store.services.clock.now(), by: store.get().user?.name ?? '', sent: { ...now.sent, ...Object.fromEntries(Object.entries(holds).map(([id, h]) => [id, { ...now.sent[id], ...h }])) }, kept: now.kept, changed: log.last?.changed ?? {} } }, { quiet: true });
  return rec.ok ? ok(undefined) : rec;
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
  const r = await store.dispatch(KeepQaLog, { dealId, log: { name, file: made.value.file, folder: folder.value, sheet: 'Q&A log', headerRow: 1, mapping: suggestMapping(grid[0].map(String)) } }, { quiet: true });
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

/**
 * Where each of a kept edit's rows that the log can't say for sure goes: for each, the index of the row picked in its
 * `rows`, -1 for a row of its own, or -2 to leave it out (in the archive only, and said so); null when the person closes the
 * ask, which leaves the update for later.
 */
export type PlaceKept = (ask: KeptAsk[]) => Promise<number[] | null>;

export const NEW_KEPT_ROW = -1;
export const LEAVE_KEPT_OUT = -2;

/** Each existing row can take at most one of the edits being placed. */
export function keptRowTaken(asks: KeptAsk[], choices: (number | undefined)[], edit: number, candidate: number) {
  const row = asks[edit]?.rows[candidate]?.row;
  return row !== undefined && choices.some((choice, index) =>
    index !== edit && choice !== undefined && asks[index]?.rows[choice]?.row === row);
}

function validKeptPlacement(asks: KeptAsk[], choices: number[]) {
  return choices.length === asks.length && asks.every((ask, edit) => {
    const choice = choices[edit];
    return choice === NEW_KEPT_ROW || choice === LEAVE_KEPT_OUT ||
      (Number.isInteger(choice) && !!ask.rows[choice] && !keptRowTaken(asks, choices, edit, choice));
  });
}

type LogTable = Extract<Awaited<ReturnType<QaLogFiles['read']>>, { ok: true }>['value'];
type KeptLogEdits = NonNullable<LogTable['kept']>;

/** Place each retained edit where chosen. Edits left out will be filed in the archive. */
function placeLogEdits(kept: KeptLogEdits, choices: number[], below: number) {
  const picked: SheetEdit[] = [];
  const own: SheetEdit[] = [];
  const clashes = [...kept.clashes];
  const out = new Set<string>();
  let nextNewRow = below + 1;
  for (const [index, edit] of (kept.ask ?? []).entries()) {
    if (choices[index] === LEAVE_KEPT_OUT) {
      out.add(edit.file);
      continue;
    }
    const target = edit.rows[choices[index]];
    if (target) {
      picked.push(...target.steps);
      if (target.clash && !clashes.includes(target.row)) clashes.push(target.row);
      continue;
    }
    const row = nextNewRow++;
    own.push({ kind: 'rows', after: row - 1, count: 1 }, ...edit.add.map(({ col, value }) => cell(row, col, value)));
  }
  const files = kept.files.map((file) => out.has(file.name) ? { ...file, left: true as const } : file);
  return { picked, own, kept: { ...kept, files, clashes: clashes.sort((left, right) => left - right) } };
}

/** what the update compared for each question it takes cells for, so a later edit is never replaced (#40) */
function comparedValues(qs: Question[], taken: Record<string, Record<string, string>>) {
  const byId = new Map(qs.map((q) => [q.id, q] as const));
  return Object.fromEntries(Object.entries(taken).flatMap(([id, cells]) => {
    const q = byId.get(id);
    return q ? [[id, Object.fromEntries(Object.keys(cells).map((k) => [k, cellValue(q, k as ImportField)]))]] : [];
  }));
}

/**
 * Bring the deal's log up to date with everything the app holds (logWrite), in the file itself. A failure after the log was
 * saved still says how many kept edits it filed not fully merged.
 */
export async function exportQaLog(store: Store, dealId: string, place?: PlaceKept): Promise<Result<ExportOutcome> & { unmerged?: number }> {
  const files = store.services.qaLogs; if (!files) return fail({ kind: 'rejected', message: 'Q&A logs are updated from the desktop app' });
  let log = logOf(store, dealId); let created = false;
  if (!log) {
    const s = await startLog(store, dealId);
    if (!s.ok) return s;
    if (!s.value) return ok({ status: 'canceled' });
    log = s.value;
    created = true;
  }
  const mapping = log.mapping as Mapping;
  // an edit a save kept aside comes in with the log: the table read has it, and its steps are saved with the update's
  let table = await files.read({ folder: log.folder, file: log.file }, { sheet: log.sheet, headerRow: log.headerRow, ...(mapping.text != null ? { kept: { text: mapping.text, ...(mapping.n != null ? { n: mapping.n } : {}), ...(mapping.askedBy != null ? { by: mapping.askedBy } : {}) } } : {}) }); if (!table.ok) return table;
  await store.loadDeal(dealId);                                                   // a retry may come while another deal is open
  const qs = dealQuestions(store.get(), dealId);
  // what the log holds of ours: the last update's record, with each choice made since in Resolve (kept on its question)
  const held = withPicks(log, qs).sent; const chosen = new Set(qs.filter((q) => q.logPick && q.logPick.of === log.last?.at).map((q) => q.id));
  const sent = new Map(Object.entries(held));
  let w = logWrite(table.value, mapping, qs, sent); let kept = table.value.kept;
  // A row of a kept edit the log can't say for sure goes where the person says: into a row (a cell both
  // changed keeps the log's, and is reported), as a row of its own below the update's own, or left out (then the notice
  // says the edit was not fully merged). Closing the ask leaves the whole update for later, so it is asked again.
  let picked: SheetEdit[] = [];
  let own: SheetEdit[] = [];
  if (kept?.ask?.length) {
    const choices = place ? await place(kept.ask) : null;
    if (!choices) return ok({ status: 'canceled' });
    if (!validKeptPlacement(kept.ask, choices)) {
      return fail(invalid('Each kept edit needs its own log row or placement'));
    }
    const below = table.value.lastRow - 1 + w.steps.reduce((count, step) =>
      count + (step.kind === 'rows' ? step.count : 0), 0);
    ({ kept, picked, own } = placeLogEdits(kept, choices, below));
  }
  const steps = [...(kept?.steps ?? []), ...picked, ...w.steps, ...own];
  // nothing to write (a log just made holds everything) leaves the file alone; what it holds of ours is still recorded
  let archive = '';
  if (steps.length) {
    const save = (s: typeof steps, stamp: string) => files.save({ folder: log.folder, file: log.file, sheet: log.sheet, steps: s, stamp });
    let r = await save(steps, table.value.stamp);
    // A save the log's content refuses with a kept edit's steps (a table ending in a totals row) never holds the update up:
    // it is made again without them, from the log read afresh, and the kept edits go to the archive as they are, never
    // hidden (they would be refused at every update). Any other failure (the share is gone) touches nothing.
    if (!r.ok && r.error.kind === 'rejected' && kept?.steps.length) {
      table = await files.read({ folder: log.folder, file: log.file }, { sheet: log.sheet, headerRow: log.headerRow }); if (!table.ok) return table;
      w = logWrite(table.value, mapping, qs, sent); kept = { files: kept.files.map((f) => ({ name: f.name, hash: f.hash, ...(f.left || f.steps || f.clashes?.length ? { left: true as const } : {}) })), steps: [], clashes: [] };   // what was to be merged is not now
      r = w.steps.length ? await save(w.steps, table.value.stamp) : ok({ status: 'written' as const, archive: '' });
    }
    if (!r.ok) return r;
    if (r.value.status === 'later') return ok({ status: 'later', ...(r.value.by ? { by: r.value.by } : {}) });
    archive = r.value.archive;
  }
  // a row where they and the log each changed a cell is reported as kept as in the file: the log's value stayed
  const asked = new Set<number>(); const clash: number[] = [];                    // clash rows with a question in the app, and their numbers
  if (kept?.clashes.length) {
    const read = table.value; const at = new Map([...matchRows(read, mapping, qs, sent)].map(([id, i]) => [i, id])); const byId = new Map(qs.map((q) => [q.id, q.n]));
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
  const now: Record<string, Record<string, string>> = { ...held, ...w.sent };
  // the cells only the log changed are the latest: the app takes them, in one step, and marks the questions Changed with
  // what each cell held before. One the app cannot take as it is (an Answered status with no response,
  // say) is left in two versions, its cell recorded as before, so the next update never writes over it.
  const keptText = { ...w.keptText }; const changed: Record<string, Record<string, string>> = {};
  const was = new Map(qs.filter((q) => w.taken[q.id]).map((q) => [q.id, q] as const));
  if (Object.keys(w.taken).length) {
    const set = Object.fromEntries(Object.entries(w.taken).map(([id, cells]) => [id, readCells(store, store.get().questions[id], cells)]));
    const expect = comparedValues(qs, w.taken);
    const took = await store.dispatch(TakeFromQaLog, { dealId, set, expect }, { quiet: true });
    if (!took.ok) return settleThen(took);
    // taken where the question now says what the log does, read in the app's terms ("Outstanding" as Open)
    for (const [id, cells] of Object.entries(w.taken)) {
      const q = store.get().questions[id]; const before = was.get(id); if (!q || !before) continue;
      for (const [k, v] of Object.entries(cells)) {
        if (holds(q, k, set[id][k])) (changed[id] ??= {})[k] = cellValue(before, k as ImportField);
        else { (keptText[id] ??= {})[k] = v; const prior = held[id]?.[k]; now[id] = { ...now[id] }; if (prior === undefined) delete now[id][k]; else now[id][k] = prior; }
      }
    }
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
  return ok({ status: 'written', archive, added: w.added, answered: w.answered, updated: w.updated, changed: Object.keys(changed).length, kept: versions, keptText, clashed, unmerged, ...(created ? { created: true as const } : {}) });
}
