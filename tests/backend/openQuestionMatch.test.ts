// @vitest-environment node
// The model's reading of which open question a text asks for (#1120): a deal's unresolved points against its open
// questions (Add All Unresolved), and a chat answer against the open questions (the suggested open question card).
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';

const lines = (c: Call) => c.prompt.split('\n').filter((l) => /^\d+: /.test(l));
const isMatch = (c: Call) => c.prompt.includes('does an open question already ask for');
const points = (n: number) => Array.from({ length: n }, (_, k) => `Point ${k + 1} needs its permit`);
const questions = (n: number) => Array.from({ length: n }, (_, k) => `Please provide document ${k + 1} for the lenders`);
const opts = { shared: new Mem(), installId: 'pc' };

describe('unresolved points against open questions', () => {
  it('asks about points and open questions, marked as such, and maps pairs back to the questions', async () => {
    const s = setup((c) => (isMatch(c) ? { pairs: [{ a: 2, b: 4, why: 'same permit' }] } : {}), {}, opts);
    const out = val(await s.ai.sameMeaning!({ items: points(2), against: questions(3), kind: 'questions' }));
    const asked = s.calls.filter(isMatch);
    expect(asked).toHaveLength(1);
    expect(lines(asked[0])).toEqual([
      '1: [point] Point 1 needs its permit', '2: [point] Point 2 needs its permit',
      '3: [question] Please provide document 1 for the lenders', '4: [question] Please provide document 2 for the lenders',
      '5: [question] Please provide document 3 for the lenders',
    ]);
    expect(asked[0].prompt).not.toContain('checklist');
    expect(out.pairs).toEqual([{ a: 1, b: 1, inAgainst: true, why: 'same permit' }]);
  });

  it('at 150 points and 2,000 open questions every point is asked about, or listed as missed', async () => {
    const s = setup((c) => (isMatch(c) ? { pairs: [] } : {}), {}, opts);
    const out = val(await s.ai.sameMeaning!({ items: points(150), against: questions(2000), kind: 'questions' }));
    const shown = s.calls.filter(isMatch).flatMap((c) => lines(c).filter((l) => l.includes('[point]')));
    expect(new Set(shown).size).toBe(150);
    expect(out.missed).toBeUndefined();
    const down = setup((c) => {
      if (isMatch(c)) throw Object.assign(new Error('down'), { code: 'ECONNRESET' });
      return {};
    }, {}, opts);
    const r = await down.ai.sameMeaning!({ items: points(150), against: questions(2000), kind: 'questions' });
    expect(r.ok).toBe(false);
  });
});
