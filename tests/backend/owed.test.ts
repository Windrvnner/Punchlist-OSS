// @vitest-environment node
// A finding in two versions that nobody has chosen between cannot take the backend's mark. The run goes on, the
// mark is owed in the deal's shared check log, and the next run on any PC writes it once a version is chosen.
import { describe, it, expect } from 'vitest';
import { nodeAi, type AiDocs } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { memRepo } from '../adapters/memRepo';
import type { DocRecord } from '../../src/backend/documents';
import type { Folder } from '../../src/backend/logRepository';

class Mem implements Folder { files = new Map<string, string>(); list() { return [...this.files.keys()]; } size(n: string) { return this.files.get(n)?.length ?? -1; } read(n: string) { return this.files.get(n) ?? null; } append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); } write(n: string, t: string) { this.files.set(n, t); } }
const doc = (n: number, name: string): DocRecord => ({ docId: `doc_${String(n).padStart(24, '0')}`, hash: 'h', name, folder: 'vdr', rel: name, size: 1, pages: 10 } as DocRecord);
let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 12, 9, 0, 0, t++)).toISOString();
const GONE = 'A document it cites is no longer in the data room';

async function setUp(o: { staleOnce?: boolean } = {}) {
  const recs = [doc(1, 'Credit agreement.pdf'), doc(2, 'Bond letter.pdf')];
  const svc = new StandInService((c: any) => JSON.stringify(c.prompt.includes('Which are the core documents') ? { core: [1] } : {}));
  const docs: AiDocs = { records: () => recs, wanted: async (_d: string, ids: string[]) => recs.filter((r) => ids.includes(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })) } as any;
  const repo = memRepo(clock); const shared = new Mem();
  await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { id: 'd1', name: 'Proseware' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } });
  const f = { id: 'f_1', dealId: 'd1', title: 'Bond missing', workstream: 'Legal', status: 'open', body: ['x [1]'], sources: [{ doc: 'Bond letter.pdf', loc: 'p. 1', docId: recs[1].docId }], updated: false };
  await repo.transaction({ writes: [{ kind: 'finding', id: 'f_1', data: f, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'finding', id: 'f_1' }] } });
  // `staleOnce`: the first read of a finding in two versions misses its other version, as when it arrives between the read and the write
  let stale = !!o.staleOnce;
  const seen = new Proxy(repo, { get(target, k) { if (k === 'get') return async (kind: any, id: string) => { const r: any = await target.get(kind, id); if (stale && r.ok && r.value?.conflict?.length) { stale = false; const { conflict, ...rest } = r.value; return { ok: true, value: rest }; } return r; }; const v = (target as any)[k]; return typeof v === 'function' ? v.bind(target) : v; } });
  const make = (installId: string) => nodeAi({ service: svc, docs, keeper: new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock }), repo: seen, shared, installId, clock, checklist: () => ({ broad: [], product: [], sector: [] }) });
  return { recs, repo, shared, f, onA: make('A'), onB: make('B') };
}
const lines = (shared: Mem) => [...shared.files.entries()].filter(([n]) => n.startsWith('checks-')).flatMap(([, t]) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l)));

describe('a mark on a finding in two versions', () => {
  it('waits instead of stopping the run, and is written by a later run on another PC once a version is chosen', async () => {
    const { recs, repo, shared, f, onA, onB } = await setUp();
    expect((await onA.firstPass('d1')).ok).toBe(true);
    repo.peer.edit('finding', 'f_1', { ...f, note: 'sroe: chased the sponsor' }, { by: 'sroe', from: 'PC B', at: clock() }); await repo.sync();
    recs.splice(1, 1);                                                             // the bond letter is withdrawn from the data room

    const second = await onA.firstPass('d1');
    expect(second.ok).toBe(true);                                                  // the run is not stopped by one finding
    expect(second.ok && second.value.marked).toEqual([]);
    expect(lines(shared).filter((l) => l.owed)).toEqual([expect.objectContaining({ owed: { finding: 'f_1', why: GONE } })]);
    expect(((await repo.get('finding', 'f_1')) as any).value.envelope.data.updated).toBe(false);

    // still in two versions: a second run waits again and does not owe it twice
    expect((await onA.firstPass('d1')).ok).toBe(true);
    expect(lines(shared).filter((l) => l.owed)).toHaveLength(1);

    // a person chooses (this PC's version); the next run, on the other PC, writes the mark and says it is paid
    const cur: any = (await repo.get('finding', 'f_1') as any).value;
    const chose = await repo.transaction({ writes: [{ kind: 'finding', id: 'f_1', data: cur.envelope.data, expectedRev: cur.rev, resolves: cur.conflict.map((v: any) => v.id) }] });
    expect(chose.ok).toBe(true);
    const third = await onB.firstPass('d1');
    expect(third.ok && third.value.marked).toContain('f_1');
    const after: any = (await repo.get('finding', 'f_1') as any).value.envelope.data;
    expect(after.updated).toBe(true); expect(after.updatedWhy).toBe(GONE);
    expect(lines(shared).filter((l) => l.paid)).toEqual([expect.objectContaining({ paid: { finding: 'f_1', why: GONE } })]);

    // paid: nothing more is owed or written
    expect((await onA.firstPass('d1')).ok).toBe(true);
    expect(lines(shared).filter((l) => l.paid)).toHaveLength(1);
  });

  it('is paid as nothing to do when the finding was closed in the meantime', async () => {
    const { recs, repo, shared, f, onA } = await setUp();
    // another open finding keeps the deal's runs going once f_1 is closed
    await repo.transaction({ writes: [{ kind: 'finding', id: 'f_2', data: { ...f, id: 'f_2', title: 'Other', sources: [{ doc: 'Credit agreement.pdf', loc: 'p. 2', docId: recs[0].docId }] }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'finding', id: 'f_2' }] } });
    expect((await onA.firstPass('d1')).ok).toBe(true);
    repo.peer.edit('finding', 'f_1', { ...f, note: 'sroe' }, { by: 'sroe', from: 'PC B', at: clock() }); await repo.sync();
    recs.splice(1, 1);
    expect((await onA.firstPass('d1')).ok).toBe(true);
    const cur: any = (await repo.get('finding', 'f_1') as any).value;
    expect((await repo.transaction({ writes: [{ kind: 'finding', id: 'f_1', data: { ...cur.envelope.data, status: 'closed' }, expectedRev: cur.rev, resolves: cur.conflict.map((v: any) => v.id) }] })).ok).toBe(true);
    const r = await onA.firstPass('d1');
    expect(r.ok && r.value.marked).toEqual([]);
    expect(((await repo.get('finding', 'f_1')) as any).value.envelope.data.updated).toBe(false);
    expect(lines(shared).filter((l) => l.paid)).toHaveLength(1);
  });

  it('waits too when the other version arrives between the read and the write', async () => {
    const { recs, repo, shared, f, onA } = await setUp({ staleOnce: true });
    expect((await onA.firstPass('d1')).ok).toBe(true);
    repo.peer.edit('finding', 'f_1', { ...f, note: 'sroe' }, { by: 'sroe', from: 'PC B', at: clock() }); await repo.sync();
    recs.splice(1, 1);
    expect((await onA.firstPass('d1')).ok).toBe(true);
    expect(lines(shared).filter((l) => l.owed)).toHaveLength(1);
  });
});
