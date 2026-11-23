// The Overview page a deal opens on, the Checklist page behind its figures, and the Settings choice of which page a deal opens on.
// This suite does not choose a page first: it tests what happens when nothing has been chosen.
import { launchChrome } from './chrome.mjs';
import { openDelete } from './dealMenu.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note); };
const browser = await launchChrome();
async function fresh(scheme = 'light', w = 1280, h = 736, locale = 'en-US') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, locale });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#fr-new');
  return { ctx, page };
}
async function newDeal(page, name, paths, button = '#fr-new') {
  await page.click(button); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', name);
  if (paths.length) { await page.click('#nd-paste'); for (let i = 0; i < paths.length; i++) { await page.fill('#nd-path', paths[i]); await page.press('#nd-path', 'Enter'); await page.waitForFunction((n) => document.querySelectorAll('.ndrow').length === n, i + 1); } }
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  return page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === `Project ${n}`).id, name);
}
const num = (s) => +s.replace(/,/g, '');
const noOverflow = (page) => page.evaluate(() => { const v = document.querySelector('.home.top').getBoundingClientRect(); return document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.home.top *')].every((e) => { const r = e.getBoundingClientRect(); return r.width === 0 || r.right <= v.right + 1; }); });
const docs = (page) => page.evaluate(() => [...document.querySelectorAll('#ov-docs .dcrow')].map((r) => ({ name: r.querySelector('.fn').textContent, text: r.querySelector('.rd').textContent, part: r.classList.contains('part'), live: !!r.querySelector('.fbar .live'), bar: [r.querySelector('.fbar').getBoundingClientRect().left, r.querySelector('.fbar').getBoundingClientRect().right].map(Math.round).join('-'), read: (r.querySelector('.fbar .rv')?.getBoundingClientRect().width ?? 0) / r.querySelector('.fbar').getBoundingClientRect().width, cut: r.querySelector('.fn').scrollWidth > r.querySelector('.fn').clientWidth })));

// each column on Overview: its heading and total, each part's words in order, the bar's parts by color, where its heading goes, and whether its words stay inside it without touching
const blocksOf = (page) => page.evaluate(() => [...document.querySelectorAll('#ov-standing .pcol')].map((b) => { const r = b.getBoundingClientRect(); const labs = [...b.querySelectorAll('.plab')]; const box = (e) => e.getBoundingClientRect();
    return { id: b.id, title: b.querySelector('.nm').textContent, tot: b.querySelector('.tot').textContent, labs: labs.map((e) => e.textContent).join('|'), bar: [...b.querySelectorAll('.pbar b')].map((x) => x.style.background || x.className).join('|'), widths: [...b.querySelectorAll('.pbar b')].map((x) => Math.round(box(x).width)), to: b.querySelector('.nm').getAttribute('href').replace(/-d_.*/, ''), left: Math.round(r.left), barTop: Math.round(box(b.querySelector('.pbar')).top), leaders: b.querySelectorAll('svg.ld path').length,
      fits: labs.every((e) => box(e).left >= r.left - 1 && box(e).right <= r.right + 1) && labs.every((x, i) => labs.every((y, j) => j <= i || box(x).right <= box(y).left || box(y).right <= box(x).left || box(x).bottom <= box(y).top || box(y).bottom <= box(x).top)) }; }));

// ---- a deal opens on Overview; while indexing it shows the folders counting up and nothing that is not there yet ----
{ const { ctx, page } = await fresh();
  const id = await newDeal(page, 'Proseware', ['C:\\Deals\\Proseware\\vdr', 'C:\\Deals\\Proseware\\advisor reports']); await page.waitForSelector('#ov-docs .dcrow');
  const at = await page.evaluate(() => ({ hash: location.hash, tabs: [...document.querySelectorAll('.dtabs a')].map((a) => a.textContent).join('|'), on: document.querySelector('.dtabs a.on').textContent, trail: document.querySelector('.trail').textContent, row: document.querySelector('.dealrow.on')?.getAttribute('href'), sub: [...document.querySelectorAll('.rail .sub a, .sub a')].map((a) => a.textContent.replace(/\d+$/, '')).join('|'), subOn: document.querySelectorAll('.sub a.on').length }));
  const tabs = at.tabs === 'Overview|Findings|Checklist|Q&A' && at.on === 'Overview';
  const onOverview = at.hash === `#overview-${id}` && tabs;
  // the sidebar lists the deal and none of its pages
  const listed = at.row === `#overview-${id}` && at.sub === '' && at.subOn === 0;
  say('a-deal-opens-on-overview', onOverview && listed && /^Home›Project Proseware·/.test(at.trail), JSON.stringify(at));
  await page.waitForFunction(() => { const m = /^([\d,]+) of ([\d,]+)/.exec(document.querySelector('#ov-docs .dcrow .rd')?.textContent ?? ''); return m && +m[1].replace(/,/g, '') > 0 && +m[1].replace(/,/g, '') < +m[2].replace(/,/g, ''); }, null, { timeout: 20000 });
  const ix = await docs(page); const m = ix.map((r) => /^([\d,]+) of ([\d,]+) indexed$/.exec(r.text)); const page0 = await page.evaluate(() => ({ brief: !!document.querySelector('.brieflet'), figs: !!document.getElementById('ov-standing'), core: !!document.getElementById('ov-core'), gaps: !!document.querySelector('.gaps'), line: document.querySelector('.emptyline')?.textContent, folders: !!document.getElementById('f-folders'), cards: !!document.querySelector('.folders') }));
  say('while-indexing-the-folders-count-up', ix.length === 3 && m.every(Boolean) && ix[0].name === '2 folders' && !ix[0].part && ix[1].part && ix[2].part && ix[1].name === 'vdr' && ix[2].name === 'advisor reports' && ix.every((r) => r.live && r.read === 0 && !r.cut) && Math.abs(num(m[0][1]) - num(m[1][1]) - num(m[2][1])) <= num(m[0][2]) * 0.05 && num(m[0][2]) === num(m[1][2]) + num(m[2][2]) && new Set(ix.map((r) => r.bar)).size === 1, JSON.stringify(ix));
  say('while-indexing-nothing-is-shown-that-is-not-there-yet', !page0.brief && !page0.figs && !page0.core && !page0.gaps && page0.line === 'Indexing' && page0.folders && !page0.cards && await noOverflow(page), JSON.stringify(page0));
  // the Checklist page before anything has been checked
  await page.click('.dtabs a:has-text("Checklist")');
  await page.waitForSelector('#ck-none');
  const early = await page.evaluate(() => ({
    text: document.getElementById('ck-none').textContent,
    filter: !!document.getElementById('ck-filter'),
    hash: location.hash.replace(/-d_.*/, ''),
    trail: document.querySelector('.trail').textContent.replace(/·.*/, ''),
    up: document.querySelector('.trail a:nth-of-type(2)')?.getAttribute('href').replace(/-d_.*/, ''),
    sub: document.querySelector('.dtabs a.on')?.textContent,
  }));
  // while indexing it says so, as Overview and Findings do
  say('checklist-before-the-first-pass', early.text === 'Indexing' && !early.filter && early.hash === '#checklist' && early.trail === 'Home›Project Proseware›Checklist' && early.up === '#overview' && early.sub === 'Checklist', JSON.stringify(early));
  await page.click('.trail a:nth-of-type(2)'); await page.waitForSelector('#ov-docs');

  // ---- after the first pass: findings, checklist and questions side by side; the gaps; and what has been read ----
  await page.waitForSelector('#ov-checklist', { timeout: 40000 }); await page.waitForSelector('#ov-core'); await page.waitForSelector('.gaps li span');
  const blocks = () => blocksOf(page);
  const ov = await page.evaluate(() => ({ heads: [...document.querySelectorAll('[role="heading"][aria-level="2"]')].map((e) => e.textContent).join('|'), gaps: [...document.querySelectorAll('.gaps li')].map((l) => `${l.querySelector('a').textContent} / ${l.querySelector('span')?.textContent ?? ''} > ${l.querySelector('a').getAttribute('href').replace(/-d_.*/, '')}`).join('|'), rows: document.querySelectorAll('.flagrow').length, check: document.getElementById('f-check')?.textContent, more: !!document.getElementById('deal-more'), line: !!document.querySelector('.emptyline'), tab: [...document.querySelectorAll('.dtabs a')].map((a) => a.textContent).join('|'), cols: [...document.querySelectorAll('.twocol.ov > div')].map((d) => Math.round(d.getBoundingClientRect().left)) }));
  const b0 = await blocks();
  say('overview-after-the-first-pass', ov.heads === 'Findings|Checklist|Q&A|Gaps in the Documents|Documents'
    && ov.gaps ===
    'Insurance advisor report (final) / The final report from the insurance advisor > #checklist|'
      + 'Executed direct agreement / A signed copy of the direct agreement > #checklist' && ov.rows === 0
        && ov.check === undefined && ov.more && !ov.line && ov.tab === 'Overview|Findings3 open|Checklist|Q&A'
        && ov.cols.length === 2 && ov.cols[0] < ov.cols[1], JSON.stringify(ov));
  say('findings-checklist-and-questions-side-by-side', b0.map((x) => `${x.title}: ${x.tot} / ${x.labs} [${x.bar}] ${x.to}`).join('\n') === 'Findings: 3 in all / 3 open [var(--high)] #deal\nChecklist: 24 in all / 5 to resolve · 3 flagged · 2 gaps|19 satisfied [var(--high)|var(--bar-ix)] #checklist\nQ&A: 0 in all / None yet [none] #qa'
    && b0[0].left < b0[1].left && b0[1].left < b0[2].left && new Set(b0.map((x) => x.barTop)).size === 1 && b0.every((x) => x.fits) && b0.map((x) => x.leaders).join() === '1,2,0' && Math.abs(b0[1].widths[1] / b0[1].widths[0] - 19 / 5) < 0.4, JSON.stringify(b0));
  const over = await page.evaluate(() => ({ details: [...document.querySelectorAll('#ov-details > div')].map((c) => Math.round(c.getBoundingClientRect().left)), blocks: [...document.querySelectorAll('#ov-standing .pcol')].map((c) => Math.round(c.getBoundingClientRect().left)), names: [...document.querySelectorAll('#ov-details .k')].map((e) => e.textContent).join(), above: document.getElementById('ov-details').getBoundingClientRect().bottom <= document.getElementById('ov-standing').getBoundingClientRect().top, under: document.getElementById('ov-details').getBoundingClientRect().top >= document.querySelector('.askslot').getBoundingClientRect().bottom }));
  say('the-deals-details-stand-over-the-three-blocks', over.names === 'Structure,Sector,Technology' && over.details.join() === over.blocks.join() && over.above && over.under, JSON.stringify(over));
  const rd = await docs(page); const r = rd.map((x) => /^([\d,]+) of ([\d,]+) read$/.exec(x.text)); const coreRows = rd.filter((x) => x.name === 'Core documents');
  const told = await page.evaluate((i) => { const f = store.get().progress[i].folders; return { n: f.length, core: f.reduce((a, x) => a + x.core, 0), coreRead: f.reduce((a, x) => a + x.coreRead, 0), each: f.every((x) => x.core > 0) }; }, id);
  say('documents-show-what-has-been-read-and-one-core-line-for-the-deal', rd.length === 4 && r.every(Boolean) && num(r[0][1]) === num(r[1][1]) + num(r[2][1]) && num(r[0][2]) === num(r[1][2]) + num(r[2][2]) && coreRows.length === 1 && !coreRows[0].part && told.n === 2 && told.each && num(r[3][1]) === told.coreRead && num(r[3][2]) === told.core && rd.every((x) => !x.live && !x.cut) && new Set(rd.map((x) => x.bar)).size === 1
    && rd.slice(0, 3).every((x, i) => Math.abs(x.read - num(r[i][1]) / num(r[i][2])) < 0.02 && x.read < 0.5) && Math.abs(rd[3].read - num(r[3][1]) / num(r[3][2])) < 0.02 && await noOverflow(page), JSON.stringify(rd));
  // under the blocks the two columns start level, and a document's bar is as long after the first pass as it was while indexing, with a small share still wide enough to see
  const barLen = (b) => { const [l, r] = b.split('-').map(Number); return r - l; };
  await page.waitForTimeout(500);                                        // the rows have finished arriving
  const level = await page.evaluate(() => { const hs = [...document.querySelectorAll('.twocol.ov .lbl.flagsl')].map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.height)]; }); const g = document.querySelector('.gaps.linked li')?.getBoundingClientRect(); const dr = document.querySelector('#ov-docs .dcrow')?.getBoundingClientRect(); return { hs, rows: [g ? Math.round(g.top) : null, dr ? Math.round(dr.top) : null], rv: [...document.querySelectorAll('#ov-docs .fbar .rv')].map((e) => e.getBoundingClientRect().width) }; });
  say('the-two-columns-under-the-blocks-start-level-and-a-bar-keeps-its-length', level.hs.length === 2 && level.hs[0][0] === level.hs[1][0] && level.hs[0][1] === level.hs[1][1] && level.rows[0] !== null && level.rows[0] === level.rows[1] && barLen(ix[0].bar) === barLen(rd[0].bar) && barLen(rd[0].bar) >= 96 && level.rv.every((w) => w >= 4), JSON.stringify({ level, was: ix[0].bar, now: rd[0].bar }));

  // ---- the numbers are counted from the things they name: findings and questions from their records ----
  // (closing a finding also resolves its checklist item, by a person: it leaves "to resolve", linking design 10.7)
  await page.evaluate(async (dealId) => { window.__check = { mark: 1 }; await store.checkEverything(dealId); delete window.__check;
    const f = Object.values(store.get().findings).find((x) => x.dealId === dealId && !x.updated); await store.dispatch(store.commandNamed('SetFindingStatus'), { dealId, findingId: f.id, status: 'closed', note: 'Confirmed' });
    for (const t of ['When was the term sheet signed?', 'Who is the offtaker?', 'Is the interconnection executed?']) await store.dispatch(store.commandNamed('CreateQuestion'), { dealId, text: t });
    const q = Object.values(store.get().questions).filter((x) => x.dealId === dealId); await store.dispatch(store.commandNamed('SetQuestionStatus'), { dealId, questionId: q[0].id, status: 'closed' }); }, id);
  await page.waitForFunction(() => /closed/.test(document.getElementById('ov-qa').textContent) && /closed/.test(document.getElementById('ov-findings').textContent));
  const b1 = await blocks(); const want = await page.evaluate((dealId) => { const f = Object.values(store.get().findings).filter((x) => x.dealId === dealId); const q = Object.values(store.get().questions).filter((x) => x.dealId === dealId); const n = (st) => q.filter((x) => x.status === st).length; return { f: [f.filter((x) => x.status === 'open').length, f.filter((x) => x.status === 'open' && x.updated).length, f.filter((x) => x.status === 'closed').length], q: [n('open'), n('answered'), n('closed')] }; }, id);
  say('findings-and-questions-are-counted-from-their-records', want.f.join() === '2,1,1' && want.q.join() === '2,0,1' && b1.map((x) => `${x.labs} [${x.bar}]`).join('\n') === '2 open · 1 may be out of date|1 closed [var(--high)|var(--bar-ix)]\n4 to resolve · 2 flagged · 2 gaps|20 settled · 19 satisfied · 1 by a person [var(--high)|var(--bar-ix)]\n2 open|1 closed [var(--high)|var(--bar-ix)]' && b1.every((x) => x.fits) && new Set(b1.map((x) => x.barTop)).size === 1, JSON.stringify({ want, b1 }));
  await page.click('#ov-findings .nm'); await page.waitForSelector('.flagrow'); const went = await page.evaluate(() => location.hash.replace(/-d_.*/, '')); await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-qa'); await page.click('#ov-qa .nm'); await page.waitForSelector('#qa-add'); const wentQ = await page.evaluate(() => location.hash.replace(/-d_.*/, ''));
  say('each-block-opens-its-page', went === '#deal' && wentQ === '#qa', JSON.stringify({ went, wentQ }));
  // every figure opens its page showing what it counts, and a gap opens the Checklist on the gaps
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-findings .plab .sub a'); await page.click('#ov-findings .plab .sub a'); await page.waitForSelector('.flagrow'); const fOnly = await page.evaluate(() => ({ st: store.get().ui.findingFilter.status, rows: [...document.querySelectorAll('.flagrow')].map((r) => !!r.querySelector('.upd')) }));
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('.gaps li a'); await page.click('.gaps li a'); await page.waitForSelector('#ck-rows .ckrow'); const gOnly = await page.evaluate(() => ({ on: document.querySelector('#ck-filter [aria-pressed="true"]').dataset.filter, rows: [...document.querySelectorAll('#ck-rows .ckrow')].map((r) => r.dataset.result).join() }));
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist .plab a.lo'); await page.click('#ov-checklist .plab a.lo'); await page.waitForSelector('#ck-rows .ckrow'); const leadTo = await page.evaluate(() => document.querySelector('#ck-filter [aria-pressed="true"]').dataset.filter);
  say('a-figure-opens-its-page-showing-what-it-counts', fOnly.st === 'reassess' && fOnly.rows.length === 1 && fOnly.rows[0] && gOnly.on === 'gap' && gOnly.rows === 'gap,gap' && leadTo === 'all', JSON.stringify({ fOnly, gOnly, leadTo }));
  // Check again is in the deal's ⋯ menu with when it was last checked; Overview's line shows only while a check is due: while one runs, and while what the latest check
  // could not reach, or that it did not finish, waits for a later check to clear it
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-standing');
  const line = () => page.evaluate(() => { const c = document.getElementById('ov-check'); if (!c) return ''; const w = c.querySelector('.when'); return `${w?.textContent ?? ''} [${c.querySelector('button').textContent}]${w?.classList.contains('warn') ? ' warn' : ''}`; });
  const menu = async () => { await page.click('#deal-more'); await page.waitForSelector('#deal-check'); const t = await page.textContent('#deal-check'); await page.keyboard.press('Escape'); await page.waitForSelector('#deal-check', { state: 'detached' }); return t; };
  const idle = await line(); const inMenu = await menu();
  // Check again is pressed once from the menu, to see what the line says while a check runs; the outcomes are then set off directly, so nothing depends on catching the button mid-press
  await page.evaluate(() => { window.__check = { unchecked: { items: 3, findings: 1 } }; }); await page.click('#deal-more'); await page.click('#deal-check'); await page.waitForSelector('#ov-check button[aria-disabled="true"]'); const during = await line(); await page.waitForSelector('#ov-check button:not([aria-disabled="true"])'); const left = await line();
  // what was left out is checked on its own; the mock then leaves nothing out, and the line goes
  await page.evaluate(() => { delete window.__check; }); const asked = await page.evaluate(() => { const ai = store.services.ai; const was = ai.checkAll.bind(ai); window.__asked = []; ai.checkAll = (i) => { window.__asked.push(i); return was(i); }; return true; });
  await page.click('#f-check-left'); await page.waitForFunction(() => window.__asked.length === 1 && !document.getElementById('ov-check')); const rest = await line(); const only = await page.evaluate(() => window.__asked[0].only); const focusAfter = await page.evaluate(() => document.activeElement?.id);   // the line has gone: the focus is on the ⋯, not the page
  const check = (hook, fail) => page.evaluate(async ([h, f, dealId]) => { window.__check = h; window.__fail = f; await store.checkEverything(dealId); delete window.__check; window.__fail = {}; }, [hook, fail, id]);
  await check({}, { checkAll: true }); const failed = await line(); await check({}, {}); const clear = await line();
  const D = '[A-Z][a-z]{2} \\d{1,2}';
  say('check-again-is-in-the-deal-menu-and-the-line-shows-only-when-due', idle === ''
    && new RegExp(`^Check AgainLast checked ${D}$`).test(inMenu)
    && during === 'Checking the checklist and findings [Checking]'
    && new RegExp(`^${D} check left out 3 checklist items and 1 finding \\[Check the 4 Left Out\\] warn$`).test(left)
    && new RegExp(`^The check on ${D} did not finish \\[Check Again\\] warn$`).test(failed) && clear === '',
    JSON.stringify({ idle, inMenu, during, left, failed, clear }));
  say('what-a-check-left-out-is-checked-on-its-own', asked && only === 'left' && rest === '' && focusAfter === 'deal-more', JSON.stringify({ only, rest, focusAfter }));
  // deleting a deal takes two pop-ups. The first says what to type, and its field reads as empty
  await openDelete(page);
  await page.waitForSelector('.dddlg');
  const dd = await page.evaluate(() => ({
    text: document.querySelector('.dddlg .ddtext').textContent,
    ph: document.getElementById('dd-name').placeholder,
    off: document.getElementById('dd-next').disabled,
    next: document.getElementById('dd-next').textContent,
  }));
  await page.keyboard.press('Escape');
  await page.waitForSelector('.dddlg', { state: 'detached' });
  say('the-delete-dialog-says-what-to-type', dd.text === 'Project Proseware will be deleted with its findings and its Q&A. Type Project Proseware to continue.' && dd.ph === 'Deal name' && dd.off && dd.next === 'Continue', JSON.stringify(dd));
  // the second asks once more, says it cannot be undone, and opens with the focus on the way out: Enter keeps the deal
  await openDelete(page);
  await page.fill('#dd-name', 'Project Proseware');
  await page.press('#dd-name', 'Enter');
  await page.waitForSelector('#dd-go');
  const sure = await page.evaluate(() => ({ title: document.getElementById('dd-title').textContent, text: document.querySelector('.dddlg .ddtext').textContent, focus: document.activeElement?.id, buttons: [...document.querySelectorAll('.dddlg .xfoot .btn')].map((b) => b.textContent).join('|'), field: !!document.getElementById('dd-name'), dialogs: document.querySelectorAll('.dddlg').length, inert: document.getElementById('app').inert }));
  await page.keyboard.press('Enter'); await page.waitForSelector('.dddlg', { state: 'detached' });
  const keptDeal = await page.evaluate(() => ({ there: Object.values(store.get().deals).some((d) => d.name === 'Project Proseware'), inert: document.getElementById('app').inert, toast: [...document.querySelectorAll('.toast')].some((t) => /deleted/.test(t.textContent)) }));
  say('the-second-pop-up-asks-once-more-and-opens-on-keep', sure.title === 'Delete Project Proseware for good?'
    && sure.text === 'Its findings and its Q&A will be deleted. This cannot be undone.' && sure.focus === 'dd-keep'
    && sure.buttons === 'Keep the Deal|Delete for Good' && !sure.field && sure.dialogs === 1 && sure.inert
    && keptDeal.there && !keptDeal.inert && !keptDeal.toast, JSON.stringify({ sure, keptDeal }));

  // ---- the Checklist page: flagged, gaps and satisfied, each its own group ----
  // (the item whose finding was closed above is resolved by a person: its own group, between gaps and satisfied; the row still carries the check's result)
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist'); await page.click('#ov-checklist .nm'); await page.waitForSelector('#ck-rows .ckrow');
  const all = await page.evaluate(() => ({ hash: location.hash.replace(/-d_.*/, ''), filters: [...document.querySelectorAll('#ck-filter button')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join('|'), order: [...document.querySelectorAll('#ck-rows .ckrow')].map((x) => x.dataset.result), first: document.querySelector('#ck-rows .ckrow .oc').textContent, sat: document.querySelector('#ck-rows .ckrow[data-result="satisfied"] .oc').textContent, checkMarks: document.querySelectorAll('#ck-rows .ckrow[data-result="satisfied"] .mk svg').length, edits: document.querySelectorAll('#ck-rows input, #ck-rows select, #ck-rows textarea').length, pane: !!document.getElementById('ck-detail'), stops: document.querySelectorAll('#ck-rows .ckrow[tabindex="0"]').length, groups: [...document.querySelectorAll('#ck-rows .ckgroup')].map((h) => `${h.textContent}@${h.nextElementSibling.dataset.result}`).join('|'), word: /Findings?/.test(document.getElementById('ck-filter').textContent + [...document.querySelectorAll('#ck-rows .ckgroup')].map((h) => h.textContent).join()) }));
  say('the-checklist-lists-every-item-in-its-group-flagged-first', all.hash === '#checklist'
    && all.filters === 'All 24*|Flagged 2|Gaps 2|Resolved by a Person 1|Satisfied 19'
    && all.order.join() === [...Array(2).fill('finding'), ...Array(2).fill('gap'), 'finding',
    ...Array(19).fill('satisfied')].join()
    && all.groups === 'Flagged2@finding|Gaps2@gap|Resolved by a Person1@finding|Satisfied19@satisfied' && !all.word
    && all.first === '' && all.sat === 'Model audit report.pdf, p. 39' && all.checkMarks === 19 && all.edits === 0
    && !all.pane && all.stops === 1, JSON.stringify(all));
  await page.click('#ck-filter [data-filter="gap"]');
  const g = await page.evaluate(() => ({ filters: [...document.querySelectorAll('#ck-filter button')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join('|'), rows: [...document.querySelectorAll('#ck-rows .ckrow')].map((x) => `${x.dataset.result}: ${x.querySelector('.it').textContent} / ${x.querySelector('.oc').textContent}`), groups: document.querySelectorAll('#ck-rows .ckgroup').length }));
  say('a-filter-shows-one-group-without-its-heading', g.filters ===
    'All 24|Flagged 2|Gaps 2*|Resolved by a Person 1|Satisfied 19' && g.groups === 0
    && g.rows.join('\n') ===
    'gap: Insurance advisor report (final) / Gap · The final report from the insurance advisor\n'
    + 'gap: Executed direct agreement / Gap · A signed copy of the direct agreement', JSON.stringify(g));
  // an item opens beside the list, like a question in the Q&A log: a gap says what is needed and can be asked about (#2); the list keeps to fewer words
  await page.click('#ck-rows .ckrow >> nth=0'); await page.waitForSelector('#ck-detail'); await page.waitForTimeout(350);
  const read = await page.evaluate(() => ({ text: document.getElementById('ck-read')?.textContent, tip: document.querySelector('#ck-read span')?.title, searches: [...document.querySelectorAll('#ck-read span')].slice(1).map((x) => `${x.textContent} / ${x.title}`) }));
  say('a-gap-says-what-was-read-names-a-scan-as-not-read-and-what-was-searched-for', read.text === 'Not found in the 3 documents read. Insurance certificate.pdf has no readable text and was not read. Searched for “insurance advisor report final”, “insurance due diligence report” and “lenders insurance advisor”.' && read.searches.join('|') === '“insurance advisor report final” / 3 documents answer to it|“insurance due diligence report” / 2 documents answer to it|“lenders insurance advisor” / No document answers to it' && read.tip === 'Insurance advisor report (draft).pdf, Technical advisor report.pdf, Information memorandum.pdf', JSON.stringify(read));
  const gp = await page.evaluate(() => { const R = (e) => { const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]; }; const d = document.getElementById('ck-detail'); const v = document.getElementById('view'); return { kind: d.querySelector('.dmeta .n').textContent, title: d.querySelector('.cktitle').textContent, need: document.getElementById('ck-need')?.textContent, list: R(document.getElementById('ck-rows')), det: R(d), row: document.querySelector('#ck-rows .ckrow.on .oc').textContent, sel: document.querySelector('#ck-rows .ckrow.on').getAttribute('aria-selected'), ask: !!document.getElementById('ck-ask'), page: v.scrollHeight - v.clientHeight, vw: innerWidth, vh: innerHeight }; });
  say('an-opened-gap-says-what-is-needed-beside-the-list', gp.kind === 'Gap' && gp.title === 'Insurance advisor report (final)' && gp.need === 'The final report from the insurance advisor' && gp.det[0] >= gp.list[2] - 1 && Math.abs(gp.det[1] - gp.list[1]) <= 1 && gp.det[2] <= gp.vw && gp.det[3] <= gp.vh && gp.row === '' && gp.sel === 'true' && gp.ask && gp.page <= 0, JSON.stringify(gp));
  // the arrow keys move what is open; Escape closes it and the focus stays on the item
  await page.keyboard.press('ArrowDown'); await page.waitForFunction(() => document.querySelector('#ck-detail .cktitle')?.textContent === 'Executed direct agreement');
  await page.keyboard.press('Escape'); await page.waitForSelector('#ck-detail', { state: 'detached' }); await page.waitForTimeout(100);
  const esc = await page.evaluate(() => ({ focus: document.activeElement?.querySelector?.('.it')?.textContent ?? '', wide: document.querySelector('.md.ck').classList.contains('wide') }));
  say('arrows-move-the-open-item-and-escape-closes-it', esc.focus === 'Executed direct agreement' && esc.wide, JSON.stringify(esc));
  await page.click('#ck-filter [data-filter="finding"]'); const fl = await page.evaluate(() => [...document.querySelectorAll('#ck-rows .ckrow')].map((x) => x.querySelector('.oc').textContent));
  // under the Flagged filter a row does not say Flagged again
  say('a-flagged-item-does-not-repeat-its-filter', fl.length === 2 && fl.every((x) => x === ''), JSON.stringify(fl));
  // opened, a flagged item names its finding, and the sponsor can be asked from there: the question is tied to the finding and the item says it was asked
  // (in the pane; beside it the row says nothing under the Flagged filter, so logging a question widens no column)
  await page.click('#ck-rows .ckrow >> nth=0'); await page.waitForSelector('#ck-ask');
  const fp = await page.evaluate(() => ({ kind: document.querySelector('#ck-detail .dmeta .n').textContent, finding: document.getElementById('ck-finding').textContent, lbl: [...document.querySelectorAll('#ck-detail .lbl')].map((l) => l.textContent).join('|'), open: document.getElementById('ck-open-finding').textContent, asked: !!document.getElementById('ck-asked') }));
  await page.click('#ck-ask'); await page.waitForSelector('#ck-ask-text'); const askFocus = await page.evaluate(() => document.activeElement.id); const logOff = await page.evaluate(() => document.getElementById('ck-ask-log').disabled);
  await page.fill('#ck-ask-text', 'Which operating assumption should the lenders rely on?'); await page.click('#ck-ask-log'); await page.waitForSelector('#ck-asked li');
  const fa = await page.evaluate((title) => { const f = Object.values(store.get().findings).find((x) => x.title === title); const q = Object.values(store.get().questions).find((x) => x.linkedFinding === f.id); return { q: q && { n: q.n, text: q.text, ws: q.workstream, status: q.status, fws: f.workstream }, asked: document.getElementById('ck-asked').textContent, row: document.querySelector('#ck-rows .ckrow.on .oc').textContent, card: !!document.getElementById('ck-ask-text'), toast: document.querySelector('#toast .ttext')?.textContent ?? '' }; }, 'Technical report and information memorandum disagree on the operating assumption');
  say('the-sponsor-can-be-asked-from-a-flagged-item-and-the-item-says-so', fp.kind === 'Flagged'
    && fp.finding === 'Technical report and information memorandum disagree on the operating assumption'
    && fp.lbl === 'Finding · Open' && fp.open === 'Open Finding' && !fp.asked && askFocus === 'ck-ask-text' && logOff
    && !!fa.q && fa.q.text === 'Which operating assumption should the lenders rely on?' && fa.q.ws === fa.q.fws
    && fa.q.status === 'open' && fa.asked === `Q${fa.q.n}openWhich operating assumption should the lenders rely on?` &&
    fa.row === '' && !fa.card, JSON.stringify({ fp, askFocus, logOff, fa }));
  await page.click('#ck-close'); await page.waitForSelector('#ck-detail', { state: 'detached' });
  const wideRow = await page.evaluate(() => document.querySelector('#ck-rows .ckrow .oc').textContent);
  // a satisfied item says where it was settled: the document, the page and the passage. The page opens, and closing it comes back to the item
  await page.click('#ck-filter [data-filter="satisfied"]'); await page.click('#ck-rows .ckrow >> nth=1'); await page.waitForSelector('#ck-sources');
  const sp = await page.evaluate(() => ({ kind: document.querySelector('#ck-detail .dmeta .n').textContent, title: document.querySelector('#ck-detail .cktitle').textContent, lbl: document.querySelector('#ck-detail .lbl').textContent, src: [...document.querySelectorAll('#ck-sources li')].map((li) => `${li.querySelector('.cdn').textContent} | ${li.querySelector('.clc').textContent} | ${li.querySelector('blockquote')?.textContent ?? ''}`) }));
  await page.click('#ck-sources .ckopen'); await page.waitForSelector('.docpanel'); await page.waitForTimeout(400);
  const rdg = await page.evaluate(() => ({ hash: location.hash.replace(/-d_.*/, ''), reading: document.body.classList.contains('reading'), aside: store.get().ui.docAside && { doc: store.get().ui.docAside.doc, loc: store.get().ui.docAside.loc, from: store.get().ui.docAside.from }, shown: document.querySelector('.docpanel')?.textContent.includes('Page 11') }));
  await page.click('#doc-close'); await page.waitForSelector('#ck-detail'); const backTo = await page.evaluate(() => ({ hash: location.hash.replace(/-d_.*/, ''), title: document.querySelector('#ck-detail .cktitle').textContent, filter: document.querySelector('#ck-filter [aria-pressed="true"]').textContent }));
  say('a-satisfied-item-says-where-it-was-settled-and-the-page-opens-and-comes-back', sp.kind === 'Satisfied' && sp.title === 'Construction contract is fixed price, date certain' && /^Settled on · checked /.test(sp.lbl) && sp.src.join() === 'EPC contract.pdf | p. 46 | The Contract Price is a fixed lump sum and the Contractor shall achieve Substantial Completion by the Scheduled Completion Date.' && rdg.hash === '#chat' && rdg.reading && rdg.aside.doc === 'EPC contract.pdf' && rdg.aside.loc === 'p. 46' && rdg.aside.from === 'From the checklist' && backTo.hash === '#checklist' && backTo.title === sp.title && backTo.filter === 'Satisfied 19', JSON.stringify({ sp, rdg, backTo, wideRow }));
  await page.click('#ck-close'); await page.click('#ck-filter [data-filter="all"]'); await page.evaluate(() => document.querySelector('#ck-rows .ckrow:last-child').scrollIntoView()); const last = await page.evaluate(() => { const bb = document.querySelector('#ck-rows .ckrow:last-child').getBoundingClientRect(); return bb.top >= 0 && bb.bottom <= innerHeight; });
  say('the-whole-checklist-can-be-reached', last && await noOverflow(page));
  await page.evaluate(() => document.querySelector('#ck-rows .ckrow').scrollIntoView()); await page.click('#ck-rows .ckrow >> nth=0'); await page.click('#ck-open-finding'); await page.waitForSelector('.opening'); const opened = await page.evaluate(() => ({ hash: location.hash.replace(/-d_.*/, ''), title: Object.values(store.get().findings).find((f) => location.hash.endsWith(f.id))?.title }));
  say('a-checklist-item-links-to-its-finding', opened.hash === '#finding' && opened.title === 'Technical report and information memorandum disagree on the operating assumption', JSON.stringify(opened));

  // ---- items that are not settled are shown on Overview apart from "to resolve" (flagged + gaps) and get a group of
  // their own ----
  await page.evaluate(async (dealId) => { const ai = store.services.ai; const p0 = ai.progress, c0 = ai.checklist;
    ai.progress = async (d) => { const x = await p0(d); x.value.checklist = { ...x.value.checklist, items: x.value.checklist.items + 2, unsettled: 2 }; return x; };
    ai.checklist = async (d) => { const x = await c0(d); x.value = [{ id: 'u1', text: 'Completion guarantee is in final form', result: 'unsettled', docs: [] }, ...x.value, { id: 'u2', text: 'Interconnection study has been completed', result: 'unchecked', docs: [] }]; return x; };
    await store.refreshProgress(dealId); await store.refreshChecklist(dealId); }, id);
  await page.goto(URL + '#overview-' + id); await page.waitForFunction(() => /not settled/.test(document.getElementById('ov-checklist')?.textContent ?? ''));
  const un = (await blocks())[1]; const due = await line();
  // the item opened above is still open, and an open item stays listed under any filter: closed, the filter shows its group alone
  await page.click('#ov-checklist .nm'); await page.waitForSelector('#ck-rows .ckrow'); await page.click('#ck-close'); await page.click('#ck-filter [data-filter="open"]'); const open = await page.evaluate(() => ({ filters: [...document.querySelectorAll('#ck-filter button')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join('|'), rows: [...document.querySelectorAll('#ck-rows .ckrow')].map((x) => `${x.querySelector('.it').textContent} / ${x.querySelector('.oc').textContent}`).join('\n') }));
  await page.click('#ck-filter [data-filter="all"]'); const order = await page.evaluate(() => [...document.querySelectorAll('#ck-rows .ckrow')].map((x) => x.dataset.result).join().replace(/(finding,)+/, 'F,').replace(/(gap,)+/, 'G,').replace(/(satisfied,?)+/, 'S'));
  const groups = await page.evaluate(() => [...document.querySelectorAll('#ck-rows .ckgroup')].map((h) => h.textContent).join('|'));
  say('items-not-settled-are-counted-and-listed-apart', `${un.labs} [${un.bar}]` ===
    '4 to resolve · 2 flagged · 2 gaps|2 not settled|20 settled · 19 satisfied · 1 by a person '
      + '[var(--high)|var(--accent)|var(--bar-ix)]'
    && un.fits
    && due === '1 checklist item not checked yet [Check Again] warn'
    && open.filters === 'All 26|Flagged 2|Gaps 2|Not Settled 2*|Resolved by a Person 1|Satisfied 19'
    && open.rows === 'Completion guarantee is in final form / Could not be checked\n'
      + 'Interconnection study has been completed / Not checked yet'
    && order === 'F,G,unsettled,unchecked,finding,S'
    && groups === 'Flagged2|Gaps2|Not Settled2|Resolved by a Person1|Satisfied19',
    JSON.stringify({ un, due, open, order, groups }));
  // ---- deleting the finding behind a flagged item leaves it to resolve, named beside flagged so the parts add up ----
  await page.evaluate(async (dealId) => { const st = store.get(); const r = st.checklists[dealId].find((x) => x.result === 'finding' && st.findings[x.findingId]?.status === 'open');
    await store.dispatch(store.commandNamed('DeleteFinding'), { dealId, findingId: r.findingId }); }, id);
  await page.goto(URL + '#overview-' + id); await page.waitForFunction(() => /1 finding deleted/.test(document.getElementById('ov-checklist')?.textContent ?? ''));
  const del = (await blocks())[1];
  say('a-deleted-finding-still-leaves-its-item-to-resolve', del.labs.split('|')[0] === '4 to resolve · 1 flagged · 2 gaps · 1 finding deleted' && del.fits, del.labs);
  // each part of the line opens the Checklist filtered to just what it counts: the filter that is on carries the same number
  const opens = async (text) => {
    await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist');
    // what a part is made of may be on its hover for want of room, so the link is pressed in the page, not by the pointer
    await page.evaluate((t) => [...document.querySelectorAll('#ov-checklist a')].find((a) => a.textContent === t).click(), text); await page.waitForSelector('#ck-filter button.on');
    return page.evaluate(() => [document.querySelector('#ck-filter button.on').textContent, document.querySelectorAll('#ck-rows .ckrow').length]);
  };
  const ck = { flagged: await opens('1 flagged'), deleted: await opens('1 finding deleted'), unsettled: await opens('2 not settled') };
  say('overview-parts-open-the-checklist-filter-of-the-same-count', ck.flagged.join() === 'Flagged 1,1'
    && ck.deleted.join() === 'Finding Deleted 1,1' && ck.unsettled.join() === 'Not Settled 2,2', JSON.stringify(ck));
  say('no-page-errors-overview', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// ---- Settings: which page a deal opens on ----
{ const { ctx, page } = await fresh();
  const id = await newDeal(page, 'Proseware', []); await page.waitForSelector('#add-first-folder');
  const empty = await page.evaluate(() => ({ hash: location.hash.replace(/-d_.*/, ''), line: document.querySelector('.emptyline').textContent, docs: !!document.getElementById('ov-docs'), figs: !!document.getElementById('ov-standing') }));
  say('overview-of-a-deal-with-no-folders', empty.hash === '#overview' && empty.line === 'No data room yet. Add folders' && !empty.docs && !empty.figs, JSON.stringify(empty));
  await page.click('#u-menu'); await page.waitForSelector('#s-landing'); const s0 = await page.evaluate(() => ({ label: document.getElementById('s-landing').closest('.srow').querySelector('.k').textContent, opts: [...document.querySelectorAll('#s-landing button')].map((b) => `${b.textContent}${b.getAttribute('aria-pressed') === 'true' ? '*' : ''}`).join('|'), fits: document.querySelector('.sdlg').getBoundingClientRect().bottom <= innerHeight }));
  say('settings-offers-every-page-of-a-deal', s0.label === 'Deals Open On'
    && s0.opts === 'Overview*|Findings|Checklist|Q&A' && s0.fits, JSON.stringify(s0));
  const hrefs = () => page.evaluate(() => ({ row: document.querySelector('.dealrow').getAttribute('href').replace(/-d_.*/, ''), pressed: document.querySelector('#s-landing [aria-pressed="true"]')?.textContent }));
  const seen = []; for (const [k, want] of [['findings', '#deal'], ['checklist', '#checklist'], ['qa', '#qa']]) { await page.click(`#s-landing [data-landing="${k}"]`); const h = await hrefs(); seen.push(`${h.pressed}:${h.row}:${h.row === want}`); }
  await page.click('#s-landing [data-landing="checklist"]'); await page.keyboard.press('Escape'); await page.waitForSelector('.sdlg', { state: 'detached' });
  await page.goto(URL + '#deals'); await page.waitForSelector('.dealrow'); const home = await page.getAttribute('.dealrow', 'href'); await page.click('.dealrow'); await page.waitForSelector('.ckpage #add-first-folder'); const landed = await page.evaluate(() => location.hash.replace(/-d_.*/, ''));
  say('every-link-that-opens-a-deal-follows-the-choice', seen.join() === 'Findings:#deal:true,Checklist:#checklist:true,Q&A:#qa:true' && home === `#checklist-${id}` && landed === '#checklist', JSON.stringify({ seen, home, landed }));
  await page.reload(); await page.waitForSelector('.dealrow'); const kept = await page.evaluate(() => ({ row: document.querySelector('.dealrow').getAttribute('href').replace(/-d_.*/, ''), pref: store.get().prefs.landing }));
  const id2 = await newDeal(page, 'Wingtip', ['reports'], '#new-deal'); await page.waitForSelector('#ck-none'); const made = await page.evaluate(() => location.hash);
  // the filter chosen on one deal's checklist does not follow the person to another deal
  await page.evaluate(() => store.ui({ checklistFilter: 'gap' })); await page.click('.dealrow:not(.on)'); await page.waitForFunction((i) => !location.hash.endsWith(i) && store.get().ui.route.dealId && store.get().ui.route.dealId !== i, id2); const carried = await page.evaluate(() => store.get().ui.checklistFilter);
  say('a-checklist-filter-stays-with-its-deal', carried === 'all', carried);
  // a deal with one folder has no line for the total
  await page.goto(URL + '#overview-' + id2); await page.waitForSelector('#ov-docs .dcrow'); const one = await docs(page);
  say('one-folder-has-no-total-line', one.filter((x) => x.name !== 'Core documents').length === 1 && one[0].name === 'reports' && !one[0].part, JSON.stringify(one));
  await page.click('#u-menu'); await page.waitForSelector('#s-landing'); await page.click('#s-landing [data-landing="overview"]'); await page.keyboard.press('Escape'); await page.goto(URL + '#deals'); await page.waitForSelector('.dealrow'); const back = await page.evaluate(() => [...document.querySelectorAll('.dealrow')].every((a) => a.getAttribute('href').startsWith('#overview-')));
  say('the-choice-is-remembered-and-new-deals-follow-it', kept.row === '#checklist' && kept.pref === 'checklist' && made === `#checklist-${id2}` && back, JSON.stringify({ kept, made, back }));
  say('no-page-errors-landing', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// ---- both themes, at the usual window and the smallest one: nothing is cut off and nothing spills ----
for (const scheme of ['light', 'dark']) for (const [w, h] of [[1280, 736], [1024, 640]]) { const { ctx, page } = await fresh(scheme, w, h); const tag = `${scheme}-${w}`;
  const id = await newDeal(page, 'Proseware', ['C:\\Deals\\Proseware\\vdr', 'C:\\Deals\\Proseware\\advisor reports']); await page.waitForSelector('#ov-checklist', { timeout: 60000 }); await page.waitForSelector('#ov-core');
  // with open questions as well as open findings, so both tabs carry a count: the widest the row of tabs gets
  await page.evaluate(async (dealId) => { for (const t of ['Who is the offtaker?', 'What is the tenor?']) await store.dispatch(store.commandNamed('CreateQuestion'), { dealId, text: t }); }, id); await page.waitForSelector('.dtabs a:has-text("2 open")'); await page.evaluate(() => document.querySelectorAll('#toast,.toast').forEach((e) => { e.remove(); })); await page.mouse.move(w - 30, h - 30); await page.waitForTimeout(300);
  const cols = await blocksOf(page);
  const lay = await page.evaluate(() => { const cut = (e) => e.scrollWidth > e.clientWidth + 1; const bg = (e) => getComputedStyle(e).backgroundColor; const bl = [...document.querySelectorAll('#ov-standing .pcol')];
    return { title: cut(document.querySelector('h1.ttl')), names: [...document.querySelectorAll('#ov-docs .fn')].some(cut), tabsOneRow: new Set([...document.querySelectorAll('.dtabs a')].map((a) => Math.round(a.getBoundingClientRect().top))).size === 1, headRow: document.querySelector('.headrow').getBoundingClientRect().height < 60,
      three: bl.length === 3 && bl[0].getBoundingClientRect().right < bl[1].getBoundingClientRect().left && bl[1].getBoundingClientRect().right < bl[2].getBoundingClientRect().left && new Set(bl.map((b) => Math.round(b.getBoundingClientRect().top))).size === 1, headsFit: bl.every((b) => !cut(b.querySelector('.tot'))),
      colsApart: document.querySelector('.twocol.ov > div').getBoundingClientRect().right < document.querySelector('.twocol.ov > div:last-child').getBoundingClientRect().left, heads: Math.abs(document.querySelector('.twocol.ov > div [role=heading]').getBoundingClientRect().top - document.querySelector('.twocol.ov > div:last-child [role=heading]').getBoundingClientRect().top) < 3,
      // the gaps and the documents stay in view at this size
      inView: document.querySelector('.gaps li') ? document.querySelector('.gaps li').getBoundingClientRect().top < innerHeight - 20 && document.querySelector('#ov-docs .dcrow').getBoundingClientRect().top < innerHeight - 20 : false,
      colors: [bg(document.querySelector('#ov-findings .pbar b')), bg(document.querySelector('.dcrow .fbar .rv')), bg(document.querySelector('.dcrow .fbar .ix')), bg(document.querySelector('#ov-checklist .pbar b:last-child')), getComputedStyle(document.querySelector('#ov-findings .plab .lo')).color] }; });
  say(`overview-fits-${tag}`, !lay.title && !lay.names && lay.tabsOneRow && lay.headRow && lay.three && lay.headsFit && cols.every((x) => x.fits) && new Set(cols.map((x) => x.barTop)).size === 1 && lay.colsApart && lay.heads && lay.inView && await noOverflow(page) && new Set(lay.colors.slice(0, 3)).size === 3 && lay.colors[3] === lay.colors[2] && lay.colors[4] === lay.colors[0] && lay.colors.every((c) => c !== 'rgba(0, 0, 0, 0)'), JSON.stringify({ lay, cols }));
  await page.click('#ov-checklist .nm'); await page.waitForSelector('#ck-rows .ckrow'); const ck = await page.evaluate(() => ({ filterInside: document.getElementById('ck-filter').getBoundingClientRect().right <= document.querySelector('.ckpage').getBoundingClientRect().right + 1, sameRow: Math.abs(document.getElementById('ck-filter').getBoundingClientRect().top + document.getElementById('ck-filter').getBoundingClientRect().height / 2 - document.querySelector('.ckpage [role=heading]').getBoundingClientRect().top - document.querySelector('.ckpage [role=heading]').getBoundingClientRect().height / 2) < 8, marks: [...document.querySelectorAll('#ck-rows .ckrow')].slice(0, 6).every((r2) => r2.querySelector('.mk').getBoundingClientRect().right <= r2.querySelector('.it').getBoundingClientRect().left) }));
  say(`checklist-fits-${tag}`, ck.filterInside && ck.sameRow && ck.marks && await noOverflow(page), JSON.stringify(ck));
  await page.click('.dtabs a:has-text("Findings")'); await page.waitForSelector('.flagrow'); const fi = await page.evaluate(() => ({ acts: [...document.querySelectorAll('.fhead .btn.act')].map((b) => b.textContent.trim()).join('|'), full: document.querySelector('.flags').getBoundingClientRect().width / document.querySelector('.askslot').getBoundingClientRect().width, gaps: !!document.querySelector('.gaps'), brief: !!document.querySelector('.brieflet') }));
  // New Finding is the one button; Import and Export are in its ⋯ menu
  const fullWidth = fi.acts === 'New Finding' && fi.full > 0.99 && !fi.gaps && !fi.brief && await noOverflow(page);
  say(`findings-has-the-full-width-${tag}`, fullWidth, JSON.stringify(fi));
  say(`no-page-errors-${tag}`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// ---- while other PCs share the check: the check line names the other person, or "three others" with who on hover ----
for (const scheme of ['light', 'dark']) { const { ctx, page } = await fresh(scheme);
  const id = await newDeal(page, 'Proseware', ['C:\\Deals\\Proseware\\vdr']); await page.waitForSelector('#ov-standing', { timeout: 60000 });
  // the backend says who else is in the check: here a stand-in for its answer, which the line asks for again every few seconds
  await page.evaluate(() => { const ai = store.services.ai; const was = ai.checked.bind(ai); ai.checked = async (d) => { const r = await was(d); return r.ok && window.__checking ? { ok: true, value: { ...r.value, checking: window.__checking } } : r; }; });
  const put = (checking) => page.evaluate(([d, c]) => { window.__checking = c; store.set({ ...store.get(), checks: { ...store.get().checks, [d]: { ...(store.get().checks[d] ?? { at: null, offerDeep: null }), busy: 'quick', checking: c } } }); }, [id, checking]);
  const sroe = { who: 'broe', pc: 'LAPTOP-7Q4M', same: false }, jdoeA = { who: 'jdoe', pc: 'LAPTOP-1A2B', same: true }, jdoeB = { who: 'jdoe', pc: 'DESKTOP-3C4D', same: true };
  await put({ with: [sroe], quiet: [] }); const one = await page.textContent('#f-checked');
  await put({ with: [sroe, jdoeA, jdoeB], quiet: [] }); const many = await page.textContent('#f-checked');
  await page.hover('#f-checked'); await page.waitForSelector('.tip'); const tip = await page.textContent('.tip');
  await page.waitForTimeout(3300); const after = await page.textContent('#f-checked');                     // still so after the line has asked again
  await page.screenshot({ path: `out/screens-checking/three-others-hover-${scheme}.png` });
  await page.evaluate(() => { window.__checking = { with: [], quiet: [] }; }); await page.waitForFunction(() => !document.querySelector('#f-checked').textContent.includes('others'), null, { timeout: 5000 });
  const tipGone = await page.evaluate(() => !document.querySelector('.tip'));                                // the names go with the line that named them
  await page.evaluate(() => { window.__checking = { with: [{ who: 'broe', pc: 'LAPTOP-7Q4M', same: false }, { who: 'jdoe', pc: 'LAPTOP-1A2B', same: true }, { who: 'jdoe', pc: 'DESKTOP-3C4D', same: true }], quiet: [] }; }); await page.waitForFunction(() => document.querySelector('#f-checked').textContent.includes('three others'), null, { timeout: 5000 });
  await page.mouse.move(5, 5); await page.focus('#f-checked'); await page.waitForSelector('.tip'); const keyTip = await page.textContent('.tip');
  await put({ with: [], quiet: [], waitingFor: sroe }); const waiting = await page.textContent('#f-checked');
  await put({ with: [sroe], quiet: [], signIn: true, retryUntil: new Date(Date.now() + 60000).toISOString() }); const signIn = await page.textContent('#f-checked');
  say(`checking-names-the-other-person-${scheme}`, one === 'Checking the checklist and findings with broe', one);
  say(`checking-with-three-others-shows-who-on-hover-and-on-focus-${scheme}`, many === 'Checking the checklist and findings with three others' && after === many && tip === 'broe, jdoe (LAPTOP-1A2B) and jdoe (DESKTOP-3C4D)' && keyTip === tip, JSON.stringify({ many, after, tip, keyTip }));
  say(`checking-names-go-when-the-others-do-${scheme}`, tipGone);
  say(`checking-waiting-names-whose-check-${scheme}`, waiting === 'Waiting for broe’s check to finish', waiting);
  say(`checking-says-it-waits-for-sign-in-${scheme}`, signIn === 'Waiting for Intelligence sign-in. The check resumes once someone signs in', signIn);
  say(`no-page-errors-checking-${scheme}`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// Fill the rendered state with deal-scale counts without indexing thousands of files or writing thousands of records.
for (const [scheme, width, height] of [['light', 1280, 736], ['dark', 1024, 640]]) {
  const { ctx, page } = await fresh(scheme, width, height, 'de-DE');
  const id = await newDeal(page, 'Large deal', []);
  await page.waitForFunction((dealId) => {
    const { dealLoad, progress, checklists } = store.get();
    return dealLoad[dealId] === 'loaded' && progress[dealId] && checklists[dealId];
  }, id);
  await page.evaluate((dealId) => {
    const state = store.get();
    const deal = state.deals[dealId];
    const deals = { ...state.deals };
    const members = { ...state.members };
    const findings = {};
    const questions = {};
    const actor = encodeURIComponent(state.user.name.trim().toLowerCase());
    for (let index = 1; index <= 2000; index++) {
      const suffix = String(index).padStart(26, '0');
      const otherId = `d_${suffix}`;
      deals[otherId] = { ...deal, id: otherId, name: `Project ${index}`, group: 'monitor' };
      members[`m_${otherId}_${actor}`] = { on: true };
      questions[`q_${suffix}`] = { dealId, n: index, status: index <= 1000 ? 'open' : 'closed' };
      if (index <= 1001) findings[`f_${suffix}`] = { dealId, status: 'open' };
    }
    const folders = [{ path: 'reports', label: 'Reports', files: 2000, indexed: 1277 }];
    deals[dealId] = { ...deal, stage: 'indexing', folders };
    store.set({
      ...state, deals, members, findings, questions,
      firmList: { general: { name: 'General', layer: 'broad', items: Array(2000).fill({}) } },
      progress: { [dealId]: { folders: [], checklist: { items: 2000, gaps: 1277, findings: 0,
        unsettled: 0, satisfied: 723 } } },
      checklists: {},
      ui: { ...state.ui, indexStalled: [dealId], settings: true },
    });
  }, id);
  const counts = await page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent.trim();
    return {
      locale: navigator.language,
      settings: text('#s-checklist'),
      findings: text('.dtabs a[href^="#deal-"] span'),
      questions: text('.dtabs a[href^="#qa-"] span'),
      groups: [...document.querySelectorAll('#rail-nav .grp-h .cnt')].map((element) => element.textContent),
      questionTotal: text('#ov-qa .tot'),
      checklist: text('#ov-checklist .tot'),
      resolve: text('#ov-checklist .plab .lo'),
      gaps: text('#ov-checklist .plab .sub a'),
      documents: text('#ov-docs .dcrow .rd'),
      stopped: text('#ix-stalled'),
    };
  });
  await page.evaluate(() => {
    const state = store.get();
    const general = state.firmList.general;
    store.set({ ...state, firmList: { general: { ...general, items: general.items.slice(0, 1) } } });
  });
  const oneItem = await page.textContent('#s-checklist');
  say(`settings-tab-and-sidebar-counts-have-thousands-commas-${scheme}`, counts.locale === 'de-DE'
    && counts.settings === 'General · 2,000 items Open' && counts.findings === '1,001 open'
    && counts.questions === '1,000 open' && counts.groups.join('|') === '1|2,000', JSON.stringify(counts));
  say(`settings-uses-the-singular-for-one-checklist-item-${scheme}`, oneItem === 'General · 1 item Open', oneItem);
  say(`overview-and-stopped-indexing-use-en-us-counts-${scheme}`, counts.locale === 'de-DE'
    && counts.questionTotal === '2,000 in all' && counts.checklist === '2,000 in all'
    && counts.resolve === '1,277 to resolve' && counts.gaps === '1,277 gaps'
    && counts.documents === '1,277 of 2,000 indexed · stopped'
    && counts.stopped === 'Indexing stopped at 1,277 of 2,000 files. Resume', JSON.stringify(counts));
  say(`no-page-errors-count-formatting-${scheme}`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
