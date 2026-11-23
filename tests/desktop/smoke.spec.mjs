// The desktop app end to end: the built Electron app (npm run desktop:build) on the real backend, on temporary folders,
// signed in on a test key, with no model service reachable. Run: node tests/desktop/smoke.spec.mjs (on Linux it needs a display: xvfb-run -a).
import { _electron as electron } from 'playwright';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createHash } from 'node:crypto';

const results = [];
const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-desktop-'));
const home = path.join(root, 'home'), shared = path.join(root, 'OneDrive', 'Punchlist'), room = path.join(root, 'data room');
fs.mkdirSync(path.join(home, 'local'), { recursive: true }); fs.mkdirSync(room, { recursive: true }); fs.mkdirSync(path.dirname(shared), { recursive: true });
fs.writeFileSync(path.join(room, 'Term sheet.pdf'), pdf('The lock-up ratio is 1.30x.', 2));
const shots = path.resolve('out/desktop'); fs.mkdirSync(shots, { recursive: true });

// running as root, or on a CI runner whose Linux blocks Chromium's sandbox, needs the sandbox off; on a PC it stays on
// the PC's OneDrive is a temporary folder; the shared folder is the Punchlist folder in it, connected on the first start.
// Sign-in comes first, so the PC is signed in with a test key (the fallback a key in the environment gives, which the app
// takes only with PUNCHLIST_LIVE=1) whatever this shell holds, and the model service is a closed port on this PC: no call
// ever reaches a real service.
const launch = (at = home) => electron.launch({ args: [...(process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : []), '.'], env: { ...process.env, PUNCHLIST_HOME: at, PUNCHLIST_LIVE: '1', PUNCHLIST_AI_KEY: 'test-key', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', OneDrive: path.dirname(shared), OneDriveCommercial: '' } });
// the window is shown once it has painted (ready-to-show): a screenshot before then has nothing to capture
async function shown(app) {
  const deadline = Date.now() + 30_000;
  let windows;
  do {
    windows = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => window.isVisible()));
    if (windows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`The first window was never shown within 30 seconds (window visibility: ${JSON.stringify(windows)})`);
}
async function started(at) {
  const app = await launch(at); const page = await app.firstWindow(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.waitForFunction(() => window.store?.get().boot.stage === 'ready', null, { timeout: 20000 });
  return { app, page };
}

// 0 the first start asks for the shared folder and saves nothing before; the OneDrive one is offered
let app = await launch(); let page = await app.firstWindow();
{
  await page.waitForSelector('#connect #cf-use'); await shown(app);
  const offered = await page.textContent('#cf-path');
  for (const [w, h] of [[1280, 736], [1024, 640]]) for (const theme of ['dark', 'light']) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme); await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(shots, `desktop-connect-${theme}-${w}x${h}.png`) });
  }
  say('first-start-asks-for-folder', offered === shared && !fs.existsSync(shared), String(offered));
  await page.click('#cf-use');
  await page.waitForFunction(() => window.store?.get().boot.stage === 'ready', null, { timeout: 20000 });
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'local', 'settings.json'), 'utf8')).sharedFolder;
  say('folder-connected', saved === shared && fs.existsSync(shared), saved);
  await app.close();
}

// 1 the window opens on the real backend, with the PC's user and nothing of Node in reach
({ app, page } = await started());
{
  const s = await page.evaluate(() => ({ user: store.get().user?.name, node: typeof require + typeof process, keys: Object.keys(window.punchlist).sort().join() }));
  say('opens-on-backend', s.user === os.userInfo().username, JSON.stringify(s));
  say('window-has-no-node', s.node === 'undefinedundefined' && s.keys === 'call,describe,on,pathFor', JSON.stringify(s));
  const min = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize());
  say('min-size-1024x640', min[0] === 1024 && min[1] === 640, JSON.stringify(min));
  const refused = await page.evaluate(() => window.punchlist.call('repo', 'close', []));
  say('bridge-refuses-unlisted', refused?.ok === false, JSON.stringify(refused));
  const optional = await page.evaluate(() => window.punchlist.describe());
  say('describe-lists-backend', optional.repo?.includes('sync') && optional.ai?.includes('checkAll') && optional.conversations?.includes('save'), JSON.stringify(optional));
}

// 2 a deal made in the window is written to the shared folder, and its folder is indexed
let dealId;
{
  // as a person does it: New deal, paste the folder's path, Create and start indexing
  await page.click('#fr-new, #new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new');   // the sidebar's + opens Add deal, which offers New deal
  await page.fill('#nd-name', 'Desktop');
  await page.click('#nd-paste'); await page.fill('#nd-path', room); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow');
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  dealId = await page.evaluate(() => Object.values(store.get().deals)[0]?.id);
  const files = fs.readdirSync(shared, { recursive: true }).map(String).filter((f) => /changes-.*\.jsonl$/.test(f));
  say('deal-written-to-shared-folder', dealId?.startsWith('d_') && files.length > 0, `${dealId} ${files.join(' ')}`);
  const indexed = await page.waitForFunction((id) => store.get().deals[id] && store.get().deals[id].stage !== 'indexing', dealId, { timeout: 20000 }).then(() => true, () => false);
  say('folder-indexed', indexed, await page.evaluate((id) => store.get().deals[id]?.stage, dealId));
}

// 3 a PDF page is served through punchlist-doc:// by token: the window never sees a path
{
  // a document's id is its content's hash, as the backend's docIdFor makes it
  const docId = `doc_${createHash('sha256').update(fs.readFileSync(path.join(room, 'Term sheet.pdf'))).digest('hex').slice(0, 24)}`;
  const got = await page.evaluate(async ([id, docId]) => {
    const r = await store.services.docs.page(id, { doc: 'Term sheet.pdf', docId }, 'p. 2'); if (!r.ok) return { r };
    const res = await fetch(r.value.url); const head = new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5));
    const bad = await fetch('punchlist-doc://00000000-0000-0000-0000-000000000000/').then((x) => x.status, (e) => String(e));
    return { url: r.value.url, page: r.value.page, status: res.status, head, bad };
  }, [dealId, docId]);
  say('pdf-page-by-token', got.status === 200 && got.head === '%PDF-' && got.page === 2 && /^punchlist-doc:\/\/[0-9a-f-]+$/.test(got.url) && !got.url.includes('Term'), JSON.stringify(got));
  say('unknown-token-404', got.bad === 404, String(got.bad));
}

// 4 what was typed survives closing and opening the app (the records are on disk, not in the window)
{
  const asked = await page.evaluate((id) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: id, text: 'Please confirm the lock-up ratio.\nAnd the test date.' }), dealId);
  say('question-saved', asked.ok, JSON.stringify(asked));
  // screenshots to look at by eye: both themes at both sizes screens are checked at
  await shown(app);
  for (const [w, h] of [[1280, 736], [1024, 640]]) for (const theme of ['dark', 'light']) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate((t) => store.setPrefs({ theme: t }), theme); await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(shots, `desktop-overview-${theme}-${w}x${h}.png`) });
  }
  say('no-window-errors', page.errors.length === 0, page.errors.join(' | '));
  await app.close();
  ({ app, page } = await started());
  await page.evaluate((id) => { location.hash = '#qa-' + id; }, dealId);
  await page.waitForFunction((id) => store.get().dealLoad[id] === 'loaded', dealId, { timeout: 15000 }).catch(() => undefined);
  const q = await page.evaluate(() => Object.values(store.get().questions).map((x) => x.text));
  const deal = await page.evaluate((id) => store.get().deals[id]?.name, dealId);
  say('kept-after-restart', deal === 'Project Desktop' && q.includes('Please confirm the lock-up ratio.\nAnd the test date.'), JSON.stringify({ deal, q }));
}

// Settings shows the shared folder with Change
{
  await page.evaluate(() => store.ui({ settings: true })); await page.waitForSelector('#s-shared .cf-now');
  const shown = await page.textContent('#s-shared .cf-now');
  say('settings-shows-folder', shown === shared && !!(await page.$('#s-shared-change')), shown);
  await page.evaluate(() => store.ui({ settings: false }));
}

// Change to another folder: the app starts again there with none of this PC's records from the last one, and changing back finds them
{
  const other = path.join(root, 'Elsewhere');
  // the answer comes once the backend has started on the folder; the window then reloads on it
  // the reload can start before the answer is carried back to this script, which then sees the page's context go: the
  // folder was taken all the same, and the checks below read what the backend and the folder hold after the reload
  const use = async (folder) => {
    const reloaded = page.waitForEvent('load', { timeout: 15000 });
    const r = await page.evaluate((f) => window.punchlist.call('place', 'use', [f]), folder).catch((e) => { if (/context was destroyed/i.test(String(e?.message))) return { ok: true }; throw e; });
    await reloaded; return r;
  };
  const moved = await use(other);
  const leaked = fs.readdirSync(other, { recursive: true }).map(String).filter((f) => fs.statSync(path.join(other, f)).isFile() && fs.readFileSync(path.join(other, f), 'utf8').includes('Project Desktop'));
  const deals = await page.evaluate(() => window.punchlist.call('repo', 'list', ['deal']));
  say('change-folder-starts-clean', moved.ok && leaked.length === 0 && deals.ok && deals.value.length === 0, JSON.stringify({ moved, leaked, deals: deals.ok && deals.value.length }));
  const back = await use(shared);
  const again = await page.evaluate(() => window.punchlist.call('repo', 'list', ['deal']));
  say('change-back-finds-records', back.ok && again.ok && again.value.some((d) => d.envelope.data.name === 'Project Desktop'), JSON.stringify({ back, n: again.ok && again.value.length }));
}

// A folder the app cannot start on is refused, and nothing changes: the window stays on the deal, on the folder it had,
// still saving, and the setting is not moved
{
  const before = JSON.parse(fs.readFileSync(path.join(home, 'local', 'settings.json'), 'utf8')).sharedFolder;
  const use = (folder) => page.evaluate((f) => window.punchlist.call('place', 'use', [f]), folder);
  const state = async () => ({ saved: JSON.parse(fs.readFileSync(path.join(home, 'local', 'settings.json'), 'utf8')).sharedFolder, has: Object.keys(await page.evaluate(() => window.punchlist.describe())).sort().join() });
  // 1. a folder that cannot be listed (the report's case). Root reads any folder, so there a file stands where the folder would be.
  const locked = path.join(root, 'Team library', 'Punchlist'); fs.mkdirSync(path.dirname(locked), { recursive: true });
  const fileFixture = process.getuid?.() === 0 || process.platform === 'win32';
  if (fileFixture) fs.writeFileSync(locked, '');
  else fs.mkdirSync(locked, { mode: 0o300 });
  const has = (await state()).has;
  const r1 = await use(locked); const s1 = await state();
  const reason = fileFixture ? 'a file has that name' : 'you don’t have permission to it';
  say('bad-folder-refused',
    r1.ok === false && r1.error.message === `That folder can’t be used: ${reason}` &&
    s1.saved === before && s1.has === has && has.includes('repo'),
    JSON.stringify({ r1, s1 }));
  // 2. a folder that passes the look but that the backend throws on as it starts: a change line it cannot apply (#199)
  //    stands in for whatever makes it throw. The backend in use was closed for the change, and runs again on its folder.
  // a page of a document the window was given before the change, to open again after it
  const docId = `doc_${createHash('sha256').update(fs.readFileSync(path.join(room, 'Term sheet.pdf'))).digest('hex').slice(0, 24)}`;
  const pageUrl = await page.evaluate(async ([id, docId]) => { const r = await store.services.docs.page(id, { doc: 'Term sheet.pdf', docId }, 'p. 1'); return r.ok ? r.value.url : null; }, [dealId, docId]);
  const broken = path.join(root, 'Broken'); fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'changes-other-_-0001.jsonl'), JSON.stringify({ v: 1, pc: 'other', seq: 1, at: '2026-11-17T00:00:00.000Z', by: 'jdoe', from: 'Other PC', recs: [], audit: [null] }) + '\n');
  const r2 = await use(broken); const s2 = await state();
  if (r2.ok) await page.waitForEvent('load', { timeout: 15000 }).catch(() => undefined);
  const pageAfter = pageUrl ? await page.evaluate((u) => fetch(u).then((x) => x.status, (e) => String(e)), pageUrl) : 'no page';
  say('page-still-opens-after-going-back', pageAfter === 200, String(pageAfter));
  say('folder-backend-cannot-start-on-goes-back', r2.ok === false && r2.error.message === 'That folder can’t be used: the records in it can’t be read' && s2.saved === before && s2.has === has, JSON.stringify({ r2, s2 }));
  // the window was not started again, and what a person types next is saved to the folder it had
  const asked = await page.evaluate((id) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: id, text: 'Saved after a folder was refused.' }), dealId);
  const onDisk = fs.readdirSync(shared, { recursive: true }).map(String).filter((f) => /changes-.*\.jsonl$/.test(f)).some((f) => fs.readFileSync(path.join(shared, f), 'utf8').includes('Saved after a folder was refused.'));
  say('still-saves-after-refused-folder', asked.ok && onDisk, JSON.stringify({ asked, onDisk }));
  if (!fileFixture) fs.chmodSync(locked, 0o700);
}

// 5 one copy of the app per user: a second start hands over to the first and exits
{
  // The second copy can exit while Playwright is still attaching to it; Playwright then rejects a call of its own that no
  // one awaits ("session closed"), which would end this script. That is the hand-over working, so it is let pass here only.
  const closedEarly = (e) => { if (!/session closed|Target page, context or browser has been closed/i.test(String(e?.message ?? e))) throw e; };
  process.on('unhandledRejection', closedEarly);
  const second = await launch().then(async (a) => { const closed = new Promise((r) => a.process().once('exit', () => r(true))); return Promise.race([closed, new Promise((r) => setTimeout(() => r(false), 8000))]); }, () => true);
  await new Promise((r) => setTimeout(r, 500)); process.off('unhandledRejection', closedEarly);
  const stillOne = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  say('single-instance', second === true && stillOne === 1, JSON.stringify({ second, stillOne }));
}
await app.close();

// 6 a connected folder that has gone (OneDrive unlinked) brings back the connect page, saying which folder, and nothing is written
{
  fs.renameSync(shared, shared + '-away');
  ({ app, page } = await (async () => { const a = await launch(); return { app: a, page: await a.firstWindow() }; })());
  await page.waitForSelector('#connect #cf-choose');
  const line = await page.textContent('#connect .fr-line');
  say('missing-folder-asks-again', line.includes(shared) && !fs.existsSync(shared), line);
  await app.close(); fs.renameSync(shared + '-away', shared);
}
// a folder that was away at the start is connected as soon as it is back, with no click
{
  fs.renameSync(shared, shared + '-away');
  app = await launch(); page = await app.firstWindow();
  await page.waitForSelector('#connect #cf-choose');
  fs.renameSync(shared + '-away', shared);
  // the page looks again every 5 seconds; the window then starts again on the app
  const back = await page.waitForFunction(() => window.store?.get().boot.stage === 'ready', null, { timeout: 20000 }).then(() => true, () => false);
  const deals = back ? await page.evaluate(() => Object.values(store.get().deals).map((d) => d.name).join()) : '';
  say('returned-folder-connects-on-its-own', back && deals === 'Project Desktop', deals);
  await app.close();
}
// a connected folder the backend cannot start on shows the connect page, saying why, rather than a box and no app;
// once it can be started on, the app carries on by itself
{
  fs.renameSync(shared, shared + '-kept'); fs.writeFileSync(shared, '');           // a file where the folder was: the backend throws on it
  app = await launch();
  const opened = await Promise.race([app.firstWindow().then((w) => w, () => null), new Promise((r) => setTimeout(() => r(null), 15000))]);
  const line = opened ? await opened.waitForSelector('#connect .fr-line', { timeout: 10000 }).then((el) => el.textContent(), () => '') : '';
  say('unusable-folder-shows-connect-page', !!opened && line === `${shared} can’t be used: a file has that name` && !!(await opened.$('#cf-choose')), line);
  if (opened) {
    await shown(app);
    for (const [w, h] of [[1280, 736], [1024, 640]]) for (const theme of ['dark', 'light']) {
      await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
      await opened.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme); await opened.waitForTimeout(600);
      await opened.screenshot({ path: path.join(shots, `desktop-connect-unusable-${theme}-${w}x${h}.png`) });
    }
  }
  fs.rmSync(shared); fs.renameSync(shared + '-kept', shared);
  // tried again 30 seconds after the failed start (REOPEN_EVERY_MS), at the page's next look
  const back = opened ? await opened.waitForFunction(() => window.store?.get().boot.stage === 'ready', null, { timeout: 50000 }).then(() => true, () => false) : false;
  say('unusable-folder-recovers-on-its-own', back);
  await app.close().catch(() => undefined);
}
// 7 another PC whose OneDrive already has the team's Punchlist folder (a shortcut added to My files) connects to it without asking
{
  const other = path.join(root, 'other PC'); fs.mkdirSync(path.join(other, 'local'), { recursive: true });
  ({ app, page } = await started(other));
  const saved = JSON.parse(fs.readFileSync(path.join(other, 'local', 'settings.json'), 'utf8')).sharedFolder;
  const deals = await page.evaluate(() => Object.values(store.get().deals).map((d) => d.name).join());
  say('finds-team-folder-on-its-own', saved === shared && deals === 'Project Desktop', `${saved} ${deals}`);
  await app.close();
}
// Sign-in comes first (decisions: "Intelligence sign-in"): a PC that has never signed in shows only the sign-in
// page, before the folder page. Keys are checked against a stand-in of the model service's key check on this PC (never a
// real service): it takes 'good-key' and refuses any other; while it is down, the page says it can't be reached.
{
  const http = await import('node:http');
  let up = false;
  const server = http.createServer((req, res) => {
    if (!up) { req.socket.destroy(); return; }
    const key = req.headers['x-api-key'] ?? String(req.headers.authorization ?? '').replace(/^Bearer /, '');   // the SDK sends it either way
    if (req.url?.startsWith('/v1/models')) { res.writeHead(key === 'good-key' ? 200 : 401, { 'content-type': 'application/json' }); res.end(key === 'good-key' ? '{"data":[],"has_more":false,"first_id":null,"last_id":null}' : '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'); return; }
    res.writeHead(503); res.end();                     // every other call: busy, so it waits and tries again rather than answering
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const fresh = path.join(root, 'fresh'); fs.mkdirSync(path.join(fresh, 'local'), { recursive: true }); fs.mkdirSync(path.join(fresh, 'OneDrive'));   // an empty OneDrive, so the folder page follows
  const app = await electron.launch({ args: [...(process.getuid?.() === 0 || process.env.CI ? ['--no-sandbox'] : []), '.'], env: { ...process.env, PUNCHLIST_HOME: fresh, PUNCHLIST_AI_KEY: '', ANTHROPIC_BASE_URL: base, OneDrive: path.join(fresh, 'OneDrive'), OneDriveCommercial: '' } });
  const page = await app.firstWindow(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.waitForSelector('#signin #si-key'); await shown(app);
  const heading = await page.textContent('#signin h1');
  say('first-start-signs-in-before-the-folder', !(await page.$('#connect')) && heading === 'Sign In to Intelligence');
  say('no-sign-in-window-pops-up', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length) === 1);
  const snap = async (name) => { for (const [w, h] of [[1280, 736], [1024, 640]]) for (const theme of ['dark', 'light']) {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [w, h]);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme); await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(shots, `desktop-signin-${name}-${theme}-${w}x${h}.png`) });
  } };
  await snap('first-start');
  await page.fill('#si-key', 'good-key'); await page.click('#si-key-use'); await page.waitForSelector('#si-retry');
  say('unreachable-says-so-and-keeps-the-key', /can’t be reached/.test(await page.textContent('#si-error')) && (await page.inputValue('#si-key')) === 'good-key');
  await snap('cannot-reach');
  up = true;
  await page.fill('#si-key', 'not-the-key'); await page.click('#si-key-use'); await page.waitForFunction(() => /didn’t accept/.test(document.querySelector('#si-error')?.textContent ?? ''));
  say('refused-key-stays-with-the-reason', (await page.inputValue('#si-key')) === 'not-the-key');
  await snap('refused');
  await page.fill('#si-key', 'good-key'); await page.click('#si-key-use');
  await page.waitForSelector('#connect', { timeout: 20000 });
  say('signed-in-the-folder-page-follows', !!(await page.$('#connect')) && !(await page.$('#signin')));
  say('no-sign-in-page-errors', !page.errors.length, page.errors.join(' | '));
  await app.close(); server.close();
}
fs.rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
// under check:all, the check IDs for scripts/gate-compare.mjs
const gateDir = process.env.PUNCHLIST_GATE_DIR;
const checks = results.map(([id, ok]) => ({ id, ok }));
if (gateDir) fs.writeFileSync(path.join(gateDir, 'smoke.json'), JSON.stringify({ checks }, null, 2));
process.exit(failed.length ? 1 : 0);

/** a small real PDF whose pages each say `text` (as tests/e2e/kit.ts makes them) */
function pdf(text, pages = 1) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages} >>`];
  for (let i = 0; i < pages; i++) { const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj 0 -16 Td (page ${i + 1}) Tj ET`; objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`); }
  let out = '%PDF-1.4\n'; const at = []; objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length; out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
