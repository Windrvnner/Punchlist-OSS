// Reading a list in: every line accounted for, lines left unplaced asked about again, then of the thorough model.
import { describe, it, expect } from 'vitest';
import { pastedLineCount, readList } from '../../src/app/listRead';
import { tieOut, textLines, type LineRead } from '../../src/domain/listRead';
import { mockAi } from '../../src/adapters/mocks';
import { ok, fail } from '../../src/domain/result';
import type { AiService } from '../../src/ports';
import { ITEMS, LEFT_OUT, pastedLines } from '../fixtures/pastedList';

const LINES = ['1. Site', '1.1 Title report', '1.2 Leases cover the array', 'Page 2 of 6'];
const RIGHT: LineRead[] = [{ n: 1, k: 'section', text: 'Site' }, { n: 2, k: 'item', text: 'Title report' }, { n: 3, k: 'item', text: 'Leases cover the array' }, { n: 4, k: 'left' }];
/** a model that answers each call from the list given, and records what it was asked */
function fake(answers: ((only?: number[]) => LineRead[] | null)[]) {
  const calls: { only?: number[]; thorough?: boolean }[] = [];
  const ai = { readList: async (i: { lines: string[]; only?: number[]; thorough?: boolean }) => { calls.push({ only: i.only, thorough: i.thorough }); const a = answers[calls.length - 1]?.(i.only); return a ? ok(a) : fail({ kind: 'failed' as const, message: 'no' }); } } as unknown as AiService;
  return { ai, calls };
}

describe('reading a list in, every line accounted for', () => {
  it('asks once when every line is placed', async () => {
    const { ai, calls } = fake([() => RIGHT]);
    const r = await readList(ai, LINES); expect(r.ok && r.value.size).toBe(4); expect(calls).toHaveLength(1);
  });
  it('asks again about the lines left unplaced, then the thorough model, and leaves out what neither placed', async () => {
    const { ai, calls } = fake([() => RIGHT.filter((x) => x.n !== 2 && x.n !== 3).concat({ n: 3, k: 'item', text: 'Leases reworded' }), () => [RIGHT[2]], () => []]);
    const r = await readList(ai, LINES); if (!r.ok) throw new Error(r.error.message);
    expect(calls).toEqual([{ only: undefined, thorough: undefined }, { only: [2, 3], thorough: false }, { only: [2], thorough: true }]);
    const t = tieOut(LINES, r.value);
    expect(t.items.map((i) => i.text)).toEqual(['1.2 Leases cover the array']); expect(t.left).toEqual([2, 4]);
  });
  it('fails when the first reading fails, and keeps the first reading when a later pass fails', async () => {
    expect((await readList(fake([() => null]).ai, LINES)).ok).toBe(false);
    const r = await readList(fake([() => RIGHT.slice(0, 3), () => null, () => null]).ai, LINES);
    expect(r.ok && [...r.value.keys()]).toEqual([1, 2, 3]);
  });
});

describe('the stand-in reading the mock-up list', () => {
  it('reads 120 items in their sections and leaves out the title, the note, the footers and the starred line', async () => {
    const lines = textLines(pastedLines().join('\n'));
    const r = await readList(mockAi({ latency: [0, 0] }), lines); if (!r.ok) throw new Error(r.error.message);
    const t = tieOut(lines, r.value);
    // the app keeps every line exactly as the file has it, numbering and curly quotes included
    const unnumbered = (text: string) => text.replace(/^(\d+(\.\d+)*[.)]?|[a-z]\))\s+/i, '');
    expect(t.items.map((i) => unnumbered(i.text))).toEqual(ITEMS.map((i) => i.t));
    expect(t.items.every((i) => lines.some((line) => line.trim() && i.text.startsWith(line.trim())))).toBe(true);
    expect(t.items.map((i) => unnumbered(i.section ?? ''))).toEqual(ITEMS.map((i) => i.s));
    expect(t.left.map((n) => lines[n - 1].trim())).toEqual(LEFT_OUT);
    const c = t.count; expect(c.items + c.more + c.headings + c.blank + c.left).toBe(lines.length);
  });
});

describe('pastedLineCount', () => {
  it('counts no lines in an empty box or one of spaces, so Next stays off', () => {
    expect(pastedLineCount('')).toBe(0);
    expect(pastedLineCount(' \n\t ')).toBe(0);
  });

  it('counts every line of a paste, as the paste step shows it', () => {
    expect(pastedLineCount('Comments\r\n1. Fees letter\n2. Hedging policy')).toBe(3);
  });
});
