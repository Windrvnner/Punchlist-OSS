// Going back in the browser while an import
// is open (#267). Only the browser build can do this: the desktop app has
// no Back. The import closes as Escape closes it, and what was read and chosen is kept on this PC.
import { immapReady } from './importReady.mjs';
import { launchChrome } from './chrome.mjs';

const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, note);
};
const browser = await launchChrome();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL);
await page.waitForSelector('#fr-new');

/** whether `selector` shows within a few seconds */
const shows = (selector, state = 'visible') => page.waitForSelector(selector, { state, timeout: 3000 })
  .then(() => true, () => false);
const back = () => page.evaluate(() => history.back());
const forward = () => page.evaluate(() => history.forward());

// a deal with a finding an issues list's point can join
await page.click('#fr-new');
await page.fill('#nd-name', 'Back');
await page.click('#nd-create');
await page.waitForSelector('.dtabs');
const dealId = await page.evaluate(() => Object.values(store.get().deals)[0].id);
const TITLE = 'Change of control definition omits the sponsor fund vehicles';
await page.evaluate(async ({ dealId, title }) => {
  const create = store.commandNamed('CreateFinding');
  await store.dispatch(create, { dealId, title, workstream: 'Legal', body: [title] }, { quiet: true });
}, { dealId, title: TITLE });

{ // the Q&A import: a deal-scale log read, two columns and the mode changed by hand
  const lines = ['Number,Question,Submitted by,Received,Workstream,Response'];
  const workstreams = ['Legal', 'Commercial', 'Financial', 'Technical'];
  for (let i = 1; i <= 2000; i++) {
    const received = `2026-11-${String((i % 28) + 1).padStart(2, '0')}`;
    const question = `"Question ${i}: provide the schedule of lease obligations, part ${i}"`;
    lines.push(`${i},${question},Lender ${'ABCD'[i % 4]},${received},${workstreams[i % 4]},`);
  }
  const file = { name: 'log-2000.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) };
  const openImport = async () => {
    await page.click('#qa-cols');
    await page.click('#qa-import');
    await page.waitForSelector('.imdlg');
  };
  const chosen = () => page.evaluate(() => JSON.stringify({
    map: [...document.querySelectorAll('.immap select')].map((s) => [s.dataset.immap, s.value]),
    mode: document.querySelector('[data-immode].on')?.dataset.immode,
  }));
  const keptAsLeft = async (was) => (await shows('.immap')) && (await chosen()) === was;
  await page.goto(`${URL}#qa-${dealId}`);
  await page.waitForSelector('#qa-add');
  await openImport();
  await page.setInputFiles('#im-file', file);
  await immapReady(page);
  await page.selectOption('[data-immap="workstream"]', '');
  await page.selectOption('[data-immap="askedBy"]', '');
  await page.click('[data-immode="append"]');
  const was = await chosen();
  await back();
  const closed = await shows('.imdlg', 'detached');
  await forward();
  await page.waitForSelector('#qa-add');
  await openImport();
  const afterBack = await keptAsLeft(was);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('#qa-add');
  await openImport();
  const afterReload = await keptAsLeft(was);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.imdlg', { state: 'detached' });
  say('#267 browser Back closes the Q&A import and keeps its columns and mode', closed && afterBack && afterReload,
    JSON.stringify({ closed, afterBack, afterReload, was }));
}

{ // an issues list: a point ticked to keep as its own finding rather than join the one already raised
  const openList = async () => {
    await page.click('#f-more');
    await page.click('#f-import');
  };
  const ticked = async () => (await shows('#il-raised')) && page.isChecked('#il-raised .keep input');
  const list = `Comments\n1. ${TITLE}\n2. Fees letter is not yet agreed`;
  await page.goto(`${URL}#deal-${dealId}`);
  await page.waitForSelector('#f-more');
  await openList();
  await page.waitForSelector('#il-drop');
  await page.setInputFiles('#il-file', {
    name: 'Lender counsel comments.txt', mimeType: 'text/plain', buffer: Buffer.from(list),
  });
  await page.waitForSelector('#il-raised');
  await page.click('#il-raised .keep input');
  const before = await page.isChecked('#il-raised .keep input');
  await back();
  const closed = await shows('#il-raised', 'detached');
  await forward();
  await page.waitForSelector('#f-more');
  await openList();
  const afterBack = await ticked();
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('#f-more');
  await openList();
  const afterReload = await ticked();
  say('#267 browser Back closes the issues list import and keeps its check marks',
    before && closed && afterBack && afterReload, JSON.stringify({ before, closed, afterBack, afterReload }));
}

say('#267 no page errors', !errors.length, JSON.stringify(errors));
await ctx.close();
await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
