import type { Operation } from '../domain/model';
import { fail, ok, type Result } from '../domain/result';
import {
  parseDate, prepareImport, type ImportRow, type Mapping, type Prepared,
} from '../domain/importExport';
import { ImportQuestions } from './commands/importQuestions';
import { KeepQaLog, RecordQaLogExport } from './commands/qaLogs';
import type { AcceptedMatch } from '../domain/qaMatch';
import {
  dropImport, dropSavedImport, finishKeptSubmission, importKey, keepImport, keptImport, keptImportsReady,
} from './keptImports';
import { unappliedColumnsWarning, unappliedImportColumns } from './qaImportColumns';
import { dialogReportsFailure, findQaImportStep, resumeQaImportStep, stillRunningImport } from './qaImportJournal';
import { keepImportedLog, logTakenBy } from './qaLog';
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
  /** suggestions the person accepted for rows that matched no question (a kept import from before has none) */
  accepted?: AcceptedMatch[];
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
function qaImportPartyCount(table: ImportTable | null, mapping: Mapping | null) {
  const column = mapping?.askedBy;
  if (!table || column == null) return 0;
  const names = table.rows.map((row) => String(row[column] ?? '').trim().toLowerCase());
  return new Set(names.filter(Boolean)).size;
}

/**
 * Whether the file becomes the deal's Q&A log. It starts so only for a consolidated log, one with two or more parties
 * under Submitted by; one party's own list is not the deal's log. Once the person checks or unchecks it (touched),
 * it stays as they set it.
 */
export function qaImportMakesLog(
  table: ImportTable | null, mapping: Mapping | null, choice: { makeLog: boolean; touched: boolean },
) {
  return choice.touched ? choice.makeLog : qaImportPartyCount(table, mapping) >= 2;
}

/** Save the latest file and choices, except while the correlated submission owns them. */
export function keepQaImport(key: string, table: ImportTable, choices: QaChoices) {
  if (!submitting.has(key)) keepImport(key, { table, choices });
}

/** A newly accepted file replaces the previous attempt and any kept heading edit. */
export async function replaceQaImport(store: Store, key: string) {
  const released = await releaseQaAttempt(store, key);
  if (!released.ok) return released;
  keepImport(key, { submission: null, headingDraft: null });
  return ok(undefined);
}

export async function clearQaImport(store: Store, key: string) {
  const released = await releaseQaAttempt(store, key);
  if (!released.ok) return released;
  dropImport(key);
  return ok(undefined);
}

async function releaseQaAttempt(store: Store, key: string) {
  const submitted = savedSubmission(key);
  if (!submitted) return ok(undefined);
  const journalReady = await store.releaseImport(submitted.key, { abandon: true });
  if (!journalReady || !await dropSavedImport(key)) {
    return fail({ kind: 'failed', message: 'Couldn’t clear the previous import. Try again.' });
  }
  void store.releaseImport(submitted.key);
  return ok(undefined);
}

/** Another deal's Q&A log is refused before its file is read (#38). */
export async function loadQaImport(store: Store, dealId: string, file: File) {
  const path = store.services.fs.pathFor?.(file) ?? null;
  const taken = logTakenBy(store, dealId, path);
  if (taken) return fail({ kind: 'rejected', message: taken });
  const read = await readImportFile(store, file);
  if (!read.ok) return fail({ ...read.error, message: `Could not read ${file.name}: ${read.error.message}` });
  const askForLayout = read.value.mapping.text == null && store.get().can.layout;
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

export function summarizeQaImport(key: string, prepared: Prepared | null, dry: Result<ImportPreview> | null) {
  // what the import adds and changes comes only from its own plan (`dry`), never from a count of its own (#1080)
  const total = prepared?.rows.length ?? 0;
  const preview = dry?.ok ? dry.value : null;
  const dryError = dry && !dry.ok ? dry.error.message : '';
  const submission = savedSubmission(key);
  // Recovery validates the original operation, rather than replanning already committed rows.
  return {
    total: submission ? Math.max(total, submission.rows.length) : total,
    preview, dryError: submission ? '' : dryError,
  };
}

type SubmissionResult = Result<void> & { restore?: QaKept };

/** Keep a correlated submission before writing rows, until its log choice has finished too. */
export async function submitQaImport(
  store: Store, dealId: string, current: QaKept, rows: ImportRow[],
): Promise<SubmissionResult> {
  const key = importKey.qa(dealId);
  if (submitting.has(key)) return stillRunningImport();
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

export function isCorrelatedQaImport(op: Operation | undefined):
  op is Operation & { dealId: string; idempotencyKey: string } {
  return !!op?.dealId && !!op.idempotencyKey?.startsWith('qa-import:')
    && [ImportQuestions.name, KeepQaLog.name, RecordQaLogExport.name].includes(op.command);
}

/** The interrupted action reopens its complete import instead of retrying only the rows (#270). */
export async function retryInterruptedImport(store: Store, opId: string) {
  const operation = store.get().ops[opId];
  if (!isCorrelatedQaImport(operation)) return store.retryOp(opId);
  await keptImportsReady;
  const { dealId, idempotencyKey } = operation;
  const key = importKey.qa(dealId);
  if (savedSubmission(key)?.key !== idempotencyKey) return store.retryOp(opId);
  await store.loadDeal(dealId, { gaps: false });
  const state = store.get();
  if (state.dealLoad[dealId] !== 'loaded' || !state.deals[dealId]) {
    store.toast('The deal could not be loaded. Retry when it is available.', 'warn');
    return;
  }
  const saved = savedSubmission(key);
  const current = keptQaImport(key);
  if (state.ui.dialog || saved?.key !== idempotencyKey || !current) return;
  keepImport(key, { table: { ...saved.table, bytes: current.table.bytes }, choices: saved.choices });
  store.ui({ dialog: { kind: 'importQa', dealId } });
}

/** A refused pre-journal attempt can be changed; a started import keeps its original, visible choices. */
async function chooseSubmission(store: Store, saved: Submission | null, current: QaKept, rows: ImportRow[]) {
  const { bytes, ...table } = current.table;
  const key = 'qa-import:' + store.services.ids.next('op');
  const next: Submission = { key, table, rows, choices: current.choices };
  if (!saved) return ok(next);
  const snapshot = (value: Submission) => [value.choices, value.table.sheet, value.table.headerRow];
  if (JSON.stringify(snapshot(saved)) === JSON.stringify(snapshot(next))) return ok(saved);
  const found = await findQaImportStep(store, saved.key, ImportQuestions.name);
  if (!found.ok) return found;
  if (!found.value && !saved.done) return ok(next);
  return ok({ restore: { table: { ...saved.table, bytes }, choices: saved.choices } });
}

async function resumeSubmission(store: Store, dealId: string, submission: Submission) {
  if (submission.done) return ok(undefined);
  const write = () => importFreshRows(store, dealId, submission);
  return resumeQaImportStep(store, submission.key, ImportQuestions.name, write);
}

async function importFreshRows(store: Store, dealId: string, submission: Submission) {
  const { choices, rows } = submission;
  // Rows not yet in the journal are refused if another deal has made the file its log since they were kept (#926).
  const taken = logTakenBy(store, dealId, choices.path);
  if (taken) return fail({ kind: 'rejected', message: taken });
  return store.dispatch(ImportQuestions, {
    dealId, mode: choices.mode, rows, answerResponded: choices.answered, accepted: choices.accepted ?? [],
  }, { ...dialogReportsFailure, idempotencyKey: submission.key });
}

/** Finish the original file choice after row recovery, rather than importing the rows again. */
async function makeTheLog(store: Store, dealId: string, submission: Submission) {
  if (submission.done) return ok(undefined);
  await store.loadDeal(dealId, { gaps: false });
  const { table, choices } = submission;
  const { sheet, headerRow, columns, cols, columnCount, rows } = table;
  const log = {
    path: choices.path, sheet, headerRow, columns, cols, columnCount,
    mapping: choices.mapping, make: choices.makeLog, rows,
  };
  return keepImportedLog(store, dealId, log, submission.key);
}
