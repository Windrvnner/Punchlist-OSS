/**
 * Spreadsheets as the app sees them: each sheet a grid of text, cell A1 at [0][0]. LibreOffice turns any spreadsheet
 * (.xlsx, .xlsm, .xls, .xlsb, .ods) into one CSV per sheet, values as the file shows them; a .csv is read as it is.
 * Everything here is pure: which sheet and heading row an import uses, and the workbook an export is written as.
 */
import { findHeaderRow, suggestMapping } from './importExport';
import type { SheetPreview } from '../ports';
import { fail, ok } from './result';

export interface Sheet { name: string; grid: string[][] }

/** a real date cell as LibreOffice's plain reading gives it: YYYY-MM-DD, with its time if it has one */
const PLAIN_DATE = /^\d{4}-\d{2}-\d{2}( \d.*)?$/;

/**
 * A workbook's cells as the file shows them ("1,234.50", "15%", "007"), except a real date cell, which stays in the
 * plain reading's YYYY-MM-DD: the import settles a date from that, never from a display format that may be day or month
 * first. `plain` and `shown` are the same workbook read both ways, so their sheets and cells line up.
 */
export function cellsAsShown(plain: Sheet[], shown: Sheet[]): Sheet[] {
  return plain.map((sheet, s) => ({
    name: sheet.name,
    grid: sheet.grid.map((row, r) => row.map((cell, c) => {
      const seen = shown[s]?.name === sheet.name ? shown[s].grid[r]?.[c] : undefined;
      return seen === undefined || PLAIN_DATE.test(cell) ? cell : seen;
    })),
  }));
}

/** CSV as written by Excel and LibreOffice: commas, fields in double quotes when they hold a comma, quote or line break, "" for a quote. */
export function parseCsv(text: string, bare?: (field: string) => string): string[][] {
  // `bare` rewrites a field written without quotes; LibreOffice quotes every text cell, so a bare field is a number or a date
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false; let wasQuoted = false;
  const end = () => { row.push(bare && !wasQuoted ? bare(field) : field); field = ''; wasQuoted = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') { quoted = true; wasQuoted = true; }
    else if (c === ',') end();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; end(); rows.push(row); row = []; }
    else field += c;
  }
  if (field || row.length) { end(); rows.push(row); }
  return rows.map((r) => r.map((x) => x.replace(/\r\n?/g, '\n')));
}

/** a sheet's used rows, and the sheet row number of the first of them (rows above are blank) */
function used(grid: string[][]): { table: string[][]; first: number } | null {
  let a = 0, b = grid.length;
  while (a < b && grid[a].every((x) => !x.trim())) a++;
  while (b > a && grid[b - 1].every((x) => !x.trim())) b--;
  return a < b ? { table: grid.slice(a, b), first: a + 1 } : null;
}

/** `cols[i]` is the sheet column (from 0) of `columns[i]`: columns with neither a heading nor a value are left out, so the two can differ */
export type ReadTable = { columns: string[]; cols: number[]; rows: string[][]; lines: number[]; sheets: string[]; sheet: string; headerRow: number; lastRow: number; previews: SheetPreview[] };
/**
 * One step of an edit to a spreadsheet, in order. Rows and columns count from 0 on the sheet. `rows` inserts `count`
 * empty rows below `after`, each formatted like it; `cell` sets one cell, a number as a number and anything else as text.
 */
/** `date`: the value is a date, YYYY-MM-DD; a writer that can goes on to write it as a date in the column's own date format, else as that text */
export type SheetEdit = { kind: 'rows'; after: number; count: number } | { kind: 'cell'; row: number; col: number; value: string | number; date?: true };

/**
 * The table an import reads from a file's sheets. Which sheet: the one asked for; otherwise the first that has a question
 * heading; otherwise the first with anything in it. Which row holds the headings: the one asked for, otherwise found
 * (findHeaderRow). Rows above it are titles and padding; columns with neither a heading nor a value are left out. Blank
 * rows are dropped, and each kept row remembers its row number in the sheet, so an error can point at it.
 */
export function tableFrom(all: Sheet[], opts?: { sheet?: string; headerRow?: number }): ReadTable | null {
  const grids = new Map(all.map((s) => [s.name, used(s.grid)] as const));
  const sheets = all.map((s) => s.name).filter((n) => grids.get(n));
  if (!sheets.length) return null;
  const sheet = opts?.sheet && sheets.includes(opts.sheet) ? opts.sheet : sheets.find((n) => { const g = grids.get(n)!; return suggestMapping(g.table[findHeaderRow(g.table)]).text != null; }) ?? sheets[0];
  const { table, first } = grids.get(sheet)!;
  const width = Math.max(...table.map((r) => r.length)); const square = table.map((r) => [...r, ...Array(width - r.length).fill('')]);
  const h = opts?.headerRow != null ? Math.max(0, Math.min(square.length - 1, Math.round(opts.headerRow) - first)) : findHeaderRow(square);
  const header = square[h];
  const kept = square.slice(h + 1).map((r, i) => ({ r, line: first + h + 1 + i })).filter((x) => x.r.some((c) => c.trim()));
  const keep = header.map((c, ci) => !!c.trim() || kept.some((x) => !!x.r[ci]?.trim()));
  const cut = (r: string[]) => r.filter((_, ci) => keep[ci]);
  return {
    columns: cut(header), cols: header.map((_, ci) => ci).filter((ci) => keep[ci]), rows: kept.map((x) => cut(x.r)), lines: kept.map((x) => x.line), sheets, sheet, headerRow: first + h, lastRow: first + table.length - 1,
    previews: sheets.map((n) => { const g = grids.get(n)!; return { name: n, first: g.first, rows: g.table.slice(0, 30).map((r) => r.slice(0, 40).map((c) => (c.length > 80 ? c.slice(0, 80) : c))) }; }),
  };
}

/** column letters for a 0-based index: 0 → A, 26 → AA */
export const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));

/** The part of a sheet a citation points at ("Model!B12", "B12" or a sheet name): the cited row with eight either side, or the top of the sheet. */
export function sheetPart(all: Sheet[], loc: string): { cols: string[]; rows: { r: number; cells: string[] }[]; cell?: string } {
  const m = /^(?:(.*)!)?\$?([A-Za-z]{1,3})\$?(\d+)\s*$/.exec(loc.trim());
  const asked = (m ? m[1] ?? '' : loc).trim().replace(/^'(.*)'$/, '$1');
  const s = all.find((x) => x.name === asked) ?? all.find((x) => x.name.toLowerCase() === asked.toLowerCase()) ?? all[0];
  const grid = s?.grid ?? [];
  const at = m ? { r: +m[3] - 1, c: [...m[2].toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 } : null;
  const WIDE = 12; const lastCol = Math.max(0, ...grid.map((r) => r.length - 1), at?.c ?? 0);
  const c0 = at && at.c >= WIDE ? at.c - WIDE + 4 : 0; const c1 = Math.min(lastCol, c0 + WIDE - 1);
  const r0 = at ? Math.max(0, at.r - 8) : 0; const r1 = at ? at.r + 8 : Math.min(grid.length - 1, 39);
  const cols: string[] = []; for (let c = c0; c <= c1; c++) cols.push(colName(c));
  const rows: { r: number; cells: string[] }[] = [];
  for (let r = r0; r <= r1; r++) rows.push({ r: r + 1, cells: cols.map((_, i) => grid[r]?.[c0 + i] ?? '') });
  return { cols, rows, ...(m ? { cell: `${m[2].toUpperCase()}${m[3]}` } : {}) };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// characters a spreadsheet file can't hold
const clean = (v: string) => v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, ' ');

/**
 * A spreadsheet LibreOffice turns into .xlsx (OpenDocument's one-file form). On every sheet: the first row in bold, every
 * cell wrapped and aligned to the top, each column as wide as its text needs (between 0.6 and 4.5 inches). Numbers stay numbers; line breaks in a text stay line breaks. An export is one sheet.
 */
export const exportDocument = (sheetName: string, rows: (string | number)[][]): string => spreadsheetDocument([{ name: sheetName, rows }]);

export function spreadsheetDocument(sheets: { name: string; rows: (string | number)[][] }[]): string {
  const name = (n: string) => esc(clean(n).slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  const cell = (v: string | number | undefined, style: string) => typeof v === 'number'
    ? `<table:table-cell table:style-name="${style}" office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell>`
    // one paragraph per line, whichever way the line breaks are stored: a CR left inside a paragraph reads back as a second break
    : `<table:table-cell table:style-name="${style}" office:value-type="string">${clean(String(v ?? '')).split(/\r\n|\r|\n/).map((l) => `<text:p>${esc(l)}</text:p>`).join('')}</table:table-cell>`;
  // about 0.075 inch per character of a column's longest line, judged on its first 200 rows
  const widths = sheets.map(({ rows }) => Array.from({ length: Math.max(1, ...rows.map((r) => r.length)) }, (_, c) => { const longest = Math.max(4, ...rows.slice(0, 200).map((r) => Math.max(...String(r[c] ?? '').split('\n').map((l) => l.length)))); return Math.min(4.5, Math.max(0.6, longest * 0.075)); }));
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
<office:automatic-styles>
${widths.map((ws, t) => ws.map((w, c) => `<style:style style:name="w${t}_${c}" style:family="table-column"><style:table-column-properties style:column-width="${w.toFixed(2)}in"/></style:style>`).join('\n')).join('\n')}
<style:style style:name="h" style:family="table-cell"><style:table-cell-properties fo:wrap-option="wrap" style:vertical-align="top"/><style:text-properties fo:font-weight="bold"/></style:style>
<style:style style:name="c" style:family="table-cell"><style:table-cell-properties fo:wrap-option="wrap" style:vertical-align="top"/></style:style>
</office:automatic-styles>
<office:body><office:spreadsheet>
${sheets.map((sh, t) => `<table:table table:name="${name(sh.name)}">${widths[t].map((_, c) => `<table:table-column table:style-name="w${t}_${c}"/>`).join('')}
${sh.rows.map((r, i) => `<table:table-row>${widths[t].map((_, c) => cell(r[c], i === 0 ? 'h' : 'c')).join('')}</table:table-row>`).join('\n')}
</table:table>`).join('\n')}
</office:spreadsheet></office:body></office:document>
`;
}

/** `all` as it reads once `steps` are made in `sheet` (a copy; null when there is no such sheet) */
export function withSteps(all: Sheet[], sheet: string, steps: SheetEdit[]): Sheet[] | null {
  const want = all.map((s) => ({ name: s.name, grid: s.grid.map((r) => [...r]) }));
  const t = want.find((s) => s.name === sheet); if (!t) return null;
  for (const s of steps) {
    if (s.kind === 'rows') t.grid.splice(s.after + 1, 0, ...Array.from({ length: s.count }, () => [] as string[]));
    else { while (t.grid.length <= s.row) t.grid.push([]); const r = t.grid[s.row]; while (r.length <= s.col) r.push(''); r[s.col] = String(s.value).replace(/\r\n?/g, '\n'); }
  }
  return want;
}

/**
 * The read-back check of a written log: `after`, read from the new file, must be `before` with `steps` made and
 * nothing else changed, on every sheet. Returns what differs, or null. Blank cells and rows at the edges don't count,
 * since a file may keep or drop them.
 */
export function writtenAsMeant(before: Sheet[], after: Sheet[], sheet: string, steps: SheetEdit[]): string | null {
  const trim = (g: string[][]) => { const rows = g.map((r) => { const x = [...r]; while (x.length && !x[x.length - 1]) x.pop(); return x; }); while (rows.length && !rows[rows.length - 1].length) rows.pop(); return rows; };
  const want = withSteps(before, sheet, steps); if (!want) return `there is no sheet named ${sheet}`;
  if (after.map((s) => s.name).join('\n') !== want.map((s) => s.name).join('\n')) return 'the sheets are not the same';
  for (const [i, s] of want.entries()) {
    const a = trim(after[i].grid), b = trim(s.grid);
    for (let r = 0; r < Math.max(a.length, b.length); r++) for (let c = 0; c < Math.max(a[r]?.length ?? 0, b[r]?.length ?? 0); c++) if ((a[r]?.[c] ?? '') !== (b[r]?.[c] ?? '')) return `${s.name}!${colName(c)}${r + 1} reads "${a[r]?.[c] ?? ''}", not "${b[r]?.[c] ?? ''}"`;
  }
  return null;
}

/** a path or file name as Windows compares it: case and slash direction don't matter, nor a separator at the end */
export const windowsPath = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLocaleLowerCase('en-US');

type Encoding = 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom' | 'utf-16le' | 'utf-16be' | 'utf-8' | 'windows-1252'
  | 'windows-1252-bom';

/** Whether the bytes are valid UTF-8 */
function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** UTF-16 without a byte-order mark, recognized by its zero bytes in the first 4,096 bytes */
function unmarkedUtf16(bytes: Uint8Array): Encoding | null {
  const n = Math.min(bytes.length, 4096);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2) oddZero++;
    else evenZero++;
  }
  if (n >= 4 && oddZero > n / 8 && evenZero < n / 64) return 'utf-16le';
  if (n >= 4 && evenZero > n / 8 && oddZero < n / 64) return 'utf-16be';
  return null;
}

/**
 * CSV files carry no reliable label for their encoding. Read, in order: a byte-order mark (UTF-8, UTF-16 either way);
 * UTF-16 without a mark, recognized by its zero bytes; valid UTF-8; and otherwise Windows-1252, which is what Excel on
 * Windows writes for "CSV" and in which every byte is a character. Text is never silently decoded as the wrong thing.
 */
function encodingOf(bytes: Uint8Array): Encoding {
  // a UTF-8 mark in front of Windows-1252 text, as some tools write it
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return isUtf8(bytes.subarray(3)) ? 'utf-8-bom' : 'windows-1252-bom';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le-bom';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be-bom';
  const utf16 = unmarkedUtf16(bytes);
  if (utf16) return utf16;
  return isUtf8(bytes) ? 'utf-8' : 'windows-1252';
}

export function decodeText(bytes: Uint8Array): string {
  const encoding = encodingOf(bytes);
  const markLength = encoding.startsWith('utf-16') ? 2 : 3;
  const bom = encoding.endsWith('-bom') ? markLength : 0;
  return new TextDecoder(encoding.replace('-bom', '')).decode(bytes.subarray(bom));
}

/** the characters Windows-1252 puts at 0x80–0x9F; the rest of its range is the same as Unicode */
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';

/** `text` as UTF-16 code units, two bytes each, big- or little-endian */
function utf16Bytes(text: string, bigEndian: boolean): number[] {
  return [...Array(text.length).keys()].flatMap((i) => {
    const code = text.charCodeAt(i);
    return bigEndian ? [code >> 8, code & 255] : [code & 255, code >> 8];
  });
}

/** `text` in the encoding `like` is in, byte-order mark included; throws when a character has no place in it */
export function encodeLike(text: string, like: Uint8Array): Uint8Array {
  switch (encodingOf(like)) {
    case 'utf-8-bom': return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    case 'utf-8': return new TextEncoder().encode(text);
    case 'utf-16le-bom': return new Uint8Array([0xff, 0xfe, ...utf16Bytes(text, false)]);
    case 'utf-16be-bom': return new Uint8Array([0xfe, 0xff, ...utf16Bytes(text, true)]);
    case 'utf-16le': return new Uint8Array(utf16Bytes(text, false));
    case 'utf-16be': return new Uint8Array(utf16Bytes(text, true));
    case 'windows-1252-bom': return new Uint8Array([0xef, 0xbb, 0xbf, ...cp1252(text)]);
    default: return new Uint8Array(cp1252(text));
  }
}

/** `text` as Windows-1252 bytes */
function cp1252(text: string): number[] {
  return [...text].map((ch) => {
    const code = ch.codePointAt(0)!;
    const high = CP1252.indexOf(ch);
    if (high >= 0) return 0x80 + high;
    if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) return code;
    throw new Error(`“${ch}” can’t be written in this CSV log’s encoding (Windows-1252)`);
  });
}

/** a workbook is a ZIP (.xlsx, .xlsm, .xlsb, .ods) or an OLE container (.xls), whatever it is called */
export function isWorkbook(b: Uint8Array): boolean {
  const zip = b[0] === 0x50 && b[1] === 0x4b;
  return zip || (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0);
}

/** A .csv read as text: raw strings, no number or date guessing. One sheet. */
export function readCsv(bytes: Uint8Array, opts?: { sheet?: string; headerRow?: number }) {
  if (isWorkbook(bytes)) {
    const message = 'That file is a workbook saved with a .csv name. Rename it to .xlsx and try again';
    return fail({ kind: 'invalid' as const, message });
  }
  const table = tableFrom([{ name: 'Sheet1', grid: parseCsv(decodeText(bytes)) }], opts);
  return table ? ok(table) : fail({ kind: 'invalid' as const, message: 'The file has no rows' });
}
