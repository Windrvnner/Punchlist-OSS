// @vitest-environment node
// Two PCs sharing one deal's checks, end to end on the real backend (docs/architecture.md, Checks, and how PCs share them): each PC indexes
// its own copy of the data room and syncs its own folder; a link stands in for OneDrive; the model is a stand-in.
import { describe, it, expect, afterAll } from 'vitest';
import { control, SERVICE } from '../../src/control';
import fs from 'node:fs';
import {
  pair, aiOf, stallFreeClock, roots, checks, verifies, logOf, roundsOf, allEnded, until, FAST, type Pair,
} from './splitKit';
import { SetFindingStatus, DeleteFinding } from '../../src/app/commands/findings';
import { view } from '../../src/backend/rounds';
import { roundOfWork } from '../../src/backend/roundsObserver';
import { itemsIn } from '../backend/reviewKit';

afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
const val = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => { if (!r.ok) throw new Error(r.error.message); return r.value; };
/** every item checked by the standard model, across both PCs, with how many times */
const tally = (p: Pair) => { const all = [...checks(p.svcA), ...checks(p.svcB)].filter(([m]) => m !== 'fast').flatMap(([, ns]) => ns); const out = new Map<number, number>(); for (const n of all) out.set(n, (out.get(n) ?? 0) + 1); return out; };
/** how one PC sees the deal's rounds, for a message when a test goes wrong */
const state = (p: Pair, w: 'A' | 'B') => JSON.stringify([...roundsOf(p.sync[w], p.dealId).values()].map((x) => ({ id: x.def.id.slice(-6), kind: x.def.kind, end: x.end?.kind, members: [...x.members.keys()].map((k) => k.slice(0, 4)), left: [...x.left].map((k) => k.slice(0, 4)) })));
const rows = async (P: Pair['A'], dealId: string) => val(await P.backend.ai.checklist!(dealId)).map((r) => `${r.id}:${r.result}${r.findingId ? ':' + r.findingId : ''}`).sort();
const findings = async (P: Pair['A'], dealId: string) => val(await P.backend.repo.list('finding', dealId)).map((l) => `${(l.envelope.data as any).id} ${(l.envelope.data as any).title}`).sort();

/**
 * A laptop that drops off at a set point: inside a batch, once every line it wrote before that batch has reached the
 * office, the link from it is paused and the batch never answers. So the batch in flight is the only work of the
 * laptop that the office does not see. Pausing whenever a test happens to look could instead fall just after the
 * laptop finished a batch, before that batch's lines reached the office, which then rightly does it again too (#131).
 */
function laptopDropsOff(p: Pair) {
  const laptopId = p.B.backend.installId;
  const laptopLines = (dir: string) => logOf(dir, p.dealId).filter((l) => l.pc === laptopId).length;
  const never = new Promise<void>(() => undefined);
  const drop = { at: 0, inBatch };
  async function inBatch() {
    if (drop.at) return never;
    await until('the office to have every line the laptop wrote', () => laptopLines(p.sync.A) >= laptopLines(p.sync.B));
    p.net.pause('ba');
    drop.at = Date.now();
    return never;
  }
  return drop;
}

describe('two PCs share a deal\'s checks', () => {
  it('1. started together: every piece is done once, the work is split, and both show the same results and codes', async () => {
    // meet: the office's model calls wait until the laptop has joined, so "together" holds on a busy machine too; otherwise the
    // office could finish every block before the laptop's first (#131)
    // stallFreeClock: a PC starved of CPU for a lapse does not take itself to have slept and redo its batch (#1230)
    const p = await pair({
      meet: true,
      items: 100,
      scriptA: { finding: (n) => n % 9 === 0 },
      scriptB: { finding: (n) => n % 9 === 0 },
      nowA: stallFreeClock(),
      nowB: stallFreeClock(),
    });
    try {
      await Promise.all([aiOf(p.A).firstPass(p.dealId), aiOf(p.B).firstPass(p.dealId)]); await allEnded(p);
      // if both opened a round before either saw the other's (within one sync gap), the two were merged, and what each did before then may have been done by both (accepted in the design); otherwise every item once
      const merged = [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.end?.kind === 'merged');
      // otherwise at most one block twice: two PCs can take the same unclaimed block within one sync gap, when one has been slow to show progress (bounded overlap, as designed)
      const t = tally(p); expect(t.size).toBe(100); if (!merged) expect([...t.values()].filter((x) => x > 1).length, JSON.stringify([...t].filter(([, x]) => x > 1))).toBeLessThanOrEqual(10);
      const a = checks(p.svcA).filter(([m]) => m !== 'fast').length, b = checks(p.svcB).filter(([m]) => m !== 'fast').length; expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(0);
      await p.A.backend.repo.sync!(); await p.B.backend.repo.sync!();
      expect(await rows(p.A, p.dealId)).toEqual(await rows(p.B, p.dealId)); expect((await rows(p.A, p.dealId)).filter((r) => r.includes(':finding:')).length).toBe(11);
      const fa = await findings(p.A, p.dealId); expect(fa.length).toBe(11); expect(new Set(fa.map((x) => x.split(' ')[0])).size).toBe(11); expect(await findings(p.B, p.dealId)).toEqual(fa);
      expect([...roundsOf(p.sync.A, p.dealId).values()].filter((r) => r.end?.kind === 'done').length).toBe(1);
    } finally { await p.close(); }
  }, 60000);

  it('2. a second PC joins half-way: it takes its share at its next batch, and nothing is done twice beyond the one block the known limit allows', async () => {
    // stallFreeClock: a PC starved of CPU for a lapse does not take itself to have slept and redo its batch (#1230)
    const p = await pair({ items: 100, scriptA: { delay: 60 }, nowA: stallFreeClock(), nowB: stallFreeClock() });
    try {
      const a = aiOf(p.A).firstPass(p.dealId);
      await until('the office to be part-way', () => checks(p.svcA).length >= 2);
      // the office waits on its next call until the laptop has joined its round and checked a block of its own, so that
      // "half-way" holds on a busy machine too: otherwise the office could finish every block left before the laptop's
      // first batch (#131)
      const bId = p.B.backend.installId;
      const working = () => logOf(p.sync.A, p.dealId).some((l) => l.member?.pc === bId) && checks(p.svcB).length > 0;
      const laptopWorking = () => until('the laptop to join the round and check a block', working, 30000);
      p.svcA.set({ delay: 60, hold: () => (working() ? undefined : laptopWorking()) });
      await aiOf(p.B).firstPass(p.dealId); await a; await allEnded(p);
      // at most one block twice: the laptop can claim the block the office has just claimed before that claim reaches it, the known
      // limit in docs/decisions.md ("two PCs that claim the same work within one OneDrive sync delay can both run it"); seen on a busy machine (GitHub #131)
      const t = tally(p); expect(t.size).toBe(100); expect([...t.values()].filter((x) => x > 1).length, JSON.stringify([...t].filter(([, x]) => x > 1))).toBeLessThanOrEqual(10); expect(checks(p.svcB).length).toBeGreaterThan(0);
      // the laptop joined: it did not open a round of its own. The office renews its opening while it prepares, by the
      // clock, so a busy machine can write it more than once (#131)
      const openings = new Set(logOf(p.sync.A, p.dealId).filter((l) => l.opening).map((l) => l.opening!.id));
      expect(openings.size).toBe(1);
    } finally { await p.close(); }
  }, 60000);

  it('17. one PC alone: today\'s calls in today\'s order, at once', async () => {
    // Use the shipped membership lapse while measuring prompt solo work (#131).
    const p = await pair({
      items: 25, one: true, scriptA: { finding: (n) => n === 3 },
      timing: { lapse: control.timings.roundLapse },
    });
    try {
      const t0 = Date.now(); const r = val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p);
      expect(checks(p.svcA)).toEqual([['standard', Array.from({ length: 10 }, (_, i) => i + 1)], ['standard', Array.from({ length: 10 }, (_, i) => i + 11)], ['standard', [21, 22, 23, 24, 25]]]);
      expect(r.written.length).toBe(1); expect(checks(p.svcB).length).toBe(0);
      // the third-party reports sweep claims its own work and writes its own lines (reports.ts): left out here, as it
      // runs beside the round
      const sweepKeys = (l: { claim?: unknown; release?: unknown }) =>
        ((l.claim ?? l.release) as { keys?: string[] } | undefined)?.keys;
      const isSweeps = (l: { claim?: unknown; release?: unknown; report?: unknown }) =>
        !!l.report || sweepKeys(l)?.every((k) => k.startsWith('reports:'));
      const kindOf = (l: object) => Object.keys(l).find((k) => !['v', 'at', 'n', 'pc'].includes(k));
      const roundLines = logOf(p.sync.A, p.dealId).filter((l) => !isSweeps(l));
      expect(roundLines.filter((l) => kindOf(l) === 'item').length).toBe(25);
      // a slow machine may renew its membership, or its opening while it prepares, on the way: renewals are by the
      // clock, so only the first of each is pinned (#131)
      const firstMember = roundLines.findIndex((x) => x.member);
      const renewal = (l: (typeof roundLines)[number], i: number) => (!!l.member && firstMember < i)
        || (!!l.opening && roundLines.findIndex((x) => x.opening?.id === l.opening!.id) < i);
      const kinds = roundLines.filter((l, i) => kindOf(l) !== 'item' && !renewal(l, i)).map(kindOf);
      // no 'core' line: the core set is worked out on each PC. The last two: hearing the responses, claimed, because
      // the round raised a finding
      expect(kinds).toEqual([
        'opening', 'claim', 'release', 'plan', 'member', 'claim', 'release', 'claim', 'release', 'claim', 'release',
        'done', 'full', 'claim', 'release',
      ]);
      expect(Date.now() - t0).toBeLessThan(FAST.lapse!);                                                 // no wait for others to join
    } finally { await p.close(); }
  }, 60000);
  it('3. a PC that drops off half-way with no `left`: the other takes its pieces over after the lapse; every piece is done once, apart from the batch in flight', async () => {
    // batches of five: twenty blocks, given out by a hash of the PCs' ids, so the laptop all but always owns two
    // each PC's clock skips a stall: a PC that is merely starved of CPU for longer than the lapse would take itself to
    // have slept and drop its batch in flight, which is not what this case is about (#1230)
    const p = await pair({
      items: 100,
      batch: 5,
      scriptA: { delay: 30 },
      scriptB: { delay: 30 },
      nowA: stallFreeClock(),
      nowB: stallFreeClock(),
    });
    try {
      const laptopId = p.B.backend.installId;
      // the office's checks wait until the laptop has finished a batch, so the laptop has one done however busy the
      // machine is; otherwise the office could take its pieces over first (#131)
      const laptopDidABatch = () => logOf(p.sync.A, p.dealId).some((l) => l.pc === laptopId && l.item);
      const laptopsBatch = () => until('the laptop to finish a batch', laptopDidABatch, 30000);
      const officeWaits = (c: Parameters<typeof itemsIn>[0]) => itemsIn(c).length > 0 && !laptopDidABatch();
      p.svcA.set({ delay: 30, hold: (c) => (officeWaits(c as any) ? laptopsBatch() : undefined) });
      // the laptop stops answering inside its second batch, and nothing more of it reaches the office; its first batch
      // has reached the office, so the office must not do that one again
      const dropOff = laptopDropsOff(p);
      const inSecondBatch = (c: Parameters<typeof itemsIn>[0]) => itemsIn(c).length > 0 && checks(p.svcB).length >= 2;
      p.svcB.set({ delay: 30, hold: (c) => (inSecondBatch(c as any) ? dropOff.inBatch() : undefined) });
      const a = aiOf(p.A).firstPass(p.dealId);
      // the laptop starts once the office holds its first block, and the office has said so: it joins that round and
      // leaves the office's block alone, rather than the two taking the same first block before either has seen the
      // other (the known limit; #1230)
      await until('the office to hold its first block', () => checks(p.svcA).length > 0);
      p.net.now();
      void aiOf(p.B).firstPass(p.dealId);
      await until('the laptop to drop off', () => dropOff.at > 0);
      const t0 = dropOff.at;
      await a;
      await until('the office to finish the round', () => [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.end?.kind === 'done'), 20000);
      // it waited for the lapse before taking over, counted as the office counts it (RoundsObserver.lastWork): from the
      // laptop's last piece line, or its joining, whichever is later. Renewals do not count, and on a busy machine the
      // last piece line can be written a little before the pause (#131)
      const fromLaptop = logOf(p.sync.A, p.dealId).filter((l) => l.pc === laptopId);
      const joined = fromLaptop.find((l) => l.member);
      const work = fromLaptop.filter((l) => roundOfWork(l) || l === joined);
      expect(work.length, 'the office saw the laptop join and work').toBeGreaterThan(0);
      const lastWork = Math.max(...work.map((l) => Date.parse(l.at)));
      expect(lastWork).toBeLessThanOrEqual(t0);
      expect(Date.now() - lastWork).toBeGreaterThanOrEqual(FAST.lapse! - 100);
      const t = tally(p);
      expect(t.size).toBe(100);
      // the laptop's batch in flight, and nothing else, was done twice
      const twice = [...t].filter(([, x]) => x > 1).map(([n]) => n).sort((x, y) => x - y);
      const laptopBatches = checks(p.svcB);
      expect(laptopBatches.length, JSON.stringify(laptopBatches)).toBe(2);
      const inFlight = [...laptopBatches[1][1]].sort((x, y) => x - y);
      expect(twice, JSON.stringify({ office: checks(p.svcA), laptop: laptopBatches })).toEqual(inFlight);
    } finally { await p.close(); }
  }, 60000);

  it('4. a PC that closes half-way: the other takes its pieces over at once', async () => {
    const p = await pair({ items: 100, scriptA: { delay: 30 }, scriptB: { delay: 30 }, timing: { lapse: 8000 } });          // a long lapse, so taking over "at once" cannot be the lapse running out
    try {
      const a = aiOf(p.A).firstPass(p.dealId); void aiOf(p.B).firstPass(p.dealId).catch(() => undefined);
      await until('the laptop to have checked a block', () => checks(p.svcB).length >= 1);
      const t0 = Date.now(); p.B.backend.close(); await a;
      await until('the office to finish the round', () => [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.end?.kind === 'done'), 20000);
      expect(Date.now() - t0).toBeLessThan(8000);                                                          // no lapse to wait for: the laptop said it left
      const t = tally(p); expect(t.size).toBe(100);
      // the laptop said it left, whichever PC planned the round (on a busy machine the laptop can be first) (#131)
      const bId = p.B.backend.installId;
      expect(logOf(p.sync.A, p.dealId).some((l) => l.pc === bId && l.left?.pc === bId)).toBe(true);
    } finally { await p.close(); }
  }, 60000);

  it('9. a quick check that ends with one item unsettled, on one PC and on two: the request ends, no `full` is written, and it says what was left', async () => {
    for (const both of [false, true]) {
      const weak = { weak: (n: number, m: string) => n === 5 && m !== 'fast' };
      const p = await pair({ items: 30, scriptA: weak, scriptB: weak, one: !both });
      try {
        val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p);
        const fullsBefore = logOf(p.sync.A, p.dealId).filter((l) => l.full).length;
        const asks = both ? [p.A.backend.ai.checkAll!({ dealId: p.dealId }), p.B.backend.ai.checkAll!({ dealId: p.dealId })] : [p.A.backend.ai.checkAll!({ dealId: p.dealId })];
        const rs = (await Promise.all(asks)).map((r) => val(r));
        for (const r of rs) expect(r).toMatchObject({ at: null, items: 30, unchecked: { items: 1, findings: 0 } });
        await allEnded(p); expect(logOf(p.sync.A, p.dealId).filter((l) => l.full).length).toBe(fullsBefore);
        const ends = [...view(logOf(p.sync.A, p.dealId)).rounds.values()].map((x) => `${x.def.kind}:${x.end?.kind}`).sort();
        expect(ends.filter((e) => e.endsWith(':done'))).toEqual(['first:done', 'quick:done']); expect(ends.filter((e) => !e.endsWith(':done')).every((e) => e === 'quick:merged')).toBe(true);   // one first pass and one check: the two asks shared it (if both opened one at once, one was merged into the other)
      } finally { await p.close(); }
    }
  }, 90000);

  it('12. a finding deleted while the round is under way: its piece is skipped, and the round ends; one closed meanwhile is still looked at, as a closed one', async () => {
    let gate: (() => void) | null = null; const held = new Promise<void>((r) => { gate = r; });
    const p = await pair({ items: 12, one: true, scriptA: { finding: (n) => n === 2 || n === 7 } });
    try {
      val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p); await p.A.backend.repo.sync!(); await p.A.store.boot();
      const fs2 = Object.values(p.A.store.get().findings).filter((f) => f.dealId === p.dealId); expect(fs2.length).toBe(2);
      p.svcA.set({ finding: (n) => n === 2 || n === 7, hold: () => held });                              // the check waits on its first call
      const ask = p.A.backend.ai.checkAll!({ dealId: p.dealId });
      await until('the check to be under way', () => p.svcA.calls.length > 0 || logOf(p.sync.A, p.dealId).some((l) => l.plan?.kind === 'quick'));
      val(await p.A.store.dispatch(DeleteFinding, { dealId: p.dealId, findingId: fs2[0].id }));
      val(await p.A.store.dispatch(SetFindingStatus, { dealId: p.dealId, findingId: fs2[1].id, status: 'closed' }));
      gate!(); p.svcA.set({ finding: (n) => n === 2 || n === 7 });
      const r = val(await ask); expect(r.findings).toBe(2);
      const lines = logOf(p.sync.A, p.dealId); expect(lines.some((l) => l.skipped?.key === `finding:${fs2[0].id}`)).toBe(true); expect(lines.some((l) => l.skipped?.key === `finding:${fs2[1].id}`)).toBe(false);
      expect(p.svcA.calls.some((c) => c.prompt.includes('a person has closed it') && c.prompt.includes(fs2[1].title))).toBe(true);
      expect([...view(lines).rounds.values()].every((x) => x.end?.kind === 'done')).toBe(true);
    } finally { await p.close(); }
  }, 60000);

  it('13. a ghost round, left by a PC that crashed with the documents since changed: it is written off, a check is not started again on its own, and the first pass runs afresh', async () => {
    const p = await pair({ items: 8, one: true });
    try {
      // a PC that crashed long ago left a check round open, over documents that are not the ones there now
      const ghost = { v: 1, at: '2026-11-01T09:00:00.000Z', pc: 'ghost' };
      const plan = { id: 'r_00000000000000000000000000_ghost', kind: 'quick', by: 'ghost', label: 'Old laptop', docs: 'x', docList: ['doc_gone'], core: { key: 'c', ids: [] }, codeBase: 0, block: 10, pieces: [{ key: 'item:c1', text: 'x', reason: 'settled', stage: 'glance' }] };
      fs.writeFileSync(`${p.sync.A}/checks-ghost-${p.dealId}.jsonl`, [{ ...ghost, n: 1, plan }, { ...ghost, n: 2, member: { round: plan.id, pc: 'ghost', label: 'Old laptop', epoch: 1, ok: true } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
      // first seen now, it is given a lapse; then the PCs with the deal open write it off (that it is written off at once after a restart is pinned in tests/backend/rounds.test.ts)
      await until('the ghost round to be written off', () => { p.net.now(); return roundsOf(p.sync.A, p.dealId).get(plan.id)?.end?.kind === 'abandoned'; }, 10000);
      await new Promise((r) => setTimeout(r, 300));
      expect([...roundsOf(p.sync.A, p.dealId).values()].filter((r) => r.def.id !== plan.id)).toEqual([]);   // no check was started again on its own
      val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p);
      expect([...roundsOf(p.sync.A, p.dealId).values()].filter((r) => r.def.id !== plan.id).map((r) => [r.def.kind, r.end?.kind])).toEqual([['first', 'done']]);
    } finally { await p.close(); }
  }, 60000);

  it('15. a deep check with one PC dropping out and the data room unchanged: it completes', async () => {
    let stuck = false; const never = new Promise<void>(() => undefined);
    const p = await pair({ items: 100, scriptA: { delay: 40 }, scriptB: { delay: 40, hold: () => (stuck ? never : undefined) } });
    try {
      val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p);
      const a = p.A.backend.ai.checkAll!({ dealId: p.dealId, deep: true }); void p.B.backend.ai.checkAll!({ dealId: p.dealId, deep: true }).catch(() => undefined);
      await until('the laptop to have done some of the deep check', () => checks(p.svcB).length >= 1);
      stuck = true; p.net.pause('ba');
      const r = val(await Promise.race([a, new Promise<never>((_, no) => setTimeout(() => no(new Error(`the check did not end. Office sees: ${state(p, 'A')}. Laptop sees: ${state(p, 'B')}`)), 25000))]));
      expect(r).toMatchObject({ items: 100, unchecked: { items: 0, findings: 0 } }); expect(r.at).not.toBeNull();
    } finally { await p.close(); }
  }, 60000);

  it('16. a quick check split across two PCs: every `full` line for it says the same, the sample is added up once per piece, and the standard calls are few', async () => {
    // Use the shipped membership lapse while checking the Standard call budget (#154).
    const p = await pair({
      items: 60, scriptA: { doubt: (n) => n % 15 === 0 }, scriptB: { doubt: (n) => n % 15 === 0 },
      timing: { lapse: control.timings.roundLapse },
    });
    try {
      await Promise.all([aiOf(p.A).firstPass(p.dealId), aiOf(p.B).firstPass(p.dealId)]); await allEnded(p);
      p.svcA.calls.length = 0; p.svcB.calls.length = 0;
      // when each standard call is answered: how many items of this check have a look written down, on either PC
      const { itemsIn } = await import('../backend/reviewKit');
      const earlier = new Set(roundsOf(p.sync.A, p.dealId).keys());
      const lookLines = (dir: string) => logOf(dir, p.dealId).filter((l) => l.glanced && !earlier.has(l.glanced.round));
      const looks = () => [p.sync.A, p.sync.B].flatMap(lookLines).flatMap((l) => l.glanced!.items.map((g) => g.item));
      const lookedNow = () => new Set(looks()).size;
      const lookedBy: number[] = [];
      const noted = (c: { model: string }) => {
        if (c.model === 'standard' && itemsIn(c as any).length) lookedBy.push(lookedNow());
        return undefined;
      };
      for (const svc of [p.svcA, p.svcB]) svc.set({ doubt: (n) => n % 15 === 0, hold: noted });
      const [ra, rb] = (await Promise.all([p.A.backend.ai.checkAll!({ dealId: p.dealId }), p.B.backend.ai.checkAll!({ dealId: p.dealId })])).map((r) => val(r));
      await allEnded(p);
      // the two summaries agree, the time included: it is when the work was finished, whichever PC wrote it down
      expect(ra).toEqual(rb); expect(ra.at).toBeTruthy(); expect(ra.sample).toEqual({ size: 6, overturned: 0 });                         // a tenth of the sixty passed, at least five: six, each counted once
      expect(val(await p.A.backend.ai.checked!(p.dealId)).at).toBe(ra.at); expect(val(await p.B.backend.ai.checked!(p.dealId)).at).toBe(ra.at);
      const quick = [...roundsOf(p.sync.A, p.dealId).values()].find((r) => r.def.kind === 'quick' && r.end?.kind === 'done')!; const fulls = logOf(p.sync.A, p.dealId).filter((l) => l.full?.round && quick.ids.has(l.full.round));
      expect(fulls.length).toBeGreaterThanOrEqual(1); expect(new Set(fulls.map((l) => JSON.stringify(l.full))).size).toBe(1);
      const std = [...checks(p.svcA), ...checks(p.svcB)].filter(([m]) => m === 'standard');
      expect(std.flatMap(([, ns]) => ns).sort((a, b) => a - b)).toEqual([...[15, 30, 45, 60], ...std.flatMap(([, ns]) => ns).filter((n) => n % 15 !== 0)].sort((a, b) => a - b));   // the flagged four and the sample, nothing else
      // every look was written down before any standard call, whichever PC looked, so a PC's flagged items go in
      // one call (#131)
      expect(lookedBy).toEqual(lookedBy.map(() => 60));
      // per PC: the flagged items in one call, the sample in one call. A failure names each PC's calls (#131).
      const standardOf = (svc: typeof p.svcA) => checks(svc).filter(([m]) => m === 'standard');
      const byPc = { office: standardOf(p.svcA), laptop: standardOf(p.svcB) };
      expect(std.length, JSON.stringify(byPc)).toBeLessThanOrEqual(4);
    } finally { await p.close(); }
  }, 90000);
  it('5. a PC that sleeps and wakes after its share was taken: its batch is thrown away, and nothing is written twice', async () => {
    // the laptop's lid closes during its first check call: the call hangs, and nothing more of the laptop reaches the office
    let offset = 0; let gate: (() => void) | null = null; let k = 0; const { itemsIn } = await import('../backend/reviewKit');
    const p = await pair({ meet: true, items: 100, scriptA: { delay: 40, finding: (n) => n % 10 === 0 }, scriptB: { delay: 40, finding: (n) => n % 10 === 0, hold: (c) => (itemsIn(c as any).length && ++k === 1 ? (p.net.pause('ba'), new Promise<void>((r) => { gate = r; })) : undefined) }, nowB: () => Date.now() + offset });
    try {
      const a = aiOf(p.A).firstPass(p.dealId); const b = aiOf(p.B).firstPass(p.dealId).catch(() => undefined);
      await until('the laptop to fall asleep', () => gate !== null);
      await a; await until('the office to finish the round', () => [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.end?.kind === 'done'), 20000);
      offset += 3 * FAST.lapse!; gate!(); p.net.resume(); await b; await allEnded(p);                       // it wakes, much later by its own clock, and the reply arrives
      const lines = logOf(p.sync.A, p.dealId); const done = [...view(lines).rounds.values()].find((r) => r.end?.kind === 'done')!;
      const per = new Map<string, number>(); for (const l of lines) if (l.item && l.result && l.round && done.ids.has(l.round)) per.set(l.item, (per.get(l.item) ?? 0) + 1);
      expect(per.size).toBe(100); expect([...per.values()].every((x) => x === 1)).toBe(true);              // the sleeper's batch was not written
      const titles = val(await p.A.backend.repo.list('finding', p.dealId)).map((l) => (l.envelope.data as any).title); expect(titles.length).toBe(10); expect(new Set(titles).size).toBe(10);
    } finally { await p.close(); }
  }, 60000);

  it('6. sync paused for longer than the lapse, the model still reachable: the PC out of touch takes nothing over and stops; its request ends; it reports how the check ended once back in touch', async () => {
    const p = await pair({ items: 100, scriptA: { delay: 150 }, scriptB: { delay: 150 } });
    try {
      val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p); const n0 = checks(p.svcB).length;
      // one round with both in it, and more work than the laptop can finish before it stops
      // the office waits on its next call until the laptop has checked part of this round, so the laptop has a part on a busy
      // machine too (#131)
      p.svcA.set({ delay: 150, hold: () => (checks(p.svcB).length > n0 ? undefined : until('the laptop to take part', () => checks(p.svcB).length > n0, 30000)) });
      const a = p.A.backend.ai.checkAll!({ dealId: p.dealId, deep: true });
      await until('the check to reach the laptop', () => logOf(p.sync.B, p.dealId).some((l) => l.plan?.kind === 'deep'));
      const b = p.B.backend.ai.checkAll!({ dealId: p.dealId, deep: true });
      await until('the laptop to have done part of the check', () => checks(p.svcB).length > n0);
      p.touch.B = false; p.net.pause('both');                                                             // a metered hotspot: OneDrive pauses
      const rb = await b; expect(!rb.ok && rb.error.message).toBe('This PC is not syncing with the Punchlist folder, so it has stopped its part of the check. You will be told how the check ended once syncing resumes.');
      const n = checks(p.svcB).length; await new Promise((r) => setTimeout(r, FAST.lapse! + 300)); expect(checks(p.svcB).length).toBeLessThanOrEqual(n + 1);   // it takes nothing over while out of touch
      p.touch.B = true; p.net.resume(); const ra = val(await a); await allEnded(p);
      expect(ra.unchecked).toEqual({ items: 0, findings: 0 });
      const told = val(await p.B.backend.ai.checked!(p.dealId)); expect(told.ended?.summary).toMatchObject({ items: 100 }); expect(val(await p.B.backend.ai.checked!(p.dealId)).ended).toBeUndefined();   // told once
    } finally { await p.close(); }
  }, 60000);

  it('6b. both PCs out of touch at once: neither says the other is working, and each says how the check ended once back in touch', async () => {
    const p = await pair({ items: 100, scriptA: { delay: 150 }, scriptB: { delay: 150 } });
    try {
      val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p); const n0 = { a: checks(p.svcA).length, b: checks(p.svcB).length };
      // one round, with both in it: the office asks first, and the laptop joins once the round has reached it
      const a = p.A.backend.ai.checkAll!({ dealId: p.dealId, deep: true });
      await until('the check to reach the laptop', () => logOf(p.sync.B, p.dealId).some((l) => l.plan?.kind === 'deep'));
      const b = p.B.backend.ai.checkAll!({ dealId: p.dealId, deep: true });
      await until('both to be part-way', () => checks(p.svcA).length > n0.a && checks(p.svcB).length > n0.b);
      p.touch.A = false; p.touch.B = false; p.net.pause('both');
      const both = await Promise.all([a, b]);
      for (const r of both) expect(!r.ok && r.error.message).toMatch(/^This PC is not syncing with the Punchlist folder, so it has stopped its part of the check\./);
      expect(fs.readFileSync(`${p.A.dirs.local}/ended-${p.dealId}.json`, 'utf8')).toContain('round');     // kept on the PC, so a restart does not lose it
      p.touch.A = true; p.touch.B = true; p.net.resume();
      const told: { a?: unknown; b?: unknown } = {};
      await until('both to be told', async () => { told.a ??= val(await p.A.backend.ai.checked!(p.dealId)).ended; told.b ??= val(await p.B.backend.ai.checked!(p.dealId)).ended; return !!told.a && !!told.b; }, 30000);
      expect(told.a).toEqual(told.b); expect((told.a as any).summary).toMatchObject({ items: 100, unchecked: { items: 0, findings: 0 } });
    } finally { await p.close(); }
  }, 60000);

  it('7 and 11d. two rounds opened while out of sync with each other: they end as one; what both did counts once, and a finding beats the other\'s pass on the same item', async () => {
    const p = await pair({ items: 40, scriptA: { delay: 60, finding: (n) => n === 3 } , scriptB: { delay: 60 } });
    try {
      p.net.pause('both');
      const a = aiOf(p.A).firstPass(p.dealId), b = aiOf(p.B).firstPass(p.dealId);
      await until('both to have written a round', () => logOf(p.sync.A, p.dealId).some((l) => l.plan) && logOf(p.sync.B, p.dealId).some((l) => l.plan));
      // each has written down item 3 before they hear of each other: what a batch has not yet written when its round is
      // merged away is dropped, so resuming once the calls had only started could lose the office's finding (#131)
      const wroteItem3 = (dir: string) => logOf(dir, p.dealId).some((l) => l.item === 'c3' && l.result);
      await until('both to have checked item 3', () => wroteItem3(p.sync.A) && wroteItem3(p.sync.B));
      p.net.resume(); await Promise.all([a, b]); await allEnded(p);
      const ends = [...roundsOf(p.sync.A, p.dealId).values()].map((r) => r.end?.kind).sort(); expect(ends).toEqual(['done', 'merged']);
      await p.A.backend.repo.sync!(); await p.B.backend.repo.sync!();
      const ra = await rows(p.A, p.dealId), rb = await rows(p.B, p.dealId); expect(ra).toEqual(rb); expect(ra.length).toBe(40);
      const c3 = ra.find((r) => r.startsWith('c3:'))!; expect(c3).toMatch(/^c3:finding:f_/);                     // the office raised it, the laptop passed it: the finding counts on both PCs
      const f = val(await p.A.backend.repo.get('finding', c3.split(':')[2])); expect((f!.envelope.data as any).status).toBe('open');
      expect(val(await p.A.backend.repo.list('finding', p.dealId)).length).toBe(1);
    } finally { await p.close(); }
  }, 60000);

  it('8. "Check again" pressed while another PC works a first pass: it waits, then runs as a check; out of touch, it ends, and is started once back in touch did not start', async () => {
    for (const away of [false, true]) {
      const p = await pair({ items: 40, one: true, scriptA: { delay: 40 } });
      try {
        const a = aiOf(p.A).firstPass(p.dealId);
        await until('the first pass to be under way', () => { p.net.now(); return logOf(p.sync.B, p.dealId).some((l) => l.plan); });
        if (away) { p.touch.B = false; p.net.pause('both'); }
        const b = p.B.backend.ai.checkAll!({ dealId: p.dealId });
        if (!away) {
          const r = val(await b); await a; await allEnded(p); expect(r).toMatchObject({ items: 40 });
          const kinds = [...roundsOf(p.sync.A, p.dealId).values()].map((x) => `${x.def.kind}:${x.end?.kind}`); expect(kinds).toEqual(['first:done', 'quick:done']);
          expect(logOf(p.sync.A, p.dealId).some((l) => l.wanted)).toBe(true);
        } else {
          const r = await b; expect(!r.ok && r.error.message).toBe('This PC is not syncing with the Punchlist folder, so the check has not started yet. It starts once syncing resumes.');
          await a; p.touch.B = true; p.net.resume();
          // once back in touch the laptop is told, once, to start the check it was asked for (the window starts it)
          let told: { restart?: string } | undefined;
          await until('the laptop to be told to start the check', async () => { told = val(await p.B.backend.ai.checked!(p.dealId)).ended; return !!told; }, 30000);
          expect(told!.restart).toBe('quick'); expect(val(await p.B.backend.ai.checked!(p.dealId)).ended).toBeUndefined();
          expect([...roundsOf(p.sync.A, p.dealId).values()].map((x) => x.def.kind)).toEqual(['first']);
        }
      } finally { await p.close(); }
    }
  }, 90000);

  it('10. a document indexed on a joining PC mid-round: it writes `due`, and the next round follows the document', async () => {
    const p = await pair({ items: 40, scriptA: { delay: 30 } });
    try {
      const a = aiOf(p.A).firstPass(p.dealId);
      await until('the first pass to be under way', () => { p.net.now(); return logOf(p.sync.B, p.dealId).some((l) => l.plan); });
      const { put, pdf } = await import('./kit'); put(`${p.root}/vdr-B`, 'Amended credit agreement.pdf', pdf('Amendment one to the credit agreement', 2));
      const { startIndexing } = await import('../../src/app/indexing'); await startIndexing(p.B.store, p.dealId, p.B.store.get().deals[p.dealId].folders);
      await until('the laptop to index it', async () => { const q = await p.B.backend.docs.poll(p.dealId); return q.ok && q.value.done && (p.B.backend.docs as any).records(p.dealId).length === 3; });
      await a; await until('the third document to be followed through', () => { p.net.now(); return logOf(p.sync.A, p.dealId).some((l) => l.done && (l.done.docs ?? []).length === 3); }, 30000);
      await allEnded(p);
      expect(logOf(p.sync.A, p.dealId).some((l) => l.due)).toBe(true);
      expect([...p.svcA.calls, ...p.svcB.calls].some((c) => c.prompt.includes('have just arrived') && c.prompt.includes('Amended credit agreement'))).toBe(true);
    } finally { await p.close(); }
  }, 60000);

  it('11. a member whose model service is away while the other PC has gone: it keeps trying in the background and finishes once the service is back; a short outage does not end a lone check', async () => {
    let stuck = false; const never = new Promise<void>(() => undefined); let down = false;
    const p = await pair({ meet: true, items: 100, scriptA: { delay: 40, hold: () => (stuck ? never : undefined) }, scriptB: { delay: 40, down: () => down } });
    try {
      void aiOf(p.A).firstPass(p.dealId); const b = aiOf(p.B).firstPass(p.dealId);
      await until('both to be at work', () => checks(p.svcA).length >= 1 && checks(p.svcB).length >= 1);
      stuck = true; p.net.pause('ab'); down = true; await b;                                               // the office stops; the laptop's model service is away
      await new Promise((r) => setTimeout(r, FAST.lapse! + FAST.giveUp!));                                // longer than both: the laptop has given up waiting, and the office has gone
      expect(val(await p.B.backend.ai.checked!(p.dealId)).checking).toMatchObject({ away: true });
      expect([...roundsOf(p.sync.B, p.dealId).values()].every((r) => !r.end)).toBe(true);                  // not given up: the round stays open
      down = false;                                                                                          // the service is back
      await until('the laptop to finish the round', () => [...roundsOf(p.sync.B, p.dealId).values()].some((r) => r.end?.kind === 'done'), 30000);
      expect(tally(p).size).toBe(100); expect(logOf(p.sync.B, p.dealId).some((l) => l.left && l.pc === p.B.backend.installId)).toBe(false);
    } finally { await p.close(); }
    // alone, with the service away for one call: the check ends as usual, even when the rest of it, once the service
    // is back, takes longer than the time a person is kept waiting (#131). Two items a call keep the rest over it.
    let off = false;
    const awayOnce = () => {
      const was = off;
      off = false;
      return was;
    };
    const q = await pair({ items: 30, one: true, batch: 2, scriptA: { delay: 40, down: awayOnce } });
    try {
      val(await aiOf(q.A).firstPass(q.dealId));
      await allEnded(q);
      off = true;
      const at = Date.now();
      const r = q.A.backend.ai.checkAll!({ dealId: q.dealId, deep: true });
      expect(val(await r)).toMatchObject({ items: 30, unchecked: { items: 0, findings: 0 } });
      expect(Date.now() - at).toBeGreaterThan(FAST.giveUp!);                       // the rest did outlast the wait
    } finally { await q.close(); }
  }, 90000);

  it('11h. alone: a second outage after the service answered again starts its own wait, '
    + 'and the check ends as out of reach', async () => {
    // away for the first call, back for three, then away for good (#131)
    let calls = 0;
    let awayAgainAt = 0;
    const away = () => {
      calls++;
      if (calls >= 5 && !awayAgainAt) awayAgainAt = Date.now();
      return calls === 1 || calls >= 5;
    };
    const q = await pair({ items: 30, one: true, batch: 2 });
    try {
      val(await aiOf(q.A).firstPass(q.dealId));
      await allEnded(q);
      q.svcA.set({ delay: 40, down: away });
      const r = await q.A.backend.ai.checkAll!({ dealId: q.dealId, deep: true });
      expect(!r.ok && r.error.message).toMatch(/can’t be reached/);
      // the wait was counted from the second outage, not from the first
      expect(Date.now() - awayAgainAt).toBeGreaterThanOrEqual(FAST.giveUp!);
    } finally { await q.close(); }
  }, 60000);

  it('11b. the only other member lacks a document the round needs: the round is not stuck', async () => {
    const p = await pair({ items: 10 });
    try {
      const { docsHash } = await import('../../src/backend/rounds');
      const by = p.A.backend.installId; const plan = { id: `r_00000000000000000000000000_${by}`, kind: 'first', by, label: 'Office', docs: docsHash(['doc_gone']), docList: ['doc_gone'], core: { key: 'c', ids: ['doc_gone'] }, codeBase: 0, block: 10, pieces: [{ key: 'item:c1', text: 'Clause 1 of the finance documents is in order', reason: 'new', stage: 'check' }] };
      fs.appendFileSync(`${p.sync.A}/checks-${by}-${p.dealId}.jsonl`, [{ v: 1, at: new Date().toISOString(), n: 900, pc: by, plan }, { v: 1, at: new Date().toISOString(), n: 901, pc: by, left: { round: plan.id, pc: by } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
      p.net.now();
      const t0 = Date.now();
      const started = aiOf(p.B).firstPass(p.dealId);
      await until('that round to end', () => { p.net.now(); return roundsOf(p.sync.B, p.dealId).get(plan.id)?.end?.kind === 'abandoned'; }, 30000);
      expect(Date.now() - t0).toBeLessThan(4 * FAST.lapse!);
      val(await started);                                  // the laptop's own pass ends before the case does
    } finally { await p.close(); }
  }, 60000);

  it('14. one PC\'s clock five hours fast: liveness and claims are still right', async () => {
    let stuck = false;
    const never = new Promise<void>(() => undefined);
    const ahead = 5 * 3600_000;
    const p = await pair({
      items: 100,
      scriptB: { delay: 40, hold: () => (stuck ? never : undefined) },
      clockB: () => new Date(Date.now() + ahead).toISOString(),
    });
    try {
      const laptopId = p.B.backend.installId;
      // Hold the office's first checklist reply until the laptop starts a block and we simulate the disconnect.
      p.svcA.set({
        delay: 40,
        hold: () => checks(p.svcA).length && !stuck ? until('the laptop to disconnect', () => stuck) : undefined,
      });
      const a = aiOf(p.A).firstPass(p.dealId);
      void aiOf(p.B).firstPass(p.dealId);
      await until('the laptop to start a block whose claim reached the office', () => {
        p.net.now();
        return checks(p.svcB).length > 0 && logOf(p.sync.A, p.dealId).some(
          (line) => line.pc === laptopId && line.claim && Date.parse(line.claim.until) > Date.now() + ahead / 2,
        );
      });
      stuck = true;
      p.net.pause('ba');
      await a;
      await until('the office to finish the round', () => [...roundsOf(p.sync.A, p.dealId).values()].some((r) => r.end?.kind === 'done'), 20000);
      expect(tally(p).size).toBe(100);
    } finally { await p.close(); }
  }, 60000);
  it('11a. two checks opened out of sync with each other end as one round: both requests end, with the same summary', async () => {
    const p = await pair({ items: 40, scriptA: { delay: 40 }, scriptB: { delay: 40 } });
    try {
      val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p);
      p.net.pause('both');
      const a = p.A.backend.ai.checkAll!({ dealId: p.dealId }), b = p.B.backend.ai.checkAll!({ dealId: p.dealId });
      await until('both to have written a check round', () => logOf(p.sync.A, p.dealId).some((l) => l.plan?.kind === 'quick') && logOf(p.sync.B, p.dealId).some((l) => l.plan?.kind === 'quick'));
      p.net.resume(); const [ra, rb] = (await Promise.all([a, b])).map((r) => val(r)); await allEnded(p);
      expect(ra).toEqual(rb); expect([...roundsOf(p.sync.A, p.dealId).values()].filter((r) => r.def.kind === 'quick').map((r) => r.end?.kind).sort()).toEqual(['done', 'merged']);
    } finally { await p.close(); }
  }, 60000);

  it('11c. a document both PCs have, arriving while a round runs: when the round ends both go to follow it, and one round does, each finding once', async () => {
    const p = await pair({ items: 30, scriptA: { delay: 40, finding: (n) => n === 4 }, scriptB: { delay: 40, finding: (n) => n === 4 } });
    try {
      const a = aiOf(p.A).firstPass(p.dealId), b = aiOf(p.B).firstPass(p.dealId);
      await until('the round to be under way', () => checks(p.svcA).length + checks(p.svcB).length >= 1);
      const { put, pdf } = await import('./kit'); const { startIndexing } = await import('../../src/app/indexing');
      for (const [P, v] of [[p.A, 'vdr-A'], [p.B, 'vdr-B']] as const) { put(`${p.root}/${v}`, 'Side letter.pdf', pdf('Side letter to the credit agreement', 2)); await startIndexing(P.store, p.dealId, P.store.get().deals[p.dealId].folders); }
      await Promise.all([a, b]);
      await until('the side letter to be followed through', () => { p.net.now(); return logOf(p.sync.A, p.dealId).some((l) => l.done && (l.done.docs ?? []).length === 3); }, 30000);
      await allEnded(p);
      const lines = logOf(p.sync.A, p.dealId); const followed = lines.filter((l) => l.done && (l.done.docs ?? []).length === 3);
      expect(new Set(followed.map((l) => l.done!.round ?? l.done!.opening)).size, `the lines: ${JSON.stringify(lines.filter((l) => l.opening || l.plan || l.done || l.merged || l.abandoned).map((l) => ({ n: l.n, pc: l.pc?.slice(0, 4), k: Object.keys(l).find((x) => !['v', 'at', 'n', 'pc'].includes(x)), id: l.opening?.id ?? l.plan?.id ?? l.done?.round ?? l.done?.opening ?? l.merged?.round ?? l.abandoned?.round, docs: l.done?.docs?.length ?? l.plan?.docList.length })))}`).toBe(1);                // one round (or one opening with nothing to do) followed it
      // the laptop's finding, if it wrote it, is read here too (#131)
      p.net.now();
      await p.A.backend.repo.sync!();
      const titles = val(await p.A.backend.repo.list('finding', p.dealId)).map((l) => (l.envelope.data as any).title); expect(titles.length).toBe(1);
    } finally { await p.close(); }
  }, 60000);
  it('19. while a check is shared, each PC can say who the other person is, and which of their PCs', async () => {
    const p = await pair({ meet: true, items: 100, scriptA: { delay: 60 }, scriptB: { delay: 60 } });
    try {
      const a = aiOf(p.A).firstPass(p.dealId), b = aiOf(p.B).firstPass(p.dealId);
      await until('both to be in the round', () => checks(p.svcA).length >= 1 && checks(p.svcB).length >= 1);
      await until('the office to see the laptop in it', async () => (val(await p.A.backend.ai.checked!(p.dealId)).checking?.with.length ?? 0) > 0);
      expect(val(await p.A.backend.ai.checked!(p.dealId)).checking!.with).toEqual([{ who: 'sroe', pc: 'Laptop', same: false }]);
      await Promise.all([a, b]); await allEnded(p);
      expect(val(await p.A.backend.ai.checked!(p.dealId)).checking).toBeUndefined();                         // over: nothing to say
      await p.close();
      // the same person name on both PCs (jdoe on a desktop and a laptop, or two people called jdoe): each is told the other's device id too
      const q = await pair({ items: 100, users: ['jdoe', 'jdoe'], scriptA: { delay: 60 }, scriptB: { delay: 60 } });
      try {
        const qa = aiOf(q.A).firstPass(q.dealId), qb = aiOf(q.B).firstPass(q.dealId);
        await until('the office to see the laptop in it', async () => (val(await q.A.backend.ai.checked!(q.dealId)).checking?.with.length ?? 0) > 0);
        expect(val(await q.A.backend.ai.checked!(q.dealId)).checking!.with).toEqual([{ who: 'jdoe', pc: 'Laptop', same: true }]);
        await Promise.all([qa, qb]); await allEnded(q);
      } finally { await q.close(); }
    } finally { await p.close(); }
  }, 60000);
  it('21. a check whose round is written off while the person waits on it: it starts again by itself and ends with a summary, not "could not finish"', async () => {
    let held = false; let release = () => {}; const gate = new Promise<void>((r) => { release = r; });
    const p = await pair({ items: 20, one: true, scriptA: { delay: 40, hold: () => (held ? gate : undefined) } });
    try {
      val(await aiOf(p.A).firstPass(p.dealId)); await allEnded(p); held = true;
      const ask = p.A.backend.ai.checkAll!({ dealId: p.dealId });
      let quick: string | undefined;
      await until('the check to be under way', () => { quick = [...roundsOf(p.sync.A, p.dealId).values()].find((x) => x.def.kind === 'quick' && !x.end)?.def.id; return !!quick && checks(p.svcA).length > 0; }, 15000);
      // as when the round stalls and is written off: an `abandoned` line for it
      fs.writeFileSync(`${p.sync.A}/checks-ghost-${p.dealId}.jsonl`, JSON.stringify({ v: 1, at: new Date().toISOString(), n: 1e9, pc: 'ghost', abandoned: { round: quick } }) + '\n');
      await until('the round to be written off', () => { p.net.now(); return roundsOf(p.sync.A, p.dealId).get(quick!)?.end?.kind === 'abandoned'; }, 10000); held = false; release();
      const r = await ask; expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
      const ends = [...roundsOf(p.sync.A, p.dealId).values()].filter((x) => x.def.kind === 'quick').map((x) => [x.def.id === quick, x.end?.kind]);
      expect(ends).toEqual(expect.arrayContaining([[true, 'abandoned'], [false, 'done']]));
    } finally { await p.close(); }
  }, 60000);

  it('20. a PC that was not part of the round, with the app open, finishes a round the only PC in it left unfinished', async () => {
    for (const how of ['sleeps', 'closes'] as const) {
      let stuck = false; const never = new Promise<void>(() => undefined);
      // a PC that closes says it left, so the laptop does not wait out a lapse: a long lapse there keeps a busy
      // machine's slowness apart from the lapse it proves was not waited for (#131)
      const timing = how === 'closes' ? { lapse: 8000 } : undefined;
      const p = await pair({ items: 60, scriptA: { delay: 40, hold: () => (stuck ? never : undefined) }, timing });
      try {
        void aiOf(p.A).firstPass(p.dealId).catch(() => undefined);                                       // only the office goes through the checklist
        await until('the office to be part-way', () => checks(p.svcA).length >= 2);
        const t0 = Date.now();
        const aId = p.A.backend.installId;
        if (how === 'sleeps') { stuck = true; p.net.pause('ab'); } else p.A.backend.close();
        await until('the laptop to finish it', () => { const r = [...roundsOf(p.sync.B, p.dealId).values()]; return r.length > 0 && r.every((x) => x.end) && r.some((x) => x.end?.kind === 'done'); }, 30000);
        const took = Date.now() - t0;
        if (how === 'sleeps') expect(took).toBeGreaterThanOrEqual(FAST.lapse! - 100);
        else {
          expect(took).toBeLessThan(8000);
          // the office said it left
          expect(logOf(p.sync.B, p.dealId).some((l) => l.pc === aId && l.left?.pc === aId)).toBe(true);
        }
        expect(checks(p.svcB).length).toBeGreaterThan(0); expect(tally(p).size).toBe(60);
        expect([...roundsOf(p.sync.B, p.dealId).values()].filter((x) => x.end?.kind === 'done').length).toBe(1);   // the same round, finished: not a fresh one
      } finally { await p.close(); }
    }
  }, 90000);
  it('11f. a PC alone in a check, signed out: the check resumes as soon as someone signs in, not after the five-minute retry', async () => {
    // the stand-in fails at once, as calls do once single sign-on has given up: the tries back off rather than fill the shared log
    let out = false; const q = await pair({ items: 30, one: true, scriptA: { delay: 10, signedOut: () => out }, timing: { retryFirst: 100, retryMax: 800, retryEvery: 60000 } });
    try {
      val(await aiOf(q.A).firstPass(q.dealId)); await allEnded(q);
      out = true; const asked = await q.A.backend.ai.checkAll!({ dealId: q.dealId, deep: true });
      expect(asked.ok).toBe(false);
      const claims = () => logOf(q.sync.A, q.dealId).filter((l) => l.claim).length; const before = claims();
      await new Promise((r) => setTimeout(r, 4000));
      expect(claims() - before).toBeLessThanOrEqual(9);                     // backing off to 0.8 s: about six tries in 4 s; a fixed 0.1 s would be about forty
      out = false; const signedIn = Date.now();                                                               // signed in again
      await until('the check to finish', () => [...roundsOf(q.sync.A, q.dealId).values()].filter((r) => r.def.kind === 'deep').some((r) => r.end?.kind === 'done'), 20000);
      expect(Date.now() - signedIn).toBeLessThan(20000);                                                      // well inside the minute the retry would otherwise wait
    } finally { await q.close(); }
  }, 60000);
  it('11g. a PC signed out mid-check with another PC in the round: it keeps the long wait and claims nothing more, so the other PC finishes the check', async () => {
    let out = false; const q = await pair({ meet: true, items: 60, scriptA: { delay: 10, signedOut: () => out }, scriptB: { delay: 30 }, timing: { retryFirst: 100, retryMax: 800, retryEvery: 60000 } });
    try {
      await Promise.all([aiOf(q.A).firstPass(q.dealId), aiOf(q.B).firstPass(q.dealId)]); await allEnded(q);
      out = true; void q.A.backend.ai.checkAll!({ dealId: q.dealId, deep: true }).catch(() => undefined); void q.B.backend.ai.checkAll!({ dealId: q.dealId, deep: true }).catch(() => undefined);
      await until('the office to say it waits for sign-in', async () => !!val(await q.A.backend.ai.checked!(q.dealId)).checking?.signIn, 10000);
      const mine = () => logOf(q.sync.A, q.dealId).filter((l) => l.claim?.pc === q.A.backend.installId).length; const before = mine();
      await until('the laptop to finish the check', () => [...roundsOf(q.sync.B, q.dealId).values()].filter((r) => r.def.kind === 'deep').some((r) => r.end?.kind === 'done'), 30000);
      expect(mine() - before).toBeLessThanOrEqual(1);                        // no short retries while another PC is there to take over its pieces
    } finally { await q.close(); }
  }, 60000);
  it('11e. a PC signed out mid-check: its line says the check waits for sign-in, not that the service is out of reach, and it finishes after sign-in', async () => {
    let out = false; const q = await pair({ items: 30, one: true, scriptA: { delay: 10, signedOut: () => out } });
    try {
      val(await aiOf(q.A).firstPass(q.dealId)); await allEnded(q);
      out = true; const asked = q.A.backend.ai.checkAll!({ dealId: q.dealId, deep: true });
      await until('the check to say it waits for sign-in', async () => !!val(await q.A.backend.ai.checked!(q.dealId)).checking?.signIn, 10000);
      const line = val(await q.A.backend.ai.checked!(q.dealId)).checking;
      expect(line).toMatchObject({ signIn: true }); expect(line?.retryUntil).toBeUndefined();          // the sign-in wait already took the two minutes: none added on top
      // the request ends saying it waits for sign-in, never that the service cannot be reached
      expect(await asked).toEqual({ ok: false, error: { kind: 'rejected', message: `Waiting for ${SERVICE} sign-in. The check resumes once someone signs in.` } });
      out = false;                                                                                           // signed in again
      await until('the check to finish', () => [...roundsOf(q.sync.A, q.dealId).values()].filter((r) => r.def.kind === 'deep').some((r) => r.end?.kind === 'done'), 30000);
      expect(val(await q.A.backend.ai.checked!(q.dealId)).checking?.signIn).toBeFalsy();
    } finally { await q.close(); }
  }, 60000);
  it('20b. a check left by a PC that has gone, over fewer documents than this PC holds: this PC finishes that check, notes the rest as due, and a first pass follows them', async () => {
    const p = await pair({ items: 6, one: true });
    try {
      // a PC that has gone left a deep check open over one of the two documents there are now
      const [d1] = (p.A.backend.docs as any).records(p.dealId).map((r: { docId: string }) => r.docId).sort();
      const ghost = { v: 1, at: '2026-11-01T09:00:00.000Z', pc: 'ghost' };
      const plan = { id: 'r_00000000000000000000000000_ghost', kind: 'deep', by: 'ghost', label: 'Old laptop', docs: 'x', docList: [d1], core: { key: 'c', ids: [] }, block: 10, pieces: p.list.items.map((it) => ({ key: `item:${it.id}`, text: it.text, reason: 'new', stage: 'check' })) };
      fs.writeFileSync(`${p.sync.A}/checks-ghost-${p.dealId}.jsonl`, [{ ...ghost, n: 1, plan }, { ...ghost, n: 2, member: { round: plan.id, pc: 'ghost', label: 'Old laptop', epoch: 1, ok: true } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
      await until('the left round to be finished', () => { p.net.now(); return roundsOf(p.sync.A, p.dealId).get(plan.id)?.end?.kind === 'done'; }, 15000);
      expect(logOf(p.sync.A, p.dealId).some((l) => l.due?.round === plan.id)).toBe(true);
      await until('a first pass to follow the other document', () => { p.net.now(); return logOf(p.sync.A, p.dealId).some((l) => l.done && (l.done.docs ?? []).length === 2); }, 15000);
    } finally { await p.close(); }
  }, 60000);
  it('20c. this PC restarts with a deep check it was in left open, and a document has arrived since: its first pass finishes that check rather than writing it off, and follows the document after', async () => {
    const p = await pair({ items: 6, one: true });
    try {
      const me = p.A.backend.installId; const [d1] = (p.A.backend.docs as any).records(p.dealId).map((r: { docId: string }) => r.docId).sort();
      const was = { v: 1, at: '2026-11-01T09:00:00.000Z', pc: me }; const n = Math.max(0, ...logOf(p.sync.A, p.dealId).map((l) => l.n ?? 0)) + 1;
      const plan = { id: 'r_00000000000000000000000000_again', kind: 'deep', by: me, label: 'Office', docs: 'x', docList: [d1], core: { key: 'c', ids: [] }, block: 10, pieces: p.list.items.map((it) => ({ key: `item:${it.id}`, text: it.text, reason: 'new', stage: 'check' })) };
      fs.appendFileSync(`${p.sync.A}/checks-${me}-${p.dealId}.jsonl`, [{ ...was, n, plan }, { ...was, n: n + 1, member: { round: plan.id, pc: me, label: 'Office', epoch: 1, ok: true } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
      val(await aiOf(p.A).firstPass(p.dealId));
      await until('the round to be finished', () => { p.net.now(); return roundsOf(p.sync.A, p.dealId).get(plan.id)?.end?.kind === 'done'; }, 15000);
      expect(logOf(p.sync.A, p.dealId).some((l) => l.abandoned?.round === plan.id)).toBe(false);
      expect(logOf(p.sync.A, p.dealId).some((l) => l.due?.round === plan.id)).toBe(true);
      await until('a first pass to follow the other document', () => { p.net.now(); return logOf(p.sync.A, p.dealId).some((l) => l.done && (l.done.docs ?? []).length === 2); }, 15000);
    } finally { await p.close(); }
  }, 60000);
  it('20d. a first pass left by a PC that has gone, over fewer documents than this PC holds: this PC finishes it, '
    + 'and a first pass follows the rest', async () => {
    const p = await pair({ items: 6, one: true });
    try {
      const docIds = (p.A.backend.docs as any).records(p.dealId).map((r: { docId: string }) => r.docId);
      const [d1] = docIds.sort();
      const ghost = { v: 1, at: '2026-11-01T09:00:00.000Z', pc: 'ghost' };
      const pieces = p.list.items.map((it) => ({ key: `item:${it.id}`, text: it.text, reason: 'new', stage: 'check' }));
      const plan = {
        id: 'r_00000000000000000000000000_first', kind: 'first', by: 'ghost', label: 'Old laptop', docs: 'x',
        docList: [d1], core: { key: 'c', ids: [] }, block: 10, pieces,
      };
      const member = { round: plan.id, pc: 'ghost', label: 'Old laptop', epoch: 1, ok: true };
      const lines = [{ ...ghost, n: 1, plan }, { ...ghost, n: 2, member }];
      const file = `${p.sync.A}/checks-ghost-${p.dealId}.jsonl`;
      fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const left = () => roundsOf(p.sync.A, p.dealId).get(plan.id);
      await until('the left pass to be finished', () => { p.net.now(); return left()?.end?.kind === 'done'; }, 15000);
      expect(left()?.members.has(p.A.backend.installId)).toBe(true);
      const log = () => logOf(p.sync.A, p.dealId);
      expect(log().some((l) => l.due?.round === plan.id)).toBe(true);
      const both = () => log().some((l) => l.done && (l.done.docs ?? []).length === 2);
      await until('a first pass to follow the other document', () => { p.net.now(); return both(); }, 15000);
      expect(log().some((l) => l.abandoned?.round === plan.id)).toBe(false);
    } finally { await p.close(); }
  }, 60000);
  it('20e. a document indexed while this PC runs its own first pass alone: the pass carries on rather than being '
    + 'written off, and no item goes to the model twice', async () => {
    // stallFreeClock: indexing the new document can starve the PC of CPU for a lapse, not a sleep (#1230)
    const p = await pair({
      items: 80, one: true, scriptA: { delay: 60, finding: (n) => n % 10 === 3 }, nowA: stallFreeClock(),
    });
    try {
      const run = aiOf(p.A).firstPass(p.dealId);
      const checked = () => checks(p.svcA).filter(([m]) => m !== 'fast').length;
      await until('the first pass to be part-way', () => checked() >= 3, 20000);
      const { put, pdf } = await import('./kit');
      const { startIndexing } = await import('../../src/app/indexing');
      put(`${p.root}/vdr-A`, 'Side letter.pdf', pdf('Side letter to the credit agreement', 2));
      await startIndexing(p.A.store, p.dealId, p.A.store.get().deals[p.dealId].folders);
      val(await run);
      await p.A.backend.idle();
      const ended = () => [...roundsOf(p.sync.A, p.dealId).values()].every((r) => r.end);
      await until('every round to end', ended, 20000);
      await p.A.backend.idle();
      expect(logOf(p.sync.A, p.dealId).some((l) => l.abandoned)).toBe(false);
      expect([...tally(p).values()].filter((n) => n > 1)).toEqual([]);
      type Line = { envelope: { data: { itemId?: string } } };
      const findingLines = val(await p.A.backend.repo.list('finding', p.dealId)) as Line[];
      const items = findingLines.map((l) => l.envelope.data.itemId);
      expect(new Set(items).size).toBe(items.length);
    } finally { await p.close(); }
  }, 90000);
});
