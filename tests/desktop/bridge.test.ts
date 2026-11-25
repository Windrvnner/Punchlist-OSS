// @vitest-environment node
// The desktop bridge: the window's services (src/shell/bridge.ts) over the main process's end (src/desktop/host.ts),
// on the real backend. The channel copies every value with structuredClone, as Electron's IPC does.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { composeBackend, type Backend } from '../../src/backend/compose';
import { StandInService } from '../../src/backend/service';
import { Store } from '../../src/app/store';
import { MemoryLocal } from '../../src/adapters/local';
import { ulidIds, mockAi } from '../../src/adapters/mocks';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { COMMANDS } from '../e2e/kit';
import { CreateDeal, DeleteDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { bridged, type BridgeApi, type Watched } from '../../src/shell/bridge';
import { envKey, modelService } from '../../src/desktop/model';
import { ok } from '../../src/domain/result';
import { serve, placesFor, machineIdentity, inTouchWith, findSoffice, inOneDrive, saveSharedFolder, closeWithin, syncedFolders, teamFolders } from '../../src/desktop/host';

const made: Backend[] = []; const dirs: string[] = [];
afterEach(() => { for (const b of made.splice(0)) b.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-bridge-')); dirs.push(d); return d; };

function backendAt(root: string) {
  const b = composeBackend({ sharedPath: path.join(root, 'shared'), localPath: path.join(root, 'local'), workPath: path.join(root, 'work'), label: 'PC', user: () => 'jdoe', service: new StandInService(() => '', '') });
  made.push(b); return b;
}
/** both ends joined by a channel that copies, as IPC does; `down` makes every call reject, as when the main process is gone */
function channel(services: Parameters<typeof serve>[0], o: { down?: () => boolean } = {}) {
  const end = serve(services); const listeners: Record<string, Set<(c: unknown) => void>> = { repo: new Set(), conversations: new Set() };
  const api: BridgeApi = {
    describe: async () => structuredClone(end.describe()),
    call: async (s, m, args) => { if (o.down?.()) throw new Error('gone'); return structuredClone(await end.call(s, m, structuredClone(args))); },
    on: (s: Watched, l) => { listeners[s].add(l); return () => listeners[s].delete(l); },
    pathFor: () => '',
    flushKeptText: () => undefined,
  };
  return { api, emit: (s: Watched, c: unknown) => { for (const l of listeners[s]) l(structuredClone(c)); } };
}
const val = <T,>(r: { ok: boolean; value?: T }) => { expect(r.ok).toBe(true); return r.value as T; };
const storeOn = (services: ReturnType<typeof bridged>) => new Store({ ...services, sheets: services.sheets ?? csvCodec, local: new MemoryLocal(), clock: { now: () => new Date().toISOString() }, ids: ulidIds }, COMMANDS);

describe('desktop bridge', () => {
  it('runs the Store on the real backend: what is saved through the bridge is on disk for the next start', async () => {
    const root = tmp(); const b = backendAt(root);
    const { api } = channel({ repo: b.repo, ai: b.ai, docs: b.docs, sheets: b.sheets, session: b.session, conversations: b.conversations });
    const store = storeOn(bridged(api, await api.describe())); await store.boot();
    expect(store.get().user?.name).toBe('jdoe');
    expect((await store.dispatch(CreateDeal, { name: 'Bridge', folders: [] })).ok).toBe(true);
    const dealId = Object.values(store.get().deals)[0].id;
    expect((await store.dispatch(CreateQuestion, { dealId, text: 'Line one\nLine two' })).ok).toBe(true);
    b.close(); made.length = 0;
    const again = backendAt(root); const listed = await again.repo.list('question', dealId);
    expect(listed.ok && listed.value.map((l) => (l.envelope.data as { text: string }).text)).toEqual(['Line one\nLine two']);
  });

  it('Settings > Change to another shared folder puts nothing from the last one in it: no records, no conversations', async () => {
    const root = tmp(); const at = (shared: string) => { const b = composeBackend({ sharedPath: path.join(root, shared), localPath: path.join(root, 'local'), workPath: path.join(root, 'work'), label: 'PC', user: () => 'jdoe', service: new StandInService(() => '', '') }); made.push(b); return b; };
    const a = at('team');
    val(await a.repo.transaction({ writes: [{ kind: 'question', id: 'q_secret', data: { dealId: 'd_1', text: 'Project Lucerne' }, expectedRev: null }] }));
    val(await a.conversations.save('d_1', [{ id: 'm1', role: 'me', text: 'Project Lucerne terms?', state: 'done', at: '2026-11-14T00:00:00Z' }]));
    await a.close(); made.length = 0;
    const b = at('elsewhere');
    expect(val(await b.repo.get('question', 'q_secret'))).toBe(null); expect(val(await b.conversations.load())).toEqual({});
    const leaked = fs.readdirSync(path.join(root, 'elsewhere')).filter((f) => fs.readFileSync(path.join(root, 'elsewhere', f), 'utf8').includes('Lucerne'));
    expect(leaked).toEqual([]);
    await b.close(); made.length = 0;
    const back = at('team');                                                                           // changed back: all there, conversation included
    expect(val(await back.repo.get('question', 'q_secret'))).not.toBe(null); expect(Object.keys(val(await back.conversations.load()))).toEqual(['d_1']);
  });

  it('passes every model call the backend has to the window: one left off the list hides its feature in the desktop app', async () => {
    const b = backendAt(tmp()); const { api } = channel({ repo: b.repo, ai: b.ai, docs: b.docs, session: b.session });
    const window = bridged(api, await api.describe()).ai as unknown as Record<string, unknown>; const backend = b.ai as unknown as Record<string, unknown>;
    // the port's methods are the stand-in's: each one the backend has must reach the window
    const port = Object.keys(mockAi()).filter((m) => typeof backend[m] === 'function');
    expect(port).toEqual(expect.arrayContaining(['sameMeaning', 'reword', 'issuesList']));
    expect(port.filter((m) => typeof window[m] !== 'function')).toEqual([]);
  });

  it('passes changes from the backend to the window', async () => {
    const b = backendAt(tmp()); const { api, emit } = channel({ repo: b.repo });
    const s = bridged(api, await api.describe()); const seen: unknown[] = [];
    const stop = s.repo.watch((c) => seen.push(c)); emit('repo', { kind: 'question', id: 'q_1' }); stop(); emit('repo', { kind: 'question', id: 'q_2' });
    expect(seen).toEqual([{ kind: 'question', id: 'q_1' }]);
  });

  it('answers "unreachable" when the main process cannot be reached, never a rejection', async () => {
    const b = backendAt(tmp()); let down = true; const { api } = channel({ repo: b.repo, session: b.session }, { down: () => down });
    const s = bridged(api, await api.describe());
    expect(await s.repo.list('deal')).toMatchObject({ ok: false, error: { kind: 'unreachable' } });
    expect(await s.session.load()).toMatchObject({ ok: false, error: { kind: 'unreachable' } });
    down = false; expect((await s.repo.list('deal')).ok).toBe(true);
  });

  it('turns a method that throws, and an answer that is not a Result, into failures', async () => {
    const { api } = channel({ docs: { cached: () => { throw new Error('disk gone'); }, poll: async () => 'nonsense' } as never });
    const s = bridged(api, await api.describe());
    expect(await s.docs.cached()).toEqual({ ok: false, error: { kind: 'failed', message: 'disk gone' } });
    expect(await s.docs.poll('d_1')).toMatchObject({ ok: false, error: { kind: 'failed' } });
  });

  it('offers Intelligence sign-in only where the backend has it', async () => {
    const b = backendAt(tmp()); const pasted: string[] = [];
    const north = { status: async () => ok({ signedIn: pasted.length > 0, sso: false, apiKey: true }), signIn: async () => ok(undefined), paste: async (t: string) => { pasted.push(t); return ok(undefined); } };
    expect(bridged(channel({ repo: b.repo }).api, serve({ repo: b.repo }).describe()).signin).toBeUndefined();
    const { api } = channel({ repo: b.repo, signin: north }); const s = bridged(api, await api.describe());
    expect(await s.signin!.status()).toEqual(ok({ signedIn: false, sso: false, apiKey: true }));
    await s.signin!.paste('a-token'); expect(await s.signin!.status()).toEqual(ok({ signedIn: true, sso: false, apiKey: true }));
  });

  it('keeps a deal deleted on another PC as a recovered copy, every step through the bridge, at deal scale', async () => {
    const root = tmp();
    const pcAt = (name: string) => { const b = composeBackend({ sharedPath: path.join(root, 'shared'), localPath: path.join(root, name, 'local'), workPath: path.join(root, name, 'work'), label: name, user: () => name, service: new StandInService(() => '', '') }); made.push(b); return b; };
    const windowOn = async (b: Backend) => {
      const { api } = channel({ repo: b.repo, ai: b.ai, docs: b.docs, sheets: b.sheets, session: b.session, conversations: b.conversations });
      const store = storeOn(bridged(api, await api.describe())); await store.boot(); return store;
    };
    const a = pcAt('office'), b = pcAt('laptop'); const A = await windowOn(a), B = await windowOn(b);
    expect(typeof B.services.repo.recover).toBe('function'); expect(typeof A.services.repo.seen).toBe('function');
    expect((await A.dispatch(CreateDeal, { name: 'Proseware', folders: [] })).ok).toBe(true);
    const dealId = Object.values(A.get().deals)[0].id; await A.loadDeal(dealId, { gaps: false });
    const rows = Array.from({ length: 2000 }, (_, i) => ({ n: i + 1, text: `Please provide the revenue by customer for entity ${i + 1}.`, askedBy: 'Lender A', received: '2026-11-02', workstream: 'Financial', priority: '' as const, response: '', respondedBy: '', responded: '', status: '' as const }));
    expect((await A.dispatch(ImportQuestions, { dealId, mode: 'append', rows }, { quiet: true })).ok).toBe(true);
    await B.refreshSync(); await B.loadDeal(dealId, { gaps: false });
    const q = Object.values(B.get().questions).find((x) => x.dealId === dealId && x.n === 1234)!;
    // the person on the first PC opens the first delete pop-up; what that PC has taken in comes back over the bridge
    const seen = val(await A.services.repo.seen!());
    expect((await B.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Typed on the laptop' })).ok).toBe(true);
    await A.refreshSync();                                                          // the first PC takes it in while its person confirms
    expect((await A.dispatch(DeleteDeal, { dealId, typedName: 'Project Proseware', seen })).ok).toBe(true);
    await B.refreshSync();
    for (let i = 0; i < 400 && !Object.values(B.get().deals).some((d) => d.name === 'Project Proseware (recovered)'); i++) await new Promise((r) => setTimeout(r, 10));
    const copy = Object.values(B.get().deals).find((d) => d.name === 'Project Proseware (recovered)')!; expect(copy).toBeDefined();
    expect(B.get().ui.toasts.map((t) => t.text)).toContain('office deleted Project Proseware · a copy is kept here');
    await B.loadDeal(copy.id, { gaps: false });
    const kept = Object.values(B.get().questions).filter((x) => x.dealId === copy.id);
    expect(kept).toHaveLength(2000); expect(kept.find((x) => x.n === 1234)!.response).toBe('Typed on the laptop');
    await A.refreshSync(); expect(A.get().deals[dealId]).toBeUndefined(); expect(Object.values(A.get().deals).some((d) => d.id === copy.id)).toBe(false);
  }, 120000);

  it('offers only listed methods the backend has: an optional one left out stays hidden', async () => {
    const b = backendAt(tmp()); const { addresses: _, ...ai } = b.ai as unknown as Record<string, unknown>;
    const end = serve({ repo: b.repo, ai: ai as never });
    const d = end.describe();
    expect(d.ai).not.toContain('addresses'); expect(d.ai).toContain('answer'); expect(d.sheets).toBeUndefined();
    expect(Object.keys(bridged(channel({ repo: b.repo, ai: ai as never }).api, d).ai)).not.toContain('addresses');
    expect(await end.call('repo', 'close', [])).toMatchObject({ ok: false, error: { kind: 'failed' } });
    expect(await end.call('constructor', 'name', [])).toMatchObject({ ok: false });
    expect(await end.call('repo', 'list', 'deal')).toMatchObject({ ok: false });
  });
});

describe('desktop host', () => {
  it('closing waits for the backend, but at most its limit: a close that never ends does not keep the app open', async () => {
    expect(await closeWithin({ close: async () => undefined }, 1000)).toBe(true);
    expect(await closeWithin({ close: () => Promise.reject(new Error('x')) }, 1000)).toBe(true);
    const t0 = Date.now(); expect(await closeWithin({ close: () => new Promise<void>(() => undefined) }, 30)).toBe(false); expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('has no shared folder until one is connected, and suggests the one in OneDrive', () => {
    const base = tmp();
    const first = placesFor(base, { OneDriveCommercial: '/od-work', OneDrive: '/od' }, (p) => p === '/od');
    expect(first.sharedPath).toBeNull(); expect(first.suggested).toBe(path.join('/od', 'Punchlist'));   // the work account's first, if it is there
    expect(placesFor(base, {}, () => true).suggested).toBeNull();
    saveSharedFolder(path.join(base, 'local'), '/team/Punchlist');
    const p = placesFor(base, { OneDrive: '/od' }, () => false);
    expect(p).toEqual({ localPath: path.join(base, 'local'), workPath: path.join(base, 'work'), libreOfficeProfile: path.join(base, 'libreoffice'), sharedPath: '/team/Punchlist', suggested: null });
  });

  it('keeps the other settings when the shared folder is saved', () => {
    const local = path.join(tmp(), 'local'); fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'settings.json'), JSON.stringify({ indexAtOnce: 5 }));
    saveSharedFolder(local, '/a'); saveSharedFolder(local, '/b');
    expect(JSON.parse(fs.readFileSync(path.join(local, 'settings.json'), 'utf8'))).toEqual({ indexAtOnce: 5, sharedFolder: '/b' });
  });

  it('tells a folder OneDrive syncs from one it does not', () => {
    const env = { OneDriveCommercial: '/home/x/OneDrive - Firm', OneDrive: '/home/x/OneDrive' };
    expect(inOneDrive('/home/x/OneDrive - Firm/Punchlist', env)).toBe(true);
    expect(inOneDrive('/home/x/onedrive/Team/Punchlist', env)).toBe(true);           // Windows paths ignore case
    expect(inOneDrive('/home/x/OneDrive2/Punchlist', env)).toBe(false);
    expect(inOneDrive('/data/Punchlist', env)).toBe(false);
  });

  it('reads the folders OneDrive syncs from team sites, and gives none rather than fail', async () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\SyncEngines\\Providers\\OneDrive\\a1\r\n    MountPoint    REG_SZ    C:\\Users\\x\\Team\\Deals - Documents\r\n\r\n'
      + 'HKEY_CURRENT_USER\\Software\\SyncEngines\\Providers\\OneDrive\\b2\r\n    MountPoint    REG_SZ    C:\\Users\\x\\Team\\Punchlist\r\n';
    expect(await syncedFolders('win32', async () => out)).toEqual(['C:\\Users\\x\\Team\\Deals - Documents', 'C:\\Users\\x\\Team\\Punchlist']);
    expect(await syncedFolders('win32', () => Promise.reject(new Error('none found')))).toEqual([]);
    expect(await syncedFolders('linux', async () => out)).toEqual([]);
  });

  it('finds the Punchlist folders that already hold the team\'s records, in OneDrive and in synced libraries', async () => {
    const root = tmp(); const at = (...p: string[]) => path.join(root, ...p);
    const records = (dir: string, name = 'changes-a1-_-0001.jsonl') => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), ''); };
    records(at('OneDrive - Firm', 'Punchlist'));                                       // a shortcut added to My files
    fs.mkdirSync(at('OneDrive', 'Punchlist'), { recursive: true });                    // a Punchlist folder with nothing of the app's in it
    records(at('Team', 'Punchlist'));                                                  // a synced folder that is the Punchlist folder itself
    records(at('Team', 'Library', 'Punchlist'), 'notes.txt');                          // something else called Punchlist
    const env = { OneDriveCommercial: at('OneDrive - Firm'), OneDrive: at('OneDrive') };
    expect(await teamFolders([at('Team', 'Punchlist'), at('Team', 'Library'), at('Gone')], env)).toEqual([at('OneDrive - Firm', 'Punchlist'), at('Team', 'Punchlist')]);
    expect(await teamFolders([], {})).toEqual([]);
  });

  it('reads the Windows machine id and user SID, and gives nothing rather than fail', () => {
    const run = (file: string) => file === 'reg' ? '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    1b2c-33\r\n' : '"pc\\jdoe","S-1-5-21-1-2-3-1001"\r\n';
    expect(machineIdentity('win32', run)).toBe('1b2c-33:S-1-5-21-1-2-3-1001');
    expect(machineIdentity('win32', () => { throw new Error('no reg'); })).toBe('');
  });

  it('is in touch only while the shared folder is there and OneDrive runs, and asks again after 30 seconds', () => {
    const shared = tmp(); let t = 0; let running = true; let asked = 0;
    const run = () => { asked++; return running ? '"OneDrive.exe","1234","Console","1","90,000 K"' : 'INFO: No tasks are running which match the specified criteria.'; };
    const touch = inTouchWith(shared, 'win32', run, () => t);
    expect(touch()).toBe(true); running = false; expect(touch()).toBe(true); expect(asked).toBe(1);
    t = 30_000; expect(touch()).toBe(false);
    expect(inTouchWith(path.join(shared, 'gone'), 'linux')()).toBe(false);
  });

  it('prefers the LibreOffice shipped in the app to an installed one', () => {
    const shipped = path.join('/res', 'libreoffice', 'program', 'soffice.exe');
    expect(findSoffice('/res', 'win32', (p) => p === shipped || String(p).startsWith('C:'))).toBe(shipped);
    expect(findSoffice('/res', 'win32', (p) => String(p).startsWith('C:'))).toBe('C:\\Program Files\\LibreOffice\\program\\soffice.exe');
    expect(findSoffice(undefined, 'win32', () => false)).toBeNull();
  });

  it('runs on Claude when a key is in the environment of a live run, every tier on the fast model unless routing is asked for', async () => {
    expect(modelService({ env: {} }).service).toBeInstanceOf(StandInService);
    const blankKey = { PUNCHLIST_LIVE: '1', PUNCHLIST_AI_KEY: '  ' };
    expect(modelService({ env: blankKey }).service).toBeInstanceOf(StandInService);
    const claude = modelService({ env: { PUNCHLIST_LIVE: '1', PUNCHLIST_AI_KEY: 'test-key-not-real' } });
    // only the Claude connector counts its use
    expect(claude.service).toHaveProperty('use');
    expect((await claude.service.models()).fast).toBeTruthy();
  });

  // a key merely set in the shell made every check run paid calls; only a run that asks with PUNCHLIST_LIVE=1 uses it
  it('never uses a key from the environment unless the run asks for live calls', () => {
    for (const live of [undefined, '', '0', 'true', ' 1']) {
      const env = { PUNCHLIST_AI_KEY: 'test-key-not-real', ...(live === undefined ? {} : { PUNCHLIST_LIVE: live }) };
      expect(envKey(env)).toBeUndefined();
      expect(modelService({ env }).service).toBeInstanceOf(StandInService);
    }
    expect(envKey({ PUNCHLIST_LIVE: '1', PUNCHLIST_AI_KEY: ' test-key-not-real ' })).toBe('test-key-not-real');
  });

  it('runs on North when the control file says so, whatever key is in the environment', () => {
    const token = { get: async () => 't', refused: () => {} };
    // only the North connector lists its own hosted tools
    expect(modelService({ env: { PUNCHLIST_AI_KEY: 'test-key-not-real' }, service: 'north', token }).service)
      .toHaveProperty('agentTools');
    expect(() => modelService({ service: 'north' })).toThrow(/token/);
  });

  it('runs on the OpenAI-compatible server when the control file says so, signed in with its key', () => {
    const token = { get: async () => 't', refused: () => {} };
    const { service } = modelService({ env: { PUNCHLIST_AI_KEY: 'test-key-not-real' }, service: 'openai', token });
    expect(service).not.toBeInstanceOf(StandInService);
    expect(service).not.toHaveProperty('use');
    expect(service).not.toHaveProperty('agentTools');
    expect(() => modelService({ service: 'openai' })).toThrow(/token/);
  });
  // an update files the edits it brought into the Q&A log through `settle`, so the window must reach it
  it('carries every Q&A log method the backend has, the filing of kept edits too', async () => {
    const b = backendAt(tmp()); const { api } = channel({ repo: b.repo, qaLogs: b.qaLogs }); const s = bridged(api, await api.describe());
    expect(Object.keys(s.qaLogs!).sort()).toEqual(Object.keys(b.qaLogs!).sort());
    expect(await s.qaLogs!.settle!({ folder: tmp(), file: 'Log.csv', kept: [] })).toEqual(ok({ gone: [] }));
  });
});
