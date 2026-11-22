// The list toolbars at deal scale: 2,000 questions and 120 findings.
// Q&A's workstream filter is a filter button opening the app's own menu (All, A to Z, No workstream last),
// named while on; Findings' filter menu has Workstream and Reviewed as sections. Findings' ⋯ holds Import…,
// Export… and Deleted…. Status is left out while every row shown has the same status; Response never is.
// Menus dim and blur nothing behind them.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = [];
const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } });
const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
await page.goto(URL); await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
const WS = ['Commercial', 'Environmental & social', 'Financial', 'Legal', 'Tax', ''];
const id = await page.evaluate(async (WS) => {
  const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
  await run('CreateDeal', { name: 'Project Proseware', folders: [] });
  const dealId = Object.values(store.get().deals).find((d) => d.name.endsWith('Proseware')).id;
  const rows = Array.from({ length: 2000 },
    (_, k) => ({ line: k + 2, n: k + 1, askedBy: ['Lender A', 'Bidder C'][k % 2],
    text: `Provide the executed version of schedule ${(k * 7919) % 10007} and confirm any amendments since signing.`,
    received: '', workstream: WS[k % WS.length], priority: k % 4 ? 'Medium' : 'High', respondedBy: '', responded: '',
    response: k % 3 === 2 ? 'Uploaded to the data room.' : '', status: k % 3 === 2 ? 'answered' : 'open' }));
  await run('ImportQuestions', { dealId, mode: 'append', rows });
  for (let k = 0; k < 120; k++) {
    const workstream = WS[k % WS.length] || 'Legal';
    await run('CreateFinding',
      { dealId, title: `Lock-up ratio differs from the term sheet ${k + 1}`, workstream, body: ['x'] });
  }
  store.ui({ toasts: [] }); return dealId;
}, WS);

// Q&A: one status chosen, every row says it, so Status is left out; Response stays
await page.goto(`${URL}#qa-${id}`); await page.waitForSelector('.md .li');
const heads = () => page.$$eval('.lhout span', (s) => s.map((x) => x.textContent));
const openHeads = await heads();
say('one-status-chosen-leaves-status-out-keeps-response', !openHeads.includes('Status')
  && openHeads.includes('Response'),
  openHeads.join('|'));
await page.click('[data-qaf="all"]'); await page.waitForTimeout(200);
const allHeads = await heads();
say('all-statuses-show-the-status-column', allHeads.includes('Status'), allHeads.join('|'));
const chosen = await page.evaluate(() => store.get().prefs.hideCols.status);
say('the-person-s-column-choice-is-untouched', chosen === false, String(chosen));

// Q&A: the filter button and its menu
await page.click('[data-qaf="open"]'); await page.click('#qa-ws'); await page.waitForSelector('.wsmenu');
const items = await page.$$eval('.wsmenu label', (l) => l.map((x) => x.textContent));
say('menu-is-all-then-a-to-z-then-no-workstream', items[0] === 'All Workstreams' && items.at(-1) === 'No workstream'
  && items.includes('Environmental & social'), items.join('|'));
const shield = await page.evaluate(() => { const sh = document.querySelector('.popshield:popover-open');
  const cs = sh && getComputedStyle(sh); return cs ? `${cs.backgroundColor} ${cs.backdropFilter}` : 'none'; });
say('a-menu-dims-and-blurs-nothing', shield === 'none' || shield === 'rgba(0, 0, 0, 0) none', shield);
await page.click('.wsmenu label:has(input[value="Environmental & social"])');
await page.waitForSelector('.wsmenu', { state: 'detached' });
const on = await page.evaluate(() => { const b = document.querySelector('#qa-ws'); const rows = store.get().ui.qaFilter;
  const t = document.querySelector('.trk-tools');
  return { text: b.textContent, on: b.classList.contains('on'), ws: rows.workstream,
    oneRow: t.scrollWidth <= t.clientWidth + 1, tip: b.title }; });
say('a-chosen-workstream-names-the-button-in-the-on-look', on.text === 'Environmental & social' && on.on && on.oneRow
  && on.tip === 'Workstream: Environmental & social', JSON.stringify(on));
await page.click('#qa-ws');
await page.click('.wsmenu label:has(input[value="No workstream"])');
await page.click('[data-qaf="all"]'); await page.waitForTimeout(200);
const none = await page.evaluate(() => [...document.querySelectorAll('.md .li:not(.vsize)')]
  .map((r) => store.get().questions[r.dataset.q])
  .filter(Boolean).map((q) => q.workstream));
say('no-workstream-lists-only-questions-without-one', none.length > 5 && none.every((w) => w === ''),
  `${none.length} rows`);
await page.click('#qa-add'); await page.waitForSelector('.det textarea.qtext');
const added = await page.evaluate(() => store.get().questions[store.get().ui.selectedQuestion]?.workstream);
say('a-question-added-under-no-workstream-has-none', added === '', JSON.stringify(added));
await page.keyboard.press('Escape');
await page.click('#qa-cols'); await page.click('#qa-export'); await page.waitForSelector('#x-count');
const x = await page.evaluate(() => ({ ws: document.getElementById('x-ws').value,
  n: document.getElementById('x-count').textContent }));
say('export-from-no-workstream-holds-those-questions', x.ws === 'No workstream' && x.n !== '0 questions',
  JSON.stringify(x));
await page.keyboard.press('Escape');

// Findings: filter and More menus
await page.goto(`${URL}#deal-${id}`); await page.waitForSelector('#f-more');
const row = await page.$$eval('.fhead .btn', (b) => b.map((x) => x.id));
await page.click('#f-more');
const menu = await page.$$eval('.fmore .mi',
  (m) => m.map((x) => `${x.id}:${x.textContent}:${x.disabled ? 'off' : 'on'}`));
say('findings-shows-new-finding-and-the-more-menu', row.join() === 'f-filter,f-new,f-more', row.join());
say('the-more-menu-holds-import-export-deleted',
  menu.join() === 'f-import:Import…:on,f-export:Export…:on,f-deleted:Deleted…:off',
  menu.join());
await page.keyboard.press('Escape');
await page.click('#f-filter'); await page.waitForSelector('.fmenu');
const sections = await page.$$eval('.fmenu [role="radiogroup"]', (g) => g.map((x) => x.getAttribute('aria-label')));
say('findings-filter-has-workstream-and-reviewed-sections', sections.join() === 'Workstream,Reviewed'
  && !(await page.$('.fmenu select')), sections.join());
await page.click('.fmenu label:has(input[name="f-rev"][value="yes"])');
const rev = await page.evaluate(() => store.get().ui.findingFilter.reviewed);
say('a-reviewed-choice-filters', rev === 'yes', rev);

say('no-page-errors', page.errors.length === 0, page.errors.join(' | '));
await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
