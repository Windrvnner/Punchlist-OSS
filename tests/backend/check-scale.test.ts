// @vitest-environment node
// Check again at the size of a real deal: 2,000 checklist items and open findings, on the stand-in model, which
// answers at once, so the time measured is the app's own. It took minutes before, because the quick check's sample was
// drawn again, hashing the whole pool, for every piece on every pass.
import { it, expect } from 'vitest';
import { setup, doc, val, deal, Mem, itemsIn, OK, type Call } from './reviewKit';

const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement'] });
const N = 2000; const BUDGET_MS = 15_000;                                                                  // under a second here; the budget leaves room for a busy machine
const items = Array.from({ length: N }, (_, i) => ({ id: `c${i + 1}`, text: `Checklist point ${i + 1} about the credit agreement` }));
/** every item satisfied, except every 40th, which the first pass raises as a finding: Check again reads the other 1,950 items and the 50 open findings */
const reply = (c: Call) => ({ items: itemsIn(c).map((it) => { const k = +/point (\d+)/.exec(it.text)![1];
  return k % 40 ? { id: it.tag, ...OK(c) } : { id: it.tag, result: 'finding', title: `Point ${k} differs from the term sheet`, workstream: 'Legal', body: ['It differs. [1]'], sources: [{ doc: 'D1', page: 2 }] }; }) });

it(`Check again on ${N.toLocaleString('en-US')} items and their findings takes seconds, not minutes`, async () => {
  const s = setup(reply, { d1: [FA] }, { shared: new Mem(), installId: 'pc', checklist: () => ({ broad: items, product: [], sector: [] }) }); await deal(s.repo);
  val(await s.ai.firstPass('d1'));
  const t = performance.now(); const r = val(await s.ai.checkAll({ dealId: 'd1' })); const ms = performance.now() - t;
  expect(r).toMatchObject({ items: N - 50, findings: 50, unchecked: { items: 0, findings: 0 } });
  expect(r.sample).toEqual({ size: 200, overturned: 0 });                                                 // 1,950 looks and 50 findings passed: a tenth
  expect(ms).toBeLessThan(BUDGET_MS);
}, 120_000);
