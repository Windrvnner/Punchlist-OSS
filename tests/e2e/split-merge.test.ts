// @vitest-environment node
// Two PCs that each opened a first pass while out of sync: what a batch still out on the PC whose round is merged away
// comes to counts in the round it was merged into (#795). End to end on the real backend, as in split.test.ts.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import { pair, aiOf, roots, checks, logOf, roundsOf, allEnded, until, numOf, rowsOf as rows, FAST, type Pair }
  from './splitKit';
import { itemsIn, val } from '../backend/reviewKit';

afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const ITEMS = 400;
const LAPSE = 4000;
/** the item the office raises a finding on, in its first block; the laptop passes it */
const FOUND = 3;
/** a call that checks item 3 (not one that only names it, such as a search) */
const checksFound = (c: { model: string; prompt: string }) =>
  itemsIn(c as Parameters<typeof itemsIn>[0]).some((it) => numOf(it.text) === FOUND);

type Release = 'merged' | 'done' | 'later' | 'closed' | 'slept';
/**
 * The laptop opens its round first, so the office's round is the one merged away. The office's first block waits
 * until the office has written the merge (`merged`), until the kept round has ended too (`done`), or until a later
 * check has run after that (`later`), until the office has closed after that (`closed`), or until the office has
 * slept after that (`slept`), then raises a finding on item 3, which the laptop has already passed.
 */
async function mergeWhileOut(release: Release) {
  let merging = false;
  let asleep = 0;                                          // how far the office's clock has jumped, as after a sleep
  const p = await pair({
    items: ITEMS,
    nowA: () => Date.now() + asleep,
    timing: { lapse: LAPSE },                              // a busy machine's pauses are not taken for a sleep (#131)
    scriptA: {
      delay: 20,
      finding: (n) => n === FOUND,
      hold: (c) => (merging && checksFound(c) ? held() : undefined),
    },
    scriptB: { delay: 5 },
  });
  const aId = p.A.backend.installId;
  const mergedByOffice = () => logOf(p.sync.A, p.dealId).some((l) => l.merged && l.pc === aId);
  const keptDone = () => {
    p.net.now();
    return [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.end?.kind === 'done');
  };
  const laterDone = () => {
    p.net.now();
    return [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.def.kind !== 'first' && r.end?.kind === 'done');
  };
  const held = async () => {
    await until('the office to merge its round away', mergedByOffice, 30000);
    if (release !== 'merged') await until('the kept round to end', keptDone, 60000);
    if (release === 'later') await until('the later check to end', laterDone, 60000);
    if (release === 'closed') await p.A.backend.close();
    if (release === 'slept') await sleepAfterEnd();
  };
  /** the office's watcher has seen the kept round end; then the office sleeps for longer than a lapse */
  const sleepAfterEnd = async () => {
    await new Promise((r) => setTimeout(r, 20 * FAST.watch!));
    asleep = 3 * LAPSE;
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

  for (const release of ['closed', 'slept'] as const) it(`once the PC has ${release}, it is not written`, async () => {
    const { p, both } = await mergeWhileOut(release);
    try {
      await Promise.allSettled([both]);
      await until('every round to end', () => {
        p.net.now();
        return [...roundsOf(p.sync.A, p.dealId).values()].every((r) => r.end);
      }, 60000);
      const aId = p.A.backend.installId;
      expect(logOf(p.sync.A, p.dealId).filter((l) => l.pc === aId && l.item)).toEqual([]);
    } finally { p.close(); }
  }, 120000);
});
