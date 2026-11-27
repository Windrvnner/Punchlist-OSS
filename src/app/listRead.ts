/**
 * Reading a list in with the model, every line accounted for, with accuracy over cost. The standard model reads the
 * whole list in one call; when its reading leaves lines unplaced (not named, or a table row whose named cell is blank),
 * the thorough model reads the whole list once more and fills those lines. What is still unplaced is left out,
 * where a person sees it and can bring it in (domain/listRead). The calls are retried as every AI call is
 * (backend/retry.ts).
 */
import { decodeText } from '../domain/textEncoding';
import type { AiService } from '../ports';
import {
  cellText, fillUnplaced, unplaced, textLines, tableLines, tableRowsAsWritten, tieOut, readingOf, type ListReading,
  type TiedOut,
} from '../domain/listRead';
import { prepareChecklist, suggestChecklistColumns, type ChecklistMapping } from '../domain/checklistImport';
import { keepImport } from './keptImports';
import { readImportBytes, type ImportTable } from './transfer';
import type { Store } from './store';
import { ok, fail, type Result } from '../domain/result';

/** `cellRows`: the numbers of the lines built from cells, the only lines read as cell rows (domain/listRead) */
export async function readList(
  ai: AiService, lines: string[], cellRows: ReadonlySet<number> = new Set(),
): Promise<Result<ListReading>> {
  if (!ai.readList) return fail({ kind: 'rejected', message: 'The backend does not offer this' });
  const first = await ai.readList({ lines });
  // the first reading failing fails the read: the person sees why, with Retry, and the text stays as it is
  if (!first.ok) return first;
  const reading = readingOf(first.value, cellRows);
  if (!unplaced(lines, reading).length) return ok(reading);
  const again = await ai.readList({ lines, thorough: true });
  // a thorough reading that fails leaves the unplaced lines out, listed for the person, keeping the first reading
  return ok(again.ok ? fillUnplaced(lines, reading, readingOf(again.value, cellRows)) : reading);
}

/** The files a list can be brought in from: spreadsheets, documents and plain text. */
export const LIST_FILES = /\.(xlsx|xlsm|xls|xlsb|ods|csv|docx|docm|doc|odt|rtf|pdf|txt|text|md)$/i;
export const LIST_ACCEPT = '.xlsx,.xlsm,.xls,.xlsb,.ods,.csv,.docx,.docm,.doc,.odt,.rtf,.pdf,.txt,.text,.md';
const SHEET = /\.(xlsx|xlsm|xls|xlsb|ods|csv)$/i; const PLAIN = /\.(txt|text|md)$/i;

/**
 * A pasted line's cells when a tab splits it: one per tab and one more, each with its own spaces, empty cells at its
 * edges included, so a column keeps the number it has in the spreadsheet. A line with no tab, or with only blank cells,
 * is text (#1227).
 */
function pastedCells(line: string): string[] | null {
  const cells = line.split('\t');
  return cells.length > 1 && cells.some((cell) => cell.trim()) ? cells : null;
}

/**
 * Pasted text as lines. Text copied from a spreadsheet comes with its cells split by tabs: those are written " | ", as
 * a table's rows are given to the model, so a paste from Excel reads as the table it is. A line with no tab stays as
 * written.
 */
export const pastedLines = (text: string): string[] =>
  textLines(text).map((line) => pastedCells(line)?.map(cellText).join(' | ') ?? line);

/** the numbers (from 1) of the pasted lines built from cells */
const pastedCellRows = (text: string): number[] =>
  textLines(text).flatMap((line, i) => (pastedCells(line) ? [i + 1] : []));

/**
 * A chosen file as a source for the model: a spreadsheet as its table (`table`, every row from the top of the sheet, so
 * that nothing above a heading row is passed over), anything else as its text. Nothing is changed.
 */
export async function readListFile(
  store: Store,
  file: { name: string; arrayBuffer(): Promise<ArrayBuffer> },
): Promise<Result<{ table: ImportTable } | { lines: string[] }>> {
  if (!LIST_FILES.test(file.name)) return fail({ kind: 'invalid', message: 'Choose a spreadsheet, a Word file, a PDF or a text file' });
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); } catch { return fail({ kind: 'failed', message: 'The file could not be opened' }); }
  if (SHEET.test(file.name)) { const t = await readImportBytes(store, file.name, bytes, { headerRow: 1 }); return t.ok ? ok({ table: t.value }) : t; }
  let text: string;
  // by byte-order mark, else UTF-8, else Windows-1252, as a CSV is read (#382)
  if (PLAIN.test(file.name)) {
    try { text = decodeText(bytes); } catch (e) { return fail({ kind: 'invalid', message: (e as Error).message }); }
  } else {
    const sheets = store.services.sheets;
    if (!sheets.text) return fail({ kind: 'invalid', message: 'Only spreadsheets and text files can be read here' });
    const r = await sheets.text(bytes, file.name);
    if (!r.ok) return r;
    text = r.value;
  }
  const lines = textLines(text.replace(/^\uFEFF/, ''));
  return lines.some((l) => l.trim()) ? ok({ lines }) : fail({ kind: 'invalid', message: 'The file has no text' });
}

type ChecklistFile = Parameters<typeof readListFile>[1];
/**
 * `written`: a paste as pasted, line for line with `lines` (which the model reads), for a line brought in (#1061).
 * `cellRows`: the numbers of the lines built from cells, the only lines read as cell rows (#1227).
 */
export interface ChecklistText {
  name: string;
  lines: string[];
  written?: string[];
  cellRows?: number[];
}
interface MappedChecklistTable { table: ImportTable; mapping: ChecklistMapping }

function mappedTable(table: ImportTable): MappedChecklistTable {
  return { table, mapping: suggestChecklistColumns(table.columns) };
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
  if (!paste.trim()) return null;
  return { name: '', lines: pastedLines(paste), written: textLines(paste), cellRows: pastedCellRows(paste) };
}

export function checklistSourceLines(text: ChecklistText | null, table: ImportTable | null) {
  return text?.lines ?? (table ? tableLines(table.columns, table.rows) : null);
}

/** The lines as the source writes them, line for line with `checklistSourceLines`, for a line brought in (#1061) */
export function checklistWrittenLines(text: ChecklistText | null, table: ImportTable | null) {
  if (text) return text.written ?? text.lines;
  return table ? tableRowsAsWritten(table.columns, table.rows) : null;
}

/**
 * The numbers of the lines built from cells: a table of several columns has every row so, a table of one column none,
 * and a text its pasted lines that had tabs between cells (#1227).
 */
export function checklistCellRows(text: ChecklistText | null, table: ImportTable | null): ReadonlySet<number> {
  if (text) return new Set(text.cellRows ?? []);
  const rows = table && table.columns.length > 1 ? table.rows.length + 1 : 0;
  return new Set(Array.from({ length: rows }, (_, k) => k + 1));
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
  cellRows: ReadonlySet<number>;
}

interface KeptReading {
  reads?: ListReading | null;
  readFailed?: string;
}

interface ReadingEvents {
  started(): void;
  finished(reply: Result<ListReading>): void;
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
    const reply = await readList(store.services.ai, current.lines, current.cellRows);
    if (source !== current || !requests.isLatest(ticket)) return;
    events.finished(reply);
    return reply;
  }

  async function sourceChanged(
    lines: string[] | null, byColumns: boolean, events: ReadingEvents, cellRows: ReadonlySet<number> = new Set(),
  ) {
    if (sameSource(lines, byColumns)) return;
    const first = !source;
    source = { lines, byColumns, cellRows };
    if (first && alreadyRead) return;
    return read(events);
  }

  function retry(
    lines: string[] | null, byColumns: boolean, events: ReadingEvents, cellRows: ReadonlySet<number> = new Set(),
  ) {
    if (!sameSource(lines, byColumns)) source = { lines, byColumns, cellRows };
    return read(events);
  }

  return { sourceChanged, retry };
}

export function tieChecklistLines(
  lines: string[] | null, reading: ListReading | null, bringIn?: Set<number>, written?: string[] | null,
) {
  return lines && reading ? tieOut(lines, reading, bringIn, written ?? lines) : null;
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
