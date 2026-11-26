// A due diligence log rarely starts in cell A1: there is a title, some padding, sometimes a cover sheet.
import { describe, it, expect } from 'vitest';
import { readCsv } from '../../src/adapters/spreadsheet';
import { tableFrom, type Sheet } from '../../src/domain/sheets';
import { findHeaderRow, suggestMapping, prepareImport } from '../../src/domain/importExport';

const LOG = [['#', 'Question', 'Response', 'Status'], [1, 'First question', '', ''], [2, 'Second question', 'Yes', 'Answered']];
/** sheets as LibreOffice gives them (each a grid of text from A1), with blocks of cells placed at their top-left cell */
function book(sheets: Record<string, { cells: any[][]; origin: string }[]>): Sheet[] {
  return Object.entries(sheets).map(([name, parts]) => {
    const grid: string[][] = [];
    for (const p of parts) {
      const m = /^([A-Z]+)(\d+)$/.exec(p.origin)!; const c0 = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1, r0 = +m[2] - 1;
      p.cells.forEach((row, i) => { row.forEach((v, j) => { const r = r0 + i, c = c0 + j; while (grid.length <= r) grid.push([]); while (grid[r].length <= c) grid[r].push(''); grid[r][c] = String(v ?? ''); }); });
    }
    return { name, grid };
  });
}
const read = (src: Sheet[] | Uint8Array, opts?: { sheet?: string; headerRow?: number }) => {
  if (ArrayBuffer.isView(src)) { const r = readCsv(src, opts); if (!r.ok) throw new Error(r.error.message); return r.value; }
  const t = tableFrom(src, opts); if (!t) throw new Error('no rows'); return t;
};

describe('finding where the table starts', () => {
  it('a log that starts at D6 with nothing above it', () => {
    const t = read(book({ Log: [{ cells: LOG, origin: 'D6' }] }));
    expect(t.columns).toEqual(['#', 'Question', 'Response', 'Status']);      // the three empty columns to the left are gone
    expect(t.headerRow).toBe(6); expect(t.lines).toEqual([7, 8]);
    expect(suggestMapping(t.columns)).toMatchObject({ n: 0, text: 1, response: 2, status: 3 });
    expect(prepareImport(t.rows, suggestMapping(t.columns), t.lines).rows.map((r) => [r.n, r.text, r.line])).toEqual([[1, 'First question', 7], [2, 'Second question', 8]]);
  });

  it('a title, a date line and padding above the table, in the same columns or off to the side', () => {
    const above = read(book({ Log: [{ cells: [['Project Proseware: lender Q&A log'], [], ['Prepared November 9, 2026']], origin: 'D2' }, { cells: LOG, origin: 'D6' }] }));
    const corner = read(book({ Log: [{ cells: [['Project Proseware: lender Q&A log']], origin: 'A1' }, { cells: LOG, origin: 'D6' }] }));
    for (const t of [above, corner]) {
      expect(t.columns).toEqual(['#', 'Question', 'Response', 'Status']);
      expect(t.headerRow).toBe(6);
      expect(t.rows.map((r) => r[1])).toEqual(['First question', 'Second question']);   // the title is not a question, nor is the heading row
    }
  });

  it('a cover sheet first: the sheet with the log is chosen, and the others are offered', () => {
    const bytes = book({ Cover: [{ cells: [['Project Proseware'], ['Strictly confidential']], origin: 'B3' }], 'Q&A': [{ cells: LOG, origin: 'B4' }], Notes: [{ cells: [['x', 'y'], ['1', '2']], origin: 'A1' }] });
    const t = read(bytes);
    expect(t.sheets).toEqual(['Cover', 'Q&A', 'Notes']); expect(t.sheet).toBe('Q&A'); expect(t.headerRow).toBe(4);
    const notes = read(bytes, { sheet: 'Notes' });
    expect(notes.sheet).toBe('Notes'); expect(notes.columns).toEqual(['x', 'y']); expect(notes.headerRow).toBe(1);
  });

  it('the person can name the heading row when the guess is wrong, or when the headings are in words we do not know', () => {
    const odd = [['Ref', 'Lender query', 'Sponsor reply'], ['A1', 'Is the EPC wrap fixed price?', 'Yes']];
    const bytes = book({ Log: [{ cells: [['Queries', 'for', 'the sponsor']], origin: 'A1' }, { cells: odd, origin: 'A4' }] });
    const guess = read(bytes);
    // nothing recognizable: the first row
    expect(guess.headerRow).toBe(1);
    const said = read(bytes, { headerRow: 4 });
    expect(said.columns).toEqual(['Ref', 'Lender query', 'Sponsor reply']); expect(said.rows).toEqual([['A1', 'Is the EPC wrap fixed price?', 'Yes']]); expect(said.lines).toEqual([5]);
    expect(read(bytes, { headerRow: 999 }).headerRow).toBe(5);               // out of range lands on the last row, not an error
  });

  it('a CSV with title lines above the headings', () => {
    const csv = new TextEncoder().encode('Project Proseware Q&A log\n\n#,Question,Response\n1,First question,\n2,Second question,Yes\n');
    const t = read(csv);
    expect(t.headerRow).toBe(3); expect(t.columns).toEqual(['#', 'Question', 'Response']); expect(t.lines).toEqual([4, 5]);
  });

  it('an ordinary file is read as before, and a one-column file keeps its first row as the heading', () => {
    const plain = read(new TextEncoder().encode('Number,Question\n1,First\n'));
    expect([plain.headerRow, plain.columns, plain.rows, plain.lines]).toEqual([1, ['Number', 'Question'], [['1', 'First']], [2]]);
    const one = read(new TextEncoder().encode('Question\nFrom the other tab\n'));
    expect([one.headerRow, one.columns, one.rows]).toEqual([1, ['Question'], [['From the other tab']]]);
    expect(findHeaderRow([['just a title'], ['a', 'b'], ['1', '2']])).toBe(0);
    expect(findHeaderRow([['only'], ['one'], ['column']])).toBe(0);
  });

  it('the heading row is found wherever it is, even past row 50 of a long sheet', () => {
    const padding = Array.from({ length: 59 }, (_, i) => [`Padding line ${i + 1}`, '']);
    const longLog = [...padding, ['#', 'Question', 'Response', 'Status'], ['1', 'First question', '', '']];
    expect(findHeaderRow(longLog)).toBe(59);
    expect(read(book({ Log: [{ cells: longLog, origin: 'A1' }] })).headerRow).toBe(60);
  });

  it('with no known heading anywhere, the first row is the guess, even when a later row has two filled cells', () => {
    const noHeading = [['just a title', ''], ['', ''], ['x', 'y'], ['1', '2']];
    expect(findHeaderRow(noHeading)).toBe(0);
  });
});
