// Turning a deal's checklist items off and on, and the Turned off list (linking design, section 5), on a deal
// holding a firm's list of 2,000 items. Runs on the mock services; the sample data room gives three findings.
import { launchChrome } from './chrome.mjs';
import { recheckFinding } from './cardPage.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note); };
const browser = await launchChrome();

const FLAGGED = 'Lock-up ratio matches the term sheet';
const SAMPLES = ['Operating assumptions agree across the advisors’ reports', FLAGGED, 'Contracted revenue covers the base case capacity', 'Insurance advisor report (final)', 'Executed direct agreement', 'Financial model has been audited'];
/** the firm's general list: the sample items and enough others for 2,000, in sections and subsections */
function generalList() {
  const secs = ['Corporate', 'Finance', 'Contracts', 'Permits and land', 'Technical', 'Insurance', 'Tax', 'Environmental and social']; const subs = ['Documents', 'Approvals', 'Conditions', 'Reporting', 'Third parties'];
  const items = SAMPLES.map((text, i) => ({ text, section: secs[0], subsection: subs[i % 2] }));
  for (let i = 0; items.length < 2000; i++) items.push({ text: `Agreement ${i + 1} has been reviewed by counsel`, section: secs[1 + (i % 7)], subsection: subs[Math.floor(i / 7) % 5] });
  return items;
}
async function start(size = [1280, 736], scheme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.evaluate((items) => store.dispatch(store.commandNamed('BringInList'), { list: { layer: 'broad', name: '', items, file: 'Firm checklist.xlsx', fileDate: '' } }), generalList());
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create');
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.waitForFunction((d) => Object.values(store.get().items).filter((i) => i.dealId === d).length === 2000, id, { timeout: 30000 });
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow[data-result="finding"]');
  return { ctx, page, id };
}
const filters = (page) => page.evaluate(() => [...document.querySelectorAll('#ck-filter button')].map((b) => b.textContent).join('|'));
const item = (page, text) => page.evaluate((t) => Object.values(store.get().items).find((i) => i.text === t), text);
const turnOff = async (page) => { await page.click('#ck-more'); await page.click('#ck-off'); };
const rowTexts = (page) => page.evaluate(() => [...document.querySelectorAll('#ck-rows .ckrow .it')].map((r) => r.textContent));

{ // Turn off, from the item's ⋯ menu: the item stays in its place, dimmed, keeps its finding and questions, and turns on from its pane
  const { ctx, page, id } = await start();
  const f = await page.evaluate(() => Object.values(store.get().findings).find((x) => /Lock-up/.test(x.title)));
  await page.evaluate(([dealId, fid]) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId, text: 'Which lock-up ratio was agreed?', workstream: 'Legal', linkedFinding: fid }), [id, f.id]);
  const before = await filters(page);
  await page.click(`#ck-rows .ckrow:has-text("${FLAGGED}")`); await page.waitForSelector('#ck-more');
  const order = await rowTexts(page);
  say('Turn off is not a button in the pane: it is in its ⋯ menu', !(await page.$('#ck-off')) && !!(await page.$('#ck-more')));
  await turnOff(page); await page.waitForSelector('#ck-on');
  await page.waitForFunction(() => document.activeElement?.id === 'ck-on', null, { timeout: 3000 }).catch(() => {});
  const after = await filters(page); const it = await item(page, FLAGGED);
  const kept = await page.evaluate(([fid]) => ({ finding: !!store.get().findings[fid], questions: Object.values(store.get().questions).filter((q) => q.linkedFinding === fid).length }), [f.id]);
  const row = await page.evaluate((t) => { const r = [...document.querySelectorAll('#ck-rows .ckrow')].find((x) => x.querySelector('.it').textContent === t); return { result: r?.getAttribute('data-result'), oc: r?.querySelector('.oc').textContent, on: r?.classList.contains('on'), pane: document.querySelector('#ck-detail .dmeta .n').textContent, focus: document.activeElement?.id }; }, FLAGGED);
  say('Turn off leaves the item in its place, marked Turned off, out of the status counts and under Turned off too',
    before === 'All 2000|Flagged 3|Gaps 2|Not Settled 1994|Satisfied 1'
      && after === 'All 2000|Flagged 2|Gaps 2|Not Settled 1994|Satisfied 1|Turned Off 1'
      && JSON.stringify(await rowTexts(page)) === JSON.stringify(order) && row.result === 'off'
      && row.oc === 'Turned off' && row.on, JSON.stringify({ before, after, row }));
  say('turning off keeps the item, its finding and its question; its pane stays open on Turn On, focused',
    it?.off === true && kept.finding && kept.questions === 1 && row.pane === 'Turned off' && row.focus === 'ck-on',
    JSON.stringify({ it, kept, row }));
  say('the notice says it and offers Undo', /Item turned off/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  await page.click('#toast .tundo'); await page.waitForFunction(() => document.querySelector('#ck-detail .dmeta .n')?.textContent === 'Flagged', null, { timeout: 5000 }).catch(() => {});
  say('Undo turns it on again, with its finding', (await item(page, FLAGGED)).off === false && await filters(page) === before, await filters(page));

  // the Turned off filter: the item, its finding and the question asked, and Turn on
  await turnOff(page); await page.waitForSelector('#ck-filter [data-filter="off"]');
  await page.click('#ck-close'); await page.click('#ck-filter [data-filter="off"]'); await page.click('#ck-rows .ckrow'); await page.waitForSelector('#ck-on');
  const pane = await page.evaluate(() => ({ n: document.querySelector('#ck-detail .dmeta .n').textContent, title: document.querySelector('#ck-detail .cktitle').textContent, lbl: [...document.querySelectorAll('#ck-detail .lbl')].map((l) => l.textContent).join('|'), asked: document.querySelector('#ck-detail .ckasked')?.textContent, rows: document.querySelectorAll('#ck-rows .ckrow').length, row: document.querySelector('#ck-rows .ckrow').getAttribute('data-result'), sr: document.querySelector('#ck-rows .ckrow .sr-only').textContent }));
  say('Turned off lists the item, with its finding and the question asked', pane.n === 'Turned off'
    && pane.title === FLAGGED && pane.lbl === 'Finding · Open|Asked' && /Q1open.*lock-up ratio/i.test(pane.asked ?? '')
    && pane.rows === 1 && pane.row === 'off' && pane.sr === ', Turned off', JSON.stringify(pane));
  await page.click('#ck-on'); await page.waitForSelector('#ck-more');
  await page.waitForFunction(() => document.activeElement?.id === 'ck-more', null, { timeout: 3000 }).catch(() => {});
  const on = await page.evaluate(() => ({ n: document.querySelector('#ck-detail .dmeta .n').textContent, filters: [...document.querySelectorAll('#ck-filter button')].map((b) => b.textContent).join('|'), sel: store.get().ui.selectedChecklist, filter: store.get().ui.checklistFilter, focus: document.activeElement?.id }));
  say('Turn On: the item stays open, flagged again, with the focus on its ⋯; the last one leaves Turned off for All',
    on.n === 'Flagged' && on.filters === before && on.filter === 'all' && on.focus === 'ck-more'
    && (await item(page, FLAGGED)).off === false && on.sel === (await item(page, FLAGGED)).id, JSON.stringify(on));
  // a question half typed about the item's finding stays, text and focus, when the item is turned off here or on another PC
  const flagged = (await item(page, FLAGGED)).id;
  await page.click('#ck-ask'); await page.fill('#ck-ask-text', 'Which ratio was agreed?');
  await page.evaluate(([dealId, it]) => store.dispatch(store.commandNamed('SetItemsOff'), { dealId, off: [it] }, { quiet: true }), [id, flagged]);   // as a write from another PC arrives
  await page.waitForFunction(() => document.querySelector('#ck-detail .dmeta .n')?.textContent === 'Turned off');
  const peer = await page.evaluate(() => ({ text: document.getElementById('ck-ask-text')?.value, focus: document.activeElement?.id, log: !document.getElementById('ck-ask-log')?.disabled }));
  await page.click('#ck-on'); await page.waitForSelector('#ck-more'); await turnOff(page); await page.waitForTimeout(600);
  const here = await page.evaluate(() => ({ pane: document.querySelector('#ck-detail .dmeta .n')?.textContent, text: document.getElementById('ck-ask-text')?.value }));
  await page.click('#ck-ask-log'); await page.waitForFunction(() => !document.getElementById('ck-ask-text'));
  const logged = await page.evaluate(() => Object.values(store.get().questions).some((q) => q.text === 'Which ratio was agreed?'));
  say('a question being typed stays in the pane, with its text and focus, when the item is turned off, and can still be logged', peer.text === 'Which ratio was agreed?' && peer.focus === 'ck-ask-text' && peer.log && here.pane === 'Turned off' && here.text === 'Which ratio was agreed?' && logged, JSON.stringify({ peer, here, logged }));
  // the Turned off filter and Overview say how many turned-off items still have an open finding
  const tip = await page.getAttribute('#ck-filter [data-filter="off"]', 'title');
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist .tot');
  await page.waitForFunction(() => /turned off/.test(document.querySelector('#ov-checklist .tot').textContent), null, { timeout: 5000 }).catch(() => {});
  const ov = await page.textContent('#ov-checklist .tot');
  say('the Turned off filter and Overview name the turned-off items with an open finding', tip === '1 with an open finding' && /1 turned off, 1 with an open finding/.test(ov), JSON.stringify({ tip, ov }));
  // every item turned off: All lists them all, dimmed, and Overview keeps its Checklist
  await page.evaluate((d) => store.dispatch(store.commandNamed('SetItemsOff'), { dealId: d, off: Object.values(store.get().items).filter((i) => i.dealId === d && !i.off).map((i) => i.id) }, { quiet: true }), id);
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-filter [data-filter="off"]');
  const all = await page.evaluate(() => ({ on: document.querySelector('#ck-filter button.on')?.textContent, rows: document.querySelectorAll('#ck-rows .ckrow[data-result="off"]').length }));
  all.filters = await filters(page);
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist .tot', { timeout: 5000 }).catch(() => {});
  all.ov = await page.evaluate(() => document.querySelector('#ov-checklist .tot')?.textContent);
  say('with every item turned off, All lists them all turned off, and Overview still has its Checklist',
    all.on === 'All 2000' && all.rows === 2000 && all.filters === 'All 2000|Turned Off 2000'
    && /2,000 turned off/.test(all.ov ?? ''), JSON.stringify(all));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // a deal checked against the backend's own list, with no items of its own, offers no Turn off
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = [];
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Coho'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create');
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow'); await page.click('#ck-rows .ckrow'); await page.waitForSelector('#ck-detail');
  say('a deal with no items of its own has no Turn off', !(await page.$('#ck-more')) && !(await page.$('#ck-off')));
  await ctx.close();
}

{ // every filter at once fits one header row at 1024, the seldom used in a menu; a question being typed outlasts its finding closing or going
  const { ctx, page, id } = await start([1024, 640]);
  const fs = await page.evaluate(() => Object.values(store.get().findings).filter((f) => f.itemId).map((f) => f.id));   // the three flagged items' findings
  await page.evaluate(([d, a, b]) => Promise.all([store.dispatch(store.commandNamed('SetFindingStatus'), { dealId: d, findingId: a, status: 'closed', note: 'Agreed' }, { quiet: true }), store.dispatch(store.commandNamed('DeleteFinding'), { dealId: d, findingId: b }, { quiet: true })]), [id, fs[0], fs[1]]);
  await page.evaluate(([d, it]) => store.dispatch(store.commandNamed('SetItemsOff'), { dealId: d, off: [it] }, { quiet: true }), [id, (await item(page, 'Financial model has been audited')).id]);
  await page.waitForFunction(() => document.querySelectorAll('#ck-filter button').length === 8, null, { timeout: 5000 }).catch(() => {});
  // counts as a deal of this size has them, which no width breakpoint can foresee: 151 flagged, 302 gaps, 1,200 satisfied
  await page.evaluate(([d, [closed, deleted, open]]) => { const st = store.get(); const rows = st.checklists[d].map((r, i) => ({ ...r, ...(i < 151 ? { result: 'finding', findingId: open } : i === 151 ? { result: 'finding', findingId: closed } : i === 152 ? { result: 'finding', findingId: deleted } : i < 455 ? { result: 'gap', findingId: undefined } : i < 1655 ? { result: 'satisfied', findingId: undefined } : { result: 'unchecked', findingId: undefined }) }));
    store.set({ ...st, checklists: { ...st.checklists, [d]: rows } }); }, [id, fs]);
  const fit = () => page.evaluate(() => { const h = document.querySelector('.ckhead'); const r = h.getBoundingClientRect(); return { h: Math.round(r.height), more: !!document.getElementById('ck-fmore'), f: [...document.querySelectorAll('#ck-filter button')].map((b) => b.textContent).join('|'), fits: h.scrollWidth <= h.clientWidth + 1 && [...h.querySelectorAll('button')].every((b) => { const x = b.getBoundingClientRect(); return x.right <= r.right + 1 && x.left >= r.left - 1; }), side: document.documentElement.scrollWidth - innerWidth }; });
  await page.waitForTimeout(300); const closedPane = await fit();
  await page.click('#ck-rows .ckrow');
  await page.waitForSelector('#ck-detail');
  await page.waitForSelector('#ck-fmore');
  const openPane = await fit();
  await page.click('#ck-fmore'); const menu = await page.evaluate(() => [...document.querySelectorAll('.ckhead .colmenu .mi')].map((b) => b.textContent).join('|'));
  await page.click('.ckhead .colmenu [data-filter="off"]'); const offOn = await page.evaluate(() => ({ filter: store.get().ui.checklistFilter, more: document.getElementById('ck-fmore')?.getAttribute('aria-label'), rows: document.querySelectorAll('#ck-rows .ckrow').length }));
  await page.click('#ck-filter [data-filter="all"]');
  say('at 1024x640, with a large deal’s counts, the filters fit one row beside the label, pane open or closed; '
    + 'the seldom used are in a menu',
    closedPane.f === 'All 2000|Flagged 151|Gaps 302|Not Settled 344|Satisfied 1200' && closedPane.more
    && closedPane.h <= 40 && openPane.h <= 40 && closedPane.fits && openPane.fits && closedPane.side <= 0
    && openPane.side <= 0 && menu === 'Finding Deleted 1|Resolved by a Person 1|Turned Off 1' && offOn.filter === 'off'
    && offOn.more === 'Filter (on)', JSON.stringify({ closedPane, openPane, menu, offOn }));
  await page.evaluate(() => store.ui({ selectedChecklist: null })); await page.evaluate((d) => store.refreshChecklist(d), id); await page.waitForTimeout(300);
  const last = fs[2]; const text = 'Who signed the side letter?';
  const it = await page.evaluate((f) => store.get().findings[f].itemId, last);
  await page.evaluate((i) => store.ui({ selectedChecklist: i }), it); await page.waitForSelector('#ck-ask'); await page.click('#ck-ask'); await page.fill('#ck-ask-text', text);
  await page.evaluate(([d, f]) => store.dispatch(store.commandNamed('SetFindingStatus'), { dealId: d, findingId: f, status: 'closed', note: 'Agreed' }, { quiet: true }), [id, last]);
  await page.waitForFunction(() => document.getElementById('ck-ask-log')?.disabled, null, { timeout: 5000 }).catch(() => {});
  const closed = await page.evaluate(() => ({ text: document.getElementById('ck-ask-text')?.value, log: document.getElementById('ck-ask-log')?.disabled, why: document.getElementById('ck-ask-log')?.title }));
  await page.press('#ck-ask-text', 'Escape'); await page.evaluate((i) => store.ui({ selectedChecklist: i }), it); await page.waitForSelector('#ck-detail');
  closed.back = await page.evaluate(() => document.getElementById('ck-ask-text')?.value);
  say('a question being typed stays when its finding is closed, and Log says why not', closed.text === text && closed.log && closed.why === 'Its finding is closed' && closed.back === text, JSON.stringify(closed));
  await page.evaluate(([d, i]) => store.dispatch(store.commandNamed('SetItemsOff'), { dealId: d, off: [i] }, { quiet: true }), [id, it]);
  await page.evaluate(([d, f]) => store.dispatch(store.commandNamed('DeleteFinding'), { dealId: d, findingId: f }, { quiet: true }), [id, last]);
  await page.waitForFunction(() => document.getElementById('ck-ask-log')?.title === 'Its finding is no longer here', null, { timeout: 5000 }).catch(() => {});
  const gone = await page.evaluate(() => ({ pane: document.querySelector('#ck-detail .dmeta .n')?.textContent, text: document.getElementById('ck-ask-text')?.value, why: document.getElementById('ck-ask-log')?.title }));
  await page.press('#ck-ask-text', 'Escape'); await page.evaluate((i) => store.ui({ selectedChecklist: i }), it); await page.waitForSelector('#ck-detail');
  gone.back = await page.evaluate(() => document.getElementById('ck-ask-text')?.value);
  say('it stays too when the item is turned off and its finding deleted, Escape included', gone.pane === 'Turned off' && gone.text === text && gone.why === 'Its finding is no longer here' && gone.back === text, JSON.stringify(gone));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // a kept question stays on the finding it was started on, though the pane is opened again after its item is turned off
  const { ctx, page, id } = await start();
  const a = await item(page, FLAGGED); const started = await page.evaluate(([d, i]) => store.get().checklists[d].find((r) => r.id === i)?.findingId, [id, a.id]);
  await page.evaluate((d) => store.dispatch(store.commandNamed('CreateFinding'), { dealId: d, title: 'An older point on the same item', workstream: 'Legal' }), id);
  // an older open finding on the same item, put in the store as the backend would raise it, so it comes first among the item's findings
  await page.evaluate((i) => { const s = store.get(); const g = Object.values(s.findings).find((x) => x.title === 'An older point on the same item'); store.set({ ...s, findings: { ...s.findings, [g.id]: { ...g, itemId: i, createdAt: '2000-01-01T00:00:00.000Z' } } }); }, a.id);
  await page.click(`#ck-rows .ckrow:has-text("${FLAGGED}")`); await page.waitForSelector('#ck-ask'); await page.click('#ck-ask'); await page.fill('#ck-ask-text', 'Which ratio was agreed?');
  const before = await page.textContent('#ck-detail .clink');
  await page.click(`#ck-rows .ckrow:has-text("${SAMPLES[0]}")`); await page.waitForSelector('#ck-more');
  await page.evaluate(([d, i]) => store.dispatch(store.commandNamed('SetItemsOff'), { dealId: d, off: [i] }, { quiet: true }), [id, a.id]);   // as a write from another PC arrives
  await page.click(`#ck-rows .ckrow:has-text("${FLAGGED}")`); await page.waitForSelector('#ck-ask-text');
  const after = await page.textContent('#ck-detail .clink');
  const title = await page.evaluate((f) => store.get().findings[f]?.title, started);
  say('a kept question stays linked to its own finding when the item is turned off while another item is open', !!title && before === after && after.includes(title), JSON.stringify({ before, after, title }));
  await ctx.close();
}

async function checkConflictedDraft(page, dealId, itemId, original, other) {
  await recheckFinding(page, dealId, itemId, original.id);
  await page.click('#ck-ask');
  const words = 'Please identify the test at the first distribution date.';
  await page.fill('#ck-ask-text', words);
  await page.evaluate((id) => __peer.edit(id, { status: 'closed' }), original.id);
  await page.waitForFunction((id) => !!store.get().conflicts[id], original.id);
  await recheckFinding(page, dealId, itemId, other);
  await page.press('#ck-ask-text', 'Escape');
  const ask = page.locator('#ck-ask');
  const canReopen = await ask.isEnabled();
  say('a kept question can be opened while its own finding has two versions', canReopen);
  if (canReopen) {
    await ask.click();
    const log = page.locator('#ck-ask-log');
    say('the reopened question keeps its text and original finding, with Log blocked by that finding’s conflict',
      await page.inputValue('#ck-ask-text') === words
      && (await page.textContent('#ck-detail .clink')).includes(original.title)
      && await log.isDisabled() && (await log.getAttribute('title')).includes('Choose one first'));
  }
}

{ // #840: a second open finding cannot take over a question about a covenant.
  const { ctx, page, id } = await start();
  const checklistItem = await item(page, FLAGGED);
  const row = page.locator(`#ck-rows [data-item="${checklistItem.id}"]`);
  const original = await page.evaluate((itemId) =>
    Object.values(store.get().findings).find((finding) => finding.itemId === itemId), checklistItem.id);
  const text = 'Please confirm the lock-up ratio in the executed credit agreement.';
  await row.click();
  await page.click('#ck-ask');
  await page.fill('#ck-ask-text', text);
  const other = await page.evaluate((id) => __peer.add(id, {
    title: 'Distribution test uses a different measurement period', status: 'open',
  }), original.id);
  await turnOff(page);
  await page.waitForSelector('#ck-on');
  await page.evaluate((id) => __peer.change(id, { status: 'closed' }), original.id);
  await page.waitForFunction((id) => store.get().findings[id]?.status === 'closed', original.id);

  const log = page.locator('#ck-ask-log');
  const card = async (reason) => (await page.inputValue('#ck-ask-text')) === text
    && (await page.textContent('#ck-detail .clink')) === `Linked to “${original.title}”`
    && await log.isDisabled() && (await log.getAttribute('title')) === reason;
  say('a peer closing the original finding keeps the question on it and disables Log',
    await card('Its finding is closed'));
  await log.evaluate((button) => button.click());
  const saved = () => page.evaluate((words) =>
    Object.values(store.get().questions).filter((q) => q.text === words), text);
  say('attempting to log while the other finding is open creates no question', (await saved()).length === 0);

  await page.reload();
  await row.click();
  await page.waitForSelector('#ck-ask-text');
  say('after restart the draft and its closed finding are still together', await card('Its finding is closed'));
  await page.evaluate(([dealId, findingId]) =>
    store.dispatch(store.commandNamed('DeleteFinding'), { dealId, findingId }), [id, original.id]);
  await page.waitForFunction((id) => !!store.get().tombstones[id], original.id);
  await page.click('#ck-close');
  await row.click();
  say('reopening a draft after deletion keeps its text and identifies the missing finding',
    await card('Its finding is no longer here'));

  await page.evaluate(([dealId, findingId]) =>
    store.dispatch(store.commandNamed('RestoreFinding'), { dealId, findingId }), [id, original.id]);
  await page.evaluate((id) => __peer.change(id, { status: 'open' }), original.id);
  await page.waitForFunction(() => document.getElementById('ck-ask-log')?.disabled === false);
  await page.click('#ck-on');
  await page.waitForSelector('#ck-more');
  await recheckFinding(page, id, checklistItem.id, other);
  await page.fill('#ck-ask-text', '');
  await page.fill('#ck-ask-text', text);
  say('editing after a new check leaves the draft on its original finding',
    (await page.getAttribute('#ck-open-finding', 'href')).includes(other)
    && (await page.textContent('#ck-detail .clink')).includes(original.title));
  await log.click();
  await page.waitForSelector('#ck-ask-text', { state: 'detached' });
  const questions = await saved();
  const otherOpen = await page.evaluate((id) => store.get().findings[id]?.status === 'open', other);
  say('reopening the original finding allows logging once with its original links', otherOpen && questions.length === 1
    && questions[0].linkedFinding === original.id && questions[0].linkedItem?.id === checklistItem.id);
  await checkConflictedDraft(page, id, checklistItem.id, original, other);
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
