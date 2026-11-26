/**
 * The desktop app's main-process helpers that need no Electron: serving the bridge, and what the shell supplies to the
 * backend about this PC (where its folders are, who it is, whether OneDrive is in touch, where LibreOffice is).
 * Kept apart from main.ts so that the tests can run them on Node.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIDGED, type Available, type ServiceName } from '../shell/bridge';
import { control } from '../control';
import { ok, fail, type Result } from '../domain/result';

/** the folder inside the person's OneDrive that holds the team's shared records (the control file's desktop.sharedFolder) */
export const SHARED_FOLDER = control.desktop.sharedFolder;
/** how often the model service's file store is checked and trimmed to its limit (desktop.trimEvery) */
export const TRIM_EVERY_MS = control.desktop.trimEvery;
/**
 * How long quitting or changing the shared folder waits for the backend's writes in flight before it goes on anyway. A write
 * cut off then is not lost silently: a line in this PC's own copy but not the shared folder is put back at the next start
 * (logRepository's restore), and an action whose journal entry was never settled shows as interrupted, with Retry, unless
 * its line is found in this PC's own file at the next start, when it is known to be done.
 */
export const CLOSE_WAIT_MS = 10_000;
/** Close a backend, waiting at most `ms`; resolves true when it closed in time, false when the wait ran out. */
export function closeWithin(backend: { close(): Promise<void> }, ms = CLOSE_WAIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((done) => { timer = setTimeout(() => done(false), ms); });
  return Promise.race([backend.close().then(() => true, () => true), late]).finally(() => clearTimeout(timer));
}
/** how long a look at whether OneDrive is running is trusted: the checks ask often */
const IN_TOUCH_MS = 30_000;

type Services = Partial<Record<ServiceName, object | undefined>>;
type Method = (...args: unknown[]) => unknown;

/**
 * The main process's end of the bridge. `describe` lists what the backend has, out of what the bridge allows; `call`
 * runs one allowed method. A method that throws (the ports say none should) is answered as a failure, never a rejection,
 * so the window can tell "the backend failed" from "the backend could not be reached".
 */
export function serve(services: Services) {
  const method = (service: string, name: string): Method | null => {
    if (!Object.hasOwn(BRIDGED, service) || !(BRIDGED[service as ServiceName] as readonly string[]).includes(name)) return null;
    const s = services[service as ServiceName] as Record<string, unknown> | undefined;
    return s && typeof s[name] === 'function' ? (s[name] as Method).bind(s) : null;
  };
  return {
    describe(): Available {
      const out: Available = {};
      for (const s of Object.keys(BRIDGED) as ServiceName[]) if (services[s]) out[s] = (BRIDGED[s] as readonly string[]).filter((m) => method(s, m));
      return out;
    },
    async call(service: string, name: string, args: unknown): Promise<unknown> {
      const run = method(service, name);
      if (!run || !Array.isArray(args)) return { ok: false, error: { kind: 'failed', message: `The window asked for ${service}.${name}, which the app does not offer.` } };
      try { return await run(...args); } catch (e) { return { ok: false, error: { kind: 'failed', message: e instanceof Error ? e.message : String(e) } }; }
    },
  };
}

/**
 * Where this PC keeps the app's files. `base` is this PC's own app folder (LocalAppData\Punchlist on Windows).
 * `sharedPath` is the shared folder a person connected on this PC (`sharedFolder` in its settings.json, the file that
 * also holds `indexAtOnce`), or null until they have. `suggested` is the Punchlist folder in the person's OneDrive (the
 * work account's first), offered when OneDrive is on this PC.
 */
export interface Places { localPath: string; workPath: string; libreOfficeProfile: string; sharedPath: string | null; suggested: string | null }

export function placesFor(base: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): Places {
  const localPath = path.join(base, 'local');
  const oneDrive = oneDrives(env).find((d) => exists(d));
  return {
    localPath, workPath: path.join(base, 'work'), libreOfficeProfile: path.join(base, 'libreoffice'),
    sharedPath: savedFolder(localPath),
    suggested: oneDrive ? path.join(oneDrive, SHARED_FOLDER) : null,
  };
}

/** the person's OneDrive folders as Windows names them, the work account's first */
const oneDrives = (env: NodeJS.ProcessEnv) => [env.OneDriveCommercial, env.OneDrive, env.OneDriveConsumer].filter((d): d is string => !!d);
/** whether a folder is inside one of the person's OneDrive folders, which is what keeps it in sync with the other PCs */
export function inOneDrive(folder: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const norm = (p: string) => path.resolve(p).toLowerCase() + path.sep;
  return oneDrives(env).some((d) => norm(folder).startsWith(norm(d)));
}
/**
 * The folders OneDrive syncs on this PC besides the person's own OneDrive: each team site library or folder they chose
 * to sync, as Windows keeps them under HKCU\Software\SyncEngines\Providers\OneDrive (a MountPoint for each). Empty
 * when there are none or they cannot be read.
 */
export async function syncedFolders(platform = process.platform, run: (file: string, args: string[]) => Promise<string> = quietly): Promise<string[]> {
  if (platform !== 'win32') return [];
  try { return [...(await run('reg', ['query', 'HKCU\\Software\\SyncEngines\\Providers\\OneDrive', '/s', '/v', 'MountPoint'])).matchAll(/MountPoint\s+REG_SZ\s+(.+?)\s*$/gim)].map((m) => m[1]); }
  catch { return []; }
}

/** a file of the app's records, as logRepository names them */
const RECORDS = /^changes-.+\.jsonl$/;
/**
 * The Punchlist folders on this PC that already hold the team's records: the one in each OneDrive folder (where a
 * shortcut added with "Add shortcut to My files" shows up) and in each synced library, or a synced folder that is itself
 * the Punchlist folder. Each is listed once, in that order.
 */
export async function teamFolders(synced: string[], env: NodeJS.ProcessEnv = process.env, list = (dir: string): Promise<string[]> => fs.promises.readdir(dir)): Promise<string[]> {
  const out: string[] = []; const seen = new Set<string>();
  for (const root of [...oneDrives(env), ...synced]) {
    for (const dir of [...(path.basename(root).toLowerCase() === SHARED_FOLDER.toLowerCase() ? [root] : []), path.join(root, SHARED_FOLDER)]) {
      const key = path.resolve(dir).toLowerCase(); if (seen.has(key)) continue; seen.add(key);
      try { if ((await list(dir)).some((n) => RECORDS.test(n))) out.push(dir); } catch { /* not there */ }
    }
  }
  return out;
}

/**
 * The settings in a file, or none when the file is missing (#1118). A file that is there but cannot be read as an
 * object of settings throws, so saving never replaces settings it could not read.
 */
function readSettings(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error('The settings file can’t be read right now, so it was left as it is');
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // left null: refused below like any other content that is not settings
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The settings file isn’t valid settings, so it was left as it is');
  }
  return parsed as Record<string, unknown>;
}

/** Keep the shared folder a person connected in this PC's settings.json, leaving its other settings as they are. */
export function saveSharedFolder(localPath: string, folder: string) {
  const file = path.join(localPath, 'settings.json');
  const temporary = file + '.tmp';
  const now = readSettings(file);
  fs.mkdirSync(localPath, { recursive: true });
  // Force the working file to disk before it replaces the settings (#217).
  fs.writeFileSync(temporary, JSON.stringify({ ...now, sharedFolder: folder }, null, 2), { flush: true });
  fs.renameSync(temporary, file);
}

/**
 * Why the app cannot keep its records in a folder, or null when it can: the folder must be listed and written to. A file is
 * written there and taken away again to find out, so a folder a person may only read is found before it is taken.
 */
export function unusable(folder: string): string | null {
  const probe = path.join(folder, `.punchlist-${randomUUID()}.tmp`);
  try { fs.readdirSync(folder); fs.writeFileSync(probe, ''); return null; }
  catch (e) { return plainReason(e); }
  finally { try { fs.rmSync(probe, { force: true }); } catch { /* left behind: an empty file the app never reads */ } }
}

/** why a change of folder ended without one: the backend before it had not finished writing */
const STILL_SAVING = 'The Punchlist folder wasn’t changed: the app is still saving to the folder it had';
/** what the system's codes mean, in the words the screen uses: no error codes or system calls on screen (design.md) */
const REASONS: Record<string, string> = {
  EACCES: 'you don’t have permission to it', EPERM: 'you don’t have permission to it', EROFS: 'it is read-only',
  EEXIST: 'a file has that name', ENOTDIR: 'a file has that name', ENOENT: 'it isn’t there', EBUSY: 'it is in use',
  ENOSPC: 'the disk is full', ENAMETOOLONG: 'its path is too long', EIO: 'the drive can’t be read', ETIMEDOUT: 'it took too long to answer',
};
/**
 * Why a folder cannot be used, for the screen: a known system code in plain words; anything else (the backend failing on
 * what the folder holds) says the records there could not be read.
 */
export function plainReason(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && REASONS[code] ? REASONS[code] : 'the records in it can’t be read';
}

/**
 * How long a change of folder waits for the backend before it to close. Past this, its writes are taken to be stuck (a file
 * on a drive that stopped answering): no backend is started on the same files while they may still be written, and the
 * change ends, so the person is never left waiting on it.
 */
export const CHANGE_WAIT_MS = 60_000;
/** how long after the backend failed to start on the connected folder it is tried again, while the connect page is open */
export const REOPEN_EVERY_MS = 30_000;

/**
 * This PC's Punchlist folder and the backend running on it. Three rules, so that a folder that cannot be used never costs a
 * person their work or locks them out of the app:
 * - `use` refuses a folder that cannot be listed or written to before anything changes. If the backend still cannot start on
 *   the new folder, it is started again on the folder it had; the setting is saved only once the backend runs on the new one.
 * - `reopen` never throws: a connected folder that is away, or that the backend cannot start on, leaves no backend and a
 *   reason (`state().missing`), which the connect page shows.
 * - `reopen` is asked again at every look of the connect page: a folder that has come back is connected at once, and one
 *   the backend failed on is tried again every 30 seconds.
 * `start` makes a backend on a folder and throws if it cannot; `changed` is told the backend now running (null for none).
 */
export function folderKeeper<B extends { close(): Promise<void> }>(o: {
  /** start a backend on `folder`; `from` is the backend it replaces (closed by then), for what carries over to the next */
  localPath: string; start: (folder: string, from: B | null) => B; changed: (backend: B | null) => void;
  exists?: (folder: string) => boolean; usable?: (folder: string) => string | null; now?: () => number; changeWait?: number; retryEvery?: number;
}) {
  const exists = o.exists ?? fs.existsSync, usable = o.usable ?? unusable, now = o.now ?? (() => Date.now());
  let folder = savedFolder(o.localPath);
  let backend: B | null = null;
  let failed: { message: string; at: number } | null = null;   // the last start on `folder` that threw
  let busy = false;                                             // a change of folder is under way
  let change: Promise<unknown> = Promise.resolve();             // the change under way, which quitting waits for
  let closed = false;                                           // the app is quitting: nothing more is started
  let lingering: Promise<unknown> | null = null;                // the close of a backend before that took too long, which may still be writing
  let recovering = false;                                       // the folder it had is being started again after that close, until it starts
  // a backend running ends a recovery: the window is told it is reachable again at once, not at the next try (recover)
  const set = (b: B | null) => { backend = b; if (b) recovering = false; o.changed(b); };
  const why = plainReason;
  /** start on the connected folder; false, with the reason kept, when it cannot */
  const open = (from: B | null = null): boolean => {
    if (!folder || closed) return false;
    try { set(o.start(folder, from)); failed = null; return true; }
    catch (e) { failed = { message: why(e), at: now() }; return false; }
  };
  // Windows paths ignore case: the folder in use, typed another way, is the same folder
  const norm = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const same = (a: string, b: string) => norm(a) === norm(b);
  /**
   * Start the folder it had again after a backend before it took too long to close, trying every REOPEN_EVERY_MS until it
   * starts. The window is never started again meanwhile, so what it has not saved yet stays in it until there is a backend.
   */
  function recover(from: B | null) {
    if (closed || backend) { recovering = false; return; }                // quitting, or a folder the person chose meanwhile is running
    recovering = true;
    if (!busy && open(from)) { recovering = false; return; }            // a change the person started is left to finish first
    setTimeout(() => recover(from), o.retryEvery ?? REOPEN_EVERY_MS);
  }
  /** the steps of `use`, one change at a time */
  async function changeTo(next: string): Promise<Result<void>> {
    const refused = (reason: string) => fail<void>({ kind: 'failed', message: `That folder can’t be used: ${reason}` });
    // refused before anything changes: the backend in use is not touched. A folder made here for the change (the OneDrive
    // suggestion, say) is taken away again if it is refused.
    let made: string | undefined;
    try { made = fs.mkdirSync(next, { recursive: true }); } catch (e) { return refused(why(e)); }
    const reason = usable(next); if (reason) { if (made) unmake(next, made); return refused(reason); }
    // The backend before is closed first, and waited on to the end (not for CLOSE_WAIT_MS, as quitting does): the next one
    // may open the same files under the same install id (going back), and its start moves this PC's Undo journal, so
    // nothing of the last one may still be writing.
    const before = backend; const wasFailed = failed;
    if (before) {
      set(null);
      const closing = before.close().catch(() => undefined);
      const done = await Promise.race([closing.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), o.changeWait ?? CHANGE_WAIT_MS))]);
      if (!done) {
        // still writing: nothing is started on its files until it has closed. The connect page says so, and the folder it had
        // is connected again at a look of the page once it has (reopen).
        // The window is not started again: it waits as for a backend it cannot reach, keeping what is not yet saved, and
        // the folder it had is connected again here as soon as that close is done.
        lingering = closing; failed = { message: STILL_SAVING, at: now() };
        void closing.then(() => { lingering = null; failed = null; recover(before); });
        if (made) unmake(next, made);
        return fail({ kind: 'failed', message: STILL_SAVING });
      }
    }
    if (closed) return refused('the app is closing');
    let started: B | null = null;
    try { started = o.start(next, before); saveSharedFolder(o.localPath, next); }
    catch (e) {
      // the new folder could not be started on, or the setting not saved: back to the folder it had
      if (started) await started.close().catch(() => undefined);
      if (made) unmake(next, made);
      failed = wasFailed; if (before) open(before);
      return refused(why(e));
    }
    folder = next; failed = null; set(started);
    return ok(undefined);
  }
  return {
    backend: () => backend,
    /** whether a change of folder is under way: the backend's services are then away for a moment, not missing */
    changing: () => busy || !!lingering || recovering,
    /** Quitting: wait for a change under way (at most `ms`), start nothing more, and close the backend, waiting at most `ms`. */
    async close(ms = CLOSE_WAIT_MS): Promise<void> {
      closed = true;
      await Promise.race([Promise.all([change, lingering]), new Promise((r) => setTimeout(r, ms))]);
      const b = backend; if (b) { set(null); await closeWithin(b, ms); }
    },
    state(): { path: string | null; missing?: string } {
      if (!folder || backend) return { path: folder };
      if (lingering) return { path: folder, missing: `${folder} is still being saved to.` };
      if (!exists(folder)) return { path: folder, missing: `${folder} can’t be found. Is OneDrive running and signed in?` };
      return { path: folder, ...(failed ? { missing: `${folder} can’t be used: ${failed.message}` } : {}) };
    },
    /** Start the backend on the connected folder if it is not running and can be. True when this call started it. */
    reopen(): boolean {
      // during a recovery the window is waiting as if offline, not on the connect page: recover() starts it, and the window is not started again
      if (backend || busy || lingering || recovering || !folder || !exists(folder)) return false;
      if (failed && now() - failed.at < REOPEN_EVERY_MS) return false;
      return open();
    },
    /** Use this folder from now on. On a failure the app is left as it was: on the folder it had, with the setting unchanged. */
    async use(next: string): Promise<Result<void>> {
      if (typeof next !== 'string' || !path.isAbsolute(next)) return fail({ kind: 'invalid', message: 'Choose a folder on this PC.' });
      // the folder already in use: nothing to start again, and a write still in flight on it is never raced by a second backend
      if (backend && folder && same(next, folder)) return ok(undefined);
      if (busy || closed) return fail({ kind: 'failed', message: 'The Punchlist folder is already being changed.' });
      // nothing starts beside a backend that may still be writing: this PC's own folder (install id, Undo journal) is shared by all of them
      if (lingering) return fail({ kind: 'failed', message: STILL_SAVING });
      busy = true;
      const run = changeTo(next); change = run;
      try { return await run; } finally { busy = false; }
    },
  };
}

/** take away the empty folders from `folder` up to `top`, which were made a moment ago: one that is not empty is left, with those above it */
function unmake(folder: string, top: string) {
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    try { fs.rmdirSync(dir); } catch { return; }
    if (dir === path.resolve(top) || path.dirname(dir) === dir) return;
  }
}

/** the shared folder a person connected on this PC, from its settings.json; null until they have */
function savedFolder(localPath: string): string | null {
  let chosen: unknown;
  try { chosen = JSON.parse(fs.readFileSync(path.join(localPath, 'settings.json'), 'utf8')).sharedFolder; } catch { /* not set */ }
  return typeof chosen === 'string' && chosen.trim() ? chosen.trim() : null;
}

/** as `quiet`, without holding up the main process (and so the window) while it runs: for what the connect page asks every few seconds */
const quietly = (file: string, args: string[]) => new Promise<string>((done, failed) => { execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 }, (e, out) => e ? failed(e) : done(out)); });
const quiet = (file: string, args: string[]) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * Who this install belongs to: on Windows the machine's MachineGuid and the Windows user's SID, so a folder copied to
 * another PC or user is a new install (logRepository's `machine`). Elsewhere, the machine id and the user id. Empty if
 * neither can be read, which turns the copied-install check off rather than stopping the app.
 */
export function machineIdentity(platform = process.platform, run = quiet): string {
  try {
    if (platform === 'win32') {
      const guid = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid']))?.[1];
      const sid = /(S-1-[\d-]+)/.exec(run('whoami', ['/user', '/fo', 'csv', '/nh']))?.[1];
      return guid && sid ? `${guid}:${sid}` : '';
    }
    const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    return id ? `${id}:${os.userInfo().uid}` : '';
  } catch { return ''; }
}

/**
 * Whether this PC's files are in touch with the shared folder: the folder can be reached and, on Windows, OneDrive is
 * running. A paused OneDrive cannot be told from a running one from outside it, so that case reads as in touch.
 * The answer is kept for 30 seconds.
 */
export function inTouchWith(sharedPath: string, platform = process.platform, run = quiet, now = () => Date.now()) {
  let last = { at: -Infinity, value: true };
  return (): boolean => {
    if (now() - last.at < IN_TOUCH_MS) return last.value;
    let value = fs.existsSync(sharedPath);
    if (value && platform === 'win32') { try { value = /OneDrive\.exe/i.test(run('tasklist', ['/fi', 'IMAGENAME eq OneDrive.exe', '/fo', 'csv', '/nh'])); } catch { value = true; } }
    last = { at: now(), value }; return value;
  };
}

/** LibreOffice: the copy shipped inside the app first, then an installed one; null when there is none. */
export function findSoffice(resources: string | undefined, platform = process.platform, exists = fs.existsSync): string | null {
  const exe = platform === 'win32' ? 'soffice.exe' : 'soffice';
  const candidates = [
    ...(resources ? [path.join(resources, 'libreoffice', 'program', exe)] : []),
    ...(platform === 'win32' ? ['C:\\Program Files\\LibreOffice\\program\\soffice.exe'] : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']),
  ];
  return candidates.find((c) => exists(c)) ?? null;
}
