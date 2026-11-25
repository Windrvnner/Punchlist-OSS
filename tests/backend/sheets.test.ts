// Spreadsheets read and written through LibreOffice, the one tool the app uses for every spreadsheet format.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { libreOfficeConverter } from '../../src/backend/convert';
import { exportDocument, spreadsheetDocument, parseCsv, sheetPart, tableFrom } from '../../src/domain/sheets';
import { libreOfficeSheets } from '../../src/backend/spreadsheets';
import { questionsSheet, prepareImport, suggestMapping } from '../../src/domain/importExport';
import { Question } from '../../src/domain/model';
import { hasOffice as has, soffice } from './officePrerequisites';
import { cachedWorkbook } from './workbookCache';

// a LibreOffice settings folder of its own, so test runs side by side never share one
const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-sheets-test-lo-')) });
// related cases share each workbook's conversion
const workbook = cachedWorkbook(lo);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-sheets-test-'));
/** an .xlsx written the way the app writes an export, then turned into `ext` by LibreOffice as a person's own file would be */
async function fileOf(ext: string, sheets: [string, (string | number)[][]][]): Promise<string> {
  const dir = tmp();
  const x = path.join(dir, 'book.xlsx');
  fs.writeFileSync(x, await workbook(spreadsheetDocument(sheets.map(([name, rows]) => ({ name, rows })))));
  if (ext === 'xlsx') return x;
  execFileSync(soffice, [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', ext, '--outdir', dir, x], { stdio: 'ignore' });
  return path.join(dir, `book.${ext}`);
}

/**
 * An .xlsx written by hand, as another program might write it: `rows` are the cells' XML (inside <row>), and cell style 1 is
 * a date with a time (number format 22), style 2 a date (14). LibreOffice is not used to write it, since it would save a
 * result for every formula. It says Excel wrote it, as files from Excel and openpyxl do: LibreOffice trusts the saved
 * results of such a file rather than working every formula out again.
 */
function handMadeXlsx(rows: string[]): string {
  const dir = tmp(); const put = (name: string, xml: string) => { fs.mkdirSync(path.dirname(path.join(dir, 'x', name)), { recursive: true }); fs.writeFileSync(path.join(dir, 'x', name), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`); };
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'; const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  put('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>');
  put('docProps/app.xml', '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>');
  put('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="${rel}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  put('xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Log" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  put('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`);
  put('xl/styles.xml', `<styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`);
  put('xl/worksheets/sheet1.xml', `<worksheet xmlns="${main}"><sheetData>${rows.map((r, i) => `<row r="${i + 1}">${r}</row>`).join('')}</sheetData></worksheet>`);
  execFileSync('zip', ['-q', '-r', path.join(dir, 'book.xlsx'), '.'], { cwd: path.join(dir, 'x') });
  return path.join(dir, 'book.xlsx');
}
const text = (ref: string, t: string) => `<c r="${ref}" t="inlineStr"><is><t>${t}</t></is></c>`;

describe('CSV', () => {
  it('reads quoted commas, quotes, line breaks and empty fields', () => {
    expect(parseCsv('a,"b, c","say ""hi""",\r\n1,"two\nlines",,x\n')).toEqual([['a', 'b, c', 'say "hi"', ''], ['1', 'two\nlines', '', 'x']]);
  });
});

describe.skipIf(!has)('spreadsheets through LibreOffice', () => {
  const two: [string, (string | number)[][]][] = [['Zeta notes', [['Note'], ['First']]], ['Q&A log', [['No.', 'Question', 'Received'], [1, 'Line one\nline two, with a comma', '11/02/2026'], [2, 'Second?', '']]]];

  for (const ext of ['xlsx', 'xls', 'ods', 'xlsm']) it(`reads every sheet of a .${ext}, in order, and picks the one with questions`, async () => {
    const f = await fileOf(ext, two); const all = await lo.sheets!(f);
    expect(all.map((s) => s.name)).toEqual(['Zeta notes', 'Q&A log']);
    const t = tableFrom(all)!;
    expect(t.sheet).toBe('Q&A log'); expect(t.columns).toEqual(['No.', 'Question', 'Received']);
    expect(t.rows[0]).toEqual(['1', 'Line one\nline two, with a comma', '11/02/2026']); expect(t.lines).toEqual([2, 3]);
  }, 60_000);

  it('reads a .xlsb (LibreOffice reads the format but can\'t write it, so the file is kept with the tests)', async () => {
    const t = tableFrom(await lo.sheets!(path.join(__dirname, '../fixtures/two-sheets.xlsb')))!;
    expect(t.sheets).toEqual(['Notes', 'Q&A log']); expect(t.sheet).toBe('Q&A log'); expect(t.rows).toEqual([['1', 'Line one\nline two, with a comma']]);
  }, 60_000);

  it('reads dates from Excel files in either date system (1900 and 1904) as the same day', async () => {
    const codec = libreOfficeSheets(lo);
    for (const f of ['excel-1900.xlsx', 'excel-1904.xlsx']) {
      const r = await codec.read(new Uint8Array(fs.readFileSync(path.join(__dirname, '../fixtures', f))), f);
      expect(r.ok && r.value.columns).toEqual(['Question', 'Received', 'Date']);
      const p = r.ok ? prepareImport(r.value.rows, suggestMapping(r.value.columns)) : null;
      expect(p?.rows[0]).toMatchObject({ text: 'Q epoch test', received: '2026-11-01', responded: '2026-11-02' });
    }
  }, 60_000);

  it('reads a date-and-time cell as its date', async () => {
    const f = handMadeXlsx([text('A1', 'Question') + text('B1', 'Received'), text('A2', 'Timed') + '<c r="B2" s="1"><v>46340.5</v></c>']);
    const r = await libreOfficeSheets(lo).read(new Uint8Array(fs.readFileSync(f)), 'book.xlsx'); if (!r.ok) throw new Error(r.error.message);
    const p = prepareImport(r.value.rows, suggestMapping(r.value.columns));
    expect(p.rows[0]).toMatchObject({ text: 'Timed', received: '2026-11-14' });
  }, 60_000);

  it('a date typed as text is kept as written; a real date cell is a date', async () => {
    const f = handMadeXlsx([text('A1', 'Question') + text('B1', 'Received'), text('A2', 'Typed') + text('B2', '02/11/2026'), text('A3', 'Cell') + '<c r="B3" s="2"><v>46328</v></c>']);
    const r = await libreOfficeSheets(lo).read(new Uint8Array(fs.readFileSync(f)), 'book.xlsx'); if (!r.ok) throw new Error(r.error.message);
    expect(r.value.rows.map((x) => x[1])).toEqual(['02/11/2026', '2026-11-02']);
    const p = prepareImport(r.value.rows, suggestMapping(r.value.columns));
    expect(p.rows.map((x) => x.received)).toEqual(['02/11/2026', '2026-11-02']); expect(p.unread).toEqual([]);
  }, 60_000);

  it('a formula cell with no saved result reads as its value, so its row is not left out (LibreOffice works it out on load)', async () => {
    const f = handMadeXlsx([text('A1', 'Number') + text('B1', 'Question') + text('C1', 'Received'), '<c r="A2"><v>1</v></c><c r="B2" t="str"><f>"What is "&amp;"the DSCR?"</f></c><c r="C2" s="2"><f>DATE(2026,11,2)</f></c>', '<c r="A3"><v>2</v></c><c r="B3"><f>CONCATENATE("No ","type")</f></c>', '<c r="A4"><v>3</v></c><c r="B4" t="str"><f>"Empty "&amp;"result"</f><v></v></c>']);
    const r = await libreOfficeSheets(lo).read(new Uint8Array(fs.readFileSync(f)), 'book.xlsx'); if (!r.ok) throw new Error(r.error.message);
    const p = prepareImport(r.value.rows, suggestMapping(r.value.columns));
    expect(p.skipped).toBe(0); expect(p.rows.map((x) => [x.n, x.text, x.received])).toEqual([[1, 'What is the DSCR?', '2026-11-02'], [2, 'No type', ''], [3, 'Empty result', '']]);
  }, 60_000);

  // only a date-formatted cell is a date
  it('a bare number in a date column is not read as a date and is kept as written', async () => {
    const f = handMadeXlsx([text('A1', 'Question') + text('B1', 'Received'), `${text('A2', 'Serial')}<c r="B2"><v>46340</v></c>`]);
    const r = await libreOfficeSheets(lo).read(new Uint8Array(fs.readFileSync(f)), 'book.xlsx'); if (!r.ok) throw new Error(r.error.message);
    expect(r.value.rows[0]).toEqual(['Serial', '46340']);
    const p = prepareImport(r.value.rows, suggestMapping(r.value.columns)); expect(p.rows[0].received).toBe('46340');
  }, 60_000);

  it('a Q&A log the app exports reads back the same: numbers, dates, line breaks, unicode', async () => {
    const codec = libreOfficeSheets(lo); const at = '2026-11-09T10:00:00.000Z';
    const q = Question.parse({ id: 'q_01HZZZZZZZZZZZZZZZZZZZZZZZ', dealId: 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ', rev: 1, createdAt: at, updatedAt: at, n: 37, text: 'Café façade — naïve £50 €100 中文 😀 & <b>x</b>\nSecond line', askedBy: 'Lender', received: '2026-11-01', workstream: 'Legal', priority: 'High', response: 'Yes.', respondedBy: 'Sponsor', responded: '2026-11-02', status: 'answered' });
    const file = await codec.write('Q&A log', questionsSheet([q])); if (!file.ok) throw new Error(file.error.message);
    expect(file.value.ext).toBe('xlsx');
    const r = await codec.read(file.value.bytes, 'log.xlsx'); if (!r.ok) throw new Error(r.error.message);
    const p = prepareImport(r.value.rows, suggestMapping(r.value.columns));
    expect(p.rows[0]).toMatchObject({ n: 37, text: q.text, received: '2026-11-01', responded: '2026-11-02', status: 'answered', priority: 'High' });
  }, 60_000);

  it('an export keeps leading spaces, trailing line breaks and a question of only spaces through LibreOffice', async () => {
    const codec = libreOfficeSheets(lo); const at = '2026-11-09T10:00:00.000Z';
    const q = (n: number, text: string, response = '') => Question.parse({ id: `q_01HZZZZZZZZZZZZZZZZZZZZZ${n}0`, dealId: 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ', rev: 1, createdAt: at, updatedAt: at, n, text, response });
    const file = await codec.write('Q&A log', questionsSheet([q(1, '  Indented, with  two spaces', 'Yes.\n'), q(2, '   '), q(3, 'Ends in a blank line\n\n', '\nStarts on a new line')])); if (!file.ok) throw new Error(file.error.message);
    const r = await codec.read(file.value.bytes, 'log.xlsx'); if (!r.ok) throw new Error(r.error.message);
    const p = prepareImport(r.value.rows, suggestMapping(r.value.columns));
    expect(p.skipped).toBe(0);
    expect(p.rows.map((x) => [x.n, x.text, x.response])).toEqual([[1, '  Indented, with  two spaces', 'Yes.\n'], [2, '   ', ''], [3, 'Ends in a blank line\n\n', '\nStarts on a new line']]);
  }, 60_000);

  it('a line break stored as CR LF or CR goes out as one line break, not two', async () => {
    const codec = libreOfficeSheets(lo);
    const file = await codec.write('Q&A log', [['Question', 'Response'], ['One\r\ntwo', 'Three\rfour\r\n']]); if (!file.ok) throw new Error(file.error.message);
    const r = await codec.read(file.value.bytes, 'log.xlsx'); expect(r.ok && r.value.rows[0]).toEqual(['One\ntwo', 'Three\nfour\n']);
  }, 60_000);

  it('a text as long as one Excel cell holds (32,767 characters) goes out and comes back whole', async () => {
    const codec = libreOfficeSheets(lo); const full = Array.from({ length: 900 }, (_, i) => `Clause ${i}: the lender may sweep cash.\n`).join('').slice(0, 32767);
    const file = await codec.write('Q&A log', [['Question', 'Response'], ['Long one', full]]); if (!file.ok) throw new Error(file.error.message);
    const r = await codec.read(file.value.bytes, 'log.xlsx'); expect(r.ok && r.value.rows[0][1]).toBe(full);
  }, 60_000);

  it('a file that is not a spreadsheet is refused with a reason', async () => {
    const r = await libreOfficeSheets(lo).read(new Uint8Array([1, 2, 3, 4]), 'x.xlsx'); expect(!r.ok && r.error.message).toBe('That file could not be read as a spreadsheet');
  });

  it('keeps cells where they are, so a citation like B3 points at the same cell', async () => {
    const f = await fileOf('xlsx', [['Model', [['', '', ''], ['', 'Title', ''], ['', 'CFADS', 41.2]]]]);
    const part = sheetPart(await lo.sheets!(f, true), 'Model!C3');
    expect(part.cell).toBe('C3'); expect(part.rows.find((r) => r.r === 3)!.cells.slice(0, 3)).toEqual(['', 'CFADS', '41.2']);
  }, 60_000);

  it('an export opens with its text whole, the header bold, cells wrapped and each column sized to its text', async () => {
    const long = 'A question long enough that it needs a wide column and wraps inside it. '.repeat(3);
    const bytes = await lo.workbook!(exportDocument('Q&A log', [['No.', 'Question'], [1, long], [2, 'Two\nlines']]));
    const dir = tmp(); const x = path.join(dir, 'e.xlsx'); fs.writeFileSync(x, bytes);
    const back = await lo.sheets!(x);
    expect(back[0].name).toBe('Q&A log'); expect(back[0].grid.slice(0, 3)).toEqual([['No.', 'Question'], ['1', long], ['2', 'Two\nlines']]);
    execFileSync('unzip', ['-q', x, '-d', path.join(dir, 'x')]);
    const sheet = fs.readFileSync(path.join(dir, 'x/xl/worksheets/sheet1.xml'), 'utf8'); const styles = fs.readFileSync(path.join(dir, 'x/xl/styles.xml'), 'utf8');
    const widths = [...sheet.matchAll(/<col [^>]*width="([\d.]+)"/g)].map((m) => +m[1]);
    expect(widths.length).toBeGreaterThanOrEqual(2); expect(widths[1]).toBeGreaterThan(widths[0] * 3);
    expect(styles).toContain('wrapText="true"'); expect(styles).toMatch(/<b val="true"\/>|<b\/>/);
  }, 60_000);
});
