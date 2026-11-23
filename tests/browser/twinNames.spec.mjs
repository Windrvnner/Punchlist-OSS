// Delete Deal and Remove from My Deals say which of two same-named deals they mean, with the sidebar's line in
// brackets, in their dialogs and notices; a deal with a name of its own reads as before (#27).
// SHOTS=<folder> also saves each dialog and notice in dark and light at 1280x736 and 1024x640.
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const SHOTS = process.env.SHOTS;
const LONG = 'Northwind Capital Infrastructure Holdings Refinancing and Recapitalization';
const LONG_PARTY = 'Fabrikam Infrastructure Partners Fund IV (Lux) SCSp';
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, note);
};
const browser = await launchChrome();

/** a window with two Kestrel deals, a long-named pair, and Coho on its own; returns the deals' ids by counterparty */
async function open(width = 1280, height = 736, scheme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#fr-new');
  const ids = await page.evaluate(async ([long, longParty]) => {
    const make = [
      ['Kestrel', 'Adatum Renewable'], ['Kestrel', 'Wingtip'], [long, longParty], [long, 'Oak'], ['Coho', ''],
    ];
    for (const [name, counterparty] of make) {
      await store.dispatch(store.commandNamed('CreateDeal'), { name, folders: [], counterparty }, { quiet: true });
    }
    return Object.fromEntries(Object.values(store.get().deals).map((d) => [d.counterparty || d.name, d.id]));
  }, [LONG, LONG_PARTY]);
  return { ctx, page, ids };
}

async function shot(page, name) {
  if (!SHOTS) return;
  const { width, height } = page.viewportSize();
  const scheme = await page.evaluate(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${SHOTS}/${name}-${scheme}-${width}x${height}.png` });
}

const text = (page, selector) => page.$eval(selector, (el) => el.textContent.replace(/\s+/g, ' ').trim());
/** clears the notices shown, so the next one read is the one an action puts up */
const clearNotices = (page) => page.evaluate(() => store.ui({ toasts: [] }));
/** a notice's words as read aloud, what shows of them, and whether its title shows whole */
const notice = async (page) => {
  await page.waitForSelector('#toast .ttext');
  return page.$eval('#toast .ttext', (el) => {
    const without = (selector) => {
      const copy = el.cloneNode(true);
      for (const part of copy.querySelectorAll(selector)) part.remove();
      return copy.textContent.replace(/\s+/g, ' ').trim();
    };
    const title = el.querySelector('.ttitle');
    return { said: without('[aria-hidden="true"]'), shown: without('.sr-only'),
      whole: !!title && title.scrollWidth <= title.clientWidth + 1
        && !title.querySelector('.tcut')?.textContent.endsWith('…') };
  });
};
/** the dialog's title fits inside it: it wraps, never runs past the edge */
const fits = (page) => page.$eval('.dddlg h2', (h) => h.scrollWidth <= h.clientWidth
  && h.getBoundingClientRect().right <= h.closest('.dddlg').getBoundingClientRect().right);

async function goTo(page, dealId) {
  await page.evaluate((id) => { location.hash = `overview-${id}`; }, dealId);
  await page.waitForSelector('.dtabs');
}

/** Remove from My Deals on the deal's own sidebar row: its confirm, its notice, and the notice's Undo */
async function removeFromMine(page, dealId, name) {
  await goTo(page, dealId);
  await clearNotices(page);
  const row = page.locator('.rail .drow', { has: page.locator(`a[href$="${dealId}"]`) });
  await row.hover();
  await row.locator('.dmore').click();
  await page.click('#deal-unlist');
  await page.waitForSelector('.uldlg h2');
  const asked = await text(page, '.uldlg h2');
  const fit = await fits(page);
  await shot(page, `${name}-remove-confirm`);
  await clearNotices(page);
  await page.click('#ul-go');
  const told = await notice(page);
  await shot(page, `${name}-remove-notice`);
  await page.click('#toast .tundo');
  await page.waitForFunction((id) => !!document.querySelector(`.rail a[href$="${id}"]`), dealId);
  return { asked, told, fit };
}

/** Delete Deal: both dialogs, typed with the name alone, and the notice once it is gone */
async function deleteDeal(page, dealId, name) {
  await goTo(page, dealId);
  await clearNotices(page);
  await page.evaluate((id) => store.ui({ deleteDeal: { dealId: id, typed: '', error: '' } }), dealId);
  await page.waitForSelector('#dd-name');
  const first = await text(page, '.ddtext');
  const typedName = await page.evaluate((id) => store.get().deals[id].name, dealId);
  await page.fill('#dd-name', typedName);
  await shot(page, `${name}-delete-1`);
  await page.click('#dd-next');
  await page.waitForSelector('#dd-title');
  const second = await text(page, '#dd-title');
  const fit = await fits(page);
  await shot(page, `${name}-delete-2`);
  await clearNotices(page);
  await page.click('#dd-go');
  const told = await notice(page);
  await shot(page, `${name}-delete-notice`);
  return { first, second, told, fit };
}

async function checkWording() {
  const { ctx, page, ids } = await open();
  const removed = await removeFromMine(page, ids.Wingtip, 'twin');
  say('#27 Remove from My Deals names the twin, and its Undo brings it back',
    removed.asked === 'Remove Project Kestrel (Wingtip) from your deals?'
    && removed.told.said === 'Project Kestrel (Wingtip) removed · From your deals'
    && removed.told.whole && removed.fit, JSON.stringify(removed));
  const gone = await deleteDeal(page, ids.Wingtip, 'twin');
  say('#27 Delete Deal names the twin in both dialogs and the notice; the name alone confirms it',
    gone.first === 'Project Kestrel (Wingtip) will be deleted with its findings and its Q&A.'
      + ' Type Project Kestrel to continue.'
    && gone.second === 'Delete Project Kestrel (Wingtip) for good?'
    && gone.told.said === 'Project Kestrel (Wingtip) deleted' && gone.told.whole && gone.fit, JSON.stringify(gone));
  const long = await deleteDeal(page, ids[LONG_PARTY], 'long');
  say('#27 a long name and counterparty wrap inside the dialog', long.fit
    && long.second === `Delete Project ${LONG} (${LONG_PARTY}) for good?`, JSON.stringify(long));
  say('#27 a long name and twin line give way at their end in the notice, never "deleted"',
    long.told.said === `Project ${LONG} (${LONG_PARTY}) deleted` && long.told.shown.startsWith('Project Northwind')
    && long.told.shown.endsWith('… deleted'), JSON.stringify(long.told));
  const single = await deleteDeal(page, ids['Project Coho'], 'single');
  say('#27 a deal with a name of its own reads as before', single.second === 'Delete Project Coho for good?'
    && single.told.said === 'Project Coho deleted' && single.told.whole
    && single.first.startsWith('Project Coho will be deleted')
    && !page.errors.length, JSON.stringify({ single, errors: page.errors }));
  await ctx.close();
}

/** the mock-ups: each dialog and notice in both themes at both sizes */
async function takeShots() {
  for (const [width, height] of [[1280, 736], [1024, 640]]) {
    for (const scheme of ['dark', 'light']) {
      const { ctx, page, ids } = await open(width, height, scheme);
      await removeFromMine(page, ids.Wingtip, 'twin');
      await deleteDeal(page, ids[LONG_PARTY], 'long');
      await deleteDeal(page, ids.Wingtip, 'twin');
      await ctx.close();
    }
  }
}

await checkWording();
if (SHOTS) await takeShots();
await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
