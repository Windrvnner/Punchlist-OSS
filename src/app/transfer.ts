/**
 * Import and export orchestration. Choosing rows and building tables is pure
 * (domain/importExport); reading and writing workbooks goes through the
 * SpreadsheetCodec port and handing the file over through the FileSystem port.
 * Exports change nothing. Imports change records only through ImportQuestions.
 */
import type { Store } from './store';
import type { SheetPreview } from '../ports';
import { IMPORT_FIELDS } from '../domain/importExport';
import {
  type State, dealQuestions, dealFindings, findingWorkstreams, FIRM,
  workstreamHead, qaStatusOnly, qaWorkstream, qaWorkstreamChoices,
} from './state';
import type { Question, Finding } from '../domain/model';
import { questionsSheet, findingsSheet, safeFileName, fitCells, suggestMapping, sameWords, type Mapping, type ImportRow } from '../domain/importExport';
import { ImportQuestions, importMatches } from './commands/importQuestions';
import { suggestMatches, type AcceptedMatch, type Suggestion } from '../domain/qaMatch';
import { ok, fail, type Result } from '../domain/result';

const MIME = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv' } as const;
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

export interface QaExportFilter { status: 'open' | 'answered' | 'closed' | 'all'; workstream: string; askedBy: string[] }

function qaRowShown(row: Question, filter: QaExportFilter): boolean {
  return (filter.status === 'all' || row.status === filter.status)
    && (!filter.workstream || qaWorkstream(row) === filter.workstream);
}

export const questionRowsFor = (state: State, dealId: string, filter: QaExportFilter): Question[] =>
  dealQuestions(state, dealId).filter((row) => qaRowShown(row, filter) && filter.askedBy.includes(row.askedBy));

/** The export opens on the page's status and workstream with every submitting firm selected. */
export function qaFilterFromPage(state: State, dealId: string): QaExportFilter {
  const { status, workstream } = state.ui.qaFilter;
  const askedBy = [...new Set(dealQuestions(state, dealId).map((row) => row.askedBy))];
  return { status: qaStatusOnly(status), workstream, askedBy };
}

/** Firm counts describe the available rows, and the footer counts the selected firms only. */
export function qaExportView(state: State, dealId: string, filter: QaExportFilter) {
  const rows = dealQuestions(state, dealId);
  const firmCounts = new Map<string, number>();
  let firmsTotal = 0;
  let total = 0;
  for (const row of rows) {
    const shown = Number(qaRowShown(row, filter));
    firmCounts.set(row.askedBy, (firmCounts.get(row.askedBy) ?? 0) + shown);
    firmsTotal += shown;
    if (filter.askedBy.includes(row.askedBy)) total += shown;
  }
  const firms = [...firmCounts.keys()].sort();
  return { firms, firmCounts, firmsTotal, total, workstreams: qaWorkstreamChoices(rows) };
}

/** The workstream is compared as the Findings list heads it (trimmed, "No workstream" for none), so an export opened from a filtered list holds what the list shows. */
export interface FindingExportFilter { status: 'open' | 'closed' | 'all'; workstream: string; reviewedOnly: boolean }
export const findingRowsFor = (s: State, dealId: string, f: FindingExportFilter): Finding[] =>
  dealFindings(s, dealId).filter((x) => (f.status === 'all' || x.status === f.status) && (!f.workstream || workstreamHead(x) === f.workstream) && (!f.reviewedOnly || !!x.reviewed));

/** Reassess opens on Open, since the export does not have a Reassess filter. */
export function findingFilterFromPage(state: State): FindingExportFilter {
  const page = state.ui.findingFilter;
  const status = page.status === 'reassess' ? 'open' : page.status;
  return { status, workstream: page.workstream, reviewedOnly: page.reviewed === 'yes' };
}

export function findingExportView(state: State, dealId: string, filter: FindingExportFilter) {
  const workstreams = findingWorkstreams(dealFindings(state, dealId));
  return { workstreams, total: findingRowsFor(state, dealId, filter).length };
}

async function saveSheet(
  store: Store,
  fileName: string,
  sheetName: string,
  table: (string | number)[][],
): Promise<Result<'saved' | 'canceled'>> {
  const fit = fitCells(table);
  const file = await store.services.sheets.write(sheetName, fit.table);
  if (!file.ok) return file;
  const r = await store.services.fs.save(`${safeFileName(fileName)}.${file.value.ext}`, file.value.bytes, MIME[file.value.ext]);
  if (r.ok && r.value === 'saved' && fit.cut) store.toast(`${fit.cut} cell${fit.cut === 1 ? ' was' : 's were'} longer than Excel allows and ${fit.cut === 1 ? 'was' : 'were'} cut at 32,767 characters in the file. Nothing in the app changed.`, undefined, true);
  return r;
}

/** Returns how many rows were written, or 'canceled' if the person dismissed the save dialog. */
export async function exportQuestions(
  store: Store,
  dealId: string,
  f: QaExportFilter,
): Promise<Result<number | 'canceled'>> {
  const s = store.get(); const d = s.deals[dealId]; if (!d) return fail({ kind: 'notFound', message: 'Deal not found' });
  const rows = questionRowsFor(s, dealId, f); if (!rows.length) return fail({ kind: 'rejected', message: 'Nothing to export' });
  const r = await saveSheet(store, `${d.name} Q&A log${f.askedBy.length === 1 && f.askedBy[0] ? ' - ' + f.askedBy[0] : ''}`, 'Q&A log', questionsSheet(rows));
  return r.ok ? ok(r.value === 'canceled' ? 'canceled' : rows.length) : r;
}
export async function exportFindings(
  store: Store,
  dealId: string,
  f: FindingExportFilter,
): Promise<Result<number | 'canceled'>> {
  const s = store.get(); const d = s.deals[dealId]; if (!d) return fail({ kind: 'notFound', message: 'Deal not found' });
  const rows = findingRowsFor(s, dealId, f); if (!rows.length) return fail({ kind: 'rejected', message: 'Nothing to export' });
  const r = await saveSheet(store, `${d.name} findings`, 'Findings', findingsSheet(rows));
  return r.ok ? ok(r.value === 'canceled' ? 'canceled' : rows.length) : r;
}

export interface ImportTable {
  name: string;
  columns: string[];
  /** Source positions, before the reader leaves out unused columns. Older kept imports may omit them. */
  cols?: number[];
  rows: string[][];
  lines?: number[];
  mapping: Mapping;
  /** Kept so the file can be read again when the person picks another sheet or heading row. */
  bytes: Uint8Array;
  sheets: string[];
  sheet: string;
  headerRow: number;
  lastRow: number;
  previews: SheetPreview[];
  /** The layout shown came from the model. */
  proposedByAi?: boolean;
}

export type ImportLocation = { sheet?: string; headerRow?: number };

/** Read (or re-read) a file's bytes with the person's choice of sheet and heading row. */
export async function readImportBytes(
  store: Store, name: string, bytes: Uint8Array, opts?: ImportLocation,
): Promise<Result<ImportTable>> {
  const t = await store.services.sheets.read(bytes, name, opts);
  if (!t.ok) return t;
  if (!t.value.columns.length) return fail({ kind: 'invalid', message: 'The file has no rows' });
  const { columns, cols, rows, lines, sheets = [], sheet = '', headerRow = 1, previews = [] } = t.value;
  const lastRow = t.value.lastRow ?? rows.length + 1;
  return ok({
    name, columns, cols, rows, lines, mapping: suggestMapping(columns), bytes, sheets, sheet, headerRow, lastRow,
    previews,
  });
}

/** Read a chosen file into a table of strings with a suggested column mapping. Nothing is changed. */
export async function readImportFile(store: Store, file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<Result<ImportTable>> {
  if (!/\.(xlsx|xlsm|xls|xlsb|ods|csv)$/i.test(file.name)) return fail({ kind: 'invalid', message: 'Choose a spreadsheet: .xlsx, .xls, .ods or .csv' });
  if (file.size > MAX_IMPORT_BYTES) return fail({ kind: 'invalid', message: 'That file is larger than 20 MB' });
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return fail({ kind: 'failed', message: 'The file could not be opened' }); }
  const t = await readImportBytes(store, file.name, bytes);
  if (t.ok && !t.value.rows.length) return fail({ kind: 'invalid', message: 'The file has no rows' });
  return t;
}

// ---- import: what a merge would change, worked out before anything is written ----

export interface ImportChange {
  n: number;
  field: string;
  from: string;
  to: string;
  /** A change between values that match after whitespace is collapsed and trimmed. */
  spacing?: true;
}
export interface ImportPreview {
  created: number;
  updated: number;
  /** deleted questions a row matches, brought back */
  restored: number;
  changes: ImportChange[];
  /** rows that matched nothing, and the question each could be: shown, never applied unless accepted */
  suggestions: Suggestion[];
}
const PREVIEW_FIELDS: [keyof Question, string][] = [['text', 'Question'], ['askedBy', 'Submitted by'], ['received', 'Received'], ['workstream', 'Workstream'], ['priority', 'Priority'], ['status', 'Status'], ['response', 'Response'], ['respondedBy', 'Responded by'], ['responded', 'Date']];

/**
 * Runs the import's own plan without committing it, and reports what it would do: how many questions it adds,
 * and for each existing question it touches, which fields change from what to what. Because this is the same
 * plan the import runs, the preview cannot disagree with the result.
 */
export function previewImport(
  store: Store, dealId: string, mode: 'merge' | 'append', rows: ImportRow[], answerResponded = false,
  accepted: AcceptedMatch[] = [],
): Result<ImportPreview> {
  const s = store.get();
  if (!rows.length) return ok({ created: 0, updated: 0, restored: 0, changes: [], suggestions: [] });
  const input = { dealId, mode, rows, answerResponded, accepted };
  const context = {
    at: store.services.clock.now(), actor: s.user?.name ?? 'Unknown', firm: FIRM, opId: 'preview',
    ids: store.services.ids,
  };
  const planned = ImportQuestions.plan(s, input, context);
  if (!planned.ok) return planned;
  let created = 0, updated = 0, restored = 0; const changes: ImportChange[] = [];
  for (const u of planned.value.upserts) {
    if (u.kind !== 'question') continue;
    const next = u.record as Question; const was = s.questions[next.id];
    if (s.tombstones[next.id]) { restored++; continue; }
    if (u.expectedRev === null || !was) { created++; continue; }
    updated++;
    for (const [k, label] of PREVIEW_FIELDS) {
      const from = String(was[k] ?? ''), to = String(next[k] ?? '');
      if (from !== to) changes.push({ n: next.n, field: label, from, to, ...(sameWords(from, to) ? { spacing: true as const } : {}) });
    }
  }
  changes.sort((a, b) => a.n - b.n);
  const suggestions = mode === 'merge' ? suggestionsFor(s, dealId, rows, accepted) : [];
  return ok({ created, updated, restored, changes, suggestions });
}

/**
 * Where each row that matched no question could slot in, leaving out what the person already accepted. The rows are
 * matched exactly as the import matches them, deleted questions included.
 */
function suggestionsFor(s: State, dealId: string, rows: ImportRow[], accepted: AcceptedMatch[]): Suggestion[] {
  return suggestMatches(rows, dealQuestions(s, dealId), importMatches(s, dealId, 'merge', rows, accepted));
}

/**
 * Ask the model where the table is. Its answer is treated as a proposal and checked against the file: the sheet must exist,
 * the row must be in range, and a field is taken only when the heading it names is really in that row. Anything else is
 * dropped. Returns the table re-read at the proposed place with the proposed columns, or the reason there is no proposal.
 */
export async function proposeLayout(store: Store, table: ImportTable): Promise<Result<ImportTable>> {
  const layout = store.services.ai.layout;
  if (!layout) return fail({ kind: 'rejected', message: 'The backend does not offer this' });
  const r = await layout({ fileName: table.name, bytes: table.bytes, sheets: table.previews, fields: IMPORT_FIELDS.map(([k]) => k) });
  if (!r.ok) return r;
  if (!table.sheets.includes(r.value.sheet) || !Number.isInteger(r.value.headerRow)) return fail({ kind: 'invalid', message: 'The proposal did not fit the file' });
  const again = await readImportBytes(store, table.name, table.bytes, { sheet: r.value.sheet, headerRow: r.value.headerRow });
  if (!again.ok) return again;
  const norm = (x: string) => x.trim().toLowerCase(); const mapping = { ...again.value.mapping };
  for (const [k] of IMPORT_FIELDS) {
    const said = r.value.fields?.[k]; if (typeof said !== 'string' || !said.trim()) continue;
    const i = again.value.columns.findIndex((c) => norm(c) === norm(said));
    if (i >= 0) { for (const [o] of IMPORT_FIELDS) if (o !== k && mapping[o] === i) mapping[o] = null; mapping[k] = i; }   // one column, one field
  }
  if (mapping.text == null) return fail({ kind: 'invalid', message: 'No question column was proposed' });
  return ok({ ...again.value, mapping, proposedByAi: true });
}
