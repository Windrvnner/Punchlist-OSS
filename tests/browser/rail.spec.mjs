// The slim rail beside a finding or a question at the size of a real deal: the queue strip of ticks keeps to
// its own space and never runs on behind Search and Settings below it, folded or open, in both themes and at both window
// sizes, from a few items up to 2,000. Open, the list runs on to the arrows and the two buttons step aside.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, String(note).slice(0, 300)); };
const browser = await launchChrome();
openOnFindings(browser);

// One deal with 300 findings and 2,000 questions, and one with 3 findings; made once, then opened at each size and theme.
async function seed(page) {
  return page.evaluate(async () => {
    const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
    const make = async (name) => { await run('CreateDeal', { name, folders: [] }); return Object.values(store.get().deals).find((d) => d.name.endsWith(name)).id; };
    const big = await make('Long'); const small = await make('Short');
    for (let k = 0; k < 300; k++) await run('CreateFinding', { dealId: big, title: `Finding ${k + 1}: the operating assumption in schedule ${k + 1} differs`, workstream: 'Technical' });
    for (let k = 0; k < 3; k++) await run('CreateFinding', { dealId: small, title: `Finding ${k + 1}`, workstream: 'Technical' });
    const rows = Array.from({ length: 2000 }, (_, k) => ({ line: k + 2, n: k + 1, text: `Question ${k + 1}: what is the position on item ${k + 1}?`, response: '', askedBy: 'Lender A', received: '', workstream: '', priority: 'High', respondedBy: '', responded: '', status: '' }));
    await run('ImportQuestions', { dealId: big, mode: 'append', rows }); store.ui({ toasts: [] });
    // findings in the list's order (dealFindings: newest first), questions by number
    const s = store.get(); const fs = (d) => Object.values(s.findings).filter((f) => f.dealId === d).sort((a, b) => b.raisedAt.localeCompare(a.raisedAt) || a.id.localeCompare(b.id)).map((f) => f.id); const qs = Object.values(s.questions).filter((q) => q.dealId === big).sort((a, b) => a.n - b.n).map((q) => q.id);
    return { big, small, bigF: fs(big), smallF: fs(small), qs };
  });
}

// The strip's box against Home above it and the buttons below it, and how many of its ticks are drawn inside that box
// (the box scrolls and clips its ticks, so the box is what must stay clear; the count shows the ticks are really there).
const measure = (page) => page.evaluate(() => {
  const r = (el) => el.getBoundingClientRect(); const grid = document.querySelector('.qgrid'); const g = r(grid);
  const shown = [...grid.querySelectorAll('.g i')].map(r).filter((b) => b.height > 0 && b.bottom > g.top && b.top < g.bottom).length;
  return { gridTop: Math.round(g.top), gridBottom: Math.round(g.bottom), homeBottom: Math.round(r(document.querySelector('.qhome')).bottom), toolsTop: Math.round(r(document.querySelector('.rtools')).top), shown, cnt: document.querySelector('.qcnt').textContent };
});
const clear = (m) => m.gridTop >= m.homeBottom && m.gridBottom <= m.toolsTop && m.shown > 0;

const ctx0 = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const p0 = await ctx0.newPage();
await p0.goto(URL + '#'); await p0.waitForFunction(() => window.store?.get().boot.stage === 'ready');
const ids = await seed(p0); await p0.close();
// the records live in the stand-in shared folder of this browser context, so each size and theme reuses it through new pages
for (const [w, h] of [[1280, 736], [1024, 640]]) for (const scheme of ['dark', 'light']) {
  const page = await ctx0.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.setViewportSize({ width: w, height: h }); await page.emulateMedia({ colorScheme: scheme });
  const at = `${scheme}-${w}x${h}`;
  const open = async (hash) => { await page.goto(URL + '#' + hash); await page.waitForSelector('#qstrip .g.on'); await page.mouse.move(w - 100, h / 2); await page.waitForTimeout(700); };
  for (const [what, hash, n] of [
    ['300-findings-middle', `finding-${ids.big}-${ids.bigF[150]}`, 300], ['300-findings-last', `finding-${ids.big}-${ids.bigF[299]}`, 300], ['300-findings-first', `finding-${ids.big}-${ids.bigF[0]}`, 300],
    ['2000-questions-middle', `q-${ids.big}-${ids.qs[1000]}`, 2000], ['2000-questions-last', `q-${ids.big}-${ids.qs[1999]}`, 2000], ['2000-questions-first', `q-${ids.big}-${ids.qs[0]}`, 2000],
    ['3-findings', `finding-${ids.small}-${ids.smallF[1]}`, 3],
  ]) {
    await open(hash); const m = await measure(page);
    say(`${at}:${what}:strip-stays-clear-of-search-and-settings`, clear(m) && m.cnt.endsWith(`/${n}`), JSON.stringify(m));
  }
  // Open (hovered), the list runs on down to the arrows: Search and Settings fade out of its way and let the pointer through to it
  await open(`q-${ids.big}-${ids.qs[1999]}`); const gb = await page.evaluate(() => { const b = document.querySelector('.qgrid').getBoundingClientRect(); return [b.left + 28, b.top + 30]; }); await page.mouse.move(gb[0], gb[1]); await page.waitForFunction(() => document.body.classList.contains('qopen')); await page.waitForTimeout(500);
  const o = await page.evaluate(() => {
    const r = (el) => el.getBoundingClientRect(); const grid = document.querySelector('.qgrid'); const g = r(grid); const b = r(document.getElementById('rt-settings'));
    const rows = [...grid.querySelectorAll('.g')].map(r).filter((x) => x.bottom > g.top && x.top < g.bottom).length;
    const under = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { gridBottom: Math.round(g.bottom), arrowsTop: Math.round(r(document.querySelector('.qarrows')).top), rows, toolsOpacity: getComputedStyle(document.querySelector('.rtools')).opacity, pointerReachesQueue: !!under?.closest('#qstrip') };
  });
  say(`${at}:open-queue-runs-to-the-arrows-and-search-and-settings-step-aside`, o.gridBottom <= o.arrowsTop && o.gridBottom > o.arrowsTop - 40 && o.rows > 12 && o.toolsOpacity === '0' && o.pointerReachesQueue, JSON.stringify(o));
  // by keyboard they are still there: Shift Tab from the queue lands on Settings, the queue folds and they show again
  await page.mouse.move(w - 100, h / 2); await page.waitForFunction(() => !document.body.classList.contains('qopen')); await page.focus('#rt-settings'); await page.keyboard.press('Tab'); await page.waitForFunction(() => document.body.classList.contains('qopen'));
  await page.keyboard.press('Shift+Tab'); await page.waitForTimeout(400);
  const k = await page.evaluate(() => ({ at: document.activeElement?.id, open: document.body.classList.contains('qopen'), toolsOpacity: getComputedStyle(document.querySelector('.rtools')).opacity }));
  say(`${at}:shift-tab-from-the-open-queue-reaches-settings-and-shows-it`, k.at === 'rt-settings' && !k.open && k.toolsOpacity === '1', JSON.stringify(k));
  say(`${at}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await page.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
