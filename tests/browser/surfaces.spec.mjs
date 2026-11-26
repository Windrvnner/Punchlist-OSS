// Every popup, menu, dialog and floating bar must be readable over whatever is behind it:
// either close to opaque, or translucent with a backdrop blur that is really applied in the built CSS (popup glass: 12px, design.md).
import { launchChrome } from './chrome.mjs';
import { openDelete } from './dealMenu.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const SHOTS = process.env.SHOTS || '';
const probe = (page, sel) => page.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor); const p = m ? m[1].split(',').map((x) => parseFloat(x)) : [0, 0, 0, 0]; const alpha = p.length > 3 ? p[3] : 1; const r = el.getBoundingClientRect(); /* a backdrop blur only reaches the page if no ancestor makes its own backdrop: inside a blurred or filtered parent it blurs nothing */ let boxed = ''; /* a popup in the top layer has no ancestor there */ if (!el.matches(':popover-open')) for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) { const c = getComputedStyle(a); if (c.backdropFilter !== 'none' || c.filter !== 'none' || +c.opacity < 1 || c.mixBlendMode !== 'normal') { boxed = a.className || a.tagName; break; } } return { boxed, alpha: /gradient/.test(cs.backgroundImage) && alpha === 0 ? -1 : alpha, blur: (/blur\((\d+)px\)/.exec(cs.backdropFilter) || [0, 0])[1] | 0, opacity: +cs.opacity, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) }; }, sel);
for (const scheme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  const check = async (name, sel) => {
    // read the surface once its opening animation has played out, however busy the machine is
    await page.evaluate((sel) => Promise.all([...(document.querySelector(sel)?.getAnimations() ?? [])].map((a) => a.finished.catch(() => {}))), sel);
    const p = await probe(page, sel);
    const ok = !!p && p.w > 0 && p.opacity === 1 && (p.alpha >= 0.9 || p.alpha === -1 || (p.blur >= 12 && !p.boxed));
    say(`${scheme}:${name}`, ok, JSON.stringify(p));
    if (SHOTS && p) await page.screenshot({ path: `${SHOTS}/surf-${name}-${scheme}.png`, clip: { x: Math.max(0, p.x - 30), y: Math.max(0, p.y - 30), width: Math.min(1280 - Math.max(0, p.x - 30), p.w + 60), height: Math.min(736 - Math.max(0, p.y - 30), p.h + 60) } });
  };
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.waitForSelector('#nd-name'); await page.waitForTimeout(400); await check('new-deal-dialog', '.scrim .dlg');
  await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await check('rail', '.rail'); await check('deal-ask-box', '.askbox');
  // a citation's pop, on an open finding (Overview's summary, where it was checked before, is gone)
  await page.click('.flagrow'); await page.waitForSelector('.opening .ref .rb');
  await page.hover('.opening .ref .rb'); await page.waitForSelector('.pop', { state: 'visible' }); await page.waitForTimeout(350); await check('citation-pop', '.ref:hover .pop, .pop');
  await page.mouse.move(700, 700); await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow');
  await page.click('#f-more'); await page.click('#f-export'); await page.waitForSelector('.xdlg');
  await page.waitForTimeout(400); await check('export-findings-dialog', '.scrim .dlg');
  await page.keyboard.press('Escape');
  await openDelete(page);
  await page.waitForSelector('#dd-name');
  await page.waitForTimeout(400);
  await check('delete-deal-dialog', '.scrim .dlg');
  await page.keyboard.press('Escape');
  // Q&A: menus over a full list
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  await page.evaluate(async (dealId) => { const cmd = store.commandNamed('ImportQuestions'); await store.dispatch(cmd, { dealId, mode: 'append', rows: Array.from({ length: 14 }, (_, i) => ({ n: null, text: `Question ${i + 1}: please provide the executed copy of the agreement and any side letters`, askedBy: 'Lender ' + 'ABC'[i % 3], received: '', workstream: 'Legal', priority: 'High', response: '', respondedBy: '', responded: '', status: '' })) }, { quiet: true }); }, id);
  await page.waitForSelector('.md .li');
  await page.click('#qa-cols'); await page.waitForSelector('#colmenu'); await page.waitForTimeout(300); await check('more-menu', '#colmenu');
  await page.click('#qa-export'); await page.waitForSelector('.xdlg'); await page.waitForTimeout(400); await check('export-qa-dialog', '.scrim .dlg'); await page.keyboard.press('Escape');
  await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.imdlg'); await page.waitForTimeout(400); await check('import-dialog', '.scrim .dlg'); await page.keyboard.press('Escape');
  await page.click('#u-menu'); await page.waitForSelector('#s-theme'); await page.waitForTimeout(400); await check('settings-dialog', '.scrim .dlg'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.type('agree'); await page.waitForTimeout(400); await check('search-palette', '.palbox'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.evaluate(() => store.toast('Imported · 4 new · 0 updated', 'done'))
  await page.waitForSelector('#toast')
  await page.waitForTimeout(300)
  await check('toast', '#toast');
  await page.evaluate(() => { window.__down = true; }); await page.evaluate(() => store.refreshGaps(Object.keys(store.get().deals)[0])); await page.waitForSelector('.netbar', { timeout: 5000 }); await check('offline-bar', '.netbar'); await page.evaluate(() => { window.__down = false; return store.probeOnce(); });
  // a deal conversation with a long thread: composer and model menu over text
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('#pask');
  for (let i = 0; i < 3; i++) { await page.fill('#pask', 'What are the three biggest issues, in order, and which documents do they rest on?'); await page.press('#pask', 'Enter'); await page.waitForFunction((n) => document.querySelectorAll('.msgs .ai:not(.pending):not(.failed)').length === n, i + 1, { timeout: 8000 }); }
  await check('composer', '#pcomposer');
  await page.click('#pcomposer .mwrap button'); await page.waitForSelector('.mmenu'); await page.waitForTimeout(300); await check('model-menu', '.mmenu'); await page.keyboard.press('Escape'); await page.mouse.click(700, 200);
  // a finding: status menu, queue strip opened by hover, reading mode with its navigation and document menu
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); await page.click('.flagrow'); await page.waitForSelector('.opening');
  await page.click('#f-status'); await page.waitForSelector('.stmenu'); await page.waitForTimeout(300); await check('status-menu', '.stmenu'); await page.mouse.click(900, 600);
  await page.mouse.move(40, 300); await page.waitForFunction(() => document.body.classList.contains('qopen')); await page.waitForTimeout(600); await check('queue-open', '.rail');
  // the open queue's titles start where its header and search box do, and its count shows once
  const q = await page.evaluate(() => { const L = (e) => Math.round(e.getBoundingClientRect().left); const t = document.querySelector('#qstrip .g.on'); const r = document.createRange(); r.selectNodeContents([...t.querySelectorAll('*')].find((e) => e.childNodes[0]?.nodeType === 3 && e.textContent.trim())); return { head: L(document.querySelector('#qstrip .qhead')), title: Math.round(r.getBoundingClientRect().left), search: L(document.getElementById('qsearch')), cnt: getComputedStyle(document.querySelector('#qstrip .qcnt')).visibility }; });
  say(`${scheme}:queue-titles-line-up-and-count-once`, q.head === q.title && q.search === q.title && q.cnt === 'hidden', JSON.stringify(q)); await page.mouse.move(800, 300); await page.waitForFunction(() => !document.body.classList.contains('qopen'));
  await page.click('.opening .ref .rb'); await page.waitForSelector('#doc-close', { state: 'attached' }); await page.waitForTimeout(700);
  await page.hover('.opening .ref .rb'); await page.waitForSelector('.opening .ref:hover .pop', { state: 'visible' }); await page.waitForTimeout(350); await check('reading-citation-pop', '.opening .ref:hover .pop'); await page.mouse.move(800, 300);
  await check('reading-doc-nav', '.docnav');
  await check('reading-composer', '#pcomposer');
  await check('reading-conversation-column', '.reading-pane');
  await check('reading-conversation-header', '.reading-pane .chathead');
  // reading, the open queue leaves no strip of the conversation column or the composer showing past it
  await page.mouse.move(40, 300); await page.waitForFunction(() => document.body.classList.contains('qopen')); await page.waitForTimeout(400);
  const under = await page.evaluate(() => ['.reading-pane', '#pcomposer']
    .map((selector) => getComputedStyle(document.querySelector(selector)).maskImage));
  await page.evaluate(() => document.querySelector('#pcomposer textarea').focus()); await page.waitForTimeout(100);
  const typing = await page.evaluate(() => getComputedStyle(document.getElementById('pcomposer')).maskImage);   // a composer being typed in stays in view
  await page.evaluate(() => document.activeElement?.blur?.());
  say(`${scheme}:queue-over-reading-leaves-no-strip`, under.every((m) => m && m !== 'none') && typing === 'none', JSON.stringify({ under, typing }));
  await page.mouse.move(800, 300); await page.waitForFunction(() => !document.body.classList.contains('qopen'));
  await page.mouse.move(40, 300); await page.waitForFunction(() => document.body.classList.contains('qopen')); await page.waitForTimeout(600); await check('queue-open-while-reading', '.rail'); await page.mouse.move(800, 300); await page.waitForTimeout(400);
  await page.click('#doc-menu'); await page.waitForSelector('.docmenu'); await page.waitForTimeout(300); await check('document-menu', '.docmenu');
  say(`${scheme}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
