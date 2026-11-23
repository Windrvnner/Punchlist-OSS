/**
 * Import Q&A log: the person picks a spreadsheet, checks where its table is and which column holds what, sees what the
 * import will add and overwrite, and imports. The import in progress is kept on this PC as it changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Modal, DialogHead } from './dialogs';
import { FileInput, PickFileRow } from './fileDrop';
import { dealQuestions } from '../app/state';
import { readImportFile, readImportBytes, proposeLayout, previewImport, type ImportTable } from '../app/transfer';
import { prepareImport, importCounts, type Mapping, type ImportRow } from '../domain/importExport';
import { ImportQuestions } from '../app/commands/importQuestions';
import { keepImportedLog, logTakenBy } from '../app/qaLog';
import { SERVICE } from '../control';
import {
  keptImport, keepImport, saveImport, dropImport, importKey, useKeptImportsReady, useFreshOnCrash,
} from './keptImports';
import { Operation } from '../domain/model';
import { fail, ok } from '../domain/result';
import { QaImportForm } from './qaImportForm';
import type { Store } from '../app/store';

/** What the dialog is doing while the person waits */
export type Busy = '' | 'reading' | 'importing' | 'asking';
/** a sheet or heading row chosen in the import and being read */
type Rereading = { sheet?: string; headerRow?: number };
/** What happens to questions the file already holds: changed in place, or added again as new ones */
export type ImportMode = 'merge' | 'append';

/** The files the Q&A import reads */
const SPREADSHEETS = '.xlsx,.xlsm,.xls,.xlsb,.ods,.csv';

/** the Q&A import as it was left: the file as read, and every choice made for it */
interface QaChoices {
  mapping: Mapping;
  path: string | null;
  mode: ImportMode;
  answered: boolean;
  makeLog: boolean;
  touched: boolean;
}
interface QaKept { table: ImportTable; choices: QaChoices }
interface Submission {
  key: string;
  table: Omit<ImportTable, 'bytes'>;
  choices: QaChoices;
  rows: ImportRow[];
  done?: boolean;
}

/** The Q&A import picks up where it was left on this PC: it waits the moment it takes to read what was kept */
export function ImportDialog({ dealId }: { dealId: string }) {
  const ready = useKeptImportsReady();
  const fresh = useFreshOnCrash();
  return !ready || fresh === 'gone' ? null : <QaImportDialog key={String(fresh)} dealId={dealId} fresh={fresh} />;
}

function QaImportDialog({ dealId, fresh }: { dealId: string; fresh: boolean }) {
  const store = useStore();
  const qa = useQaImportState(dealId, fresh);
  const plan = useImportPlan(store, dealId, qa);
  const actions = useQaImportActions(store, dealId, qa, plan);
  const { table, mapping, busy, error } = qa;
  const read = (file: File) => void actions.load(file);
  const fileInput = <FileInput id="im-file" accept={SPREADSHEETS} inputRef={qa.fileRef} onFile={read} />;
  const browse = () => qa.fileRef.current?.click();

  // one Modal for both steps, so reading a file or going back to pick another keeps the same dialog: no second
  // opening animation, and the focus stays where it was
  return (
    <Modal onClose={actions.close} label="Import Q&A log" blur className="sdlg imdlg">
      <DialogHead title="Import Q&A Log" onClose={actions.close} disabled={busy === 'importing'} />
      {table && mapping
        ? <QaImportForm store={store} dealId={dealId} qa={{ ...qa, table, mapping }} plan={plan} actions={actions} />
        : <>
          <PickFileRow dropId="im-drop" errorId="im-error" error={error} onFile={read}>
            Drop an .xlsx or .csv here, or{' '}
            <button type="button" class="linkb" id="im-browse" onClick={browse}>choose a file…</button>
            {fileInput}
          </PickFileRow>
          {busy === 'reading' && <div class="xfoot"><span>Reading the file</span></div>}
        </>}
    </Modal>
  );
}

/** Checks that what was kept is still a whole Q&A import, so a damaged or older entry starts a fresh one instead */
function isQaKept(value: unknown): value is QaKept {
  const kept = value as QaKept | undefined;
  return isKeptTable(kept?.table) && isKeptChoices(kept?.choices);
}

function isKeptTable(table: ImportTable | undefined) {
  return !!table
    && typeof table.name === 'string'
    && Array.isArray(table.rows) && table.rows.every(Array.isArray)
    && Array.isArray(table.columns)
    && Array.isArray(table.sheets)
    && Array.isArray(table.previews)
    && typeof table.sheet === 'string'
    && Number.isInteger(table.headerRow)
    && Number.isInteger(table.lastRow)
    && (table.lines === undefined || Array.isArray(table.lines))
    && table.bytes instanceof Uint8Array;
}

function isKeptChoices(choices: QaChoices | undefined) {
  return !!choices
    && !!choices.mapping && typeof choices.mapping === 'object' && 'text' in choices.mapping
    && (choices.mode === 'merge' || choices.mode === 'append');
}

/** How many parties the Submitted by column names, in any case or spacing */
function partyCount(table: ImportTable | null, mapping: Mapping | null) {
  const column = mapping?.askedBy;
  if (!table || column == null) return 0;
  const names = table.rows.map((row) => String(row[column] ?? '').trim().toLowerCase());
  return new Set(names.filter(Boolean)).size;
}

/** The file as read and every choice made for it, starting from what was kept on this PC unless it starts fresh */
function useQaImportState(dealId: string, fresh: boolean) {
  const key = importKey.qa(dealId);
  const [kept] = useState(() => {
    const found = fresh ? null : keptImport(key);
    return isQaKept(found) ? found : null;
  });
  const choices = kept?.choices;
  const [table, setTable] = useState<ImportTable | null>(kept?.table ?? null);
  const [mapping, setMapping] = useState<Mapping | null>(choices?.mapping ?? null);
  // where the file is, which the desktop app knows: the deal's log is that file
  const [path, setPath] = useState<string | null>(choices?.path ?? null);
  const [mode, setMode] = useState<ImportMode>(choices?.mode ?? 'merge');
  const [answered, setAnswered] = useState(!!choices?.answered);
  // the file becomes the deal's log only if this stays checked. It starts checked only for a
  // consolidated log, one with two or more parties under Submitted by; one party's own list is not the deal's log
  // Once the person checks or unchecks it (touched), the app leaves it as they set it.
  const [makeLog, setMakeLog] = useState(!!choices?.makeLog);
  const touched = useRef(!!choices?.touched);
  const parties = partyCount(table, mapping);
  useEffect(() => {
    if (!touched.current) setMakeLog(parties >= 2);
  }, [parties, table]);
  const [busy, setBusy] = useState<Busy>('');
  // the sheet a reread is reading: shown in its picker until the read settles (#63)
  const [wantedSheet, setWantedSheet] = useState<string>();
  const [error, setError] = useState('');
  const [restart, setRestart] = useState(false);   // "start over" asks first, in the footer
  const fileRef = useRef<HTMLInputElement>(null);
  // each read, proposal and import takes the next number; one that finds a later number when it ends was overtaken
  // (another file, another choice, the dialog closed) and changes nothing
  const token = useRef(0);
  return {
    key, table, setTable, mapping, setMapping, path, setPath, mode, setMode, answered, setAnswered,
    makeLog, setMakeLog, touched, busy, setBusy, wantedSheet, setWantedSheet,
    error, setError, restart, setRestart, fileRef, token,
  };
}
export type QaImportState = ReturnType<typeof useQaImportState>;

/** What the import will do with the file as mapped: its rows, and what they add to and change in the deal */
function useImportPlan(store: Store, dealId: string, qa: QaImportState) {
  const state = useAppState();
  const { table, mapping, mode, answered } = qa;
  const prepared = useMemo(
    () => (table && mapping ? prepareImport(table.rows, mapping, table.lines) : null),
    [table, mapping],
  );
  const counts = prepared ? importCounts(prepared.rows, dealQuestions(state, dealId), mode) : { add: 0, match: 0 };
  const total = counts.add + counts.match;
  // the import's own plan, run without committing: exactly what would be added and what would be overwritten
  const dry = useMemo(
    () => (prepared?.rows.length ? previewImport(store, dealId, mode, prepared.rows, answered) : null),
    [prepared, mode, answered, state.questions, state.tombstones],
  );
  const preview = dry?.ok ? dry.value : null;
  const dryError = dry && !dry.ok ? dry.error.message : '';
  const submission = savedSubmission(qa.key);
  // Recovery validates the original operation, rather than replanning already committed rows.
  return {
    prepared, counts, total: submission ? Math.max(total, submission.rows.length) : total,
    preview, dryError: submission ? '' : dryError,
  };
}
export type ImportPlan = ReturnType<typeof useImportPlan>;

/**
 * Keeps the import on this PC as it changes, so closing it, a reload or a restart loses nothing: opening it again picks
 * it up where it was left. "change" keeps it too until another file is read in its place; only "start
 * over", which asks first, or the import itself lets it go. While Import runs (holding) nothing is written.
 */
function useKeepAsItChanges(qa: QaImportState) {
  const { key, table, mapping, path, mode, answered, makeLog, touched } = qa;
  const holding = useRef(false);
  const keep = () => {
    if (!table || !mapping || holding.current) return;
    keepImport(key, { table, choices: { mapping, path, mode, answered, makeLog, touched: touched.current } });
  };
  // written as soon as what is kept changes, before the next frame
  useLayoutEffect(keep, [table, mapping, path, mode, answered, makeLog]);
  return { holding };
}
type Keeping = ReturnType<typeof useKeepAsItChanges>;

/** What the person can do in the dialog: read a file, ask the model, read the file again, import, start over, close */
function useQaImportActions(store: Store, dealId: string, qa: QaImportState, plan: ImportPlan) {
  const { busy, token, setBusy, setError, setTable, setMapping } = qa;
  const keeping = useKeepAsItChanges(qa);

  const close = () => {
    if (busy === 'importing') return;
    token.current++;
    store.ui({ dialog: null });
  };

  const startOver = () => {
    token.current++;
    const submitted = savedSubmission(qa.key);
    if (submitted) void store.releaseImport(submitted.key);
    dropImport(qa.key);
    qa.setRestart(false);
    setBusy('');
    setError('');
    setTable(null);
    setMapping(null);
    qa.setPath(null);
    qa.setMode('merge');
    qa.setAnswered(false);
    qa.setMakeLog(false);
    qa.touched.current = false;
  };

  /** "change": back to the file pick. What was kept stays until another file is read in its place */
  const changeFile = () => {
    token.current++;
    setBusy('');
    setTable(null);
    setMapping(null);
    setError('');
    qa.setRestart(false);
  };

  const run = () => runImport(store, dealId, qa, plan, keeping);
  return { close, startOver, changeFile, run, ...fileReading(store, dealId, qa) };
}
export type QaImportActions = ReturnType<typeof useQaImportActions>;

/** Reading the file: the file the person picks, the model's proposal of its layout, and another sheet or heading row */
function fileReading(store: Store, dealId: string, qa: QaImportState) {
  const { table, busy, token, setBusy, setError, setTable, setMapping } = qa;

  const load = async (file: File) => {
    if (busy) return;
    // another deal's Q&A log is refused before it is read (#38)
    const taken = logTakenBy(store, dealId, store.services.fs.pathFor?.(file) ?? null);
    if (taken) {
      setError(taken);
      return;
    }
    const mine = ++token.current;
    setBusy('reading');
    setError('');
    const read = await readImportFile(store, file);
    if (token.current !== mine) return;   // the dialog moved on while the file was read
    setBusy('');
    if (!read.ok) {
      setError(`Could not read ${file.name}: ${read.error.message}`);
      return;
    }
    const submitted = savedSubmission(qa.key);
    if (submitted) void store.releaseImport(submitted.key);
    keepImport(qa.key, { submission: null }); // Choosing a new file deliberately replaces the previous import.
    setTable(read.value);
    setMapping(read.value.mapping);
    qa.setPath(store.services.fs.pathFor?.(file) ?? null);
    qa.touched.current = false;
    // the app's own rules found no question column: ask the model for a proposal
    if (read.value.mapping.text == null) void askAi(read.value, mine);
  };

  // The model proposes the sheet, the heading row and the columns; the app checks the proposal against the file and
  // shows it in the same controls. If there is no usable proposal the dialog stays as it was, for the person to set by
  // hand. A read that asks goes on with its own number; the person's own ask takes the next one.
  const canAsk = !!store.services.ai.layout;
  const askAi = async (asked: ImportTable, mine = ++token.current) => {
    if (!canAsk) return;
    setBusy('asking');
    const proposal = await proposeLayout(store, asked);
    if (token.current !== mine) return;
    setBusy('');
    if (proposal.ok) {
      setError('');
      setTable(proposal.value);
      setMapping(proposal.value.mapping);
    } else if (asked.mapping.text != null) {
      setError(`${SERVICE} had no better proposal`);
    }
  };

  // the person says where the table really starts: another sheet, or another heading row
  // A later choice replaces a pending read. Import waits for it and uses the accepted table (#63, #380).
  const reread = async (where: Rereading, accept?: (read: ImportTable) => void) => {
    if (!table || (busy && busy !== 'reading')) return;
    const mine = ++token.current;   // a later choice wins over a slower earlier read
    setBusy('reading');
    qa.setWantedSheet(where.sheet);
    const again = await readImportBytes(store, table.name, table.bytes, where);
    if (token.current !== mine) return;
    setBusy('');
    if (!again.ok) {
      setError(`Could not read ${table.name}: ${again.error.message}`);
      return;
    }
    setError('');
    setTable(again.value);
    setMapping(again.value.mapping);
    accept?.(again.value);
  };

  return { load, canAsk, askAi, reread };
}

/** Keep a correlated submission before writing rows, until its log choice has finished too. */
async function runImport(store: Store, dealId: string, qa: QaImportState, plan: ImportPlan, keeping: Keeping) {
  const { prepared, total, dryError } = plan;
  if (qa.busy || keeping.holding.current) return;
  if (!savedSubmission(qa.key) && (!prepared || !total || dryError)) return;
  keeping.holding.current = true;
  qa.setBusy('importing');
  qa.setError('');
  qa.setRestart(false);
  try {
    // a kept import not sent yet, of a file another deal has made its log since, imports nothing (#38)
    const taken = savedSubmission(qa.key) ? null : logTakenBy(store, dealId, qa.path);
    if (taken) {
      qa.setError(taken);
      return;
    }
    const chosen = await chooseSubmission(store, qa, prepared?.rows ?? []);
    if (!chosen.ok) { qa.setError(chosen.error.message); return; }
    const submission = chosen.value;
    if (!(await saveImport(qa.key, { submission }))) {
      qa.setError('Couldn’t keep this import on this PC. Nothing was imported.');
      return;
    }
    const imported = await resumeSubmission(store, dealId, submission);
    if (!imported.ok) { qa.setError(`Couldn’t import: ${imported.error.message}`); return; }
    const log = await makeTheLog(store, dealId, submission);
    if (!log.ok) { qa.setError(`Imported, but the Q&A log could not be kept: ${log.error.message}`); return; }
    if (!(await saveImport(qa.key, { submission: { ...submission, done: true } }))) {
      qa.setError('Imported, but completion could not be kept on this PC. Retry to finish.');
      return;
    }
    if (!(await store.releaseImport(submission.key))) {
      qa.setError('Imported, but completion could not be recorded. Retry to finish.');
      return;
    }
    dropImport(qa.key);
    store.ui({ dialog: null });
  } finally {
    qa.setBusy('');
    keeping.holding.current = false;
  }
}

/** Only a complete submission made by this build can own the retained rows. */
function savedSubmission(key: string): Submission | null {
  const value = keptImport(key)?.submission as Submission | undefined;
  if (!value) return null;
  const { bytes: _bytes, ...metadata } = (value.table ?? {}) as ImportTable;
  const table = { ...metadata, bytes: (keptImport(key)?.table as ImportTable | undefined)?.bytes };
  const valid = isQaKept({ table, choices: value.choices }) && typeof value.key === 'string'
    && value.key.startsWith('qa-import:') && Array.isArray(value.rows)
    && (value.done === undefined || typeof value.done === 'boolean');
  return valid ? { ...value, table: metadata } : null;
}

function makeSubmission(store: Store, qa: QaImportState, rows: ImportRow[]): Submission {
  const { bytes: _bytes, ...table } = qa.table!;
  return {
    key: 'qa-import:' + store.services.ids.next('op'), table, rows,
    choices: {
      mapping: qa.mapping!, path: qa.path, mode: qa.mode, answered: qa.answered,
      makeLog: qa.makeLog, touched: qa.touched.current,
    },
  };
}

/** A refused pre-journal attempt can be changed; a started import keeps its original, visible choices. */
async function chooseSubmission(store: Store, qa: QaImportState, rows: ImportRow[]) {
  const saved = savedSubmission(qa.key);
  const current = makeSubmission(store, qa, rows);
  if (!saved) return ok(current);
  const snapshot = (value: Submission) => [value.choices, value.table.sheet, value.table.headerRow];
  const same = JSON.stringify(snapshot(saved)) === JSON.stringify(snapshot(current));
  if (same) return ok(saved);
  const found = await findSubmission(store, saved.key);
  if (!found.ok) return found;
  if (!found.value && !saved.done) return ok(current);
  qa.setTable({ ...saved.table, bytes: qa.table!.bytes });
  qa.setMapping(saved.choices.mapping);
  qa.setPath(saved.choices.path);
  qa.setMode(saved.choices.mode);
  qa.setAnswered(saved.choices.answered);
  qa.setMakeLog(saved.choices.makeLog);
  qa.touched.current = saved.choices.touched;
  return fail({ kind: 'rejected', message: 'This import already started. Its original choices have been restored.' });
}

async function findSubmission(store: Store, key: string) {
  const read = await store.services.repo.list('op');
  if (!read.ok) return read;
  const matching = read.value.flatMap((loaded) => {
    const parsed = Operation.safeParse(loaded.envelope.data);
    return parsed.success && parsed.data.idempotencyKey === key ? [parsed.data] : [];
  }).filter((operation) => operation.state !== 'discarded');
  return ok(matching.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0]);
}

/** A committed Append is never sent again after its reply was lost. */
async function resumeSubmission(store: Store, dealId: string, submission: Submission) {
  if (submission.done) return ok(undefined);
  const found = await findSubmission(store, submission.key);
  if (!found.ok) return found;
  const operation = found.value;
  if (operation?.state === 'succeeded') return ok(undefined);
  if (operation) {
    const result = await store.retryOp(operation.id);
    return result ?? fail({ kind: 'rejected', message: 'This import is still running. Retry after it finishes.' });
  }
  const { choices, rows } = submission;
  return store.dispatch(ImportQuestions, {
    dealId, mode: choices.mode, rows, answerResponded: choices.answered,
  }, { idempotencyKey: submission.key });
}

/** Finish the original file choice after row recovery, rather than importing the rows again. */
async function makeTheLog(store: Store, dealId: string, submission: Submission) {
  if (submission.done) return ok(undefined);
  await store.loadDeal(dealId, { gaps: false });
  const { table, choices } = submission;
  const { sheet, headerRow, rows } = table;
  const log = { path: choices.path, sheet, headerRow, mapping: choices.mapping, make: choices.makeLog, rows };
  return keepImportedLog(store, dealId, log);
}
