// @vitest-environment node
// The model's reading of which open question a chat answer addresses (#1120), for the suggested open question card.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, qid, type Call } from './reviewKit';

const questions = (n: number) =>
  Array.from({ length: n }, (_, k) => ({ id: qid(k + 1), text: `Please provide document ${k + 1} for the lenders` }));
const opts = { shared: new Mem(), installId: 'pc' };

describe('the open question an answer addresses', () => {
  const isSuggest = (c: Call) => c.prompt.includes('Which one of these open questions does the answer address');
  /** the ids a call shows, each on its own line */
  const shown = (c: Call) => [...c.prompt.matchAll(/^(q_[0-9A-Z]{26}): /gm)].map((m) => m[1]);
  const answer = 'The base case follows the technical advisor at 98% availability, as in Q3 2027.';

  it('shows each question by its permanent id, never its number, and returns the id the reply names', async () => {
    const asked = [
      { id: qid(7), text: 'Q7 Provide the insurance certificates' },
      { id: qid(9), text: 'Which operating assumption does the base case use?' },
    ];
    const s = setup((c) => (isSuggest(c) ? { question: ` ${qid(9)} ` } : {}), {}, opts);
    expect(val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: asked }))).toEqual([qid(9)]);
    const call = s.calls.filter(isSuggest)[0];
    expect(shown(call)).toEqual([qid(7), qid(9)]);
    expect(call.prompt).not.toMatch(/\bA\d+:/);
    expect(call.prompt).toContain(answer);
    expect(call.files).toEqual([]);
    expect(call.model).toBe('standard');
  });

  it('none proposes no question', async () => {
    const s = setup((c) => (isSuggest(c) ? { question: 'none' } : {}), {}, opts);
    expect(val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2) }))).toEqual([]);
    expect(s.calls.filter(isSuggest)).toHaveLength(1);
  });

  it('an id not shown, or no id at all, is a failed reply asked again; still wrong, none is proposed', async () => {
    for (const named of [qid(99), 'Q2', 2, null]) {
      const s = setup((c) => (isSuggest(c) ? { question: named } : {}), {}, opts);
      const r = await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2) });
      expect(r.ok).toBe(false);
      expect(s.calls.filter(isSuggest).length).toBeGreaterThan(1);
    }
    // a corrected reply is taken
    let asked = 0;
    const fixed = setup((c) => (isSuggest(c) ? { question: asked++ === 0 ? qid(99) : qid(2) } : {}), {}, opts);
    expect(val(await fixed.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2) }))).toEqual([qid(2)]);
  });

  it('at 2,000 open questions the calls are sized to the input limit; every part named is kept', async () => {
    // the model names the last question of every part that shows document 300 or document 1500, by its id
    const s = setup((c) => {
      if (!isSuggest(c)) return {};
      const named = c.prompt.includes('document 300 for') || c.prompt.includes('document 1500 for');
      return { question: named ? shown(c).at(-1) : 'none' };
    }, {}, opts);
    s.svc.inputLimit = () => 20000;
    const places = val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }));
    const calls = s.calls.filter(isSuggest);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flatMap(shown)).toHaveLength(2000);
    expect(places).toHaveLength(2);
    expect(places[0] < places[1]).toBe(true);
    const whole = setup((c) => (isSuggest(c) ? { question: 'none' } : {}), {}, opts);
    expect(val(await whole.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }))).toEqual([]);
    expect(whole.calls.filter(isSuggest)).toHaveLength(1);
  });

  it('a later part that fails keeps what earlier parts named; none named, the failure is returned', async () => {
    const down = Object.assign(new Error('down'), { code: 'ECONNRESET' });
    const s = setup((c) => {
      if (!isSuggest(c)) return {};
      if (c.prompt.includes('document 1500 for')) throw down;
      return { question: c.prompt.includes('document 300 for') ? shown(c).at(-1) : 'none' };
    }, {}, opts);
    s.svc.inputLimit = () => 20000;
    const places = val(await s.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) }));
    expect(places).toHaveLength(1);
    expect(places[0] <= qid(1499)).toBe(true);
    const none = setup((c) => {
      if (isSuggest(c) && c.prompt.includes('document 1500 for')) throw down;
      return isSuggest(c) ? { question: 'none' } : {};
    }, {}, opts);
    none.svc.inputLimit = () => 20000;
    const r = await none.ai.suggestQuestion!({ dealId: 'd1', answer, questions: questions(2000) });
    expect(r.ok).toBe(false);
  });
});
