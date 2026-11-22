// @vitest-environment node
// This PC's Punchlist folder (folderKeeper in src/desktop/host.ts) on the real backend and stand-in folders: a folder that
// cannot be used never costs what a person saved, and never leaves the app unable to save or to start.
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { composeBackend, type Backend } from '../../src/backend/compose';
import { StandInService } from '../../src/backend/service';
import { folderKeeper, saveSharedFolder, unusable, plainReason, REOPEN_EVERY_MS } from '../../src/desktop/host';

const dirs: string[] = []; const keepers: { backend(): Backend | null }[] = [];
afterEach(async () => { for (const k of keepers.splice(0)) await k.backend()?.close(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-folder-')); dirs.push(d); return d; };

/** a PC: its local folder, and a keeper whose backend is the real one; `bad` names folders the backend throws on, as it starts */
function pc(root: string, o: { bad?: () => string[]; usable?: (f: string) => string | null; now?: () => number } = {}) {
  const local = path.join(root, 'local'); const served: (Backend | null)[] = [];
  const keeper = folderKeeper<Backend>({
    localPath: local, usable: o.usable, now: o.now, changed: (b) => served.push(b),
    start: (folder, from) => {
      if (o.bad?.().includes(folder)) throw Object.assign(new Error(`EACCES: permission denied, scandir '${folder}'`), { code: 'EACCES' });
      // signed in as someone other than the Windows user, as with single sign-on; who that is carries over to the next backend
      return composeBackend({
        sharedPath: folder,
        localPath: local,
        workPath: path.join(root, 'work'),
        label: 'PC',
        user: () => 'jdoe',
        service: new StandInService(() => '', 'jroe'),
        person: from?.person(),
      });
    },
  });
  keepers.push(keeper);
  const saved = () => { try { return JSON.parse(fs.readFileSync(path.join(local, 'settings.json'), 'utf8')).sharedFolder as string; } catch { return null; } };
  return { keeper, local, served, saved };
}
/** save a deal through the backend running now, as the window would; the result says whether it was saved */
const save = (b: Backend | null, id: string, name: string) => b!.repo.transaction({ commandId: `c-${id}`, writes: [{ kind: 'deal', id, expectedRev: null, data: { id, name } }] } as never);
const names = async (b: Backend | null) => { const r = await b!.repo.list('deal'); return r.ok ? r.value.map((d) => (d.envelope.data as { name: string }).name).sort() : r.error.message; };

describe('the Punchlist folder', () => {
  it('refuses a folder that cannot be written to before anything changes', async () => {
    const root = tmp(); const good = path.join(root, 'Punchlist'), readOnly = path.join(root, 'Read only');
    const p = pc(root, { usable: (f) => f === readOnly ? 'it is read-only' : unusable(f) });
    expect((await p.keeper.use(good)).ok).toBe(true);
    const running = p.keeper.backend();
    expect((await save(running, 'd1', 'Before')).ok).toBe(true);
    const r = await p.keeper.use(readOnly);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.message).toBe('That folder can’t be used: it is read-only');
    // the same backend still runs, on the folder it had, and still saves; the setting is as it was
    expect(p.keeper.backend()).toBe(running); expect(p.saved()).toBe(good);
    // a folder made for the change is taken away again once it is refused
    const deep = path.join(root, 'New', 'Deeper', 'Read only');
    const q = pc(root, { usable: () => 'it is read-only' });
    expect((await q.keeper.use(deep)).ok).toBe(false); expect(fs.existsSync(path.join(root, 'New'))).toBe(false);
    expect((await save(running, 'd2', 'After')).ok).toBe(true);
    expect(await names(running)).toEqual(['After', 'Before']);
  });

  // run as an ordinary user: the folder of the bug report, which exists and cannot be listed (root reads any folder, so it is skipped there)
  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('finds a folder it cannot list, and one it cannot write to, by trying', () => {
    const root = tmp(); const noList = path.join(root, 'no list'), noWrite = path.join(root, 'no write');
    fs.mkdirSync(noList, { mode: 0o300 }); fs.mkdirSync(noWrite, { mode: 0o500 });
    try { expect(unusable(noList)).toBe('you don’t have permission to it'); expect(unusable(noWrite)).toBe('you don’t have permission to it'); }
    finally { fs.chmodSync(noList, 0o700); fs.chmodSync(noWrite, 0o700); }
  });

  it('tries a folder by writing to it, and leaves nothing behind', () => {
    const root = tmp(); const folder = path.join(root, 'Punchlist'); fs.mkdirSync(folder);
    expect(unusable(folder)).toBeNull(); expect(fs.readdirSync(folder)).toEqual([]);
    expect(unusable(path.join(root, 'not there'))).toBe('it isn’t there');
    fs.writeFileSync(path.join(root, 'a file'), ''); expect(unusable(path.join(root, 'a file'))).toBe('a file has that name');
  });

  it('says why in plain words, never with a system code', () => {
    expect(plainReason(Object.assign(new Error("EROFS: read-only file system, open 'x'"), { code: 'EROFS' }))).toBe('it is read-only');
    expect(plainReason(new Error("Cannot read properties of null (reading 'recordId')"))).toBe('the records in it can’t be read');
    expect(plainReason(Object.assign(new Error('odd'), { code: 'EWHATEVER' }))).toBe('the records in it can’t be read');
    expect(plainReason(null)).toBe('the records in it can’t be read');
  });

  it('goes back to the folder it had when the backend cannot start on the new one, and keeps saving', async () => {
    const root = tmp(); const good = path.join(root, 'Punchlist'), bad = path.join(root, 'Team library', 'Punchlist');
    const p = pc(root, { bad: () => [bad] });
    expect((await p.keeper.use(good)).ok).toBe(true);
    expect((await save(p.keeper.backend(), 'd1', 'Before')).ok).toBe(true);
    const first = p.keeper.backend();
    const r = await p.keeper.use(bad);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.message).toBe('That folder can’t be used: you don’t have permission to it');
    // a backend runs again on the folder it had (the one before was closed for the change), and the setting never moved
    const now = p.keeper.backend();
    expect(now).not.toBeNull(); expect(now).not.toBe(first); expect(p.served.at(-1)).toBe(now);
    expect(p.saved()).toBe(good); expect(p.keeper.state()).toEqual({ path: good });
    expect(await names(now)).toEqual(['Before']);
    expect((await save(now, 'd2', 'After')).ok).toBe(true);
    // the next start of the app is on the folder it had, with everything saved before and after
    await now!.close();
    const again = pc(root); expect(again.keeper.reopen()).toBe(true);
    expect(await names(again.keeper.backend())).toEqual(['After', 'Before']);
  });

  it('keeps this PC\'s Undo and its id in the folder it had when the real backend throws on the new folder', async () => {
    const root = tmp(); const good = path.join(root, 'Punchlist'), broken = path.join(root, 'Broken');
    // a change line this build cannot apply (#199) makes the backend throw as it starts on that folder
    fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, 'changes-other-_-0001.jsonl'), `${JSON.stringify({ v: 1, pc: 'other', seq: 1, at: '2026-11-17T00:00:00.000Z', by: 'x', from: 'Other PC', recs: [], audit: [null] })}\n`);
    const p = pc(root);
    expect((await p.keeper.use(good)).ok).toBe(true);
    const id = p.keeper.backend()!.installId;
    const op = await p.keeper.backend()!.repo.transaction({ commandId: 'c-op', writes: [{ kind: 'deal', id: 'd1', expectedRev: null, data: { id: 'd1', name: 'Before' } }, { kind: 'op', id: 'op1', expectedRev: null, data: { id: 'op1', undo: 'kept' } }] } as never);
    expect(op.ok).toBe(true);
    const r = await p.keeper.use(broken);
    expect(r.ok).toBe(false); expect(p.saved()).toBe(good);
    const now = p.keeper.backend()!;
    expect(now.installId).toBe(id);
    const kept = await now.repo.get('op', 'op1');
    expect(kept.ok && (kept.value?.envelope.data as { undo?: string } | undefined)?.undo).toBe('kept');
    expect(await names(now)).toEqual(['Before']);
  });

  it('keeps a conversation under the person signed in when it goes back, with no window reload to load the session again', async () => {
    const root = tmp(); const good = path.join(root, 'Punchlist'), bad = path.join(root, 'Bad');
    const p = pc(root, { bad: () => [bad] });
    expect((await p.keeper.use(good)).ok).toBe(true);
    await p.keeper.backend()!.session.load();                                          // as the window does at its start
    const msg = (id: string) => ({ id, role: 'me', text: id, state: 'done', at: '2026-11-17T00:00:00.000Z' });
    expect((await p.keeper.backend()!.conversations.save('deal:d1', [msg('m1')] as never)).ok).toBe(true);
    expect((await p.keeper.use(bad)).ok).toBe(false);
    const back = p.keeper.backend()!;
    expect(back.person()).toBe('jroe');
    expect(Object.keys((await back.conversations.load() as { ok: true; value: object }).value)).toEqual(['deal:d1']);
    expect((await back.conversations.save('deal:d1', [msg('m1'), msg('m2')] as never)).ok).toBe(true);
    await back.close();
    // the next start, signed in as the same person, has both messages
    const again = pc(root); expect(again.keeper.reopen()).toBe(true); await again.keeper.backend()!.session.load();
    const kept = await again.keeper.backend()!.conversations.load() as { ok: true; value: Record<string, { id: string }[]> };
    expect(kept.value['deal:d1'].map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('waits for a change under way when the app quits, and starts nothing after', async () => {
    const root = tmp(); const a = path.join(root, 'A'), b = path.join(root, 'B');
    const p = pc(root);
    expect((await p.keeper.use(a)).ok).toBe(true);
    const changing = p.keeper.use(b); expect(p.keeper.changing()).toBe(true);
    await p.keeper.close();
    expect(p.keeper.changing()).toBe(false); expect(p.keeper.backend()).toBeNull();
    // the quit came while the backend before was closing: the new folder is not started on, and the setting stays
    expect((await changing).ok).toBe(false); expect(p.saved()).toBe(a);
    expect((await p.keeper.use(a)).ok).toBe(false); expect(p.keeper.reopen()).toBe(false); expect(p.keeper.backend()).toBeNull();
  });

  it('ends a change whose backend before never finishes closing, starts nothing on its files meanwhile, and connects again once it has', async () => {
    const root = tmp(); const a = path.join(root, 'A'), b = path.join(root, 'B');
    let t = 0; let release: () => void = () => {}; let stuck = true; const local = path.join(root, 'local'); let started = 0;
    const keeper = folderKeeper<{ close(): Promise<void> }>({
      localPath: local, now: () => t, changeWait: 50, changed: () => {},
      start: () => { started++; return { close: () => stuck ? new Promise<void>((r) => { release = r; }) : Promise.resolve() }; },
    });
    expect((await keeper.use(a)).ok).toBe(true); expect(started).toBe(1);
    const r = await keeper.use(b);                                                       // answered, not left waiting
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.message).toBe('The Punchlist folder wasn’t changed: the app is still saving to the folder it had');
    // the window waits as for a backend it cannot reach; nothing is started beside the one still writing, by any way in
    expect(keeper.changing()).toBe(true); expect(keeper.backend()).toBeNull(); expect(started).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(local, 'settings.json'), 'utf8')).sharedFolder).toBe(a);
    expect(keeper.state()).toEqual({ path: a, missing: `${a} is still being saved to.` });
    t = REOPEN_EVERY_MS; expect(keeper.reopen()).toBe(false);
    expect((await keeper.use(a)).ok).toBe(false); expect((await keeper.use(path.join(root, 'C'))).ok).toBe(false);
    expect(started).toBe(1);
    // once it has closed, the folder it had is connected again by itself, and the change is over
    stuck = false; release(); await new Promise((r2) => setTimeout(r2, 0));
    expect(started).toBe(2); expect(keeper.backend()).not.toBeNull(); expect(keeper.changing()).toBe(false); expect(keeper.state()).toEqual({ path: a });
  });

  it('keeps trying the folder it had after a slow close, without giving up on the window, until it starts', async () => {
    const root = tmp(); const local = path.join(root, 'local'); let release: () => void = () => {}; let starts = 0; let fails = true;
    const keeper = folderKeeper<{ close(): Promise<void> }>({
      // its clock runs fast, so the connect page's 30-second wait after a failed start has always passed when it looks
      localPath: local, changeWait: 20, retryEvery: 20, changed: () => {}, now: () => Date.now() * 10_000,
      start: () => { starts++; if (starts > 1 && fails) throw new Error('busy'); return { close: () => starts === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve() }; },
    });
    expect((await keeper.use(path.join(root, 'A'))).ok).toBe(true); expect((await keeper.use(path.join(root, 'B'))).ok).toBe(false);
    release(); await new Promise((r) => setTimeout(r, 10));
    expect(keeper.backend()).toBeNull(); expect(keeper.changing()).toBe(true);           // the window still waits, as offline
    const tried = starts; await new Promise((r) => setTimeout(r, 50)); expect(starts).toBeGreaterThan(tried);
    // a look meanwhile (Settings asks for the folder) starts nothing: the retry does, and the window is not started again
    const looked = starts; expect(keeper.reopen()).toBe(false); expect(starts).toBe(looked);
    fails = false; await new Promise((r) => setTimeout(r, 50));
    expect(keeper.backend()).not.toBeNull(); expect(keeper.changing()).toBe(false);
    const done = starts; await new Promise((r) => setTimeout(r, 50)); expect(starts).toBe(done);   // and stops trying
  });

  it('says the window can reach the backend again the moment one runs, when a folder the person chose ends a recovery', async () => {
    const root = tmp(); const local = path.join(root, 'local'); let release: () => void = () => {}; let starts = 0;
    const keeper = folderKeeper<{ close(): Promise<void> }>({
      localPath: local, changeWait: 20, retryEvery: 60_000, changed: () => {},
      start: (f) => { starts++; if (starts > 1 && f.endsWith('A')) throw new Error('busy'); return { close: () => starts === 1 ? new Promise<void>((r) => { release = r; }) : Promise.resolve() }; },
    });
    expect((await keeper.use(path.join(root, 'A'))).ok).toBe(true); expect((await keeper.use(path.join(root, 'B'))).ok).toBe(false);
    release(); await new Promise((r) => setTimeout(r, 10));
    expect(keeper.changing()).toBe(true);                                                   // recovering: the next try is a minute away
    expect((await keeper.use(path.join(root, 'C'))).ok).toBe(true);
    expect(keeper.backend()).not.toBeNull(); expect(keeper.changing()).toBe(false);
  });

  it('quits while a backend before is still closing without waiting longer than it may', async () => {
    const root = tmp(); const local = path.join(root, 'local');
    const keeper = folderKeeper<{ close(): Promise<void> }>({ localPath: local, changeWait: 20, changed: () => {}, start: () => ({ close: () => new Promise<void>(() => {}) }) });
    expect((await keeper.use(path.join(root, 'A'))).ok).toBe(true); expect((await keeper.use(path.join(root, 'B'))).ok).toBe(false);
    const at = Date.now(); await keeper.close(100); const took = Date.now() - at;
    expect(took).toBeGreaterThanOrEqual(90); expect(took).toBeLessThan(1000);
  });

  it('takes away a folder made for a change whose start then fails', async () => {
    const root = tmp(); const good = path.join(root, 'Punchlist'), bad = path.join(root, 'New', 'Punchlist');
    const p = pc(root, { bad: () => [bad] });
    expect((await p.keeper.use(good)).ok).toBe(true);
    expect((await p.keeper.use(bad)).ok).toBe(false); expect(fs.existsSync(path.join(root, 'New'))).toBe(false);
  });

  it('goes back when the setting cannot be saved, and leaves no backend running on the new folder', async () => {
    const root = tmp(); const good = path.join(root, 'Punchlist'), next = path.join(root, 'Elsewhere');
    const p = pc(root);
    expect((await p.keeper.use(good)).ok).toBe(true);
    expect((await save(p.keeper.backend(), 'd1', 'Before')).ok).toBe(true);
    fs.mkdirSync(path.join(p.local, 'settings.json.tmp'));                           // the setting's file cannot be written
    const r = await p.keeper.use(next);
    expect(r.ok).toBe(false); expect(p.saved()).toBe(good);
    expect(await names(p.keeper.backend())).toEqual(['Before']);
    expect((await save(p.keeper.backend(), 'd2', 'After')).ok).toBe(true);
  });

  it('flushes the new settings before replacing them and keeps the other settings (#217)', () => {
    const local = tmp();
    const file = path.join(local, 'settings.json');
    const sharedFolder = path.join(local, 'Next folder');
    fs.writeFileSync(file, JSON.stringify({ sharedFolder: 'Before', indexAtOnce: true }));
    const steps: string[] = [];
    const sync = fs.fsyncSync.bind(fs);
    const rename = fs.renameSync.bind(fs);
    const flush = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      steps.push('flush');
      sync(fd);
    });
    const replace = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      steps.push('rename');
      rename(from, to);
    });
    try {
      saveSharedFolder(local, sharedFolder);
    } finally {
      flush.mockRestore();
      replace.mockRestore();
    }
    expect(steps).toEqual(['flush', 'rename']);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ sharedFolder, indexAtOnce: true });
  });

  it('starts on the connect page, not with an error, when the backend cannot start on the connected folder, and tries again', async () => {
    const root = tmp(); const folder = path.join(root, 'Punchlist'); fs.mkdirSync(folder);
    saveSharedFolder(path.join(root, 'local'), folder);
    let t = 0; let bad = [folder];
    const p = pc(root, { bad: () => bad, now: () => t });
    expect(p.keeper.reopen()).toBe(false); expect(p.keeper.backend()).toBeNull();
    expect(p.keeper.state()).toEqual({ path: folder, missing: `${folder} can’t be used: you don’t have permission to it` });
    // the folder can be read again: it is tried again 30 seconds after the last try, not at every look
    bad = [];
    t = REOPEN_EVERY_MS - 1; expect(p.keeper.reopen()).toBe(false);
    t = REOPEN_EVERY_MS; expect(p.keeper.reopen()).toBe(true);
    expect(p.keeper.backend()).not.toBeNull(); expect(p.keeper.state()).toEqual({ path: folder }); expect(p.saved()).toBe(folder);
  });

  it('connects a folder that was away at the start as soon as it is back, without making it', async () => {
    const root = tmp(); const folder = path.join(root, 'OneDrive', 'Punchlist');
    const first = pc(root); expect((await first.keeper.use(folder)).ok).toBe(true);
    expect((await save(first.keeper.backend(), 'd1', 'Kept')).ok).toBe(true); await first.keeper.backend()!.close();
    fs.renameSync(folder, folder + '-away');
    const p = pc(root);
    expect(p.keeper.reopen()).toBe(false);
    expect(p.keeper.state()).toEqual({ path: folder, missing: `${folder} can’t be found. Is OneDrive running and signed in?` });
    expect(p.keeper.reopen()).toBe(false); expect(fs.existsSync(folder)).toBe(false);     // looking again never makes the folder
    fs.renameSync(folder + '-away', folder);
    expect(p.keeper.reopen()).toBe(true); expect(p.keeper.state()).toEqual({ path: folder });
    expect(await names(p.keeper.backend())).toEqual(['Kept']);
    expect(p.keeper.reopen()).toBe(false);                                                  // running: nothing to start again
  });

  it('lets a person pick another folder from the connect page when the connected one cannot be used', async () => {
    const root = tmp(); const bad = path.join(root, 'Punchlist'), other = path.join(root, 'Other'); fs.mkdirSync(bad);
    saveSharedFolder(path.join(root, 'local'), bad);
    const p = pc(root, { bad: () => [bad] });
    expect(p.keeper.reopen()).toBe(false);
    expect((await p.keeper.use(bad)).ok).toBe(false); expect(p.keeper.backend()).toBeNull(); expect(p.saved()).toBe(bad);
    expect((await p.keeper.use(other)).ok).toBe(true); expect(p.saved()).toBe(other); expect(p.keeper.state()).toEqual({ path: other });
  });

  it('takes one change of folder at a time, and does nothing for the folder already in use', async () => {
    const root = tmp(); const a = path.join(root, 'A'), b = path.join(root, 'B'), c = path.join(root, 'C');
    const p = pc(root);
    expect((await p.keeper.use(a)).ok).toBe(true); const running = p.keeper.backend();
    expect((await p.keeper.use(a)).ok).toBe(true); expect(p.keeper.backend()).toBe(running);
    const [one, two] = await Promise.all([p.keeper.use(b), p.keeper.use(c)]);
    expect(one.ok).toBe(true); expect(two.ok).toBe(false); expect(p.saved()).toBe(b);
    expect((await p.keeper.use('relative')).ok).toBe(false);
  });
});
