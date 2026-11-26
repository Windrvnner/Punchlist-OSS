import { describe, it, expect } from 'vitest';
import { tieOut, unplaced, tableLines, tableRowsAsWritten, textLines, type LineRead } from '../../src/domain/listRead';

const reads = (rs: LineRead[]) => new Map(rs.map((r) => [r.n, r]));
const LINES = textLines(['Proseware Solar checklist', '', '1. Site', '   1.1  Title report for the whole site', '   1.2  Leases cover the array and the', '        gen-tie route', 'Page 2 of 6', '2. Permits', '   2.1  Conditional use permit issued'].join('\r\n'));
const READ: LineRead[] = [
  { n: 1, k: 'left' }, { n: 3, k: 'section', text: 'Site' }, { n: 4, k: 'item', text: 'Title report for the whole site' },
  { n: 5, k: 'item', text: 'Leases cover the array and the' }, { n: 6, k: 'more' }, { n: 7, k: 'left' },
  { n: 8, k: 'section', text: 'Permits' }, { n: 9, k: 'item', text: 'Conditional use permit issued' },
];

describe('a list read by the model, tied out line by line', () => {
  it('accounts for every line, joins a wrapped item, and keeps each item under its heading', () => {
    const t = tieOut(LINES, reads(READ));
    expect(t.items.map((i) => [i.section, i.text, i.lines])).toEqual([
      ['1. Site', '1.1  Title report for the whole site', [4]], ['1. Site', '1.2  Leases cover the array and the gen-tie route', [5, 6]], ['2. Permits', '2.1  Conditional use permit issued', [9]]]);
    expect(t.left).toEqual([1, 7]);
    const c = t.count; expect(c.items + c.more + c.headings + c.blank + c.left).toBe(c.lines);
    expect(c).toEqual({ lines: 9, items: 3, more: 1, headings: 2, blank: 1, left: 2 });
  });

  it('leaves out a line the model skipped or answered with words the line does not hold, and asks about it again', () => {
    const r = reads(READ.filter((x) => x.n !== 9).map((x) => (x.n === 4 ? { ...x, text: 'Title report and survey for the site' } : x)));
    expect(unplaced(LINES, r)).toEqual([4, 9]);
    const t = tieOut(LINES, r);
    expect(t.left).toEqual([1, 4, 7, 9]);
    // the wrapped line of the next item still joins its own item, not one before it
    expect(t.items.map((i) => i.text)).toEqual(['1.2  Leases cover the array and the gen-tie route']);
    const c = t.count; expect(c.items + c.more + c.headings + c.blank + c.left).toBe(c.lines);
  });

  it('never joins a "more" line to an item across a heading', () => {
    const t = tieOut(['A', 'Item one', 'B', 'rest'], reads([{ n: 1, k: 'section', text: 'A' }, { n: 2, k: 'item', text: 'Item one' }, { n: 3, k: 'section', text: 'B' }, { n: 4, k: 'more' }]));
    expect(t.items.map((i) => i.text)).toEqual(['Item one']); expect(t.left).toEqual([4]);
  });

  it('brings a checked line in where it sits, with its own words, under the heading above it', () => {
    const t = tieOut(LINES, reads(READ), new Set([7]));
    expect(t.left).toEqual([1]);
    expect(t.items.map((i) => [i.section, i.text])).toContainEqual(['1. Site', 'Page 2 of 6']);
    expect(t.items.findIndex((i) => i.text === 'Page 2 of 6')).toBe(2);
    // a line brought in comes in exactly as written: bullets, list numbers and figures stay
    const given = ['*  Independent engineer engaged', '1.4) Survey', '2 years of audited accounts', '10. Board minutes'];
    expect(tieOut(given, new Map(), new Set([1, 2, 3, 4])).items.map((i) => i.text)).toEqual(given);
  });

  it('brings a left-out table row in with its cells as a spreadsheet copies them (#1061)', () => {
    const columns = ['Ref', 'Item', 'Notes'];
    const rows = [
      ['1.1', 'Title report', ''], ['1.2', 'Insurance certificates', 'Lender to confirm'], ['', 'Survey', ''],
    ];
    const lines = tableLines(columns, rows);
    const written = tableRowsAsWritten(columns, rows);
    expect(written).toHaveLength(lines.length);
    const read = reads([{ n: 1, k: 'columns' }, { n: 2, k: 'item', text: 'Title report' }, { n: 3, k: 'left' },
      { n: 4, k: 'item', text: 'Survey' }]);
    expect(tieOut(lines, read, new Set(), written).left).toEqual([3]);
    const brought = tieOut(lines, read, new Set([3]), written).items.map((i) => i.text);
    expect(brought).toEqual(['Title report', '1.2\tInsurance certificates\tLender to confirm', 'Survey']);
    // empty cells at a row's edges are not text the file holds; a line break inside a cell is
    expect(tableRowsAsWritten(columns, [['', 'Two\nlines', '']])[1]).toBe('Two\nlines');
  });

  it('reads a table row with its own section and subsection, and the heading row as a heading', () => {
    const lines = tableLines(['Area', 'Requirement'], [['Interconnection', 'Network upgrade costs  capped'], ['Land', 'Site control covers the array']]);
    expect(lines[1]).toBe('Interconnection | Network upgrade costs  capped');   // the cell's own spacing stays
    const t = tieOut(lines, reads([{ n: 1, k: 'columns' }, { n: 2, k: 'item', text: 'Network upgrade costs capped', section: 'Interconnection' }, { n: 3, k: 'item', text: 'Site control covers the array', section: 'Land' }]));
    expect(t.items.map((i) => [i.section, i.text])).toEqual([['Interconnection', 'Network upgrade costs  capped'], ['Land', 'Site control covers the array']]);
    expect(t.count.headings).toBe(1);
  });

  it('carries a table row\'s section and subsection to the rows under it, as a section filled in once is laid out', () => {
    const lines = tableLines(['Section', 'Sub-section', 'Item'], [['Finance', 'Model', 'The model is audited'], ['', '', 'Reserves are funded'], ['', 'Funding', 'Equity is committed'], ['Legal', '', 'Approvals are in place']]);
    const t = tieOut(lines, reads([{ n: 1, k: 'columns' }, { n: 2, k: 'item', text: 'The model is audited', section: 'Finance', subsection: 'Model' }, { n: 3, k: 'item', text: 'Reserves are funded' }, { n: 4, k: 'item', text: 'Equity is committed', subsection: 'Funding' }, { n: 5, k: 'item', text: 'Approvals are in place', section: 'Legal' }]));
    expect(t.items.map((i) => [i.section, i.subsection, i.text])).toEqual([['Finance', 'Model', 'The model is audited'], ['Finance', 'Model', 'Reserves are funded'], ['Finance', 'Funding', 'Equity is committed'], ['Legal', undefined, 'Approvals are in place']]);
  });

  it('does not take an item shortened from its line, but takes one without its leading number or label', () => {
    const lines = ['1.1 Title report for the whole site and an ALTA survey', 'Section 3: Permits', 'a) Survey delivered', 'Land | Site control covers the array'];
    expect(unplaced(lines, reads([{ n: 1, k: 'item', text: 'Title report for the whole site' }, { n: 2, k: 'section', text: 'Permits' }, { n: 3, k: 'item', text: 'Survey delivered' }, { n: 4, k: 'item', text: 'Site control' }]))).toEqual([1, 4]);
  });

  it('does not take a section the row does not hold', () => {
    const lines = ['Land | Site control covers the array'];
    expect(unplaced(lines, reads([{ n: 1, k: 'item', text: 'Site control covers the array', section: 'Real estate' }]))).toEqual([1]);
  });
});
