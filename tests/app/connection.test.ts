// The connection card and the dot on the avatar: what each row says, and when the dot shows.
import { describe, it, expect } from 'vitest';
import { connection, clockTime, DOT_WAITING_MS, DOT_ONEDRIVE_MS, DOT_QUIET_MS, NOTICE_ONEDRIVE_MS } from '../../src/app/connection';
import type { SyncState } from '../../src/ports';

const NOW = Date.parse('2026-11-15T15:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const sync = (o: Partial<SyncState> = {}): SyncState => ({ self: { id: 'pc1', label: 'PC A' }, peers: [], waiting: [], ...o });
const wait = (since: string, label: string | null = 'PC B') => ({ pc: 'pc2', label, from: ['Laptop'], changes: 2, since, deals: ['d1'] });
const at = (o: Partial<SyncState> = {}, { online = true, model = false } = {}) => connection({ sync: sync(o), net: { down: false, model } }, online, NOW);
const said = (c: ReturnType<typeof connection>) => Object.fromEntries(c.rows.map((r) => [r.name, [r.tone, ...r.lines]]));

describe('the connection card', () => {
  it('says nothing is wrong when everything is connected and nothing waits', () => {
    const c = at(); expect(c.wrong).toBe(false); expect(c.dot).toBe(false);
    expect(said(c)).toEqual({ Network: ['good', 'Connected'], OneDrive: ['good', 'In sync'], Intelligence: ['good', 'Connected'], Sync: ['good', 'Up to date'] });
  });

  it('names the PC waited for and who made the held changes; a PC with nothing arrived yet is another PC', () => {
    expect(said(at({ waiting: [wait(ago(60_000))] })).Sync).toEqual(['med', 'Waiting for PC B', '2 changes from Laptop']);
    expect(said(at({ waiting: [{ ...wait(ago(0), null), changes: 1, from: ['Laptop', 'PC B'] }] })).Sync).toEqual(['med', 'Waiting for another PC', '1 change from Laptop and PC B']);
  });

  it('OneDrive out of touch says since when; sync waits for OneDrive, and still names what waits', () => {
    const c = at({ outOfTouchSince: ago(10 * 60_000), waiting: [wait(ago(60_000))] });
    expect(said(c).OneDrive).toEqual(['high', 'Not syncing', `Since ${clockTime(ago(10 * 60_000), NOW)}`]); expect(said(c).Sync).toEqual(['med', 'Waiting for OneDrive', 'Waiting for PC B', '2 changes from Laptop']);
    expect(clockTime(ago(24 * 60 * 60_000), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/);   // another day: with its date, in this PC's time zone
  });

  it('offline and the model service out of reach are said in their rows', () => {
    expect(said(at({}, { online: false }))).toMatchObject({ Network: ['high', 'Offline'], OneDrive: ['med', 'Waiting for the network'], Sync: ['med', 'Waiting for the network'] });
    expect(said(at({}, { model: true })).Intelligence).toEqual(['high', 'Can’t be reached']);
  });
});

describe('the dot on the avatar', () => {
  it('shows once changes have waited 5 minutes, or OneDrive has been out 2 minutes', () => {
    expect(at({ waiting: [wait(ago(DOT_WAITING_MS - 1000))] }).dot).toBe(false); expect(at({ waiting: [wait(ago(DOT_WAITING_MS))] }).dot).toBe(true);
    expect(at({ outOfTouchSince: ago(DOT_ONEDRIVE_MS - 1000) }).dot).toBe(false); expect(at({ outOfTouchSince: ago(DOT_ONEDRIVE_MS) }).dot).toBe(true);
  });
  it('never shows while the network is down, nor for the model service alone', () => {
    expect(at({ waiting: [wait(ago(DOT_WAITING_MS))] }, { online: false }).dot).toBe(false);
    expect(at({}, { model: true }).dot).toBe(false);
  });
  it('goes quiet after a day, while the card still says it', () => {
    const c = at({ waiting: [wait(ago(DOT_QUIET_MS))] }); expect(c.dot).toBe(false); expect(c.wrong).toBe(true);
    expect(at({ waiting: [wait(ago(DOT_QUIET_MS)), { ...wait(ago(DOT_WAITING_MS)), pc: 'pc3' }] }).dot).toBe(true);   // a newer wait still marks it
    expect(at({ outOfTouchSince: ago(2 * DOT_QUIET_MS) }).dot).toBe(true); expect(at({ outOfTouchSince: ago(2 * DOT_QUIET_MS) }).notice).not.toBeNull();   // this PC's own OneDrive never goes quiet
  });
});

describe('the OneDrive notice', () => {
  it('is due once OneDrive has been out 15 minutes, never while offline, and names since when', () => {
    expect(at({ outOfTouchSince: ago(NOTICE_ONEDRIVE_MS - 1000) }).notice).toBeNull();
    expect(at({ outOfTouchSince: ago(NOTICE_ONEDRIVE_MS) }).notice).toBe(`OneDrive hasn’t synced since ${clockTime(ago(NOTICE_ONEDRIVE_MS), NOW)}`);
    expect(at({ outOfTouchSince: ago(NOTICE_ONEDRIVE_MS) }, { online: false }).notice).toBeNull();
  });
});

describe('the Intelligence row’s source', () => {
  it('follows the calls that go to the model service, not the read-only ones, and an older answer never overwrites a newer one', async () => {
    const { Store } = await import('../../src/app/store'); const { memRepo } = await import('../adapters/memRepo');
    const { mockAi, mockDocuments, mockSession } = await import('../../src/adapters/mocks'); const { MemoryLocal } = await import('../../src/adapters/local'); const { csvCodec } = await import('../../src/adapters/spreadsheet');
    const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo();
    let release: (v: unknown) => void = () => {}; const slow = new Promise((r) => { release = r; });
    const down = { ok: false as const, error: { kind: 'unreachable' as const, message: 'Intelligence could not be reached.' } };
    const ai = { ...mockAi(opts, repo), dealBrief: async () => down, gaps: () => slow as any, progress: async () => ({ ok: true as const, value: {} as any }) };
    const store = new Store({ repo, ai, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock: { now: () => new Date().toISOString() }, ids: { next: (p: string) => `${p}_x` } }, []);
    const gaps = store.services.ai.gaps('d1');                                                       // asked first, answered last
    await store.services.ai.dealBrief('d1'); expect(store.get().net.model).toBe(true);
    await store.services.ai.progress!('d1'); expect(store.get().net.model).toBe(true);               // read-only: says nothing
    release({ ok: true, value: [] }); await gaps; await Promise.resolve();
    expect(store.get().net.model).toBe(true);                                                         // older than the failure: not taken
    await store.services.ai.dealBrief('d1').then(() => undefined); ai.dealBrief = async () => ({ ok: true as const, value: { paragraphs: [] } }) as any;
    await store.services.ai.dealBrief('d1'); expect(store.get().net.model).toBe(false);              // a later call that reaches it clears it
  });

  it('hears an unreachable service from checklist import and the deal memo (#1067)', async () => {
    const { Store } = await import('../../src/app/store'); const { memRepo } = await import('../adapters/memRepo');
    const { mockAi, mockDocuments, mockSession } = await import('../../src/adapters/mocks');
    const { MemoryLocal } = await import('../../src/adapters/local');
    const { csvCodec } = await import('../../src/adapters/spreadsheet');
    const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo();
    const error = { kind: 'unreachable' as const, message: 'Intelligence could not be reached.' };
    const down = { ok: false as const, error };
    const reached = { ok: true as const, value: { paragraphs: [] } };
    const ai = {
      ...mockAi(opts, repo), readList: async () => down, memo: async () => down, dealBrief: async () => reached,
    };
    const fs = { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) };
    const services = {
      repo, ai, docs: mockDocuments(opts), fs, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(),
      clock: { now: () => new Date().toISOString() }, ids: { next: (p: string) => `${p}_x` },
    };
    const store = new Store(services, []);
    await store.services.ai.readList!({ lines: ['Item'] }); expect(store.get().net.model).toBe(true);
    await store.services.ai.dealBrief('d1'); expect(store.get().net.model).toBe(false);
    await store.services.ai.memo!('d1'); expect(store.get().net.model).toBe(true);
  });
});
