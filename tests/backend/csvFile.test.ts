// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CsvCells } from '../../src/domain/csvCells';
import { parseCsv } from '../../src/domain/sheets';
import { eachCsvCell } from '../../src/backend/csvFile';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
const write = (name: string, bytes: Uint8Array | string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-'));
  roots.push(dir);
  fs.writeFileSync(path.join(dir, name), bytes);
  return path.join(dir, name);
};
const cellsOf = async (at: string) => {
  const cells: string[] = [];
  await eachCsvCell(at, (cell) => cells.push(cell));
  return cells;
};

describe('a CSV read a piece at a time', () => {
  it('splits quotes, doubled quotes and line breaks as it always has, wherever the text is cut into pieces', () => {
    // the rows `parseCsv` gave before it ran on the same splitter as the file reader (checked over 200,000 texts)
    const text = 'a,"b ""quoted"", with a comma",c\r\n"two\r\nlines",,\n"x"';
    const rows = [['a', 'b "quoted", with a comma', 'c'], ['two\nlines', '', ''], ['x']];
    expect(parseCsv(text)).toEqual(rows);
    expect(parseCsv('"a""",b\r"c"')).toEqual([['a"', 'b'], ['c']]);
    expect(parseCsv('a,"b"', (field) => field.toUpperCase())).toEqual([['A', 'b']]);
    for (let cut = 0; cut <= text.length; cut++) {
      const got: string[][] = [];
      let row: string[] = [];
      const cells = new CsvCells(
        (cell) => row.push(cell),
        () => {
          got.push(row);
          row = [];
        },
      );
      cells.push(text.slice(0, cut));
      cells.push(text.slice(cut));
      cells.end();
      expect(got).toEqual(rows);
    }
  });

  it('reads a file larger than one piece, with a character that spans two pieces, in its own encoding', async () => {
    const row = 'ledger,é\n';
    const utf8 = write('big.csv', row.repeat(500_000));      // about 5 MB, and é is two bytes
    const cells = await cellsOf(utf8);
    expect(cells.length).toBe(1_000_000);
    expect(new Set(cells)).toEqual(new Set(['ledger', 'é']));
    const windows = write('win.csv', Buffer.from('Société,Crédit\n'.repeat(100_000), 'latin1'));
    expect(new Set(await cellsOf(windows))).toEqual(new Set(['Société', 'Crédit']));
    const mark = Buffer.from([0xff, 0xfe]);
    const utf16 = write('wide.csv', Buffer.concat([mark, Buffer.from('Société,Crédit\n', 'utf16le')]));
    expect(await cellsOf(utf16)).toEqual(['Société', 'Crédit']);
  });

  it('holds only a piece of the file in memory, however large the file is', async () => {
    const at = write('huge.csv', 'ledger,entry\n'.repeat(8_000_000));      // about 104 MB
    global.gc?.();
    const before = process.memoryUsage().rss;
    let count = 0;
    await eachCsvCell(at, () => count++);
    expect(count).toBe(16_000_000);
    expect(process.memoryUsage().rss - before).toBeLessThan(80 * 1024 * 1024);
  }, 120_000);
});
