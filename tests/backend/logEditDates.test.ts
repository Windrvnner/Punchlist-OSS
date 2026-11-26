// Dates written into an .xlsx log as real dates, in the column's own date format: text
// such as "2026-11-12" would not sort or filter as a date in Excel.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { libreOfficeConverter } from '../../src/backend/convert';
import { editXlsx } from '../../src/backend/xlsxEdit';
import { readZip, partText } from '../../src/backend/zipParts';
import { writtenAsMeant, type SheetEdit } from '../../src/domain/sheets';
import { hasOffice as has, soffice } from './officePrerequisites';

const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-dates-lo-')) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-dates-'));
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'; const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const t = (ref: string, v: string, s = 0) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t>${v}</t></is></c>`;
const n = (ref: string, v: number, s = 0) => `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
const header = `<row r="1">${t('A1', 'No.')}${t('B1', 'Question')}${t('C1', 'Received')}</row>`;
// style 1 shows a date in a format of the workbook's own; style 2 is Excel's built-in short date (14); style 3 a plain number
const styles = `<styleSheet xmlns="${main}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\ mmm\\ yyyy"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

function book(rows: string[], o: { in1904?: boolean } = {}): string {
  const dir = tmp(); const put = (name: string, xml: string) => { fs.mkdirSync(path.dirname(path.join(dir, 'x', name)), { recursive: true }); fs.writeFileSync(path.join(dir, 'x', name), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`); };
  put('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  put('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put('xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${rel}">${o.in1904 ? '<workbookPr date1904="1"/>' : ''}<sheets><sheet name="Log" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  put('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="${rel}/styles" Target="styles.xml"/></Relationships>`);
  put('xl/styles.xml', styles);
  put('xl/worksheets/sheet1.xml', `<worksheet xmlns="${main}" xmlns:r="${rel}"><sheetData>${[header, ...rows].join('')}</sheetData></worksheet>`);
  execFileSync('zip', ['-q', '-X', '-r', path.join(dir, 'log.xlsx'), '.'], { cwd: path.join(dir, 'x') });
  return path.join(dir, 'log.xlsx');
}
async function write(file: string, steps: SheetEdit[]) {
  const out = path.join(tmp(), 'out.xlsx'); const bytes = editXlsx(fs.readFileSync(file), 'Log', steps); fs.writeFileSync(out, bytes);
  return { xml: partText(readZip(bytes), 'xl/worksheets/sheet1.xml')!, wrong: has ? writtenAsMeant(await lo.sheets!(file), await lo.sheets!(out), 'Log', steps) : null };
}
const cellOf = (xml: string, ref: string) => new RegExp(`<c r="${ref}"[^>]*?(?:/>|>.*?</c>)`).exec(xml)?.[0];

describe('a date written into an .xlsx log', () => {
  it('is a real date in the cell\'s own date format, and reads back as the date written', async () => {
    const r = await write(book([`<row r="2">${t('A2', '1')}${t('B2', 'DSCR?')}<c r="C2" s="1"/></row>`]), [{ kind: 'cell', row: 1, col: 2, value: '2026-11-12', date: true }]);
    expect(cellOf(r.xml, 'C2')).toBe('<c r="C2" s="1"><v>46338</v></c>'); expect(r.wrong).toBeNull();
  }, 60_000);
  it('in a new row takes the date format of the row above, Excel\'s built-in one too', async () => {
    const r = await write(book([`<row r="2">${t('A2', '1')}${t('B2', 'DSCR?')}${n('C2', 46337, 2)}</row>`]), [{ kind: 'rows', after: 1, count: 1 }, { kind: 'cell', row: 2, col: 1, value: 'EPC?' }, { kind: 'cell', row: 2, col: 2, value: '2026-11-14', date: true }]);
    expect(cellOf(r.xml, 'C3')).toBe('<c r="C3" s="2"><v>46340</v></c>'); expect(r.wrong).toBeNull();
  }, 60_000);
  it('in a cell with no look of its own takes a date format its column uses', async () => {
    const r = await write(book([`<row r="2">${t('A2', '1')}${t('B2', 'DSCR?')}${n('C2', 46337, 1)}</row>`, `<row r="3">${t('A3', '2')}${t('B3', 'EPC?')}</row>`, `<row r="4">${t('A4', '3')}${t('B4', 'O&amp;M?')}</row>`]), [{ kind: 'cell', row: 3, col: 2, value: '2026-11-12', date: true }]);
    expect(cellOf(r.xml, 'C4')).toBe('<c r="C4" s="1"><v>46338</v></c>'); expect(r.wrong).toBeNull();
  }, 60_000);
  it('stays text in a column that shows no dates, and in a cell styled some other way, so neither changes its look', async () => {
    const plain = await write(book([`<row r="2">${t('A2', '1')}${t('B2', 'DSCR?')}</row>`]), [{ kind: 'cell', row: 1, col: 2, value: '2026-11-12', date: true }]);
    expect(cellOf(plain.xml, 'C2')).toContain('t="inlineStr"'); expect(plain.wrong).toBeNull();
    const styled = await write(book([`<row r="2">${t('A2', '1')}${t('B2', 'DSCR?')}<c r="C2" s="3"/></row>`, `<row r="3">${n('C3', 46337, 1)}</row>`]), [{ kind: 'cell', row: 1, col: 2, value: '2026-11-12', date: true }]);
    expect(cellOf(styled.xml, 'C2')).toMatch(/^<c r="C2" s="3" t="inlineStr">/);
  }, 60_000);
  it('counts its days as the workbook does, from 1904 in a workbook that says so', async () => {
    const r = await write(book([`<row r="2">${t('A2', '1')}${t('B2', 'DSCR?')}<c r="C2" s="1"/></row>`], { in1904: true }), [{ kind: 'cell', row: 1, col: 2, value: '2026-11-12', date: true }]);
    expect(cellOf(r.xml, 'C2')).toBe(`<c r="C2" s="1"><v>${46338 - 1462}</v></c>`); expect(r.wrong).toBeNull();
  }, 60_000);
});
