// @vitest-environment node
// Taking a folder off a deal, and Undo, on the real record store.
import { describe, it, expect } from 'vitest';
import { LogRepository, type Folder } from '../../src/backend/logRepository';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal, AddFolders, RemoveFolder, RestoreFolder, RecordIndexingProgress, foldersWithRemoved } from '../../src/app/commands/deals';
import { registry, Undo } from '../../src/app/commands/undo';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
const COMMANDS: any[] = [CreateDeal, AddFolders, RemoveFolder, RestoreFolder, RecordIndexingProgress, Undo];
for (const c of COMMANDS) registry.set(c.name, c);
let idn = 0;
async function setup() {
  let tick = 0; const now = () => new Date(Date.UTC(2026, 10, 15, 9, 0, 0, 0) + (tick++) * 1000).toISOString();
  const repo = new LogRepository({ shared: new Mem(), local: new Mem(), label: 'Office', user: () => 'sroe', clock: now, newId: () => 'office' });
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec,
    session: {
      load: async () => ({ ok: true as const, value: {
        user: { name: 'sroe', initials: 'SA' }, lastSeen: now(), models: [{ id: 'm', name: 'M' }], defaultModel: 'm',
      } }),
    },
    local: new MemoryLocal(),
    clock: { now }, ids: { next: (p: string) => `${p}_01HPRBFXXXXXXXXXXXR${String(idn++).padStart(7, '0')}` } } as any, COMMANDS);
  await store.boot();
  const folder = (path: string, label: string) => ({ path, label, files: 10, size: '1 MB' });
  const r = await store.dispatch(CreateDeal, { name: 'Liberty', folders: [folder('C:\\VDR\\Legal', 'Legal'), folder('C:\\VDR\\Tech', 'Tech'), folder('C:\\VDR\\Old', '')] });
  expect(r.ok).toBe(true);
  const dealId = Object.keys(store.get().deals)[0];
  return { store, dealId, paths: () => store.get().deals[dealId].folders.map((f) => f.path) };
}

describe('removing a folder from a deal', () => {
  it('takes the folder off, says so by its label, and Undo puts it back in its place with its counts', async () => {
    const { store, dealId, paths } = await setup();
    const r = await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' }); expect(r.ok).toBe(true);
    expect(paths()).toEqual(['C:\\VDR\\Legal', 'C:\\VDR\\Old']);
    expect(store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Tech removed', action: { label: 'Undo' } });
    if (!r.ok) return; expect((await store.undo(r.value.opId)).ok).toBe(true);
    expect(store.get().deals[dealId].folders.map((f) => [f.path, f.label, f.files])).toEqual([['C:\\VDR\\Legal', 'Legal', 10], ['C:\\VDR\\Tech', 'Tech', 10], ['C:\\VDR\\Old', '', 10]]);
  });
  it('names a folder with no label by its path, and refuses one that is no longer on the deal', async () => {
    const { store, dealId } = await setup();
    expect((await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Old' })).ok).toBe(true);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('C:\\VDR\\Old removed');
    const again = await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Old' }, { quiet: true }); expect(!again.ok && again.error.message).toBe('That folder is no longer on this deal');
  });
  it('indexing that finishes after a folder was removed does not put it back', async () => {
    const { store, dealId, paths } = await setup();
    const polled = store.get().deals[dealId].folders.map((f) => ({ ...f, indexed: f.files }));     // the run still had all three
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Legal' });
    expect((await store.dispatch(RecordIndexingProgress, { dealId, folders: polled, log: ['Indexed 30 files'], done: true }, { quiet: true })).ok).toBe(true);
    expect(paths()).toEqual(['C:\\VDR\\Tech', 'C:\\VDR\\Old']);
    expect(store.get().deals[dealId].folders.every((f) => f.indexed === 10)).toBe(true);
  });

  it('keeps a removed folder with its counts and place, and Restore brings it back without indexing it again', async () => {
    const { store, dealId, paths } = await setup();
    const kept = () => store.get().deals[dealId].removed;
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' });
    expect(kept()).toEqual([{ path: 'C:\\VDR\\Tech', label: 'Tech', files: 10, size: '1 MB', indexed: 0, reviewed: 0, at: 1 }]);
    const { at, ...folder } = kept()[0];
    const r = await store.dispatch(RestoreFolder, { dealId, folder, at }); expect(r.ok).toBe(true);
    expect(paths()).toEqual(['C:\\VDR\\Legal', 'C:\\VDR\\Tech', 'C:\\VDR\\Old']);
    expect(store.get().deals[dealId].folders[1]).toMatchObject({ indexed: 0, files: 10 });
    expect(kept()).toEqual([]);
    expect(store.get().ui.toasts.at(-1)).toMatchObject({ text: 'Tech restored', action: { label: 'Undo' } });
    if (!r.ok) return; expect((await store.undo(r.value.opId)).ok).toBe(true);           // Undo of Restore removes it again, still listed
    expect(kept().map((f) => f.path)).toEqual(['C:\\VDR\\Tech']);
  });
  it('Undo on the notice takes the folder off the removed list too', async () => {
    const { store, dealId } = await setup();
    const r = await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Legal' });
    if (!r.ok) return; expect((await store.undo(r.value.opId)).ok).toBe(true);
    expect(store.get().deals[dealId].removed).toEqual([]);
    expect(store.get().deals[dealId].folders.map((f) => f.path)).toEqual(['C:\\VDR\\Legal', 'C:\\VDR\\Tech', 'C:\\VDR\\Old']);
  });
  it('a removed folder added again is indexed again and no longer listed as removed', async () => {
    const { store, dealId, paths } = await setup();
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Old' });
    expect((await store.dispatch(AddFolders, { dealId, folders: [{ path: 'c:\\vdr\\old\\', label: 'Old', files: 12, size: '1 MB' }] })).ok).toBe(true);
    expect(store.get().deals[dealId].removed).toEqual([]);
    expect(paths()).toEqual(['C:\\VDR\\Legal', 'C:\\VDR\\Tech', 'c:\\vdr\\old\\']);
  });
  it('refuses to put back a folder that overlaps one added since, saying which', async () => {
    const { store, dealId } = await setup();
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' });
    await store.dispatch(AddFolders, { dealId, folders: [{ path: 'C:\\VDR\\Tech\\Grid', label: 'Grid', files: 3, size: '1 MB' }] });
    const { at, ...folder } = store.get().deals[dealId].removed[0];
    const r = await store.dispatch(RestoreFolder, { dealId, folder, at }, { quiet: true });
    expect(!r.ok && r.error.message).toBe('Grid, already on this deal, is inside Tech');
    expect(store.get().deals[dealId].removed.map((f) => f.path)).toEqual(['C:\\VDR\\Tech']);   // still listed, nothing lost
  });
  it('lists removed folders where each stood, however many were removed and in what order', async () => {
    const { store, dealId } = await setup();
    await store.dispatch(AddFolders, { dealId, folders: ['A', 'B', 'C', 'D', 'E'].map((x) => ({ path: 'C:\\Room\\' + x, label: x, files: 1, size: '1 MB' })) });
    const all = store.get().deals[dealId].folders.map((f) => f.path);
    for (const p of [all[2], all[6], all[0], all[7]]) await store.dispatch(RemoveFolder, { dealId, path: p });
    const rows = foldersWithRemoved(store.get().deals[dealId]);
    expect(rows.map((r) => r.f.path)).toEqual(all);
    expect(rows.filter((r) => r.gone).map((r) => r.f.path)).toEqual([all[0], all[2], all[6], all[7]]);
  });
  it('treats a path written with / or \\ as one folder, and lists a folder on the deal again only once', async () => {
    const { store, dealId, paths } = await setup();
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' });
    expect((await store.dispatch(AddFolders, { dealId, folders: [{ path: 'c:/vdr/tech', label: 'Tech', files: 10, size: '1 MB' }] })).ok).toBe(true);
    expect(store.get().deals[dealId].removed).toEqual([]);
    expect((await store.dispatch(AddFolders, { dealId, folders: [{ path: 'C:\\VDR\\Legal\\', label: '', files: 1, size: '1 MB' }] }, { quiet: true })).ok).toBe(false);
    const d = store.get().deals[dealId];
    expect(foldersWithRemoved({ folders: d.folders, removed: [{ ...d.folders[0], at: 0 }] }).map((r) => r.f.path)).toEqual(paths());
  });
  it('refuses to add a folder inside one put back while it waited to be added', async () => {
    const { store, dealId } = await setup();
    const r = await store.dispatch(AddFolders, { dealId, folders: [{ path: 'C:\\VDR\\Tech\\Grid', label: 'Grid', files: 3, size: '1 MB' }] }, { quiet: true });
    expect(!r.ok && r.error.message).toBe('Grid is inside Tech, already on this deal');
  });
  it('no row moves when folders are removed and put back in any order', async () => {
    const { store, dealId } = await setup();
    await store.dispatch(AddFolders, { dealId, folders: ['A', 'B', 'C', 'D', 'E'].map((x) => ({ path: 'C:\\Room\\' + x, label: x, files: 1, size: '1 MB' })) });
    const order = () => foldersWithRemoved(store.get().deals[dealId]).map((r) => r.f.path);
    const all = order(); let seed = 7; const rnd = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
    for (let step = 0; step < 120; step++) {
      const rows = foldersWithRemoved(store.get().deals[dealId]); const r = rows[rnd(rows.length)];
      if (r.gone) { const { at, ...folder } = r.gone; expect((await store.dispatch(RestoreFolder, { dealId, folder, at }, { quiet: true })).ok).toBe(true); }
      else expect((await store.dispatch(RemoveFolder, { dealId, path: r.f.path }, { quiet: true })).ok).toBe(true);
      expect(order()).toEqual(all);
    }
  });
  it('Undo of a removal puts the folder back in its row, with others removed above it', async () => {
    const { store, dealId, paths } = await setup();
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Legal' });
    const r = await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' });
    if (!r.ok) return; expect((await store.undo(r.value.opId)).ok).toBe(true);
    expect(paths()).toEqual(['C:\\VDR\\Tech', 'C:\\VDR\\Old']);
    expect(foldersWithRemoved(store.get().deals[dealId]).map((x) => x.f.path)).toEqual(['C:\\VDR\\Legal', 'C:\\VDR\\Tech', 'C:\\VDR\\Old']);
  });
  it('refuses two folders, one inside the other, added together', async () => {
    const { store, dealId } = await setup();
    const r = await store.dispatch(AddFolders, { dealId, folders: [{ path: 'D:\\X', label: 'X', files: 1, size: '1 MB' }, { path: 'D:\\X\\Y', label: 'Y', files: 1, size: '1 MB' }] }, { quiet: true });
    expect(!r.ok && r.error.message).toBe('Y is inside X, already on this deal');
  });
  it('a folder removed before its indexing finished goes back on a deal that is indexing again, so it is not stuck', async () => {
    const { store, dealId } = await setup();
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' });
    const polled = store.get().deals[dealId].folders.map((f) => ({ ...f, indexed: f.files }));
    await store.dispatch(RecordIndexingProgress, { dealId, folders: polled, log: [], done: true }, { quiet: true });
    expect(store.get().deals[dealId].stage).toBe('ready');
    const { at, ...folder } = store.get().deals[dealId].removed[0];
    expect((await store.dispatch(RestoreFolder, { dealId, folder, at })).ok).toBe(true);
    expect(store.get().deals[dealId].stage).toBe('indexing');
  });
  it('a fully indexed folder put back leaves a finished deal finished', async () => {
    const { store, dealId } = await setup();
    const polled = store.get().deals[dealId].folders.map((f) => ({ ...f, indexed: f.files }));
    await store.dispatch(RecordIndexingProgress, { dealId, folders: polled, log: [], done: true }, { quiet: true });
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' });
    const { at, ...folder } = store.get().deals[dealId].removed[0];
    await store.dispatch(RestoreFolder, { dealId, folder, at });
    expect(store.get().deals[dealId].stage).toBe('ready');
  });
  it('a removed folder added again by its path goes back in its own row, and no other row moves', async () => {
    const { store, dealId } = await setup();
    await store.dispatch(AddFolders, { dealId, folders: [{ path: 'C:\\VDR\\D', label: 'D', files: 1, size: '1 MB' }] });
    await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Tech' }); await store.dispatch(RemoveFolder, { dealId, path: 'C:\\VDR\\Old' });
    const before = foldersWithRemoved(store.get().deals[dealId]).map((r) => r.f.path.toLowerCase());
    await store.dispatch(AddFolders, { dealId, folders: [{ path: 'c:/vdr/tech', label: 'Tech', files: 10, size: '1 MB' }] });
    expect(foldersWithRemoved(store.get().deals[dealId]).map((r) => r.f.path.toLowerCase().replace(/\//g, '\\'))).toEqual(before);
    expect(store.get().deals[dealId].removed.map((r) => r.path)).toEqual(['C:\\VDR\\Old']);
  });
});
