// @vitest-environment node
// Two PCs that each opened a first pass while out of sync: what a batch still out on the PC whose round is merged away
// comes to counts in the round it was merged into (#795). End to end on the real backend, as in split.test.ts.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { pair, aiOf, roots, checks, logOf, roundsOf, allEnded, until, numOf, type Pair } from './splitKit';
import { itemsIn } from '../backend/reviewKit';

afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const val = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const rows = async (P: Pair['A'], dealId: string) => val(await P.backend.ai.checklist!(dealId))
  .map((r) => `${r.id}:${r.result}${r.findingId ? `:${r.findingId}` : ''}`).sort();
const ITEMS = 400;
/** the item the office raises a finding on, in its first block; the laptop passes it */
const FOUND = 3;
/** a call that checks item 3 (not one that only names it, such as a search) */
const checksFound = (c: { model: string; prompt: string }) =>
  itemsIn(c as Parameters<typeof itemsIn>[0]).some((it) => numOf(it.text) === FOUND);

type Release = 'merged' | 'done' | 'later';
/**
 * The laptop opens its round first, so the office's round is the one merged away. The office's first block waits
 * until the office has written the merge (`merged`), until the kept round has ended too (`done`), or until a later
 * check has run after that (`later`), then raises a finding on item 3, which the laptop has already passed.
 */
async function mergeWhileOut(release: Release) {
  let merging = false;
  const p = await pair({
    items: ITEMS,
    scriptA: {
      delay: 20,
      finding: (n) => n === FOUND,
      hold: (c) => (merging && checksFound(c) ? held() : undefined),
    },
    scriptB: { delay: 5 },
  });
  const aId = p.A.backend.installId;
  const mergedByOffice = () => logOf(p.sync.A, p.dealId).some((l) => l.merged && l.pc === aId);
  const keptDone = () => { p.net.now(); return [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.end?.kind === 'done'); };
  const laterDone = () => {
    p.net.now();
    return [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.def.kind !== 'first' && r.end?.kind === 'done');
  };
  const held = async () => {
    await until('the office to merge its round away', mergedByOffice, 30000);
    if (release !== 'merged') await until('the kept round to end', keptDone, 60000);
    if (release === 'later') await until('the later check to end', laterDone, 60000);
  };
  p.net.pause('both');
  const b = aiOf(p.B).firstPass(p.dealId);
  await until('the laptop to open its round', () => logOf(p.sync.B, p.dealId).some((l) => l.plan));
  await until('the laptop to pass item 3', () => checks(p.svcB).some(([, ns]) => ns.includes(FOUND)));
  merging = true;
  const a = aiOf(p.A).firstPass(p.dealId);
  await until('the office to send item 3', () => checks(p.svcA).some(([, ns]) => ns.includes(FOUND)));
  p.net.resume();
  const later = release === 'later'
    ? until('the kept round to end', keptDone, 60000).then(() => p.B.backend.ai.checkAll!({ dealId: p.dealId }))
    : undefined;
  return { p, both: Promise.all([a, b, later]) };
}
/** both PCs show the same rows once synced, and `ok` holds of them */
async function settled(p: Pair, ok: (rows: string[]) => boolean) {
  await until('both PCs to show the same rows', async () => {
    p.net.now();
    await p.A.backend.repo.sync!();
    await p.B.backend.repo.sync!();
    const ra = await rows(p.A, p.dealId);
    return ra.join() === (await rows(p.B, p.dealId)).join() && ok(ra);
  }, 20000).catch(() => undefined);
  const ra = await rows(p.A, p.dealId);
  expect(ra.length).toBe(ITEMS);
  expect(await rows(p.B, p.dealId)).toEqual(ra);
  return ra;
}
const isFound = (r: string) => r.startsWith(`c${FOUND}:finding:`);

describe('a batch still out when its round is merged away (#795)', () => {
  for (const release of ['merged', 'done'] as const) {
    const when = release === 'done' ? 'after the kept round has ended' : 'while the kept round runs';
    it(`its finding counts, ${when}, on both PCs`, async () => {
      const { p, both } = await mergeWhileOut(release);
      try {
        await both;
        await allEnded(p, 60000);
        const ends = [...roundsOf(p.sync.A, p.dealId).values()].map((r) => r.end?.kind).sort();
        expect(ends).toEqual(['done', 'merged']);
        const ra = await settled(p, (all) => all.some(isFound));
        expect(ra.find((r) => r.startsWith(`c${FOUND}:`))).toMatch(new RegExp(`^c${FOUND}:finding:f_`));
        const found = val(await p.A.backend.repo.list('finding', p.dealId));
        expect(found.map((l) => (l.envelope.data as { itemId?: string }).itemId)).toEqual([`c${FOUND}`]);
      } finally { p.close(); }
    }, 120000);
  }

  it('once a later check has run, it does not take the place of that check\'s results', async () => {
    const { p, both } = await mergeWhileOut('later');
    try {
      await both;
      await allEnded(p, 60000);
      const ra = await settled(p, () => true);
      expect(ra.find((r) => r.startsWith(`c${FOUND}:`))).toBe(`c${FOUND}:satisfied`);   // as the later check left it
    } finally { p.close(); }
  }, 120000);
});
