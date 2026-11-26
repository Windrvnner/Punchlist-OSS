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
    expect(val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: asked }))).toBe(1);
    const call = s.calls.filter(isSuggest)[0];
    expect(handles(call)).toEqual(['A1', 'A2']);
    expect(call.prompt).toContain(answer);
    expect(call.files).toEqual([]);
    expect(call.model).toBe('standard');
  });

  it('a handle not shown, or none, proposes no question', async () => {
    for (const named of ['A3', 'none', 'Q2', 2]) {
      const s = setup((c) => (isSuggest(c) ? { question: named } : {}), {}, opts);
      expect(val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2) }))).toBeNull();
    }
  });

  it('at 2,000 open questions the calls are sized to the input limit; the earliest one named is taken', async () => {
    // the model names the last question of every part that shows document 300 or document 1500
    const s = setup((c) => {
      if (!isSuggest(c)) return {};
      const named = c.prompt.includes('document 300 for') || c.prompt.includes('document 1500 for');
      return { question: named ? `A${handles(c).length}` : 'none' };
    }, {}, opts);
    s.svc.inputLimit = () => 20000;
    const at = val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }));
    const calls = s.calls.filter(isSuggest);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap(handles).length).toBe(2000);
    expect(at).toBeGreaterThanOrEqual(299);
    expect(at).toBeLessThan(1499);
    const whole = setup((c) => (isSuggest(c) ? { question: 'none' } : {}), {}, opts);
    expect(val(await whole.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }))).toBeNull();
    expect(whole.calls.filter(isSuggest)).toHaveLength(1);
  });
});
