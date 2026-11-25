/**
 * Import Q&A log: the person picks a spreadsheet, checks where its table is and which column holds what, sees what the
 * import will add and overwrite, and imports. The import in progress is kept on this PC as it changes.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import { Modal, DialogHead } from './dialogs';
import { FileInput, PickFileRow } from './fileDrop';
import { readImportBytes, proposeLayout, previewImport, type ImportTable } from '../app/transfer';
import type { Mapping } from '../domain/importExport';
import {
  clearQaImport, keepQaImport, keptQaImport, loadQaImport, prepareQaImport, qaImportPartyCount,
  replaceQaImport, submitQaImport, summarizeQaImport, type ImportMode, type QaChoices,
} from '../app/qaImport';
import { SERVICE } from '../control';
import { importKey } from '../app/keptImports';
import { useKeptImportsReady, useFreshOnCrash } from './keptImports';
import { QaImportForm } from './qaImportForm';
import type { Store } from '../app/store';

/** What the dialog is doing while the person waits */
export type Busy = '' | 'reading' | 'importing' | 'asking';
/** a sheet or heading row chosen in the import and being read */
type Rereading = { sheet?: string; headerRow?: number };
/** The files the Q&A import reads */
const SPREADSHEETS = '.xlsx,.xlsm,.xls,.xlsb,.ods,.csv';

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

/** The file as read and every choice made for it, starting from what was kept on this PC unless it starts fresh */
function useQaImportState(dealId: string, fresh: boolean) {
  const key = importKey.qa(dealId);
  const [kept] = useState(() => (fresh ? null : keptQaImport(key)));
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
  const parties = qaImportPartyCount(table, mapping);
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
  const file = useMemo(() => (table && mapping ? prepareQaImport(table, mapping) : null), [table, mapping]);
  const prepared = file?.prepared ?? null;
  // The same plan the command would run, without committing it.
  const dry = useMemo(
    () => (prepared?.rows.length ? previewImport(store, dealId, mode, prepared.rows, answered) : null),
    [prepared, mode, answered, state.questions, state.tombstones],
  );
  return {
    ...summarizeQaImport(state, dealId, qa.key, mode, prepared, dry),
    prepared,
    previewRows: file?.previewRows ?? [],
  };
}
export type ImportPlan = ReturnType<typeof useImportPlan>;

/**
 * Keeps the import on this PC as it changes, so closing it, a reload or a restart loses nothing: opening it again picks
 * it up where it was left. "change" keeps it too until another file is read in its place; only "start
 * over", which asks first, or the import itself lets it go.
 */
function useKeepAsItChanges(qa: QaImportState) {
  const { key, table, mapping, path, mode, answered, makeLog, touched } = qa;
  // Hand choices to the app before the next frame.
  useLayoutEffect(() => {
    if (table && mapping) {
      keepQaImport(key, table, { mapping, path, mode, answered, makeLog, touched: touched.current });
    }
  }, [table, mapping, path, mode, answered, makeLog]);
}

/** What the person can do in the dialog: read a file, ask the model, read the file again, import, start over, close */
function useQaImportActions(store: Store, dealId: string, qa: QaImportState, plan: ImportPlan) {
  const { busy, token, setBusy, setError, setTable, setMapping } = qa;
  useKeepAsItChanges(qa);

  const close = () => {
    if (busy === 'importing') return;
    token.current++;
    store.ui({ dialog: null });
  };

  const startOver = () => {
    token.current++;
    clearQaImport(store, qa.key);
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

  const run = () => runImport(store, dealId, qa, plan);
  return { close, startOver, changeFile, run, ...fileReading(store, dealId, qa) };
}
export type QaImportActions = ReturnType<typeof useQaImportActions>;

/** Reading the file: the file the person picks, the model's proposal of its layout, and another sheet or heading row */
function fileReading(store: Store, dealId: string, qa: QaImportState) {
  const { table, busy, token, setBusy, setError, setTable, setMapping } = qa;

  const load = async (file: File) => {
    if (busy) return;
    const mine = ++token.current;
    setBusy('reading');
    setError('');
    const read = await loadQaImport(store, dealId, file);
    if (token.current !== mine) return;   // the dialog moved on while the file was read
    setBusy('');
    if (!read.ok) {
      setError(read.error.message);
      return;
    }
    replaceQaImport(store, qa.key);
    const { table, path, askForLayout } = read.value;
    setTable(table);
    setMapping(table.mapping);
    qa.setPath(path);
    qa.touched.current = false;
    if (askForLayout) void askAi(table, mine);
  };

  // The model proposes the sheet, the heading row and the columns; the app checks the proposal against the file and
  // shows it in the same controls. If there is no usable proposal the dialog stays as it was, for the person to set by
  // hand. A read that asks goes on with its own number; the person's own ask takes the next one.
  const canAsk = store.get().can.layout;
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
    if (!table || busy === 'importing') return;
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

  return { load, canAsk, askAi, reread, cancelProposal: () => cancelProposal(qa) };
}

/** A manual heading edit takes over from an outstanding layout proposal (#380). */
function cancelProposal(qa: QaImportState) {
  if (qa.busy !== 'asking') return;
  qa.token.current++;
  qa.setBusy('');
}

/** Display the app's submission outcome and restore the original controls when requested. */
async function runImport(store: Store, dealId: string, qa: QaImportState, plan: ImportPlan) {
  const { table, mapping, path, mode, answered, makeLog, touched } = qa;
  if (qa.busy || !table || !mapping || !plan.total || plan.dryError) return;
  qa.setBusy('importing');
  qa.setError('');
  qa.setRestart(false);
  const choices = { mapping, path, mode, answered, makeLog, touched: touched.current };
  try {
    const result = await submitQaImport(store, dealId, { table, choices }, plan.prepared?.rows ?? []);
    if (result.ok) store.ui({ dialog: null });
    else {
      if (result.restore) restoreChoices(qa, result.restore.table, result.restore.choices);
      qa.setError(result.error.message);
    }
  } finally {
    qa.setBusy('');
  }
}

function restoreChoices(qa: QaImportState, table: ImportTable, choices: QaChoices) {
  qa.setTable(table);
  qa.setMapping(choices.mapping);
  qa.setPath(choices.path);
  qa.setMode(choices.mode);
  qa.setAnswered(choices.answered);
  qa.setMakeLog(choices.makeLog);
  qa.touched.current = choices.touched;
}
