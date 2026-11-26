// @vitest-environment node
// The model's check of an Already Asked? pair (#1218): whether an open question already asks for what an unresolved point
// lacks. The model sees each pair under a neutral tag only; code takes an answer only for a tag that was offered, once.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';

const isCovers = (c: Call) => c.prompt.includes('already asks for what the point lacks');
const tagsIn = (c: Call) => [...c.prompt.matchAll(/^([bcdfghjkmnpqrstvwxz]{3}):$/gm)].map((m) => m[1]);
const checks = [
  { point: 'Insurance advisor report (final)', question: 'Has the insurance advisor issued its final report yet?' },
  { point: 'Direct agreement signed', question: 'Who audited the model?' },
  { point: 'Lock-up ratio differs', question: 'Which lock-up ratio was agreed?' },
];
const run = (script: (c: Call) => object | string) => {
  const s = setup((c) => (isCovers(c) ? script(c) : {}), {}, { shared: new Mem(), installId: 'pc' });
  return { s, ask: (input = checks) => s.ai.covers!({ dealId: 'd', checks: input }) };
};

describe('covers: does an open question already ask for what a point lacks', () => {
  it('asks once for all the pairs, under tags, and gives each answer its pair', async () => {
    const { s, ask } = run((c) => {
      const [a, b, d] = tagsIn(c);
      return { items: [{ id: d, covers: true }, { id: a, covers: true }, { id: b, covers: false }] };
    });
    expect(val(await ask())).toEqual([true, false, true]);
    expect(s.calls.filter(isCovers)).toHaveLength(1);
  });
  it('shows the model the texts only: no question number or record id', async () => {
    const { s, ask } = run((c) => ({ items: tagsIn(c).map((id) => ({ id, covers: true })) }));
    val(await ask());
    const prompt = s.calls.find(isCovers)!.prompt;
    expect(prompt).toContain('Has the insurance advisor issued its final report yet?');
    expect(prompt).not.toMatch(/\bQ\d/);
  });
  it('takes no answer for a tag it did not offer, or one named twice, or one that is not true or false', async () => {
    const { ask } = run((c) => {
      const [a, b] = tagsIn(c);
      return { items: [{ id: 'zzz', covers: true }, { id: a, covers: true }, { id: a, covers: false }, { id: b, covers: 'yes' }] };
    });
    expect(val(await ask())).toEqual([null, null, null]);
  });
  it('makes no call when there is nothing to check', async () => {
    const { s, ask } = run(() => ({ items: [] }));
    expect(val(await ask([]))).toEqual([]);
    expect(s.all).toHaveLength(0);
  });
  it('fails, naming a reply it cannot read, when nothing came back', async () => {
    const { ask } = run(() => 'not json at all');
    const result = await ask();
    expect(result.ok).toBe(false);
  });
});
