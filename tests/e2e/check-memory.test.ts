// @vitest-environment node
// Memory across repeated checks at deal scale: a 2,000-item deal checked again and again on one PC must not keep
// more memory after each check. Before the fix the backend held 1.7 GB more after the third check than after the first,
// and 3.6 GB in all after the fourth, until the PC ran out of memory.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';
import { tmp, put, pdf, pcApp, newDeal, StandInService } from './kit';
import { isPickAsk, isPickForAsk, isDescribeAsk, isAffectsAsk, isVerifyAsk, isHearAsk, itemsIn, OK, val, type Call } from '../backend/reviewKit';

const ITEMS = 2000, DOCS = 120, CHECKS = 3;
const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** a model that answers at once and finds every item satisfied */
const model = () => new StandInService((x) => {
  const c = x as Call;
  if (isDescribeAsk(c)) return JSON.stringify({ summary: 'An agreement.', keywords: ['agreement'] });
  if (isPickAsk(c) || isPickForAsk(c)) return 'I cannot say';
  const items = itemsIn(c);
  if (items.length) return JSON.stringify({ items: items.map((it) => ({ id: it.tag, ...OK(c) })) });
  if (isAffectsAsk(c)) return JSON.stringify({ items: [], findings: [] });
  if (isHearAsk(c)) return JSON.stringify({ affected: [] });
  if (isVerifyAsk(c)) return JSON.stringify({ stands: true, why: '' });
  return JSON.stringify({ text: 'It is signed. [1]', sources: [{ doc: 'D1', page: 1 }] });
});

/** the heap in use, in MB, after a full garbage collection (`gc` is turned on here, so the test needs no node flag) */
v8.setFlagsFromString('--expose-gc'); const gc = vm.runInNewContext('gc') as () => void;
const heapMb = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1e6; };

describe('memory across repeated checks', () => {
  it(`a ${ITEMS}-item deal checked ${CHECKS} times keeps no more memory after each check`, async () => {
    const root = tmp(); roots.push(root); const vdr = path.join(root, 'vdr');
    for (let i = 0; i < DOCS; i++) put(vdr, `${String(i % 12).padStart(2, '0')} Legal/Agreement ${i}.pdf`, pdf(`agreement number ${i} signed and dated`, 2));
    const svc = model();
    const A = await pcApp(root, 'Office', { service: svc, checklist: () => ({ broad: Array.from({ length: ITEMS }, (_, i) => ({ id: `b${i}`, text: `Agreement number ${i} is signed and dated` })), product: [], sector: [] }) });
    const dealId = await newDeal(A, 'Proseware', vdr, 150_000);
    const heap: number[] = [];
    for (let k = 0; k < CHECKS; k++) {
      val(await A.backend.ai.checkAll!({ dealId, deep: true })); await A.backend.idle();
      svc.calls.length = 0;                                                     // the stand-in's own record of prompts is not the app's
      heap.push(heapMb());
    }
    await A.backend.close();
    // the check log grows by about 2,000 lines a check, well under 10 MB; before the fix this was 1,700 MB
    expect(heap[CHECKS - 1] - heap[0], `heap after each check, MB: ${heap.map(Math.round).join(', ')}`).toBeLessThan(100);
  }, 600000);
});
