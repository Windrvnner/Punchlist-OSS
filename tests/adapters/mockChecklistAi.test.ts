// The stand-in for the fast model's duplicate check as a checklist is brought in. It is what the browser build and its
// suites run on, so it must behave as strictly as the model is told to, and stay quick on a list of deal size: a list of
// 2,000 items worded alike once paired nearly every item with every other and froze the import.
import { describe, it, expect } from 'vitest';
import { mockAi } from '../../src/adapters/mocks';

const ai = mockAi({ latency: [0, 0] });
const pairs = async (items: string[], against: string[] = []) => { const r = await ai.sameMeaning!({ items, against }); if (!r.ok) throw new Error(r.error.message); return r.value.pairs.map((p) => [p.a, p.b, p.inAgainst]); };

describe('the stand-in duplicate check', () => {
  it('pairs items that ask for the same thing in other words, here and in the general list', async () => {
    expect(await pairs(['Insurance certificates delivered to the lenders', 'Delivered to the lenders: the insurance certificates'], ['Insurance certificates were delivered to lenders'])).toEqual([[0, 1, false], [0, 0, true], [1, 0, true]]);
  });
  it('does not pair items whose figures differ, or items worded the same, which the app finds itself', async () => {
    expect(await pairs(['Phase 1 permit issued for the substation', 'Phase 2 permit issued for the substation', 'phase 1 permit issued for the substation.'])).toEqual([]);
  });
  it('answers for 2,400 items worded alike within a second, with no pair between numbered items', async () => {
    const items = Array.from({ length: 2400 }, (_, i) => `Checklist item ${i + 1}: insurance certificates delivered`);
    const t = performance.now(); const out = await pairs(items, items.slice(0, 400));
    expect(out).toEqual([]); expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('the stand-in rewording', () => {
  it('splits two conditions joined by ";" into two items, "(if applicable)" only on a permit that may not be needed', async () => {
    const r = await ai.reword!({ items: ['Wetlands delineation complete; any Section 404 permit in hand', 'Interconnection agreement executed; conditions to energization identified'] });
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.map((x) => [x.text, ...(x.also ?? [])])).toEqual([['Wetlands delineation complete.', 'Section 404 permit in hand (if applicable).'], ['Interconnection agreement executed.', 'Conditions to energization identified.']]);
  });
});
