/**
 * The desktop app's main process: one window on the built front end (dist/), with the real backend (composeBackend)
 * behind the bridge in src/shell/bridge.ts. The window side is src/shell/desktop.tsx.
 *
 * What the shell does for the backend, as docs/architecture.md lists it:
 * - serves `punchlist-doc://<token>` for PDF pages, asking the backend which file a token stands for (the window is
 *   given tokens, never paths);
 * - passes LibreOffice (shipped in the app, or an installed copy) as the converter, with its own settings folder;
 * - supplies the machine identity (copied-install check) and whether OneDrive is in touch;
 * - trims the model service's file store on a timer;
 * - keeps to one copy of the app per Windows user, so two copies never append to the same files;
 * - checks the control file (src/control.ts) before anything starts;
 * - signs in to Intelligence (./signin.ts): single sign-on at launch and when the token runs out, or an API key.
 * The window itself calls pickUpIndexing before store.boot(), as the browser demo does.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { composeBackend, type Backend } from '../backend/compose';
import { libreOfficeConverter } from '../backend/convert';
import { ok, fail } from '../domain/result';
import { serve, placesFor, machineIdentity, inTouchWith, findSoffice, inOneDrive, folderKeeper, teamFolders, syncedFolders, TRIM_EVERY_MS, type Places } from './host';
import { envKey, modelService } from './model';
import { aiSignIn } from './signin';
import { providerSignIn } from './providerSignIn';
import { pickedFile, writePickedFile } from './pickedFile';
import { signInBinding, assertControl, control } from '../control';
import type { WATCHED } from '../shell/bridge';

// The window's own files are served as app://punchlist/…, a secure origin of its own, rather than file://.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'punchlist-doc', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Everything the app keeps on this PC goes in LocalAppData, which never roams with a Windows profile. PUNCHLIST_HOME
// moves it (the desktop tests use a temporary folder).
const base = process.env.PUNCHLIST_HOME || (process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Punchlist') : path.join(app.getPath('appData'), 'Punchlist'));
app.setPath('userData', path.join(base, 'window'));

let win: BrowserWindow | null = null;
let backend: Backend | null = null;
// Intelligence sign-in, made once at start; the backend, started again on a new folder, keeps it
let signin: ReturnType<typeof aiSignIn> | null = null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start, (e) => stop(e));
}

function stop(e: unknown) {
  dialog.showErrorBox('Punchlist could not start', e instanceof Error ? e.message : String(e));
  app.exit(1);
}

// What the window can call right now: the shared-folder and sign-in services always, and the backend's services once a folder is connected (serveOn).
let bridge = serve({});
let trim: ReturnType<typeof setInterval> | undefined;

async function start() {
  try { assertControl(); } catch (e) { stop(e); return; }     // a value out of range in the control file stops the app, naming it
  ipcMain.on('punchlist:flush-kept-text', ({ sender }) => {
    if (sender === win?.webContents) sender.session.flushStorageData();
  });
  ipcMain.handle('punchlist:describe', () => bridge.describe());
  // while the folder is being changed the backend's services are away for a moment: the window hears "can't be reached" and
  // shows it is offline, with Retry, rather than being told the service is not there
  ipcMain.handle('punchlist:call', (_e, service: string, method: string, args: unknown) => service !== 'place' && keeper.changing()
    ? { ok: false, error: { kind: 'unreachable', message: 'The app’s backend could not be reached.' } } : bridge.call(service, method, args));
  const dist = path.join(app.getAppPath(), 'dist');
  protocol.handle('app', (req) => {
    const rel = decodeURIComponent(new URL(req.url).pathname);
    const file = path.normalize(path.join(dist, rel));
    if (!file.startsWith(dist + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  protocol.handle('punchlist-doc', async (req) => {
    const file = backend?.fileFor(new URL(req.url).hostname);
    if (!file) return new Response('Not found', { status: 404 });
    const r = await net.fetch(pathToFileURL(file).href);
    return new Response(r.body, { status: r.status, headers: { 'content-type': 'application/pdf', 'access-control-allow-origin': 'app://punchlist' } });
  });
  // quitting waits for a change of folder under way and then for the backend's writes in flight (each at most CLOSE_WAIT_MS),
  // then exits (quit is not asked again: it would wait on this once more)
  let quitting = false;
  app.on('will-quit', (e) => { signin?.close(); if (quitting) return; quitting = true; if (!backend && !keeper.changing()) return; e.preventDefault(); void keeper.close().finally(() => app.exit(0)); });
  signin = aiSignIn({
    provider: control.models.service,
    address: control.north.address,
    ssoSite: control.north.ssoSite,
    sso: control.signIn.sso,
    apiKey: control.signIn.apiKey,
    browserSignIn: providerSignIn(),
    binding: signInBinding(control),
    dir: placesFor(base).localPath, fallback: control.models.service === 'claude' ? envKey() : undefined, parent: () => win,
    probe: (token) => modelService({ token }).service,
  });
  app.on('window-all-closed', () => app.quit());
  if (!keeper.reopen()) serveOn(null);   // never stops the app: with no folder, or one that cannot be used, the window shows the connect page
  Menu.setApplicationMenu(null);
  open();
  signin?.start();
}

/**
 * This PC's Punchlist folder and the backend on it (folderKeeper in ./host.ts): started on the connected folder at launch
 * if it can be, and again when a person connects or changes one. A folder that cannot be used leaves the app as it was.
 */
const keeper = folderKeeper<Backend>({ localPath: placesFor(base).localPath, start: (folder, from) => carryOver(compose(folder, placesFor(base), from?.person()), from, folder), changed: serveOn });

/**
 * A backend started in place of another goes on serving the pages the window was given links to: the window is not started
 * again when a change goes back to the folder it had, and keeps the pages it has shown. (After a change that succeeds, the
 * window starts again and asks for its pages afresh.)
 */
function carryOver(b: Backend, from: Backend | null, folder: string): Backend {
  // only on the folder the window is on: after a change to another folder it starts again, and the last backend is let go
  if (!from || folder !== keeper.state().path) return b;
  const own = b.fileFor; const theirs = from.fileFor;
  return { ...b, fileFor: (token) => own(token) ?? theirs(token) };
}

/**
 * What the window can call follows the backend: all of its services while one runs, else only the shared-folder service
 * and the sign-in (sign-in comes first, decisions: "Intelligence sign-in"), and the window asks for a folder.
 */
function serveOn(b: Backend | null) {
  clearInterval(trim); backend = b;
  if (!b) { bridge = serve({ place, ...(signin ? { signin: signin.service } : {}) }); return; }
  bridge = serve({ repo: b.repo, ai: b.ai, docs: b.docs, sheets: b.sheets, qaLogs: b.qaLogs, session: b.session, conversations: b.conversations, fs: files(), place, ...(signin ? { signin: signin.service } : {}) });
  // changes from other PCs (and from the backend's own checks) go to the window as they arrive
  const send = (service: (typeof WATCHED)[number]) => (change?: unknown) => { if (backend === b && win && !win.isDestroyed()) win.webContents.send('punchlist:watch', service, change ?? null); };
  b.repo.watch(send('repo')); b.conversations.watch?.(send('conversations'));
  trim = setInterval(() => { void b.trim().catch(() => undefined); }, TRIM_EVERY_MS);
}

/** the window starts again, on the app or on the connect page, after the answer under way has reached it */
const restart = () => { setTimeout(() => win?.webContents.reload(), 0); };

/** The shared-folder service the window's connect screen and Settings use. */
const place = {
  async get() {
    // The connected folder was away at launch, or the backend could not start on it: it is looked at again here, as the
    // connect page asks every few seconds, and the window starts again on the app once the backend runs.
    if (keeper.reopen()) restart();
    const now = keeper.state();
    // the team's folders are looked for on each call: a shortcut a person has just added shows up when the connect page looks again
    return ok({ path: now.path, found: now.path ? [] : await teamFolders(await syncedFolders()), suggested: placesFor(base).suggested, ...(now.missing ? { missing: now.missing } : {}) });
  },
  async pick() {
    if (!win) return fail({ kind: 'failed', message: 'No window to show the folder picker in.' });
    const suggested = placesFor(base).suggested;
    const r = await dialog.showOpenDialog(win, { title: 'Choose the Punchlist folder', properties: ['openDirectory', 'createDirectory'], ...(suggested ? { defaultPath: path.dirname(suggested) } : {}) });
    return ok(r.canceled || !r.filePaths[0] ? null : { path: r.filePaths[0], inOneDrive: inOneDrive(r.filePaths[0]) });
  },
  async use(folder: string) {
    const before = keeper.backend();
    const r = await keeper.use(folder);
    // On the new folder the window starts again. A folder that was refused leaves the window as it is, on the folder it had
    // only if that one could not be gone back to is there no backend, and the window starts again on the connect page.
    // While the backend before is still closing, the window waits as for one it cannot reach (keeper.changing()).
    if (r.ok ? keeper.backend() !== before : !!before && !keeper.backend() && !keeper.changing()) restart();
    return r;
  },
};

/** The backend on this PC's folders and the chosen model service; `person` is who was signed in on the backend it replaces. */
function compose(sharedPath: string, places: Places, person?: string | null): Backend {
  for (const dir of [places.localPath, places.workPath]) fs.mkdirSync(dir, { recursive: true });
  const soffice = findSoffice(app.isPackaged ? process.resourcesPath : undefined);
  const convert = soffice ? libreOfficeConverter({ soffice, profile: places.libreOfficeProfile }) : undefined;
  const { service } = modelService({ convert, ...(signin ? { token: signin.holder } : {}) });
  const machine = machineIdentity();
  return composeBackend({
    sharedPath, localPath: places.localPath, workPath: places.workPath, person,
    label: os.hostname(), user: () => os.userInfo().username, machine: machine ? () => machine : undefined,
    service, convert, inTouch: inTouchWith(sharedPath), ...(signin ? ((si) => ({ signingIn: () => si.holder.waiting() && si.prompting(), signedOut: () => si.holder.waiting() && !si.prompting(), signedInNow: () => si.holder.signedIn(), ...(si.sso ? { signInAgain: () => void si.service.signIn() } : {}) }))(signin) : {}),
  });
}

/** The file dialogs: folders for a deal, and where to save an export. */
const picked = new Map<string, ReturnType<typeof pickedFile>>();   // places picked with pickSave, by id
const written = new Map<string, string>();  // files written there, by the same id, so the notice can open them
function files() {
  return {
    async pickFolders() {
      if (!win) return fail({ kind: 'failed', message: 'No window to show the folder picker in.' });
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] });
      return ok(r.canceled ? [] : r.filePaths);
    },
    async save(name: string, bytes: Uint8Array) {
      if (!win) return fail({ kind: 'failed', message: 'Couldn’t save the file' });
      const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), name) });
      if (r.canceled || !r.filePath) return ok('canceled' as const);
      try { fs.writeFileSync(r.filePath, bytes); return ok('saved' as const); } catch (e) { return fail({ kind: 'failed', message: `Couldn’t save the file: ${(e as Error).message}` }); }
    },
    /** one file in more than one kind (the deal memo: Word or PDF), picked before it is made: the kind is the one the chosen name ends in, else the first, whose extension is then added */
    async pickSave(name: string, kinds: { label: string; ext: string }[]) {
      if (!win || !kinds.length) return fail({ kind: 'failed', message: 'Couldn’t save the file' });
      const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), `${name}.${kinds[0].ext}`), filters: kinds.map((k) => ({ name: k.label, extensions: [k.ext] })) });
      if (r.canceled || !r.filePath) return ok(null);
      const ext = path.extname(r.filePath).slice(1).toLowerCase(); const k = kinds.find((x) => x.ext === ext);
      const id = randomUUID();
      picked.set(id, pickedFile(k ? r.filePath : `${r.filePath}.${kinds[0].ext}`));
      return ok({ id, ext: (k ?? kinds[0]).ext });
    },
    /** writes successfully only once to a place the person picked: the window can't name a path of its own */
    async writePicked(id: string, bytes: Uint8Array) {
      return writePickedFile(picked, written, id, bytes);
    },
    /** opens a file written with writePicked, in the PC's own app for its kind (Word, a PDF reader) */
    async openPicked(id: string) {
      const file = written.get(id); if (!file) return fail({ kind: 'failed', message: 'Couldn’t open the file' });
      const err = await shell.openPath(file); return err ? fail({ kind: 'failed', message: `Couldn’t open the file: ${err}` }) : ok('opened' as const);
    },
  };
}

function open() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 1024, minHeight: 640, show: false, title: 'Punchlist',
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  win.once('ready-to-show', () => win?.show());
  // The window shows the app and nothing else: a link to the web opens in the browser, and nothing navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://punchlist/')) e.preventDefault(); });
  if (!app.isPackaged) win.webContents.on('before-input-event', (_e, input) => { if (input.key === 'F12' && input.type === 'keyDown') win?.webContents.toggleDevTools(); });
  win.on('closed', () => { win = null; });
  void win.loadURL('app://punchlist/desktop.html');
}
