// Reading a list in, whole: one reading, and when it leaves lines unplaced, one whole reading by the thorough model.
import { describe, it, expect } from 'vitest';
import { readList } from '../../src/app/listRead';
import { tieOut, textLines, type LineRead, type ListReply } from '../../src/domain/listRead';
import { mockAi } from '../../src/adapters/mocks';
import { ok, fail } from '../../src/domain/result';
import type { AiService } from '../../src/ports';
import { ITEMS, LEFT_OUT, pastedLines } from '../fixtures/pastedList';

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

describe('reading a list in, whole, every line accounted for', () => {
  it('asks once when every line is placed', async () => {
    const { ai, calls } = fake([reading(RIGHT)]);
    const r = await readList(ai, LINES); expect(r.ok && r.value.reads.size).toBe(4); expect(calls).toHaveLength(1);
  });
  it('reads the whole list again on the thorough model when lines are unplaced, and takes that reading', async () => {
    const { ai, calls } = fake([reading(RIGHT.filter((x) => x.n !== 2 && x.n !== 3)), reading(RIGHT.filter((x) => x.n !== 2))]);
    const r = await readList(ai, LINES); if (!r.ok) throw new Error(r.error.message);
    expect(calls).toEqual([{ lines: 4, thorough: undefined }, { lines: 4, thorough: true }]);
    const t = tieOut(LINES, r.value);
    expect(t.items.map((i) => i.text)).toEqual(['1.2 Leases cover the array']); expect(t.left).toEqual([2, 4]);
  });
  it('fails when the first reading fails, and keeps the first reading when the thorough one fails', async () => {
    expect((await readList(fake([null]).ai, LINES)).ok).toBe(false);
    const r = await readList(fake([reading(RIGHT.slice(0, 3)), null]).ai, LINES);
    expect(r.ok && [...r.value.reads.keys()]).toEqual([1, 2, 3]);
  });
  it('reads a 2,000-line list in one call when every line is placed', async () => {
    const lines = Array.from({ length: 2000 }, (_, k) => `${k + 1}. Item ${k + 1} is in place`);
    const { ai, calls } = fake([reading(lines.map((_, k) => ({ n: k + 1, k: 'item' })))]);
    const r = await readList(ai, lines); if (!r.ok) throw new Error(r.error.message);
    expect(calls).toEqual([{ lines: 2000, thorough: undefined }]); expect(tieOut(lines, r.value).count.items).toBe(2000);
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
