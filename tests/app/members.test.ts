import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, DeleteDeal } from '../../src/app/commands/deals';
import { SetDealMember, isMine } from '../../src/app/commands/members';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { ok, type Result } from '../../src/domain/result';
import { ask } from '../../src/app/conversations';

// a deal shows for the people who created it or added it
const COMMANDS = [CreateDeal, DeleteDeal, SetDealMember];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 15, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

/** a person on their own PC; `shared` is the team's folder, the same for everyone */
async function person(name: string, shared?: ReturnType<typeof memRepo>['shared']) {
  const opts = { latency: [0, 0] as [number, number] };
  const repo = memRepo(clock.now, { user: () => name, ...(shared ? { shared } : {}) });
  const base = mockSession(opts);
  const session = { load: async (): Promise<Result<any>> => { const r = await base.load(); return r.ok ? ok({ ...r.value, user: { ...r.value.user, name } }) : r; } };
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session, local: new MemoryLocal(), clock, ids }, COMMANDS);
  await store.boot();
  return { store, repo };
}

describe('my deals', () => {
  it('a new deal is in its creator’s list only', async () => {
    const adoe = await person('adoe');
    await adoe.store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const d = Object.values(adoe.store.get().deals)[0];
    expect(isMine(adoe.store.get(), d.id)).toBe(true);
    const sroe = await person('sroe', adoe.repo.shared);
    expect(sroe.store.get().deals[d.id]?.name).toBe('Project Datum');      // every deal is there to add
    expect(isMine(sroe.store.get(), d.id)).toBe(false);
  });

  it('Add to my deals, then Undo, and adding twice is refused', async () => {
    const adoe = await person('adoe');
    await adoe.store.dispatch(CreateDeal, { name: 'Margie', folders: [] });
    const d = Object.values(adoe.store.get().deals)[0];
    const sroe = await person('sroe', adoe.repo.shared);
    const r = await sroe.store.dispatch(SetDealMember, { dealId: d.id, on: true });
    expect(r.ok).toBe(true);
    expect(isMine(sroe.store.get(), d.id)).toBe(true);
    expect((await sroe.store.dispatch(SetDealMember, { dealId: d.id, on: true })).ok).toBe(false);
    await sroe.store.undo((r as any).value.opId);
    expect(isMine(sroe.store.get(), d.id)).toBe(false);
    expect(isMine(adoe.store.get(), d.id)).toBe(true);                    // sroe's record is sroe's alone
  });

  it('the list follows the person to another PC', async () => {
    const adoe = await person('adoe');
    await adoe.store.dispatch(CreateDeal, { name: 'Nod', folders: [] });
    const d = Object.values(adoe.store.get().deals)[0];
    const home = await person('adoe', adoe.repo.shared);
    expect(isMine(home.store.get(), d.id)).toBe(true);
  });

  it('deleting a deal takes it out of every list', async () => {
    const adoe = await person('adoe');
    await adoe.store.dispatch(CreateDeal, { name: 'Coho', folders: [] });
    const d = Object.values(adoe.store.get().deals)[0];
    expect((await adoe.store.dispatch(DeleteDeal, { dealId: d.id, typedName: d.name })).ok).toBe(true);
    expect(Object.values(adoe.store.get().members).filter((m) => m.dealId === d.id)).toEqual([]);
  });
  it('a question across deals reaches only the person’s own deals', async () => {
    const adoe = await person('adoe');
    await adoe.store.dispatch(CreateDeal, { name: 'Trey', folders: [] });
    const sroe = await person('sroe', adoe.repo.shared);
    await sroe.store.dispatch(CreateDeal, { name: 'Liberty', folders: [] });
    const mine = Object.values(sroe.store.get().deals).find((d) => d.name === 'Project Liberty')!.id;
    expect(Object.keys(sroe.store.get().deals)).toHaveLength(2);           // adoe's deal is there to add, but not sroe's
    let asked: { dealId?: string; dealIds?: string[] } | undefined;
    sroe.store.services.ai.answer = async (input) => { asked = input; return ok({ text: 'Nothing open.', sources: [] }) as any; };
    await ask(sroe.store, { kind: 'all' }, 'What is still open across my deals?');
    expect(asked?.dealId).toBeUndefined();
    expect(asked?.dealIds).toEqual([mine]);
  });
});
