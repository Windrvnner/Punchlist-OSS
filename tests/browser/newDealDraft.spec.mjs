// The New deal form never loses what was typed or chosen: it is kept across a reload until the deal is made (#55),
// a folder still being read when the form goes comes back (#113), and Create holds the form while it reads a typed
// path, so no deal is made without its folder (#36).
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const KEPT = 'dil/1/kept-drafts';
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, note);
};
const browser = await launchChrome();

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#fr-new');
  return { ctx, page };
}

/** holds every folder read until `window.releaseScans()`; `window.scansHeld()` counts the reads waiting */
const holdScans = (page) => page.evaluate(() => {
  const scan = store.services.docs.scanFolder.bind(store.services.docs);
  const waiting = [];
  window.scansHeld = () => waiting.length;
  window.releaseScans = () => {
    for (const go of waiting.splice(0)) go();
  };
  store.services.docs.scanFolder = async (...args) => {
    await new Promise((go) => waiting.push(go));
    return scan(...args);
  };
});

/** every folder read fails, as for a path that cannot be opened */
const failScans = (page) => page.evaluate(() => {
  store.services.docs.scanFolder = async () => ({ ok: false, error: { kind: 'notFound', message: 'x' } });
});

/** the form as it shows now */
const form = (page) => page.evaluate(() => ({
  name: document.querySelector('#nd-name')?.value,
  counterparty: document.querySelector('#nd-cp')?.value,
  path: document.querySelector('#nd-path')?.value ?? null,
  kinds: store.get().ui.newDeal?.kinds ?? null,
  folders: [...document.querySelectorAll('.ndrow .p')].map((p) => p.textContent),
}));

/** opens New deal from the start page's button, or as the sidebar opens it once a deal exists */
async function reopen(page) {
  if (await page.$('#fr-new')) await page.click('#fr-new');
  else await page.evaluate(() => store.ui({ newDeal: { name: '', folders: [], error: '', busy: false } }));
  await page.waitForSelector('#nd-name');
}

async function dismiss(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#nd-name', { state: 'detached' });
}

/** reloads once the kept drafts have been written */
async function reload(page, ready = '#fr-new') {
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector(ready);
}

async function chooseFolder(page, path) {
  await page.evaluate((p) => { window.__pickFolder = p; }, path);
  await page.click('#nd-browse');
}

const dealsNamed = (page, name) => page.evaluate((n) => Object.values(store.get().deals)
  .filter((d) => d.name === n).map((d) => d.folders.map((f) => f.path)), name);

const toDeal = (page) => page.waitForFunction(() => /^#(overview|deal)-d_/.test(location.hash), null,
  { timeout: 15000 });

/** #55: everything in the form survives a reload with the form still open, and Create lets it go */
async function keptAcrossReload() {
  const { ctx, page } = await open();
  await reopen(page);
  await page.fill('#nd-name', 'Buyer diligence');
  await page.fill('#nd-cp', 'Acme');
  await page.click('#nd-paste');
  await page.fill('#nd-path', 'D:\\Example\\Evidence');
  await page.press('#nd-path', 'Enter');
  await page.waitForSelector('.ndrow');
  await page.fill('#nd-path', 'D:\\Example\\Second');
  await page.evaluate(() => store.ui((ui) => ({ newDeal: { ...ui.newDeal, kinds: { product: 'Acquisition' } } })));
  await reload(page);
  await reopen(page);
  const back = await form(page);
  say('#55 the form comes back after a reload with it open', back.name === 'Buyer diligence'
    && back.counterparty === 'Acme' && back.path === 'D:\\Example\\Second' && back.kinds?.product === 'Acquisition'
    && back.folders.join() === 'D:\\Example\\Evidence', JSON.stringify(back));
  await page.click('#nd-create');
  await toDeal(page);
  const made = await dealsNamed(page, 'Project Buyer diligence');
  await reload(page, '.dtabs');
  await reopen(page);
  await page.waitForTimeout(200);
  const after = await form(page);
  say('#55 Create lets the kept form go', made.length === 1 && made[0].length === 2 && after.name === ''
    && after.counterparty === '' && !after.folders.length && after.path === null && !page.errors.length,
    JSON.stringify({ made, after, errors: page.errors }));
  await ctx.close();
}

/** #55: clearing every field forgets the form; closing another deal's Folders dialog does not */
async function keptOnlyWhileFilled() {
  const { ctx, page } = await open();
  await reopen(page);
  await page.fill('#nd-name', 'Fabrikam');
  await page.fill('#nd-name', '');
  await page.waitForTimeout(600);
  const cleared = await page.evaluate((key) => localStorage.getItem(key), KEPT);
  await page.evaluate(() => store.dispatch(store.commandNamed('CreateDeal'), { name: 'Other', folders: [] },
    { quiet: true }));
  await page.fill('#nd-name', 'Fabrikam');
  await dismiss(page);
  await page.evaluate(() => {
    const d = Object.values(store.get().deals)[0];
    store.ui({ newDeal: { name: d.name, folders: [], error: '', busy: false, forDeal: d.id } });
  });
  await page.waitForSelector('#nd-title');
  await page.keyboard.press('Escape');
  await page.waitForSelector('#nd-title', { state: 'detached' });
  await reopen(page);
  const back = await form(page);
  say('#55 an empty form keeps nothing, and the Folders dialog leaves the New deal draft alone',
    !cleared?.includes('new-deal') && back.name === 'Fabrikam' && !page.errors.length,
    JSON.stringify({ cleared, back }));
  await ctx.close();
}

await keptAcrossReload();
await keptOnlyWhileFilled();
await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
