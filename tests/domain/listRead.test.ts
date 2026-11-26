import { describe, it, expect } from 'vitest';
import { tieOut, unplaced, tableLines, textLines, type LineRead, type ListCells, type ListReading } from '../../src/domain/listRead';

const reading = (rs: LineRead[], cells?: ListCells): ListReading => ({ reads: new Map(rs.map((r) => [r.n, r])), ...(cells ? { cells } : {}) });
const LINES = textLines(['Proseware Solar checklist', '', '1. Site', '   1.1  Title report for the whole site', '   1.2  Leases cover the array and the', '        gen-tie route', 'Page 2 of 6', '2. Permits', '   2.1  Conditional use permit issued'].join('\r\n'));
const READ: LineRead[] = [
  { n: 1, k: 'left' }, { n: 3, k: 'section' }, { n: 4, k: 'item' }, { n: 5, k: 'item' }, { n: 6, k: 'more' },
  { n: 7, k: 'left' }, { n: 8, k: 'section' }, { n: 9, k: 'item' },
];

describe('a list read whole by the model, tied out line by line', () => {
  it('accounts for every line, joins a wrapped item, and keeps each item under its heading', () => {
    const t = tieOut(LINES, reading(READ));
    expect(t.items.map((i) => [i.section, i.text, i.lines])).toEqual([
      ['1. Site', '1.1  Title report for the whole site', [4]], ['1. Site', '1.2  Leases cover the array and the gen-tie route', [5, 6]], ['2. Permits', '2.1  Conditional use permit issued', [9]]]);
    expect(t.left).toEqual([1, 7]);
    const c = t.count; expect(c.items + c.more + c.headings + c.blank + c.left).toBe(c.lines);
    expect(c).toEqual({ lines: 9, items: 3, more: 1, headings: 2, blank: 1, left: 2 });
  });

  it('leaves out a line the model did not name, and asks about it again', () => {
    const r = reading(READ.filter((x) => x.n !== 4 && x.n !== 9));
    expect(unplaced(LINES, r)).toEqual([4, 9]);
    const t = tieOut(LINES, r);
    expect(t.left).toEqual([1, 4, 7, 9]);
    // the wrapped line of the next item still joins its own item, not one before it
    expect(t.items.map((i) => i.text)).toEqual(['1.2  Leases cover the array and the gen-tie route']);
    const c = t.count; expect(c.items + c.more + c.headings + c.blank + c.left).toBe(c.lines);
  });

  it('never joins a "more" line to an item across a heading', () => {
    const t = tieOut(['A', 'Item one', 'B', 'rest'], reading([{ n: 1, k: 'section' }, { n: 2, k: 'item' }, { n: 3, k: 'section' }, { n: 4, k: 'more' }]));
    expect(t.items.map((i) => i.text)).toEqual(['Item one']); expect(t.left).toEqual([4]);
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
    const lines = tableLines(['Area', 'Requirement'], [['Interconnection', 'Network upgrade costs  capped'], ['Land', 'Site control covers the array']]);
    expect(lines[1]).toBe('Interconnection | Network upgrade costs  capped');   // the cell's own spacing stays
    const t = tieOut(lines, reading([{ n: 1, k: 'columns' }, { n: 2, k: 'item' }, { n: 3, k: 'item' }], { item: 2, section: 1 }));
    expect(t.items.map((i) => [i.section, i.text])).toEqual([['Interconnection', 'Network upgrade costs  capped'], ['Land', 'Site control covers the array']]);
    expect(t.count.headings).toBe(1);
  });

  it('carries a table row\'s section and subsection to the rows under it, as a section filled in once is laid out', () => {
    const lines = tableLines(['Section', 'Sub-section', 'Item'], [['Finance', 'Model', 'The model is audited'], ['', '', 'Reserves are funded'], ['', 'Funding', 'Equity is committed'], ['Legal', '', 'Approvals are in place']]);
    const items: LineRead[] = [2, 3, 4, 5].map((n) => ({ n, k: 'item' }));
    const t = tieOut(lines, reading([{ n: 1, k: 'columns' }, ...items], { item: 3, section: 1, subsection: 2 }));
    expect(t.items.map((i) => [i.section, i.subsection, i.text])).toEqual([['Finance', 'Model', 'The model is audited'], ['Finance', 'Model', 'Reserves are funded'], ['Finance', 'Funding', 'Equity is committed'], ['Legal', undefined, 'Approvals are in place']]);
  });

  it('takes a table row read as a heading from its section or subsection cell, as written', () => {
    const lines = tableLines(['Section', 'Sub-section', 'Item'], [['Site  works', '', ''], ['', 'Grading', ''], ['', '', 'Grading plan approved']]);
    const t = tieOut(lines, reading([{ n: 1, k: 'columns' }, { n: 2, k: 'section' }, { n: 3, k: 'subsection' }, { n: 4, k: 'item' }], { item: 3, section: 1, subsection: 2 }));
    expect(t.items.map((i) => [i.section, i.subsection, i.text])).toEqual([['Site  works', 'Grading', 'Grading plan approved']]);
  });

  it('leaves out a table row whose item cell is blank or past the row, or a heading row whose heading cell is blank', () => {
    const lines = tableLines(['Area', 'Requirement'], [['Land', ''], ['Land', 'Site control covers the array'], ['', 'Permits']]);
    expect(unplaced(lines, reading([{ n: 1, k: 'columns' }, { n: 2, k: 'item' }, { n: 3, k: 'item' }, { n: 4, k: 'section' }], { item: 2, section: 1 }))).toEqual([2, 4]);
    expect(unplaced(lines, reading([{ n: 1, k: 'columns' }, { n: 3, k: 'item' }], { item: 5 }))).toEqual([2, 3, 4]);
    expect(unplaced(lines, reading([{ n: 3, k: 'item' }]))).toEqual([1, 2, 3, 4]);    // a table read with no columns named
  });

  it('ties out a 2,000-line list with 100 headings, every line counted and every item worded as its line', () => {
    const lines: string[] = []; const read: LineRead[] = [];
    for (let s = 0; s < 100; s++) {
      lines.push(`${s + 1}. Area ${s + 1}`); read.push({ n: lines.length, k: 'section' });
      for (let i = 0; i < 19; i++) { lines.push(`   ${s + 1}.${i + 1}  Item ${i + 1} of area ${s + 1} is in place`); read.push({ n: lines.length, k: 'item' }); }
    }
    const t = tieOut(lines, reading(read));
    expect(lines.length).toBe(2000); expect(t.count.items).toBe(1900); expect(t.left).toEqual([]);
    const c = t.count; expect(c.items + c.more + c.headings + c.blank + c.left).toBe(2000);
    expect(t.items[1900 - 1]).toMatchObject({ section: '100. Area 100', text: '100.19  Item 19 of area 100 is in place' });
  });
});
