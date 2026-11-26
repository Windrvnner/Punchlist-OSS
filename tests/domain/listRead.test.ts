import { describe, it, expect } from 'vitest';
import {
  fillUnplaced, tieOut, unplaced, tableLines, textLines, type LineRead, type ListCells, type ListReading, type TiedOut,
} from '../../src/domain/listRead';

const reading = (rs: LineRead[], cells?: ListCells): ListReading =>
  ({ reads: new Map(rs.map((r) => [r.n, r])), ...(cells ? { cells } : {}) });
const kinds = (pairs: [number, LineRead['k']][]): LineRead[] => pairs.map(([n, k]) => ({ n, k }));
/** every line accounted for: the counts add up to the number of lines */
const addsUp = ({ count: c }: TiedOut) => c.items + c.more + c.headings + c.blank + c.left === c.lines;
const LINES = textLines([
  'Proseware Solar checklist', '', '1. Site', '   1.1  Title report for the whole site',
  '   1.2  Leases cover the array and the', '        gen-tie route', 'Page 2 of 6', '2. Permits',
  '   2.1  Conditional use permit issued',
].join('\r\n'));
const READ = kinds([[1, 'left'], [3, 'section'], [4, 'item'], [5, 'item'], [6, 'more'], [7, 'left'], [8, 'section'],
  [9, 'item']]);

describe('a list read whole by the model, tied out line by line', () => {
  it('accounts for every line, joins a wrapped item, and keeps each item under its heading', () => {
    const t = tieOut(LINES, reading(READ));
    expect(t.items.map((i) => [i.section, i.text, i.lines])).toEqual([
      ['1. Site', '   1.1  Title report for the whole site', [4]],
      ['1. Site', '   1.2  Leases cover the array and the         gen-tie route', [5, 6]],
      ['2. Permits', '   2.1  Conditional use permit issued', [9]]]);
    expect(t.left).toEqual([1, 7]);
    expect(addsUp(t)).toBe(true);
    expect(t.count).toEqual({ lines: 9, items: 3, more: 1, headings: 2, blank: 1, left: 2 });
  });

  it('leaves out a line the model did not name, and asks about it again', () => {
    const r = reading(READ.filter((x) => x.n !== 4 && x.n !== 9));
    expect(unplaced(LINES, r)).toEqual([4, 9]);
    const t = tieOut(LINES, r);
    expect(t.left).toEqual([1, 4, 7, 9]);
    // the wrapped line of the next item still joins its own item, not one before it
    expect(t.items.map((i) => i.text)).toEqual(['   1.2  Leases cover the array and the         gen-tie route']);
    expect(addsUp(t)).toBe(true);
  });

  it('words an item and a heading as its line is written, edge spaces and tabs included (#1215)', () => {
    const lines = ['\tPermits  ', '  Item one \t', '\tand more  '];
    const t = tieOut(lines, reading(kinds([[1, 'section'], [2, 'item'], [3, 'more']])));
    expect(t.items).toEqual([{ section: '\tPermits  ', text: '  Item one \t \tand more  ', lines: [2, 3] }]);
  });

  it('keeps a text line\'s own backslashes and pipes even when the model names columns for it', () => {
    const lines = ['Check C:\\dir and a\\|b', 'Second'];
    const cells = { item: 1 };
    const t = tieOut(lines, reading(kinds([[1, 'item'], [2, 'item']]), cells));
    expect(t.items.map((i) => i.text)).toEqual(lines);
  });

  it('never joins a "more" line to an item across a heading', () => {
    const t = tieOut(['A', 'Item one', 'B', 'rest'], reading(kinds([[1, 'section'], [2, 'item'], [3, 'section'],
      [4, 'more']])));
    expect(t.items.map((i) => i.text)).toEqual(['Item one']);
    expect(t.left).toEqual([4]);
  });

  it('brings a checked line in where it sits, with its own words, under the heading above it', () => {
    const t = tieOut(LINES, reading(READ), new Set([7]));
    expect(t.left).toEqual([1]);
    expect(t.items.map((i) => [i.section, i.text])).toContainEqual(['1. Site', 'Page 2 of 6']);
    expect(t.items.findIndex((i) => i.text === 'Page 2 of 6')).toBe(2);
    // a line brought in comes in exactly as written: bullets, list numbers and figures stay
    const given = ['*  Independent engineer engaged', '1.4) Survey', '2 years of audited accounts', '10. Board minutes'];
    expect(tieOut(given, reading([]), new Set([1, 2, 3, 4])).items.map((i) => i.text)).toEqual(given);
  });

  it('reads a table row from the columns the model names, and the heading row as a heading', () => {
    const rows = [['Interconnection', 'Network upgrade costs  capped'], ['Land', 'Site control covers the array']];
    const lines = tableLines(['Area', 'Requirement'], rows);
    expect(lines[1]).toBe('Interconnection | Network upgrade costs  capped');   // the cell's own spacing stays
    const t = tieOut(lines, reading(kinds([[1, 'columns'], [2, 'item'], [3, 'item']]), { item: 2, section: 1 }));
    expect(t.items.map((i) => [i.section, i.text])).toEqual(rows);
    expect(t.count.headings).toBe(1);
  });

  it('carries a table row\'s section and subsection to the rows under it, as a section filled in once is', () => {
    const lines = tableLines(['Section', 'Sub-section', 'Item'], [['Finance', 'Model', 'The model is audited'],
      ['', '', 'Reserves are funded'], ['', 'Funding', 'Equity is committed'],
      ['Legal', '', 'Approvals are in place']]);
    const read = kinds([[1, 'columns'], [2, 'item'], [3, 'item'], [4, 'item'], [5, 'item']]);
    const t = tieOut(lines, reading(read, { item: 3, section: 1, subsection: 2 }));
    expect(t.items.map((i) => [i.section, i.subsection, i.text])).toEqual([
      ['Finance', 'Model', 'The model is audited'], ['Finance', 'Model', 'Reserves are funded'],
      ['Finance', 'Funding', 'Equity is committed'], ['Legal', undefined, 'Approvals are in place']]);
  });

  it('takes a table row read as a heading from the heading column the model names, as written', () => {
    const lines = tableLines(['No', 'Description', 'Notes'], [['A', 'Site and  real estate', ''],
      ['1', 'Title report', ''], ['B', 'Permits', ''], ['2', 'Air permit', 'Renewed yearly']]);
    const read = kinds([[1, 'columns'], [2, 'section'], [3, 'item'], [4, 'section'], [5, 'item']]);
    const t = tieOut(lines, reading(read, { item: 2, heading: 2 }));
    expect(t.items.map((i) => [i.section, i.text])).toEqual([['Site and  real estate', 'Title report'],
      ['Permits', 'Air permit']]);
    // with no heading column named, a heading row has no words to take and is left out
    expect(unplaced(lines, reading(read, { item: 2 }))).toEqual([2, 4]);
  });

  it('takes section and subsection rows from the heading and subheading columns the model names', () => {
    const lines = tableLines(['Section', 'Subsection', 'Item'], [['A. Site', '', ''], ['', 'A.1 Real estate', ''],
      ['', '', 'Title report'], ['', 'A.2 Access', ''], ['', '', 'Road agreement']]);
    const read = kinds([[1, 'columns'], [2, 'section'], [3, 'subsection'], [4, 'item'], [5, 'subsection'],
      [6, 'item']]);
    const t = tieOut(lines, reading(read, { item: 3, heading: 1, subheading: 2 }));
    expect(t.items.map((i) => [i.section, i.subsection, i.text])).toEqual([
      ['A. Site', 'A.1 Real estate', 'Title report'], ['A. Site', 'A.2 Access', 'Road agreement']]);
  });

  it('fills a line the first reading left unplaced from the second, with the first reading\'s columns', () => {
    const lines = tableLines(['No', 'Description'], [['A', 'Site'], ['1', 'Title report']]);
    const first = reading(kinds([[1, 'columns'], [3, 'item']]), { item: 2 });
    const filled = fillUnplaced(lines, first, reading(kinds([[1, 'left'], [2, 'item']]), { item: 1 }));
    expect(filled.cells).toEqual({ item: 2 });
    expect(tieOut(lines, filled).items.map((i) => i.text)).toEqual(['Site', 'Title report']);
    expect(unplaced(lines, filled)).toEqual([]);
  });

  it('reads the table from the second reading\'s columns when the first reading named none', () => {
    const lines = tableLines(['No', 'Description'], [['1', 'Site'], ['2', 'Title report']]);
    const first = reading(kinds([[1, 'columns'], [2, 'item'], [3, 'item']]));
    const second = reading(kinds([[1, 'columns'], [2, 'item'], [3, 'item']]), { item: 2 });
    const filled = fillUnplaced(lines, first, second);
    expect(filled.cells).toEqual({ item: 2 });
    expect(tieOut(lines, filled).items.map((i) => i.text)).toEqual(['Site', 'Title report']);
    expect(unplaced(lines, filled)).toEqual([]);
  });

  it('reads the table from the second reading\'s columns when the first reading\'s place no row', () => {
    const lines = tableLines(['No', 'Description'], [['1', 'Site'], ['2', 'Title report']]);
    const first = reading(kinds([[1, 'columns'], [2, 'item'], [3, 'item']]), { item: 5 });
    const second = reading(kinds([[1, 'columns'], [2, 'item'], [3, 'item']]), { item: 2 });
    const filled = fillUnplaced(lines, first, second);
    expect(filled.cells).toEqual({ item: 2 });
    expect(tieOut(lines, filled).items.map((i) => i.text)).toEqual(['Site', 'Title report']);
  });

  it('keeps a cell whole when its own text holds " | " or a backslash, and the columns after it in place', () => {
    const rows = [['1', 'Check Debt | Equity obligations', 'Debt'], ['2', 'Path C:\\\\dir\\| x', 'Equity']];
    const lines = tableLines(['No', 'Requirement', 'Area'], rows);
    const read = kinds([[1, 'columns'], [2, 'item'], [3, 'item']]);
    const t = tieOut(lines, reading(read, { item: 2, section: 3 }));
    expect(t.items.map((i) => [i.section, i.text])).toEqual([
      ['Debt', 'Check Debt | Equity obligations'], ['Equity', 'Path C:\\\\dir\\| x']]);
  });

  it('does not let a column only the second reading names regroup the items the first placed', () => {
    const lines = tableLines(['No', 'Description'], [['A', 'Site'], ['1', 'Title report']]);
    const first = reading(kinds([[1, 'columns'], [3, 'item']]), { item: 2 });
    const second = reading(kinds([[1, 'left'], [2, 'section'], [3, 'item']]), { item: 2, section: 1 });
    const filled = fillUnplaced(lines, first, second);
    expect(filled.cells).toEqual({ item: 2 });
    expect(tieOut(lines, filled).items).toEqual([{ text: 'Title report', lines: [3] }]);
    expect(unplaced(lines, filled)).toEqual([2]);
  });

  it('keeps the first reading\'s columns where it names them, so the items it placed keep their words', () => {
    const lines = tableLines(['Section', 'Subsection', 'Item'], [['A. Site', '', ''], ['', 'A.1 Real estate', ''],
      ['', '', 'Title report']]);
    const read = kinds([[1, 'columns'], [2, 'section'], [3, 'subsection'], [4, 'item']]);
    const first = reading(read, { item: 3, heading: 1, subheading: 1 });
    const filled = fillUnplaced(lines, first, reading(read, { item: 3, heading: 1, subheading: 2 }));
    expect(filled.cells).toEqual({ item: 3, heading: 1, subheading: 1 });
    expect(unplaced(lines, filled)).toEqual([3]);
  });

  it('leaves out a table row whose item cell is blank or past the row, or a heading row with a blank heading', () => {
    const lines = tableLines(['Area', 'Requirement'], [['Land', ''], ['Land', 'Site control covers the array'],
      ['', 'Permits']]);
    const read = kinds([[1, 'columns'], [2, 'item'], [3, 'item'], [4, 'section']]);
    expect(unplaced(lines, reading(read, { item: 2, heading: 1 }))).toEqual([2, 4]);
    expect(unplaced(lines, reading(kinds([[1, 'columns'], [3, 'item']]), { item: 5 }))).toEqual([2, 3, 4]);
    // a table read with no columns named
    expect(unplaced(lines, reading(kinds([[3, 'item']])))).toEqual([1, 2, 3, 4]);
  });

  it('ties out a 2,000-line list with 100 headings, every line counted and every item worded as its line', () => {
    const lines: string[] = [];
    const read: LineRead[] = [];
    for (let s = 1; s <= 100; s++) {
      lines.push(`${s}. Area ${s}`);
      read.push({ n: lines.length, k: 'section' });
      for (let i = 1; i <= 19; i++) {
        lines.push(`   ${s}.${i}  Item ${i} of area ${s} is in place`);
        read.push({ n: lines.length, k: 'item' });
      }
    }
    const t = tieOut(lines, reading(read));
    expect(lines.length).toBe(2000);
    expect(t.count.items).toBe(1900);
    expect(t.left).toEqual([]);
    expect(addsUp(t)).toBe(true);
    expect(t.items[1899]).toMatchObject({
      section: '100. Area 100', text: '   100.19  Item 19 of area 100 is in place',
    });
  });
});
