// Writing into a person's own Q&A log through LibreOffice: the values change, and everything else in the file stays as it was.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { libreOfficeConverter, editJob } from '../../src/backend/convert';
import { editXlsx } from '../../src/backend/xlsxEdit';
import { editLog } from '../../src/backend/spreadsheets';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { readZip, partText, setPart, writeZip } from '../../src/backend/zipParts';
import { sha256 } from '../../src/backend/qaLogFolder';
import { hasMetricFont, hasOffice as has, soffice } from './officePrerequisites';

const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-edit-test-lo-')) });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-edit-test-'));

/**
 * A log as a counterparty might send it, written by hand: a merged title, a dark header (style 1), shaded rows (style 2),
 * set column widths, a rule that shades Open, a frozen header and a second sheet of notes.
 */
function counterpartyLog(o: { table?: boolean } = {}): string {
  const dir = tmp(); const put = (name: string, xml: string) => { fs.mkdirSync(path.dirname(path.join(dir, 'x', name)), { recursive: true }); fs.writeFileSync(path.join(dir, 'x', name), `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`); };
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'; const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const ws = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  put('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ws}"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="${ws}"/>${o.table ? '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' : ''}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`);
  put('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  put('xl/workbook.xml', `<workbook xmlns="${main}" xmlns:r="${rel}"><sheets><sheet name="Lender Q&amp;A" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  put('xl/_rels/workbook.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${rel}/styles" Target="styles.xml"/></Relationships>`);
  put('xl/styles.xml', `<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1F3864"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/></cellXfs><dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFF8CBAD"/></patternFill></fill></dxf></dxfs></styleSheet>`);
  const t = (ref: string, v: string, s = 0) => `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t>${v}</t></is></c>`;
  const n = (ref: string, v: number, s = 0) => `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
  const rows = [
    `<row r="1">${t('A1', 'Project Proseware - Lender Q&amp;A log')}</row>`,
    `<row r="3">${t('A3', 'No.', 1)}${t('B3', 'Question', 1)}${t('C3', 'Sponsor response', 1)}${t('D3', 'Status', 1)}</row>`,
    `<row r="4">${n('A4', 1, 2)}${t('B4', 'What is the minimum DSCR covenant?', 2)}${t('C4', '1.20x', 2)}${t('D4', 'Closed', 2)}</row>`,
    `<row r="5">${n('A5', 2, 2)}${t('B5', 'Who is the EPC contractor?', 2)}<c r="C5" s="2"/>${t('D5', 'Open', 2)}</row>`,
  ];
  put('xl/worksheets/sheet1.xml', `<worksheet xmlns="${main}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="3" width="50" customWidth="1"/><col min="4" max="4" width="10" customWidth="1"/></cols><sheetData>${rows.join('')}</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells><conditionalFormatting sqref="D4:D200"><cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>"Open"</formula></cfRule></conditionalFormatting></worksheet>`);
  put('xl/worksheets/sheet2.xml', `<worksheet xmlns="${main}"><sheetData><row r="1">${t('A1', 'Internal notes')}</row></sheetData></worksheet>`);
  if (o.table) {
    // an Excel table over the header and the two rows, banded blue, and a sheet relationship to it
    put('xl/tables/table1.xml', `<table xmlns="${main}" id="1" name="Log" displayName="Log" ref="A3:D5"><autoFilter ref="A3:D5"/><tableColumns count="4"><tableColumn id="1" name="No."/><tableColumn id="2" name="Question"/><tableColumn id="3" name="Sponsor response"/><tableColumn id="4" name="Status"/></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`);
    put('xl/worksheets/_rels/sheet1.xml.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/table" Target="../tables/table1.xml"/></Relationships>`);
    const sheet = path.join(dir, 'x', 'xl/worksheets/sheet1.xml'); fs.writeFileSync(sheet, fs.readFileSync(sheet, 'utf8').replace('</worksheet>', `<tableParts count="1"><tablePart xmlns:r="${rel}" r:id="rId1"/></tableParts></worksheet>`));
  }
  execFileSync('zip', ['-q', '-r', path.join(dir, 'log.xlsx'), '.'], { cwd: path.join(dir, 'x') });
  return path.join(dir, 'log.xlsx');
}
/** the XML of one part of an .xlsx */
function part(bytes: Uint8Array, name: string): string {
  const dir = tmp(); const f = path.join(dir, 'out.xlsx'); fs.writeFileSync(f, bytes);
  return execFileSync('unzip', ['-p', f, name], { encoding: 'utf8' });
}
/** the style index of one cell in a sheet's XML */
const styleOf = (xml: string, ref: string) => xml.match(new RegExp(`<c r="${ref}"[^>]*?s="(\\d+)"`))?.[1];

/** Add names to the existing real workbook, retaining its layout and second sheet. */
function namedLog(names: string, sheet = 'Lender Q&A'): string {
  const file = counterpartyLog();
  const zip = readZip(fs.readFileSync(file));
  const label = sheet.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const workbook = partText(zip, 'xl/workbook.xml')!
    .replace('name="Lender Q&amp;A"', `name="${label}"`)
    .replace('</workbook>', `<definedNames>${names}</definedNames></workbook>`);
  setPart(zip, 'xl/workbook.xml', workbook);
  fs.writeFileSync(file, writeZip(zip));
  return file;
}

/** The same workbook with one unmapped formula, in a format written by the LibreOffice macro. */
function formulaLog(extension: 'xls', formula = 'LEN(B4)'): string {
  const file = counterpartyLog();
  const zip = readZip(fs.readFileSync(file));
  const xml = partText(zip, 'xl/worksheets/sheet1.xml')!;
  setPart(zip, 'xl/worksheets/sheet1.xml', xml.replace(/(<row r="4">[\s\S]*?)(<\/row>)/,
    `$1<c r="E4"><f>${formula}</f><v>34</v></c>$2`));
  fs.writeFileSync(file, writeZip(zip));
  const folder = path.dirname(file);
  execFileSync(soffice, [
    `-env:UserInstallation=file://${folder}/conversion`, '--headless', '--convert-to', extension,
    '--outdir', folder, file,
  ], { stdio: 'ignore', timeout: 20_000 });
  return path.join(folder, `log.${extension}`);
}

describe.skipIf(!has)('formula cells in other workbook formats', () => {
  for (const extension of ['xls'] as const) {
    it(`refuses a formula overwrite in .${extension}, while ordinary cells remain writable`, async () => {
      const file = formulaLog(extension);
      const before = fs.readFileSync(file);
      const [original] = await lo.sheets!(file, false, true);
      expect(original.grid[3][4]).toBe('=LEN(B4)');
      const control = await lo.edit!(file, 'Lender Q&A', [
        { kind: 'cell', row: 4, col: 2, value: 'Control answer' },
      ]);
      const output = path.join(tmp(), `control.${extension}`);
      fs.writeFileSync(output, control);
      const [safe, notes] = await lo.sheets!(output, false, true);
      expect(safe.grid[4][2]).toBe('Control answer');
      expect(safe.grid[3][4]).toBe('=LEN(B4)');
      expect(notes.grid).toEqual([['Internal notes']]);
      const refused = lo.edit!(file, 'Lender Q&A', [{ kind: 'cell', row: 3, col: 4, value: 'typed' }]);
      await expect(refused).rejects.toThrow(/formula/i);
      await expect(refused).rejects.toMatchObject({ refused: true });
      const saved = await nodeQaLogs({ convert: lo }).save({
        folder: path.dirname(file), file: path.basename(file), sheet: 'Lender Q&A', stamp: sha256(before),
        steps: [
          { kind: 'rows', after: 2, count: 1 },
          { kind: 'cell', row: 5, col: 2, value: 'Must not persist' },
          { kind: 'cell', row: 4, col: 4, value: 'typed' },
        ],
      });
      expect(!saved.ok && saved.error.kind).toBe('rejected');
      expect(fs.existsSync(path.join(path.dirname(file), '01. Archive'))).toBe(false);
      expect(fs.readFileSync(file)).toEqual(before);
    }, 30_000);
  }
});

describe.skipIf(!has)('inserting rows into other workbook formats', () => {
  for (const extension of ['xls'] as const) {
    it(`preserves a legitimate formula-reference adjustment when inserting a row in .${extension}`, async () => {
      const file = formulaLog(extension, 'LEN(B5)');
      const before = fs.readFileSync(file);
      const [had] = await lo.sheets!(file);
      const saved = await nodeQaLogs({ convert: lo }).save({
        folder: path.dirname(file), file: path.basename(file), sheet: 'Lender Q&A', stamp: sha256(before),
        steps: [
          { kind: 'rows', after: 3, count: 1 },
          { kind: 'cell', row: 4, col: 0, value: 3 },
          { kind: 'cell', row: 4, col: 1, value: 'New question' },
        ],
      });
      expect(saved, JSON.stringify(saved)).toMatchObject({ ok: true, value: { status: 'written' } });
      const [values, notes] = await lo.sheets!(file);
      const [formulas] = await lo.sheets!(file, false, true);
      expect(formulas.grid[3][4]).toBe('=LEN(B6)');
      expect(values.grid[3][4]).toBe(had.grid[3][4]);
      expect(values.grid[4].slice(0, 2)).toEqual(['3', 'New question']);
      expect(values.grid[5].slice(0, 2)).toEqual(had.grid[4].slice(0, 2));
      expect(notes.grid).toEqual([['Internal notes']]);
      if (!saved.ok || saved.value.status !== 'written') throw new Error(JSON.stringify(saved));
      expect(fs.readFileSync(path.join(path.dirname(file), '01. Archive', saved.value.archive))).toEqual(before);
    }, 30_000);
  }
});

describe('names that also refer to another worksheet', () => {
  const steps = [
    { kind: 'rows', after: 4, count: 1 },
    { kind: 'cell', row: 5, col: 0, value: 3 },
    { kind: 'cell', row: 5, col: 1, value: 'Q three' },
  ] as const;
  for (const [sheet, qualifier] of [
    ['Lender Q&A', "'Lender Q&amp;A'"],
    ["Lender's Q&A", "'Lender''s Q&amp;A'"],
    ["Lender's Q&A", '&apos;Lender&apos;&apos;s Q&amp;A&apos;'],
    ["Lender's Q&A", "'Lender'&apos;s Q&amp;A&apos;"],
    ["Lender's Q&A", "&apos;Lender&apos;'s Q&amp;A'"],
    ['Log', 'Log'],
  ]) {
    it(`grows only that sheet's ranges, preserving scope and quoting: ${qualifier}`, () => {
      const ref = `${qualifier}!$A$4:$A$5`;
      const mixed = `<definedName name="Combined">SUM(${ref},Notes!$B$4:$B$5)</definedName>`;
      const own = `<definedName name="OnlyQa">${ref}</definedName>`;
      const print = `<definedName name="_xlnm.Print_Area" localSheetId="0">${ref}</definedName>`;
      const untouched = [
        '<definedName name="Other" localSheetId="1">Notes!$B$4:$B$5</definedName>',
        `<definedName name="Text">&quot;${ref}&quot;</definedName>`,
        `<definedName name="RawText">"${ref}"</definedName>`,
        `<definedName name="MixedOpen">&quot;${ref}"</definedName>`,
        `<definedName name="MixedClose">"${ref}&quot;</definedName>`,
        `<definedName name="NumericQuote">IF(A1=1,&#34;${ref}&#34;,${ref})</definedName>`,
        `<definedName name="HexQuote">IF(A1=1,&#x22;${ref}&#x22;,${ref})</definedName>`,
        '<definedName name="External">\'[Other.xlsx]Log\'!$A$4:$A$5</definedName>',
        '<definedName name="ThreeD">\'Notes:Log\'!$A$4:$A$5</definedName>',
        '<definedName name="Prefix">NotesLog!$A$4:$A$5</definedName>',
      ].join('');
      const file = namedLog(mixed + own + print + untouched, sheet);
      const before = fs.readFileSync(file);
      const after = editXlsx(before, sheet, [...steps]);
      const workbook = part(after, 'xl/workbook.xml');
      for (const name of [mixed, own, print]) expect(workbook).toContain(name.replace('$A$5', '$A$6'));
      expect(workbook).toContain(untouched);
      expect(part(after, 'xl/worksheets/sheet2.xml')).toBe(part(before, 'xl/worksheets/sheet2.xml'));
      expect(fs.readFileSync(file)).toEqual(before);
    });
  }

  it('leaves the complete name definition unchanged when only a response is edited', () => {
    const file = namedLog('<definedName name="Combined">SUM(\'Lender Q&amp;A\'!A4:A5,Notes!B4:B5)</definedName>');
    const before = fs.readFileSync(file);
    const after = editXlsx(before, 'Lender Q&A', [{ kind: 'cell', row: 4, col: 2, value: 'Confirmed' }]);
    expect(part(after, 'xl/workbook.xml')).toBe(part(before, 'xl/workbook.xml'));
  });

  it.skipIf(!has)('saves and reopens the question, archiving the original workbook byte for byte', async () => {
    const definition = '<definedName name="Combined">SUM(\'Lender Q&amp;A\'!A4:A5,Notes!B4:B5)</definedName>';
    const file = namedLog(definition);
    const before = fs.readFileSync(file);
    const saved = await nodeQaLogs({ convert: lo }).save({
      folder: path.dirname(file), file: path.basename(file), sheet: 'Lender Q&A',
      stamp: sha256(before), steps: [...steps],
    });
    expect(saved.ok && saved.value.status).toBe('written');
    if (!saved.ok || saved.value.status !== 'written') throw new Error(JSON.stringify(saved));
    expect(part(fs.readFileSync(file), 'xl/workbook.xml')).toContain(definition.replace('A4:A5', 'A4:A6'));
    const archive = path.join(path.dirname(file), '01. Archive', saved.value.archive);
    expect(fs.readFileSync(archive)).toEqual(before);
    const [log, notes] = await lo.sheets!(file);
    expect(log.grid[5].slice(0, 2)).toEqual(['3', 'Q three']);
    expect(notes.grid).toEqual([['Internal notes']]);
  }, 60_000);
});

it.skipIf(!has)('keeps a structured-reference column name that resembles a worksheet range', async () => {
  const file = counterpartyLog({ table: true });
  const zip = readZip(fs.readFileSync(file));
  const header = 'Log!$A$4:$A$5';
  const expression = 'SUM(Log[[Log!$A$4:$A$5]])';
  setPart(zip, 'xl/workbook.xml', partText(zip, 'xl/workbook.xml')!
    .replace('name="Lender Q&amp;A"', 'name="Log"')
    .replace('</workbook>', '<definedNames><definedName name="Probe">'
      + `${expression}</definedName></definedNames><calcPr fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`));
  setPart(zip, 'xl/tables/table1.xml', partText(zip, 'xl/tables/table1.xml')!
    .replace('name="No."', `name="${header}"`));
  setPart(zip, 'xl/worksheets/sheet1.xml', partText(zip, 'xl/worksheets/sheet1.xml')!
    .replace('No.</t>', `${header}</t>`)
    .replace(/(<row r="1">[\s\S]*?)(<\/row>)/, '$1<c r="F1"><f>Probe</f><v>0</v></c>$2'));
  const before = writeZip(zip);
  fs.writeFileSync(file, before);
  const [valid] = await lo.sheets!(file);
  expect(valid.grid[0][5]).toBe('3'); // Recalculated from the table, rather than the deliberately wrong cached zero.
  const bytes = editXlsx(before, 'Log', [
    { kind: 'rows', after: 4, count: 1 },
    { kind: 'cell', row: 5, col: 0, value: 3 },
    { kind: 'cell', row: 5, col: 1, value: 'New question' },
  ]);
  expect(part(bytes, 'xl/workbook.xml')).toBe(part(before, 'xl/workbook.xml'));
  const output = path.join(tmp(), 'structured.xlsx');
  fs.writeFileSync(output, bytes);
  const [after] = await lo.sheets!(output);
  expect(after.grid[0][5]).toBe('6');
  expect(part(bytes, 'xl/tables/table1.xml')).toContain(`name="${header}"`);
  expect(fs.readFileSync(file)).toEqual(Buffer.from(before));
}, 30_000);

describe('the edit job', () => {
  it('escapes line breaks, tabs and backslashes, so one step stays on one line', () => {
    expect(editJob('file:///a.xlsx', 'Q&A\tlog', [{ kind: 'rows', after: 4, count: 2 }, { kind: 'cell', row: 5, col: 0, value: 3 }, { kind: 'cell', row: 5, col: 1, value: 'Two\r\nlines \\ a\ttab' }]))
      .toBe('file:///a.xlsx\nQ&A\\tlog\nR\t4\t2\nN\t5\t0\t3\nS\t5\t1\tTwo\\nlines \\\\ a\\ttab\n');
  });
});

function fillCellAndAddRow(file: string) {
  return lo.edit!(file, 'Lender Q&A', [
    { kind: 'cell', row: 4, col: 2, value: 'Fabrikam Construction, under a\nfixed-price contract' },
    { kind: 'rows', after: 4, count: 1 },
    { kind: 'cell', row: 5, col: 0, value: 3 },
    { kind: 'cell', row: 5, col: 1, value: 'Is there a tax equity investor?' },
    { kind: 'cell', row: 5, col: 3, value: 'Open' },
  ]);
}

describe.skipIf(!has)('writing into a Q&A log', () => {
  it('fills a cell and adds a row like the one above, keeping the title, header, colors, rule and sheets', async () => {
    const f = counterpartyLog(); const before = fs.readFileSync(f);
    const bytes = await fillCellAndAddRow(f);
    expect(fs.readFileSync(f).equals(before)).toBe(true);                                // the person's file is untouched: the edit is made on a copy
    const out = path.join(tmp(), 'out.xlsx'); fs.writeFileSync(out, bytes);
    const [log, notes] = await lo.sheets!(out);
    expect(log.name).toBe('Lender Q&A'); expect(notes).toMatchObject({ name: 'Notes', grid: [['Internal notes']] });
    expect(log.grid.slice(2)).toEqual([
      ['No.', 'Question', 'Sponsor response', 'Status'],
      ['1', 'What is the minimum DSCR covenant?', '1.20x', 'Closed'],
      ['2', 'Who is the EPC contractor?', 'Fabrikam Construction, under a\nfixed-price contract', 'Open'],
      ['3', 'Is there a tax equity investor?', '', 'Open'],
    ]);
    const xml = part(bytes, 'xl/worksheets/sheet1.xml'); const styles = part(bytes, 'xl/styles.xml');
    expect(xml).toContain('<mergeCell ref="A1:D1"/>'); expect(xml).toMatch(/state="frozen"/);
    expect(xml).toMatch(/conditionalFormatting sqref="D4:D201"/);                         // the rule grows with the new row
    expect(styles).toContain('FF1F3864'); expect(styles).toContain('FFFFF2CC');
    expect(styleOf(xml, 'B6')).toBe(styleOf(xml, 'B5')); expect(styleOf(xml, 'D6')).toBe(styleOf(xml, 'D5'));   // the new row takes the shading of the row above (a cell given two lines also wraps, so C5's style differs)
    expect(styleOf(xml, 'B3')).not.toBe(styleOf(xml, 'B5'));
  }, 60_000);

  it.skipIf(!hasMetricFont('Calibri'))('keeps the column widths (requires Calibri or Carlito)', async () => {
    const bytes = await fillCellAndAddRow(counterpartyLog());
    const xml = part(bytes, 'xl/worksheets/sheet1.xml');
    expect(xml).toMatch(/<col [^>]*max="3" min="2"[^>]*width="50"|<col [^>]*min="2"[^>]*max="3"[^>]*width="50"/);
  }, 60_000);
});

describe.skipIf(!has)('writing into a Q&A log of another kind', () => {
  const keeps = (ext: string) => `keeps a .${ext} a .${ext}, with the new values and its other sheet`;
  for (const ext of ['xls', 'xlsm']) it(keeps(ext), async () => {
    const x = counterpartyLog(); const dir = path.dirname(x);
    execFileSync(soffice, [`-env:UserInstallation=file://${dir}/p`, '--headless', '--convert-to', ext, '--outdir', dir, x], { stdio: 'ignore' });
    const f = path.join(dir, `log.${ext}`);
    const bytes = await lo.edit!(f, 'Lender Q&A', [
      { kind: 'cell', row: 4, col: 2, value: 'Fabrikam' },
      { kind: 'rows', after: 4, count: 1 },
      { kind: 'cell', row: 5, col: 0, value: 3 },
      { kind: 'cell', row: 5, col: 1, value: 'Is there a tax equity investor?' },
    ]);
    const out = path.join(tmp(), `out.${ext}`); fs.writeFileSync(out, bytes);
    const kind = execFileSync('file', ['-b', out], { encoding: 'utf8' });
    expect(kind).toMatch(ext === 'xls' ? /Excel|Composite Document/ : /Zip|Excel|OOXML/);
    const [log, notes] = await lo.sheets!(out);
    expect(notes.name).toBe('Notes');
    expect(log.grid.slice(3)).toEqual([
      ['1', 'What is the minimum DSCR covenant?', '1.20x', 'Closed'],
      ['2', 'Who is the EPC contractor?', 'Fabrikam', 'Open'],
      ['3', 'Is there a tax equity investor?', '', ''],
    ]);
  }, 60_000);
});

describe('writing into an .xlsx by editing the file itself', () => {
  const steps = [
    { kind: 'cell', row: 4, col: 2, value: 'Fabrikam & partners, under a\nfixed-price contract' },
    { kind: 'rows', after: 4, count: 1 },
    { kind: 'cell', row: 5, col: 0, value: 3 }, { kind: 'cell', row: 5, col: 1, value: 'Is there a tax equity investor?' }, { kind: 'cell', row: 5, col: 3, value: 'Open' },
  ] as const;
  it('changes only the sheet written into and its table: every other part is the same, byte for byte', () => {
    const before = readZip(fs.readFileSync(counterpartyLog({ table: true }))); const after = readZip(editXlsx(fs.readFileSync(counterpartyLog({ table: true })), 'Lender Q&A', [...steps]));
    expect(after.entries.map((e) => e.name)).toEqual(before.entries.map((e) => e.name));
    for (const e of before.entries) if (!['xl/worksheets/sheet1.xml', 'xl/tables/table1.xml'].includes(e.name)) expect(Buffer.from(after.entries.find((x) => x.name === e.name)!.data).equals(Buffer.from(e.data))).toBe(true);
    const table = partText(after, 'xl/tables/table1.xml')!;
    expect(table).toContain('ref="A3:D6"'); expect(table).toContain('<autoFilter ref="A3:D6"/>'); expect(table).toContain('<tableStyleInfo name="TableStyleMedium2"');   // the table takes in the new row and keeps its look
    const xml = partText(after, 'xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('<row r="6"><c r="A6" s="2"><v>3</v></c><c r="B6" s="2" t="inlineStr"><is><t xml:space="preserve">Is there a tax equity investor?</t></is></c><c r="C6" s="2"/><c r="D6" s="2" t="inlineStr">');
    expect(xml).toContain(
      '<c r="C5" s="2" t="inlineStr"><is><t ' +
        'xml:space="preserve">Fabrikam &amp; partners, under a\nfixed-price contract</t></is></c>',
    );
    expect(xml).toContain('<conditionalFormatting sqref="D4:D200">');                 // a rule that already reached past the table is left as it was
    const was = partText(before, 'xl/worksheets/sheet1.xml')!;
    expect(xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, '')).toBe(was.replace(/<sheetData>[\s\S]*<\/sheetData>/, ''));   // nothing outside the cells changed
    expect(xml).toContain(was.match(/<row r="1">[\s\S]*?<\/row>/)![0]); expect(xml).toContain(was.match(/<row r="4">[\s\S]*?<\/row>/)![0]);   // rows not written into are as they were
  });
  it('will not write over a row that has something in it', () => {
    expect(() => editXlsx(fs.readFileSync(counterpartyLog()), 'Lender Q&A', [{ kind: 'rows', after: 3, count: 1 }])).toThrow('row 5 of the sheet is not empty');
  });
  it.skipIf(!has)('makes a file LibreOffice reads with the new values', async () => {
    const out = path.join(tmp(), 'out.xlsx'); fs.writeFileSync(out, editXlsx(fs.readFileSync(counterpartyLog({ table: true })), 'Lender Q&A', [...steps]));
    const [log, notes] = await lo.sheets!(out);
    expect(notes.grid).toEqual([['Internal notes']]);
    expect(log.grid.slice(3)).toEqual([
      ['1', 'What is the minimum DSCR covenant?', '1.20x', 'Closed'],
      ['2', 'Who is the EPC contractor?', 'Fabrikam & partners, under a\nfixed-price contract', 'Open'],
      ['3', 'Is there a tax equity investor?', '', 'Open'],
    ]);
  }, 60_000);
});

describe('which way a log is written', () => {
  it('edits an .xlsx directly and a CSV as text, and never writes to the file given', async () => {
    const x = counterpartyLog({ table: true }); const before = fs.readFileSync(x);
    const out = await editLog(lo, x, 'Lender Q&A', [{ kind: 'cell', row: 4, col: 2, value: 'Fabrikam' }]);
    expect(fs.readFileSync(x).equals(before)).toBe(true);
    expect(partText(readZip(out), 'xl/tables/table1.xml')).toBe(partText(readZip(before), 'xl/tables/table1.xml'));   // only LibreOffice would have rewritten the table part
    const c = path.join(tmp(), 'log.csv'); fs.writeFileSync(c, new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from('No.,Question,Response\r\n1,DSCR?,\r\n')]));
    expect(Buffer.from(await editLog(lo, c, 'Sheet1', [{ kind: 'cell', row: 1, col: 2, value: '1.20x' }])).toString('utf8')).toBe('﻿No.,Question,Response\r\n1,DSCR?,1.20x\r\n');
  });
});

describe.skipIf(!has)('updating a log where it is', () => {
  const setup = () => { const folder = tmp(); fs.mkdirSync(path.join(folder, 'Old versions')); fs.copyFileSync(counterpartyLog({ table: true }), path.join(folder, 'Lender A Q&A.xlsx')); return { folder, logs: nodeQaLogs({ convert: lo, now: () => new Date(2026, 10, 15, 16, 12) }) }; };
  const steps = [{ kind: 'cell' as const, row: 4, col: 2, value: 'Fabrikam' }];
  it('reads the file as it is, writes into it in place, archives the version it replaced, and checks the new file reads as meant', async () => {
    const { folder, logs } = setup(); const at = { folder, file: 'Lender A Q&A.xlsx' }; const before = fs.readFileSync(path.join(folder, at.file));
    const t = await logs.read(at, { sheet: 'Lender Q&A', headerRow: 3 }); if (!t.ok) throw new Error(t.error.message);
    const r = await logs.save({ ...at, sheet: 'Lender Q&A', steps, stamp: t.value.stamp });
    expect(r).toEqual({ ok: true, value: { status: 'written', archive: 'Lender A Q&A 2026-11-15 1612.xlsx' } });
    expect(fs.readdirSync(folder).sort()).toEqual(['Lender A Q&A.xlsx', 'Old versions']);
    expect(fs.readFileSync(path.join(folder, 'Old versions', 'Lender A Q&A 2026-11-15 1612.xlsx')).equals(before)).toBe(true);
    const [log] = await lo.sheets!(path.join(folder, at.file));
    expect(log.grid[4]).toEqual(['2', 'Who is the EPC contractor?', 'Fabrikam', 'Open']);
    // a save from what was read before someone else's save writes nothing
    expect(await logs.save({ ...at, sheet: 'Lender Q&A', steps, stamp: t.value.stamp })).toEqual({ ok: true, value: { status: 'later' } });
  }, 60_000);
  it('says so when the log is not where it was', async () => {
    const { folder, logs } = setup();
    expect(await logs.read({ folder, file: 'Gone.xlsx' }, { sheet: 'Lender Q&A', headerRow: 3 })).toMatchObject({ ok: false, error: { kind: 'notFound' } });
    expect(await logs.save({ folder: path.join(folder, 'gone'), file: 'Lender A Q&A.xlsx', sheet: 'Lender Q&A', steps, stamp: 'x' })).toMatchObject({ ok: false, error: { kind: 'notFound' } });
  });
});

describe('a log that is not an Excel or CSV file', () => {
  it('refuses an OpenDocument log without touching it', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-ods-'));
    fs.writeFileSync(path.join(folder, 'Lender A Q&A.ods'), 'a log');
    const saved = await nodeQaLogs({}).save({ folder, file: 'Lender A Q&A.ods', sheet: 'Q&A', stamp: '', steps: [] });
    expect(!saved.ok && saved.error.message).toBe('Only .xlsx, .xlsm, .xls and .csv logs can be updated');
    expect(fs.readFileSync(path.join(folder, 'Lender A Q&A.ods'), 'utf8')).toBe('a log');
    fs.rmSync(folder, { recursive: true, force: true });
  });
});
