import { describe, expect, it } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { libreOfficeConverter } from '../../src/backend/convert';
import { editXlsx } from '../../src/backend/xlsxEdit';
import { hasOffice as has, soffice } from './officePrerequisites';
import { gridOf, xlsxOf } from './miniXlsx';

const rows = [['No.', 'Question', 'Response'], ['1', 'DSCR & "x" <y>?', ''], ['2', 'Line\nbreak', 'a']];

describe('the hand-made workbook the log tests use', () => {
  it('holds its cells as written, and as the app edits them', async () => {
    expect(gridOf(xlsxOf(rows))).toEqual([['No.', 'Question', 'Response'], ['1', 'DSCR & "x" <y>?'], ['2', 'Line\nbreak', 'a']]);
    const edited = await editXlsx(xlsxOf(rows), 'Sheet1', [{ kind: 'cell', row: 1, col: 2, value: '1.20x' }]);
    expect(gridOf(edited)[1]).toEqual(['1', 'DSCR & "x" <y>?', '1.20x']);
  });

  it.skipIf(!has)('reads in LibreOffice the same', async () => {
    const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-mini-lo-')) });
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-mini-')), 'a.xlsx'); fs.writeFileSync(file, xlsxOf(rows));
    expect((await lo.sheets!(file))[0].grid).toEqual([['No.', 'Question', 'Response'], ['1', 'DSCR & "x" <y>?', ''], ['2', 'Line\nbreak', 'a']]);
  }, 60_000);
});
