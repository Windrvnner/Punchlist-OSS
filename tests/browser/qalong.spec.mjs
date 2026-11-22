// A Q&A list at the size of a real deal (up to 2,000 questions). Only the rows in view and a margin around them
// are drawn, so opening and stepping through questions stays quick; the columns keep their widths as the list scrolls, every
// row can be reached by scrolling and by keyboard, and the open question is always drawn.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { settled, trackSettle } from './settle.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const N = 2000;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } });
await trackSettle(ctx);
const page = await ctx.newPage();
page.errors = [];
page.on('pageerror', (error) => page.errors.push(error.message));
await page.goto(URL + '#'); await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
const id = await page.evaluate(async (N) => {
  const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
  await run('CreateDeal', { name: 'Long', folders: [] }); const dealId = Object.values(store.get().deals).find((d) => d.name.endsWith('Long')).id;
  // one row in five wraps onto a second line, and one party has a long name, as a real log has
  const rows = Array.from({ length: N }, (_, k) => ({ line: k + 2, n: k + 1, text: k % 5 ? `Question ${k + 1}: what is the position on item ${(k * 7919) % 10007}?` : `Question ${k + 1}: a longer question that wraps onto a second line in the table, about item ${(k * 7919) % 10007} of the legal review and its conditions precedent?`, response: k % 3 ? `Answer ${k + 1}` : '', askedBy: k === 1500 ? 'A party with a much longer name' : k % 2 ? 'Lender A' : 'Bidder C', received: '', workstream: '', priority: 'High', respondedBy: '', responded: '', status: '' }));
  await run('ImportQuestions', { dealId, mode: 'append', rows }); store.ui({ toasts: [] }); return dealId;
}, N);
await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li'); await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' } })); await page.waitForTimeout(400);
const drawn = () => page.$$eval('.md .li:not(.vsize)', (l) => l.length);
const cols = () => page.evaluate(() => [...document.querySelector('.md .li:not(.vsize)').children].map((c) => Math.round(c.getBoundingClientRect().left)).join(','));
const inView = () => page.evaluate(() => { const l = document.querySelector('.md .list'); const b = l.getBoundingClientRect(); const v = [...l.querySelectorAll('.li:not(.vsize)')].filter((r) => { const x = r.getBoundingClientRect(); return x.bottom > b.top + 30 && x.top < b.bottom; }).map((r) => +r.querySelector('.n').textContent); return v; });
const scrollTo = async (f) => { await page.evaluate((f) => { const l = document.querySelector('.md .list'); l.scrollTop = (l.scrollHeight - l.clientHeight) * f; }, f); await page.waitForTimeout(250); };
say('draws-only-the-rows-near-the-view', (await drawn()) < 150, `${await drawn()} of ${N}`);
const top = await cols(); const seen = {};
for (const f of [0.5, 1]) { await scrollTo(f); seen[f] = await inView(); }
say('the-middle-of-the-list-shows-its-middle-rows', seen[0.5].length > 3 && Math.abs(seen[0.5][0] - N / 2) < 60, JSON.stringify(seen[0.5]));
say('the-end-of-the-list-shows-its-last-row', seen[1].includes(N), JSON.stringify(seen[1]));
say('columns-keep-their-widths-as-it-scrolls', (await cols()) === top, `${top} / ${await cols()}`);
await scrollTo(0); let blank = 0; await page.mouse.move(800, 600);
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(30); if (!(await inView()).length) blank++; }
say('wheeling-through-never-shows-an-empty-list', blank === 0, `${blank} empty`);
// filtered and cleared while scrolled down: the list still shows rows
await scrollTo(1); await page.fill('input[aria-label="Filter questions"]', 'Question 19'); await page.waitForTimeout(250); await scrollTo(0.3);   // 111 rows: drawn in full; then somewhere in them
const filtered = await inView(); await page.fill('input[aria-label="Filter questions"]', ''); await page.waitForTimeout(400);
const cleared = await inView();
say('a-filter-set-and-cleared-while-scrolled-still-shows-rows', filtered.length > 0 && cleared.length > 0, JSON.stringify({ filtered: filtered.slice(0, 3), cleared: cleared.slice(0, 3) }));
await scrollTo(0); await page.focus('.md .li[tabindex="0"]');
const focusN = () => page.evaluate(() => document.activeElement?.querySelector?.('.n')?.textContent);
await page.keyboard.press('End'); await page.waitForTimeout(150); const end = await focusN();
await page.keyboard.press('Home'); await page.waitForTimeout(150); const home = await focusN();
say('end-and-home-reach-the-last-and-first-rows', end === String(N) && home === '1', JSON.stringify({ end, home }));
// opening a question and stepping on: timed, as the person would feel it (a frame after the key)
const timed = async (act) => { const t = await page.evaluate(() => performance.now()); await act(); await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))); return (await page.evaluate(() => performance.now())) - t; };
const open = await timed(() => page.keyboard.press('Enter'));
const steps = []; for (let i = 0; i < 5; i++) steps.push(await timed(() => page.keyboard.press('ArrowDown')));
const at = await page.evaluate(() => document.querySelector('.md .li.on .n')?.textContent);
say('the-open-question-is-drawn-as-the-arrows-step', at === '6', at);
const step = steps.sort((a, b) => a - b)[2];
say('opening-and-stepping-stay-quick-at-2000-questions', open < 200 && step < 120, `open ${Math.round(open)} ms, step ${Math.round(step)} ms`);
await page.keyboard.press('End'); await page.waitForTimeout(200);
say('the-open-question-far-down-is-drawn-and-shown', (await page.evaluate(() => document.querySelector('.md .li.on .n')?.textContent)) === String(N));
say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
// the controls stay on one row at every window width with four-digit counts, in every state of Draft all. The widths are
// the narrowest window and those just either side of the point where the long labels come back; the counts are this deal's and
// the widest mix a 2,000-question deal can show (the segment labels' text is rewritten in place, as only their width matters here)
await page.keyboard.press('Escape');
const oneRow = () => page.evaluate(() => { const t = document.querySelector('.trk-tools'); const b = t.getBoundingClientRect(); const kids = [...t.children].map((e) => e.getBoundingClientRect()); const one = new Set(kids.map((k) => Math.round(k.top + k.height / 2))).size === 1 && kids.every((k) => k.right <= b.right + 0.5);
  // the Filter keeps room for a typed word in every state: Draft all's longer labels take their room from the select first
  const filter = Math.round(t.querySelector('input.field').getBoundingClientRect().width); if (filter < 100) window.__squeezed.push(`${innerWidth} ${filter}px`); return one; });
const widest = () => page.evaluate(() => { const l = ['Open 1100', 'Answered 800', 'Closed 100']; window.__segWas = []; document.querySelectorAll('.trk-tools .seg button').forEach((b, i) => { if (l[i] && b.firstChild) { window.__segWas[i] = b.firstChild.nodeValue; b.firstChild.nodeValue = l[i]; } }); });
// the app does not set the text again while the counts stay the same, so the deal's own labels are put back after each check
const restore = () => page.evaluate(() => { document.querySelectorAll('.trk-tools .seg button').forEach((b, i) => { if (window.__segWas?.[i] != null && b.firstChild) b.firstChild.nodeValue = window.__segWas[i]; }); window.__segWas = []; });
const wrapped = []; await page.evaluate(() => { window.__squeezed = []; });
for (const w of [1024, 1240, 1256, 1262, 1536]) {
  await page.setViewportSize({ width: w, height: 640 }); await page.waitForTimeout(250);
  for (const counts of ['deal', 'widest']) {
    const states = { rest: () => {},
      workstream: () => page.evaluate(() => store.ui({ qaFilter: { ...store.get().ui.qaFilter,
      workstream: 'Environmental & social' } })), confirm: () => page.click('#qa-draftall') };
    for (const [name, set] of Object.entries(states)) {
      await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' }, confirmDraftAll: false, batch: null })); await page.waitForTimeout(100);
      await set(); await page.waitForTimeout(100); if (counts === 'widest') await widest();
      if (!(await oneRow())) wrapped.push(`${w} ${counts} ${name}`); await restore();
    }
    for (const stopping of [false, true]) {
      await page.evaluate(([d, stopping]) => store.ui({ confirmDraftAll: false, batch: { dealId: d, done: 1999, total: 2000, stopping } }), [id, stopping]); await page.waitForTimeout(100); if (counts === 'widest') await widest();
      if (!(await oneRow())) wrapped.push(`${w} ${counts} ${stopping ? 'stopping' : 'drafting'}`); await restore();
    }
  }
}
await page.evaluate(() => store.ui({ batch: null, confirmDraftAll: false }));
await page.setViewportSize({ width: 1024, height: 640 }); await page.waitForTimeout(250);
// with a long workstream chosen, its name on the filter button gives way and the Filter keeps its room
//
await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: 'Environmental & social', text: '' } }));
await page.waitForTimeout(150);
const narrow = await page.evaluate(() => ({
  filter: Math.round(document.querySelector('.trk-tools input.field').getBoundingClientRect().width),
  button: Math.round(document.querySelector('#qa-ws').getBoundingClientRect().width) }));
const roomKept = narrow.filter >= 100 && narrow.button <= 150;
say('at-1024-the-filter-keeps-the-room-the-workstream-button-does-not-need', roomKept, JSON.stringify(narrow));
say('the-controls-stay-on-one-row-at-every-width', wrapped.length === 0, JSON.stringify(wrapped));
const squeezed = await page.evaluate(() => window.__squeezed);
say('the-filter-keeps-at-least-100px-in-every-state', squeezed.length === 0, JSON.stringify(squeezed));
// Scrolling down tucks the deal's header row away and the list takes its height; scrolling up brings it back. The trail, ask
// box, controls and column heads stay, each head over its column (#593 design C). Not while the header has the focus.
await page.setViewportSize({ width: 1280, height: 736 }); await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' }, selectedQuestion: null })); await page.waitForTimeout(300);
await page.evaluate(() => { document.querySelector('.md .list').scrollTop = 0; }); await page.waitForTimeout(500);
const look = () => page.evaluate(() => { const l = document.querySelector('.md .list'); const lb = l.getBoundingClientRect(); const vis = (s) => { const e = document.querySelector(s); if (!e) return false; const b = e.getBoundingClientRect(); return getComputedStyle(e).visibility !== 'hidden' && b.height > 2 && b.bottom > 0; };
  const row = [...l.querySelectorAll('.li:not(.vsize)')].find((r) => r.getBoundingClientRect().top >= lb.top - 1);
  const heads = [...document.querySelectorAll('.lhout span')].map((e) => Math.round(e.getBoundingClientRect().left)); const cells = [...row.children].map((e) => Math.round(e.getBoundingClientRect().left));
  return { tucked: document.querySelector('.home').classList.contains('tuck'), header: vis('.headrow'), ask: vis('.askslot .askbox'), tools: vis('.trk-tools'), heads: vis('.lhout'), aligned: heads.length === cells.length && heads.every((x, k) => x === cells[k]), listH: Math.round(lb.height), bottom: Math.round(lb.bottom),
    gaps: [['.trail', '.headrow'], ['.headrow', '.askslot .askbox'], ['.askslot .askbox', '.trk-tools']].map(([a, b]) => Math.round(document.querySelector(b).getBoundingClientRect().top - document.querySelector(a).getBoundingClientRect().bottom)) }; });
const atRest = await look();
// at rest the page is laid out as before the tuck: the gaps between the trail, header row, ask box and controls are the deal pages' own
// and the rows sit where they did under the heads in the list: the second row's top 98.1px below the controls, as on main
const rowGap = await page.evaluate(() => +([...document.querySelectorAll('.md .li:not(.vsize)')][1].getBoundingClientRect().top - document.querySelector('.trk-tools').getBoundingClientRect().bottom).toFixed(1));
say('at-rest-nothing-has-moved', JSON.stringify(atRest.gaps) === '[8,14,26]' && Math.abs(rowGap - 98.1) < 0.3, JSON.stringify({ gaps: atRest.gaps, rowGap }));
await page.mouse.move(700, 600); for (let k = 0; k < 3; k++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(150); } await page.waitForTimeout(600);
const down = await look();
await page.mouse.wheel(0, -200);
await page.waitForFunction(() => !document.querySelector('.home').classList.contains('tuck'));
await settled(page);
const up = await look();
say('scrolling-down-tucks-the-header-and-the-list-takes-its-height', !atRest.tucked && atRest.header && down.tucked && !down.header && down.ask && down.tools && down.heads && down.listH > atRest.listH + 40 && down.bottom <= 736, JSON.stringify({ atRest, down }));
say('scrolling-up-brings-the-header-back', !up.tucked && up.header && up.listH === atRest.listH, JSON.stringify(up));
say('the-column-heads-sit-over-their-columns-as-it-scrolls', atRest.aligned && down.aligned && up.aligned, JSON.stringify([atRest.aligned, down.aligned, up.aligned]));
await page.focus('#deal-group'); await page.mouse.wheel(0, 600); await page.waitForTimeout(600); const focused = await look();
say('the-header-stays-while-it-has-the-focus', !focused.tucked && focused.header, JSON.stringify(focused));
await page.mouse.wheel(0, -100000); await page.waitForTimeout(700); const atTop = await look();
say('the-header-is-back-at-the-top', !atTop.tucked && atTop.header, JSON.stringify(atTop));
// a slow scroll in small steps, as on a trackpad, adds up: 2px at a time down tucks it, 4px at a time up brings it back
await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(700, 600);
for (let k = 0; k < 40; k++) { await page.mouse.wheel(0, 2); await page.waitForTimeout(16); } await page.waitForTimeout(600); const slowDown = await look();
await page.mouse.wheel(0, 900); await page.waitForTimeout(700);
for (let k = 0; k < 10; k++) { await page.mouse.wheel(0, -4); await page.waitForTimeout(16); } await page.waitForTimeout(600); const slowUp = await look();
say('a-slow-scroll-in-small-steps-tucks-and-untucks', slowDown.tucked && !slowUp.tucked, JSON.stringify({ slowDown: slowDown.tucked, slowUp: slowUp.tucked }));
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
