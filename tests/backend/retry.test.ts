/** Every AI call is asked again quietly before a failure is shown (decisions: Retries; src/backend/retry.ts). */
import { describe, it, expect } from 'vitest';
import { retrier, curable, BREAK } from '../../src/backend/retry';
import { setup, val, deal, doc, OK, itemsIn, Mem, type Call } from './reviewKit';
import type { Checklist } from '../../src/backend/ai';

const fail = (extra: object = {}) => Object.assign(new Error('said 500: internal'), extra);

describe('the retry policy', () => {
  it('asks a failed or empty call again, waiting longer each time, and gives the last reply or error when the tries are used up', async () => {
    const waits: number[] = []; const retried = retrier({ retries: 2, waitMs: 2000, sleep: async (ms) => { waits.push(ms); } });
    let n = 0; expect(await retried(async () => { if (++n === 1) throw fail(); return 'ok'; })).toBe('ok'); expect(n).toBe(2); expect(waits).toEqual([2000]);
    n = 0; waits.length = 0; expect(await retried(async () => (++n < 3 ? '  ' : 'ok'), (r) => !r.trim())).toBe('ok'); expect(waits).toEqual([2000, 4000]);
    n = 0; expect(await retried(async () => { n++; return ''; }, (r) => !r)).toBe(''); expect(n).toBe(3);   // still empty: returned as it is, for the caller to treat as it always has
    n = 0; await expect(retried(async () => { n++; throw fail(); })).rejects.toThrow(/500/); expect(n).toBe(3);
  });

  it('what has its own path is not asked again: unreachable, cut off, too long, gone, a spent search, a sign-in, a request refused as asked', async () => {
    for (const e of [fail({ code: 'unreachable' }), fail({ code: 'cutoff' }), fail({ code: 'toolong' }), fail({ code: 'gone' }), fail({ code: 'spent' }), fail({ signedOut: true }), fail({ status: 400 }), fail({ status: 404 }), fail({ status: 422 })]) {
      expect(curable(e)).toBe(false);
      let n = 0; const retried = retrier({ retries: 2, sleep: async () => {} });
      await expect(retried(async () => { n++; throw e; })).rejects.toBe(e); expect(n).toBe(1);
    }
    for (const e of [fail(), fail({ status: 500 }), fail({ status: 503 }), new SyntaxError('Unexpected end of JSON input'), new Error('declined to answer this'), null, undefined]) expect(curable(e)).toBe(true);
  });

  it(`after ${BREAK} calls in a row fail on every try, calls are tried once until one succeeds, so an outage does not triple the calls`, async () => {
    const retried = retrier({ retries: 2, sleep: async () => {} }); let n = 0; let up = false;
    const call = () => retried(async () => { n++; if (!up) throw fail(); return 'ok'; }).catch(() => 'failed');
    for (let i = 0; i < BREAK; i++) await call(); expect(n).toBe(BREAK * 3);
    n = 0; await call(); await call(); expect(n).toBe(2);                         // tried once each
    up = true; n = 0; expect(await call()).toBe('ok'); expect(n).toBe(1);
    up = false; n = 0; await call(); expect(n).toBe(3);                           // a success puts the retries back
    expect(retrier({ retries: 0 }).retriesFor()).toBe(0); expect(retried.retriesFor()).toBe(2);                     // what the chat asks before it starts a new conversation
    up = false; for (let i = 0; i < BREAK; i++) await call(); expect(retried.retriesFor()).toBe(0); expect(retried.retriesFor('other')).toBe(2);
  });

  it('the run of failures is counted per model: one model down while another answers stops being asked again', async () => {
    const retried = retrier({ retries: 2, sleep: async () => {} }); let down = 0;
    const call = (model: string) => retried(async () => { if (model === 'standard') { down++; throw fail(); } return 'ok'; }, undefined, model).catch(() => 'failed');
    for (let i = 0; i < BREAK + 3; i++) { await call('standard'); await call('fast'); }
    expect(down).toBe(BREAK * 3 + 3);                                             // after BREAK calls of three tries, one try each
  });

  it('the waits are capped, and a call that already had a try elsewhere has that many fewer here', async () => {
    const waits: number[] = []; const retried = retrier({ retries: 5, waitMs: 1000, sleep: async (ms) => { waits.push(ms); } }); let n = 0;
    await retried(async () => { n++; throw fail(); }).catch(() => {}); expect(n).toBe(6); expect(waits).toEqual([1000, 2000, 4000, 4000, 4000]);
    n = 0; waits.length = 0; await retried(async () => { n++; throw fail(); }, undefined, 'other', 1).catch(() => {}); expect(n).toBe(5); expect(waits).toEqual([1000, 2000, 4000, 4000, 4000]);   // the first is its retry's wait
  });

  it('a call that succeeds after a retry counts as a success: the run of failures starts again', async () => {
    const retried = retrier({ retries: 2, sleep: async () => {} }); let n = 0;
    for (let i = 0; i < BREAK * 3; i++) expect(await retried(async () => { if (++n % 2) throw fail(); return 'ok'; })).toBe('ok');
    expect(n).toBe(BREAK * 3 * 2);
  });
});

describe('every AI feature gets it', () => {
  /** a checklist of deal size: 2,100 items across the layers */
  const big: Checklist = { broad: Array.from({ length: 1500 }, (_, i) => ({ id: `b${i}`, text: `Broad requirement number ${i} is met by the documents` })), product: Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, text: `Structure requirement ${i} holds` })), sector: Array.from({ length: 300 }, (_, i) => ({ id: `s${i}`, text: `Sector requirement ${i} holds` })) };
  const docs = { d1: [doc(1, 'Credit Agreement.pdf', { summary: 'Senior credit agreement.', keywords: ['lock-up'] }), doc(2, 'Term sheet.pdf', { summary: 'Term sheet.', keywords: ['margin'] })] };
  const reply = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });

  it('a first pass of 2,100 items whose every call fails once, or comes back empty once, settles every item, and the usage log counts each try', async () => {
    const clean = setup((c) => (itemsIn(c).length ? reply(c) : {}), docs, { checklist: () => big, shared: new Mem(), installId: 'pc' }); await deal(clean.repo);
    const expected = val(await clean.ai.firstPass('d1')); expect(expected.unsettled).toEqual([]); expect(clean.calls.filter((c) => itemsIn(c).length).length).toBeGreaterThan(100);   // every item really goes to the model
    for (const how of ['fails', 'empty'] as const) {
      const seen = new Set<string>(); const usage: { calls: { calls: number }[] }[] = [];
      const s = setup((c) => { if (!itemsIn(c).length) return {}; const key = c.model + c.prompt; if (!seen.has(key)) { seen.add(key); if (how === 'fails') throw fail(); return ''; } return reply(c); }, docs, { checklist: () => big, shared: new Mem(), installId: 'pc', usage: (e) => usage.push(e as never) });
      await deal(s.repo);
      const r = val(await s.ai.firstPass('d1'));
      expect(r.unsettled).toEqual([]); expect({ gaps: r.gaps.length, written: r.written.length }).toEqual({ gaps: expected.gaps.length, written: expected.written.length });   // as if nothing had failed
      const asked = s.calls.filter((c) => itemsIn(c).length);
      expect(asked.length).toBe(seen.size * 2);                                   // each call asked twice: once failing, once answered
      expect(usage.flatMap((u) => u.calls).reduce((a, l) => a + l.calls, 0)).toBeGreaterThanOrEqual(asked.length);
    }
  }, 60_000);

  it('a draft whose first reply is empty is asked again and drafted; one that fails every try says so, as it always has', async () => {
    let n = 0; const s = setup((c) => (itemsIn(c).length ? {} : ++n === 1 ? '' : { status: 'found', text: 'The lock-up ratio is 1.25x. [D1 p. 3]', sources: [{ doc: 'D1', page: 3 }] }), docs, {});
    await deal(s.repo);
    const r = await s.ai.draft({ dealId: 'd1', questionId: 'q1', questionText: 'What is the lock-up ratio?' });
    expect(r.ok).toBe(true); expect(n).toBeGreaterThanOrEqual(2);
    const down = setup((c) => { if (!itemsIn(c).length && !c.prompt.includes('Which')) throw fail(); return {}; }, docs, {});
    await deal(down.repo);
    const d = await down.ai.draft({ dealId: 'd1', questionId: 'q1', questionText: 'What is the lock-up ratio?' });
    expect(d.ok).toBe(false);
  });

  it('a service that cannot be reached is not asked again here: the connectors and the checks wait for it', async () => {
    let n = 0; const s = setup((c) => { if (!itemsIn(c).length) return {}; n++; throw fail({ code: 'unreachable' }); }, docs, { checklist: () => ({ broad: big.broad.slice(0, 40), product: [], sector: [] }) });
    await deal(s.repo);
    const r = await s.ai.firstPass('d1'); expect(!r.ok && r.error.kind).toBe('unreachable');
    expect(n).toBeLessThanOrEqual(2);
  });
});
