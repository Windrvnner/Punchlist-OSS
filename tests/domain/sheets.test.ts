import { describe, it, expect } from 'vitest';
import { cellsAsShown, parseCsv, withSteps } from '../../src/domain/sheets';
import { editCsv } from '../../src/domain/csvEdit';

describe('cellsAsShown', () => {
  const plain = [{ name: 'Log', grid: [['1234.5', '2026-11-02', '2026-11-02 09:30:00', '0.15', '']] }];
  const shown = [{ name: 'Log', grid: [['1,234.50', '2-Nov-26', '2-Nov-26 9:30 AM', '15%', '']] }];

  it('takes a number as the file shows it and leaves a real date cell as plain', () => {
    expect(cellsAsShown(plain, shown)[0].grid).toEqual([['1,234.50', '2026-11-02', '2026-11-02 09:30:00', '15%', '']]);
  });

  it('keeps the plain cell where the shown reading has no cell to match it', () => {
    expect(cellsAsShown(plain, [{ name: 'Other', grid: [] }])).toEqual(plain);
    expect(cellsAsShown(plain, [{ name: 'Log', grid: [['9']] }])[0].grid[0].slice(0, 2)).toEqual(['9', '2026-11-02']);
  });
});

describe('a line break inside a cell', () => {
  const cells = ['One\r\ntwo', 'Three\rfour', 'Five\nsix\r\n'];

  it('is read from a CSV as the file writes it, CR, CRLF and LF alike', () => {
    expect(parseCsv(`${cells.map((c) => `"${c}"`).join(',')}\r\n`)).toEqual([cells]);
  });

  it('is kept as given by an edit of a sheet', () => {
    const edited = withSteps([{ name: 'Log', grid: [['']] }], 'Log', [{ kind: 'cell', row: 0, col: 0, value: cells[0] }]);
    expect(edited?.[0].grid).toEqual([[cells[0]]]);
  });

  it('is written into a CSV quoted, and reads back as given', () => {
    const steps = cells.map((value, col) => ({ kind: 'cell' as const, row: 1, col, value }));
    const written = editCsv('A,B,C\r\n,,\r\n', steps);
    expect(parseCsv(written)).toEqual([['A', 'B', 'C'], cells]);
  });
});
