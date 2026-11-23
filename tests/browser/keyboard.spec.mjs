// Keyboard and reading aids, driven the way a person without a mouse would: Tab, arrows, Enter, Escape.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { followUp } from './followUp.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
async function start(scheme = 'dark', name = 'Proseware') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  return { ctx, page, id: await page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === 'Project ' + n).id, name) };
}
const active = (page) => page.evaluate(() => { const a = document.activeElement; return a ? (a.id ? '#' + a.id : a.tagName + (a.className && typeof a.className === 'string' ? '.' + a.className.trim().split(/\s+/).join('.') : '')) : null; });
const activeText = (page) => page.evaluate(() => (document.activeElement?.textContent ?? '').trim());
const toastsGone = (page) => page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 12000 });
const newQ = (page, dealId, text) => page.evaluate(async ([d, t]) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => store.get().questions[x]); }, [dealId, text]);
const lum = `(c) => { const f = (x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }`;

for (const scheme of ['dark', 'light']) {
  const { ctx, page, id } = await start(scheme);
  await toastsGone(page);
  const fs = await page.evaluate((d) => Object.values(store.get().findings).filter((x) => x.dealId === d).sort((a, b) => ['Technical', 'Lock-up', 'Revenue'].findIndex((t) => a.title.startsWith(t)) - ['Technical', 'Lock-up', 'Revenue'].findIndex((t) => b.title.startsWith(t))).map((f) => f.id), id);

  // ---- getting to the page -------------------------------------------------------------------------------------------
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask');
  const firstInRail = await page.evaluate(() => { const el = document.querySelector('.rail button, .rail a'); el.focus(); return document.activeElement === el; });
  await page.keyboard.press('Shift+Tab'); const firstStop = await active(page); await page.waitForTimeout(250); const skipShown = await page.evaluate(() => { const r = document.getElementById('skip').getBoundingClientRect(); return r.top >= 0 && r.height > 20; });
  await page.keyboard.press('Enter'); const afterSkip = await active(page);
  say(`${scheme}:the-stop-before-the-rail-skips-to-the-page`, firstInRail && firstStop === '#skip' && skipShown && afterSkip === '#view', JSON.stringify({ firstStop, skipShown, afterSkip }));
  // a link that goes with its page (the Overview's Findings heading): the new page takes the focus
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-findings .nm');
  await page.focus('#ov-findings .nm'); await page.keyboard.press('Enter'); await page.waitForSelector('#ov-findings', { state: 'detached' }); await page.waitForTimeout(150);
  const afterNav = await active(page); await page.keyboard.press('Tab'); const nextStop = await page.evaluate(() => !!document.activeElement.closest('#view'));
  say(`${scheme}:a-new-page-takes-the-focus`, afterNav === '#view' && nextStop, JSON.stringify({ afterNav, nextStop }));
  // ---- search: a second Ctrl K takes the cursor out of search and back to where it was ------------------------------------
  const wasAt = await page.evaluate(() => { window.__was = document.activeElement; return document.activeElement !== document.body; });
  await page.keyboard.press('Control+k'); const kIn = await active(page); await page.keyboard.press('Control+k'); await page.waitForTimeout(80);
  const kBack = await page.evaluate(() => document.activeElement === window.__was);
  say(`${scheme}:a-second-ctrl-k-gives-the-focus-back`, wasAt && kIn === '#pal-in' && kBack, JSON.stringify({ wasAt, kIn, kBack, now: await active(page) }));

  // ---- menus: focus goes in, arrows move, Escape and Tab leave, choosing gives the focus back --------------------------
  // a menu opened the moment its page appears stays open: nothing run after the first paint closes it again
  const atOnce = await page.evaluate(async (h) => { const seen = new Promise((r) => { const mo = new MutationObserver(() => { const b = document.getElementById('f-status'); if (b) { mo.disconnect(); b.click(); r(); } }); mo.observe(document.body, { childList: true, subtree: true }); }); location.hash = h; await seen; await new Promise((r) => setTimeout(r, 400)); return !!document.querySelector('.stmenu'); }, `#finding-${id}-${fs[1]}`);
  say(`${scheme}:a-menu-opened-at-once-stays-open`, atOnce); await page.keyboard.press('Escape');
  await page.goto(URL + `#finding-${id}-${fs[0]}`); await page.waitForSelector('#f-status'); const hash0 = await page.evaluate(() => location.hash);
  await page.focus('#f-status'); await page.keyboard.press('Enter'); await page.waitForSelector('.stmenu');
  const m1 = await activeText(page); await page.keyboard.press('ArrowDown'); const m2 = await activeText(page); await page.keyboard.press('ArrowDown'); const m3 = await activeText(page);
  await page.keyboard.press('End'); const m4 = await activeText(page); await page.keyboard.press('Home'); const m5 = await activeText(page);
  await page.keyboard.press('Escape'); const mEsc = { open: !!(await page.$('.stmenu')), focus: await active(page), hash: await page.evaluate(() => location.hash) };
  say(`${scheme}:arrows-move-inside-a-menu`, m1 === 'Open' && m2 === 'Closed' && m3 === 'Open' && m4 === 'Closed' && m5 === 'Open' && !mEsc.open && mEsc.focus === '#f-status' && mEsc.hash === hash0, JSON.stringify({ m1, m2, m3, m4, m5, mEsc }));
  await page.keyboard.press('Enter'); await page.waitForSelector('.stmenu'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForSelector('#fnote-text');
  const noteFocus = await active(page); await page.keyboard.press('Escape'); await page.waitForSelector('#fnote-text', { state: 'detached' }); await page.waitForTimeout(80);
  say(`${scheme}:choosing-opens-the-note-with-focus-and-escape-returns`, noteFocus === '#fnote-text' && (await active(page)) === '#f-status', JSON.stringify({ noteFocus, back: await active(page) }));
  // the model menu: choosing an item puts the focus back on its button
  await page.focus('.mwrap .scopebtn'); await page.keyboard.press('Enter'); await page.waitForSelector('.mmenu'); const mm1 = await activeText(page); await page.keyboard.press('ArrowDown'); const mm2 = await activeText(page); await page.keyboard.press('Enter');
  await page.waitForSelector('.mmenu', { state: 'detached' }); await page.waitForTimeout(80);
  const mmBack = await page.evaluate(() => document.activeElement?.closest('.mwrap') && document.activeElement.getAttribute('aria-haspopup'));
  say(`${scheme}:choosing-in-a-menu-gives-the-focus-back-to-its-button`, mm1 === 'Standard' && mm2 === 'Thorough' && mmBack === 'menu' && (await page.evaluate(() => store.get().model)) === 'thorough', JSON.stringify({ mm1, mm2, mmBack }));
  await page.evaluate(() => store.setPrefs({ model: 'standard' }));

  // ---- a citation: named with its source, Escape puts the popup away, Enter opens the document --------------------------
  await page.focus('.opening .ref .rb'); await page.waitForTimeout(60);
  const cite = await page.evaluate(() => { const rb = document.activeElement; const pop = document.getElementById(rb.getAttribute('aria-describedby')); return { described: !!pop && /\.pdf/.test(pop.textContent), shown: !!pop && getComputedStyle(pop).display !== 'none' }; });
  await page.keyboard.press('Escape'); await page.waitForTimeout(60);
  const citeEsc = await page.evaluate(() => { const rb = document.activeElement; const pop = document.getElementById(rb?.getAttribute('aria-describedby') ?? ''); return { still: !!rb?.classList.contains('rb'), shown: !!pop && getComputedStyle(pop).display !== 'none' }; });
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await page.waitForTimeout(60);
  const citeBack = await page.evaluate(() => { const rb = document.activeElement; const pop = document.getElementById(rb?.getAttribute('aria-describedby') ?? ''); return !!pop && getComputedStyle(pop).display !== 'none'; });
  say(`${scheme}:a-citation-names-its-source-and-escape-puts-the-popup-away`, cite.described && cite.shown && citeEsc.still && !citeEsc.shown && citeBack, JSON.stringify({ cite, citeEsc, citeBack }));
  // ---- the document: arrows step, its menu takes arrows, Escape goes back to the citation ------------------------------
  await page.focus('.opening .ref .rb'); await page.keyboard.press('Enter'); await page.waitForSelector('.docpanel');
  const loc0 = await page.textContent('#doc-menu .loc'); await page.keyboard.press('ArrowRight'); await page.waitForFunction((l) => document.querySelector('#doc-menu .loc')?.textContent !== l, loc0);
  const loc1 = await page.textContent('#doc-menu .loc'); await page.keyboard.press('ArrowLeft'); await page.waitForFunction((l) => document.querySelector('#doc-menu .loc')?.textContent !== l, loc1);
  const stepped = { loc0, loc1, back: await page.textContent('#doc-menu .loc'), label: await page.getAttribute('.docpanel', 'aria-label'), hash: await page.evaluate(() => location.hash) };
  say(`${scheme}:left-and-right-step-through-the-documents`, stepped.loc0 !== stepped.loc1 && stepped.back === stepped.loc0 && stepped.label === 'Document' && stepped.hash === hash0, JSON.stringify(stepped));
  await page.focus('#doc-menu'); await page.keyboard.press('Enter'); await page.waitForSelector('.docmenu');
  const dm1 = await page.evaluate(() => ({ inMenu: !!document.activeElement.closest('.docmenu'), current: document.activeElement.getAttribute('aria-current') })); await page.keyboard.press('ArrowDown');
  const dm2 = await page.evaluate(() => ({ inMenu: !!document.activeElement.closest('.docmenu'), current: document.activeElement.getAttribute('aria-current') }));
  await page.keyboard.press('Escape'); const dmEsc = { menu: !!(await page.$('.docmenu')), doc: !!(await page.$('.docpanel')), focus: await active(page), hash: await page.evaluate(() => location.hash) };
  say(`${scheme}:the-document-list-takes-arrows-and-escape-closes-only-it`, dm1.inMenu && dm1.current === 'page' && dm2.inMenu && dm2.current !== 'page' && !dmEsc.menu && dmEsc.doc && dmEsc.focus === '#doc-menu' && dmEsc.hash === hash0, JSON.stringify({ dm1, dm2, dmEsc }));
  await page.keyboard.press('Escape'); await page.waitForSelector('.docpanel', { state: 'detached' }); await page.waitForTimeout(80);
  const closed = await page.evaluate(() => { const rb = document.activeElement; const pop = document.getElementById(rb?.getAttribute('aria-describedby') ?? ''); return { onCitation: !!rb?.classList.contains('rb'), inOpening: !!rb?.closest('.opening'), popup: !!pop && getComputedStyle(pop).display !== 'none' }; });
  say(`${scheme}:closing-the-document-returns-to-the-citation`, closed.onCitation && closed.inOpening && !closed.popup, JSON.stringify(closed));
  // opened from the phrase by keyboard: its popup steps aside for the document, and one Escape closes the document
  await page.keyboard.press('Enter'); await page.waitForSelector('.docpanel'); await page.waitForTimeout(80);
  const reading = await page.evaluate(() => { const rb = document.activeElement; const pop = document.getElementById(rb?.getAttribute('aria-describedby') ?? ''); return { onCitation: !!rb?.classList.contains('rb'), popup: !!pop && getComputedStyle(pop).display !== 'none' }; });
  await page.keyboard.press('Escape'); await page.waitForTimeout(150); const oneEsc = { doc: !!(await page.$('.docpanel')), onCitation: await page.evaluate(() => !!document.activeElement?.classList.contains('rb')) };
  say(`${scheme}:one-escape-closes-a-document-opened-from-its-phrase`, reading.onCitation && !reading.popup && !oneEsc.doc && oneEsc.onCitation, JSON.stringify({ reading, oneEsc }));
  // from the composer, Escape closes the document too
  await page.keyboard.press('Enter'); await page.waitForSelector('.docpanel'); await page.focus('#pask'); await page.keyboard.type('half a thought'); await page.keyboard.press('Escape'); await page.waitForSelector('.docpanel', { state: 'detached' });
  say(`${scheme}:escape-in-the-composer-closes-the-document-and-keeps-the-text`, (await page.inputValue('#pask')) === 'half a thought');
  await page.fill('#pask', '');
  // ---- search beside the folded rail: Tab and Shift Tab go on from where the rail's own field would be (the stop before it here is Skip) ----
  const tabbed = []; for (const key of ['Tab', 'Shift+Tab']) { await page.focus('#f-status'); await page.keyboard.press('Control+k'); await page.waitForSelector('#pal-in'); await page.keyboard.type('lock'); await page.waitForSelector('#pal-drop'); await page.keyboard.press(key); await page.waitForSelector('#pal-in', { state: 'detached' }); await page.waitForTimeout(80); tabbed.push(await active(page)); }
  say(`${scheme}:tab-out-of-search-beside-the-folded-rail-goes-on-from-its-place`, tabbed.join() === '#rt-search,#skip', JSON.stringify(tabbed));

  // ---- the queue strip opens for the keyboard as it does for the pointer -----------------------------------------------
  await page.evaluate(() => document.activeElement?.blur?.()); await page.focus('#rt-settings'); await page.keyboard.press('Tab');
  let hops = 0; while (hops++ < 6 && !(await page.evaluate(() => !!document.activeElement?.closest('.qgrid')))) await page.keyboard.press('Tab');
  await page.waitForTimeout(350);
  const strip = await page.evaluate(() => ({ inGrid: !!document.activeElement?.closest('.qgrid'), open: document.body.classList.contains('qopen'), h: Math.round(document.activeElement.getBoundingClientRect().height), text: !!(document.activeElement.textContent || '').trim(), searchTab: document.getElementById('qsearch').tabIndex }));
  await page.focus('#pask'); await page.waitForTimeout(350);
  const stripAfter = await page.evaluate(() => ({ open: document.body.classList.contains('qopen'), searchTab: document.getElementById('qsearch').tabIndex }));
  say(`${scheme}:the-queue-strip-opens-on-keyboard-focus`, strip.inGrid && strip.open && strip.h >= 20 && strip.text && strip.searchTab === 0 && !stripAfter.open && stripAfter.searchTab === -1, JSON.stringify({ strip, stripAfter }));

  // the queue is one stop for Tab; the arrow keys move within it without opening anything
  await page.evaluate(() => document.activeElement?.blur?.()); await page.focus('#rt-settings'); hops = 0; while (hops++ < 6 && !(await page.evaluate(() => !!document.activeElement?.closest('.qgrid')))) await page.keyboard.press('Tab');
  const q0 = await page.evaluate(() => ({ stops: document.querySelectorAll('.qgrid .g[tabindex="0"]').length, n: document.querySelectorAll('.qgrid .g').length, at: [...document.querySelectorAll('.qgrid .g')].indexOf(document.activeElement), on: document.activeElement.classList.contains('on'), hash: location.hash }));
  await page.keyboard.press('ArrowDown'); const q1 = await page.evaluate(() => ({ at: [...document.querySelectorAll('.qgrid .g')].indexOf(document.activeElement), hash: location.hash }));
  await page.keyboard.press('Home'); const q2 = await page.evaluate(() => [...document.querySelectorAll('.qgrid .g')].indexOf(document.activeElement));
  await page.keyboard.press('Tab'); const q3 = await page.evaluate(() => !!document.activeElement?.closest('.qgrid'));
  say(`${scheme}:the-queue-is-one-tab-stop-and-arrows-move-within-it`, q0.stops === 1 && q0.n > 1 && q0.on && q1.at === Math.min(q0.n - 1, q0.at + 1) && q1.hash === q0.hash && q2 === 0 && !q3, JSON.stringify({ q0, q1, q2, q3 }));
  await page.focus('#pask'); await page.waitForTimeout(350);

  // ---- cards opened in the conversation take the focus and give it back ------------------------------------------------
  await followUp(page, 'Why does this matter?');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed) .acts', { timeout: 10000 });
  await page.focus('.msgs .ai .acts button[aria-label="Add as question"]'); await page.keyboard.press('Enter'); await page.waitForSelector('.card.addq');
  const cardFocus = await active(page); await page.keyboard.press('Escape'); await page.waitForSelector('.card.addq', { state: 'detached' }); await page.waitForTimeout(80);
  say(`${scheme}:a-card-takes-the-focus-and-escape-gives-it-back`, cardFocus === '#aq-text' && (await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Add as question', JSON.stringify({ cardFocus }));
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('#f-new'); await page.focus('#f-new'); await page.keyboard.press('Enter'); await page.waitForSelector('.card.addf');
  const nfFocus = await active(page); await page.keyboard.type('Half typed'); await page.keyboard.press('Escape'); await page.waitForSelector('.card.addf', { state: 'detached' }); await page.waitForTimeout(80);
  say(`${scheme}:new-finding-takes-the-focus-and-escape-returns-to-its-button`, nfFocus === '#af-title' && (await active(page)) === '#f-new', JSON.stringify({ nfFocus, back: await active(page) }));

  // ---- dialogs start where the typing goes ---------------------------------------------------------------------------
  await page.focus('#u-menu'); const uName = await page.getAttribute('#u-menu', 'aria-label'); await page.keyboard.press('Enter'); await page.waitForSelector('#s-title');
  const sFocus = await page.evaluate(() => ({ close: document.activeElement.id === 's-close', inDialog: !!document.activeElement.closest('.dlg'), text: document.activeElement.textContent }));
  const avatar = await page.evaluate(`(() => { const lum = ${lum}; const rgb = (v) => v.match(/[\\d.]+/g).slice(0, 3).map((x) => +x / 255); const cs = getComputedStyle(document.getElementById('s-ini')); const a = lum(rgb(cs.color)), b = lum(rgb(cs.backgroundColor)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); })()`);
  await page.keyboard.press('Escape'); await page.waitForSelector('#s-title', { state: 'detached' });
  say(`${scheme}:settings-opens-on-its-first-control-and-names-its-button`, !sFocus.close && sFocus.inDialog && sFocus.text === 'Match Windows' && uName === 'jdoe · Settings' && (await active(page)) === '#u-menu', JSON.stringify({ sFocus, uName }));
  say(`${scheme}:settings-initials-can-be-read`, avatar >= 4.5, avatar.toFixed(2));
  // ⋯, then its last item, Delete deal…
  await page.focus('#deal-more');
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#dd-name');
  await page.keyboard.type('Project Pros');
  const ddTyped = await page.inputValue('#dd-name'); await page.keyboard.press('Escape'); await page.waitForSelector('#dd-name', { state: 'detached' });
  say(`${scheme}:delete-deal-opens-in-its-name-field`, ddTyped === 'Project Pros', ddTyped);
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#f-folders'); await page.focus('#f-folders'); await page.keyboard.press('Enter'); await page.waitForSelector('#nd-title');
  const fdFocus = await active(page);
  await page.waitForFunction((dealId) => store.get().deals[dealId]?.stage === 'ready', id, { timeout: 30000 });
  for (const files of [0, 1, 2]) {
    await page.evaluate(async ([dealId, count]) => {
      const deal = store.get().deals[dealId];
      const folders = deal.folders.map((folder, i) => i ? folder : { ...folder, files: count, indexed: count });
      await store.dispatch(store.commandNamed('RecordIndexingProgress'), {
        dealId, folders, log: deal.log, done: true,
      }, { quiet: true });
    }, [id, files]);
    const expected = `${files} ${files === 1 ? 'file' : 'files'}`;
    await page.waitForFunction((text) => document.querySelector('#folders .cnt')?.textContent === text, expected);
    const countText = await page.$eval('#folders .cnt', (e) => e.textContent);
    say(`${scheme}:folder-count-uses-the-right-singular-${files}`, countText === expected, countText);
  }
  for (const files of [0, 1, 2]) {
    await page.evaluate((count) => {
      const ui = store.get().ui;
      store.ui({ newDeal: { ...ui.newDeal, folders: [{
        path: 'incoming', label: 'incoming', files: count, size: '0.0 GB',
      }] } });
    }, files);
    const expected = `${files} ${files === 1 ? 'file' : 'files'} · 0.0 GB`;
    await page.waitForFunction((text) =>
      document.querySelector('#folders-waiting .cnt')?.textContent === text, expected);
    const waitingCount = await page.$eval('#folders-waiting .cnt', (e) => e.textContent);
    say(`${scheme}:waiting-folder-count-uses-the-right-singular-${files}`, waitingCount === expected, waitingCount);
  }
  await page.keyboard.press('Escape');
  await page.waitForSelector('#nd-title', { state: 'detached' });
  say(`${scheme}:folders-opens-on-choose-folders`, fdFocus === '#nd-browse' && (await active(page)) === '#f-folders', JSON.stringify({ fdFocus, back: await active(page) }));
  await page.focus('#new-deal'); await page.keyboard.press('Enter'); await page.waitForSelector('#add-new'); await page.focus('#add-new'); await page.keyboard.press('Enter'); await page.waitForSelector('#nd-name'); await page.focus('#nd-paste'); await page.keyboard.press('Enter'); await page.waitForSelector('#nd-path'); await page.waitForTimeout(80);
  const pathPlaceholder = await page.getAttribute('#nd-path', 'placeholder');
  say(`${scheme}:paste-path-shows-atlas-1370`, pathPlaceholder === 'C:\\Deals\\Atlas\\VDR export', pathPlaceholder);
  const pasteFocus = await active(page); await page.keyboard.press('Escape'); await page.waitForSelector('#nd-title', { state: 'detached' });
  say(`${scheme}:paste-a-path-puts-the-focus-in-its-field`, pasteFocus === '#nd-path', pasteFocus);
  // Check again from the deal's ⋯ menu: the focus goes back to the ⋯ and stays there while the check runs and after
  const onMore = () => page.evaluate(() => document.activeElement === document.getElementById('deal-more'));
  await page.focus('#deal-more'); await page.keyboard.press('Enter'); await page.waitForSelector('#deal-check'); await page.focus('#deal-check'); await page.keyboard.press('Enter'); await page.waitForSelector('#ov-check button[aria-disabled="true"]');
  const chkDuring = await onMore(); await page.waitForFunction(() => !document.querySelector('#ov-check button[aria-disabled="true"]'), null, { timeout: 10000 }); const chkAfter = await onMore();
  say(`${scheme}:check-again-keeps-the-focus-while-it-checks`, chkDuring && chkAfter, JSON.stringify({ chkDuring, chkAfter, now: await active(page) }));
  await toastsGone(page);

  // ---- the question list: Home, End, and Escape on the Draft all confirmation -------------------------------------------
  for (const t of ['First question', 'Second question', 'Third question', 'Fourth question']) await newQ(page, id, t);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li'); await toastsGone(page);
  await page.focus('.md .li[tabindex="0"]'); await page.keyboard.press('End'); await page.waitForTimeout(80); const atEnd = await page.evaluate(() => document.activeElement.querySelector('.n')?.textContent);
  await page.keyboard.press('Home'); await page.waitForTimeout(80); const atHome = await page.evaluate(() => document.activeElement.querySelector('.n')?.textContent);
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(80); const down = await page.evaluate(() => document.activeElement.querySelector('.n')?.textContent);
  say(`${scheme}:home-and-end-in-the-question-list`, atEnd === '4' && atHome === '1' && down === '2', JSON.stringify({ atEnd, atHome, down }));
  // ---- the open question: a draft asked for, arriving, discarded and put back by Undo leaves the focus in the panel ----------
  await page.click('.md .li >> nth=0'); await page.waitForSelector('#q-draft'); await page.focus('#q-draft'); await page.keyboard.press('Enter'); await page.waitForSelector('.qpanel .draft.pending');
  const dPending = await page.evaluate(() => !!document.activeElement?.classList.contains('qpanel')); await page.waitForSelector('.qpanel .draft:not(.pending)', { timeout: 8000 }); await page.waitForTimeout(80);
  const firstAct = () => page.evaluate(() => document.activeElement === document.querySelector('.qpanel .racts button'));
  const dArrived = await firstAct(); await page.focus('.qpanel .racts > :last-child button'); await page.keyboard.press('Enter'); await page.waitForSelector('#q-draft'); await page.waitForTimeout(80);
  const dDiscarded = await active(page); await page.focus('#toast .tundo'); await page.keyboard.press('Enter'); await page.waitForSelector('.qpanel .draft:not(.pending)'); await page.waitForTimeout(80); const dBack = await firstAct();
  say(`${scheme}:a-draft-arriving-discarded-and-put-back-leaves-the-focus-in-the-panel`, dPending && dArrived && dDiscarded === '#q-draft' && dBack, JSON.stringify({ dPending, dArrived, dDiscarded, dBack }));
  // ...and so do its arrows: Enter keeps stepping, and at the end of the list the focus goes to the other arrow
  await page.focus('#q-next'); const qSteps = []; for (let i = 0; i < 4; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(120); qSteps.push(await page.evaluate(() => document.querySelector('.qpanel .n').textContent + ' ' + document.activeElement.id)); }
  say(`${scheme}:enter-on-the-question-arrows-keeps-stepping`, qSteps.join() === 'Q2 q-next,Q3 q-next,Q4 q-prev,Q3 q-prev', JSON.stringify(qSteps));
  await page.click('#q-close'); await page.waitForSelector('.qpanel', { state: 'detached' }); await toastsGone(page);
  await page.focus('#qa-draftall'); await page.keyboard.press('Enter'); await page.waitForFunction(() => /confirm/.test(document.getElementById('qa-draftall').textContent));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !/confirm/.test(document.getElementById('qa-draftall').textContent));
  say(`${scheme}:escape-cancels-the-draft-all-confirmation`, (await active(page)) === '#qa-draftall' && (await page.evaluate(() => store.get().ui.batch)) === null);
  // the More menu: arrows over buttons and checkboxes alike; Tab leaves it
  await page.focus('#qa-cols'); await page.keyboard.press('Enter'); await page.waitForSelector('#colmenu'); const c1 = await active(page);
  const colsWas = await page.evaluate(() => JSON.stringify(store.get().prefs.hideCols ?? {}));
  await page.keyboard.press('ArrowDown'); const cExport = await active(page);                                    // Deleted… has nothing in it yet and is passed over
  await page.keyboard.press('ArrowDown'); const c2 = await page.evaluate(() => document.activeElement.tagName + ':' + (document.activeElement.getAttribute('data-col') ?? ''));
  await page.keyboard.press('ArrowDown'); const c3 = await page.evaluate(() => document.activeElement.tagName + ':' + (document.activeElement.getAttribute('data-col') ?? ''));
  const colsNow = await page.evaluate(() => JSON.stringify(store.get().prefs.hideCols ?? {}));                     // moving over a checkbox does not check mark it
  await page.keyboard.press('Tab'); await page.waitForSelector('#colmenu', { state: 'detached' }); const cTab = await page.evaluate(() => !document.activeElement?.closest('#colmenu') && document.activeElement !== document.body);
  say(`${scheme}:the-more-menu-takes-arrows-and-tab-leaves-it`, c1 === '#qa-import' && cExport === '#qa-export' && c2 === 'INPUT:priority' && c3 === 'INPUT:askedBy' && colsNow === colsWas && cTab, JSON.stringify({ c1, cExport, c2, c3, colsWas, colsNow, cTab }));

  // ---- the Deleted dialog: each Restore leaves the focus on the next Restore, so Enter keeps putting things back --------
  await page.evaluate(async (d) => { const qs = Object.values(store.get().questions).filter((q) => q.dealId === d).sort((a, b) => a.n - b.n); for (const q of qs.slice(2)) await store.dispatch(store.commandNamed('DeleteQuestion'), { dealId: d, questionId: q.id }); }, id);
  await page.click('#qa-cols'); await page.click('#qa-deleted'); await page.waitForSelector('.deldlg .delrow');
  const delOpen = await active(page); await page.keyboard.press('Tab'); const delTab = await page.evaluate(() => document.activeElement === document.querySelector('.deldlg [data-restore]'));
  say(`${scheme}:deleted-opens-on-its-list-and-tab-goes-to-the-first-restore`, delOpen === 'DIV.delscroll' && delTab, JSON.stringify({ delOpen, delTab }));
  await page.focus('.deldlg [data-restore]');
  await page.keyboard.press('Enter'); await page.waitForFunction(() => document.querySelectorAll('.deldlg .delrow').length === 1);
  const r1 = await page.waitForFunction(() => document.activeElement?.hasAttribute('data-restore'), null, { timeout: 2000 }).then(() => true, () => false); await page.keyboard.press('Enter');   // the focus moves a frame after the row goes: waited for, not a fixed pause, which a busy machine outruns
  if (!(await page.waitForSelector('.deldlg', { state: 'detached', timeout: 3000 }).then(() => true, () => false))) { await page.click('.deldlg [data-restore]'); await page.waitForSelector('.deldlg', { state: 'detached' }); }   // the Enter went nowhere: put the last one back by hand, for the checks after this
  const r2 = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id);
  say(`${scheme}:restore-leaves-the-focus-on-the-next-restore`, r1 && r2 === 4, JSON.stringify({ r1, r2 }));
  await toastsGone(page);

  // ---- Ctrl Z is the toast's Undo -------------------------------------------------------------------------------------
  const before = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id);
  await page.click('.md .li >> nth=3'); await page.waitForSelector('.det .del'); await page.focus('.det .del'); await page.keyboard.press('Enter'); await page.waitForSelector('#ask-keep:focus'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await page.waitForSelector('#toast .tundo');
  const gone = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id);
  await page.evaluate(() => document.activeElement?.blur?.()); await page.keyboard.press('Control+z'); await page.waitForFunction(([d, n]) => Object.values(store.get().questions).filter((q) => q.dealId === d).length === n, [id, before]);
  say(`${scheme}:ctrl-z-undoes-while-the-message-shows`, gone === before - 1);
  await page.click('.md .li >> nth=3'); await page.waitForSelector('.det .del'); await toastsGone(page); await page.focus('.det .del'); await page.keyboard.press('Enter'); await page.waitForSelector('#ask-keep:focus'); await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await page.waitForSelector('#toast .tundo'); await page.waitForTimeout(120);
  const afterDel = await page.evaluate(() => ({ inList: !!document.activeElement?.closest('.md .li') || !!document.activeElement?.classList.contains('li'), body: document.activeElement === document.body }));
  await page.click('#toast .tundo'); await page.waitForFunction(([d, n]) => Object.values(store.get().questions).filter((q) => q.dealId === d).length === n, [id, before]);
  say(`${scheme}:deleting-a-question-leaves-the-focus-in-the-list`, afterDel.inList && !afterDel.body, JSON.stringify(afterDel));
  await page.click('.md .li >> nth=0'); await page.waitForSelector('.det textarea.qtext'); await page.fill('.det textarea.qtext', 'First question, edited'); await page.keyboard.press('Control+z'); await page.waitForTimeout(700);
  say(`${scheme}:ctrl-z-in-a-field-is-the-field's-own-undo`, (await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id)) === before);
  await toastsGone(page);

  // ---- a question's Discuss page: Keep or Replace in the Replace prompt gives the focus back to Use as response --------------
  const answeredQ = await page.evaluate(async (d) => { const q = Object.values(store.get().questions).find((x) => x.dealId === d && x.n === 2); await store.dispatch(store.commandNamed('SetResponse'), { dealId: d, questionId: q.id, response: 'Already answered.' }); return q.id; }, id);
  await page.goto(URL + `#q-${id}-${answeredQ}`);
  await followUp(page, 'Why do you say that?');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed) .acts', { timeout: 10000 });
  const kept = []; for (const k of ['Keep', 'Replace']) { await page.focus('.msgs .ai .acts button[aria-label="Use as response"]'); await page.keyboard.press('Enter'); await page.waitForSelector('#use-replace'); if (k === 'Keep') await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await page.waitForSelector('.card.confirm', { state: 'detached' }); await page.waitForTimeout(80); kept.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? (document.activeElement?.textContent ?? '').trim())); }
  say(`${scheme}:keep-and-replace-give-the-focus-back-to-use-as-response`,
    kept.join() === 'Use as response,Use as response', JSON.stringify(kept));
  await toastsGone(page);

  // ---- headings and the ask box's focus ring ---------------------------------------------------------------------------
  await page.goto(URL + `#finding-${id}-${fs[1]}`); await page.waitForSelector('.opening .qtxt');
  const hFinding = await page.evaluate(() => [...document.querySelectorAll('h1,[role="heading"][aria-level="1"]')].map((e) => e.textContent));
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('#pask'); const hChat = await page.evaluate(() => [...document.querySelectorAll('h1,[role="heading"][aria-level="1"]')].map((e) => e.textContent));
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); const hDeal = await page.evaluate(() => ({ h1: [...document.querySelectorAll('h1')].map((e) => e.textContent), h2: [...document.querySelectorAll('[role="heading"][aria-level="2"]')].map((e) => e.textContent), form: document.querySelector('#pcomposer')?.getAttribute('aria-label') ?? null }));
  const h2s = () => page.evaluate(() => [...document.querySelectorAll('[role="heading"][aria-level="2"]')].map((e) => e.textContent));
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist'); const hOver = await h2s(); await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow'); const hList = await h2s();
  say(`${scheme}:every-page-has-a-heading`, hFinding.length === 1 && hFinding[0].length > 10
    && hChat.join() === 'Ask about Project Proseware' && hDeal.h1.join() === 'Project Proseware'
    && hDeal.h2.join('|') === 'Findings' && hOver.join('|') === 'Findings|Checklist|Q&A|Gaps in the Documents|Documents'
    && hList.join('|') === 'Checklist', JSON.stringify({ hFinding, hChat, hDeal, hOver, hList }));
  // ---- a document opened from the Checklist: closing it, by Escape or by its ×, gives the focus back to the link that opened it ----
  await page.click('#ck-filter [data-filter="satisfied"]'); await page.click('#ck-rows .ckrow >> nth=1'); await page.waitForSelector('#ck-sources');
  const srcBack = []; for (const how of ['Escape', '#doc-close']) { await page.focus('#ck-sources .ckopen'); await page.keyboard.press('Enter'); await page.waitForSelector('.docpanel'); if (how !== 'Escape') await page.focus(how); await page.keyboard.press(how === 'Escape' ? 'Escape' : 'Enter'); await page.waitForSelector('#ck-detail'); await page.waitForTimeout(150); srcBack.push(await active(page) + (await page.evaluate(() => document.activeElement?.matches('#ck-sources .ckopen') ? ' (link)' : ''))); }
  say(`${scheme}:closing-a-document-opened-from-the-checklist-returns-to-its-link`, srcBack.every((x) => x.endsWith('(link)')), JSON.stringify(srcBack));
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask');
  const ring = await page.evaluate(`(async () => { const lum = ${lum}; const box = document.getElementById('homeask'); const nums = (v) => (v.match(/-?[\\d.]+(e-?\\d+)?/g) ?? []).map(Number);
    const parse = (v) => { const n = nums(v); return /^color\\(srgb/.test(v) ? { c: n.slice(0, 3), a: n[3] ?? 1 } : { c: n.slice(0, 3).map((x) => x / 255), a: n[3] ?? 1 }; };
    const cs = getComputedStyle(document.documentElement); const hex = (v) => { const h = v.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); }; const surface = hex(cs.getPropertyValue('--surface'));
    const over = (p) => p.c.map((x, i) => x * p.a + surface[i] * (1 - p.a)); const ratio = (p) => { const a = lum(over(p)), b = lum(surface); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const idle = getComputedStyle(box).borderTopColor; document.getElementById('hask').focus(); await new Promise((r) => setTimeout(r, 400)); const on = getComputedStyle(box).borderTopColor;
    return { idle: ratio(parse(idle)), on: ratio(parse(on)), raw: on }; })()`);
  say(`${scheme}:the-ask-box-shows-where-the-focus-is`, ring.on >= 3 && ring.on > ring.idle, JSON.stringify(ring));
  // a link in the trail takes a click 24px high
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.trail a');
  const hit = await page.evaluate(() => { const a = document.querySelector('.trail a'); const r = a.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; return { h: Math.round(r.height), up: document.elementFromPoint(x, y - 11) === a, down: document.elementFromPoint(x, y + 11) === a }; });
  say(`${scheme}:trail-links-take-a-click-24px-high`, hit.up && hit.down, JSON.stringify(hit));
  // ---- Page Up and Page Down in a list longer than the window: a page at a time, stopping at the ends, the row kept in view ----
  for (let i = 5; i <= 30; i++) await newQ(page, id, 'Question number ' + i);
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask'); await page.goto(URL + '#qa-' + id); await page.waitForFunction(() => document.querySelectorAll('.md .li').length === 30); await toastsGone(page);
  const at = async () => { await page.waitForTimeout(120); return page.evaluate(() => { const a = document.activeElement, l = document.querySelector('.md .list').getBoundingClientRect(), r = a.getBoundingClientRect(); return { n: Number(a.querySelector('.n')?.textContent), seen: r.top >= l.top - 1 && r.bottom <= l.bottom + 1, sel: a.getAttribute('aria-selected') }; }); };
  const geo = await page.evaluate(() => { const l = document.querySelector('.md .list'); const fits = Math.floor(l.clientHeight / document.querySelector('.md .li').getBoundingClientRect().height); return { step: fits - 1, fits, scrolls: l.scrollHeight > l.clientHeight }; });
  await page.focus('.md .li[tabindex="0"]'); await page.keyboard.press('Home'); const p0 = await at();
  await page.keyboard.press('PageDown'); const p1 = await at(); await page.keyboard.press('PageDown'); const p2 = await at(); await page.keyboard.press('PageUp'); const p3 = await at();
  await page.keyboard.press('PageUp'); await page.keyboard.press('PageUp'); const pTop = await at();
  await page.keyboard.press('End'); const pEnd = await at(); await page.waitForTimeout(700);
  // End scrolls down, which tucks the deal's header away on Q&A (#593): the list is taller, so a page from here is measured again
  const stepEnd = await page.evaluate(() => Math.floor(document.querySelector('.md .list').clientHeight / document.querySelector('.md .li').getBoundingClientRect().height) - 1);
  await page.keyboard.press('PageDown'); const pPast = await at(); await page.keyboard.press('PageUp'); const pBack = await at();
  const st = geo.step;
  say(`${scheme}:page-up-and-page-down-in-the-question-list`, geo.scrolls && st > 1 && st === geo.fits - 1 && st * 2 + 1 < 30 && p0.n === 1 && p1.n === 1 + st && p2.n === 1 + 2 * st && p3.n === 1 + st && pTop.n === 1 && pEnd.n === 30 && pPast.n === 30 && pBack.n === 30 - stepEnd && [p0, p1, p2, p3, pTop, pEnd, pPast, pBack].every((x) => x.seen && x.sel === 'true'), JSON.stringify({ geo, stepEnd, p0, p1, p2, p3, pTop, pEnd, pPast, pBack }));
  // ---- a question logged from the Checklist: the card goes and the focus goes back to the button that opened it (last: it adds a question) ----
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow'); await page.click('#ck-filter [data-filter="all"]'); await page.click('#ck-rows .ckrow[data-result="finding"]'); await page.waitForSelector('#ck-ask'); await page.waitForTimeout(150);
  await page.focus('#ck-ask'); await page.keyboard.press('Enter'); await page.waitForSelector('#ck-ask-text'); await page.keyboard.type('Logged from the checklist'); await page.focus('#ck-ask-log'); await page.keyboard.press('Enter'); await page.waitForSelector('#ck-ask-text', { state: 'detached' }); await page.waitForTimeout(80);
  const ckLogged = await active(page);
  say(`${scheme}:logging-a-question-from-the-checklist-returns-to-its-button`, ckLogged === '#ck-ask', ckLogged);
  // focus that can be seen: Undo's ring stands out from its notice, a dialog's select keeps its ring in its
  // column, and the delete-deal name field gets a ring, not only a new border color
  await page.evaluate(() => { for (const t of [...store.get().ui.toasts]) store.dismissToast(t.id); });
  const qx = await newQ(page, id, 'Focus check'); await page.evaluate(([d, q]) => store.dispatch(store.commandNamed('DeleteQuestion'), { dealId: d, questionId: q }), [id, qx]);
  const undoBtn = page.locator('.toast', { hasText: 'deleted' }).locator('.tundo'); await undoBtn.waitFor(); await undoBtn.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  const undoRing = await page.evaluate(`(() => {
    const lum = ${lum};
    // a notice is popup glass: a see-through fill, given as rgba() or as color(srgb r g b / a) with channels 0 to 1,
    // so it is laid over the window's surface (the body's own fill) to get the color the ring is seen against
    const parts = (c) => {
      const n = c.match(/[\\d.]+/g).map(Number);
      const k = c.startsWith('color(') ? 1 : 255;
      return [n[0] / k, n[1] / k, n[2] / k, n[3] ?? 1];
    };
    const over = (top, under) => top.slice(0, 3).map((x, i) => x * top[3] + under[i] * (1 - top[3]));
    const e = document.activeElement;
    const surface = parts(getComputedStyle(document.body).backgroundColor);
    const a = lum(parts(getComputedStyle(e).outlineColor).slice(0, 3)),
      b = lum(over(parts(getComputedStyle(e.closest('.toast')).backgroundColor), surface));
    const ratio = +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2);
    return { on: e.classList.contains('tundo'), ratio };
  })()`);
  await page.evaluate(() => { for (const t of [...store.get().ui.toasts]) store.dismissToast(t.id); });
  await page.evaluate((d) => store.ui({ dialog: { kind: 'exportQa', dealId: d } }), id); await page.waitForSelector('#x-ws'); await page.focus('#x-ws'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  const xws = await page.evaluate(() => { const e = document.getElementById('x-ws'); const s = getComputedStyle(e); return { on: document.activeElement === e, spill: e.getBoundingClientRect().right + parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset) - e.closest('.srow').getBoundingClientRect().right }; });
  await page.keyboard.press('Escape'); await page.waitForSelector('#x-ws', { state: 'detached' });
  await page.evaluate((d) => store.ui({ deleteDeal: { dealId: d, typed: '', error: '' } }), id); await page.waitForSelector('#dd-name'); await page.focus('#dd-name');
  const dd = await page.evaluate(() => getComputedStyle(document.getElementById('dd-name')).boxShadow);
  await page.evaluate(() => store.ui({ deleteDeal: null }));
  say(`${scheme}:focus-rings-can-be-seen`, undoRing.on && undoRing.ratio >= 3 && xws.on && xws.spill <= 0.5 && dd !== 'none', JSON.stringify({ undoRing, xws, dd }));
  say(`${scheme}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
