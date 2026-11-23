// The Findings list grouped by workstream, at deal scale: 120 findings, 90 of them open, some marked "May be out
// of date", a few with a workstream the app does not list and a few with none. Each workstream is one heading with its
// count, in the app's order; marked findings lead their group; the queue beside an open finding steps through the same
// order. With SHOTS=<folder>, screenshots of the list in dark and light at 1280x736 and 1024x640 are saved there.
import { launchChrome } from './chrome.mjs';
import fs from 'node:fs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const SHOTS = process.env.SHOTS || ''; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const ORDER = ['Commercial', 'Environmental & social', 'Financial', 'Insurance', 'Interconnection', 'Legal', 'Tax', 'Technical', 'No workstream'];   // A to Z, none last

// titles of the kind a check raises, by workstream; each is used with a few different subjects so 120 read as a deal's
const POOL = {
  Technical: ['Degradation rate in the model differs from the module datasheet', 'Independent engineer has not reviewed the latest energy yield report', 'Availability guarantee in the O&M contract is below the base case', 'Inverter warranty ends before the debt tenor', 'Curtailment assumption is not supported by the grid study', 'Construction schedule leaves no float before the outside date', 'Tracker supplier has no reference projects of this size', 'Spare parts list in the O&M contract is incomplete'],
  Legal: ['Security package does not cover the substation easement', 'Direct agreement with the EPC contractor is unsigned', 'Change of control clause in the PPA needs offtaker consent', 'Land lease term ends before the final maturity', 'Step-in rights under the O&M contract are not assignable', 'Shareholder loan is not subordinated in the draft intercreditor', 'Hedging counterparty is not a party to the intercreditor', 'Conditions precedent list omits the interconnection permit'],
  Commercial: ['Merchant tail assumes prices above the market advisor forecast', 'PPA indexation differs between the term sheet and the contract', 'Offtaker credit rating is below the threshold in the term sheet', 'Revenue from capacity payments is not contracted', 'Market report is more than a year old'],
  Financial: ['Lock-up ratio differs between the term sheet and the credit agreement', 'Model audit has not covered the latest refinancing case', 'Debt sculpting uses a P50 case instead of the P90', 'DSRA sizing in the model differs from the credit agreement', 'Tax equity flip date is not modeled', 'Contingency is below the lenders’ technical advisor recommendation'],
  Insurance: ['Delay in start-up cover is shorter than the lenders require', 'Insurance advisor report is still in draft', 'Lenders are not named as loss payees', 'Business interruption indemnity period is twelve months, not eighteen'],
  Tax: ['Tax depreciation assumption has no tax opinion behind it', 'Withholding tax on shareholder loan interest is not modeled', 'Sales tax recovery on construction costs is assumed in full'],
  'Environmental & social': ['Grievance mechanism is not in place for the local community', 'Bird and bat monitoring plan has not been approved', 'Environmental permit conditions are not reflected in the O&M scope'],
  'Interconnection': ['Interconnection date in the agreement differs from the model', 'Interconnection agreement requires network upgrades not in the budget'],
  '': ['Signed board minutes for the financing are missing', 'Data room index does not match the documents provided'],
};
const SUBJ = ['', ' for phase 2', ' for the battery storage', ' after the October amendment'];
const WHY = ['Found by the check on Nov 16', 'Response received on Q12', 'Side letter.pdf arrived'];

async function setup(w, h, scheme) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Project Proseware'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.evaluate(async ([dealId, POOL, SUBJ, WHY]) => {
    const repo = store.services.repo; const writes = []; const add = []; let n = 0;
    const ws = Object.keys(POOL); const t0 = Date.parse('2026-11-16T15:00:00Z');
    // 120 findings spread over the workstreams the way a check raises them: interleaved, not already grouped
    for (let round = 0; n < 120; round++) for (const w of ws) {
      const titles = POOL[w]; const base = titles[round % titles.length]; const subj = SUBJ[Math.floor(round / titles.length) % SUBJ.length];
      if (n >= 120) break;
      const fid = `f_01HZZZZZZZZZZZZZZZZZZZ${String(n).padStart(4, '0')}`; const at = new Date(t0 - n * 3_600_000).toISOString();
      const open = n % 4 !== 3; const marked = open && n % 11 === 0;
      writes.push({ kind: 'finding', id: fid, expectedRev: null, data: { id: fid, dealId, rev: 0, createdAt: at,
        updatedAt: at, title: base + subj, workstream: w, status: open ? 'open' : 'closed', raisedAt: at,
        body: ['The documents do not agree on this point.'], sources: [], origin: 'ai', note: '',
        reviewed: n % 7 === 0 ? { by: 'jdoe', at } : null, updated: marked,
        updatedWhy: marked ? WHY[n % WHY.length] : '', ...(open ? {} : { closedAt: at }) } });
      add.push({ kind: 'finding', id: fid }); n++;
    }
    await repo.transaction({ writes, index: { dealId, add } });
  }, [id, POOL, SUBJ, WHY]);
  await page.goto(`${URL}#deal-${id}`);
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length > 50, null, { timeout: 30000 });
  return { ctx, page, id };
}

// the list as shown: each heading with its count, the rows under it, whether each row is marked, and its meta line
const read = (page) => page.evaluate(() => {
  const groups = []; for (const el of document.querySelectorAll('.flags > *')) {
    if (el.classList.contains('fgroup')) groups.push({ head: el.firstChild.textContent, n: +el.querySelector('span').textContent, role: el.getAttribute('role'), level: el.getAttribute('aria-level'), label: el.getAttribute('aria-label'), rows: [] });
    else if (el.classList.contains('flagrow')) groups.at(-1)?.rows.push({ marked: !!el.querySelector('.upd'), meta: el.querySelector('.fm').textContent, title: el.querySelector('.ft').textContent });
  }
  return { groups, rows: document.querySelectorAll('.flagrow').length, first: document.querySelector('.flags > *')?.classList.contains('fgroup') };
});

// The 120 findings are written once; each size and color scheme after the first reloads the same page (#97).
const { ctx, page, id } = await setup(1280, 736, 'dark');
/** What the list starts from: the stored findings, and the rows as shown, in order, with their marks. */
const startState = () => page.evaluate(() => {
  const findings = Object.values(store.get().findings);
  const rows = [...document.querySelectorAll('.flagrow')];
  return {
    findings: findings.length, closed: findings.filter((f) => f.status === 'closed').length,
    reviewed: findings.filter((f) => f.reviewed).length, rows: rows.length,
    groups: document.querySelectorAll('.fgroup').length, marked: document.querySelectorAll('.flagrow .upd').length,
    order: rows.map((r) => r.getAttribute('href')).join(' '),
  };
});
// the stored data right after setup, put back before each reload so one size's clicks cannot reach the next
const stored = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
const first = await startState();
/** Puts back the stored data from setup, then reloads the page at this size and scheme. */
async function reloadAs(w, h, scheme) {
  await page.setViewportSize({ width: w, height: h });
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto(`${URL}#deal-${id}`);
  await page.evaluate((saved) => {
    localStorage.clear();
    sessionStorage.clear();
    for (const [k, v] of Object.entries(saved.local)) localStorage.setItem(k, v);
    for (const [k, v] of Object.entries(saved.session)) sessionStorage.setItem(k, v);
  }, stored);
  page.errors = [];   // this load's errors count from here; the first size keeps the errors from setup
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length > 50, null, { timeout: 30000 });
}
for (const [w, h] of [[1280, 736], [1024, 640]]) for (const scheme of ['dark', 'light']) {
  if (w !== 1280 || scheme !== 'dark') await reloadAs(w, h, scheme);
  const T = `${w}-${scheme}:`;
  const start = await startState();
  say(`${T} the list starts from the same 120 findings, 90 open under 9 headings, in the same order and marks`,
    start.findings === 120 && start.rows === 90 && start.groups === 9 && JSON.stringify(start) === JSON.stringify(first),
    JSON.stringify({ ...start, order: start.order === first.order }));
  const open = await read(page);
  const heads = open.groups.map((g) => g.head);
  say(`${T} one heading per workstream, A to Z, then none`, JSON.stringify(heads) === JSON.stringify(ORDER) && open.first, JSON.stringify(heads));
  say(`${T} each heading counts the rows under it, and every open finding is under one`, open.groups.every((g) => g.n === g.rows.length) && open.rows === 90 && open.groups.reduce((a, g) => a + g.n, 0) === 90, JSON.stringify(open.groups.map((g) => [g.head, g.n, g.rows.length])));
  say(`${T} marked findings lead their group`, open.groups.every((g) => g.rows.findIndex((r) => !r.marked) === -1 || g.rows.slice(g.rows.findIndex((r) => !r.marked)).every((r) => !r.marked)) && open.groups.some((g) => g.rows[0]?.marked), JSON.stringify(open.groups.map((g) => g.rows.map((r) => +r.marked).join(''))));
  say(`${T} headings are headings for a screen reader, and each row still names its workstream`, open.groups.every((g) => g.role === 'heading' && g.level === '3' && g.label === `${g.head}, ${g.n}`) && open.groups.filter((g) => g.head !== 'No workstream').every((g) => g.rows.every((r) => r.meta.startsWith(g.head + ' · '))), JSON.stringify(open.groups[0].rows[0]));
  if (SHOTS) await page.waitForTimeout(1500);   // the rows' entry animation
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-open-grouped-${scheme}-${w}x${h}.png` });
  // further down the list: where one group ends and the next begins
  await page.evaluate(() => { const box = document.querySelector('.flags'); const hd = [...document.querySelectorAll('.fgroup')][3]; box.scrollTop = hd.offsetTop - box.offsetTop - 140; });
  await page.waitForTimeout(300);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-open-scrolled-${scheme}-${w}x${h}.png` });
  // All: open and closed together, still one heading per workstream
  await page.evaluate(() => document.querySelector('.flags').scrollTop = 0);
  await page.click('[data-fstatusf="all"]'); await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 120);
  const all = await read(page);
  say(`${T} All keeps the grouping, 120 under the same headings`, JSON.stringify(all.groups.map((g) => g.head)) === JSON.stringify(ORDER) && all.groups.every((g) => g.n === g.rows.length) && all.rows === 120, JSON.stringify(all.groups.map((g) => [g.head, g.n])));
  if (SHOTS) await page.waitForTimeout(1000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/3-all-${scheme}-${w}x${h}.png` });
  // one workstream chosen in the filter menu: its heading alone, with the count of what is shown
  await page.click('[data-fstatusf="open"]').catch(async () => { await page.click('#f-filter'); await page.click('.fmenu [data-fstatusf="open"]'); await page.keyboard.press('Escape'); });
  await page.click('#f-filter');
  const opts = await page.$$eval('.fmenu [aria-label="Workstream"] label', (els) => els.map((o) => o.textContent));
  say(`${T} the workstream filter lists the headings in their order, No workstream last`, JSON.stringify(opts) === JSON.stringify(['All Workstreams', ...ORDER]), JSON.stringify(opts));
  await page.click(`.fmenu label:has(input[name="f-ws"][value="Legal"])`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.fgroup').length === 1);
  const legal = await read(page);
  say(`${T} a workstream filter shows that one heading with its count`, legal.groups.length === 1 && legal.groups[0].head === 'Legal' && legal.groups[0].n === legal.rows && legal.rows > 5, JSON.stringify(legal.groups.map((g) => [g.head, g.n, legal.rows])));
  // Export, opened from the filtered list, holds what the list shows: for a workstream, and for "No workstream"
  for (const ws of ['Legal', 'No workstream']) {
    await page.click('#f-filter');
    await page.click(`.fmenu label:has(input[name="f-ws"][value="${ws}"])`);
    await page.keyboard.press('Escape');
    await page.waitForFunction((w) => document.querySelector('.fgroup')?.firstChild.textContent === w && document.querySelectorAll('.fgroup').length === 1, ws);
    const shown = await page.evaluate(() => document.querySelectorAll('.flagrow').length);
    await page.click('#f-more'); await page.click('#f-export'); await page.waitForSelector('#fx-count');
    const x = await page.evaluate(() => ({ ws: document.getElementById('fx-ws').value, count: document.getElementById('fx-count').textContent, off: document.getElementById('fx-go').disabled }));
    say(`${T} Export from the "${ws}" filter holds the ${shown} findings the list shows`, x.ws === ws && x.count === `${shown} findings` && !x.off, JSON.stringify({ shown, x }));
    await page.keyboard.press('Escape'); await page.waitForSelector('#fx-count', { state: 'detached' });
  }
  await page.click('#f-filter');
  await page.click(`.fmenu label:has(input[name="f-ws"][value="Legal"])`);
  await page.keyboard.press('Escape');
  await page.click('#f-filter');
  await page.click(`.fmenu label:has(input[name="f-ws"][value=""])`);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.fgroup').length === 9);
  if (w === 1280 && scheme === 'dark') {
    // the queue beside an open finding steps in the list's order: from the last finding of the group before Legal, Next is the first Legal one
    const ids = await page.evaluate(() => [...document.querySelectorAll('.flags > *')].map((el) => el.classList.contains('fgroup') ? '#' + el.firstChild.textContent : el.getAttribute('href')));
    const lastBefore = ids[ids.indexOf('#Legal') - 1]; const firstLegal = ids[ids.indexOf('#Legal') + 1];
    await page.goto(URL + lastBefore); await page.waitForSelector('[data-qstep="1"]'); await page.click('[data-qstep="1"]');
    await page.waitForFunction((h) => location.hash === h, firstLegal, { timeout: 5000 }).catch(() => {});
    const at = await page.evaluate(() => location.hash);
    say('the queue steps from the last finding of one workstream to the first of the next', at === firstLegal, JSON.stringify({ from: lastBefore, want: firstLegal, at }));
    // the queue keeps exactly one stop for Tab: after arrows and then Next, and after arrows, a search that hides that item, and clearing it
    const stops = () => page.evaluate(() => [...document.querySelectorAll('.qgrid .g')].filter((g) => g.tabIndex === 0).map((g) => g.title));
    const intoGrid = async () => { await page.evaluate(() => document.querySelector('.qgrid .g[tabindex="0"]').focus()); };
    await intoGrid(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); const afterArrows = await stops();
    const h0 = await page.evaluate(() => location.hash); await page.click('.qarrows [data-qstep="1"]'); await page.waitForFunction((h) => location.hash !== h, h0); const afterNext = await stops();
    await intoGrid(); await page.keyboard.press('ArrowDown'); const openTitle = await page.evaluate(() => document.querySelector('.qgrid .g.on').title);
    await page.fill('#qsearch', openTitle); await page.waitForTimeout(150); const searched = await stops();
    await page.fill('#qsearch', ''); await page.waitForTimeout(150); const cleared = await stops();
    say('the queue has one stop for Tab after arrows then Next, and after arrows, a search and clearing it', afterArrows.length === 1 && afterNext.length === 1 && searched.length === 1 && cleared.length === 1, JSON.stringify({ afterArrows, afterNext, searched, cleared }));
  }
  say(`${T} no errors on the page`, page.errors.length === 0, JSON.stringify(page.errors));
}
await ctx.close();

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
