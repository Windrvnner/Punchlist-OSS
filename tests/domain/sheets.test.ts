import { describe, it, expect } from 'vitest';
import { cellsAsShown } from '../../src/domain/sheets';

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
