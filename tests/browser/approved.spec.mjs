// The main screens look as approved (#1027): each is compared with its image in tests/browser/approved/, in dark and
// light, at 1280x736 and 1024x640. A screen changed on purpose gets a new image in the same pull request, taken from
// a failed CI run's upload (browser-logs-<shard>, approved/): text edges render slightly differently elsewhere.
//   PUNCHLIST_APPROVE=1 node tests/browser/approved.spec.mjs     (writes every image from this machine, for local runs)
import { launchChrome } from './chrome.mjs';
import { approve, approvedPath, differingPixels, keepChanged } from './approvedImages.mjs';
import { openOnFindings } from './landing.mjs';
import fs from 'node:fs';

const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const SIZES = [[1280, 736], [1024, 640]];
// Pixels that may differ on a screen before it counts as changed: room for text edges that shift by a shade.
const MAX_DIFFERING = 50;
// Times and dates on screen are drawn from this moment, so every run shows the same ones.
const FIXED_TIME = new Date('2026-06-01T14:00:00Z');
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, note);
};
const browser = await launchChrome();
openOnFindings(browser);

/** A new window at `size` and `scheme` holding the sample deal, with the clock held at FIXED_TIME. */
async function sampleDeal([width, height], scheme) {
  const ctx = await browser.newContext({
    viewport: { width, height }, colorScheme: scheme, locale: 'en-US', timezoneId: 'America/New_York',
  });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(FIXED_TIME);
  await page.goto(URL);
  await page.waitForSelector('#fr-new');
  await page.click('#fr-new');
  await page.fill('#nd-name', 'Datum');
  await page.click('#nd-paste');
  await page.fill('#nd-path', 'reports');
  await page.press('#nd-path', 'Enter');
  await page.waitForSelector('.ndrow');
  await page.click('#nd-create');
  await page.waitForFunction(() => Object.values(store.get().deals)[0]?.stage === 'ready', null, { timeout: 40000 });
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
  const dealId = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  return { ctx, page, dealId };
}

/** The first finding of the deal by title, so every run opens the same one. */
function firstFinding(page, dealId) {
  return page.evaluate((id) => Object.values(store.get().findings)
    .filter((finding) => finding.dealId === id)
    .sort((a, b) => a.title.localeCompare(b.title))[0].id, dealId);
}

/** Each screen: its name and how to bring it up from the sample deal. */
const SCREENS = [
  ['home', async ({ page }) => {
    await page.goto(`${URL}#deals`);
    await page.waitForSelector('#hask');
  }],
  ['findings', async ({ page, dealId }) => {
    await page.goto(`${URL}#deal-${dealId}`);
    await page.waitForSelector('.flagrow');
  }],
  ['qa', async ({ page, dealId }) => {
    await page.goto(`${URL}#qa-${dealId}`);
    await page.waitForSelector('#qa-cols');
  }],
  ['finding', async ({ page, dealId }) => {
    await page.goto(`${URL}#finding-${dealId}-${await firstFinding(page, dealId)}`);
    await page.waitForSelector('#f-review');
  }],
  ['settings', async ({ page, dealId }) => {
    await page.goto(`${URL}#deal-${dealId}`);
    await page.waitForSelector('.flagrow');
    await page.click('#u-menu');
    await page.waitForSelector('.setdlg');
  }],
];

/** Shows one screen, takes its picture, and compares it with the approved one (or saves it, when approving). */
async function checkScreen(deal, name, show) {
  await show(deal);
  await deal.page.mouse.move(0, 0);
  await deal.page.evaluate(() => document.fonts.ready);
  const png = await deal.page.screenshot({ animations: 'disabled', caret: 'hide' });
  if (process.env.PUNCHLIST_APPROVE === '1') {
    approve(name, png);
    say(`${name}:approved-image-saved`, true);
    return;
  }
  const expected = approvedPath(name);
  if (!expected) {
    keepChanged(name, png, null);
    say(`${name}:looks-as-approved`, false, 'no approved image yet');
    return;
  }
  const { differing, total, diffPng } = await differingPixels(deal.page, fs.readFileSync(expected), png);
  const same = differing >= 0 && differing <= MAX_DIFFERING;
  if (!same) keepChanged(name, png, diffPng);
  const note = differing < 0 ? 'the size changed' : `${differing} of ${total} pixels differ`;
  say(`${name}:looks-as-approved`, same, note);
}

for (const size of SIZES) {
  for (const scheme of ['dark', 'light']) {
    const deal = await sampleDeal(size, scheme);
    for (const [screen, show] of SCREENS) await checkScreen(deal, `${size.join('x')}-${scheme}-${screen}`, show);
    await deal.ctx.close();
  }
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
