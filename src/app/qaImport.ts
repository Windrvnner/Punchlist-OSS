import { Operation } from '../domain/model';
import { fail, ok, type Result } from '../domain/result';
import {
  importCounts, parseDate, prepareImport, type ImportRow, type Mapping, type Prepared,
} from '../domain/importExport';
import { ImportQuestions } from './commands/importQuestions';
import { dropImport, finishKeptSubmission, importKey, keepImport, keptImport } from './keptImports';
import { unappliedColumnsWarning, unappliedImportColumns } from './qaImportColumns';
import { keepImportedLog, logTakenBy } from './qaLog';
import { dealQuestions, type State } from './state';
import type { Store } from './store';
import { readImportFile, type ImportPreview, type ImportTable } from './transfer';

export type ImportMode = 'merge' | 'append';

/** The Q&A import as it was left, with the file as read and every choice made for it. */
export interface QaChoices {
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

const submitting = new Set<string>();

/** Checks that what was kept is still a whole Q&A import, so a damaged or older entry starts a fresh one. */
export function keptQaImport(key: string): QaKept | null {
  const found = keptImport(key);
  return isQaKept(found) ? found : null;
}

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

/** How many parties the Submitted by column names, in any case or spacing. */
export function qaImportPartyCount(table: ImportTable | null, mapping: Mapping | null) {
  const column = mapping?.askedBy;
  if (!table || column == null) return 0;
  const names = table.rows.map((row) => String(row[column] ?? '').trim().toLowerCase());
  return new Set(names.filter(Boolean)).size;
}

/** Save the latest file and choices, except while the correlated submission owns them. */
export function keepQaImport(key: string, table: ImportTable, choices: QaChoices) {
  if (!submitting.has(key)) keepImport(key, { table, choices });
}

/** A newly accepted file replaces the previous attempt and any kept heading edit. */
export function replaceQaImport(store: Store, key: string) {
  releaseQaAttempt(store, key);
  keepImport(key, { submission: null, headingDraft: null });
}

export function clearQaImport(store: Store, key: string) {
  releaseQaAttempt(store, key);
  dropImport(key);
}

function releaseQaAttempt(store: Store, key: string) {
  const submitted = savedSubmission(key);
  if (submitted) void store.releaseImport(submitted.key);
}

/** Another deal's Q&A log is refused before its file is read (#38). */
export async function loadQaImport(store: Store, dealId: string, file: File) {
  const path = store.services.fs.pathFor?.(file) ?? null;
  const taken = logTakenBy(store, dealId, path);
  if (taken) return fail({ kind: 'rejected', message: taken });
  const read = await readImportFile(store, file);
  if (!read.ok) return fail({ ...read.error, message: `Could not read ${file.name}: ${read.error.message}` });
  // any field the app's own heading names did not find goes to the model's proposal, which the person then confirms
  const askForLayout = Object.values(read.value.mapping).some((column) => column == null) && store.get().can.layout;
  return ok({ table: read.value, path, askForLayout });
}

export interface QaPreviewRow {
  cells: string[];
  dates: Pick<ImportRow, 'received' | 'responded'>;
}

/** Use the import's contextual date readings wherever the preview shows a prepared row. */
export function prepareQaImport(table: ImportTable, mapping: Mapping) {
  const prepared = prepareImport(table.rows, mapping, table.lines);
  return { prepared, previewRows: previewQaRows(table, mapping, prepared) };
}

/** Preserve the preview's original file sample, including control-only text that preparation skips (#925). */
function previewQaRows(table: ImportTable, mapping: Mapping, prepared: Prepared): QaPreviewRow[] {
  const questionColumn = mapping.text;
  if (questionColumn == null) return [];
  const previewRows: QaPreviewRow[] = [];
  for (const [at, cells] of table.rows.entries()) {
    if (!String(cells[questionColumn] ?? '').trim()) continue;
    const line = table.lines?.[at] ?? at + 2;
    const row = prepared.rows.find((candidate) => candidate.line === line);
    const date = (field: 'received' | 'responded') => row?.[field] ?? parseDate(cells[mapping[field] ?? -1]) ?? '';
    previewRows.push({ cells, dates: { received: date('received'), responded: date('responded') } });
    if (previewRows.length === 5) break;
  }
  return previewRows;
}

export function summarizeQaImport(
  state: State, dealId: string, key: string, mode: ImportMode, prepared: Prepared | null,
  dry: Result<ImportPreview> | null,
) {
  const counts = prepared ? importCounts(prepared.rows, dealQuestions(state, dealId), mode) : { add: 0, match: 0 };
  const total = counts.add + counts.match;
  const preview = dry?.ok ? dry.value : null;
  const dryError = dry && !dry.ok ? dry.error.message : '';
  const submission = savedSubmission(key);
  // Recovery validates the original operation, rather than replanning already committed rows.
  return {
    counts, total: submission ? Math.max(total, submission.rows.length) : total,
    preview, dryError: submission ? '' : dryError,
  };
}

type SubmissionResult = Result<void> & { restore?: QaKept };

/** Keep a correlated submission before writing rows, until its log choice has finished too. */
export async function submitQaImport(
  store: Store, dealId: string, current: QaKept, rows: ImportRow[],
): Promise<SubmissionResult> {
  const key = importKey.qa(dealId);
  if (submitting.has(key)) return stillRunning();
  submitting.add(key);
  try {
    const saved = savedSubmission(key);
    // A kept import not sent yet imports nothing if another deal has made the file its log since (#38).
    const taken = saved ? null : logTakenBy(store, dealId, current.choices.path);
    if (taken) return fail({ kind: 'rejected', message: taken });
    const unresolved = saved ? '' : unappliedColumnsMessage(current.table);
    if (unresolved) return fail({ kind: 'rejected', message: unresolved });
    const chosen = await chooseSubmission(store, saved, current, rows);
    if (!chosen.ok) return chosen;
    if ('restore' in chosen.value) {
      const message = 'This import already started. Its original choices have been restored.';
      return { ok: false, error: { kind: 'rejected', message }, restore: chosen.value.restore };
    }
    const retained = chosen.value === saved ? {} : { ...current };
    return await finishKeptSubmission(key, chosen.value, {
      importRows: (submission) => resumeSubmission(store, dealId, submission),
      keepLog: (submission) => makeTheLog(store, dealId, submission),
      release: (correlation) => store.releaseImport(correlation),
    }, retained);
  } finally {
    submitting.delete(key);
  }
}

/** A manual column choice that no longer matches the file is settled by a person before any row is sent (#741). */
function unappliedColumnsMessage(table: ImportTable) {
  return unappliedColumnsWarning(unappliedImportColumns(table));
}

/** Only a complete submission made by this build can own the retained rows. */
function savedSubmission(key: string): Submission | null {
  const kept = keptImport(key);
  const value = kept?.submission as Submission | undefined;
  if (!value) return null;
  const { bytes: _bytes, ...metadata } = (value.table ?? {}) as ImportTable;
  const table = { ...metadata, bytes: (kept?.table as ImportTable | undefined)?.bytes };
  const valid = isQaKept({ table, choices: value.choices }) && typeof value.key === 'string'
    && value.key.startsWith('qa-import:') && Array.isArray(value.rows)
    && (value.done === undefined || typeof value.done === 'boolean');
  return valid ? { ...value, table: metadata } : null;
}

/** A refused pre-journal attempt can be changed; a started import keeps its original, visible choices. */
async function chooseSubmission(store: Store, saved: Submission | null, current: QaKept, rows: ImportRow[]) {
  const { bytes, ...table } = current.table;
  const key = 'qa-import:' + store.services.ids.next('op');
  const next: Submission = { key, table, rows, choices: current.choices };
  if (!saved) return ok(next);
  const snapshot = (value: Submission) => [value.choices, value.table.sheet, value.table.headerRow];
  if (JSON.stringify(snapshot(saved)) === JSON.stringify(snapshot(next))) return ok(saved);
  const found = await findSubmission(store, saved.key);
  if (!found.ok) return found;
  if (!found.value && !saved.done) return ok(next);
  return ok({ restore: { table: { ...saved.table, bytes }, choices: saved.choices } });
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
    return result ?? stillRunning();
  }
  const { choices, rows } = submission;
  // Rows not yet in the journal are refused if another deal has made the file its log since they were kept (#926).
  const taken = logTakenBy(store, dealId, choices.path);
  if (taken) return fail({ kind: 'rejected', message: taken });
  return store.dispatch(ImportQuestions, {
    dealId, mode: choices.mode, rows, answerResponded: choices.answered,
  }, { idempotencyKey: submission.key });
}

function stillRunning() {
  return fail({ kind: 'rejected', message: 'This import is still running. Retry after it finishes.' });
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
