/**
 * Reading a list in with the model, every line accounted for, with accuracy over cost. The standard model reads
 * every line; the lines its readings leave unplaced (skipped, or answered with words the line does not hold) are asked
 * about once more, and any still unplaced are asked of the thorough model. What is still unplaced after that is left
 * out, where a person sees it and can bring it in (domain/listRead). The calls are retried as every AI call is
 * (backend/retry.ts).
 */
import { decodeText } from '../domain/textEncoding';
import type { AiService } from '../ports';
import { unplaced, textLines, tableLines, tieOut, type LineRead, type TiedOut } from '../domain/listRead';
import { prepareChecklist, suggestChecklistColumns, type ChecklistMapping } from '../domain/checklistImport';
import { keepImport } from './keptImports';
import { readImportBytes, MAX_IMPORT_BYTES, type ImportTable } from './transfer';
import type { Store } from './store';
import { ok, fail, type Result } from '../domain/result';

export async function readList(ai: AiService, lines: string[]): Promise<Result<Map<number, LineRead>>> {
  if (!ai.readList) return fail({ kind: 'rejected', message: 'The backend does not offer this' });
  const first = await ai.readList({ lines });
  // the first reading failing fails the read: the person sees why, with Retry, and the text stays as it is
  if (!first.ok) return first;
  const reads = new Map<number, LineRead>(); const take = (rs: LineRead[]) => { for (const r of rs) reads.set(r.n, r); };
  take(first.value);
  for (const thorough of [false, true]) {
    const missing = unplaced(lines, reads); if (!missing.length) break;
    // a reading still unusable is dropped first, so the line is never taken from a reading the line does not bear out
    for (const n of missing) reads.delete(n);
    const again = await ai.readList({ lines, only: missing, thorough });
    // a later pass that fails leaves those lines out, listed for the person, rather than losing the reading already made
    if (again.ok) take(again.value.filter((r) => missing.includes(r.n)));
  }
  for (const n of unplaced(lines, reads)) reads.delete(n);
  return ok(reads);
}

/** The files a list can be brought in from: spreadsheets, documents and plain text. */
export const LIST_FILES = /\.(xlsx|xlsm|xls|xlsb|ods|csv|docx|docm|doc|odt|rtf|pdf|txt|text|md)$/i;
export const LIST_ACCEPT = '.xlsx,.xlsm,.xls,.xlsb,.ods,.csv,.docx,.docm,.doc,.odt,.rtf,.pdf,.txt,.text,.md';
const SHEET = /\.(xlsx|xlsm|xls|xlsb|ods|csv)$/i; const PLAIN = /\.(txt|text|md)$/i;

/**
 * Pasted text as lines. Text copied from a spreadsheet comes with its cells split by tabs: those are written " | ", as a
 * table's rows are given to the model, so a paste from Excel reads as the table it is.
 */
export const pastedLines = (text: string): string[] => textLines(text).map((l) => l.replace(/\s*\t\s*/g, ' | ').replace(/^ \| | \| $/g, ''));

/**
 * A chosen file as a source for the model: a spreadsheet as its table (`table`, every row from the top of the sheet, so
 * that nothing above a heading row is passed over), anything else as its text. Nothing is changed.
 */
export async function readListFile(store: Store, file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }): Promise<Result<{ table: ImportTable } | { lines: string[] }>> {
  if (!LIST_FILES.test(file.name)) return fail({ kind: 'invalid', message: 'Choose a spreadsheet, a Word file, a PDF or a text file' });
  if (file.size > MAX_IMPORT_BYTES) return fail({ kind: 'invalid', message: 'That file is larger than 20 MB' });
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return fail({ kind: 'failed', message: 'The file could not be opened' }); }
  if (SHEET.test(file.name)) { const t = await readImportBytes(store, file.name, bytes, { headerRow: 1 }); return t.ok ? ok({ table: t.value }) : t; }
  let text: string;
  if (PLAIN.test(file.name)) text = decodeText(bytes);   // UTF-8, UTF-16 or Windows-1252, as a spreadsheet program reads a text file
  else { const sheets = store.services.sheets; if (!sheets.text) return fail({ kind: 'invalid', message: 'Only spreadsheets and text files can be read here' }); const r = await sheets.text(bytes, file.name); if (!r.ok) return r; text = r.value; }
  const lines = textLines(text.replace(/^\uFEFF/, ''));
  return lines.some((l) => l.trim()) ? ok({ lines }) : fail({ kind: 'invalid', message: 'The file has no text' });
}

type ChecklistFile = Parameters<typeof readListFile>[1];
interface ChecklistText { name: string; lines: string[] }
interface MappedChecklistTable { table: ImportTable; mapping: ChecklistMapping }

function mappedTable(table: ImportTable): MappedChecklistTable {
  return { table, mapping: suggestChecklistColumns(table.columns, table.rows) };
}

export async function loadChecklistSource(
  store: Store, file: ChecklistFile,
): Promise<Result<MappedChecklistTable | { text: ChecklistText }>> {
  const read = await readListFile(store, file);
  if (!read.ok) return read;
  return 'table' in read.value
    ? ok(mappedTable(read.value.table))
    : ok({ text: { name: file.name, lines: read.value.lines } });
}

/** When reading with the model, keep rows above any heading so they can be tied out too. */
export async function readChecklistColumns(
  store: Store, table: ImportTable, options: { sheet?: string; headerRow?: number }, byColumns: boolean,
) {
  const layout = byColumns ? options : { ...options, headerRow: 1 };
  const read = await readImportBytes(store, table.name, table.bytes, layout);
  return read.ok ? ok(mappedTable(read.value)) : read;
}

/** A successfully replaced source starts without the previous table's heading draft (#380). */
export function clearChecklistHeading(key: string) {
  keepImport(key, { headingDraft: null });
}

export function checklistPaste(paste: string): ChecklistText | null {
  return paste.trim() ? { name: '', lines: pastedLines(paste) } : null;
}

export function checklistSourceLines(text: ChecklistText | null, table: ImportTable | null) {
  return text?.lines ?? (table ? tableLines(table.columns, table.rows) : null);
}

/** Later work (a file read, a model call, or leaving) takes the place of an earlier reply. */
export function checklistRequests() {
  let generation = 0;
  // worksheet reads still running: kept apart from the tokens, so a later request does not hide one (#821)
  const tableReads = new Set<number>();
  const newToken = () => ++generation;
  const isLatest = (token: number) => token === generation;
  const startTableRead = () => {
    const token = newToken();
    tableReads.add(token);
    return token;
  };
  // pending clears here only; whether the read is still the latest says whether its result is used
  const finishTableRead = (token: number) => {
    tableReads.delete(token);
    return isLatest(token);
  };
  const tableReadPending = () => tableReads.size > 0;
  // a read that never settles must not hold the review once the person has dropped it (Change, Back)
  const dropTableReads = () => tableReads.clear();
  return { newToken, isLatest, startTableRead, finishTableRead, tableReadPending, dropTableReads };
}

interface ChecklistTableReadEvents {
  started(): void;
  finished(read: Result<MappedChecklistTable>): void;
}

/** An older model reply cannot release the selected worksheet's read (#821). */
export async function rereadChecklistTable(
  store: Store, requests: ReturnType<typeof checklistRequests>, table: ImportTable,
  options: { sheet?: string; headerRow?: number }, byColumns: boolean, events: ChecklistTableReadEvents,
) {
  const token = requests.startTableRead();
  events.started();
  let read: Result<MappedChecklistTable>;
  try {
    read = await readChecklistColumns(store, table, options, byColumns);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The worksheet could not be opened';
    read = fail({ kind: 'failed', message });
  }
  if (requests.finishTableRead(token)) events.finished(read);
}

interface ReadSource {
  lines: string[] | null;
  byColumns: boolean;
}

interface KeptReading {
  reads?: Map<number, LineRead> | null;
  readFailed?: string;
}

interface ReadingEvents {
  started(): void;
  finished(reply: Result<Map<number, LineRead>>): void;
}

/** Resume an unfinished read, and ask again only when its source changes or the person chooses Retry. */
export function checklistReading(store: Store, requests: ReturnType<typeof checklistRequests>, kept?: KeptReading) {
  let source: ReadSource | undefined;
  const alreadyRead = !!kept?.reads || !!kept?.readFailed;
  const sameSource = (lines: string[] | null, byColumns: boolean) =>
    source?.lines === lines && source.byColumns === byColumns;

  async function read(events: ReadingEvents) {
    const current = source;
    if (!current?.lines || current.byColumns || requests.tableReadPending()) return;
    const ticket = requests.newToken();
    events.started();
    const reply = await readList(store.services.ai, current.lines);
    if (source !== current || !requests.isLatest(ticket)) return;
    events.finished(reply);
    return reply;
  }

  async function sourceChanged(lines: string[] | null, byColumns: boolean, events: ReadingEvents) {
    if (sameSource(lines, byColumns)) return;
    const first = !source;
    source = { lines, byColumns };
    if (first && alreadyRead) return;
    return read(events);
  }

  function retry(lines: string[] | null, byColumns: boolean, events: ReadingEvents) {
    if (!sameSource(lines, byColumns)) source = { lines, byColumns };
    return read(events);
  }

  return { sourceChanged, retry };
}

export function tieChecklistLines(lines: string[] | null, reads: Map<number, LineRead> | null, bringIn?: Set<number>) {
  return lines && reads ? tieOut(lines, reads, bringIn) : null;
}

export function checklistItemsAsRead(
  byColumns: boolean, table: ImportTable | null, mapping: ChecklistMapping, tied: TiedOut | null,
) {
  if (byColumns) {
    if (!table) return null;
    const result = prepareChecklist(table.rows, mapping);
    return { ...result, count: result.items.length };
  }
  if (!tied) return null;
  return { items: tied.items.map(({ lines: _, ...item }) => item), skipped: 0, count: tied.count.items };
}

export function checklistReadCounts(table: ImportTable | null, lines: string[] | null, paste: ChecklistText | null) {
  return { rows: table?.rows.length ?? 0, lines: lines?.length ?? 0, pasted: paste?.lines.length ?? 0 };
}
