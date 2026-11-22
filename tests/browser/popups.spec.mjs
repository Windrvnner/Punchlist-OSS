// Popups over the page (design.md, Glass → Popup glass): menus sit in the top layer over the popup backdrop. A press
// on the backdrop closes the menu and reaches nothing under it; Escape closes it; a press on the backdrop never closes a
// dialog; hover popovers and search results have no backdrop.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
// is the popup in the top layer, is a backdrop under it, and is that backdrop drawn (a menu's never is)
const state = (sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const shield = document.querySelector('.popshield:popover-open');
  const look = shield && getComputedStyle(shield);
  return {
    top: el.matches(':popover-open'),
    lift: el.dataset.lift || '',
    shield: !!shield,
    dim: !!look && look.backgroundColor !== 'rgba(0, 0, 0, 0)',
    blur: look?.backdropFilter ?? 'none',
  };
}, sel);
const gone = (sel) => page.waitForFunction((sel) => !document.querySelector(sel), sel, { timeout: 3000 }).then(() => true, () => false);
// a menu: in the top layer over a clear backdrop (no dim, no blur); a press on the backdrop, over `under`, closes it
// and does not press `under`
const menu = async (name, open, sel, under) => {
  await open(); await page.waitForSelector(sel); await page.waitForTimeout(250);
  const s = await state(sel);
  const backdropOk = !!s && s.top && s.lift === 'menu' && s.shield && !s.dim && s.blur === 'none';
  say(`${name}-on-top-with-backdrop`, backdropOk, JSON.stringify(s));
  const b = await page.locator(under).first().boundingBox(); const seen = () => page.evaluate(() => [document.querySelectorAll('.scrim').length, location.hash, document.querySelector('.md .li[aria-selected="true"]')?.textContent ?? '']); const before = await seen();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); const closed = await gone(sel); await page.waitForTimeout(300);
  const after = await seen();
  say(`${name}-backdrop-press-closes-and-reaches-nothing`, closed && JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ closed, before, after }));
  await open(); await page.waitForSelector(sel); await page.keyboard.press('Escape'); say(`${name}-escape-closes`, await gone(sel));
};
await page.goto(URL); await page.waitForSelector('#fr-new');
await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
// a hover popover: on top, with no backdrop
await page.click('.flagrow'); await page.waitForSelector('.opening .ref .rb'); await page.hover('.opening .ref .rb');
await page.waitForSelector('.pop', { state: 'visible' }); await page.waitForTimeout(350);
const pop = await state('.pop');
const popOk = !!pop && pop.top && pop.lift === 'bare' && !pop.shield;
say('source-popover-on-top-without-backdrop', popOk, JSON.stringify(pop));
await page.mouse.move(700, 700);
// Q&A: the More menu and a question's Workstream list
await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
await page.evaluate((dealId) => store.dispatch(store.commandNamed('ImportQuestions'), { dealId, mode: 'append', rows: Array.from({ length: 6 }, (_, i) => ({ n: null, text: `Question ${i + 1}`, askedBy: 'Lender A', received: '2026-11-02', workstream: 'Legal', priority: 'High', response: '', respondedBy: '', responded: '', status: '' })) }, { quiet: true }), id);
await page.waitForSelector('.md .li');
await menu('more-menu', () => page.click('#qa-cols'), '#colmenu', '#qa-add');
await page.click('.md .li >> nth=0'); await page.waitForSelector('.qpanel .qph'); await page.mouse.move(5, 730);
await menu('workstream-list', () => page.click('.qprops .qp >> nth=0'), '.stlist', '.md .li >> nth=3');
// an open list follows its button when the page moves under it: here the workstream grows, pushing Priority right
await page.click('.qpanel [aria-label="Priority"]'); await page.waitForSelector('#q-prlist'); await page.waitForTimeout(300);
const gap = () => page.evaluate(() => Math.round(document.getElementById('q-prlist').getBoundingClientRect().left - document.querySelector('.qpanel [aria-label="Priority"]').getBoundingClientRect().left));
const g0 = await gap(); await page.evaluate(() => { const q = store.get().questions[store.get().ui.selectedQuestion]; return store.dispatch(store.commandNamed('EditQuestionField'), { dealId: q.dealId, questionId: q.id, field: 'workstream', value: 'Commercial and Regulatory Affairs' }, { quiet: true }); });
await page.waitForTimeout(400); const g1 = await gap(); await page.keyboard.press('Escape');
say('open-list-follows-its-button', Math.abs(g0 - g1) <= 1, JSON.stringify({ g0, g1 }));
// a dialog: a press on its backdrop leaves it open
await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.imdlg'); await page.waitForTimeout(400);
const had = !!(await page.$('.imdlg')); await page.mouse.click(20, 400); await page.waitForTimeout(300); say('dialog-stays-on-backdrop-press', had && !!(await page.$('.imdlg')), JSON.stringify({ had }));
await page.keyboard.press('Escape'); await gone('.imdlg');
// search results: on top, no backdrop
await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.type('question'); await page.waitForSelector('#pal-drop'); await page.waitForTimeout(300);
const sd = await state('#pal-drop');
say('search-results-on-top-without-backdrop', !!sd && sd.top && sd.lift === 'bare' && !sd.shield, JSON.stringify(sd));
await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
// a finding's status menu, and the model menu in the composer
await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); await page.click('.flagrow'); await page.waitForSelector('.opening');
await menu('status-menu', () => page.click('#f-status'), '.stmenu', '.opening');
await page.goto(URL + '#chat-' + id); await page.waitForSelector('#pask');
await menu('model-menu', () => page.click('#pcomposer .mwrap button'), '.mmenu', '#pask');
// and through a resize of the window
await page.click('#pcomposer .mwrap button'); await page.waitForSelector('.mmenu'); await page.waitForTimeout(300);
const mgap = () => page.evaluate(() => Math.round(document.querySelector('.mmenu').getBoundingClientRect().left - document.querySelector('#pcomposer .mwrap button').getBoundingClientRect().left));
const m0 = await mgap(); await page.setViewportSize({ width: 1024, height: 640 }); await page.waitForTimeout(400); const m1 = await mgap(); await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1280, height: 736 });
say('open-menu-follows-its-button-on-resize', Math.abs(m0 - m1) <= 1, JSON.stringify({ m0, m1 }));
// a notice shown while a menu is open stays above the menu's backdrop
await page.click('#pcomposer .mwrap button'); await page.waitForSelector('.mmenu'); await page.evaluate(() => store.toast('Saved')); await page.waitForSelector('#toast'); await page.waitForTimeout(300);
const n = await page.evaluate(() => { const t = document.getElementById('toast').getBoundingClientRect(); const e = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2); return !!e?.closest('#toast, .notices'); });
say('notice-above-menu-backdrop', n); await page.keyboard.press('Escape');
// a right press on the backdrop closes the menu, and the next key press on the menu's button still opens it
await page.click('#pcomposer .mwrap button'); await page.waitForSelector('.mmenu'); await page.mouse.click(700, 150, { button: 'right' }); const rclosed = await gone('.mmenu');
await page.focus('#pcomposer .mwrap button'); await page.keyboard.press('Enter'); const reopened = await page.waitForSelector('.mmenu', { timeout: 2000 }).then(() => true, () => false); await page.keyboard.press('Escape');
say('right-press-on-backdrop-leaves-the-keyboard-working', rclosed && reopened, JSON.stringify({ rclosed, reopened }));
// Past conversations opens upward from the composer and keeps its foot there as a search shortens it
for (let i = 0; i < 12; i++) { await page.goto(URL + '#overview-' + id); await page.waitForSelector('#hask'); await page.fill('#hask', `Conversation number ${i + 1} about the lease`); await page.press('#hask', 'Enter'); await page.waitForFunction(() => /-c[0-9a-z]+$/.test(location.hash)); }
await page.click('#p-past'); await page.waitForSelector('.pastpop'); await page.waitForTimeout(300);
const foot = () => page.evaluate(() => Math.round(document.querySelector('.pastpop').getBoundingClientRect().bottom));
const f0 = await foot(); await page.keyboard.type('number 3'); await page.waitForFunction(() => document.querySelectorAll('.pastpop .prow').length === 1, null, { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(300); const f1 = await foot();
say('past-conversations-keeps-its-foot-on-the-composer', Math.abs(f0 - f1) <= 1, JSON.stringify({ f0, f1 })); await page.keyboard.press('Escape');
say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
