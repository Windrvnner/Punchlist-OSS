// Long and messy file names: always one line, start and end visible, full name in a tooltip,
// one slide through on hover or on open, and nothing else on the row pushed out or wrapped.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { ITEMS } from '../fixtures/pastedList.ts';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const SHOTS = process.env.SHOTS || '';
const BASE = '4.2.1.17 Project Proseware - Senior Credit Agreement (Execution Version) - Lenders Counsel Comments 2026-10-14 v7 ';
const A = BASE + 'CLEAN.pdf', B = BASE + 'REDLINE.pdf';
const HASH = 'a3f9c2e17b5d4406998e1f20c7b6aa51d0e4c2e17b5d4406998e1f20c7-FINAL-FINAL-v12(1).PDF';
const DIRTY = 'Direct agreement\r\n(lenders)\tSIGNED\u0000 copy - do not use - superseded by the version in folder 4.3.pdf';
const HUGE = 'Minutes ' + 'of the adjourned meeting of the board '.repeat(12) + 'final.docx';
/** waits until the reading bar's name has finished sliding (rejects after 6 s) */
const slideEnds = (page) => page.waitForFunction(() => !document.querySelector('.docnav .docnm.run'), null,
  { timeout: 6000 });
async function setup(w, h, scheme, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, ...extra }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  const [f1, f2] = await page.evaluate(async ([dealId, A, B, HASH, DIRTY, HUGE]) => {
    const now = new Date().toISOString(); const repo = store.services.repo; const ids = ['f_01HZZZZZZZZZZZZZZZZZZZZZZ8', 'f_01HZZZZZZZZZZZZZZZZZZZZZZ9'];
    const mk = (id, code, title, body, sources) => ({ id, dealId, rev: 0, createdAt: now, updatedAt: now, code, title,
      workstream: 'Legal', status: 'open', raisedAt: now, body, sources, origin: 'ai', note: '', reviewed: null,
      updated: false });
    await repo.transaction({ writes: [
      { kind: 'finding', id: ids[0], data: mk(ids[0], 'K-01', 'Lock-up ratio differs between the clean and redline drafts', ['The clean draft sets the lock-up at 1.25x. [1] The redline shows 1.30x struck through. [2]'], [{ doc: A, loc: 'p. 142', docId: 'doc_a' }, { doc: B, loc: 'p. 143', docId: 'doc_b' }]), expectedRev: null },
      { kind: 'finding', id: ids[1], data: mk(ids[1], 'K-02', 'Three files with names that are not clean', ['A scanned copy has no readable name. [1] A second has line breaks in its name. [2] A third has a very long one. [3]'], [{ doc: HASH, loc: 'p. 3', docId: 'doc_h' }, { doc: DIRTY, loc: 'p. 1', docId: 'doc_d' }, { doc: HUGE, loc: 'p. 12', docId: 'doc_x' }]), expectedRev: null },
    ], index: { dealId, add: ids.map((id) => ({ kind: 'finding', id })) } });
    localStorage.setItem('dil/mock/cached', JSON.stringify(['doc_a', 'doc_h'])); return ids;
  }, [id, A, B, HASH, DIRTY, HUGE]);
  return { ctx, page, id, f1, f2 };
}
const box = (page, sel) => page.evaluate((sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; }, sel);
// what a name looks like at rest: is the start cut with an ellipsis, is the end whole, is it one line
const nameState = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].map((el) => { const h = el.querySelector('.dnh'), t = el.querySelector('.dnt'), r = el.getBoundingClientRect(); const tr = t?.getBoundingClientRect(); return { cut: h.scrollWidth > h.clientWidth + 1, end: t?.textContent ?? '', endWhole: !t || (tr.right <= r.right + 1 && tr.width > 0), oneLine: r.height < 24, text: el.textContent, run: el.classList.contains('run') }; }), sel);

for (const [w, h] of [[1280, 736], [1024, 640]]) {
  const { ctx, page, id, f1, f2 } = await setup(w, h, 'light');
  const T = `${w}:`;
  // ---- the hover on a cited phrase
  await page.goto(`${URL}#finding-${id}-${f1}`); await page.reload(); await page.waitForSelector('.opening .ref .rb'); await page.waitForTimeout(400);
  await page.hover('.opening .ref .rb'); await page.waitForSelector('.opening .ref:hover .pop', { state: 'visible' }); await page.waitForTimeout(350);
  const pop = (await nameState(page, '.opening .ref:hover .pop .docnm'))[0];
  const popRow = await page.evaluate(() => { const p = document.querySelector('.opening .ref:hover .pop'); const i = p.querySelector('i.psrc'); const loc = i.querySelector('.loc').getBoundingClientRect(); const pr = p.getBoundingClientRect(); return { loc: i.querySelector('.loc').textContent, locInside: loc.right <= pr.right - 8, rowH: i.getBoundingClientRect().height, mark: !!i.querySelector('.cmark') }; });
  // the space where the name is split ends its start, so the end shown after "…" starts with the word itself
  say(T + 'hover-shows-start-and-end-on-one-line', pop.cut && pop.end === 'v7 CLEAN.pdf' && pop.endWhole && pop.oneLine && pop.text === A, JSON.stringify(pop));
  say(T + 'hover-keeps-the-page-number', popRow.loc === ' · p. 142' && popRow.locInside && popRow.rowH < 24 && popRow.mark, JSON.stringify(popRow));
  if (SHOTS && w === 1280) { const b = await box(page, '.opening .ref:hover .pop'); await page.screenshot({ path: `${SHOTS}/ln-pop-light.png`, clip: { x: b.x - 14, y: b.y - 34, width: b.w + 28, height: b.h + 48 } }); }
  // ---- reading bar: one line, under the page, clear of the conversation column; slides once on open
  await page.click('.opening .ref .rb'); await page.waitForSelector('#doc-close', { state: 'attached' });
  const ranOnOpen = await page.waitForSelector('.docnav .docnm.run', { timeout: 3000 }).then(() => true).catch(() => false);
  const endShown = await page.waitForFunction(() => { const el = document.querySelector('.docnav .docnm.run'); if (!el) return false; const i = el.querySelector('.dni').getBoundingClientRect(), r = el.getBoundingClientRect(); return i.right <= r.right + 1.5; }, null, { timeout: 5000 }).then(() => true).catch(() => false);
  const t0 = Date.now();
  await slideEnds(page).catch(() => {});
  const restAgain = (await nameState(page, '.docnav .docnm'))[0];
  say(T + 'reading-bar-slides-once-on-open-then-rests', ranOnOpen && endShown && !restAgain.run && restAgain.cut && restAgain.end === 'v7 CLEAN.pdf', JSON.stringify({ ranOnOpen, endShown, restAgain, settleMs: Date.now() - t0 }));
  await page.waitForTimeout(1500);
  say(T + 'it-does-not-start-again-by-itself', !(await page.$('.docnav .docnm.run')));
  const geo = await page.evaluate(() => { const nav = document.querySelector('.docnav').getBoundingClientRect(); const col = document.querySelector('#view .chat').getBoundingClientRect(); const comp = document.getElementById('pcomposer').getBoundingClientRect(); const q = (s) => document.querySelector('.docnav ' + s).getBoundingClientRect(); const hit = (s) => { const el = document.querySelector('.docnav ' + s); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el === top || el.contains(top); }; return { navH: Math.round(nav.height), left: Math.round(nav.left), right: Math.round(nav.right), colRight: Math.round(col.right), compRight: Math.round(comp.right), vw: innerWidth, locH: Math.round(q('.loc').height), cntH: Math.round(q('.cnt').height), prev: hit('#doc-prev'), next: hit('#doc-next'), close: hit('#doc-close') }; });
  say(T + 'reading-bar-one-line-clear-of-the-conversation', geo.navH <= 46 && geo.left >= geo.compRight && geo.right <= geo.vw - 8 && geo.locH < 22 && geo.cntH < 22 && geo.prev && geo.next && geo.close, JSON.stringify(geo));
  if (SHOTS && w === 1280) { const b = await box(page, '.docnav'); await page.screenshot({ path: `${SHOTS}/ln-nav-light.png`, clip: { x: b.x - 14, y: b.y - 12, width: b.w + 28, height: b.h + 24 } }); }
  // ---- hovering the name: tooltip with the full name, and one slide; leaving stops both
  await page.hover('.docnav .docnm'); await page.waitForSelector('.tip', { timeout: 2000 });
  // measured once it has lifted into place, not part-way through its entrance
  await page.waitForFunction(() => {
    const lifts = document.querySelector('.tip')?.getAnimations() ?? [];
    return lifts.every((lift) => lift.playState === 'finished');
  });
  const tip = await page.evaluate(() => { const t = document.querySelector('.tip'); const cs = getComputedStyle(t); const r = t.getBoundingClientRect(); const a = document.querySelector('.docnav .docnm').getBoundingClientRect(); const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor)[1].split(',').map(parseFloat); return { text: t.textContent, role: t.getAttribute('role'), alpha: m.length > 3 ? m[3] : 1, inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight, clearOfName: r.bottom <= a.top || r.top >= a.bottom, running: !!document.querySelector('.docnav .docnm.run') }; });
  say(T + 'hover-shows-the-full-name-in-a-tooltip', tip.text === A && tip.role === 'tooltip' && tip.alpha === 1 && tip.inside && tip.clearOfName && tip.running, JSON.stringify(tip));
  // the name holds still under the pointer through the slide and after it, so its tooltip stays
  const nameBox = () => page.evaluate(() => {
    const r = document.querySelector('.docnav .docnm').getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), tip: !!document.querySelector('.tip') };
  });
  const during = await nameBox();
  const ended = await slideEnds(page).then(() => true, () => false);
  const after = await nameBox();
  const still = ended && during.left === after.left && during.right === after.right && after.tip;
  say(T + 'the-name-stays-under-the-pointer', still, JSON.stringify({ ended, during, after }));
  if (SHOTS && w === 1280) { const b = await box(page, '.docnav'); const t = await box(page, '.tip'); await page.waitForTimeout(250); await page.screenshot({ path: `${SHOTS}/ln-tip-light.png`, clip: { x: Math.min(b.x, t.x) - 14, y: t.y - 12, width: Math.max(b.r, t.r) - Math.min(b.x, t.x) + 28, height: b.b - t.y + 24 } }); }
  await page.mouse.move(w / 2, 200); await page.waitForTimeout(150);
  say(T + 'leaving-stops-the-slide-and-the-tooltip', !(await page.$('.tip')) && !(await page.$('.docnav .docnm.run')));
  // ---- the document list: both drafts on one line each, and you can tell them apart
  await page.click('#doc-menu'); await page.waitForSelector('.docmenu');
  const menu = await nameState(page, '.docmenu .dm-r .docnm');
  const menuFit = await page.evaluate(() => { const m = document.querySelector('.docmenu').getBoundingClientRect(); return [...document.querySelectorAll('.docmenu .dm-r')].every((g) => g.getBoundingClientRect().right <= m.right && g.getBoundingClientRect().height < 36); });
  const centered = await page.evaluate(() => {
    const m = document.querySelector('.docmenu').getBoundingClientRect(),
      n = document.querySelector('.docnav').getBoundingClientRect();
    return {
      off: Math.round(Math.abs((m.left + m.right) / 2 - (n.left + n.right) / 2)),
      inside: m.left >= 0 && m.right <= innerWidth && m.top >= 0,
    };
  });
  say(
    T + 'document-list-centered-on-the-bar-and-on-screen',
    centered.off <= 2 && centered.inside,
    JSON.stringify(centered),
  );
  say(T + 'document-list-tells-the-two-drafts-apart', menu.length === 2 && menu.every((m) => m.cut && m.endWhole && m.oneLine) && menu[0].end === 'v7 CLEAN.pdf' && menu[1].end === 'v7 REDLINE.pdf' && menuFit, JSON.stringify(menu.map((m) => m.end)));
  if (SHOTS && w === 1280) { const b = await box(page, '.docmenu'); await page.screenshot({ path: `${SHOTS}/ln-menu-light.png`, clip: { x: b.x - 14, y: b.y - 12, width: b.w + 28, height: b.h + 24 } }); }
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.docpanel'));
  // ---- search
  await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.type('counsel'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button').length === 2);
  const hits = await nameState(page, '#pal-res .docnm');
  const rows = await page.evaluate(() => [...document.querySelectorAll('#pal-res button')].map((b) => { const r = b.getBoundingClientRect(); const wr = b.querySelector('.where').getBoundingClientRect(); return { h: Math.round(r.height), whereInside: wr.right <= r.right && wr.height < 24 }; }));
  say(T + 'search-rows-keep-each-line-to-one-line-and-distinguishable', hits.length === 2 && hits.every((m) => m.endWhole && m.oneLine) && hits[0].end !== hits[1].end && rows.every((r) => r.h <= 60 && r.whereInside), JSON.stringify({ hits: hits.map((x) => [x.cut, x.end]), rows }));
  if (SHOTS && w === 1280) { const b = await box(page, '.palbox'); await page.screenshot({ path: `${SHOTS}/ln-search-light.png`, clip: { x: b.x - 10, y: b.y - 10, width: b.w + 20, height: b.h + 20 } }); }
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // ---- names that are not clean
  await page.goto(`${URL}#finding-${id}-${f2}`); await page.waitForSelector('.opening .ref .rb'); await page.waitForTimeout(300);
  await page.click('.opening .ref .rb'); await page.waitForSelector('#doc-close', { state: 'attached' }); await page.waitForTimeout(400); await page.click('#doc-menu'); await page.waitForSelector('.docmenu');
  const dirty = await nameState(page, '.docmenu .dm-r .docnm');
  const dirtyFit = await page.evaluate(() => { const m = document.querySelector('.docmenu').getBoundingClientRect(); return [...document.querySelectorAll('.docmenu .dm-r')].every((g) => { const r = g.getBoundingClientRect(); return r.right <= m.right && r.height < 36; }) && m.right <= innerWidth && m.height < innerHeight; });
  say(T + 'no-word-break-keeps-last-18-characters', dirty[0].cut && dirty[0].end === HASH.slice(-18) && dirty[0].endWhole && dirty[0].oneLine, JSON.stringify(dirty[0]));
  say(T + 'line-breaks-and-control-characters-stay-on-one-line', dirty[1].oneLine && dirty[1].endWhole && !/[\r\n\t\u0000]/.test(dirty[1].text) && dirty[1].text.startsWith('Direct agreement (lenders) SIGNED'), JSON.stringify(dirty[1]));
  const dbg = await page.evaluate(() => { const m = document.querySelector('.docmenu').getBoundingClientRect(); return { menu: [Math.round(m.left), Math.round(m.right), Math.round(m.top), Math.round(m.height)], vw: innerWidth, vh: innerHeight, grps: [...document.querySelectorAll('.docmenu .dm-r')].map((g) => { const r = g.getBoundingClientRect(); return [Math.round(r.right), Math.round(r.height)]; }) }; });
  say(T + 'a-very-long-name-does-not-stretch-anything', dirty[2].oneLine && dirty[2].cut && dirty[2].endWhole && dirtyFit, JSON.stringify({ end: dirty[2].end, dirtyFit, dbg }));
  if (SHOTS && w === 1280) { const b = await box(page, '.docmenu'); await page.screenshot({ path: `${SHOTS}/ln-dirty-light.png`, clip: { x: b.x - 14, y: b.y - 12, width: b.w + 28, height: b.h + 24 } }); }
  // too long to slide through readably: no slide, the tooltip still has it, capped in height
  const huge = page.locator('.docmenu .dm-r .docnm').nth(2); await huge.hover(); await page.waitForSelector('.tip', { timeout: 2000 });
  const hugeTip = await page.evaluate(() => { const t = document.querySelector('.tip').getBoundingClientRect(); return { h: Math.round(t.height), inside: t.left >= 0 && t.right <= innerWidth && t.top >= 0 && t.bottom <= innerHeight, run: !!document.querySelectorAll('.docmenu .docnm.run').length }; });
  say(T + 'too-long-to-slide-shows-the-tooltip-only', hugeTip.h <= 130 && hugeTip.inside && !hugeTip.run, JSON.stringify(hugeTip));
  await page.keyboard.press('Escape');
  say(T + 'no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

// Windows set to show no animations: nothing slides, the tooltip still works
{ const { ctx, page, id, f1 } = await setup(1280, 736, 'dark', { reducedMotion: 'reduce' });
  await page.goto(`${URL}#finding-${id}-${f1}`); await page.reload(); await page.waitForSelector('.opening .ref .rb'); await page.waitForTimeout(300);
  await page.click('.opening .ref .rb'); await page.waitForSelector('#doc-close', { state: 'attached' }); await page.waitForTimeout(1500);
  const ranOnOpen = !!(await page.$('.docnav .docnm.run'));
  await page.hover('.docnav .docnm'); await page.waitForSelector('.tip', { timeout: 2000 }); await page.waitForTimeout(500);
  say('reduced-motion-no-slide-tooltip-still', !ranOnOpen && !(await page.$('.docnav .docnm.run')) && (await page.textContent('.tip')) === A);
  if (SHOTS) { const b = await box(page, '.docnav'); const t = await box(page, '.tip'); await page.screenshot({ path: `${SHOTS}/ln-tip-dark.png`, clip: { x: Math.min(b.x, t.x) - 14, y: t.y - 12, width: Math.max(b.r, t.r) - Math.min(b.x, t.x) + 28, height: b.b - t.y + 24 } }); await page.mouse.move(600, 200); await page.click('#doc-menu'); await page.waitForSelector('.docmenu'); const m = await box(page, '.docmenu'); await page.screenshot({ path: `${SHOTS}/ln-menu-dark.png`, clip: { x: m.x - 14, y: m.y - 12, width: m.w + 28, height: m.h + 24 } }); }
  await ctx.close(); }

{ // a deal named in Arabic keeps the start of its name when cut, and Hebrew or Arabic questions run right to left
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'مشروع الرياح البحرية الكبير في شمال البحر مع شركاء متعددين ومقرضين دوليين'); await page.click('#nd-create'); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.evaluate(async (d) => { await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'מה יחס הנעילה שהוסכם?', workstream: 'Legal' }); }, id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li .q');
  const q = await page.evaluate(() => Object.values(store.get().questions)[0].id); await page.evaluate((q) => store.ui({ selectedQuestion: q }), q); await page.waitForSelector('.qpanel textarea.qtext');
  const got = await page.evaluate(() => ({ title: getComputedStyle(document.querySelector('h1.ttl')).direction, rail: getComputedStyle(document.querySelector('.dealrow .dn1')).direction, cell: getComputedStyle(document.querySelector('.md .li .q')).direction, field: document.querySelector('.qpanel textarea.qtext').matches(':dir(rtl)'), box: document.querySelector('#pask, #hask')?.getAttribute('dir') }));
  say('right-to-left names and text', got.title === 'rtl' && got.rail === 'rtl' && got.cell === 'rtl' && got.field && page.errors.length === 0, JSON.stringify({ got, errors: page.errors }));
  await ctx.close(); }

{ // two deals of one name: a hit inside either says on its second line which it is in, first and whole (all of it
  // on hover); a question number or page stays whole at the right, and a long sheet cell shows whole or is left to the hover
  for (const [w, h] of [[1280, 736], [1024, 640]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
    await page.goto(URL); await page.waitForSelector('#fr-new');
    const made = await page.evaluate(async () => {
      const C = (n) => store.commandNamed(n); const ids = [];
      for (const counterparty of ['Northwind Capital Partners International', 'Tailwind Infrastructure']) { const before = new Set(Object.keys(store.get().deals)); await store.dispatch(C('CreateDeal'), { name: 'Proseware', folders: [], counterparty }, { quiet: true }); ids.push(Object.keys(store.get().deals).find((id) => !before.has(id))); }
      for (const dealId of ids) {
        for (let i = 1; i <= 2; i++) await store.dispatch(C('CreateQuestion'), { dealId, text: `Covenant compliance certificate for the quarter ending ${i}` }, { quiet: true });
        await store.dispatch(C('CreateFinding'), { dealId, title: 'Sources and uses do not tie', workstream: 'Financial', sources: [{ doc: 'Model.xlsx', docId: `m-${dealId}`, loc: 'Sources and Uses (Base Case)!$AB$1234' }] }, { quiet: true });
        await store.dispatch(C('CreateFinding'), { dealId, title: 'Downside case breaches the leverage test', workstream: 'Financial', sources: [{ doc: 'Proseware financial model for the senior facility refinancing, base and downside cases.xlsx', docId: `k-${dealId}`, loc: 'Sources and Uses (Base Case)!$AB$1234' }] }, { quiet: true });
      }
      // a question as long as real ones are, also in a deal with a name of its own
      const before = new Set(Object.keys(store.get().deals)); await store.dispatch(C('CreateDeal'), { name: 'Coho', folders: [] }, { quiet: true }); ids.push(Object.keys(store.get().deals).find((id) => !before.has(id)));
      // a long name shared by two deals, told apart by a short counterparty
      for (const counterparty of ['Oak', 'Elm']) { const b4 = new Set(Object.keys(store.get().deals)); await store.dispatch(C('CreateDeal'), { name: 'Northwind Capital Infrastructure Holdings Refinancing', folders: [], counterparty }, { quiet: true }); const dealId = Object.keys(store.get().deals).find((id) => !b4.has(id)); await store.dispatch(C('CreateQuestion'), { dealId, text: 'Zeta tranche pricing against the swap curve at financial close, with the margin ratchet and the hedging costs' }, { quiet: true }); await store.dispatch(C('CreateFinding'), { dealId, title: 'Zeta tranche is unhedged against rising base rates through to final maturity of the facility', workstream: 'Financial', sources: [{ doc: 'Zeta tranche hedging schedule, swap confirmations and the hedging letter from the arrangers.xlsx', docId: `z-${dealId}`, loc: 'Sources and Uses (Base Case)!$AB$1234' }] }, { quiet: true }); }
      // what tells two deals apart is short (a three-letter counterparty, or the day alone) beside a never-cut place
      for (const counterparty of ['QRS', 'XYZ', '', '', 'FABRIKAM ABC', 'Contoso Group', 'Fabrikam Infrastructure Partners Fund IV (Lux) SCSp']) { const b4 = new Set(Object.keys(store.get().deals)); await store.dispatch(C('CreateDeal'), { name: { '': 'Lamna Two', 'FABRIKAM ABC': 'Lamna', 'Contoso Group': 'Northwind Capital Infrastructure Holdings Refinancing', 'Fabrikam Infrastructure Partners Fund IV (Lux) SCSp': 'Northwind Capital Infrastructure Holdings Refinancing' }[counterparty] ?? 'Lamna', folders: [], ...(counterparty ? { counterparty } : {}) }, { quiet: true }); const dealId = Object.keys(store.get().deals).find((id) => !b4.has(id)); await store.dispatch(C('CreateFinding'), { dealId, title: 'Lamna lease schedule', workstream: 'Legal', sources: [{ doc: counterparty.length > 3 ? 'Lamna leases B, the schedule of rents, renewal dates, CAM charges and restoration costs.xlsx' : 'Lamna leases.xlsx', docId: `h-${dealId}`, loc: { '': 'pp. 1120-1185', 'FABRIKAM ABC': 'Sheet1!WM100', 'Contoso Group': 'pp. 112-118', 'Fabrikam Infrastructure Partners Fund IV (Lux) SCSp': 'Sources and Uses (Base Case)!$AB$1234' }[counterparty] ?? 'Sheet1!A1:B2' }] }, { quiet: true }); }
      // a counterparty that nearly fills the line, beside a page range: the counterparty is cut, never the pages
      const AD = 'Sovereign Wealth Trust Infrastructure Co-Investment Vehicle III (Luxembourg) SCSp';
      const counterparties = [
        'Contoso Sovereign Wealth Trust Infrastructure Co-Investment Vehicle III (Lux 76',
        'Oak', ('Widewater ' + AD).slice(0, 66), ('Northwind ' + AD).slice(0, 78),
      ];
      for (const counterparty of counterparties) {
        const before = new Set(Object.keys(store.get().deals));
        await store.dispatch(C('CreateDeal'), { name: 'Liberty', folders: [], counterparty }, { quiet: true });
        const dealId = Object.keys(store.get().deals).find((id) => !before.has(id));
        await store.dispatch(C('CreateFinding'), {
          dealId, title: 'Liberty lease break', workstream: 'Legal',
          sources: [{ doc: 'Liberty lease.pdf', docId: `w-${dealId}`, loc: 'pp. 1120-1185' }],
        }, { quiet: true });
      }
      // a place of medium length beside a short deal name: there is room for it whole
      await store.dispatch(C('CreateFinding'), { dealId: ids[2], title: 'Returns differ', workstream: 'Financial', sources: [{ doc: 'Q.xlsx', docId: 'q-solo', loc: 'Tab!A1:B20000' }] }, { quiet: true });
      for (const dealId of ids) for (let i = 0; i < 150; i++) await store.dispatch(C('CreateQuestion'), { dealId, text: `Diligence request ${i}` }, { quiet: true });   // three-digit numbers, as on a real deal
      for (const dealId of ids) for (let k = 0; k < 2; k++) await store.dispatch(C('CreateQuestion'), { dealId, text: 'Please confirm whether the EPC contract is a fixed-price, date-certain turnkey wrap, and provide the liquidated damages schedule' }, { quiet: true });
      return ids.map((id) => new Date(store.get().deals[id].createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
    });
    // each row as it looks: the second line's parts, which are cut, which show, and whether the line stays one line
    const read = () => page.evaluate(() => [...document.querySelectorAll('#pal-res .pgrp:not([data-kind=deal]) button:not(.pmore)')].map((b) => {
      const wh = b.querySelector('.where'), d = wh.querySelector('.wdeal'), tw = wh.querySelector('.wtwin'), at = wh.querySelector('.wat'), r = b.getBoundingClientRect(), w = wh.getBoundingClientRect(), t = b.querySelector('.ttl').getBoundingClientRect();
      const cutBy = (e) => { if (!e) return 0; const g = document.createRange(); g.selectNodeContents(e); const over = g.getBoundingClientRect().width - e.getBoundingClientRect().width; return over > 0.01 ? Math.max(0.01, Math.round(over * 100) / 100) : 0; };
      const lh = parseFloat(getComputedStyle(wh).lineHeight) || 16;
      return { tip: wh.title, twin: tw?.textContent ?? '', deal: d.textContent, twinCut: cutBy(tw), twinFirst: !tw || tw.getBoundingClientRect().left <= d.getBoundingClientRect().left, nameCut: cutBy(d), ...(() => {   // the name keeps its first word; a cut counterparty ends at its last whole word and the ellipsis, with no gap after
        const left = (e) => e.getBoundingClientRect().left, right = (e) => e.getBoundingClientRect().right, first = d.querySelector('.ww');
        const g = document.createElement('canvas').getContext('2d'); g.font = getComputedStyle(wh).font; const ell = g.measureText('…').width;
        const fit = tw && [...tw.querySelectorAll('.ww')].filter((x) => right(x) <= right(tw) - ell + 0.5).pop();
        return { firstWord: !first || d.getBoundingClientRect().width + 0.5 >= Math.min(d.scrollWidth, right(first) - left(d) + ell) - 1, twinGap: tw && cutBy(tw) ? Math.round(right(tw) - (fit ? right(fit) : left(tw)) - ell) : 0 }; })(), byWords: [d, tw].filter(Boolean).every((e) => { const ws = [...e.querySelectorAll('.ww')]; return ws.length > 0 && ws.map((x) => x.textContent).join('') === e.textContent.replace(/^ · /, '') && ws.every((x, i) => getComputedStyle(x).display === 'inline-block' && (i === 0) !== x.textContent.startsWith(' ')); }), dealShown: d.getBoundingClientRect().top < w.top + 2 && d.getBoundingClientRect().width >= Math.min(40, d.scrollWidth), nameW: Math.round(d.getBoundingClientRect().width * 100) / 100,
        at: at?.textContent, atShown: !!at && at.getBoundingClientRect().top < w.top + 2, atWhole: !!at && cutBy(at) === 0, atRight: !!at && Math.abs(at.getBoundingClientRect().right - w.right) <= 1,
        oneLine: w.height <= lh + 1, below: w.top >= t.bottom - 1, inside: w.left >= r.left && w.right <= r.right, whL: Math.round(w.left), h: Math.round(r.height) }; }));
    // a row is right if its second line is one line under the title, inside the row, and names the deal; names are cut by
    // whole words, each word an unbreakable box with its space before it, so an ellipsis never follows a space; what tells the deal apart comes first and
    // whole; a page or question number shows whole at the right; a sheet cell shows whole or not at all
    const sound = (r) => r.firstWord && r.twinGap <= 2 && r.byWords && r.dealShown && r.oneLine && r.below && r.inside && r.h <= 60 && r.twinFirst && r.twinCut === 0 && (r.atShown ? r.atWhole && r.atRight : !r.at || r.at.includes('!'));
    await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.type('covenant');
    await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 4);
    const rows = await read();
    const want = [['Northwind Capital Partners International', made[0], 1], ['Northwind Capital Partners International', made[0], 2], ['Tailwind Infrastructure', made[1], 1], ['Tailwind Infrastructure', made[1], 2]].map(([cp, day, n]) => `Project Proseware · ${cp} · ${day} · Q${n}`);
    say(`${w} same-named deals' hits say which deal first, the question number whole at the right`, rows.map((r) => r.tip).join('|') === want.join('|') && rows.every((r, i) => sound(r) && r.twin === (i < 2 ? 'Northwind Capital Partners International' : 'Tailwind Infrastructure') && r.deal === ' · Project Proseware' && r.nameCut === 0 && r.at === `Q${(i % 2) + 1}` && r.atShown) && page.errors.length === 0, JSON.stringify({ rows, errors: page.errors }));
    await page.fill('#pal-in', 'model.xlsx'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 2);
    const cells = await read();
    say(`${w} a sheet cell shows whole at the right where it fits beside the counterparty and the deal's first word, else is left to the hover`, cells.every((r) => sound(r) && r.tip.endsWith('$AB$1234')) && !cells[0].atShown && cells[1].atShown, JSON.stringify(cells));
    await page.fill('#pal-in', 'downside cases'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 2);
    const cut = await read();
    say(`${w} a long title does not take room from the second line`, cut.every((r) => sound(r) && r.tip.endsWith('$AB$1234')) && cut.some((r) => r.atShown) && cut[0].tip !== cut[1].tip, JSON.stringify(cut));
    await page.fill('#pal-in', 'q.xlsx'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 1);
    const mid = await read();
    say(`${w} a medium place beside a short deal shows whole`, mid[0].tip === 'Project Coho · Tab!A1:B20000' && sound(mid[0]) && mid[0].atShown && mid[0].twin === '', JSON.stringify(mid));
    await page.fill('#pal-in', 'zeta'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 6);
    const zeta = await read();
    say(`${w} a long shared name is told apart by its counterparty, first and whole`, zeta.every((r, i) => sound(r) && r.twin === (i % 2 ? 'Elm' : 'Oak') && r.deal.startsWith(' · Project Northwind')), JSON.stringify(zeta));
    await page.fill('#pal-in', 'lamna leases.xlsx'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 4);
    const ham = await read();
    say(
      `${w} a short counterparty or the day alone stays whole, and the place shows`,
      ham.every((r) => sound(r) && r.atShown && r.nameCut === 0) &&
        ham.map((r) => r.twin).slice(0, 2).join() === 'QRS,XYZ',
      JSON.stringify(ham),
    );
    await page.fill('#pal-in', 'leases b,'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 3);
    const wide = await read();   // a wide twelve-letter counterparty and a sheet cell; a thirteen-letter one beside a long name and pages; a long one
    // beside a long name and a long sheet cell: the two together are wider than the line, so the cell is left to the hover
    say(
      `${w} the deal's name gives way before the counterparty and the place; ` +
        'a cell that cannot sit beside the counterparty is left to the hover',
      wide.every((r) => sound(r) && (r.nameCut === 0 || r.nameW >= 80)) &&
        wide[0].atShown &&
        wide[1].atShown &&
        !wide[2].atShown &&
        wide[2].nameCut > 0 &&
        wide.map((r) => r.twin).join() ===
          'FABRIKAM ABC,Contoso Group,Fabrikam Infrastructure Partners Fund IV (Lux) SCSp',
      JSON.stringify(wide),
    );
    await page.fill('#pal-in', 'liberty lease'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 8);
    const liberty = await read();   // the finding of each Liberty, and its document, which carries the pages
    const rangeWhole = (r) => r.at === 'pp. 1120-1185' && r.atShown && r.atWhole && r.atRight;
    const whole = (r) => r.oneLine && r.inside && (!r.at || rangeWhole(r));
    const cutByWords = (r) => r.twinCut > 0 && sound({ ...r, twinCut: 0 });
    const cutLiberty = liberty.filter((row) => row.at && row.twin.startsWith('Contoso Sovereign'));
    say(`${w} beside a counterparty that nearly fills the line, the page range stays whole, `
      + 'the deal keeps its meaningful name, and the counterparty is cut by words with no gap',
    liberty.every(whole) && liberty.filter((r) => r.at).length === 4
      && cutLiberty.length === 1 && cutLiberty.every(cutByWords)
      && liberty.filter((r) => r.twin === 'Oak').every((r) => sound(r)), JSON.stringify(liberty));
    await page.fill('#pal-in', 'epc contract'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length === 5);
    const long = await read();
    say(`${w} a long question still says which deal, and its three-digit number stays whole`, long.every((r) => sound(r) && r.atShown && /^Q15[1-4]$/.test(r.at)) && long[2].tip.startsWith('Project Proseware · Tailwind') && long[4].tip === 'Project Coho · Q151', JSON.stringify(long));
    say(`${w} every row's second line starts at one line, and one deal's name is cut at one point`, new Set(long.map((r) => r.whL)).size === 1 && Math.abs(long[0].nameW - long[1].nameW) < 0.5 && Math.abs(long[2].nameW - long[3].nameW) < 0.5, JSON.stringify(long));
    // a deal hit says only what tells it apart, as the sidebar does, and the hover gives both
    await page.fill('#pal-in', 'proseware'); await page.waitForFunction(() => document.querySelectorAll('#pal-res .pgrp[data-kind=deal] button:not(.pmore)').length === 2);
    const deals = await page.evaluate(() => [...document.querySelectorAll('#pal-res .pgrp[data-kind=deal] button:not(.pmore) .where')].map((e) => [e.textContent, e.title]));
    say(`${w} a same-named deal's own hit gives its counterparty, the hover adds the day`, JSON.stringify(deals) === JSON.stringify([['Northwind Capital Partners International', `Northwind Capital Partners International · ${made[0]}`], ['Tailwind Infrastructure', `Tailwind Infrastructure · ${made[1]}`]]), JSON.stringify(deals));
    await ctx.close();
  } }

const ARABIC = 'مشروع الرياح البحرية الكبير في شمال البحر';
const HEBREW = 'פרויקט אגירת אנרגיה ימית עם חיבור לתחנות משנה צפוניות';
const FUND = 'Example Infrastructure Partners Fund';
const REPEATED_FUND = 'Fund IV Fund V Example Infrastructure Partners Fund';
const UNBROKEN = 'ExampleCoInvestmentInfrastructureCoInvestmentVehicleIIILuxembourgSCSp';
const SAMPLE_PARTY = 'Widewater Worldwide Wind Infrastructure Co-Investment Vehicle III (Lux) SCSp';
const LONG_DEAL = 'Supercalifragilisticexpialidocious-Offshore-Wind-Portfolio-Refinancing';
const REFERENCE = 'pp. 1120-1185';

async function seedSearchLabels(page) {
  await page.evaluate(async ({ arabic, hebrew, fund, repeated, word, counterparty, longDeal, loc }) => {
    const run = (name, input) => store.dispatch(store.commandNamed(name), input, { quiet: true });
    const labels = [
      ['Maple Wind Portfolio', fund + ' IV (Lux) SCSp', 'covenant compliance'],
      ['Maple Wind Portfolio', fund + ' V (Lux) SCSp', 'covenant compliance'],
      ['Meadow Storage Portfolio', repeated + ' IV (Lux) SCSp', 'Reserve fund test'],
      ['Meadow Storage Portfolio', repeated + ' V (Lux) SCSp', 'Reserve fund test'],
      ['Sample A', counterparty, 'Sample A lease'],
      ['Sample A', 'Elm', 'Sample A lease'],
      ['Project - Sample Name with a Long Series of Terms', 'W'.repeat(75), 'Punctuated deal lease'],
      ['Project - Sample Name with a Long Series of Terms', 'Elm', 'Punctuated deal lease'],
      [longDeal, word, 'Zebra edge finding'],
      [longDeal, 'Oak', 'Zebra edge finding'],
      [arabic, 'W'.repeat(74), 'connection signature'],
      [arabic, 'Elm', 'connection signature'],
      [hebrew, 'Oak', 'Hebrew connection'],
    ];
    for (const [name, party, title] of labels) {
      const before = new Set(Object.keys(store.get().deals));
      const created = await run('CreateDeal', { name, counterparty: party, folders: [] });
      if (!created.ok) throw new Error(JSON.stringify(created.error));
      const dealId = Object.keys(store.get().deals).find((id) => !before.has(id));
      if (title === 'covenant compliance' || title.includes('connection')) {
        await run('CreateQuestion', { dealId, text: title });
      } else {
        await run('CreateFinding', {
          dealId, title, workstream: 'Legal', sources: [{ doc: title + '.pdf', docId: dealId, loc }],
        });
      }
    }
  }, { arabic: ARABIC, hebrew: HEBREW, fund: FUND, repeated: REPEATED_FUND, word: UNBROKEN, counterparty: SAMPLE_PARTY,
    longDeal: LONG_DEAL, loc: REFERENCE });
}

async function loadSearchLog(page) {
  const sections = [
    'the array', 'the substation', 'the access roads', 'the cable route', 'the battery yard', 'the control building',
    'the met stations', 'the laydown area', 'the switchyard', 'the water supply', 'the collection system',
    'the inverter pads', 'the drainage', 'the gen-tie', 'the fencing', 'the backup supply',
    'the communications network',
  ];
  const texts = sections.flatMap((section) => ITEMS.map(({ t }) => `${section}: ${t}`)).slice(0, 2001);
  const imported = await page.evaluate((texts) => {
    const dealId = Object.values(store.get().deals).find(({ name }) => name === 'Project Maple Wind Portfolio').id;
    const rows = texts.map((text) => ({
      n: null, text, askedBy: '', received: '', workstream: 'Legal', priority: '',
      response: '', respondedBy: '', responded: '', status: 'open',
    }));
    return store.dispatch(store.commandNamed('ImportQuestions'), { dealId, mode: 'append', rows }, { quiet: true });
  }, texts);
  if (!imported.ok) throw new Error(JSON.stringify(imported.error));
  await page.waitForFunction(() => Object.keys(store.get().questions).length >= 2001);
}

// A text run is readable when its range fits inside the clipped label.
const fitsText = (locator, text) => locator.evaluate((root, text) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const offset = node.textContent.indexOf(text);
    if (offset < 0) continue;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + text.length);
    const box = range.getBoundingClientRect();
    let parent = node.parentElement;
    while (parent && root.contains(parent)) {
      const style = getComputedStyle(parent);
      const edges = parent.getBoundingClientRect();
      if (style.overflowX !== 'visible' && (box.left < edges.left - 1 || box.right > edges.right + 1)) return false;
      parent = parent.parentElement;
    }
    return true;
  }
  return false;
}, text);

async function searchLabel(page, query, kind, full = '') {
  await page.fill('#pal-in', query);
  const label = page.locator(`#pal-res [data-kind=${kind}] .where`).filter({ hasText: full }).first();
  await label.waitFor();
  return label;
}

const labelChecks = { 490: [], 492: [], 494: [], 495: [] };
for (const [width, height] of [[1280, 736], [1024, 640]]) {
  for (const colorScheme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme });
    const page = await ctx.newPage();
    await page.goto(URL);
    await page.waitForSelector('#fr-new');
    await seedSearchLabels(page);
    if (width === 1280 && colorScheme === 'dark') await loadSearchLog(page);
    await page.goto(URL + '#deals');
    const shot = async (name) => {
      if (!SHOTS) return;
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/${name}-${colorScheme}-${width}x${height}.png` });
    };

    await shot('492-sidebar');
    await page.keyboard.press('Control+k');
    for (const roman of ['IV', 'V']) {
      const token = 'Fund ' + roman + ' (';
      const rail = page.locator('.dealrow .dtw').filter({ hasText: token }).first();
      const found = await searchLabel(page, 'covenant compliance', 'question', token);
      const searchTwin = await fitsText(found.locator('.wtwin'), roman);
      const railTwin = await fitsText(rail, roman);
      const full = (await found.getAttribute('title')).includes(FUND + ' ' + roman + ' (Lux) SCSp');
      labelChecks[492].push(searchTwin && railTwin && full);
    }
    await shot('492-funds');
    for (const roman of ['IV', 'V']) {
      const full = REPEATED_FUND + ' ' + roman + ' (Lux) SCSp';
      const repeated = await searchLabel(page, 'Reserve fund test.pdf', 'document', full);
      const rail = page.locator('.dealrow .dtw').filter({ hasText: full }).first();
      const distinction = 'Fund ' + roman;
      labelChecks[492].push(await fitsText(repeated.locator('.twin-focus'), distinction) &&
        await fitsText(rail.locator('.twin-focus'), distinction));
    }

    const sample = await searchLabel(page, 'Sample A lease.pdf', 'document', SAMPLE_PARTY);
    labelChecks[495].push(await fitsText(sample.locator('.wdeal'), 'Sample') &&
      await fitsText(sample.locator('.wdeal'), ' A') && await fitsText(sample.locator('.wat'), REFERENCE));
    await shot('495-name-and-pages');
    const punctuated = await searchLabel(page, 'Punctuated deal lease.pdf', 'document', 'WWWW');
    labelChecks[495].push(await fitsText(punctuated.locator('.wdeal'), 'Sample') &&
      await fitsText(punctuated.locator('.wat'), REFERENCE));

    const unbroken = await searchLabel(page, 'Zebra edge finding.pdf', 'document', UNBROKEN);
    const ellipsis = await unbroken.locator('.wtwin .ww').evaluate((word) =>
      getComputedStyle(word).textOverflow === 'ellipsis' && word.scrollWidth > word.clientWidth);
    labelChecks[494].push(ellipsis && await fitsText(unbroken.locator('.wat'), REFERENCE) &&
      (await unbroken.getAttribute('title')).includes(UNBROKEN));
    await shot('494-unbroken');

    const rtl = await searchLabel(page, 'connection signature', 'question', 'WWWW');
    const rtlName = rtl.locator('.wdeal');
    const direction = await rtlName.evaluate((deal) =>
      getComputedStyle(deal.querySelector('[dir]') ?? deal).direction);
    labelChecks[490].push(direction === 'rtl' && await fitsText(rtlName, 'مشروع') &&
      await fitsText(rtl.locator('.wat'), 'Q1'));
    await shot('490-right-to-left');
    const hebrew = await searchLabel(page, 'Hebrew connection', 'question');
    labelChecks[490].push(await fitsText(hebrew.locator('.wdeal'), 'פרויקט') &&
      await fitsText(hebrew.locator('.wat'), 'Q1'));
    await ctx.close();
  }
}
for (const [issue, outcomes] of Object.entries(labelChecks)) {
  say(`#${issue} Search labels at both sizes in both themes`, outcomes.every(Boolean), JSON.stringify(outcomes));
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
