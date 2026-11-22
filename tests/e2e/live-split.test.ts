// @vitest-environment node
// Two PCs sharing one deal's first pass on a real model (docs/architecture.md, Checks, and how PCs share them). It runs only through
// npm run e2e:live, and is skipped otherwise. Light: every call goes to Haiku, with a cap on calls per PC.
//   npm run e2e:live -- tests/e2e/live-split.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { pair, aiOf, roots, allEnded, logOf } from './splitKit';
import { put, pdf } from './kit';
import { claudeService } from '../../src/backend/claude';
import { itemsIn } from '../backend/reviewKit';

// only on a run that asks for live calls (npm run e2e:live sets PUNCHLIST_LIVE=1), never because a key is set
const KEY = process.env.PUNCHLIST_LIVE === '1' ? process.env.PUNCHLIST_AI_KEY : undefined;
const LIST = [
  { id: 'b1', text: 'The distribution lock-up ratio is the same in the credit agreement and the term sheet' },
  { id: 'b2', text: 'The term sheet is signed by the lenders and the borrower' },
  { id: 'b3', text: 'The financial model has been audited by an independent model auditor' },
  { id: 'b4', text: 'The credit agreement sets a final maturity date' },
];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

describe.skipIf(!KEY)('two PCs sharing a first pass on Claude (live)', () => {
  it('both PCs check the list together: every item comes to a result once, and both show the same', async () => {
    const svcA = claudeService({ key: KEY!, maxCalls: 30, who: 'Office' }), svcB = claudeService({ key: KEY!, maxCalls: 30, who: 'Laptop' });
    const room = (dir: string) => {
      put(dir, '01 Finance/Credit Agreement.pdf', pdf('Clause 21.3 Distribution lock-up. The Borrower may make a Distribution only if the historic DSCR is at least 1.25x. Clause 7.1 Final Maturity Date: June 30, 2041.', 2));
      put(dir, '01 Finance/Term sheet signed.pdf', pdf('Term sheet. Distribution lock-up DSCR 1.30x. Signed by the Lenders and the Borrower on November 4, 2026', 2));
    };
    const p = await pair({ list: LIST, room, serviceA: svcA, serviceB: svcB, batch: 1, timing: { lapse: 60_000, renew: 10_000, watch: 200 } });
    try {
      await Promise.all([aiOf(p.A).firstPass(p.dealId), aiOf(p.B).firstPass(p.dealId)]); await allEnded(p, 120_000);
      await p.A.backend.repo.sync!(); await p.B.backend.repo.sync!();
      const rows = async (P: typeof p.A) => { const r = await P.backend.ai.checklist!(p.dealId); if (!r.ok) throw new Error(r.error.message); return r.value; };
      const ra = await rows(p.A), rb = await rows(p.B);
      console.log('live split rows: ' + JSON.stringify(ra.map((r) => ({ id: r.id, result: r.result, need: r.need }))));
      expect(ra.map((r) => `${r.id}:${r.result}`)).toEqual(rb.map((r) => `${r.id}:${r.result}`));
      expect(ra.filter((r) => r.result === 'unchecked' || r.result === 'unsettled').map((r) => `${r.id}: ${r.why ?? r.result}`)).toEqual([]);
      // each item was given to the standard tier once, by one PC or the other (a second look for what an item needs comes after its first)
      const lines = logOf(p.sync.A, p.dealId); const results = lines.filter((l) => l.item && l.result && l.round);
      expect(new Set(results.map((l) => l.item)).size).toBe(LIST.length); expect(results.length).toBe(LIST.length);
      const done = lines.find((l) => l.done?.round)!; const members = new Set(lines.filter((l) => l.member?.round === done.done!.round).map((l) => l.member!.pc)); expect(members.size).toBe(2);   // both PCs were in the round
      console.log(`live split: items checked by ${[...new Set(results.map((l) => l.pc!.slice(0, 4)))].join(' and ')}`);
      expect(ra.find((r) => r.id === 'b1')!.result).toBe('finding'); expect(ra.find((r) => r.id === 'b3')!.result).toBe('gap');
    } finally {
      for (const [w, s] of [['office', svcA], ['laptop', svcB]] as const) console.log(`live split, ${w}: ${s.use.calls} calls, ${s.use.input} tokens in, ${s.use.output} out, by model ${JSON.stringify(s.use.byModel)}`);
      void itemsIn; p.close();
      for (const s of [svcA, svcB]) for (const id of [...s.use.uploaded]) await s.remove(id);   // leave nothing in the account's file store
    }
  }, 300000);
});
