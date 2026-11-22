import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, SetFindingStatus, RestoreFindingSnapshot } from '../../src/app/commands/findings';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { dealFindings } from '../../src/app/state';

// closed findings the documents bring into question are marked; a person reopens one, or leaves it closed
const COMMANDS = [CreateDeal, CreateFinding, SetFindingStatus, RestoreFindingSnapshot];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 14, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

async function setup(n: number) {
  const opts = { latency: [0, 0] as [number, number] };
  const repo = memRepo(clock.now, disk());
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
  const dealId = Object.values(store.get().deals)[0].id; await store.loadDeal(dealId);
  for (let i = 0; i < n; i++) await store.dispatch(CreateFinding, { dealId, title: `Finding ${i + 1}`, workstream: 'Legal' });
  const found = dealFindings(store.get(), dealId);
  for (const f of found) {
    await store.dispatch(SetFindingStatus, { dealId, findingId: f.id, status: 'closed' });
    // as a check marks it: the backend writes the mark on the record
    const closed = store.get().findings[f.id];
    await store.dispatch(RestoreFindingSnapshot, { dealId, findingId: f.id, snapshot: { ...closed, updated: true, updatedWhy: 'New lender term sheet' } });
  }
  return { store, dealId, ids: found.map((f) => f.id) };
}

describe('closed findings brought into question', () => {
  it('closing keeps the date, and reopening clears it', async () => {
    const { store, dealId, ids: [id] } = await setup(1);
    expect(store.get().findings[id].closedAt).toMatch(/^2026-11-14/);
    await store.dispatch(SetFindingStatus, { dealId, findingId: id, status: 'open' });
    expect(store.get().findings[id].closedAt).toBeUndefined();
  });

  it('reopening a marked closed finding keeps the mark, so it asks to be updated', async () => {
    const { store, dealId, ids: [id] } = await setup(1);
    const r = await store.dispatch(SetFindingStatus, { dealId, findingId: id, status: 'open' });
    expect(r.ok).toBe(true);
    expect(store.get().findings[id]).toMatchObject({ status: 'open', updated: true });
    await store.undo((r as any).value.opId);
    expect(store.get().findings[id]).toMatchObject({ status: 'closed', updated: true });
  });
});
