// Ten decisions on records, folders and imports. Each check is the thing a person would do.
import { launchChrome } from './chrome.mjs';
import { openRename } from './dealMenu.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openOnFindings } from './landing.mjs';
import { followUp } from './followUp.mjs';
import { checkHeadingRow, headingWorkbook } from './headingRow.mjs';
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
const addQ = async (page, text) => {
  await page.evaluate(() => { window.__prevQ = store.get().ui.selectedQuestion; }); await page.click('#qa-add');
  await page.waitForFunction(() => { const q = store.get().ui.selectedQuestion; return !!q && q !== window.__prevQ && !document.querySelector('.det[inert]') && !!document.querySelector('.det textarea.qtext'); });
  await page.fill('.det textarea.qtext', text); await page.press('.det textarea.qtext', 'Tab');
  await page.waitForFunction((t) => store.get().questions[store.get().ui.selectedQuestion]?.text === t, text);
  return page.evaluate(() => store.get().ui.selectedQuestion);
};
// the pointer is moved off first: toasts stack in one place now, and one under the pointer waits
const toastsGone = async (page) => { await page.mouse.move(2, 400); return page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 12000 }); };
const rect = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null; }, sel);
const apart = (a, b) => !a || !b || a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t;

{ const { ctx, page, id } = await start('dark');
  // ---- 10. one name per thing ---------------------------------------------------------------------------
  const words = async () => page.evaluate(() => document.body.innerText + ' ' + [...document.querySelectorAll('[aria-label],[placeholder]')].map((e) => (e.getAttribute('aria-label') ?? '') + ' ' + (e.getAttribute('placeholder') ?? '')).join(' '));
  const dealWords = await words();
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); const q1 = await addQ(page, 'Who holds the interconnection agreement?');
  const qaWords = await words();
  const old = /outstanding|categor|red flag|mandate|recogni[sz]ed/i;
  say('one-name-per-thing', !old.test(dealWords) && !old.test(qaWords) && /FINDINGS|Findings/.test(dealWords) && /Open 1/.test(qaWords) && /Workstream/.test(qaWords), JSON.stringify({ deal: dealWords.match(old), qa: qaWords.match(old) }));
  const filters = await page.evaluate(() => [...document.querySelectorAll('.trk-tools input.field')].map((i) => [i.placeholder, i.getAttribute('aria-label')]));
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow');
  say('list-fields-are-filters-not-search', filters.length === 1 && filters[0].join() === 'Filter,Filter questions' && (await page.evaluate(() => document.querySelectorAll('input[placeholder="Search"]').length)) === 1, JSON.stringify(filters));

  // ---- 4. toasts sit clear of the composer and the reading bar; a second action keeps the first one's Undo ----
  await toastsGone(page);
  await page.click('.flagrow'); await page.waitForSelector('#f-review'); await page.click('#f-review'); await page.waitForSelector('#toast');
  await page.click('#f-review'); await page.waitForFunction(() => document.querySelectorAll('.toast').length === 2);
  const two = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => ({ text: t.querySelector('.ttext').textContent, undo: !!t.querySelector('.tundo'), newest: t.id === 'toast' })));
  const tr = await rect(page, '.toasts'), comp = await rect(page, '#pcomposer');
  say('two-toasts-each-with-undo', two.length === 2 && two.every((t) => t.undo) && two[1].newest && !two[0].newest, JSON.stringify(two));
  say('toasts-clear-of-the-composer', tr.t < 60 && apart(tr, comp), JSON.stringify({ tr, comp }));
  // undo the OLDER one (reviewed), leaving the newer in place; it sits behind the newest until the deck is pointed at
  await page.hover('.toasts'); await page.waitForTimeout(300);
  const fid = await page.evaluate(() => store.get().ui.route.findingId);
  await page.locator('.toast').first().locator('.tundo').click(); await page.waitForFunction(() => document.querySelectorAll('.toast').length <= 2);
  await page.waitForTimeout(400);
  // the pointer resting on a toast stops its clock
  await page.evaluate(() => store.toast('Stay while I read you', { label: 'Undo', run() {} })); await page.hover('#toast'); await page.waitForTimeout(9200);
  const held = await page.evaluate(() => [...document.querySelectorAll('.toast .ttext')].some((t) => t.textContent === 'Stay while I read you'));
  await page.mouse.move(640, 500); await toastsGone(page);
  say('toast-waits-while-hovered-then-goes', held);
  // reading bar
  await page.click('.opening .ref .rb'); await page.waitForSelector('.docnav'); await page.evaluate(() => store.toast('Finding marked closed', { label: 'Undo', run() {} })); await page.waitForSelector('#toast');
  const bar = await rect(page, '.docnav'), tr2 = await rect(page, '.toasts'), comp2 = await rect(page, '#pcomposer');
  say('toasts-clear-of-the-reading-bar', apart(tr2, bar) && apart(tr2, comp2), JSON.stringify({ tr2, bar }));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => store.get().ui.doc == null);

  // ---- 8. a finding's words can be edited; nothing else about it moves -------------------------------------
  const f0 = await page.evaluate((i) => store.get().findings[i], fid);
  await page.click('#f-edit'); await page.waitForSelector('#fe-title');
  const focusOnTitle = await page.evaluate(() => document.activeElement.id);
  await page.fill('#fe-title', 'Operating assumption differs between the two reports');
  await page.keyboard.press('Escape'); await page.waitForSelector('#fe-title', { state: 'detached' });
  const canceled = await page.evaluate((i) => store.get().findings[i].title, fid);
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Operating assumption differs between the two reports');
  await page.selectOption('#fe-ws', 'Legal');
  await page.click('#fe-save'); await page.waitForSelector('#fe-title', { state: 'detached' });
  const f1 = await page.evaluate((i) => store.get().findings[i], fid);
  const shown = await page.evaluate(() => ({ title: document.querySelector('.opening .qtxt').textContent, refs: document.querySelectorAll('.opening .ref .rb').length, toast: document.querySelector('#toast .ttext')?.textContent }));
  say('finding-edit-cancel-changes-nothing', focusOnTitle === 'fe-title' && canceled === f0.title, canceled);
  const sameAsBefore = (k) => JSON.stringify(f1[k]) === JSON.stringify(f0[k]);
  const editWords = f1.title === 'Operating assumption differs between the two reports' && f1.workstream === 'Legal';
  const editKept = f1.status === f0.status && ['sources', 'reviewed', 'body'].every(sameAsBefore);
  const editShown = shown.title === f1.title && shown.refs >= 2 && shown.toast === 'Finding edited';
  const editSeen = JSON.stringify({ f1: [f1.title, f1.workstream, f1.status], shown });
  say('finding-edit-saves-words-only', editWords && editKept && editShown, editSeen);
  await page.click('#toast .tundo'); await page.waitForFunction((t) => store.get().findings[store.get().ui.route.findingId].title === t, f0.title);
  say('finding-edit-undo', true);

  // ---- 7. attaching on a finding goes with the next message only; it joins the sources when the person says so ----
  await page.setInputFiles('#pcomposer input[type=file]', { name: 'side-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') }); await page.waitForSelector('.askbox .chip.att:not(.pending)');
  await page.waitForTimeout(500);
  const afterAttach = await page.evaluate((i) => ({ sources: store.get().findings[i].sources.length, updated: store.get().findings[i].updated, add: !!document.querySelector('.askbox .chip.att [data-addsrc]') }), fid);
  say('attach-does-not-touch-the-finding', afterAttach.sources === f0.sources.length && afterAttach.updated === f0.updated && afterAttach.add, JSON.stringify(afterAttach));
  // another finding's composer does not show it; nor does the deal chat
  const others = await page.evaluate((i) => Object.values(store.get().findings).filter((f) => f.id !== i).map((f) => f.id), fid);
  await page.goto(`${URL}#finding-${id}-${others[0]}`); await page.waitForSelector('#f-edit'); const leakF = await page.evaluate(() => document.querySelectorAll('.askbox .chip.att').length);
  await page.goto(`${URL}#chat-${id}`); await page.waitForSelector('#pask'); const leakD = await page.evaluate(() => document.querySelectorAll('.askbox .chip.att').length);
  await page.goto(`${URL}#finding-${id}-${fid}`); await page.waitForSelector('.askbox .chip.att');
  say('attachment-stays-in-its-conversation', leakF === 0 && leakD === 0);
  await toastsGone(page);
  await page.click('.askbox .chip.att [data-addsrc]'); await page.waitForFunction((n) => store.get().findings[store.get().ui.route.findingId].sources.length === n + 1, f0.sources.length);
  const added = await page.evaluate((i) => ({ src: store.get().findings[i].sources.at(-1),
    toast: document.querySelector('#toast .ttext')?.textContent, undo: !!document.querySelector('#toast .tundo'),
    stillOffered: !!document.querySelector('.askbox .chip.att [data-addsrc]'),
    listed: [...document.querySelectorAll('.opening .rsch-chip')].map((b) => b.textContent) }), fid);
  const once = added.listed.filter((t) => /side-letter\.pdf/.test(t)).length === 1;
  say('add-to-sources-is-explicit-with-undo', added.src.doc === 'side-letter.pdf' && added.src.loc === ''
    && added.toast === 'side-letter.pdf added to the finding’s sources' && added.undo && !added.stillOffered && once,
    JSON.stringify(added));
  await page.click('#toast .tundo'); await page.waitForFunction((n) => store.get().findings[store.get().ui.route.findingId].sources.length === n, f0.sources.length);
  await page.fill('#pask', 'Does the side letter change this?'); await page.press('#pask', 'Enter'); await page.waitForSelector('.msgs .matt .chip.att'); await page.waitForSelector('.msgs .ai:not(.pending)', { timeout: 10000 });
  const onMsg = await page.evaluate((i) => ({ composer: document.querySelectorAll('.askbox .chip.att').length, msg: document.querySelector('.msgs .matt .chip.att')?.textContent ?? '', add: !!document.querySelector('.msgs .matt [data-addsrc]'), sources: store.get().findings[i].sources.length }), fid);
  say('sent-file-stays-on-its-message-and-can-still-be-added', onMsg.composer === 0 && /side-letter\.pdf/.test(onMsg.msg) && onMsg.add && onMsg.sources === f0.sources.length, JSON.stringify(onMsg));

  // ---- 3. deleted findings and questions can be put back ---------------------------------------------------
  await toastsGone(page);
  // a delete asks first: Keep it leaves the finding, with the focus back on Delete
  await page.click('#f-delete'); await page.waitForSelector('#ask-keep:focus');
  const askD = await page.evaluate(() => ({ title: document.querySelector('#ask-title').textContent, go: document.querySelector('#ask-go').textContent, tip: document.querySelector('#ask-go').title }));
  await page.keyboard.press('Enter'); await page.waitForFunction(() => !document.querySelector('.scrim'));
  const keptD = await page.evaluate((i) => ({ there: !!store.get().findings[i], focus: document.activeElement?.id }), fid);
  say('deleting-a-finding-asks-first-and-keep-it-keeps-it', askD.title === 'Delete this finding?' && askD.go === 'Delete' && askD.tip === 'It can be restored from Deleted' && keptD.there && keptD.focus === 'f-delete', JSON.stringify({ askD, keptD }));
  await page.click('#f-delete'); await page.click('#ask-go'); await page.waitForSelector('#f-more');
  // Deleted… is in the ⋯ menu, on once there is something in it
  await page.click('#f-more');
  const delBtn = await page.$eval('#f-deleted', (b) => (b.disabled ? 'off' : b.textContent));
  await page.keyboard.press('Escape');
  await toastsGone(page);                                                   // the Undo toast has gone: this is the way back
  await page.click('#f-more'); await page.click('#f-deleted'); await page.waitForSelector('.deldlg .delrow');
  const delRow = await page.evaluate(() => ({ code: document.querySelector('.delrow .dcode')?.textContent ?? null, text: document.querySelector('.delrow .dtext b').textContent, meta: document.querySelector('.delrow .dmeta').textContent }));
  const delTip = await page.evaluate(() => { const b = document.querySelector('.delrow .dtext b'); return b.title === b.textContent && !!b.title; });
  say('a-deleted-title-shows-whole-on-hover', delTip);
  await page.click('.delrow [data-restore]'); await page.waitForFunction((i) => !!store.get().findings[i], fid);
  // with the last one put back there is nothing left to list: the dialog closes by itself and the focus goes back to
  // the ⋯ button that opened it, not to nowhere
  await page.waitForSelector('.deldlg', { state: 'detached' }); await page.waitForTimeout(150);
  const restored = await page.evaluate(
    (i) => ({ back: store.get().findings[i].title, focus: document.activeElement?.id }), fid);
  say('deleted-finding-restored', delBtn === 'Deleted…' && delRow.code === null && delRow.text === f0.title
    && /^Deleted by jdoe · \w{3} \d+, \d+:\d\d\s[AP]M$/.test(delRow.meta) && restored.back === f0.title
    && restored.focus === 'f-more' && !(await page.$('#f-deleted')), JSON.stringify({ delBtn, delRow, restored }));
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li'); const q2 = await addQ(page, 'Please confirm the distribution lock-up test.');
  await page.click('.det .del'); await page.waitForSelector('#ask-keep:focus'); const askQ = await page.textContent('#ask-title'); await page.click('#ask-keep'); await page.waitForFunction(() => !document.querySelector('.scrim'));
  say('deleting-a-question-asks-first-and-keep-it-keeps-it', askQ === 'Delete Q2?' && await page.evaluate((q) => !!store.get().questions[q], q2), askQ);
  await page.click('.det .del'); await page.click('#ask-go'); await page.waitForFunction((q) => !store.get().questions[q], q2); const q3 = await addQ(page, 'A later question');
  const nums = await page.evaluate((i) => Object.values(store.get().questions).filter((q) => q.dealId === i).map((q) => q.n).sort(), id);
  await page.click('#qa-cols'); await page.click('#qa-deleted'); await page.waitForSelector('.deldlg .delrow'); await page.click('.delrow [data-restore]'); await page.waitForFunction((q) => !!store.get().questions[q], q2); await page.waitForSelector('.deldlg', { state: 'detached' });
  const nums2 = await page.evaluate((i) => Object.values(store.get().questions).filter((q) => q.dealId === i).map((q) => q.n).sort(), id);
  say('deleted-question-restored-and-number-not-reused', nums.join() === '1,3' && nums2.join() === '1,2,3', JSON.stringify({ nums, nums2 }));

  // ---- 8. questions have no direction: no control on the question or in More; one hint in the response box ----
  await page.click(`.md .li:has-text("A later question")`); await page.waitForFunction((q) => store.get().ui.selectedQuestion === q, q3);
  const ph = await page.getAttribute('.det textarea.rtext', 'placeholder'); const dirSel = await page.$('.det select[aria-label="Direction"]'); const propsEnd = await page.evaluate(() => document.querySelector('.qpanel .qprops').textContent.trim().slice(-1));
  await page.click('#qa-cols'); const newmode = await page.$('[data-newmode]'); const menuText = await page.textContent('#colmenu'); await page.keyboard.press('Escape');
  say('questions-have-no-direction', ph === 'Type the response' && !dirSel && !newmode && !/We ask|We answer|New questions/.test(menuText) && propsEnd !== '·', JSON.stringify({ ph, dirSel: !!dirSel, newmode: !!newmode, propsEnd }));
  const q4 = await addQ(page, 'A question put to us');

  // ---- adding a question while the save is slow: nothing typed lands in the previous question --------------------
  await page.evaluate(() => { const repo = store.services.repo; const orig = repo.transaction.bind(repo); window.__slow = true; repo.transaction = async (tx) => { if (window.__slow) await new Promise((r) => setTimeout(r, 500)); return orig(tx); }; });
  const beforeText = await page.evaluate((q) => store.get().questions[q].text, q4);
  await page.click('#qa-add'); await page.waitForSelector('.det[inert]');
  await page.keyboard.type('typed too early');
  await page.evaluate(() => { window.__slow = false; }); await page.waitForFunction(() => !document.querySelector('.det[inert]')); await page.waitForTimeout(900);
  const afterText = await page.evaluate((q) => store.get().questions[q].text, q4);
  say('add-question-never-types-into-the-previous-one', afterText === beforeText, afterText);

  // ---- 2 and 8. the deal header: status, rename ----------------------------------------------------------------
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('#deal-group'); await toastsGone(page);
  // the app's own list, not the system's (#567)
  await page.click('#deal-group');
  await page.waitForSelector('#deal-grouplist');
  const opts = await page.evaluate(() => {
    const options = [...document.querySelectorAll('#deal-grouplist [role="option"]')];
    return options.map((o) => o.textContent);
  });
  await page.click('#deal-grouplist [role="option"]:has-text("Monitoring")');
  await page.waitForFunction((i) => store.get().deals[i].group === 'monitor', id);
  await page.waitForSelector('#toast .tundo', { timeout: 5000 }).catch(() => {});   // the notice follows the saved write, a moment after the deal moves: on a busy machine it was read too soon
  const moved = await page.evaluate(() => ({ toast: document.querySelector('#toast .ttext')?.textContent, undo: !!document.querySelector('#toast .tundo'), groups: [...document.querySelectorAll('.rail .grp-h')].map((g) => [g.textContent, g.getAttribute('aria-expanded')]), row: document.querySelector('.rail .dealrow.on')?.textContent }));
  say('deal-status-moves-it-in-the-rail', opts.join() === 'Live,Monitoring,Pitch,Closed' && moved.toast === 'Project Proseware moved to Monitoring' && moved.undo && moved.groups.find((g) => /Monitoring/.test(g[0]))[1] === 'true' && /Monitoring1/.test(moved.groups.map((g) => g[0]).join(' ')) && moved.row === 'Project Proseware', JSON.stringify(moved));
  // the group holding the open deal can be folded
  await page.click('.rail .grp-h:has-text("Monitoring")'); const folded = await page.evaluate(() => !document.querySelector('.rail .dealrow'));
  // folded stays folded across a reload, like the other view choices; unfolding is kept as well
  await page.reload(); await page.waitForSelector('.rail .grp-h'); await page.waitForSelector('.dtabs'); await page.waitForTimeout(300);
  const afterReload = await page.evaluate(() => ({ rows: document.querySelectorAll('.rail .dealrow').length, exp: [...document.querySelectorAll('.rail .grp-h')].find((g) => /Monitoring/.test(g.textContent)).getAttribute('aria-expanded') }));
  await page.click('.rail .grp-h:has-text("Monitoring")'); await page.waitForSelector('.rail .dealrow');
  say('rail-group-with-the-open-deal-can-fold', folded);
  say('a-folded-group-stays-folded-after-a-reload', afterReload.rows === 0 && afterReload.exp === 'false', JSON.stringify(afterReload));
  // the tabs stay put when the name becomes a field, and an emptied name says why it can't be saved
  const tabsAt = () => page.evaluate(() => Math.round(document.querySelector('.dtabs').getBoundingClientRect().left));
  const tabs0 = await tabsAt();
  await openRename(page);
  await page.waitForSelector('#deal-name');
  const tabs1 = await tabsAt();
  await page.fill('#deal-name', ''); await page.press('#deal-name', 'Enter'); await page.waitForTimeout(200);
  const emptied = await page.evaluate(() => ({ open: !!document.getElementById('deal-name'), said: store.get().ui.toasts.some((t) => t.text === 'A deal needs a name') }));
  await page.press('#deal-name', 'Escape'); await page.waitForSelector('#deal-name', { state: 'detached' });
  say('rename-keeps-the-tabs-still-and-an-empty-name-says-why', tabs0 === tabs1 && emptied.open && emptied.said, JSON.stringify({ tabs0, tabs1, emptied }));
  await openRename(page);
  await page.waitForSelector('#deal-name');
  const sel = await page.evaluate(() => {
    const i = document.getElementById('deal-name');
    return document.activeElement === i && i.selectionStart === 0 && i.selectionEnd === i.value.length;
  });
  await page.keyboard.type('Something else'); await page.keyboard.press('Escape'); await page.waitForSelector('#deal-name', { state: 'detached' });
  const kept = await page.evaluate((i) => [store.get().deals[i].name, document.activeElement.id], id);
  await openRename(page);
  await page.fill('#deal-name', 'Project Proseware Holdings');
  await page.keyboard.press('Enter');
  await page.waitForFunction((i) => store.get().deals[i].name === 'Project Proseware Holdings', id);
  const headed = () => document.querySelector('.headrow h1')?.textContent === 'Project Proseware Holdings';
  await page.waitForFunction(headed, null, { timeout: 3000 }).catch(() => {});
  const renamed = await page.evaluate(() => ({ h1: document.querySelector('.headrow h1').textContent, rail: document.querySelector('.rail .dealrow.on').textContent, trail: document.querySelector('.trail').textContent, title: document.title }));
  const renamedShown = renamed.h1 === 'Project Proseware Holdings' && renamed.rail === 'Project Proseware Holdings'
    && /Project Proseware Holdings/.test(renamed.trail);
  // Escape gives the focus back to ⋯, where Rename was chosen
  const ok = sel && kept[0] === 'Project Proseware' && kept[1] === 'deal-more' && renamedShown;
  say('rename-in-place', ok, JSON.stringify({ kept, renamed }));
  // a name typed without "Project " has 8 characters less room, as in the New deal dialog, since "Project " is added to it
  await openRename(page);
  await page.waitForSelector('#deal-name');
  await page.keyboard.type('x'.repeat(115));
  const room = await page.evaluate(() => document.getElementById('deal-name').value.length); await page.keyboard.press('Escape');
  say('a-rename-without-project-has-room-for-it', room === 112, JSON.stringify({ room }));
  // a very long name stays on one line everywhere and pushes nothing off the page
  const long = 'Project ' + 'Extraordinarily long portfolio refinancing name '.repeat(2).trim().slice(0, 105);
  await openRename(page);
  await page.fill('#deal-name', long);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => Object.values(store.get().deals)[0].name === n, long);
  const fit = await page.evaluate(() => { const h = document.querySelector('.headrow h1').getBoundingClientRect(), row = document.querySelector('.headrow').getBoundingClientRect(), acts = document.querySelector('.hacts').getBoundingClientRect(), tabs = document.querySelector('.dtabs').getBoundingClientRect(), rr = document.querySelector('.rail .dealrow.on').getBoundingClientRect(), rail = document.querySelector('.rail').getBoundingClientRect(), t = document.querySelector('.toast')?.getBoundingClientRect(); return { h1Height: Math.round(h.height), inside: acts.right <= row.right + 1 && h.right <= tabs.left + 1, railRow: Math.round(rr.height), railInside: rr.right <= rail.right, toastW: t ? Math.round(t.width) : 0, scroll: document.documentElement.scrollWidth <= innerWidth }; });
  say('long-deal-name-fits', fit.h1Height < 45 && fit.inside && fit.railRow === 32 && fit.railInside && fit.toastW <= 520 && fit.scroll, JSON.stringify(fit));
  say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// ---- indexing that did not finish is shown as stopped, never assumed done -----------------
{ const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: 'light' }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  // the backend refuses to start
  await page.evaluate(() => { window.__fail = { index: true }; });
  await page.click('#fr-new'); await page.waitForSelector('#nd-create');
  // a deal needs a name: until it has one, Create is off, and pointing at it says why
  const need0 = await page.evaluate(() => ({ off: document.getElementById('nd-create').disabled, why: document.getElementById('nd-need').title, text: document.getElementById('nd-create').textContent }));
  await page.fill('#nd-name', 'Stalled'); const need1 = await page.evaluate(() => ({ off: document.getElementById('nd-create').disabled, why: document.getElementById('nd-need').title }));
  say('create-is-off-until-the-deal-has-a-name-and-says-why', need0.off && need0.why === 'Give the deal a name' && need0.text === 'Create' && !need1.off && !need1.why, JSON.stringify({ need0, need1 }));
  await page.fill('#nd-name', 'Stalled'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  await page.waitForSelector('#ix-stalled'); const onFindings = await page.evaluate(() => ({ tab: document.querySelector('.dtabs a.on').textContent, docs: !!document.querySelector('.dcrow') }));
  await page.click('.dtabs a:has-text("Overview")'); await page.waitForSelector('#ov-docs .dcrow');      // the folders and how far they have got are on Overview; the stopped line is on both pages
  const s0 = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { stage: d.stage, indexed: d.folders.map((f) => f.indexed), text: document.getElementById('ix-stalled').textContent, tip: document.getElementById('ix-resume').title, sub: document.querySelector('#ov-docs .dcrow .rd').textContent, live: !!document.querySelector('#ov-docs .fbar .live'), toast: document.querySelector('#toast .ttext')?.textContent, toasts: [...document.querySelectorAll('.toast .ttext')].map((t) => t.textContent).join('|'), trail: document.querySelector('.trail .facts')?.textContent }; });
  say('failed-start-says-stopped-on-the-deal', s0.stage === 'indexing' && s0.indexed.join() === '0'
    && /^Indexing has not started\. Retry Now$/.test(s0.text) && s0.tip === 'It will be tried again automatically.'
    && /^0 of [\d,]+ indexed · not started$/.test(s0.sub) && /^Indexing not started\b/.test(s0.trail)
    && s0.toasts === 'Project Stalled created|Couldn’t start indexing' && !s0.live
    && s0.toast === 'Couldn’t start indexing' && onFindings.tab === 'Findings' && !onFindings.docs,
    JSON.stringify({ s0, onFindings }));
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 12000 });
  say('resume-stays-after-the-toast-has-gone', !!(await page.$('#ix-resume')));
  // start it, then close the app part-way: on return nothing is assumed finished
  // the app is closed and opened again, and this time the start is not refused: the deal is one this PC was asked to index, so it starts by itself
  await page.reload(); await page.waitForSelector('#ov-docs .dcrow');
  await page.waitForFunction(() => { const d = Object.values(store.get().deals)[0]; const f = store.get().indexing[d.id]?.folders[0]; return f && f.indexed > 0; }, null, { timeout: 15000 });
  const picked = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { stalled: !!document.getElementById('ix-stalled'), marked: store.get().ui.indexStalled.includes(d.id), toasts: document.querySelectorAll('.toast').length }; });
  say('a-start-that-was-refused-is-picked-up-when-the-app-opens-again', !picked.stalled && !picked.marked && picked.toasts === 0, JSON.stringify(picked));
  // while it runs, progress is shown on the page and nothing is saved to the deal
  await page.waitForFunction(() => { const d = Object.values(store.get().deals)[0]; const f = store.get().indexing[d.id]?.folders[0]; return f && f.indexed > 0 && f.indexed < f.files; }, null, { timeout: 15000 });
  const mid = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { live: store.get().indexing[d.id].folders[0].indexed, saved: d.folders[0].indexed, rev: d.rev, shown: document.querySelector('#ov-docs .dcrow .rd').textContent, moving: !!document.querySelector('#ov-docs .fbar .ix.live') }; });
  await page.waitForFunction((was) => { const d = Object.values(store.get().deals)[0]; return (store.get().indexing[d.id]?.folders[0].indexed ?? 0) > was; }, mid.live, { timeout: 15000 });
  const later = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { saved: d.folders[0].indexed, rev: d.rev }; });
  say('progress-is-shown-and-not-saved-while-indexing', mid.live > 0 && mid.saved === 0 && later.saved === 0 && later.rev === mid.rev && new RegExp('^' + mid.live.toLocaleString() + ' of [\\d,]+ indexed$').test(mid.shown) && mid.moving, JSON.stringify({ mid, later }));
  // the app is closed part-way and opened again. First with the backend refusing to start: nothing is announced, the page says where indexing stopped and that it will be tried again
  await page.addInitScript(() => { if (sessionStorage.getItem('failIndexOnce')) { sessionStorage.removeItem('failIndexOnce'); window.__fail = { index: true }; } });
  await page.evaluate(() => sessionStorage.setItem('failIndexOnce', '1'));
  await page.reload(); await page.waitForSelector('#ix-stalled', { timeout: 10000 });
  const quiet = await page.evaluate(() => document.querySelectorAll('.toast').length);
  const s1 = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { stage: d.stage, indexed: d.folders[0].indexed, files: d.folders[0].files, findings: Object.keys(store.get().findings).length, shown: document.querySelector('#ov-docs .dcrow .rd')?.textContent, line: document.getElementById('ix-stalled').textContent, trail: document.querySelector('.trail .facts')?.textContent }; });
  // how far it had got is kept by the backend on this PC: after the reload the page says where it stopped, not zero
  const where = /^([\d,]+) of ([\d,]+) indexed · stopped$/.exec(s1.shown ?? ''); const gotTo = where ? +where[1].replace(/,/g, '') : -1;
  say('reload-mid-indexing-is-not-marked-ready', s1.stage === 'indexing' && s1.indexed < s1.files && s1.findings === 0, JSON.stringify({ mid, s1 }));
  say('after-a-reload-the-page-says-where-indexing-stopped', gotTo >= mid.live && gotTo < s1.files
    && s1.line === `Indexing stopped at ${gotTo.toLocaleString()} of ${s1.files.toLocaleString()} files. Retry Now` &&
    /^Indexing stopped\b/.test(s1.trail) && quiet === 0, JSON.stringify({ s1, live: mid.live, quiet }));
  // opened again while the data room cannot be reached yet (the PC is still connecting): that is not a failure. The page says it is waiting, nothing is announced,
  // and when the folders can be reached indexing picks up by itself from where it stopped, with nothing to press; the first pass follows
  await page.addInitScript(() => { if (sessionStorage.getItem('roomAwayOnce')) { sessionStorage.removeItem('roomAwayOnce'); window.__fail = { roomAway: true }; } });
  await page.evaluate(() => sessionStorage.setItem('roomAwayOnce', '1'));
  await page.reload(); await page.waitForSelector('#ix-stalled', { timeout: 10000 }); await page.waitForFunction(() => /data room can be reached/.test(document.getElementById('ix-resume')?.title ?? ''), null, { timeout: 10000 });
  const away = await page.evaluate(() => ({ line: document.getElementById('ix-stalled').textContent, tip: document.getElementById('ix-resume').title, toasts: document.querySelectorAll('.toast').length }));
  say('with-the-data-room-not-reachable-yet-it-waits-and-says-so',
    away.line === `Indexing stopped at ${gotTo.toLocaleString()} of ${s1.files.toLocaleString()} files. Retry Now` &&
    away.tip === 'It will resume when the data room can be reached.' && away.toasts === 0, JSON.stringify(away));
  // when the backend says what stopped the run, the line says it, between where it stopped and what happens next
  const whyLine = await page.evaluate(async () => { const d = Object.values(store.get().deals)[0]; store.ui((ui) => ({ indexWhy: { ...ui.indexWhy, [d.id]: 'The data room stopped answering.' } })); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return document.getElementById('ix-stalled').textContent; });
  say('what-stopped-indexing-is-said-on-the-line',
    whyLine === `Indexing stopped at ${gotTo.toLocaleString()} of ${s1.files.toLocaleString()} files.`
      + ' The data room stopped answering. Retry Now', whyLine);
  await page.evaluate(() => { window.__fail = {}; });
  await page.waitForFunction((n) => { const d = Object.values(store.get().deals)[0]; const f = store.get().indexing[d.id]?.folders[0]; return (f && f.indexed > n) || d.stage === 'ready'; }, gotTo, { timeout: 20000 });
  const auto = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { stalled: !!document.getElementById('ix-stalled'), marked: store.get().ui.indexStalled.includes(d.id), toasts: document.querySelectorAll('.toast').length }; });
  say('indexing-left-unfinished-resumes-by-itself-when-the-app-opens', !auto.stalled && !auto.marked && auto.toasts === 0, JSON.stringify(auto));
  await page.waitForFunction(() => Object.keys(store.get().findings).length === 3, null, { timeout: 40000 }); await page.waitForSelector('#ov-core');
  const s2 = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { stage: d.stage, done: d.folders.every((f) => f.indexed === f.files), stalled: !!document.getElementById('ix-stalled'), shown: document.querySelector('#ov-docs .dcrow .rd').textContent, core: document.getElementById('ov-core').textContent, live: !!document.querySelector('#ov-docs .fbar .live') }; });
  // (a folder's own `reviewed` count is no longer filled in: what has been read is what the backend reports, and it is on the page)
  say('resume-finishes-and-the-first-pass-runs', s2.stage === 'ready' && s2.done && !s2.stalled && /^[\d,]+ of [\d,]+ read$/.test(s2.shown) && /^Core documents[\d,]+ of [\d,]+ read$/.test(s2.core) && !s2.live, JSON.stringify(s2));
  say('no-page-errors-indexing', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

{ // #380: an invalid heading row stays visible when another Q&A import choice redraws the dialog.
  const { ctx, page, id } = await start('light');
  await page.goto(URL + '#qa-' + id);
  await page.click('#qa-cols');
  await page.click('#qa-import');
  const fixture = await headingWorkbook(page, 'im');
  await page.waitForSelector('#im-header');
  const { invalid, ...checks } = await checkHeadingRow(page, 'im', fixture, '#im-answered');
  say('Q&A heading-row edits preserve typed text and the accepted preview',
    fixture.lastRow >= 2000 && invalid.every(Boolean) && Object.values(checks).every(Boolean) && !page.errors.length,
    JSON.stringify({ invalid, ...checks, errors: page.errors }));
  await ctx.close();
}

// ---- more decisions -------------------------------------------------------------------------------------------------
{ const { ctx, page, id } = await start('light');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-')); 
  // a log the way they arrive: a cover sheet, then the table at D6 under a title, with padding
  // a sheet as LibreOffice reads it: a grid of text from A1, with blocks of cells placed at their top-left cell
  const sheet = (name, parts) => { const grid = []; for (const [origin, cells] of parts) { const m = /^([A-Z])(\d+)$/.exec(origin); const c0 = m[1].charCodeAt(0) - 65, r0 = +m[2] - 1; cells.forEach((row, i) => { row.forEach((v, j) => { while (grid.length <= r0 + i) grid.push([]); const r = grid[r0 + i]; while (r.length <= c0 + j) r.push(''); r[c0 + j] = String(v); }); }); } return { name, grid }; };
  await page.evaluate((s) => { window.__sheets = s; }, {
    'Proseware log.xlsx': [sheet('Cover', [['B3', [['Project Proseware'], ['Strictly confidential']]]]), sheet('Q&A', [['D2', [['Project Proseware: lender Q&A log'], [], ['Prepared November 9, 2026']]], ['D6', [['#', 'Question', 'Submitted by', 'Response'], [1, 'Is the EPC wrap fixed price?', 'Lender A', 'Yes, lump sum turnkey.'], [2, 'Who holds the interconnection agreement?', 'Lender A', '']]]])],
    'odd.xlsx': [sheet('Log', [['B2', [['Queries', 'for', 'the sponsor']]], ['B5', [['Ref', 'Lender query', 'Sponsor reply'], ['A1', 'Is the debt sized on P90?', 'Yes']]]])],
  });
  const file = path.join(tmp, 'Proseware log.xlsx'); fs.writeFileSync(file, 'PK\u0003\u0004');               // the stand-in takes its sheets from __sheets
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-cols'); await page.click('#qa-cols'); await page.click('#qa-import'); await page.setInputFiles('#im-file', file); await page.waitForSelector('.immap');
  const at = () => page.evaluate(() => ({ sheet: document.getElementById('im-sheet')?.value, sheets: [...(document.getElementById('im-sheet')?.options ?? [])].map((o) => o.value), row: document.getElementById('im-header').value, q: document.querySelector('[data-immap="text"]').selectedOptions[0].textContent, cols: [...document.querySelector('[data-immap="text"]').options].map((o) => o.textContent).slice(1), first: [...document.querySelectorAll('.imprev:not(.imchg) tbody tr:first-child td')].map((x) => x.textContent), line: document.getElementById('im-line').textContent, go: !document.getElementById('im-go').disabled }));
  const i0 = await at();
  say('import-finds-the-table-under-a-title-on-the-right-sheet', i0.sheet === 'Q&A' && i0.sheets.join() === 'Cover,Q&A' && i0.row === '6' && i0.q === 'Question' && i0.cols.join() === '#,Question,Submitted by,Response' && i0.first[0] === 'Is the EPC wrap fixed price?' && /Import 2 questions · 2 new/.test(i0.line) && i0.go, JSON.stringify(i0));
  // the person can move the heading row; a wrong row is plainly wrong and Import stays off
  await page.fill('#im-header', '2'); await page.waitForFunction(() => /Choose the question column/.test(document.getElementById('im-line').textContent));
  const i1 = await at();
  await page.fill('#im-header', '6'); await page.waitForFunction(() => /Import 2 questions/.test(document.getElementById('im-line').textContent));
  await page.selectOption('#im-sheet', 'Cover'); await page.waitForFunction(() => document.getElementById('im-sheet').value === 'Cover' && !/Import 2/.test(document.getElementById('im-line').textContent));
  const i2 = await at();
  await page.selectOption('#im-sheet', 'Q&A'); await page.waitForFunction(() => /Import 2 questions/.test(document.getElementById('im-line').textContent));
  say('heading-row-and-sheet-are-the-persons-to-change', i1.row === '2' && !i1.go && i2.sheet === 'Cover' && !i2.go && (await at()).row === '6', JSON.stringify({ i1: [i1.row, i1.line], i2: [i2.sheet, i2.line] }));
  // a response with no status stays Open unless the person checks the box
  const checked0 = await page.isChecked('#im-answered');
  await page.check('#im-answered'); await page.click('#im-go'); await page.waitForFunction(() => !document.querySelector('.imdlg'));
  const imported = await page.evaluate((i) => Object.values(store.get().questions).filter((q) => q.dealId === i).sort((a, b) => a.n - b.n).map((q) => [q.n, q.text, q.status, q.response]), id);
  say('imported-response-answers-only-when-checked', !checked0 && imported.length === 2 && imported[0][2] === 'answered' && imported[0][3] === 'Yes, lump sum turnkey.' && imported[1][2] === 'open', JSON.stringify(imported));

  // headings in words the app does not know: the model proposes the layout, it is shown as a proposal, and the person can still change it
  { const oddFile = path.join(tmp, 'odd.xlsx'); fs.writeFileSync(oddFile, 'PK\u0003\u0004');
    await page.evaluate(() => { window.__fail = { layout: true }; });
    await page.click('#qa-cols'); await page.click('#qa-import'); await page.setInputFiles('#im-file', oddFile); await page.waitForSelector('.immap'); await page.waitForFunction(() => /Choose the question column/.test(document.getElementById('im-line').textContent));
    const byHand = await page.evaluate(() => ({ file: document.querySelector('.imfile').textContent, go: !document.getElementById('im-go').disabled, ask: !!document.getElementById('im-ask') }));
    await page.evaluate(() => { window.__fail = {}; }); await page.click('#im-ask'); await page.waitForFunction(() => /layout proposed by AI/.test(document.querySelector('.imfile').textContent), null, { timeout: 8000 });
    const prop = await at();
    await page.selectOption('[data-immap="n"]', ''); const changed = await page.evaluate(() => document.querySelector('[data-immap="n"]').value);
    await page.click('#im-restart'); await page.click('#im-restart-ask-go'); await page.waitForSelector('#im-drop'); await page.keyboard.press('Escape'); await page.waitForSelector('.imdlg', { state: 'detached' });
    say('ai-proposes-the-layout-and-the-person-decides', !/proposed by AI/.test(byHand.file) && !byHand.go && byHand.ask && prop.row === '5' && prop.q === 'Lender query' && prop.first[0] === 'Is the debt sized on P90?' && prop.go && changed === '', JSON.stringify({ byHand, prop: [prop.row, prop.q, prop.line] })); }

  // a waiting draft stands in the response's place; the status control stays. Use as response makes it the response,
  // which can then be typed over
  await addQ(page, 'What lock-up test does the facility draft set?'); await page.waitForSelector('#q-draft'); await page.click('#q-draft'); await page.waitForSelector('.qpanel .draft:not(.pending)', { timeout: 8000 });
  const beside = await page.evaluate(() => ({ draft: !!document.querySelector('.qpanel .draft'), box: !!document.querySelector('.qpanel textarea.rtext'), status: !!document.querySelector('.qpanel #q-status'), word: document.querySelector('.qpanel .qright .qlbl .sub')?.textContent ?? '' }));
  const actions = await page.$$eval('.qpanel .racts button', (bs) => bs.map((x) => x.textContent));   // one action takes the draft: no Edit beside it
  await page.click('.qpanel .racts button:has-text("Use as response")'); await page.waitForSelector('.qpanel textarea.rtext');
  await page.fill('.qpanel textarea.rtext', 'Held by the project company; expires 2041.'); await page.press('.qpanel textarea.rtext', 'Tab');
  await page.waitForFunction(() => store.get().questions[store.get().ui.selectedQuestion].response === 'Held by the project company; expires 2041.');
  say('a-draft-stands-in-the-responses-place-and-use-makes-it-the-response',
    actions.join() === 'Use as Response,Discard' && beside.draft && !beside.box && beside.status
    && beside.word === 'Draft Response' && !(await page.$('.qpanel .draft')), JSON.stringify({ beside, actions }));

  // "Use as response" asks first when a response is already there
  const qid = await page.evaluate(() => store.get().ui.selectedQuestion);
  const qn = await page.evaluate((q) => store.get().questions[q].n, qid);
  await page.click('#q-discuss'); await page.waitForSelector('#pask'); await page.fill('#pask', 'When does it expire?'); await page.press('#pask', 'Enter'); await page.waitForSelector('.msgs .ai:not(.pending):not(.failed)', { timeout: 10000 });
  await page.click('.msgs .ai .acts button[aria-label="Use as response"]'); await page.waitForSelector('.card.confirm');
  const ask1 = await page.evaluate((q) => ({ text: document.querySelector('.card.confirm p').textContent, focus: document.activeElement.id, still: store.get().questions[q].response }), qid);
  await page.click('#use-keep'); await page.waitForSelector('.card.confirm', { state: 'detached' });
  const kept = await page.evaluate((q) => store.get().questions[q].response, qid);
  await page.click('.msgs .ai .acts button[aria-label="Use as response"]'); await page.click('#use-replace'); await page.waitForFunction((q) => store.get().questions[q].response !== 'Held by the project company; expires 2041.', qid);
  const replacementNotice = `Response to Q${qn} replaced`;
  await page.waitForFunction((text) => {
    return document.querySelector('#toast .ttext')?.textContent === text;
  }, replacementNotice);
  const replaced = await page.evaluate(() => document.querySelector('#toast .ttext')?.textContent);
  say('use-as-response-asks-before-replacing',
    /already has a response\. Replace it/.test(ask1.text) && ask1.focus === 'use-replace'
    && ask1.still === 'Held by the project company; expires 2041.' && kept === ask1.still
    && replaced === replacementNotice, JSON.stringify({ ask1, replaced }));

  // Search and Settings by mouse while the rail is folded
  const folded = await page.evaluate(() => ({ search: !!document.getElementById('rt-search'), settings: !!document.getElementById('rt-settings'), railField: !!document.querySelector('.rail #pal-in') }));
  await page.click('#rt-search'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); const floated = await page.evaluate(() => document.getElementById('rsearch').classList.contains('float'));
  await page.click('#rt-search'); await page.waitForFunction(() => !document.getElementById('pal-in'));
  await page.click('#rt-settings'); await page.waitForSelector('#s-theme'); await page.keyboard.press('Escape'); await page.waitForSelector('#s-theme', { state: 'detached' });
  say('search-and-settings-by-mouse-on-a-folded-rail', folded.search && folded.settings && !folded.railField && floated && (await page.evaluate(() => document.activeElement.id)) === 'rt-settings', JSON.stringify(folded));

  // the counterparty on every deal page; the deal's structure, sector and technology on Overview; a folder is labeled
  // with its own name
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.trail [aria-label="Counterparty"]');
  await page.fill('.trail [aria-label="Counterparty"]', 'Northwind Sponsor LP'); await page.press('.trail [aria-label="Counterparty"]', 'Tab');
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-details [aria-label="Structure"]');
  for (const [l, v] of [['Structure', 'Construction loan'], ['Sector', 'Battery storage'], ['Technology', 'Long-duration storage']]) { await page.fill(`#ov-details [aria-label="${l}"]`, v); await page.press(`#ov-details [aria-label="${l}"]`, 'Tab'); }
  await page.waitForFunction((i) => { const d = store.get().deals[i]; return d.counterparty === 'Northwind Sponsor LP' && d.product === 'Construction loan' && d.sector === 'Battery storage' && d.technology === 'Long-duration storage'; }, id);
  await page.reload(); await page.waitForSelector('#ov-details [aria-label="Structure"]');
  const facts = await page.evaluate((i) => { const v = (l) => document.querySelector(`#ov-details [aria-label="${l}"]`).value; const cols = [...document.querySelectorAll('#ov-details > div')].map((c) => Math.round(c.getBoundingClientRect().left)); return { cp: document.querySelector('.trail [aria-label="Counterparty"]').value, product: v('Structure'), sector: v('Sector'), technology: v('Technology'), trail: [...document.querySelectorAll('.trail .tfacts input')].map((e) => e.getAttribute('aria-label')).join(), order: [...document.querySelectorAll('#ov-details .k')].map((e) => e.textContent).join(), even: cols.length === 3 && Math.abs((cols[1] - cols[0]) - (cols[2] - cols[1])) <= 1, label: store.get().deals[i].folders[0].label, path: store.get().deals[i].folders[0].path, scroll: document.documentElement.scrollWidth <= innerWidth }; }, id);
  const elsewhere = []; for (const r of ['deal', 'checklist', 'qa']) { await page.goto(URL + `#${r}-` + id); await page.waitForSelector('.trail [aria-label="Counterparty"]'); elsewhere.push(await page.evaluate(() => !document.getElementById('ov-details') && document.querySelectorAll('.trail .tfacts input').length === 1)); }
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.trail [aria-label="Counterparty"]');
  // they sit at the right end of the line, in the same place on every tab, whatever the trail on the left says
  const spot = () => page.evaluate(() => { const r = document.querySelector('.trail .tfacts').getBoundingClientRect(), h = document.querySelector('.headrow').getBoundingClientRect(), tr = document.querySelector('.trail').getBoundingClientRect(); return { right: Math.round(r.right), left: Math.round(r.left), headRight: Math.round(h.right), dy: Math.round(r.top - tr.top), oneLine: tr.height < 30 }; });
  const onDeal = await spot(); await page.click('.dtabs a:has-text("Q&A")'); await page.waitForSelector('#qa-add'); await page.waitForTimeout(500); const onQa = await spot();
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.trail [aria-label="Counterparty"]');
  say('deal-facts-pinned-right-on-every-tab', onDeal.right === onDeal.headRight && onQa.right === onQa.headRight && onDeal.right === onQa.right && onDeal.left === onQa.left && onDeal.oneLine && onQa.oneLine, JSON.stringify({ onDeal, onQa }));
  say('the-deals-details-are-kept-and-sit-on-overview-only', facts.cp === 'Northwind Sponsor LP' && facts.product === 'Construction loan' && facts.sector === 'Battery storage' && facts.technology === 'Long-duration storage' && facts.trail === 'Counterparty' && facts.order === 'Structure,Sector,Technology' && facts.even && elsewhere.every(Boolean) && facts.scroll, JSON.stringify({ facts, elsewhere }));
  say('folder-label-is-the-folders-own-name', facts.label === 'reports' && facts.path === 'reports', JSON.stringify([facts.label, facts.path]));
  say('no-page-errors-round-two', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// ---- decisions, second batch ----------------------------------------------------------------------------------------
{ const { ctx, page, id } = await start('dark');
  // a deal's folders live in the Folders dialog, off the page; a label can be changed there, and more can be added
  const onPage = await page.evaluate(() => !!document.querySelector('.foldlist, .twocol #folders'));
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#f-folders'); const notOnFindings = await page.evaluate(() => !document.querySelector('.fhead #f-folders'));
  await page.click('#f-folders'); await page.waitForSelector('#folders .fdrow');
  // Choose Folders… is the one filled action while nothing waits
  const f0 = await page.evaluate(() => ({
    title: document.getElementById('nd-title').textContent,
    n: document.querySelectorAll('#folders .fdrow').length,
    label: document.querySelector('#folders .ef').value,
    files: document.querySelector('#folders .cnt').textContent,
    path: document.querySelector('#folders .p').textContent,
    pri: [...document.querySelectorAll('.nddlg .btn.pri:not(:disabled)')].map((b) => b.id).join(),
    add: !!document.getElementById('nd-create'),
    close: document.getElementById('nd-x').getAttribute('aria-label'),
  }));
  await page.fill('#folders .ef', 'Advisor reports'); await page.press('#folders .ef', 'Tab'); await page.waitForFunction((i) => store.get().deals[i].folders[0].label === 'Advisor reports', id);
  await page.click('#nd-x'); await page.waitForSelector('#nd-title', { state: 'detached' });
  await page.reload(); await page.waitForSelector('#f-folders'); await page.click('#f-folders');
  await page.waitForSelector('#folders .fdrow');
  say('folders-in-their-dialog-and-relabeled', !onPage && notOnFindings && f0.title === 'Folders on Project Proseware'
    && f0.n === 1 && f0.label === 'reports' && /files$/.test(f0.files) && f0.path === 'reports'
    && f0.pri === 'nd-browse'
    && !f0.add && f0.close === 'Close' && (await page.inputValue('#folders .ef')) === 'Advisor reports',
    JSON.stringify({ onPage, f0 }));
  // a folder can be taken off the deal from its row, and Undo puts it back as it was (the × is flush with the row's edge: half a pixel allows for the dialog opening)
  const x = await page.evaluate(() => {
    const b = document.querySelector('#folders .fdrow .x');
    const r = b.getBoundingClientRect(), row = b.closest('.fdrow').getBoundingClientRect();
    const cnt = document.querySelector('#folders .cnt').getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), inRow: r.right <= row.right + 0.5 && r.left > cnt.right };
  });
  // it asks first: Keep it comes back to the dialog with the folder still on the deal
  await page.click('#folders .fdrow .x'); await page.waitForSelector('#ask-keep:focus');
  const askF = await page.evaluate(() => ({ title: document.querySelector('#ask-title').textContent, go: document.querySelector('#ask-go').textContent, folders: !!document.querySelector('#folders') }));
  await page.click('#ask-keep');
  await page.waitForSelector('#folders .fdrow .x:focus');
  const keptF = await page.evaluate((i) => ({ n: store.get().deals[i].folders.length, focus: document.activeElement?.getAttribute('aria-label') }), id);
  say('removing-a-folder-asks-first-and-keep-it-keeps-it', askF.title === 'Remove Advisor reports from Project Proseware?' && askF.go === 'Remove' && !askF.folders && keptF.n === 1 && keptF.focus === 'Remove reports', JSON.stringify({ askF, keptF }));
  await page.click('#folders .fdrow .x'); await page.click('#ask-go');
  await page.waitForFunction((i) => store.get().deals[i].folders.length === 0, id);
  // the removed folder's row stays, dimmed, under Removed, with Restore in place of the ×
  await page.waitForSelector('#folders .fdrow.gone');
  const gone = await page.evaluate(() => {
    const g = document.querySelector('#folders .fdrow.gone');
    const path = getComputedStyle(g.querySelector('.p'));
    const title = getComputedStyle(document.getElementById('nd-title'));
    return {
      sub: document.getElementById('folders-removed')?.textContent,
      rows: document.querySelectorAll('#folders .fdrow').length,
      put: g.querySelector('.btn')?.textContent,
      x: !!g.querySelector('.x'),
      edit: !!g.querySelector('.ef'),
      dim: path.opacity + ' ' + (path.color !== title.color),
      notice: [...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent).join('|'),
    };
  });
  await page.click('.toasts .toast button:has-text("Undo")');
  await page.waitForFunction((dealId) => store.get().deals[dealId].folders.length === 1, id);
  await page.waitForSelector('#folders .fdrow.gone', { state: 'detached' });
  const back = await page.evaluate((i) => ({ ...store.get().deals[i].folders[0], stage: store.get().deals[i].stage,
    gone: document.querySelectorAll('#folders .fdrow.gone').length }), id);
  say('a-folder-is-removed-from-its-row-and-undo-brings-it-back', x.label === 'Remove reports' && x.inRow && gone.rows === 1 && gone.put === 'Restore' && gone.sub === 'Removed' && !gone.x && !gone.edit && gone.dim === '1 true' && gone.notice.includes('Advisor reports removed') && back.path === 'reports' && back.label === 'Advisor reports' && back.indexed === back.files && back.stage === 'ready' && back.gone === 0, JSON.stringify({ x, gone, back }));
  // after the notice, Restore on the row brings it back as it was: nothing is indexed again
  await page.click('#folders .fdrow .x'); await page.click('#ask-go');
  await page.waitForSelector('#folders .fdrow.gone');
  await page.evaluate(() => store.ui({ toasts: [] }));
  const runs = await page.evaluate(() => store.get().indexing);
  await page.click('#folders .fdrow.gone .btn');
  await page.waitForFunction((i) => store.get().deals[i].folders.length === 1, id);
  const put = await page.evaluate((i) => ({ f: store.get().deals[i].folders[0],
    removed: store.get().deals[i].removed.length, rows: document.querySelectorAll('#folders .fdrow').length,
    gone: document.querySelectorAll('#folders .fdrow.gone').length,
    indexing: !!store.get().indexing[i] }), id);
  say('restore-on-a-removed-folder-row-keeps-what-was-indexed', put.f.path === 'reports' && put.f.indexed === put.f.files && put.removed === 0 && put.rows === 1 && put.gone === 0 && !put.indexing && !runs[id], JSON.stringify(put));
  // its path added again restores it the same way, from what was indexed
  await page.click('#folders .fdrow .x'); await page.click('#ask-go');
  await page.waitForSelector('#folders .fdrow.gone'); await page.evaluate(() => store.ui({ toasts: [] }));
  await page.click('#nd-paste');
  await page.fill('#nd-path', 'reports');
  await page.press('#nd-path', 'Enter');
  await page.waitForFunction((dealId) => store.get().deals[dealId].folders.length === 1, id);
  await page.locator('.toasts .toast').filter({ hasText: 'restored' }).first().waitFor();
  const again = await page.evaluate((i) => ({ f: store.get().deals[i].folders[0], removed: store.get().deals[i].removed.length, waiting: store.get().ui.newDeal?.folders.length ?? 0, typed: document.getElementById('nd-path')?.value, indexing: !!store.get().indexing[i], notice: [...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent).join('|') }), id);
  say('a-removed-folders-path-added-again-restores-it', again.f.indexed === again.f.files && again.removed === 0 && again.waiting === 0 && again.typed === '' && !again.indexing && again.notice.includes('restored'), JSON.stringify(again));
  await page.keyboard.press('Escape'); await page.waitForSelector('#nd-title', { state: 'detached' }); await page.goto(URL + '#deal-' + id); await page.waitForSelector('.fhead');
  // a chat answer carries a citation per sentence, like a finding
  await page.click('.flagrow');
  await followUp(page, 'Why does this matter?');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed) .ref .rb', { timeout: 10000 });
  const cited = await page.evaluate(() => ({ refs: document.querySelectorAll('.msgs .ai .ref .rb').length, raw: /\[\d+\]/.test(document.querySelector('.msgs .ai').textContent), srcs: store.get().threads[Object.keys(store.get().threads)[0]].at(-1).sources.map((s) => s.doc) }));
  await page.locator('.msgs .ai .ref .rb').nth(1).click(); await page.waitForSelector('.docnav', { timeout: 6000 });
  const opened = await page.evaluate(() => document.querySelector('#doc-menu')?.textContent ?? '');
  // what you sent is on the right and as wide as its words; the answer starts at the left edge
  const sides = await page.evaluate(messageSides);
  // "as wide as its words": the bubble holds its text and its padding, nothing more, whatever the font's widths
  const hugs = Math.abs(sides.spare) <= 2 && sides.meWidth < 260;
  const onRight = sides.meRight === 0 && sides.meLeftGap > 0;
  say('my-message-is-on-the-right', onRight && hugs && sides.aiLeft === 0, JSON.stringify(sides));
  say('chat-answer-cites-each-sentence', cited.refs >= 2 && !cited.raw && opened.includes(cited.srcs[1]), JSON.stringify({ cited, opened }));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => store.get().ui.doc == null && store.get().ui.docAside == null);
  await page.mouse.move(700, 70);                              // off the sentence, so its citation popup closes
  await page.evaluate(() => { const c = document.querySelector('.chat'); c.scrollTop = c.scrollHeight; }); await page.waitForTimeout(200);
  const reach = await page.evaluate(() => { const b = [...document.querySelectorAll('.msgs .ai .acts button')].find((x) => x.getAttribute('aria-label') === 'Add as question').getBoundingClientRect(), c = document.getElementById('pcomposer').getBoundingClientRect(); return b.bottom <= c.top; });
  say('answer-actions-clear-the-composer-when-scrolled-to-the-end', reach);
  await page.click('.msgs .ai .acts button[aria-label="Add as question"]'); await page.waitForSelector('.card.addq textarea');
  say('markers-stay-out-of-a-question-made-from-an-answer', !/\[\d+\]/.test(await page.inputValue('.card.addq textarea')));
  // the open question that stops matching the filter stays, and says so
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); const q = await addQ(page, 'Is the lock-up test in the credit agreement?');
  await page.click('.det #q-ws'); await page.click('#q-ws-legal');   /* Workstream is a button with its own list, as Status is */ await page.waitForFunction((x) => store.get().questions[x].workstream === 'Legal', q);
  await page.click('#qa-ws');
  await page.click('.wsmenu label:has(input[value="Legal"])');
  const inFilter = await page.evaluate(() => !!document.querySelector('.md .li.offfilter'));
  await page.click('.det #q-ws'); await page.click('#q-ws-tax'); await page.waitForFunction((x) => store.get().questions[x].workstream === 'Tax', q);
  const off = await page.evaluate(() => ({ rows: document.querySelectorAll('.md .li').length, mark: document.querySelector('.md .li.offfilter')?.title ?? '', cls: document.querySelector('.md .li').classList.contains('offfilter') }));
  say('open-question-outside-the-filter-is-marked', !inFilter && off.rows === 1 && off.mark === 'Outside this filter' && off.cls, JSON.stringify(off));
  say('no-page-errors-second-batch', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// ---- the firm's name comes from the control file and stamps new questions; Settings has no Firm input -------
for (const scheme of ['dark', 'light']) { const { ctx, page, id } = await start(scheme);
  const asked = (text) => page.evaluate(async ([d, t]) => { await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t }); return Object.values(store.get().questions).find((q) => q.text === t).askedBy; }, [id, text]);
  say(`firm-from-the-control-file-${scheme}`, (await asked('Who holds the land rights?')) === '[firm name]');
  await page.click('#u-menu'); await page.waitForSelector('#s-theme'); await page.waitForTimeout(300);
  const open = await page.evaluate(() => ({ sub: document.querySelector('.sdlg .who').textContent, firm: !!document.getElementById('s-firm'), focus: document.activeElement?.getAttribute('data-theme-pick'), fits: document.querySelector('.sdlg').getBoundingClientRect().bottom <= innerHeight }));
  say(`no-firm-input-in-settings-${scheme}`, !open.firm && open.focus === 'system' && open.fits, JSON.stringify(open));
  const rail = await page.evaluate(() => ({ text: document.getElementById('u-menu').textContent.trim(), gearRight: Math.round(document.getElementById('u-menu').getBoundingClientRect().right - document.getElementById('u-gear').getBoundingClientRect().right) }));
  say(`name-alone-in-settings-and-the-rail-${scheme}`, open.sub === 'Jjdoe' && rail.text === 'Jjdoe' && rail.gearRight >= 0 && rail.gearRight <= 10, JSON.stringify({ sub: open.sub, rail }));
  say(`firm-no-errors-${scheme}`, page.errors.length === 0, page.errors.join(' | '));
  await ctx.close(); }
{ const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 }, colorScheme: 'dark' }); const page = await ctx.newPage(); await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#u-menu'); await page.waitForSelector('#s-theme'); await page.waitForTimeout(400);
  const r = await page.evaluate(() => { const d = document.querySelector('.sdlg').getBoundingClientRect(); return { top: Math.round(d.top), bottom: Math.round(d.bottom), h: innerHeight }; });
  say('settings-fits-the-smallest-window', r.top >= 0 && r.bottom <= r.h, JSON.stringify(r));
  // each key cap with its title-case name beside it, in two columns of four rows; the full description is the
  // tooltip and what a screen reader reads
  const keys = await page.evaluate(() => [...document.querySelectorAll('.keylist dt')].map((dt) => {
    const name = dt.nextElementSibling;
    const box = dt.getBoundingClientRect();
    return {
      k: dt.textContent, h: Math.round(box.height), top: Math.round(box.top), keyTip: dt.title, tip: name.title,
      name: name.textContent, sr: name.getAttribute('aria-label') };
  }));
  const rows = new Set(keys.map((x) => x.top)).size;
  const named = keys.every((x) => x.h <= 24 && !x.keyTip && x.tip && x.tip === x.sr && x.name && x.name !== x.tip);
  say('settings-keys-are-named-in-two-columns', keys.length === 8 && rows === 4 && named
    && keys.some((x) => x.k === 'PgUp PgDn' && x.name === 'Previous or Next Page'), JSON.stringify(keys));
  await ctx.close(); }

// ---- the New deal form always asks for structure, sector and technology: typed while the firm has no lists for them
{ const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 }, colorScheme: 'light' }); const page = await ctx.newPage(); await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.waitForSelector('#nd-name');
  const f = await page.evaluate(() => ['nd-product', 'nd-sector', 'nd-technology'].map((id) => { const e = document.getElementById(id); return e ? `${e.tagName}:${e.getBoundingClientRect().width > 100}` : 'missing'; }).join(','));
  say('new-deal-asks-structure-sector-technology-without-lists', f === 'INPUT:true,INPUT:true,INPUT:true', f); await ctx.close(); }

// ---- two deals of one name: each row in the rail keeps its name in view, told apart by what differs (counterparty, else date), in full -------------
for (const scheme of ['dark', 'light']) { const { ctx, page } = await start(scheme);
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.evaluate(async () => { await store.dispatch(store.commandNamed('CreateDeal'), { name: 'Proseware', folders: [], counterparty: 'Tailwind Partners' }); });
  await page.waitForFunction(() => document.querySelectorAll('.rail a.dealrow .dtw').length === 2);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.rail a.dealrow')].filter((a) => a.querySelector('.dtw')).map((a) => ({ name: a.querySelector('.dn1').textContent, w: Math.round(a.querySelector('.dn1').getBoundingClientRect().width), full: a.querySelector('.dn1').scrollWidth <= a.querySelector('.dn1').clientWidth, twin: a.querySelector('.dtw').textContent, twinFull: a.querySelector('.dtw').scrollWidth <= a.querySelector('.dtw').clientWidth, title: a.title })));
  say(`same-name-rows-keep-the-name-${scheme}`, rows.length === 2 && rows.every((r) => r.name === 'Project Proseware' && r.full && r.w > 60 && r.title.startsWith('Project Proseware · ')) && rows.every((r) => r.twinFull) && rows.some((r) => r.twin === 'Tailwind Partners' && / · [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(r.title)), JSON.stringify(rows));
  await ctx.close(); }

// ---- faint text meets the 4.5:1 guideline against the page in both themes ---------------------------------------------
for (const scheme of ['light', 'dark']) { const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage();
  await page.goto(URL); await page.waitForSelector('#fr-new');
  const ratio = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const hex = (v) => { const h = v.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); }; const lum = (c) => { const f = (x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }; const a = lum(hex(cs.getPropertyValue('--ink-3'))), b = lum(hex(cs.getPropertyValue('--surface'))); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); });
  say(`${scheme}:faint-text-contrast`, ratio >= 4.5, ratio.toFixed(2));
  await ctx.close(); }

// ---- a removed folder's path and label are dimmed with the text colors and still meet 4.5:1 against what is drawn behind them ----------
for (const scheme of ['dark', 'light']) { const { ctx, page, id } = await start(scheme);
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#f-folders'); await page.click('#f-folders');
  await page.waitForSelector('#folders .fdrow .x');
  await page.click('#folders .fdrow .x'); await page.click('#ask-go');
  await page.waitForSelector('#folders .fdrow.gone'); await toastsGone(page);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  // the words' color, then what is drawn behind them, read from a screenshot with the words hidden
  const ratio = async (sel) => { const el = await page.$(sel); const b = await el.boundingBox();
    const ink = await el.evaluate((e) => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = getComputedStyle(e).color; const v = c.fillStyle; return v.startsWith('#') ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : v.match(/[\d.]+/g).slice(0, 3).map(Number); });
    await el.evaluate((e) => e.style.setProperty('color', 'transparent', 'important'));
    const png = await page.screenshot({ clip: { x: b.x, y: b.y, width: b.width, height: b.height } }); await el.evaluate((e) => e.style.removeProperty('color'));
    const bg = await page.evaluate(async (a) => { const im = new Image(); im.src = 'data:image/png;base64,' + a; await im.decode(); const c = new OffscreenCanvas(im.width, im.height); const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, im.width, im.height).data; const s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; } return s.map((v) => v / (d.length / 4)); }, png.toString('base64'));
    const [hi, lo] = [lum(ink), lum(bg)].sort((p, q) => q - p); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); };
  // the removed folder's path and its name
  const r = { path: await ratio('#folders .fdrow.gone .p'), label: await ratio('#folders .fdrow.gone .fdname') };
  say(`${scheme}:removed-folder-text-meets-4.5`, r.path >= 4.5 && r.label >= 4.5, JSON.stringify(r));
  await ctx.close(); }

await browser.close();
const bad = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
if (bad.length) process.exit(1);

/** Where the sent message and the answer sit in the conversation column, and the sent bubble's width beyond its
 *  text and padding (runs in the page). */
function messageSides() {
  const meEl = document.querySelector('.msgs .me');
  const me = meEl.getBoundingClientRect();
  const ai = document.querySelector('.msgs .ai').getBoundingClientRect();
  const col = document.querySelector('.msgs').getBoundingClientRect();
  const text = document.createRange();
  text.selectNodeContents(meEl);
  const css = getComputedStyle(meEl);
  const edges = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'];
  const inset = edges.reduce((sum, name) => sum + parseFloat(css[name]), 0);
  return {
    meRight: Math.round(col.right - me.right),
    meLeftGap: Math.round(me.left - col.left),
    meWidth: Math.round(me.width),
    col: Math.round(col.width),
    aiLeft: Math.round(ai.left - col.left),
    spare: Math.round(me.width - text.getBoundingClientRect().width - inset),
  };
}
