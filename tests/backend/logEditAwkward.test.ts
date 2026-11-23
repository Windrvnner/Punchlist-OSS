// Writing into awkward .xlsx logs: what Excel would hide, misread or report as broken
// is either written so it shows, or refused; a refusal saves nothing, which is better than a log that is wrong.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { libreOfficeConverter } from '../../src/backend/convert';
import { editXlsx } from '../../src/backend/xlsxEdit';
import { readZip, partText } from '../../src/backend/zipParts';
import { writtenAsMeant, type SheetEdit } from '../../src/domain/sheets';
import { hasOffice as has, soffice } from './officePrerequisites';

const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-adv-lo-')) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-adv-'));
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'; const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const t = (ref: string, v: string, s = 0) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t>${v}</t></is></c>`;
const n = (ref: string, v: number, s = 0) => `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
const header = `<row r="1">${t('A1', 'No.')}${t('B1', 'Question')}${t('C1', 'Response')}${t('D1', 'Status')}</row>`;

/** a one-sheet .xlsx written by hand: rows, XML before and after sheetData, and an optional table */
function book(o: { rows: string[]; before?: string; after?: string; table?: string; name?: string }): string {
  const dir = tmp(); const put = (name: string, xml: string) => { fs.mkdirSync(path.dirname(path.join(dir, 'x', name)), { recursive: true }); fs.writeFileSync(path.join(dir, 'x', name), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`); };
  put('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${o.table ? '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' : ''}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  put('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put('xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="${o.name ?? 'Log'}" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  put('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="${rel}/styles" Target="styles.xml"/></Relationships>`);
  put('xl/styles.xml', `<styleSheet xmlns="${main}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`);
  put('xl/worksheets/sheet1.xml', `<worksheet xmlns="${main}" xmlns:r="${rel}">${o.before ?? ''}<sheetData>${[header, ...o.rows].join('')}</sheetData>${o.after ?? ''}${o.table ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : ''}</worksheet>`);
  if (o.table) {
    put('xl/tables/table1.xml', o.table);
    put('xl/worksheets/_rels/sheet1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/table" Target="../tables/table1.xml"/></Relationships>`);
  }
  execFileSync('zip', ['-q', '-X', '-r', path.join(dir, 'log.xlsx'), '.'], { cwd: path.join(dir, 'x') });
  return path.join(dir, 'log.xlsx');
}

/** editXlsx, then the save pipeline's read-back check; returns the check's verdict and the written sheet and table XML */
async function write(file: string, steps: SheetEdit[], sheet = 'Log') {
  const out = path.join(tmp(), 'out.xlsx'); const bytes = editXlsx(fs.readFileSync(file), sheet, steps); fs.writeFileSync(out, bytes);
  const z = readZip(bytes);
  return { wrong: writtenAsMeant(await lo.sheets!(file), await lo.sheets!(out), sheet, steps), xml: partText(z, 'xl/worksheets/sheet1.xml')!, table: partText(z, 'xl/tables/table1.xml'), after: await lo.sheets!(out) };
}
const add = (after: number, ...cells: [number, string | number][]): SheetEdit[] => [{ kind: 'rows', after, count: 1 }, ...cells.map(([col, value]) => ({ kind: 'cell' as const, row: after + 1, col, value }))];

describe.skipIf(!has)('what Excel would hide or report as broken', () => {
  it('a new question below a filtered-out (hidden) last row must be visible', async () => {
    // a log sent with an autofilter showing only Open questions: the last row is Closed, so Excel saved it hidden="1"
    const f = book({
      rows: [
        `<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}${t('D2', 'Open')}</row>`,
        `<row r="3" hidden="1">${n('A3', 2)}${t('B3', 'EPC?')}${t('C3', 'Fabrikam')}${t('D3', 'Closed')}</row>`,
      ],
      after:
        '<autoFilter ref="A1:D3"><filterColumn ' +
        'colId="3"><filters><filter val="Open"/></filters></filterColumn></autoFilter>',
    });
    const r = await write(f, add(2, [0, 3], [1, 'Is there a tax equity investor?'], [3, 'Open']));
    expect(r.wrong).toBeNull();                                                          // saved
    expect(r.xml).toMatch(/<row r="4"[^>]*>/); expect(r.xml.match(/<row r="4"[^>]*>/)![0]).not.toMatch(/hidden="1"/);
  }, 60_000);

  it('a new question below a collapsed outline group must be visible', async () => {
    const f = book({ rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`, `<row r="3" outlineLevel="1" hidden="1">${n('A3', 2)}${t('B3', 'EPC?')}</row>`, ] });
    const r = await write(f, add(2, [0, 3], [1, 'Tax equity?']));
    expect(r.wrong).toBeNull();
    expect(r.xml.match(/<row r="4"[^>]*>/)![0]).not.toMatch(/hidden="1"|outlineLevel/);
  }, 60_000);

  it('refuses to add rows below a table\'s totals row', async () => {
    const f = book({
      rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}${t('D2', 'Open')}</row>`, `<row r="3">${t('A3', 'Total')}<c r="D3" t="str"><f>SUBTOTAL(103,Log[Status])</f><v>1</v></c></row>`],
      table: `<table xmlns="${main}" id="1" name="Log" displayName="Log" ref="A1:D3" totalsRowCount="1"><autoFilter ref="A1:D2"/><tableColumns count="4"><tableColumn id="1" name="No." totalsRowLabel="Total"/><tableColumn id="2" name="Question"/><tableColumn id="3" name="Response"/><tableColumn id="4" name="Status" totalsRowFunction="count"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showRowStripes="1"/></table>`,
    });
    expect(() => editXlsx(fs.readFileSync(f), 'Log', add(2, [0, 2], [1, 'Tax equity?'], [3, 'Open']))).toThrow('totals row');
  }, 60_000);

  it('refuses to write over a formula, even one that shows blank', async () => {
    // C2 is the master of a shared formula over C2:C3 that shows blank until answered; the app sees C2 as empty and fills it
    const f = book({ rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}<c r="C2" t="str"><f t="shared" ref="C2:C3" si="0">IF(E2="","",E2)</f><v></v></c></row>`, `<row r="3">${n('A3', 2)}${t('B3', 'EPC?')}<c r="C3" t="str"><f t="shared" si="0"/><v></v></c></row>`] });
    expect(() => editXlsx(fs.readFileSync(f), 'Log', [{ kind: 'cell', row: 1, col: 2, value: '1.20x' }])).toThrow('holds a formula');
  }, 60_000);

  it('refuses to write into a cell a merge covers, which Excel would not show', async () => {
    // a pre-formatted log: C3:C4 merged below the last question, so a new row's answer lands in the covered C4
    const f = book({ rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`], after: '<mergeCells count="1"><mergeCell ref="C3:C4"/></mergeCells>' });
    expect(() => editXlsx(fs.readFileSync(f), 'Log', [{ kind: 'rows', after: 1, count: 2 }, { kind: 'cell', row: 2, col: 1, value: 'EPC?' }, { kind: 'cell', row: 3, col: 1, value: 'Tax equity?' }, { kind: 'cell', row: 3, col: 2, value: 'None' }])).toThrow('merged cell');
  }, 60_000);

  it('text that reads as an OOXML escape (_x0041_) reads back as typed', async () => {
    const f = book({ rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`] });
    const r = await write(f, [{ kind: 'cell', row: 1, col: 2, value: 'see file_x0041_v2' }]);
    expect(r.after[0].grid[1][2]).toBe('see file_x0041_v2');
    expect(r.wrong).toBeNull();
  }, 60_000);
});

describe.skipIf(!has)('what used to be refused', () => {
  it('an answer with a control character makes a well-formed file', async () => {
    const f = book({ rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`] });
    const bytes = editXlsx(fs.readFileSync(f), 'Log', [{ kind: 'cell', row: 1, col: 2, value: 'pasted from a PDF\u0002\u000bpage 3' }]);
    const out = path.join(tmp(), 'out.xlsx'); fs.writeFileSync(out, bytes);
    expect((await lo.sheets!(out))[0].grid[1][2]).toBe('pasted from a PDFpage 3');
    expect(partText(readZip(bytes), 'xl/worksheets/sheet1.xml')).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);   // XML 1.0 has no place for them
  }, 60_000);

  it('rows written without r (allowed by the schema) are kept', async () => {
    const f = book({ rows: [`<row>${n('A2', 1)}${t('B2', 'DSCR?')}</row>`, `<row>${n('A3', 2)}${t('B3', 'EPC?')}</row>`] });
    const xml = partText(readZip(editXlsx(fs.readFileSync(f), 'Log', [{ kind: 'cell', row: 1, col: 2, value: '1.20x' }])), 'xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('DSCR?');
  });
});

describe.skipIf(!has)('the LibreOffice path (.xls, .ods)', () => {
  for (const ext of ['ods', 'xls']) {
    it(`.${ext}: a new row below a hidden last row is visible, and quotes, tabs and newlines survive`, async () => {
      const x = book({ name: 'Lender&apos;s &quot;Q&amp;A&quot;', rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`, `<row r="3" hidden="1">${n('A3', 2)}${t('B3', 'EPC?')}</row>`] });
      const dir = path.dirname(x);
      execFileSync(soffice, [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', ext, '--outdir', dir, x], { stdio: 'ignore' });
      const f = path.join(dir, `log.${ext}`); const sheet = (await lo.sheets!(f))[0].name;
      const steps = add(2, [0, 3], [1, 'a\tb\nc \\n =1+1']);
      const bytes = await lo.edit!(f, sheet, steps); const out = path.join(tmp(), `out.${ext}`); fs.writeFileSync(out, bytes);
      expect(writtenAsMeant(await lo.sheets!(f), await lo.sheets!(out), sheet, steps)).toBeNull();
      const xlsx = path.join(tmp(), 'o'); execFileSync(soffice, [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', 'xlsx', '--outdir', xlsx, out], { stdio: 'ignore' });
      const xml = partText(readZip(fs.readFileSync(path.join(xlsx, 'out.xlsx'))), 'xl/worksheets/sheet1.xml')!;
      expect(xml.match(/<row r="4"[^>]*>/)![0]).not.toMatch(/hidden="1"|hidden="true"/);
    }, 120_000);
  }
});

describe.skipIf(!has)('more .xlsx shapes', () => {
  it('a row with a set height does not clip a long new answer', async () => {
    const f = book({ rows: [`<row r="2" ht="15" customHeight="1">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`] });
    const r = await write(f, add(1, [0, 2], [1, 'EPC?'], [2, 'A long answer\nover\nfour lines']));
    expect(r.wrong).toBeNull();
    expect(r.xml.match(/<row r="3"[^>]*>/)![0]).not.toMatch(/customHeight="1"/);
  }, 60_000);
  it('a print area still covers the new rows', async () => {
    const f = book({ rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`] });
    const dir = tmp(); execFileSync('unzip', ['-q', f, '-d', dir]);
    const w = path.join(dir, 'xl/workbook.xml'); fs.writeFileSync(w, fs.readFileSync(w, 'utf8').replace('</sheets>', '</sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">Log!$A$1:$D$2</definedName></definedNames>'));
    const g = path.join(tmp(), 'log.xlsx'); execFileSync('zip', ['-q', '-X', '-r', g, '.'], { cwd: dir });
    const bytes = editXlsx(fs.readFileSync(g), 'Log', add(1, [0, 2], [1, 'EPC?']));
    expect(partText(readZip(bytes), 'xl/workbook.xml')).not.toContain('$A$1:$D$2');
  });
  it('a zip streamed with data descriptors, and an x: prefixed sheet with CRLF, are edited', async () => {
    const f = book({ rows: [`<row r="2">${n('A2', 1)}${t('B2', 'DSCR?')}</row>`] });
    const dir = tmp(); execFileSync('unzip', ['-q', f, '-d', dir]);
    const s = path.join(dir, 'xl/worksheets/sheet1.xml'); fs.writeFileSync(s, fs.readFileSync(s, 'utf8').replace(/<(\/?)(worksheet|sheetData|row|c|is|t|tableParts|tablePart)\b/g, '<$1x:$2').replace(`xmlns="${main}"`, `xmlns:x="${main}"`).replace(/\n/g, '\r\n'));
    const streamed = path.join(tmp(), 'log.xlsx'); fs.writeFileSync(streamed, execFileSync('zip', ['-q', '-r', '-fd', '-', '.'], { cwd: dir }));
    const r = await write(streamed, add(1, [0, 2], [1, 'EPC?']));
    expect(r.wrong).toBeNull(); expect(r.xml).toContain('<x:row r="3"');
  }, 60_000);
});
