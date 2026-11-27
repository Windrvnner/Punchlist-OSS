// Reading a list in, whole: one reading, and when it leaves lines unplaced, one whole reading by the thorough model.
import { describe, it, expect } from 'vitest';
import {
  checklistCellRows, checklistPaste, checklistSourceLines, checklistWrittenLines, pastedLines, readList,
  tieChecklistLines,
} from '../../src/app/listRead';
import {
  tableLines, tieOut, textLines, type LineRead, type ListReading, type ListReply,
} from '../../src/domain/listRead';
import { mockAi } from '../../src/adapters/mocks';
import { ok, fail, type Result } from '../../src/domain/result';
import type { AiService } from '../../src/ports';
import { ITEMS, LEFT_OUT, pastedLines as mockUpLines } from '../fixtures/pastedList';

const LINES = ['1. Site', '1.1 Title report', '1.2 Leases cover the array', 'Page 2 of 6'];
const RIGHT: LineRead[] = [{ n: 1, k: 'section' }, { n: 2, k: 'item' }, { n: 3, k: 'item' }, { n: 4, k: 'left' }];
const reading = (rs: LineRead[]): ListReply => ({ lines: rs });
/** a model that answers each call in turn, and records what it was asked */
function fake(answers: (ListReply | null)[]) {
  const calls: { lines: number; thorough?: boolean }[] = [];
  const readList = async (i: { lines: string[]; thorough?: boolean }) => {
    calls.push({ lines: i.lines.length, thorough: i.thorough });
    const a = answers[calls.length - 1];
    return a ? ok(a) : fail({ kind: 'failed' as const, message: 'no' });
  };
  return { ai: { readList } as unknown as AiService, calls };
}

const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const numbered = (count: number) => Array.from({ length: count }, (_, k) => `${k + 1}. Item ${k + 1} is in place`);

describe('reading a list in, whole, every line accounted for', () => {
  it('asks once when every line is placed', async () => {
    const { ai, calls } = fake([reading(RIGHT)]);
    expect(unwrap(await readList(ai, LINES)).reads.size).toBe(4);
    expect(calls).toHaveLength(1);
  });
  it('reads the whole list again on the thorough model when lines are unplaced, and fills only those', async () => {
    // the thorough reading places line 3, leaves line 2 out and reads line 1 otherwise: line 1 keeps the first reading
    const thorough = reading([{ n: 1, k: 'left' }, { n: 3, k: 'item' }]);
    const { ai, calls } = fake([reading(RIGHT.filter((x) => x.n !== 2 && x.n !== 3)), thorough]);
    const t = tieOut(LINES, unwrap(await readList(ai, LINES)));
    expect(calls).toEqual([{ lines: 4, thorough: undefined }, { lines: 4, thorough: true }]);
    expect(t.items.map((i) => [i.section, i.text])).toEqual([['1. Site', '1.2 Leases cover the array']]);
    expect(t.left).toEqual([2, 4]);
  });
  it('keeps 1,999 lines the first reading placed when the thorough reading places fewer', async () => {
    const lines = numbered(2000);
    const first = reading(lines.slice(1).map((_, k) => ({ n: k + 2, k: 'item' })));
    const read = unwrap(await readList(fake([first, reading([{ n: 1, k: 'item' }])]).ai, lines));
    expect(tieOut(lines, read).count).toMatchObject({ items: 2000, left: 0 });
  });
  it('fails when the first reading fails, and keeps the first reading when the thorough one fails', async () => {
    expect((await readList(fake([null]).ai, LINES)).ok).toBe(false);
    const read = unwrap(await readList(fake([reading(RIGHT.slice(0, 3)), null]).ai, LINES));
    expect([...read.reads.keys()]).toEqual([1, 2, 3]);
  });
  it('reads a 2,000-line list in one call when every line is placed', async () => {
    const lines = numbered(2000);
    const { ai, calls } = fake([reading(lines.map((_, k) => ({ n: k + 1, k: 'item' })))]);
    const read = unwrap(await readList(ai, lines));
    expect(calls).toEqual([{ lines: 2000, thorough: undefined }]);
    expect(tieOut(lines, read).count.items).toBe(2000);
  });
});

describe('reading a table whose first reading named no columns', () => {
  it('leaves the rows out and listed, as the thorough reading\'s columns are not taken', async () => {
    const lines = tableLines(['No', 'Requirement'], [['1', 'Title report'], ['2', 'Check Debt | Equity obligations']]);
    const placed: LineRead[] = [{ n: 1, k: 'columns' }, { n: 2, k: 'item' }, { n: 3, k: 'item' }];
    const { ai, calls } = fake([reading(placed), { lines: placed, cells: { item: 2 } }]);
    const t = tieOut(lines, unwrap(await readList(ai, lines, new Set([1, 2, 3]))));
    expect(calls.map((c) => c.thorough)).toEqual([undefined, true]);
    expect(t.items).toEqual([]);
    expect(t.left).toEqual([2, 3]);
  });

  it('writes a pasted cell\'s own " | " and backslash so that it stays one cell', () => {
    const lines = pastedLines('No\tRequirement\n1\tCheck Debt | Equity obligations\n2\tC:\\dir\\file');
    const placed: LineRead[] = [{ n: 1, k: 'columns' }, { n: 2, k: 'item' }, { n: 3, k: 'item' }];
    const reads = new Map(placed.map((r) => [r.n, r]));
    const t = tieOut(lines, { reads, cells: { item: 2 }, cellRows: new Set([1, 2, 3]) });
    expect(t.items.map((i) => i.text)).toEqual(['Check Debt | Equity obligations', 'C:\\dir\\file']);
  });
});

describe('the stand-in reading the mock-up list', () => {
  it('reads 120 items in their sections and leaves out the title, the note, the footers and the starred line', async () => {
    const lines = textLines(mockUpLines().join('\n'));
    const r = await readList(mockAi({ latency: [0, 0] }), lines); if (!r.ok) throw new Error(r.error.message);
    const t = tieOut(lines, r.value);
    // the app keeps every line exactly as the file has it, numbering and curly quotes included
    const unnumbered = (text: string) => text.replace(/^\s*(\d+(\.\d+)*[.)]?|[a-z]\))\s+/i, '');
    // a wrapped item keeps the next line's own indentation after its space (#1215)
    expect(t.items.map((i) => unnumbered(i.text).replace(/ {2,}/g, ' '))).toEqual(ITEMS.map((i) => i.t));
    expect(t.items.every((i) => lines.some((line) => line.trim() && i.text.startsWith(line)))).toBe(true);
    expect(t.items.map((i) => unnumbered(i.section ?? ''))).toEqual(ITEMS.map((i) => i.s));
    expect(t.left.map((n) => lines[n - 1].trim())).toEqual(LEFT_OUT);
    const c = t.count; expect(c.items + c.more + c.headings + c.blank + c.left).toBe(lines.length);
  });
});

describe('a person\'s file content is never altered on its way in', () => {
  const placed = (ks: LineRead['k'][]): LineRead[] => ks.map((k, i) => ({ n: i + 1, k }));
  it('keeps a pasted line with one cell and a trailing tab as written, not escaped', () => {
    expect(pastedLines('a\\b|c\td\te')).toEqual(['a\\\\b\\|c | d | e']);
    expect(checklistPaste('a\\b')!.cellRows).toEqual([]);
    expect(checklistPaste('a\\b\t')!.written).toEqual(['a\\b\t']);
  });
  it('keeps the empty cells at a pasted row\'s edges and the spaces around its tabs, so columns stay as pasted', () => {
    expect(pastedLines('\tBylaws\tnotes2')).toEqual([' | Bylaws | notes2']);
    expect(pastedLines('Bylaws\tnotes2\t')).toEqual(['Bylaws | notes2 | ']);
    expect(pastedLines('a \t b')).toEqual(['a  |  b']);
    expect(pastedLines('\t\t')).toEqual(['\t\t']);   // a line of only tabs is blank, as it was pasted
    expect(checklistPaste('Ref\tItem\n\tBylaws\n \t\n')!.cellRows).toEqual([1, 2]);
  });
  it('imports the item column of a pasted table whose section is blank on continuation rows', async () => {
    const paste = ['Corporate\tArticles\tnotes', '\tBylaws\tnotes2', '\tAccounts | audited\tx'].join('\n');
    const source = checklistPaste(paste)!;
    const lines = checklistSourceLines(source, null)!;
    const model = fake([{ lines: placed(['item', 'item', 'item']), cells: { item: 2, section: 1 } }]);
    const read = unwrap(await readList(model.ai, lines, checklistCellRows(source, null)));
    const tied = tieChecklistLines(lines, read, undefined, checklistWrittenLines(source, null))!;
    expect(tied.items.map((i) => [i.section, i.text])).toEqual([
      ['Corporate', 'Articles'], ['Corporate', 'Bylaws'], ['Corporate', 'Accounts | audited']]);
  });
  it('reads a one-column table\'s lines as text, so its cells import as written', async () => {
    const table = { columns: ['Item'], rows: [['Review A | B agreement'], ['Path C:\\docs']] } as never;
    const lines = checklistSourceLines(null, table)!;
    const cellRows = checklistCellRows(null, table);
    expect(cellRows.size).toBe(0);
    const model = fake([{ lines: placed(['columns', 'item', 'item']), cells: { item: 1 } }]);
    const read = unwrap(await readList(model.ai, lines, cellRows));
    const items = tieChecklistLines(lines, read, undefined, checklistWrittenLines(null, table))!.items;
    expect(items.map((i) => i.text)).toEqual(['Review A | B agreement', 'Path C:\\docs']);
  });
  it('marks every row of a table of several columns, and only the tabbed lines of a paste, as cell rows', () => {
    const table = { columns: ['A', 'B'], rows: [['1', '2']] } as never;
    expect([...checklistCellRows(null, table)]).toEqual([1, 2]);
    const paste = checklistPaste('Share D:\\srv | read only\n1.2\tInsurance\tLender')!;
    expect([...checklistCellRows(paste, null)]).toEqual([2]);
  });
  it('lists, brings in and appends pasted text holding " | " as pasted, though a column is named', async () => {
    const pasted = ['Share D:\\srv | read only', 'Note a \\| b | c', 'Item', 'rest | of it'];
    const source = checklistPaste(pasted.join('\n'))!;
    const lines = checklistSourceLines(source, null)!;
    const written = checklistWrittenLines(source, null);
    const cellRows = checklistCellRows(source, null);
    const model = fake([{ lines: placed(['left', 'left', 'item', 'more']), cells: { item: 1 } }]);
    const read = unwrap(await readList(model.ai, lines, cellRows));
    expect(tieChecklistLines(lines, read, undefined, written)!.leftText).toEqual(lines.slice(0, 2));
    const brought = tieChecklistLines(lines, read, new Set([1, 2]), written)!.items;
    expect(brought.map((i) => i.text)).toEqual(['Share D:\\srv | read only', 'Note a \\| b | c', 'Item rest | of it']);
  });
});

describe('a pasted line keeps its own text (#1061)', () => {
  const pasted = [
    'Insurance', '1.2\tInsurance certificates\tLender to confirm', '1.3\tBroker letter', '\tand cover note',
  ];
  const source = checklistPaste(pasted.join('\n'))!;
  const lines = checklistSourceLines(source, null)!;
  const written = checklistWrittenLines(source, null);
  const reading = (cells?: { item: number }): ListReading => ({
    reads: new Map<number, LineRead>([
      [1, { n: 1, k: 'section' }], [2, { n: 2, k: 'left' }], [3, { n: 3, k: 'item' }], [4, { n: 4, k: 'more' }],
    ]),
    ...(cells ? { cells } : {}),
    cellRows: checklistCellRows(source, null),
  });

  it('brings a left-out pasted line in exactly as pasted, its tabs included', () => {
    expect(lines[1]).toBe('1.2 | Insurance certificates | Lender to confirm');   // as the model reads it
    const tied = tieChecklistLines(lines, reading({ item: 2 }), new Set([2]), written)!;
    expect(tied.items[0].text).toBe('1.2\tInsurance certificates\tLender to confirm');
  });

  it('joins the rest of an item on the line below as pasted, not as the model reads it', () => {
    const tied = tieChecklistLines(lines, reading({ item: 2 }), new Set(), written)!;
    expect(tied.items.map((i) => i.text)).toEqual(['Broker letter \tand cover note']);
  });
});
