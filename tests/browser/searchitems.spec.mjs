// Checklist items in search (decisions, Checklist: "Checklist items appear in search"; #2), on two deals each holding a
// general list of 2,000 items. Runs on the mock services. With SHOTS=<folder>, it also saves the results and the item
// opened from them in both themes at both sizes.
import { launchChrome } from './chrome.mjs';
import fs from 'node:fs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const SHOTS = process.env.SHOTS || '';
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note); };
const browser = await launchChrome();

// the realistic technology list's items (tests/fixtures/pastedList.ts), each asked of the parts of a project a lender's
// counsel splits them over, to 2,000; the mock's sample items lead, so its first pass flags and settles some of them
const PASTED = [...fs.readFileSync(new globalThis.URL('../fixtures/pastedList.ts', import.meta.url), 'utf8').split('export const NOT_TAKEN')[0].matchAll(/^ {4}'((?:[^'\\]|\\.)+)',?$/gm)].map((m) => m[1].replace(/\\'/g, "'"));
const PARTS = ['the array', 'the substation', 'the gen-tie', 'the battery yard', 'the O&M building', 'the access road', 'the laydown area', 'the collection system', 'the met stations', 'the switchyard', 'the inverter pads', 'the fencing', 'the drainage', 'the cable route', 'the water supply', 'the SCADA system', 'the spare parts store'];
const SAMPLES = ['Operating assumptions agree across the advisors’ reports', 'Lock-up ratio matches the term sheet', 'Contracted revenue covers the base case capacity', 'Insurance advisor report (final)', 'Executed direct agreement', 'Financial model has been audited'];
const SECS = ['Site and real estate', 'Permits', 'Interconnection', 'Construction', 'Operations', 'Insurance', 'Finance'];
const general = () => [...SAMPLES, ...PARTS.flatMap((p) => PASTED.map((t) => `${t.replace(/[.;]$/, '')}, for ${p}`))].slice(0, 2000).map((text, i) => ({ text, section: SECS[i % SECS.length] }));
const LAST = general()[1999].text;
const bring = (page, items) => page.evaluate((items) => store.dispatch(store.commandNamed('BringInList'), { list: { layer: 'broad', name: '', items, file: 'Firm checklist.xlsx', fileDate: '' } }, { quiet: true }), items);
async function newDeal(page, name) {
  await page.evaluate(() => store.ui({ newDeal: { name: '', folders: [], error: '', busy: false } })); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create');
  await page.waitForFunction((n) => Object.values(store.get().deals).some((d) => d.name === `Project ${n}`), name);
  const id = await page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === `Project ${n}`).id, name);
  await page.waitForFunction((d) => Object.values(store.get().items).filter((i) => i.dealId === d).length === 2000, id, { timeout: 30000 });
  return id;
}
async function start(size = [1280, 736], scheme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await bring(page, general());
  const k = await newDeal(page, 'Proseware'); const o = await newDeal(page, 'Wingtip');
  await page.waitForFunction(() => Object.values(store.get().findings).length >= 3, null, { timeout: 30000 });
  await page.goto(URL + '#overview-' + k); await page.waitForSelector('#rsearch');
  return { ctx, page, k, o };
}
const groups = (page) => page.evaluate(() => [...document.querySelectorAll('#pal-res .pgrp')].map((g) => [g.dataset.kind, g.querySelector('.plbl').textContent, g.querySelectorAll('button:not(.pmore)').length]));
const search = async (page, q) => { await page.keyboard.press('Control+k'); await page.fill('#pal-in', q); await page.waitForSelector('#pal-res .pgrp, #pal-res .empty'); await page.waitForTimeout(150); };

// Hold one mock record read until the test releases it, without changing its contents.
const holdDeal = (page, id) => page.evaluate((id) => {
  const repo = store.services.repo;
  const list = repo.list.bind(repo);
  const held = new Promise((resolve) => { window.releaseSearchRead = resolve; });
  repo.list = async (kind, dealId) => {
    if (kind === 'question' && dealId === id) await held;
    return list(kind, dealId);
  };
}, id);

// Supply a deal-scale log through the browser's mock reader, without consuming localStorage quota.
async function seedQuestions(page, id) {
  await page.evaluate(([id, wordings]) => {
    const repo = store.services.repo;
    const list = repo.list.bind(repo);
    repo.list = async (kind, dealId) => {
      const read = await list(kind, dealId);
      if (!read.ok || kind !== 'question' || dealId !== id) return read;
      const question = read.value.find(({ envelope }) => envelope.data.text.includes('lease term'));
      if (!question) throw new Error('Missing mock question template');
      const rows = wordings.map((text, index) => ({
        ...question,
        envelope: {
          ...question.envelope,
          data: { ...question.envelope.data, id: `q_${String(index + 1).padStart(26, '0')}`, n: index + 1, text },
        },
      }));
      return { ...read, value: rows };
    };
  }, [id, general().map(({ text }) => `Please confirm: ${text}`)]);
}

async function loadingUsesMyDeals() {
  const { ctx, page, k, o } = await start();
  const neverAdded = 'd_00000000000000000000000001';
  await page.evaluate(async ([removed, neverAdded]) => {
    await store.dispatch(store.commandNamed('SetDealMember'), { dealId: removed, on: false }, { quiet: true });
    const data = { ...store.get().deals[removed], id: neverAdded };
    const result = await store.services.repo.transaction({
      writes: [{ kind: 'deal', id: neverAdded, data, expectedRev: null }],
      index: { dealId: '_', add: [{ kind: 'deal', id: neverAdded }] },
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
  }, [o, neverAdded]);
  const created = await page.evaluate((dealId) => store.dispatch(store.commandNamed('CreateQuestion'),
    { dealId, text: 'Please confirm the lease term.', workstream: 'Legal' }, { quiet: true }), k);
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  await page.goto(URL + '#deals');
  await page.reload();
  await page.waitForFunction(([mine, unadded]) =>
    store.get().boot.stage === 'ready' && !!store.get().deals[mine] && !!store.get().deals[unadded], [k, neverAdded]);
  await seedQuestions(page, k);
  await holdDeal(page, k);
  await search(page, 'zzzzqqq');
  const loading = await page.textContent('#pal-res .empty');
  await page.evaluate(() => window.releaseSearchRead());
  await page.waitForFunction((id) => store.get().dealLoad[id] === 'loaded', k);
  const done = await page.textContent('#pal-res .empty');
  const ownOnly = await page.evaluate(([removed, unadded]) =>
    [removed, unadded].every((id) => store.get().dealLoad[id] === undefined), [o, neverAdded]);
  await page.fill('#pal-in', 'lease term');
  const question = page.locator('#pal-res [data-kind=question] button:not(.pmore)').first();
  const match = await question.waitFor({ timeout: 3000 }).then(() => true, () => false);
  const finished = loading === 'Searching' && done === 'No matches.' && ownOnly && match;
  say('#491 Search completes after My Deals are read', finished, JSON.stringify({ loading, done, ownOnly, match }));
  await ctx.close();
}

async function searchWhileDealIsHeld(page, open, held, phrase) {
  await page.goto(URL + '#overview-' + open);
  await page.reload();
  await page.waitForFunction((id) => store.get().dealLoad[id] === 'loaded', open);
  await holdDeal(page, held);
  await search(page, phrase);
}

async function selectionSurvivesLoading() {
  const { ctx, page, k, o } = await start();
  const races = [
    { phrase: 'Financial model has been audited', pointer: false, finding: true },
    { phrase: 'lease term', pointer: true, finding: true },
    { phrase: LAST, pointer: false, finding: false },
  ];
  for (const { phrase, finding } of races) {
    if (!finding) continue;
    const created = await page.evaluate(([dealId, title]) =>
      store.dispatch(store.commandNamed('CreateFinding'), { dealId, title, workstream: 'Legal' }, { quiet: true }),
    [o, phrase]);
    if (!created.ok) throw new Error(JSON.stringify(created.error));
  }
  const ownItems = page.locator('#pal-res [data-kind=item] button').filter({ hasText: 'Project Proseware' });
  const selected = page.locator('#pal-res [aria-selected=true]');
  const outcomes = [];
  for (const { phrase, pointer, finding } of races) {
    await searchWhileDealIsHeld(page, k, o, phrase);
    const original = ownItems.nth(pointer ? 1 : 0);
    await original.waitFor();
    if (pointer) await original.hover();
    const wanted = await original.textContent();
    const pointed = await selected.textContent();
    await page.evaluate(() => window.releaseSearchRead());
    await page.waitForFunction((id) => store.get().dealLoad[id] === 'loaded', o);
    if (finding) await page.locator('#pal-res [data-kind=finding]').waitFor();
    const kept = await selected.textContent();
    await page.keyboard.press('Enter');
    await page.waitForSelector('#pal-drop', { state: 'detached' });
    const hash = await page.evaluate(() => location.hash);
    outcomes.push(wanted === pointed && kept === wanted && hash === `#checklist-${k}`);
  }
  await search(page, LAST);
  await ownItems.first().hover();
  await page.evaluate((dealId) =>
    store.dispatch(store.commandNamed('SetDealMember'), { dealId, on: false }, { quiet: true }), k);
  const fallback = await selected.textContent();
  outcomes.push(fallback.includes('Project Wingtip'));
  say('#501 Search preserves the selected hit through late results and falls back when it disappears',
    outcomes.every(Boolean), JSON.stringify(outcomes));
  await ctx.close();
}

async function selectedExpansion(page, oldCount) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  return page.evaluate((before) => {
    const group = document.querySelector('#pal-res [data-kind=item]');
    const rows = group.querySelectorAll('button:not(.pmore)');
    const activeId = document.getElementById('pal-in').getAttribute('aria-activedescendant');
    const row = document.getElementById(activeId)?.getBoundingClientRect();
    const panel = document.getElementById('pal-drop').getBoundingClientRect();
    return {
      activeId, firstNewId: rows[before]?.id ?? null, more: !!group.querySelector('.pmore'),
      visible: !!row && row.top >= panel.top - 1 && row.bottom <= panel.bottom + 1,
    };
  }, oldCount);
}

{
  const { ctx, page, k, o } = await start();
  await search(page, 'lease term');
  const g = await groups(page);
  const listed = g.some(([kind, label]) => kind === 'item' && label === 'Checklist Items');
  const after = g.findIndex(([x]) => x === 'item') > g.findIndex(([x]) => x === 'deal');
  say('items matching the words are listed under Checklist Items, after Findings and before Questions',
    listed && after, JSON.stringify(g));
  const rows = await page.evaluate(() => [...document.querySelectorAll('#pal-res .pgrp[data-kind=item] button:not(.pmore)')].map((b) => [b.querySelector('.ttl').textContent, b.querySelector('.wdeal')?.textContent]));
  say('each names its item and the deal it is in, and the same item in two deals is two results', rows.length === 5 && rows.every(([t, d]) => /lease term/i.test(t) && /^Project (Proseware|Wingtip)$/.test(d)), JSON.stringify(rows));
  const more = await page.textContent('#pal-res .pgrp[data-kind=item] .pmore');
  say('the rest are counted, as for every type', more === `Show ${2 * PARTS.length - 5} More`, more);
  await page.press('#pal-in', 'ArrowUp');
  await page.press('#pal-in', 'Enter');
  const activeAfterMore = await selectedExpansion(page, 5);
  say('enter-on-show-more-activates-the-first-new-row', activeAfterMore.activeId === activeAfterMore.firstNewId,
    JSON.stringify(activeAfterMore));
  say('keyboard-search-expansion-brings-the-final-page-into-view',
    activeAfterMore.visible && !activeAfterMore.more, JSON.stringify(activeAfterMore));
  // a broad word: "Show N more" opens a page more at a time, and the panel stays quick to open and to move through
  await page.fill('#pal-in', 'e'); await page.waitForSelector('#pal-res .pgrp[data-kind=item] .pmore');
  const opened = await page.evaluate(() => new Promise((ok) => { const t0 = performance.now(); document.querySelector('#pal-res .pgrp[data-kind=item] .pmore').click(); requestAnimationFrame(() => setTimeout(() => ok({ ms: Math.round(performance.now() - t0), rows: document.querySelectorAll('#pal-res .pgrp[data-kind=item] button:not(.pmore)').length, more: document.querySelector('#pal-res .pgrp[data-kind=item] .pmore')?.textContent }), 0)); }));
  say('"Show N more" shows 50 more, not thousands, opens quickly, and names only what the next click adds',
    opened.rows === 55 && opened.more === 'Show 50 More' && opened.ms < 1000, JSON.stringify(opened));
  await page.focus('#pal-in');
  const arrows = []; for (let i = 0; i < 6; i++) { const t0 = Date.now(); await page.keyboard.press('ArrowDown'); await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => ok()))); arrows.push(Date.now() - t0); }
  say('moving through the opened group stays quick', Math.max(...arrows) < 500, JSON.stringify(arrows));

  const back = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('#pal-res button')];
    const active = document.getElementById(document.getElementById('pal-in').getAttribute('aria-activedescendant'));
    const more = document.querySelector('#pal-res [data-kind=item] .pmore');
    return (buttons.indexOf(active) - buttons.indexOf(more) + buttons.length) % buttons.length;
  });
  for (let step = 0; step < back; step++) await page.press('#pal-in', 'ArrowUp');
  await page.press('#pal-in', 'Enter');
  const repeated = await selectedExpansion(page, 55);
  say('repeat-keyboard-search-expansion-shows-the-new-row-with-more-still-available',
    repeated.activeId === repeated.firstNewId && repeated.visible && repeated.more, JSON.stringify(repeated));

  await page.fill('#pal-in', 'lease term'); await page.waitForSelector('#pal-res .pgrp[data-kind=item]');
  const label = await page.getAttribute('#pal-in', 'aria-label');
  say('the field says to a screen reader that it searches checklist items', label === 'Search deals, findings, checklist items, questions and documents', label);

  // an item near the end of the 2,000 opens on its deal's Checklist, open beside the list, with its row in view
  await page.fill('#pal-in', LAST.slice(-45)); await page.waitForSelector('#pal-res .pgrp[data-kind=item]');
  const n = await page.evaluate(() => [...document.querySelectorAll('#pal-res button')].findIndex((b) => b.closest('[data-kind=item]')));
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowDown');
  const want = await page.evaluate(() => document.querySelector('#pal-res [aria-selected=true] .wdeal').textContent);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#ck-detail'); await page.waitForTimeout(400);
  const at = await page.evaluate(() => { const r = document.querySelector('#ck-rows .ckrow.on'); const l = document.querySelector('#ck-rows').getBoundingClientRect(); const b = r?.getBoundingClientRect(); return { hash: location.hash, text: r?.querySelector('.it')?.textContent, inView: !!b && b.top >= Math.max(0, l.top) - 1 && b.bottom <= Math.min(innerHeight, l.bottom) + 1, detail: document.querySelector('#ck-detail').textContent.includes(r?.querySelector('.it')?.textContent ?? '\u0000') }; });
  const deal = want === 'Project Proseware' ? k : o;
  say('Enter opens the item on its deal’s Checklist, open beside the list', at.hash === `#checklist-${deal}` && at.text === LAST && at.detail, JSON.stringify(at));
  say('its row, near the end of 2,000, is brought into view', at.inView, JSON.stringify(at));
  // a row already in sight, clicked, stays where it is: the list does not jump
  const still = await page.evaluate(() => { const rows = [...document.querySelectorAll('#ck-rows .ckrow')]; const i = rows.findIndex((r) => r.classList.contains('on')); const r = rows[i - 2]; const y = r.getBoundingClientRect().top; r.click(); return new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => ok({ was: y, now: r.getBoundingClientRect().top, on: r.classList.contains('on') }), 100)))); });
  say('a row clicked in sight stays where it is', Math.abs(still.was - still.now) < 1 && still.on, JSON.stringify(still));
  // and a row cut off at the list's foot, clicked, does not send the list scrolling: it is chosen where it is, as on main
  const pick = await page.evaluate(() => { const l = document.querySelector('#ck-rows'); const lb = l.getBoundingClientRect(); const foot = Math.min(innerHeight, lb.bottom);
    const r = [...l.querySelectorAll('.ckrow')].find((x) => { const b = x.getBoundingClientRect(); return b.top < foot && b.bottom > foot; });
    if (r) l.scrollTop += r.getBoundingClientRect().top - (foot - 30);   // 30px of it in sight, the rest under the list's foot
    if (!r) return null; const b = r.getBoundingClientRect(); window.__was = { r, y: b.top, top: document.scrollingElement.scrollTop + l.scrollTop }; return { x: b.left + 40, y: (b.top + foot) / 2 }; });
  if (pick) await page.mouse.click(pick.x, pick.y);   // a real click, which gives the row the focus
  await page.waitForTimeout(400);
  const cut = pick ? await page.evaluate(() => { const { r, y, top } = window.__was; const l = document.querySelector('#ck-rows'); return { moved: Math.round(Math.abs(r.getBoundingClientRect().top - y)), scrolled: document.scrollingElement.scrollTop + l.scrollTop - top, on: r.classList.contains('on') }; }) : { none: true };
  say('a row cut off at the list’s foot, clicked, does not send the list scrolling', cut.on && cut.scrolled === 0, JSON.stringify(cut));

  // a turned-off item is found too, and opens listed in its place
  const off = general()[1500].text;
  await page.evaluate(([d, t]) => { const it = Object.values(store.get().items).find((i) => i.dealId === d && i.text === t); return store.dispatch(store.commandNamed('SetItemsOff'), { dealId: d, off: [it.id] }, { quiet: true }); }, [o, off]);
  await search(page, off.slice(-50));
  const offRows = await page.evaluate(() => [...document.querySelectorAll('#pal-res .pgrp[data-kind=item] button:not(.pmore) .wdeal')].map((e) => e.textContent));
  say('an item turned off on a deal is still found there', offRows.includes('Project Wingtip') && offRows.includes('Project Proseware'), JSON.stringify(offRows));
  await page.evaluate(() => { const b = [...document.querySelectorAll('#pal-res .pgrp[data-kind=item] button:not(.pmore)')].find((x) => x.querySelector('.wdeal').textContent === 'Project Wingtip'); b.click(); });
  await page.waitForSelector('#ck-detail'); await page.waitForTimeout(300);
  const offAt = await page.evaluate(() => ({ hash: location.hash, on: document.querySelector('#ck-rows .ckrow.on')?.className ?? '' }));
  say('and opens on that deal’s Checklist, listed in its place', offAt.hash === `#checklist-${o}` && /\boff\b/.test(offAt.on), JSON.stringify(offAt));
  say('no page errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

await loadingUsesMyDeals();
await selectionSurvivesLoading();

const QUESTION = 'Who guarantees delivery under the direct agreement?';
const FILTER = { status: 'closed', workstream: 'Financial', text: 'permit' };
const DEFAULT_FILTER = { status: 'all', workstream: '', text: '' };
const sameFilter = (a, b) => a.status === b.status && a.workstream === b.workstream && a.text === b.text;
const itemIn = (page, deal) =>
  page.locator('#pal-res [data-kind=item] button:not(.pmore)').filter({ hasText: deal }).first();

async function chooseQuestion(page, dealId, origin, pointer = false) {
  await page.goto(URL + '#' + origin);
  await page.waitForFunction((hash) => location.hash === '#' + hash, origin);
  await page.waitForSelector('#view');
  await page.evaluate((qaFilter) => store.ui({ qaFilter, selectedQuestion: null }), FILTER);
  await search(page, QUESTION);
  const result = page.locator('#pal-res [data-kind=question] button:not(.pmore)').first();
  await result.waitFor();
  if (pointer) await result.click();
  else await page.keyboard.press('Enter');
  await page.waitForFunction((id) =>
    location.hash === '#qa-' + id && document.querySelector('.qpanel textarea.qtext')?.value.includes('guarantees'),
  dealId);
  return page.evaluate(() => store.get().ui.qaFilter);
}

async function keepsQaFilters(page, k, o) {
  const fromQa = await chooseQuestion(page, k, 'qa-' + k);
  const chosenVisible = await page.locator('.md .li.on').isVisible();
  await page.focus('.qpanel textarea.qtext');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.qpanel', { state: 'detached' });
  const afterEscape = await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => {
    resolve({ filter: store.get().ui.qaFilter, focus: !!document.activeElement?.closest('.trk-tools') });
  })));
  const sameDeal = await chooseQuestion(page, k, 'overview-' + k);
  const fromHome = await chooseQuestion(page, k, 'deals');
  const otherDeal = await chooseQuestion(page, k, 'qa-' + o);
  const keptFilters = [fromQa, afterEscape.filter, sameDeal].every((filter) => sameFilter(filter, FILTER));
  const resetFilters = [fromHome, otherDeal].every((filter) => sameFilter(filter, DEFAULT_FILTER));
  say('#497 Search keeps same-deal Q&A filters and opens out-of-filter questions',
    chosenVisible && afterEscape.focus && keptFilters && resetFilters,
    JSON.stringify({ fromQa, afterEscape, sameDeal, fromHome, otherDeal }));
}

async function revealsOpenChecklistRow(page, k) {
  await page.goto(URL + '#overview-' + k);
  await search(page, LAST);
  await itemIn(page, 'Project Proseware').click();
  await page.waitForSelector('#ck-detail');
  const outcomes = [];
  for (const pointer of [false, true]) {
    await page.locator('#ck-rows').evaluate((list) => { list.scrollTop = 0; });
    await search(page, LAST);
    const item = itemIn(page, 'Project Proseware');
    await item.waitFor();
    if (pointer) await item.click();
    else {
      await item.hover();
      await page.keyboard.press('Enter');
    }
    await page.waitForSelector('#pal-drop', { state: 'detached' });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    outcomes.push(await page.evaluate(() => {
      const list = document.querySelector('#ck-rows').getBoundingClientRect();
      const row = document.querySelector('#ck-rows .ckrow.on').getBoundingClientRect();
      return row.top >= Math.max(0, list.top) && row.bottom <= Math.min(innerHeight, list.bottom);
    }));
  }
  say('#496 Search reveals the already-open Checklist row', outcomes.every(Boolean), JSON.stringify(outcomes));
}

async function focusConflictedQuestion(page, dealId) {
  const conflict = await page.evaluate(async ([dealId, text, qaFilter]) => {
    const question = Object.values(store.get().questions).find((q) => q.dealId === dealId && q.text === text);
    const saved = await store.dispatch(store.commandNamed('SetResponse'), {
      dealId, questionId: question.id, response: 'The draft names the operator.',
    }, { quiet: true });
    if (!saved.ok) throw new Error(JSON.stringify(saved.error));
    const result = await __peer.edit(question.id, { response: 'The revision names the sponsor.' });
    store.ui({ selectedQuestion: null, qaFilter });
    return { result, id: question.id };
  }, [dealId, QUESTION, DEFAULT_FILTER]);
  if (conflict.result !== 'conflict') throw new Error('Could not seed the mock conflict: ' + conflict.result);
  await page.waitForFunction((id) => !!store.get().conflicts[id], conflict.id);
  await search(page, QUESTION);
  await page.locator('#pal-res [data-kind=question] button:not(.pmore)').first().waitFor();
  await page.keyboard.press('Enter');
  await page.waitForSelector('.qpanel.conflict');
  const focused = await page.evaluate(() => document.activeElement?.matches('.qpanel.conflict'));
  await page.keyboard.press('Tab');
  const continued = await page.evaluate(() => !!document.activeElement?.closest('.qpanel.conflict'));
  return focused && continued;
}

async function focusesKeyboardResults(page, k, o) {
  const inQuestion = () => page.evaluate(() => !!document.activeElement?.closest('.qpanel'));
  await chooseQuestion(page, k, 'qa-' + k);
  const samePage = await inQuestion();
  await page.keyboard.press('Tab');
  const next = await page.evaluate(() => !!document.activeElement?.closest('#view'));
  await chooseQuestion(page, k, 'qa-' + o);
  const otherDeal = await inQuestion();
  await chooseQuestion(page, k, 'qa-' + k, true);
  const pointer = await inQuestion();
  const conflict = await focusConflictedQuestion(page, k);
  await page.goto(URL + '#checklist-' + k);
  await search(page, LAST);
  await itemIn(page, 'Project Proseware').hover();
  await page.keyboard.press('Enter');
  await page.waitForSelector('#ck-detail');
  const checklist = await page.evaluate(() => document.activeElement?.matches('#ck-rows .ckrow.on'));
  say('#498 keyboard Search moves focus to the opened question or Checklist row',
    samePage && next && otherDeal && !pointer && conflict && checklist,
    JSON.stringify({ samePage, next, otherDeal, pointer, conflict, checklist }));
}

{
  const { ctx, page, k, o } = await start();
  const created = await page.evaluate(([dealId, text]) =>
    store.dispatch(store.commandNamed('CreateQuestion'), { dealId, text, workstream: 'Legal' }, { quiet: true }),
  [k, QUESTION]);
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  await page.goto(URL + '#deals');
  await page.reload();
  await page.waitForFunction(() => store.get().boot.stage === 'ready');
  await page.evaluate(([id, target, questions]) => {
    const repo = store.services.repo;
    const list = repo.list.bind(repo);
    repo.list = async (kind, dealId) => {
      const read = await list(kind, dealId);
      if (!read.ok || kind !== 'question' || dealId !== id) return read;
      const sample = read.value.find(({ envelope }) => envelope.data.text === target);
      const extra = questions.map(({ text }, index) => ({
        ...sample,
        envelope: {
          ...sample.envelope,
          data: { ...sample.envelope.data, id: `q_${String(index + 10).padStart(26, '0')}`, n: index + 10, text },
        },
      }));
      return { ...read, value: [...read.value, ...extra] };
    };
  }, [k, QUESTION, general()]);
  await keepsQaFilters(page, k, o);
  await revealsOpenChecklistRow(page, k);
  await focusesKeyboardResults(page, k, o);
  await ctx.close();
}

for (const [w, h] of SHOTS ? [[1280, 736], [1024, 640]] : []) for (const scheme of ['dark', 'light']) {
  const { ctx, page, k } = await start([w, h], scheme);
  await page.waitForSelector('#toast', { state: 'detached', timeout: 15000 }).catch(() => {});   // the deals' "created" notices gone
  // a question about it too, so the shot shows Checklist items between Findings and Questions
  await page.evaluate((d) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Please confirm the lock-up ratio and its test dates' }, { quiet: true }), k);
  await search(page, 'lock-up ratio'); await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/1-results-${scheme}-${w}x${h}.png` });
  await page.fill('#pal-in', LAST.slice(-45)); await page.waitForSelector('#pal-res .pgrp[data-kind=item]');
  const n = await page.evaluate(() => [...document.querySelectorAll('#pal-res button')].findIndex((b) => b.closest('[data-kind=item]')));
  for (let i = 0; i < n; i++) await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter'); await page.waitForSelector('#ck-detail'); await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/2-item-opened-${scheme}-${w}x${h}.png` });
  await page.evaluate(([dealId, text]) =>
    store.dispatch(store.commandNamed('CreateQuestion'), { dealId, text, workstream: 'Legal' }, { quiet: true }),
  [k, QUESTION]);
  await chooseQuestion(page, k, 'qa-' + k);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/3-question-opened-${scheme}-${w}x${h}.png` });
  await search(page, 'zzzzqqq');
  await page.locator('#pal-res .empty').filter({ hasText: 'No matches.' }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/4-no-matches-${scheme}-${w}x${h}.png` });
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
