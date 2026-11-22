// The Q&A page as a full table for skimming: no question open = the list takes the whole width and shows the start of each
// response; clicking a row opens its detail beside a narrower list; closing the detail gives the table back. Left as it was, per deal.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const ROWS = [
  ['Confirm the lock-up ratio that applies from financial close, and which document prevails.', 'The credit agreement prevails. Lock-up is tested at 1.25x from financial close, on each calculation date, on both the historic and the projected ratio. The term sheet figure of 1.30x was superseded in the second draft, and the model was updated to match in version 14.', 'Northwind Sponsor LP', '2026-11-02', 'High'],
  ['Provide the executed revenue contract and all amendments.', '', '', '', ''],
  ['What is the basis for the operating assumption in the base case?', 'The technical advisor’s P50 case, less a 2% availability haircut.', 'Northwind Sponsor LP', '2026-11-05', 'Medium'],
  ['Has the interconnection agreement been signed, and what are its conditions?', '', '', '', ''],
  ['Provide the insurance advisor’s latest report.', 'Attached as document 14.3 in the data room.', 'Litware', '2026-11-06', ''],
  ['Who holds the land rights, and when do they expire?', '', '', '', ''],
];
async function newDeal(page, name) {
  await page.click((await page.$('#fr-new')) ? '#fr-new' : '#new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  const id = await page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === 'Project ' + n).id, name);
  await page.waitForFunction((d) => Object.values(store.get().findings).filter((f) => f.dealId === d).length === 3, id, { timeout: 30000 });
  return id;
}
const importRows = (page, id, rows) => page.evaluate(([d, rows]) => store.dispatch(store.commandNamed('ImportQuestions'), { dealId: d, mode: 'append', rows: rows.map(([text, response, respondedBy, responded, priority]) => ({ n: null, text, askedBy: 'Lamna Capital', received: '2026-10-28', workstream: 'Legal', priority, response, respondedBy, responded, status: response ? 'answered' : '' })) }, { quiet: true }), [id, rows]);
const toastsGone = (page) => page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
// every status is listed, so the rows are the same whatever was open before
const all = async (page, n = ROWS.length) => { await page.waitForSelector('.md .list'); await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' } })); await page.waitForFunction((n) => document.querySelectorAll('.md .li').length === n, n); await page.waitForTimeout(150); };
const openQa = async (page, id, n = ROWS.length) => { await page.goto(URL + '#qa-' + id); await all(page, n); };
const view = (page) => page.evaluate(() => { const r = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }; const md = document.querySelector('.md'), list = document.querySelector('.md .list'), det = document.querySelector('.qpanel'); const on = document.querySelector('.md .li.on');
  return { wide: md.classList.contains('wide'), det: !!det, detQ: det?.querySelector('.qph .n')?.textContent ?? null, ask: !!document.querySelector('.askslot'), panel: det ? r(det) : null, heads: [...document.querySelectorAll('.md .lh span')].map((x) => x.textContent).filter(Boolean), previews: document.querySelectorAll('.md .li .rs').length, list: r(list), tracker: r(document.querySelector('.tracker')), on: on ? on.querySelector('.n').textContent : null, onSeen: on ? r(on)[1] >= r(list)[1] - 1 && r(on)[3] <= r(list)[3] + 1 : null, sel: store.get().ui.selectedQuestion, focusN: document.activeElement?.classList?.contains('li') ? document.activeElement.querySelector('.n').textContent : null, over: list.scrollWidth - list.clientWidth, scrolled: document.getElementById('view').scrollTop }; });

for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  const id = await newDeal(page, 'Proseware'); await importRows(page, id, ROWS); await toastsGone(page);

  // ---- first visit: the full table ----------------------------------------------------------------------------------
  await openQa(page, id);
  const v0 = await view(page);
  say(`${scheme}:a-deal's-q&a-opens-as-the-full-table`, v0.wide && !v0.det && v0.sel === null && Math.abs(v0.list[2] - v0.tracker[2]) <= 1 && v0.list[0] === v0.tracker[0] && v0.over <= 0, JSON.stringify(v0));
  // no Draft column: a ready draft shows in the Response cell, after the AI mark, instead
  say(`${scheme}:its-columns-are-named-and-the-two-response-details-start-off`,
    v0.heads.join('|') === '#|Priority|Submitted By|Question|Response|Status' && v0.previews === ROWS.length
    && (await page.$$('.md .li .rby, .md .li .rdt')).length === 0, JSON.stringify(v0.heads));
  const prev = await page.evaluate(() => { const c = document.querySelector('.md .li .rs'); const lh = parseFloat(getComputedStyle(c).lineHeight); return { lines: Math.round(c.clientHeight / lh), cut: c.scrollHeight > c.clientHeight + 1, starts: c.textContent.slice(0, 31), empty: document.querySelectorAll('.md .li')[1].querySelector('.rs').textContent, status: [...document.querySelectorAll('.md .li .stc')].map((x) => x.textContent).join(',') }; });
  say(`${scheme}:a-response-shows-its-first-two-lines`, prev.lines === 2 && prev.cut && prev.starts === 'The credit agreement prevails. ' && prev.empty === '' && prev.status === 'Answered,Open,Answered,Open,Answered,Open', JSON.stringify(prev));

  // ---- opening and closing the detail ---------------------------------------------------------------------------------
  await page.click('.md .li >> nth=2'); await page.waitForSelector('.qpanel'); await page.waitForTimeout(150);
  const v1 = await view(page);
  // design G: the open question goes across the top in place of the ask box; the table below stays the full table
  say(`${scheme}:clicking-a-row-opens-it-across-the-top-in-place-of-the-ask-box`, v1.wide && v1.det && v1.detQ === 'Q3' && v1.on === '3' && !v1.ask && v1.panel[3] <= v1.tracker[1] && v1.previews === ROWS.length && v1.heads.length === 6 && Math.abs(v1.list[2] - v1.tracker[2]) <= 1 && v1.over <= 0, JSON.stringify(v1));
  await page.click('#q-close'); await page.waitForSelector('.qpanel', { state: 'detached' }); await page.waitForTimeout(150);
  const v2 = await view(page);
  say(`${scheme}:the-close-button-gives-the-table-back-and-the-focus-to-that-row`, v2.wide && !v2.det && v2.ask && v2.sel === null && v2.focusN === '3' && v2.previews === ROWS.length, JSON.stringify(v2));
  await page.click('.md .li >> nth=1'); await page.waitForSelector('.qpanel'); await page.keyboard.press('Escape'); await page.waitForSelector('.qpanel', { state: 'detached' }); await page.waitForTimeout(150);
  const v3 = await view(page);
  say(`${scheme}:escape-closes-the-detail`, v3.wide && v3.sel === null && v3.focusN === '2', JSON.stringify(v3));
  // Escape while typing in the detail: the pane closes and what was typed is saved, as it is on leaving a field any other way
  await page.click('.md .li >> nth=1'); await page.waitForSelector('.det textarea.qtext'); const q2 = await page.evaluate(() => store.get().ui.selectedQuestion);
  await page.fill('.det textarea.qtext', 'Provide the executed revenue contract, all amendments and side letters.'); await page.keyboard.press('Escape'); await page.waitForSelector('.qpanel', { state: 'detached' });
  await page.waitForFunction((q) => store.get().questions[q].text === 'Provide the executed revenue contract, all amendments and side letters.', q2, { timeout: 5000 });
  say(`${scheme}:escape-from-a-field-closes-the-detail-and-keeps-what-was-typed`, (await page.textContent('.md .li >> nth=1')).includes('side letters'));

  // ---- keyboard: in the table the arrows only move; Enter opens. With the detail open they change the open question ----
  await page.focus('.md .li[tabindex="0"]'); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120);
  const k1 = await view(page); await page.keyboard.press('Enter'); await page.waitForSelector('.qpanel'); await page.waitForTimeout(120); const k2 = await view(page);
  await page.focus('.md .li.on'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); const k3 = await view(page);
  say(`${scheme}:arrows-move-through-the-table-without-opening-and-enter-opens`, k1.focusN === '3' && k1.sel === null && k1.wide && k2.detQ === 'Q3' && k3.detQ === 'Q4' && k3.focusN === '4', JSON.stringify({ k1: [k1.focusN, k1.sel, k1.wide], k2: k2.detQ, k3: [k3.detQ, k3.focusN] }));

  // Enter on the row already open goes into the panel, to the Response, without changing the open question
  await page.keyboard.press('Enter'); await page.waitForTimeout(120);
  const k4 = await page.evaluate(() => ({ cls: document.activeElement?.className ?? '', inPanel: !!document.activeElement?.closest('.qpanel'), sel: store.get().questions[store.get().ui.selectedQuestion]?.n }));
  say(`${scheme}:enter-on-the-open-row-goes-to-its-response`, k4.inPanel && /rtext/.test(k4.cls) && k4.sel === 4, JSON.stringify(k4));

  // ---- left as it was, per deal -----------------------------------------------------------------------------------------
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); await openQa(page, id); const l1 = await view(page);
  await page.reload(); await all(page); await page.waitForSelector('.qpanel'); const l2 = await view(page);
  say(`${scheme}:the-page-comes-back-with-the-detail-open-where-it-was-left`, l1.detQ === 'Q4' && l2.detQ === 'Q4' && l2.wide, JSON.stringify({ l1: l1.detQ, l2: l2.detQ }));
  const id2 = await (async () => { await page.goto(URL + '#deals'); await page.waitForSelector('#hask'); const x = await newDeal(page, 'Trey'); await importRows(page, x, ROWS.slice(0, 2)); await toastsGone(page); return x; })();
  await openQa(page, id2, 2); const d2 = await view(page); await openQa(page, id); await page.waitForSelector('.qpanel'); const d1 = await view(page);
  say(`${scheme}:each-deal-remembers-its-own`, d2.wide && !d2.det && d1.detQ === 'Q4', JSON.stringify({ d2: [d2.wide, d2.det], d1: d1.detQ }));
  await page.click('#q-close'); await page.waitForSelector('.qpanel', { state: 'detached' }); await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); await openQa(page, id); const c1 = await view(page);
  await page.reload(); await all(page); await page.waitForTimeout(300); const c2 = await view(page);
  say(`${scheme}:closed-stays-closed`, c1.wide && !c1.det && c2.wide && !c2.det && (await page.evaluate((d) => store.get().prefs.qaOpen[d] === undefined, id)), JSON.stringify({ c1: c1.wide, c2: c2.wide }));

  // ---- columns on and off ---------------------------------------------------------------------------------------------
  await page.click('#qa-cols'); await page.waitForSelector('#colmenu');
  const menu = await page.evaluate(() => { const m = document.getElementById('colmenu').getBoundingClientRect(); return { bottom: Math.round(m.bottom), vh: innerHeight, labels: [...document.querySelectorAll('#colmenu .mcols label')].map((l) => l.textContent + ':' + l.querySelector('input').checked).join('|') }; });
  await page.click('#colmenu [data-col="respondedBy"]'); await page.click('#colmenu [data-col="responded"]'); await page.waitForTimeout(150);
  const afterMenu = await page.evaluate(() => document.getElementById('view').scrollTop);
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const c3 = await view(page); const cells = await page.evaluate(() => ({ by: document.querySelector('.md .li .rby').textContent, date: document.querySelector('.md .li .rdt').textContent }));
  say(`${scheme}:the-more-menu-lists-six-columns-and-stays-inside-the-window`,
    menu.labels === 'Priority:true|Submitted By:true|Response:true|Status:true|Responded By:false|Response Date:false'
    && menu.bottom <= menu.vh && afterMenu === 0, JSON.stringify({ menu, afterMenu }));
  say(`${scheme}:responded-by-and-its-date-can-be-switched-on`,
    c3.heads.join('|') === '#|Priority|Submitted By|Question|Response|Responded By|Response Date|Status'
    && cells.by === 'Northwind Sponsor LP' && /Nov 2/.test(cells.date) && c3.over <= 0,
    JSON.stringify({ heads: c3.heads, cells, over: c3.over }));
  await page.reload(); await all(page); const c4 = await view(page);
  await page.click('#qa-cols'); await page.click('#colmenu [data-col="response"]'); await page.keyboard.press('Escape'); await page.waitForTimeout(150); const c5 = await view(page);
  say(`${scheme}:column-choices-are-kept-and-response-can-be-switched-off`, c4.heads.includes('Responded By')
    && c4.heads.includes('Response Date') && !c5.heads.includes('Response') && c5.previews === 0,
    JSON.stringify({ c4: c4.heads, c5: c5.heads }));
  // a short window: the table still fits, with every column on
  await page.click('#qa-cols'); await page.click('#colmenu [data-col="response"]'); await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1024, height: 640 }); await page.waitForTimeout(300); const small = await view(page);
  await page.click('#qa-cols'); await page.waitForSelector('#colmenu'); const smallMenu = await page.evaluate(() => { const m = document.getElementById('colmenu').getBoundingClientRect(); return { bottom: Math.round(m.bottom), vh: innerHeight }; }); await page.keyboard.press('Escape');
  say(`${scheme}:at-1024-by-640-the-table-and-the-menu-still-fit`, small.over <= 0 && small.list[2] <= 1024 && smallMenu.bottom <= smallMenu.vh, JSON.stringify({ over: small.over, list: small.list, smallMenu }));
  // at both sizes an opened question sits across the top, inside the window, with the table's toolbar still below it in view
  const opened = async () => { await page.evaluate(() => document.querySelector('.md .li').click()); await page.waitForSelector('.qpanel'); await page.waitForTimeout(400); const r = await page.evaluate(() => { const R = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }; const p = document.querySelector('.qpanel'); const hd = p.querySelector('.qph'); const kids = [...hd.querySelector('.qnav').children].filter((c) => c.getClientRects().length); const last = kids[kids.length - 1];
    return { panel: R(p), tools: R(document.querySelector('.trk-head')), vh: innerHeight, vw: innerWidth, head: { h: Math.round(hd.getBoundingClientRect().height), last: last.id, gap: Math.round(p.getBoundingClientRect().left + p.clientWidth - last.getBoundingClientRect().right), btns: [...hd.querySelectorAll('.btn')].map((b) => Math.round(b.getBoundingClientRect().height)).join(), over: hd.scrollWidth - hd.clientWidth, props: [...hd.querySelectorAll('.qprops [role="combobox"]')].map((x) => x.getAttribute('aria-label')).join(), propsCut: Math.max(0, ...[...hd.querySelectorAll('.qprops .pv, .qprops .ef')].map((e) => e.scrollWidth - e.clientWidth)) } }; }); await page.click('#q-close'); await page.waitForSelector('.qpanel', { state: 'detached' }); return r; };
  await page.setViewportSize({ width: 1024, height: 640 }); await page.waitForTimeout(300);
  const o1024 = await opened(); await page.setViewportSize({ width: 1280, height: 736 }); await page.waitForTimeout(300); const o1280 = await opened();
  const inside = (o) => o.panel[1] >= 0 && o.panel[3] <= o.vh && o.panel[2] <= o.vw && o.tools[1] < o.vh;
  say(`${scheme}:an-opened-question-sits-across-the-top-inside-the-window-at-1024-and-1280`, inside(o1024) && inside(o1280), JSON.stringify({ o1024, o1280 }));
  // its controls end at the panel's inner edge (22px padding), all 28 high; the details fit, on the header's line at 1280 and on a line of their own at 1024
  const row = (o, h) => o.head.last === 'q-close' && Math.abs(o.head.gap - 22) <= 1 && o.head.btns === '28,28,28,28,28' && o.head.over <= 0 && o.head.props === 'Workstream,Priority' && o.head.propsCut <= 0 && o.head.h <= h;
  say(`${scheme}:an-opened-question-has-one-header-of-controls-ending-at-the-panels-edge`, row(o1280, 28) && row(o1024, 66), JSON.stringify({ a: o1024.head, b: o1280.head }));
  await page.setViewportSize({ width: 1280, height: 736 });
  await page.click('#qa-cols'); await page.click('#colmenu [data-col="respondedBy"]'); await page.click('#colmenu [data-col="responded"]'); await page.keyboard.press('Escape');

  // ---- deleting and adding from the detail ------------------------------------------------------------------------------
  await page.click('.md .li >> nth=1'); await page.waitForSelector('.qpanel .del'); await page.click('.qpanel .del'); await page.click('#ask-go'); await page.waitForSelector('#toast .tundo'); await page.waitForTimeout(200);
  const del = await view(page);
  await page.click('#toast .tundo'); await page.waitForFunction((n) => document.querySelectorAll('.md .li').length === n, ROWS.length);
  say(`${scheme}:deleting-the-open-question-moves-the-detail-to-the-next-one`, del.det && del.detQ === 'Q3' && del.wide, JSON.stringify({ det: del.det, detQ: del.detQ }));
  await page.waitForTimeout(150); const undone = await view(page);
  say(`${scheme}:undoing-the-delete-brings-the-detail-back-to-that-question`, undone.det && undone.detQ === 'Q2' && undone.on === '2', JSON.stringify({ detQ: undone.detQ, on: undone.on }));
  await page.click('#q-close'); await page.waitForSelector('.qpanel', { state: 'detached' }); await toastsGone(page);
  await page.click('#qa-add'); await page.waitForSelector('.det textarea.qtext'); await page.waitForTimeout(200); const add = await view(page);
  say(`${scheme}:add-question-opens-the-detail-on-the-new-question`, add.det && add.detQ === 'Q7' && (await page.evaluate(() => document.activeElement?.classList.contains('qtext'))), JSON.stringify({ detQ: add.detQ }));
  // a question of only spaces has no words to show: its row says New question, as an empty one does
  await page.fill('.det textarea.qtext', '   '); await page.click('.qpanel .qleft .qlbl'); await page.waitForFunction(() => store.get().questions[store.get().ui.selectedQuestion].text === '   ', null, { timeout: 5000 }).catch(() => {});
  const blank = await page.evaluate(() => ({ saved: JSON.stringify(store.get().questions[store.get().ui.selectedQuestion].text), row: document.querySelector('.md .li.on .q').innerHTML }));
  say(`${scheme}:a-question-of-only-spaces-shows-as-new-question`, blank.row === '<i>New question</i>', JSON.stringify(blank));
  say(`${scheme}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
