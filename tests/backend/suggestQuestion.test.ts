// @vitest-environment node
// The model's reading of which open question a chat answer addresses (#1120), for the suggested open question card.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';

const questions = (n: number) =>
  Array.from({ length: n }, (_, k) => `Please provide document ${k + 1} for the lenders`);
const opts = { shared: new Mem(), installId: 'pc' };

describe('the open question an answer addresses', () => {
  const isSuggest = (c: Call) => c.prompt.includes('Which one of these open questions does the answer address');
  const handles = (c: Call) => [...c.prompt.matchAll(/^(A\d+): /gm)].map((m) => m[1]);
  const answer = 'The base case follows the technical advisor at 98% availability, as in Q3 2027.';

  it('shows the questions under neutral handles and maps the one named back to its place', async () => {
    const s = setup((c) => (isSuggest(c) ? { question: ' A2 ' } : {}), {}, opts);
    const asked = ['Q7 Provide the insurance certificates', 'Which operating assumption does the base case use?'];
    expect(val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: asked }))).toEqual([1]);
    const call = s.calls.filter(isSuggest)[0];
    expect(handles(call)).toEqual(['A1', 'A2']);
    expect(call.prompt).toContain(answer);
    expect(call.files).toEqual([]);
    expect(call.model).toBe('standard');
  });

  it('none proposes no question', async () => {
    const s = setup((c) => (isSuggest(c) ? { question: 'none' } : {}), {}, opts);
    expect(val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2) }))).toEqual([]);
    expect(s.calls.filter(isSuggest)).toHaveLength(1);
  });

  it('a handle not shown is sent back once; still wrong, the reply failed and none is proposed', async () => {
    for (const named of ['A3', 'Q2', 2]) {
      const s = setup((c) => (isSuggest(c) ? { question: named } : {}), {}, opts);
      const r = await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2) });
      expect(r.ok).toBe(false);
      expect(s.calls.filter(isSuggest)).toHaveLength(2);
    }
    // a corrected reply is taken
    let asked = 0;
    const fixed = setup((c) => (isSuggest(c) ? { question: asked++ === 0 ? 'A9' : 'A2' } : {}), {}, opts);
    expect(val(await fixed.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2) }))).toEqual([1]);
  });

  it('at 2,000 open questions the calls are sized to the input limit; every part named is kept', async () => {
    // the model names the last question of every part that shows document 300 or document 1500
    const s = setup((c) => {
      if (!isSuggest(c)) return {};
      const named = c.prompt.includes('document 300 for') || c.prompt.includes('document 1500 for');
      return { question: named ? `A${handles(c).length}` : 'none' };
    }, {}, opts);
    s.svc.inputLimit = () => 20000;
    const places = val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }));
    const calls = s.calls.filter(isSuggest);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap(handles).length).toBe(2000);
    expect(places).toHaveLength(2);
    expect(places[0]).toBeGreaterThanOrEqual(299);
    expect(places[0]).toBeLessThan(places[1]);
    expect(places[1]).toBeGreaterThanOrEqual(1499);
    const whole = setup((c) => (isSuggest(c) ? { question: 'none' } : {}), {}, opts);
    expect(val(await whole.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }))).toEqual([]);
    expect(whole.calls.filter(isSuggest)).toHaveLength(1);
  });

  it('a later part that fails keeps what earlier parts named; none named, the failure is returned', async () => {
    const down = Object.assign(new Error('down'), { code: 'ECONNRESET' });
    const s = setup((c) => {
      if (!isSuggest(c)) return {};
      if (c.prompt.includes('document 1500 for')) throw down;
      return { question: c.prompt.includes('document 300 for') ? `A${handles(c).length}` : 'none' };
    }, {}, opts);
    s.svc.inputLimit = () => 20000;
    const places = val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }));
    expect(places).toHaveLength(1);
    expect(places[0]).toBeGreaterThanOrEqual(299);
    expect(places[0]).toBeLessThan(1499);
    const none = setup((c) => {
      if (isSuggest(c) && c.prompt.includes('document 1500 for')) throw down;
      return isSuggest(c) ? { question: 'none' } : {};
    }, {}, opts);
    none.svc.inputLimit = () => 20000;
    const r = await none.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) });
    expect(r.ok).toBe(false);
  });
});
