// Browser workflow tests for slice 1. Run: node tests/browser/slice.spec.mjs (expects the static server on :4178)
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { followUp } from './followUp.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = [];
const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);

async function fresh() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new, #ov-standing', { timeout: 10000 });
  return { ctx, page };
}
const newDeal = async (page, name, folder = 'reports') => {
  await page.click('#fr-new, #new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', name);
  if (folder) { await page.click('#nd-paste'); await page.fill('#nd-path', folder); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); }
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  return page.evaluate(() => Object.values(store.get().deals)[0].id);
};
const addQuestion = async (page, text) => { await page.evaluate(() => { window.__prevQ = store.get().ui.selectedQuestion; }); await page.click('#qa-add'); await page.waitForFunction(() => { const q = store.get().ui.selectedQuestion; return !!q && q !== window.__prevQ && !document.querySelector('.det[inert]') && !!document.querySelector('.det textarea.qtext'); }); await page.fill('.det textarea.qtext', text); await page.press('.det textarea.qtext', 'Tab'); await page.waitForTimeout(700); return page.evaluate(() => store.get().ui.selectedQuestion); };

// 1 create → question → edit → save → reload
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Datum QA');
  await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('#qa-add');
  const qid = await addQuestion(page, 'First line\nSecond line');
  await page.click('.det #q-ws'); await page.click('#q-ws-legal'); await page.waitForTimeout(600);   // Workstream is a button with its own list, as Status is
  await page.reload(); await page.waitForSelector('.md .li');
  const q = await page.evaluate((id) => store.get().questions[id], qid);
  say('create-edit-reload', q && q.text === 'First line\nSecond line' && q.workstream === 'Legal' && q.rev === 3, JSON.stringify({ text: q?.text, ws: q?.workstream, rev: q?.rev }));
  // reversal: undo the delete
  await page.click('.det .del'); await page.click('#ask-go'); await page.waitForSelector('#toast .tundo'); await page.click('#toast .tundo'); await page.waitForTimeout(400);
  const back = await page.evaluate((id) => !!store.get().questions[id], qid);
  say('undo-delete', back);
  await ctx.close(); }

// 2 two tabs editing different questions
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Tabs QA', '');
  await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('#qa-add');
  const q1 = await addQuestion(page, 'one'); const q2 = await addQuestion(page, 'two');
  const page2 = await ctx.newPage(); await page2.goto(URL + '#qa-' + dealId); await page2.waitForSelector('.md .li');
  await page.click(`.md .li >> nth=0`); await page.fill('.det textarea.qtext', 'TAB A edit'); await page.press('.det textarea.qtext', 'Tab'); await page.waitForTimeout(700);
  await page2.click(`.md .li >> nth=1`); await page2.fill('.det textarea.qtext', 'TAB B edit'); await page2.press('.det textarea.qtext', 'Tab'); await page2.waitForTimeout(700);
  await page.reload(); await page.waitForSelector('.md .li');
  const r = await page.evaluate(([a, b]) => [store.get().questions[a].text, store.get().questions[b].text], [q1, q2]);
  say('two-tabs', r[0] === 'TAB A edit' && r[1] === 'TAB B edit', JSON.stringify(r));
  // and tab A sees B's change arrive without reload
  await page2.fill('.det textarea.qtext', 'TAB B again'); await page2.press('.det textarea.qtext', 'Tab'); await page2.waitForTimeout(800);
  const live = await page.evaluate((b) => store.get().questions[b].text, q2);
  say('two-tabs-live-sync', live === 'TAB B again', live);
  await ctx.close(); }

// 3 storage full → not saved, text kept, retry works
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Quota QA', '');
  await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('#qa-add');
  await addQuestion(page, 'before');
  // fill the origin's storage until a 512-byte write fails, leaving no headroom for the app's next transaction
  await page.evaluate(() => { let i = 0; for (const size of [262144, 16384, 512]) { for (;;) { try { localStorage.setItem('qaQuotaFixture' + (i++), 'x'.repeat(size)); } catch { break; } } } });
  await page.fill('.det textarea.qtext', 'QA real browser quota failure'); await page.press('.det textarea.qtext', 'Tab'); await page.waitForTimeout(900);
  const shown = await page.evaluate(() => ({ field: document.querySelector('.det textarea.qtext').value, state: !!document.querySelector('.efstate.fail'), toast: document.getElementById('toast')?.textContent || '', stored: Object.values(store.get().questions)[0].text }));
  say('storage-full-surfaced', shown.state && /storage is full/.test(shown.toast) && shown.field === 'QA real browser quota failure' && shown.stored === 'before', JSON.stringify(shown));
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('qaQuotaFixture')) localStorage.removeItem(k); });
  await page.click('.efstate.fail'); await page.waitForTimeout(600);
  const after = await page.evaluate(() => Object.values(store.get().questions)[0].text);
  say('storage-full-retry', after === 'QA real browser quota failure', after);
  await ctx.close(); }

// 3b an Undo refused because storage is full keeps its notice, and works once there is room
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Quota Undo', '');
  await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('#qa-add');
  const q = await addQuestion(page, 'to be deleted');
  await page.evaluate(() => { for (const t of [...store.get().ui.toasts]) store.dismissToast(t.id); });
  await page.evaluate(([d, id]) => store.dispatch(store.commandNamed('DeleteQuestion'), { dealId: d, questionId: id }), [dealId, q]);
  await page.waitForSelector('.toast .tundo'); await page.hover('.toast');
  await page.evaluate(() => { let i = 0; for (const size of [262144, 16384, 512]) { for (;;) { try { localStorage.setItem('qaQuotaFixture' + (i++), 'x'.repeat(size)); } catch { break; } } } });
  await page.click('.toast .tundo:has-text("Undo")'); await page.waitForTimeout(600);
  const kept = await page.evaluate(() => store.get().ui.toasts.some((t) => t.action?.label === 'Undo'));
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('qaQuotaFixture')) localStorage.removeItem(k); });
  await page.click('.toast .tundo:has-text("Undo")'); await page.waitForFunction((id) => !!store.get().questions[id], q, { timeout: 3000 }).catch(() => {});
  const back = await page.evaluate((id) => !!store.get().questions[id], q);
  say('undo-refused-for-space-can-be-tried-again', kept && back, JSON.stringify({ kept, back }));
  await ctx.close(); }

// 4 delayed save then undo → undo wins, survives reload
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Delay QA', '');
  await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('#qa-add');
  const qid = await addQuestion(page, 'slow');
  await page.evaluate(() => { const repo = store.services.repo; const orig = repo.transaction.bind(repo); let n = 0; repo.transaction = async (tx) => { if (tx.writes.some((w) => w.kind === 'question') && ++n === 1) await new Promise((r) => setTimeout(r, 900)); return orig(tx); }; });
  await page.click('.det #q-status'); await page.click('#q-st-closed');   // Status is a button with its own list
  await page.waitForTimeout(50);
  // the toast only appears after commit; undo must still be the final word
  await page.waitForFunction(() => /marked closed/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 4000 }); await page.click('#toast .tundo'); await page.waitForTimeout(1500);
  await page.reload(); await page.waitForSelector('.md .li, .emptyline');
  const st = await page.evaluate((id) => store.get().questions[id].status, qid);
  say('delayed-save-vs-undo', st === 'open', st);
  await ctx.close(); }

// 5 navigate away while a save is pending → saves to the original deal
{ const { ctx, page } = await fresh();
  const dealA = await newDeal(page, 'Nav A', '');
  await page.goto(URL + '#qa-' + dealA); await page.waitForSelector('#qa-add');
  const qid = await addQuestion(page, 'stay here');
  await page.click('#new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', 'Nav B'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  const dealB = await page.evaluate(() => Object.values(store.get().deals).find((d) => d.name === 'Project Nav B').id);
  await page.goto(URL + '#qa-' + dealA); await page.waitForSelector('.md .li');
  await page.evaluate(() => { const repo = store.services.repo; const orig = repo.transaction.bind(repo); let n = 0; repo.transaction = async (tx) => { if (tx.writes.some((w) => w.kind === 'question') && ++n === 1) await new Promise((r) => setTimeout(r, 700)); return orig(tx); }; });
  await page.fill('.det textarea.qtext', 'edited while leaving'); await page.press('.det textarea.qtext', 'Tab');
  await page.waitForTimeout(50); await page.goto(URL + '#qa-' + dealB); await page.waitForTimeout(1200);
  await page.reload(); await page.waitForSelector('#qa-add');
  const r = await page.evaluate(async ([a, id]) => { await store.loadDeal(a); const q = store.get().questions[id]; return { deal: q.dealId === a, text: q.text }; }, [dealA, qid]);
  say('navigate-during-save', r.deal && r.text === 'edited while leaving', JSON.stringify(r));
  await ctx.close(); }

// 6 interrupted operation after reload
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Interrupt QA', '');
  await page.evaluate(async () => { await store.services.repo.transaction({ writes: [{ kind: 'op', id: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', data: { id: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', command: 'CreateQuestion', input: { dealId: Object.keys(store.get().deals)[0], text: 'interrupted one' }, targets: [], state: 'pending', startedAt: new Date().toISOString() }, expectedRev: null }] }); });
  await page.reload(); await page.waitForSelector('.intbar');
  const txt = await page.textContent('.intbar');
  await page.click('.intbar .intop button'); await page.waitForTimeout(500);
  const made = await page.evaluate(() => Object.values(store.get().questions).some((q) => q.text === 'interrupted one'));
  say('interrupted-retry', /interrupted/.test(txt) && made, txt.trim());
  await ctx.close(); }

// #565: the fourth notice counts the interrupted actions outside the first three.
{
  const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Interrupted actions', '');
  await page.evaluate(async (dealId) => {
    const writes = Array.from({ length: 5 }, (_, index) => {
      const id = 'op_01HZZZZZZZZZZZZZZZZZZZZZZ' + index;
      const input = { dealId, text: `Interrupted question ${index}` };
      const data = { id, command: 'CreateQuestion', input, targets: [], state: 'pending' };
      return { kind: 'op', id, data: { ...data, startedAt: new Date().toISOString() }, expectedRev: null };
    });
    await store.services.repo.transaction({ writes });
  }, dealId);
  await page.reload();
  await page.waitForSelector('.intbar .toast');
  const notices = page.locator('.intbar .toast');
  const count = await notices.count();
  const summary = await notices.last().locator('.ttext').textContent();
  say('interrupted-actions-show-a-summary', count === 4 && summary === '2 more interrupted',
    JSON.stringify({ count, summary }));
  const rows = page.locator('.intbar .intop');
  const showing = () => rows.evaluateAll((items) => items.map((item) => item.id));
  const pending = () => page.evaluate(() => store.interruptedOps().map(({ id }) => `interrupted-${id}`));
  const initiallyShowing = await showing();
  const [dismissed] = initiallyShowing;
  const all = await pending();
  const outside = all.filter((id) => !initiallyShowing.includes(id)).at(-1);
  await rows.first().getByRole('button', { name: 'Dismiss' }).click();
  const afterDismiss = await showing();
  const hiddenCount = Number.parseInt(await notices.last().locator('.ttext').textContent(), 10);
  say('dismissed-interrupted-writes-still-count',
    !afterDismiss.includes(dismissed) && (await pending()).length === 5 && afterDismiss.length + hiddenCount === 5);

  const overflow = notices.last();
  const show = overflow.getByRole('button', { name: 'Show', exact: true });
  const canShow = await show.count() === 1 && await overflow.getByRole('button', { name: 'Dismiss' }).count() === 0;
  say('interrupted-summary-stays-actionable', canShow);
  if (canShow) {
    await show.press('Enter');
    await page.waitForFunction(() => document.activeElement.matches('.intop .tundo'));
    const focused = await page.evaluate(() => document.activeElement.closest('.intop')?.id);
    const restored = (await showing()).includes(dismissed);
    if (!(await showing()).includes(outside)) await show.click();
    const retry = page.locator('#' + outside).getByRole('button', { name: 'Retry', exact: true });
    const discard = page.locator('#' + dismissed).getByRole('button', { name: 'Discard', exact: true });
    await retry.click();
    await page.waitForFunction(({ id, text }) =>
      store.get().ops[id]?.state === 'succeeded' && Object.values(store.get().questions).some((q) => q.text === text),
    { id: outside.replace('interrupted-', ''), text: `Interrupted question ${outside.at(-1)}` });
    if (!(await showing()).includes(dismissed)) await show.click();
    await discard.click();
    const discardedId = dismissed.replace('interrupted-', '');
    await page.waitForFunction((id) => store.get().ops[id]?.state === 'discarded', discardedId);
    say('dismissed-and-overflowed-writes-can-be-retried-and-discarded',
      focused === dismissed && restored && (await pending()).length === 3 &&
      await page.locator('.intbar').getByRole('button', { name: 'Show', exact: true }).count() === 0);
  }
  await ctx.close();
}

// 7 double-click create → one deal
{ const { ctx, page } = await fresh();
  await page.evaluate(() => { const repo = store.services.repo; const orig = repo.transaction.bind(repo); repo.transaction = async (tx) => { if (tx.writes.some((w) => w.kind === 'deal')) await new Promise((r) => setTimeout(r, 500)); return orig(tx); }; });
  await page.click('#fr-new'); await page.fill('#nd-name', 'Double QA');
  await page.click('#nd-create'); await page.click('#nd-create', { force: true }).catch(() => {}); await page.waitForTimeout(1500);
  const n = await page.evaluate(() => Object.values(store.get().deals).filter((d) => d.name === 'Project Double QA').length);
  say('double-create', n === 1, 'deals=' + n);
  await ctx.close(); }

// 8 backend unreachable during start-up, then recovery
{ const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage();
  await page.addInitScript(() => { window.__down = true; });
  await page.goto(URL); await page.waitForSelector('.netbar', { timeout: 5000 });
  const booting = await page.evaluate(() => document.body.classList.contains('booting'));
  // in words the person knows (it said "Can't reach the backend")
  const bar = await page.textContent('.netbar');
  say('offline-bar-says-not-connected', /^Not connected · RetryingRetry Now$/.test(bar.trim()), bar);
  await page.evaluate(() => { window.__down = false; }); await page.click('.netbar .tundo'); await page.waitForTimeout(1200);
  const ready = await page.evaluate(() => !document.body.classList.contains('booting') && store.get().boot.stage === 'ready');
  say('startup-recovery', booting && ready);
  await ctx.close(); }

// 9 focus survives edits; line breaks and spaces preserved; arrow keys after click
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Focus QA', '');
  await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('#qa-add');
  await addQuestion(page, 'a'); await addQuestion(page, 'b');
  await page.click('.md .li >> nth=0'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(100);
  const idx = await page.evaluate(() => [...document.querySelectorAll('.md .li')].findIndex((x) => x.classList.contains('on')));
  await page.click('.det textarea.qtext'); await page.keyboard.press('Control+a'); await page.keyboard.type('QA words with spaces'); await page.keyboard.press('Enter'); await page.keyboard.type('next paragraph');
  await page.click('.det #q-ws'); await page.waitForTimeout(300);
  const focusOnSelect = await page.evaluate(() => document.activeElement.matches('#q-ws'));
  await page.waitForTimeout(600);
  const txt = await page.evaluate(() => Object.values(store.get().questions).find((q) => /QA words/.test(q.text))?.text);
  say('focus-and-text', idx === 1 && focusOnSelect && txt === 'QA words with spaces\nnext paragraph', JSON.stringify({ idx, focusOnSelect, txt }));
  say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// Add deal: a deal someone else made is listed to add; adding it puts it in the sidebar, Undo takes it out again
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Theirs', '');
  await page.evaluate(async (id) => { await store.dispatch(store.commandNamed('SetDealMember'), { dealId: id, on: false }); }, dealId);   // as if another person had made it
  await page.goto(URL + '#deals'); await page.waitForSelector('#fr-new');
  const firstRun = await page.textContent('#fr-new');
  await page.click('#fr-new'); await page.waitForSelector('#add-find');
  await page.fill('#add-find', 'zzz'); const none = !!(await page.$('#add-none'));
  await page.fill('#add-find', 'thei');
  const add = page.locator(`[data-add="${dealId}"]`);
  const addLabel = await add.getAttribute('aria-label');
  say('add-button-names-the-deal-1370', addLabel === 'Add Project Theirs to my deals', String(addLabel));
  await add.click();
  await page.waitForSelector(`.addrow[data-deal="${dealId}"] .yours`);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => [...document.querySelectorAll('.rail .grp-h .cnt')].some((c) => c.textContent === '1'));
  const inRail = await page.evaluate(() => [...document.querySelectorAll('.rail .grp-h .cnt')].some((c) => c.textContent === '1'));
  const homeBare = await page.evaluate(() => !document.querySelector('.home a[href]') && !document.querySelector('.home section'));   // Home is the composer alone
  await page.click('#toast .tundo'); await page.waitForSelector('#fr-new');
  say('add-deal', /Add Deal/.test(firstRun) && none && inRail && homeBare,
    JSON.stringify({ firstRun, none, inRail, homeBare }));
  say('add-deal-no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// Remove from my deals: the sidebar's ⋯, a confirm, then Undo puts it back
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Leaving', '');
  await page.goto(URL + '#deals'); await page.waitForSelector('.rail .drow');
  const hidden = await page.$eval('.rail .dmore', (b) => getComputedStyle(b).opacity === '0');
  await page.hover('.rail .drow'); await page.click('.rail .dmore'); await page.waitForSelector('#deal-unlist');
  await page.click('#deal-unlist'); await page.waitForSelector('#ul-keep');
  const keepFocused = await page.evaluate(() => document.activeElement?.id === 'ul-keep');
  await page.click('#ul-keep'); const stillMine = await page.evaluate((id) => !!document.querySelector('.rail .drow') && store.get().ui.removeDeal === null, dealId);
  await page.hover('.rail .drow'); await page.click('.rail .dmore'); await page.click('#deal-unlist'); await page.click('#ul-go');
  await page.waitForSelector('#fr-new'); const gone = !(await page.$('.rail .drow'));
  await page.click('#toast .tundo'); await page.waitForSelector('.rail .drow');
  say('remove-from-my-deals', hidden && keepFocused && stillMine && gone, JSON.stringify({ hidden, keepFocused, stillMine, gone }));
  say('remove-no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// A closed finding the documents bring into question: one Reopen, through the usual note; nothing else to press
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Closed Q', '');
  const fid = await page.evaluate(async (dealId) => {
    const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
    await run('CreateFinding', { dealId, title: 'Step-in period short', workstream: 'Legal' });
    const f = Object.values(store.get().findings).find((x) => x.title === 'Step-in period short');
    await run('SetFindingStatus', { dealId, findingId: f.id, status: 'closed' });
    await run('RestoreFindingSnapshot', { dealId, findingId: f.id, snapshot: { ...store.get().findings[f.id], updated: true, updatedWhy: 'New term sheet' } });   // as a check marks it
    return f.id;
  }, dealId);
  await page.goto(`${URL}#finding-${dealId}-${fid}`); await page.waitForSelector('#f-reopen');
  const buttons = await page.$$eval('#f-maybe button', (b) => b.map((x) => x.textContent));
  await page.click('#f-reopen'); await page.waitForSelector('#fnote-save'); await page.click('#fnote-save');
  await page.waitForFunction((id) => store.get().findings[id].status === 'open', fid);
  say('closed-finding-reopen', buttons.length === 1 && buttons[0] === 'Reopen', JSON.stringify(buttons));
  say('closed-finding-no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// ---- a document's copies are counted once: Overview says how many a folder holds, and reading mode's list names the other folders ----
{ const { ctx, page } = await fresh(); await page.evaluate(() => { window.__copies = { reports: 15 }; });
  const dealId = await newDeal(page, 'Copies');
  await page.waitForFunction(() => Object.values(store.get().findings).length >= 3, null, { timeout: 30000 });
  await page.goto(`${URL}#overview-${dealId}`); await page.waitForSelector('#ov-docs .copies', { timeout: 15000 });
  const ov = await page.evaluate(() => { const r = document.querySelector('#ov-docs [data-folder]'); return { copies: r.querySelector('.copies').textContent, rd: r.querySelector('.rd').textContent, of: store.get().deals[Object.keys(store.get().deals)[0]].folders[0].files }; });
  say('copies-on-overview', ov.copies === '15 copies counted once' && new RegExp(`^[\\d,]+ of ${(ov.of - 15).toLocaleString()} read$`).test(ov.rd), JSON.stringify(ov));
  const fid = await page.evaluate((d) => Object.values(store.get().findings).find((f) => f.dealId === d).id, dealId);
  await page.goto(`${URL}#finding-${dealId}-${fid}`);
  await followUp(page, 'Why does this matter?');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed) .acts', { timeout: 15000 });
  await page.click('.opening .ref .rb'); await page.waitForSelector('.docpanel');
  await page.evaluate(() => { const name = document.querySelector('#doc-menu .dn b').textContent.trim(); window.__places = { [name]: [{ folder: 'reports', name }, { folder: 'reports/09 Superseded', name }, { folder: 'reports/Archive', name: 'TA report.pdf' }] }; });
  await page.click('#doc-menu'); await page.waitForSelector('.dm-r .alsoat', { timeout: 10000 });
  const also = await page.$$eval('.dm-r .alsoat', (els) => els.map((e) => [e.textContent, e.title]));
  say('copies-in-reading-list', also.length === 1 && also[0][0] === 'Also in 2 more folders: 09 Superseded, Archive' && also[0][1].endsWith('Archive › TA report.pdf'), JSON.stringify(also));
  say('copies-no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
