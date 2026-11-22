// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { StoreKeeper, storeName, fromStoreName } from '../../src/backend/storeKeeper';
import { StandInService } from '../../src/backend/service';
import type { Folder } from '../../src/backend/logRepository';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; } size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; } append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); } write(n: string, t: string) { this.files.set(n, t); }
}
const id = (n: number) => `doc_${String(n).padStart(24, '0')}`;
const doc = (n: number) => ({ docId: id(n), name: `Document ${n}.pdf`, read: () => new TextEncoder().encode(`contents of ${n}`) });
function setup(limit = 3, svc = new StandInService(), local = new Mem()) { let t = 0; const clock = () => new Date(Date.UTC(2026, 10, 10, 9, 0, t++)).toISOString(); return { svc, local, keeper: new StoreKeeper(svc, local, { limit, clock, recheckMs: 0 }) }; }
const inStore = async (svc: StandInService) => (await svc.list()).map((f) => fromStoreName(f.name)?.docId ?? f.name).sort();

describe('the file store is kept within its limit', () => {
  it('uses the shared control-file limit when constructed without an override', async () => {
    vi.resetModules();
    vi.doMock('../../src/control', async (original) => {
      const actual = await original<typeof import('../../src/control')>();
      return { ...actual, control: { ...actual.control, limits: { ...actual.control.limits, storedFiles: 10 } } };
    });
    try {
      const { StoreKeeper: ConfiguredKeeper } = await import('../../src/backend/storeKeeper');
      const service = new StandInService();
      const keeper = new ConfiguredKeeper(service, new Mem());
      await keeper.ensure(Array.from({ length: 10 }, (_, index) => doc(index + 1)));
      await keeper.ensure([doc(11)]);
      expect(service.files.size).toBe(10);
      expect(service.removed).toHaveLength(1);
    } finally {
      vi.doUnmock('../../src/control');
      vi.resetModules();
    }
  });

  it('a document is uploaded once, under a name that carries its id, and found there afterwards', async () => {
    const { svc, keeper } = setup();
    const first = await keeper.ensure([doc(1), doc(2)]); const again = await keeper.ensure([doc(1)]);
    expect(svc.uploads).toBe(2); expect(again[id(1)]).toBe(first[id(1)]);
    expect((await svc.list()).map((f) => f.name)).toEqual([storeName(id(1), 'Document 1.pdf'), storeName(id(2), 'Document 2.pdf')]);
    expect(keeper.loaded().sort()).toEqual([id(1), id(2)]); expect(fromStoreName('Somebody else’s notes.pdf')).toBeNull();
  });

  it('when room is needed, the document used longest ago goes, and using a document counts', async () => {
    const { svc, keeper } = setup(3);
    await keeper.ensure([doc(1)]); await keeper.ensure([doc(2)]); await keeper.ensure([doc(3)]);
    await keeper.ensure([doc(1)]);                                             // 1 is used again, so 2 is now the oldest
    await keeper.ensure([doc(4)]);
    expect(await inStore(svc)).toEqual([id(1), id(3), id(4)]); expect(svc.removed.length).toBe(1);
    await keeper.ensure([doc(2)]);                                             // needed again: uploaded again, and 3 makes way
    expect(await inStore(svc)).toEqual([id(1), id(2), id(4)]); expect(svc.uploads).toBe(5);
  });

  it('the store never holds more than the limit, however many documents pass through', async () => {
    const { svc, keeper } = setup(5); let most = 0;
    for (let n = 1; n <= 40; n++) { await keeper.ensure([doc(n), doc(Math.max(1, n - 1))]); most = Math.max(most, svc.files.size); }
    expect(most).toBe(5); expect(svc.files.size).toBe(5);
  });

  it('files this app did not upload are never removed and do not count toward the limit', async () => {
    const { svc, keeper } = setup(3); const theirs = await svc.upload({ name: 'Somebody else’s notes.pdf', bytes: new Uint8Array([1]) });
    await keeper.ensure([doc(1), doc(2)]); await keeper.ensure([doc(3)]);
    expect(svc.files.has(theirs)).toBe(true); expect(await inStore(svc)).toEqual(['Somebody else’s notes.pdf', id(1), id(2), id(3)].sort());
    await keeper.ensure([doc(4)]); expect(await inStore(svc)).toEqual(['Somebody else’s notes.pdf', id(2), id(3), id(4)].sort());
    await expect(keeper.ensure([doc(5), doc(6), doc(7), doc(8)])).rejects.toThrow(/4 documents cannot all be loaded at once: the store holds 3/);
    expect(svc.files.has(theirs)).toBe(true); expect(await inStore(svc)).toContain(id(4));         // and nothing was thrown away for a request that could not be met
  });

  it('a document another PC uploaded is recognized and not uploaded twice; with no record of its use here, ' +
    'it goes first', async () => {
    const svc = new StandInService(); const office = setup(3, svc), home = setup(3, svc);
    await office.keeper.ensure([doc(1), doc(2)]);
    await home.keeper.ensure([doc(2), doc(3)]); expect(svc.uploads).toBe(3);
    await home.keeper.ensure([doc(4)]); expect(await inStore(svc)).toEqual([id(2), id(3), id(4)]);
    await office.keeper.ensure([doc(1)]); expect(svc.uploads).toBe(5);         // the office finds 1 gone, and puts it back
    expect(svc.files.size).toBe(3);
  });

  it('two PCs that upload the same document at once end up keeping the same copy', async () => {
    const svc = new StandInService(); const a = await svc.upload({ name: storeName(id(1), 'Document 1.pdf'), bytes: new Uint8Array([1]) }); const b = await svc.upload({ name: storeName(id(1), 'Document 1.pdf'), bytes: new Uint8Array([1]) });
    const office = setup(3, svc), home = setup(3, svc); office.local.write('store.json', JSON.stringify({ [id(1)]: { fileId: b, usedAt: '2026-11-10T08:00:00.000Z' } }));
    const o = new StoreKeeper(svc, office.local, { limit: 3 }); const h = new StoreKeeper(svc, home.local, { limit: 3 }); home.local.write('store.json', JSON.stringify({ [id(1)]: { fileId: a, usedAt: '2026-11-10T08:00:00.000Z' } }));
    await o.trim(); await h.trim();
    expect([...svc.files.keys()]).toEqual([a]); expect((await o.ensure([doc(1)]))[id(1)]).toBe(a); expect(svc.uploads).toBe(2);
  });

  it('the check run every once in a while takes out whatever is over the limit', async () => {
    const svc = new StandInService(); const { keeper } = setup(3, svc);
    await keeper.ensure([doc(1), doc(2), doc(3)]);
    for (const n of [7, 8]) await svc.upload({ name: storeName(id(n), `Document ${n}.pdf`), bytes: new Uint8Array([n]) });      // another PC, with a higher limit or none
    expect(await keeper.trim()).toBe(2); expect(svc.files.size).toBe(3); expect(await inStore(svc)).toEqual([id(1), id(2), id(3)]);   // the ones with no record of use went first
    expect(await keeper.trim()).toBe(0);
  });

  it('between looks at the store, what this PC remembers is used: no call to the store for a document already there', async () => {
    const svc = new StandInService(); let lists = 0; const list = svc.list.bind(svc); svc.list = async () => { lists++; return list(); };
    const keeper = new StoreKeeper(svc, new Mem(), { limit: 3 });               // the default: look again after a minute
    await keeper.ensure([doc(1)]); await keeper.ensure([doc(1)]); await keeper.ensure([doc(1), doc(2)]);
    expect(lists).toBe(1); expect(svc.uploads).toBe(2);
  });

  it('two requests at once do not both take the last place', async () => {
    const { svc, keeper } = setup(3); await keeper.ensure([doc(1), doc(2)]);
    await Promise.all([keeper.ensure([doc(3)]), keeper.ensure([doc(4)]), keeper.ensure([doc(5)])]);
    expect(svc.files.size).toBe(3);
  });

  it('what was used when is remembered across a restart', async () => {
    const svc = new StandInService(), local = new Mem(); const first = setup(3, svc, local);
    await first.keeper.ensure([doc(1)]); await first.keeper.ensure([doc(2)]); await first.keeper.ensure([doc(3)]); await first.keeper.ensure([doc(1)]);
    const again = new StoreKeeper(svc, local, { limit: 3, clock: () => '2026-11-11T09:00:00.000Z' });
    expect(again.loaded().sort()).toEqual([id(1), id(2), id(3)]);
    await again.ensure([doc(4)]); expect(await inStore(svc)).toEqual([id(1), id(3), id(4)]);
  });
});
