/**
 * A small .xlsx written by hand for tests that need a log the app writes in place: one sheet, every cell text. The
 * parts are stored, not compressed, and carry Excel's name, so LibreOffice trusts what they hold.
 */
import { readZip, partText, writeZip } from '../../src/backend/zipParts';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const colName = (c: number) => { let n = ''; for (let k = c + 1; k > 0; k = Math.floor((k - 1) / 26)) n = String.fromCharCode(65 + ((k - 1) % 26)) + n; return n; };
const colIndex = (name: string) => [...name].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** the file's parts, each stored as given */
function stored(parts: Record<string, string>) {
  return writeZip({ entries: Object.entries(parts).map(([name, text]) => {
    const data = new Uint8Array(Buffer.from(text, 'utf8'));
    return { name, method: 0, flags: 0, time: 0, date: 0x21, crc: crc32(data), size: data.length, usize: data.length, data,
      extra: new Uint8Array(), comment: new Uint8Array(), attrs: 0, made: 20, version: 20 };
  }) });
}
function crc32(data: Uint8Array): number {
  let crc = ~0; for (const byte of data) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}

/** the rows as a workbook with one sheet, named `sheet`; an empty cell is left out */
export function xlsxOf(rows: string[][], sheet = 'Sheet1'): Uint8Array {
  const cell = (v: string, r: number, c: number) => (v === '' ? '' : `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
  const data = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, r, c)).join('')}</row>`).join('');
  return stored({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>',
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'docProps/app.xml': '<?xml version="1.0" encoding="UTF-8"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="${esc(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${data}</sheetData></worksheet>`,
  });
}

/** the first sheet's cells as text, as `xlsxOf` or the app's own edit of such a file holds them */
export function gridOf(bytes: Uint8Array): string[][] {
  const xml = partText(readZip(bytes), 'xl/worksheets/sheet1.xml') ?? '';
  const grid: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = +row[1] - 1; grid[r] ??= [];
    for (const c of row[2].matchAll(/<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const text = [...(c[2] ?? '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<v>([\s\S]*?)<\/v>/g)].map((m) => unesc(m[1] ?? m[2] ?? '')).join('');
      const at = colIndex(c[1]); while (grid[r].length <= at) grid[r].push(''); grid[r][at] = text;
    }
  }
  for (let r = 0; r < grid.length; r++) grid[r] ??= [];
  return grid;
}
