// Long values in capsules (design.md, Editable values): a capsule is as wide as its value, never cut. In the Q&A
// header the details that do not fit on the top line go onto lines under it, each starting at the header's left edge, 10px apart,
// with Q1, the status and the buttons staying on the top line; a list opens under its own capsule on whichever line it is; and
// each column's text sits right under its own label.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const LONG = { askedBy: 'Bellows Bank Infrastructure Lending, Project Finance Group', respondedBy: 'Northwind Sponsor Legal Team', workstream: 'Environmental, social and governance review', counterparty: 'Northwind Energy Holdings International LLC' };
// every value in a capsule shows whole: its words are not wider than the room they have
const cut = (page, sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map((e) => `${e.getAttribute('aria-label') || e.textContent} ${e.scrollWidth - e.clientWidth}`), sel);
for (const [w, h] of [[1280, 736], [1024, 640]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.evaluate(([dealId, L]) => store.dispatch(store.commandNamed('ImportQuestions'), { dealId, mode: 'append', rows: [{ n: null, text: 'Confirm whether the conditions precedent in clause 1 of the credit agreement have been satisfied or waived, and by whom.', askedBy: L.askedBy, received: '2026-11-03', workstream: L.workstream, priority: 'Medium', response: 'The sponsor confirms all conditions precedent were satisfied on signing.', respondedBy: L.respondedBy, responded: '2026-11-12', status: 'answered' }, { n: null, text: 'Second question', askedBy: 'Lender A', received: '2026-11-03', workstream: 'Legal', priority: 'High', response: '', respondedBy: '', responded: '', status: '' }] }, { quiet: true }), [id, LONG]);
  await page.evaluate(([dealId, L]) => store.dispatch(store.commandNamed('EditDeal'), { dealId, counterparty: L.counterparty }, { quiet: true }), [id, LONG]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' } }));
  await page.waitForSelector('.md .li'); await page.click('.md .li >> nth=0'); await page.waitForSelector('.qpanel .qph'); await page.mouse.move(5, h - 5); await page.waitForTimeout(400);
  const T = `${w}`;
  const shown = await cut(page, '.qph .pv, .qph .efcap>.ef, .qlbl .efcap>.ef, .trail .efcap>.ef');
  say(`${T}:every-value-in-a-capsule-shows-whole`, shown.length === 0, JSON.stringify(shown));
  const head = await page.evaluate(() => {
    const R = (e) => e.getBoundingClientRect(); const lead = document.querySelector('.qlead'), nav = document.querySelector('.qnav'), n = document.querySelector('.qph .n');
    // a line starts where its first ink is: Q1's text, or a plain detail's icon (its box starts 4px early)
    const inkLeft = (e) => {
      const icon = e.matches('.qprops>*') ? e.querySelector('svg') : null;
      if (!icon) return R(e).left;
      return R(icon).left + icon.getBBox().x * (R(icon).width / 24);
    };
    const all = [n, ...document.querySelectorAll('.qlead>.stpick, .qprops>*')];
    const items = all.map((e) => ({ l: Math.round(inkLeft(e)), t: Math.round(R(e).top), r: R(e).right }));
    const tops = [...new Set(items.map((x) => x.t))].sort((a, b) => a - b);
    return { left: Math.round(R(lead).left), tops, starts: tops.map((t) => Math.min(...items.filter((x) => x.t === t).map((x) => x.l))), status: Math.round(R(document.querySelector('.qph .stpick')).top), close: Math.round(R(document.getElementById('q-close')).top), qn: [Math.round(R(n).top), Math.round(R(n).height)],
      clear: items.filter((x) => x.t === tops[0]).every((x) => x.r <= R(nav).left - 8 + 0.5), gap: (() => { const a = R(document.querySelector('.qph .stpick')), b = R(document.querySelector('.qprops>.qpick')); return Math.round(a.top) === Math.round(b.top) ? Math.round(b.left - a.right) : null; })(), head: Math.round(R(document.querySelector('.qph')).height) };
  });
  say(`${T}:the-details-wrap-onto-lines-that-start-at-the-headers-left-edge`, head.tops.length >= 2 && head.starts.every((s) => Math.abs(s - head.left) <= 1), JSON.stringify(head));
  say(`${T}:its-lines-are-10px-apart-and-the-header-ends-at-the-last`, head.tops.every((t, i) => i === 0 || t - head.tops[i - 1] === 38) && head.head === 28 + 38 * (head.tops.length - 1), JSON.stringify(head));
  // the status sits 16px from the details' box, 20px from their ink (qapanel.spec checks the ink)
  const topLine = [head.status, head.close, head.qn[0]].every((t) => t === head.tops[0]) && head.qn[1] === 28;
  say(`${T}:Q1-the-status-16px-from-the-details-and-the-buttons-stay-on-the-top-line`,
    topLine && head.clear && (head.gap === 16 || head.gap === null), JSON.stringify(head));
  // Workstream, past the top line here, opens its list under its own capsule
  await page.click('.qprops .qp[title="Workstream"]'); await page.waitForSelector('.stlist'); await page.waitForTimeout(300);
  const list = await page.evaluate(() => { const b = document.querySelector('.qprops .qp[title="Workstream"]').getBoundingClientRect(), l = document.querySelector('.stlist').getBoundingClientRect(); return { dx: Math.round(l.left - b.left), dy: Math.round(l.top - b.bottom), line: Math.round(b.top - document.querySelector('.qph').getBoundingClientRect().top) }; });
  await page.keyboard.press('Escape'); await page.waitForSelector('.stlist', { state: 'detached' });
  say(`${T}:a-list-opens-under-its-own-capsule`, list.dx === 0 && list.dy === 6, JSON.stringify(list));
  // each column's text right under its own label, the same space under both
  const under = await page.evaluate(() => { const g = (s) => document.querySelector(s).getBoundingClientRect(); return [Math.round(g('.qleft .qtext').top - g('.qleft .qlbl').bottom), Math.round(g('.qright .rtext').top - g('.qright .qlbl').bottom)]; });
  say(`${T}:the-question-and-the-response-each-sit-right-under-their-label`, under[0] === under[1] && under[0] <= 6, JSON.stringify(under));
  // Overview: the counterparty and the deal's lists show whole too
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('.trail .efcap'); await page.waitForTimeout(300);
  const ov = await cut(page, '.trail .efcap>.ef, .ovfacts .pv, .ovfacts .efcap>.ef');
  say(`${T}:on-overview-the-counterparty-shows-whole`, ov.length === 0, JSON.stringify(ov));
  // a counterparty at its 80-character limit gives way before the deal's name in the trail does
  await page.evaluate((dealId) => store.dispatch(store.commandNamed('EditDeal'), { dealId, counterparty: 'Northwind Energy Holdings International LLC and Affiliated Companies of Northwin' }, { quiet: true }), id); await page.waitForTimeout(300);
  const name = await page.evaluate(() => { const t = document.querySelector('.trail .tn'); return t.scrollWidth - t.clientWidth; });
  say(`${T}:a-long-counterparty-gives-way-before-the-deal-name`, name <= 0, String(name));
  say(`${T}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
