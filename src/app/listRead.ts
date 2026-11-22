/**
 * Reading a list in with the model, every line accounted for, with accuracy over cost. The standard model reads
 * every line; the lines its readings leave unplaced (skipped, or answered with words the line does not hold) are asked
 * about once more, and any still unplaced are asked of the thorough model. What is still unplaced after that is left
 * out, where a person sees it and can bring it in (domain/listRead). The calls are retried as every AI call is
 * (backend/retry.ts).
 */
import type { AiService } from '../ports';
import { unplaced, textLines, type LineRead } from '../domain/listRead';
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
  if (PLAIN.test(file.name)) { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('windows-1252').decode(bytes); } }
  else { const sheets = store.services.sheets; if (!sheets.text) return fail({ kind: 'invalid', message: 'Only spreadsheets and text files can be read here' }); const r = await sheets.text(bytes, file.name); if (!r.ok) return r; text = r.value; }
  const lines = textLines(text.replace(/^\uFEFF/, ''));
  return lines.some((l) => l.trim()) ? ok({ lines }) : fail({ kind: 'invalid', message: 'The file has no text' });
}
