// @vitest-environment node
// Sharing a round with another PC, on the check log alone (docs/architecture.md, Checks, and how PCs share them): a PC that finds a round another PC
// started joins it and works only its own share; inside a round a claim counts while its writer is live, whatever the
// writer's clock put in `until`.
import { describe, it, expect } from 'vitest';
import { nodeAi, type AiDocs } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo } from '../adapters/memRepo';
import { owner, blockOf, unitOf, view, docsHash, type RoundDef } from '../../src/backend/rounds';
import { Mem, itemsIn } from './reviewKit';
import { tokenHolder } from '../../src/backend/signInToken';

let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 12, 9, 0, 0, t++)).toISOString();
let n = 0; const line = (o: object) => JSON.stringify({ v: 1, at: '2026-11-12T09:00:00.000Z', n: ++n, pc: 'office', ...o }) + '\n';
const DOC = { docId: 'doc_1', hash: 'h', name: 'A.pdf', folder: 'vdr', rel: 'A.pdf', size: 1, pages: 1 };
const LIST = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((id) => ({ id, text: `Item ${id} is in order` }));
async function setUp(o: { timing?: Parameters<typeof nodeAi>[0]['timing'] } = {}) {
  const repo = memRepo(clock); const shared = new Mem();
  await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Proseware' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } });
  const svc = new StandInService((c) => JSON.stringify({ items: itemsIn(c as any).map((it) => ({ id: it.tag, result: 'more', need: 'a report' })) }));
  const docs: AiDocs = { records: () => [DOC], wanted: async (_d, ids) => (ids.includes('doc_1') ? [{ docId: 'doc_1', name: 'A.pdf', read: () => new TextEncoder().encode('A') }] : []) };
  const ai = nodeAi({ service: svc, docs, keeper: new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock }), repo, shared, installId: 'laptop', label: 'Laptop', clock, now: () => Date.now(), batch: 1, checklist: () => ({ broad: LIST, product: [], sector: [] }), ...o });
  return { ai, shared, svc };
}
/** a first-pass round the office started, one item to a block, with the office in it */
const ROUND: RoundDef = { id: 'r_00000000000000000000000000_office', kind: 'first', by: 'office', label: 'PC A', docs: docsHash(['doc_1']), docList: ['doc_1'], core: { key: 'c', ids: [] }, block: 1, pieces: LIST.map((it) => ({ key: `item:${it.id}`, text: it.text, reason: 'new', stage: 'check' as const })) };
const officeLines = (more = '') => line({ plan: ROUND }) + line({ member: { round: ROUND.id, pc: 'office', label: 'PC A', epoch: 1, ok: true } }) + more;
/** the items this PC asked the model about, in any call (#1162: a pick names them by id, not by the check's words) */
const checked = (svc: StandInService) =>
  LIST.filter((x) => svc.calls.some((c) => c.prompt.includes(x.text))).map((x) => x.id).sort();

describe('a round another PC started', () => {
  it('this PC joins it, says who started it, and works only its own share while the other PC is live', async () => {
    const { ai, shared, svc } = await setUp(); shared.files.set('checks-office-d1.jsonl', officeLines());
    const r = await ai.firstPass('d1'); expect(r.ok && (r.value as any).elsewhere).toBe('PC A');
    const R = view((shared.read('checks-office-d1.jsonl')! + shared.read('checks-laptop-d1.jsonl')!).split('\n').filter(Boolean).map((l) => JSON.parse(l))).rounds.get(ROUND.id)!;
    const blocks = blockOf(R); const ours = LIST.filter((it) => owner(unitOf(blocks, R.pieces.find((p) => p.key === `item:${it.id}`)!), ['office', 'laptop']) === 'laptop').map((it) => it.id).sort();
    expect(ours.length).toBeGreaterThan(0); expect(ours.length).toBeLessThan(LIST.length); expect(checked(svc)).toEqual(ours);
    expect(R.members.has('laptop')).toBe(true);
    ai.close();
  });

  it('inside a round a claim counts while its writer is live, whatever its clock put in `until`; once released, the piece is free', async () => {
    const { ai, shared, svc } = await setUp();
    // the office holds a claim on one of the laptop's own blocks, written by a clock five hours slow: its `until` is long past by the laptop's clock
    const R = view([{ at: '', plan: ROUND }]).rounds.get(ROUND.id)!; const blocks = blockOf(R);
    const mineFirst = LIST.find((it) => owner(unitOf(blocks, R.pieces.find((p) => p.key === `item:${it.id}`)!), ['office', 'laptop']) === 'laptop')!;
    const unit = `${ROUND.id}:${unitOf(blocks, R.pieces.find((p) => p.key === `item:${mineFirst.id}`)!)}`;
    shared.files.set('checks-office-d1.jsonl', officeLines(line({ claim: { keys: [unit], pc: 'office', label: 'PC A', until: '2026-11-12T04:00:00.000Z' } })));
    val(await ai.firstPass('d1')); expect(checked(svc)).not.toContain(mineFirst.id);
    shared.append('checks-office-d1.jsonl', line({ release: { keys: [unit], pc: 'office' } }));
    val(await ai.firstPass('d1')); expect(checked(svc)).toContain(mineFirst.id);
    ai.close();
  });

  it('a PC signed out mid-check lets go of the pieces it claimed, so the other PC can finish the check', async () => {
    const { ai, shared, svc } = await setUp({ timing: { giveUp: 50, retryFirst: 10, retryMax: 20, retryEvery: 60_000 } });
    shared.files.set('checks-office-d1.jsonl', officeLines());
    const signedOut = tokenHolder({}); const answer = svc.script;
    svc.script = async (c) => { await signedOut.get(); return answer(c); };            // as North does: every call waits on the sign-in
    const r = await ai.firstPass('d1'); expect(!r.ok && r.error.message).toMatch(/ sign-in\. The check resumes once someone signs in\.$/);   // told why, not that the service is down
    const mine = shared.read('checks-laptop-d1.jsonl')!.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const claimed = mine.flatMap((l) => l.claim?.keys ?? []); const released = mine.flatMap((l) => l.release?.keys ?? []);
    expect(claimed.length).toBeGreaterThan(0); expect(released).toEqual(expect.arrayContaining(claimed));
    ai.close();
  });
});
const val = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
