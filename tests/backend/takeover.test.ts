// A check whose PCs have all gone is finished by a PC that holds its documents: by Check again, and by the
// background look over deals once this PC has indexed the deal. Rounds are read back from the shared folder.
import { describe, it, expect } from 'vitest';
import type { AiDocs } from '../../src/backend/ai';
import { view } from '../../src/backend/rounds';
import { setup, Mem, doc, deal, val, OK, itemsIn, checkLines } from './reviewKit';

const LIST = { broad: [{ id: 'a1', text: 'The margin is as in the term sheet' }, { id: 'a2', text: 'A decommissioning bond is in place' }], product: [], sector: [] };
const okAll = (c: Parameters<typeof itemsIn>[0]) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });
const roundsIn = (shared: Mem) => view(checkLines(shared).sort((a, b) => (a.n ?? 0) - (b.n ?? 0))).rounds;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** a PC that has gone left a check of `kind` open over these documents, and said it left */
function leftRound(shared: Mem, kind: 'deep' | 'quick', docList: string[]) {
  const at = '2026-11-01T09:00:00.000Z'; const id = `r_00000000000000000000000000_${kind}`;
  const plan = { id, kind, by: 'ghost', label: 'Old laptop', docs: 'x', docList, core: { key: 'c', ids: [] }, block: 10, pieces: LIST.broad.map((it) => ({ key: `item:${it.id}`, text: it.text, reason: 'settled', stage: 'check' })) };
  shared.append('checks-ghost-d1.jsonl', [{ v: 1, at, n: 9000, pc: 'ghost', plan }, { v: 1, at, n: 9001, pc: 'ghost', member: { round: id, pc: 'ghost', epoch: 1, ok: true } }, { v: 1, at, n: 9002, pc: 'ghost', left: { round: id, pc: 'ghost' } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return id;
}

describe('a check whose PCs have all gone', () => {
  it('Check again finishes a left check of the kind asked for, rather than writing it off and paying for another', async () => {
    const shared = new Mem(); const recs = { d1: [doc(1, 'Credit agreement.pdf'), doc(2, 'Term sheet.pdf')] };
    const s = setup(okAll, recs, { shared, installId: 'pc', checklist: () => LIST, batch: 1 });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    const id = leftRound(shared, 'deep', recs.d1.map((r) => r.docId));
    val(await s.ai.checkAll!({ dealId: 'd1', deep: true }));
    expect(roundsIn(shared).get(id)?.end?.kind).toBe('done');
    expect([...roundsIn(shared).values()].filter((r) => r.def.kind === 'deep').length).toBe(1);
  });

  it('the look over deals leaves a left check alone while this PC is indexing the deal, and finishes it once indexing is done', async () => {
    const shared = new Mem(); const recs = { d1: [doc(1, 'Credit agreement.pdf'), doc(2, 'Term sheet.pdf')] }; let busy = false;
    const docs: AiDocs = { records: (d) => (recs as Record<string, typeof recs.d1>)[d] ?? [], wanted: async (d, ids) => recs.d1.filter((r) => ids.includes(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })), indexing: () => busy };
    const s = setup(okAll, recs, { shared, installId: 'pc', checklist: () => LIST, batch: 1, docs, timing: { watch: 20, renew: 50 } });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    busy = true; const id = leftRound(shared, 'deep', recs.d1.map((r) => r.docId));
    s.ai.watchDeals!(); await settle(300);
    expect(roundsIn(shared).get(id)?.end).toBeNull(); expect(roundsIn(shared).get(id)?.members.has('pc')).toBe(false);
    busy = false;
    for (let i = 0; i < 100 && roundsIn(shared).get(id)?.end?.kind !== 'done'; i++) await settle(50);
    expect(roundsIn(shared).get(id)?.end?.kind).toBe('done');
  });
});
