/**
 * Intelligence sign-in window in a real Electron, against the stand-in North (tests/backend/northStandIn.ts), whose home
 * page sets a JWT cookie as the SSO site would. Built and run by tests/desktop/signin.spec.mjs; prints PASS or FAIL lines.
 */
import { app, safeStorage, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aiSignIn } from '../../src/desktop/signin';
import { SERVICE } from '../../src/control';
import { northService } from '../../src/backend/north';
import { northStandIn, jwt } from '../backend/northStandIn';

const results: [string, boolean, string?][] = [];
const check = (name: string, pass: boolean, note = '') => { results.push([name, pass, note]); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${note}`); };
const until = async (f: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 100)); return f(); };

// On Windows the running app still holds files in its own data folder, so removing the temporary folder can fail
// with EPERM; that must not keep the app from exiting with the results, so the folder is left to the system's cleanup
function removeTemporaryFolder(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.log(`(temporary folder left in place: ${(error as Error).message})`);
  }
}

app.on('window-all-closed', () => { /* the sign-in window closing must not end the test */ });
app.whenReady().then(async () => {
  const token = jwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
  const north = await northStandIn({ ssoToken: token, tokens: [token] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-signin-'));
  app.setPath('userData', path.join(dir, 'window'));
  try {
    const probe = (t: Parameters<typeof northService>[0]['token']) => northService({ address: north.address, token: t, models: { fast: 'f', standard: 's', thorough: 't' } });
    const s = aiSignIn({ provider: 'north', address: north.address, ssoSite: north.address, sso: true, apiKey: true, dir, parent: () => null, probe });
    const svc = northService({
      address: north.address,
      token: s.holder,
      models: { fast: 'model-fast', standard: 'model-standard', thorough: 'model-thorough' },
    });
    check('signed-out-at-start', !s.holder.signedIn());
    check('first-setup-at-start', (await s.service.status()).ok && (await s.service.status() as { value: { firstSetup?: boolean } }).value.firstSetup === true);
    const who = svc.whoami();                                    // waits for the sign-in
    s.start();                                                   // at first setup the sign-in page asks: no window opens by itself
    check('first-setup-opens-no-window', BrowserWindow.getAllWindows().length === 0 && !s.prompting());
    await s.service.signIn();                                    // Single sign-on on the page: the window opens and takes the cookie
    // the window keeps its own title once the page loads, rather than the page's ("North" on the stand-in)
    const w = BrowserWindow.getAllWindows()[0];
    if (w) await new Promise((r) => { w.webContents.once('did-finish-load', () => r(undefined)); setTimeout(r, 5000); });
    check('title-stays-service-sign-in', !!w && !w.isDestroyed() && w.webContents.getTitle() === 'North' && w.getTitle() === `${SERVICE} sign-in`, w && !w.isDestroyed() ? JSON.stringify([w.getTitle(), w.webContents.getTitle()]) : 'no window');
    check('token-taken-from-cookie', await until(() => s.holder.signedIn()));
    check('waiting-call-carried-on', (await who).name === 'jdoe', JSON.stringify(await who));
    check('token-sent-as-bearer', north.seen.some((r) => r.auth === `Bearer ${token}`));
    // kept only encrypted: where this PC can encrypt, the file holds no trace of the token; where it cannot, there is no file
    const file = path.join(dir, 'north-token.bin');   // one file per provider
    const enc = safeStorage.isEncryptionAvailable();
    check('kept-only-encrypted', enc ? fs.existsSync(file) && !fs.readFileSync(file, 'latin1').includes(token.slice(0, 20)) : !fs.existsSync(file), enc ? 'encrypted on disk' : '(no encryption on this PC: kept in memory only)');
    // a refused token opens the window again, and is not taken again from the cookie there
    s.holder.refused(token);
    await new Promise((r) => setTimeout(r, 3000));
    check('refused-token-not-taken-again', !s.holder.signedIn());
    check('paste-rejects-blank', !(await s.service.paste('  ')).ok);
    // a pasted key is checked with the service first: a refused one is not taken, and says so
    const no = await s.service.paste('pasted-token');
    check('paste-refused-not-taken', !no.ok && no.error.kind === 'invalid' && /didn’t accept that key/.test(no.error.message) && !s.holder.signedIn(), JSON.stringify(no));
    north.tokens.add('pasted-token');
    check('paste-accepted', (await s.service.paste('pasted-token')).ok && s.holder.signedIn());
    check('status-offers-both', JSON.stringify((await s.service.status()) as unknown) === JSON.stringify({ ok: true, value: { signedIn: true, sso: true, apiKey: true, firstSetup: false } }));
    // with no answer from the service the key is not taken either, and the one in use stays
    const away = aiSignIn({ provider: 'north', address: 'http://127.0.0.1:9', ssoSite: 'http://127.0.0.1:9', sso: false, apiKey: true, dir: path.join(dir, 'away'), parent: () => null, probe: (t) => northService({ address: 'http://127.0.0.1:9', token: t, models: { fast: 'f', standard: 's', thorough: 't' } }) });
    const unreach = await away.service.paste('any-key');
    check('paste-unreachable-not-taken', !unreach.ok && unreach.error.kind === 'unreachable' && !away.holder.signedIn(), JSON.stringify(unreach));
    away.close();
    s.close();
    // a provider that refuses every SSO token: the window does not loop; it gives up after three, and the call fails
    let n = 0; const fresh = () => jwt({ sub: `u${++n}`, exp: Math.floor(Date.now() / 1000) + 3600 });
    const refusing = await northStandIn({ ssoToken: fresh, tokens: [] });
    const d2 = path.join(dir, 'refusing'); app.setPath('userData', path.join(d2, 'window'));
    const r = aiSignIn({ provider: 'north', address: refusing.address, ssoSite: refusing.address, sso: true, apiKey: true, dir: d2, parent: () => null });
    const rsvc = northService({ address: refusing.address, token: r.holder, models: { fast: 'f', standard: 's', thorough: 't' } });
    const failed = rsvc.whoami().then(() => 'answered', (e) => e.code);
    await r.service.signIn();
    check('refused-sso-call-fails', (await failed) === 'unreachable');
    const status = await r.service.status();
    check('refused-sso-gives-up', status.ok && /did not work/.test(status.value.problem ?? ''), JSON.stringify(status));
    check('refused-sso-tried-three-times', refusing.seen.filter((x) => x.path === '/v1/users/me').length === 3, String(refusing.seen.length));
    r.close(); await refusing.close();
    // a pop-up the sign-in page opens, and one that pop-up opens, keep the same title; no cookie here, so the window stays open
    const quiet = await northStandIn({ tokens: [] });
    const d3 = path.join(dir, 'pop-ups'); app.setPath('userData', path.join(d3, 'window'));
    const q = aiSignIn({ provider: 'north', address: quiet.address, ssoSite: quiet.address, sso: true, apiKey: true, dir: d3, parent: () => null });
    await q.service.signIn();
    const loaded = (x: BrowserWindow) => new Promise((r) => { if (!x.webContents.isLoading() && x.webContents.getTitle() === 'North') r(undefined); else x.webContents.once('did-finish-load', () => r(undefined)); setTimeout(r, 5000); });
    const opened = async (from: BrowserWindow) => { const before = new Set(BrowserWindow.getAllWindows()); await from.webContents.executeJavaScript(`void window.open(${JSON.stringify(quiet.address)}, '_blank', 'popup'); 0`, true); await until(() => BrowserWindow.getAllWindows().some((x) => !before.has(x))); return BrowserWindow.getAllWindows().find((x) => !before.has(x)); };
    const main = BrowserWindow.getAllWindows()[0]; await loaded(main);
    const pop = await opened(main); if (pop) await loaded(pop);
    const popPop = pop ? await opened(pop) : undefined; if (popPop) await loaded(popPop);
    const titles = [pop, popPop].map((x) => x && !x.isDestroyed() ? [x.getTitle(), x.webContents.getTitle()] : null);
    check('pop-ups-keep-the-title', titles.every((t) => !!t && t[0] === `${SERVICE} sign-in` && t[1] === 'North'), JSON.stringify(titles));
    q.close(); for (const x of BrowserWindow.getAllWindows()) x.destroy(); await quiet.close();
    // each way of signing in can be turned off in the control file; single sign-on is never offered on Claude
    const off = aiSignIn({ provider: 'claude', address: north.address, ssoSite: north.address, sso: true, apiKey: false, dir, parent: () => null });
    check('claude-has-no-sso', !(await off.service.signIn()).ok);
    check('api-key-turned-off', !(await off.service.paste('a-key')).ok);
    off.close();
  } catch (e) { check('no-exception', false, String(e)); }
  await north.close();
  removeTemporaryFolder(dir);
  const failed = results.filter((r) => !r[1]).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  app.exit(failed ? 1 : 0);
});
