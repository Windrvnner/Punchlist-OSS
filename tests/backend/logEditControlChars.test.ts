// A response holding a character XML 1.0 cannot carry is written as Excel's own _xHHHH_ code
// and reads back as the value (#1149).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { libreOfficeConverter } from '../../src/backend/convert';
import { editXlsx } from '../../src/backend/xlsxEdit';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { readZip, partText } from '../../src/backend/zipParts';
import { sha256 } from '../../src/backend/qaLogFolder';
import { exportDocument } from '../../src/domain/sheets';
import { cachedWorkbook } from './workbookCache';
import { hasOffice as has, soffice } from './officePrerequisites';

const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-ctl-test-lo-')) });
const workbook = cachedWorkbook(lo);
const SHEET = 'Q&A log';
const rows = [['No.', 'Question', 'Response'], [1, 'Is there a lender?', ''], [2, 'Who is the EPC?', '']];

/** a log in a new folder, saved through the app's own save with `value` as the response to question 1 */
async function saveResponse(value: string) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-ctl-test-'));
  const file = path.join(folder, 'log.xlsx');
  fs.writeFileSync(file, await workbook(exportDocument(SHEET, rows)));
  const saved = await nodeQaLogs({ convert: lo }).save({
    folder, file: 'log.xlsx', sheet: SHEET, stamp: sha256(fs.readFileSync(file)),
    steps: [{ kind: 'cell', row: 1, col: 2, value }],
  });
  const [log] = await lo.sheets!(file);
  const sheetXml = partText(readZip(fs.readFileSync(file)), 'xl/worksheets/sheet1.xml')!;
  return { saved, cell: log.grid[1][2], sheetXml };
}

describe.skipIf(!has)('a response with a control character, saved through the log save', () => {
  it('keeps a manual line break (U+000B) and the save succeeds', async () => {
    const r = await saveResponse('line one\u000bline two');
    expect(r.saved).toMatchObject({ ok: true, value: { status: 'written' } });
    expect(r.cell).toBe('line one\u000bline two');
  }, 60_000);
  it('keeps other characters XML cannot carry', async () => {
    const value = 'a\u0001b\u0008c\u000cd\u001fe';
    const r = await saveResponse(value);
    expect(r.saved).toMatchObject({ ok: true, value: { status: 'written' } });
    expect(r.cell).toBe(value);
  }, 60_000);
  it('keeps text that looks like an Excel code as typed', async () => {
    const r = await saveResponse('see _x000B_ here');
    expect(r.saved).toMatchObject({ ok: true, value: { status: 'written' } });
    expect(r.cell).toBe('see _x000B_ here');
  }, 60_000);
  it('writes each one as its _xHHHH_ code and a literal code as _x005F_', async () => {
    const r = await saveResponse('a\u000bb\u0001c\ufffed _x000B_ plain');
    expect(r.sheetXml).toContain('a_x000B_b_x0001_c_xFFFE_d _x005F_x000B_ plain');
  }, 60_000);
  it('leaves plain text as it is', async () => {
    const r = await saveResponse('Fabrikam & Co <ok>');
    expect(r.saved).toMatchObject({ ok: true, value: { status: 'written' } });
    expect(r.cell).toBe('Fabrikam & Co <ok>');
    expect(r.sheetXml).toContain('Fabrikam &amp; Co &lt;ok&gt;');
  }, 60_000);
});
