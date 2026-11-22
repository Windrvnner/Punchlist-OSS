// @vitest-environment node
// "Check the N left out": a check of only what the latest check left out, while the documents are the ones it checked.
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, finding, itemsIn, Mem, type Call, OK } from './reviewKit';

const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'borrower', 'lender'] });
const TS = doc(2, 'Term sheet.pdf', { pages: 12, words: ['term', 'sheet', 'margin'] });
const IM = doc(3, 'Information memorandum.pdf', { words: ['project', 'capacity', 'sponsor'] });
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, text: `Checklist point ${i + 1} about the credit agreement` }));
const list = (n: number) => () => ({ broad: items(n), product: [], sector: [] });
const LEFT = /^Checklist point [123] about/;                                                        // the three items the deep check gets no usable answer on
const checked = (c: Call) => itemsIn(c).map((it) => it.text);

describe('checking only what the latest check left out', () => {
  async function leftThree() {
    let phase = 0;
    // in the deep check (phase 1) no model answers on points 1 to 3; otherwise every item is satisfied
    const s = setup((c) => ({ items: itemsIn(c).filter((it) => !(phase === 1 && LEFT.test(it.text))).map((it) => ({ id: it.tag, ...OK(c) })) }), { d1: [FA, TS, IM] }, { shared: new Mem(), installId: 'pc', checklist: list(10) });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    phase = 1; const r = val(await s.ai.checkAll({ dealId: 'd1', deep: true })); phase = 2;
    return { s, r };
  }

  it('says what was left out; checks only those; and, leaving nothing out, moves the date as a complete check', async () => {
    const { s, r } = await leftThree();
    expect(r).toMatchObject({ at: null, unchecked: { items: 3, findings: 0 } });
    const before = val(await s.ai.checked('d1')); expect(before.left).toMatchObject({ items: 3, findings: 0, changed: false }); const stood = before.at;                // the first pass's date stands
    const m = s.calls.length; const rest = val(await s.ai.checkAll({ dealId: 'd1', only: 'left' }));
    expect(rest).toMatchObject({ items: 3, findings: 0, unchecked: { items: 0, findings: 0 } }); expect(rest.at).not.toBeNull(); expect(rest.at! > stood!).toBe(true);
    expect(s.calls.slice(m).flatMap(checked).sort()).toEqual(['Checklist point 1 about the credit agreement', 'Checklist point 2 about the credit agreement', 'Checklist point 3 about the credit agreement']);
    const after = val(await s.ai.checked('d1')); expect(after.left).toBeNull(); expect(after.at).toBe(rest.at);
    // nothing left out now: asking again is refused, and costs nothing
    const n = s.calls.length; const again = await s.ai.checkAll({ dealId: 'd1', only: 'left' });
    expect(!again.ok && again.error).toEqual({ kind: 'rejected', message: 'The last check left nothing out' }); expect(s.calls.length).toBe(n);
  });

  it('once the documents have changed, says so and refuses to check only what was left out', async () => {
    const { s } = await leftThree();
    s.recs.d1 = [...s.recs.d1, doc(4, 'Amendment.pdf', { words: ['amendment'] })];
    expect(val(await s.ai.checked('d1')).left).toMatchObject({ items: 3, changed: true });
    const n = s.calls.length; const r = await s.ai.checkAll({ dealId: 'd1', only: 'left' });
    expect(!r.ok && r.error).toEqual({ kind: 'rejected', message: 'The documents have changed since the last check. Press Check again to check everything' }); expect(s.calls.length).toBe(n);
  });

  it('a finding no model gave a usable answer on is left out too, and is looked at again on its own', async () => {
    let phase = 0;
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), { d1: [FA, TS, IM] }, { shared: new Mem(), installId: 'pc', checklist: list(4), verify: () => (phase === 1 ? 'Sorry?' : { stands: true, why: '' }) });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    await finding(s.repo, 'f_1', 'Margin differs', { sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
    phase = 1; expect(val(await s.ai.checkAll({ dealId: 'd1', deep: true }))).toMatchObject({ unchecked: { items: 0, findings: 1 } }); phase = 2;
    expect(val(await s.ai.checked('d1')).left).toMatchObject({ items: 0, findings: 1, changed: false });
    const m = s.calls.length, v = s.verifyCalls.length; const rest = val(await s.ai.checkAll({ dealId: 'd1', only: 'left' }));
    expect(rest).toMatchObject({ items: 0, findings: 1, unchecked: { items: 0, findings: 0 } }); expect(s.calls.length).toBe(m); expect(s.verifyCalls.length).toBeGreaterThan(v);
    expect(val(await s.ai.checked('d1')).left).toBeNull();
  });
});
