import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { longPdf } from './longpdf.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
async function fresh() { const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(URL); await page.waitForSelector('#fr-new'); return { ctx, page }; }
async function indexedDeal(page, name = 'Proseware') {
  await page.click('#fr-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForSelector('.flagrow', { timeout: 30000 });
  return page.evaluate(() => Object.values(store.get().deals)[0].id);
}

// 1 indexing → first pass → findings, gaps
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page);
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3);
  const info = await page.evaluate(() => ({ rows: document.querySelectorAll('.flagrow').length, brief: !!document.querySelector('.brieflet'), gaps: !!document.querySelector('.gaps'), docs: !!document.querySelector('.dcrow'), tab: document.querySelector('.dtabs a.on').textContent, tabs: [...document.querySelectorAll('.dtabs a')].map((a) => a.textContent).join('|'), full: document.querySelector('.flags').getBoundingClientRect().width / document.querySelector('.askslot').getBoundingClientRect().width }));
  say('first-pass-findings', info.rows === 3 && !info.brief && !info.gaps && !info.docs && info.tab === 'Findings3 open' && info.tabs === 'Overview|Findings3 open|Checklist|Q&A' && info.full > 0.99, JSON.stringify(info));
  await page.click('.dtabs a:has-text("Overview")'); await page.waitForSelector('.gaps li', { timeout: 5000 });
  const ov = await page.evaluate(() => ({ brief: !!document.querySelector('.brieflet'), gaps: document.querySelectorAll('.gaps li').length, tab: document.querySelector('.dtabs a.on').textContent, rows: document.querySelectorAll('.flagrow').length }));
  say('overview-has-the-gaps-and-no-summary', !ov.brief && ov.gaps === 2 && ov.tab === 'Overview' && ov.rows === 0, JSON.stringify(ov));
  // a finding opens from its tab
  await page.click('.dtabs a:has-text("Findings")'); await page.waitForSelector('.flagrow'); await page.click('.flagrow'); await page.waitForSelector('.opening');
  say('a-finding-opens', /^#finding-/.test(await page.evaluate(() => location.hash)) && !/\b[A-Z]-\d+\b/.test(await page.textContent('.fmeta')), await page.title());
  // reload on a finding keeps it
  await page.reload(); await page.waitForSelector('.opening');
  say('reload-keeps-finding', /^#finding-/.test(await page.evaluate(() => location.hash)));
  // the status button's arrow sits level with its word (it was 2.5px high)
  const chev = await page.evaluate(() => { const b = document.getElementById('f-status'); const r = document.createRange(); r.selectNodeContents(b.firstChild); const t = r.getBoundingClientRect(); const s = b.querySelector('.chev svg').getBoundingClientRect(); return +((s.top + s.height / 2) - (t.top + t.height / 2)).toFixed(1); });
  say('status-arrow-is-level-with-its-word', Math.abs(chev) <= 0.5, String(chev));
  // review
  await page.click('#f-review'); await page.waitForFunction(() => document.getElementById('f-review').getAttribute('aria-pressed') === 'true' && /reviewed by jdoe/.test(document.querySelector('.opening .fmeta').textContent));
  // close with note
  await page.click('#f-status'); await page.click('.stmenu .mi:has-text("Closed")'); await page.fill('#fnote-text', 'Confirmed with counsel'); await page.click('#fnote-save'); await page.waitForFunction(() => /Closed/.test(document.getElementById('f-status').textContent));
  const closed = await page.evaluate(() => ({ note: document.querySelector('.opening').textContent.includes('Confirmed with counsel'), toast: document.getElementById('toast')?.textContent }));
  say('review-and-close-with-note', closed.note && /closed/.test(closed.toast), JSON.stringify(closed));
  // undo restores open + no note
  await page.click('#toast .tundo'); await page.waitForFunction(() => /Open/.test(document.getElementById('f-status').textContent));
  say('undo-close', !(await page.evaluate(() => document.querySelector('.opening').textContent.includes('Confirmed with counsel'))));
  // close again, saved with Ctrl Enter from the note; the list shows the status filter and the closed row under Closed
  await page.click('#f-status'); await page.click('.stmenu .mi:has-text("Closed")'); await page.press('#fnote-text', 'Control+Enter'); await page.waitForFunction(() => /Closed/.test(document.getElementById('f-status').textContent), null, { timeout: 5000 }).catch(() => {});
  say('ctrl-enter-saves-the-closing-note', /Closed/.test(await page.textContent('#f-status')));
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('[data-fstatusf="closed"]');
  const openRows = await page.evaluate(() => document.querySelectorAll('.flagrow').length);
  await page.click('[data-fstatusf="closed"]'); const closedRows = await page.evaluate(() => ({ n: document.querySelectorAll('.flagrow').length, check: !!document.querySelector('.flagrow .rvd'), meta: document.querySelector('.flagrow .fm').textContent }));
  say('closed-filter', openRows === 2 && closedRows.n === 1 && closedRows.check, JSON.stringify({ openRows, closedRows }));
  say('a-closed-row-says-when-it-was-closed', / · Closed just now$/.test(closedRows.meta), closedRows.meta);   // it said when it was raised
  // delete from finding page → back on the list, undo restores
  await page.click('.flagrow'); await page.waitForSelector('.opening'); await page.click('#f-delete'); await page.click('#ask-go'); await page.waitForSelector('.flagsl');
  const afterDel = await page.evaluate(() => document.querySelectorAll('.flagrow').length);
  await page.click('#toast .tundo'); await page.waitForSelector('[data-fstatusf="all"]'); await page.click('[data-fstatusf="all"]'); await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3);
  say('delete-and-undo', afterDel === 2);
  // deleted finding URL after reload falls back safely
  const fid = await page.evaluate(() => Object.values(store.get().findings)[0].id);
  await page.evaluate(async (fid) => { const f = store.get().findings[fid]; await store.dispatch(store.commandNamed('DeleteFinding'), { dealId: f.dealId, findingId: fid }); }, fid);
  await page.goto(URL + `#finding-${id}-${fid}`); await page.reload(); await page.waitForSelector('.chathead'); await page.waitForFunction(() => /was deleted/.test(document.querySelector('.chat')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const goneText = await page.textContent('#gone');
  say('deleted-finding-url-safe', /^That finding was deleted\. Restore it or go back to /.test(goneText) && page.errors.length === 0, JSON.stringify({ goneText, errors: page.errors }));
  // the page that says it was deleted can put it back, and then shows it; the trail ends at Findings (findings have no code)
  await page.click('#gone-restore'); await page.waitForSelector('.opening');
  const back = await page.evaluate((fid) => ({ there: !!store.get().findings[fid], trail: document.querySelector('.chathead .back').textContent, here: document.querySelector('.chathead .back .here')?.textContent }), fid);
  say('a-deleted-finding-can-be-restored-from-its-own-page', back.there && back.here === undefined && back.trail.endsWith('Findings'), JSON.stringify(back));
  await ctx.close(); }

// #763: the deleted page names an unsaved edit and Restore it opens that same edit.
async function checkDeletedEdit(page, dealId, title, remove, reload = false) {
  await page.goto(URL + '#deal-' + dealId);
  await page.click('#f-new');
  await page.fill('#af-title', title);
  await page.selectOption('#af-ws', 'Legal');
  await page.fill('#af-body', 'The signed agreement requires a third-party consent.');
  await page.click('#af-create');
  await page.locator('.flagrow', { hasText: title }).click();
  const findingUrl = page.url();
  const findingId = await page.evaluate((wording) =>
    Object.values(store.get().findings).find((finding) => finding.title === wording).id, title);
  const editedTitle = 'Assignment consent needs a notice period';
  const editedDetail = 'The revised consent adds a 30-day notice period before assignment.';
  await page.click('#f-edit');
  await page.fill('#fe-title', editedTitle);
  await page.fill('#fe-body', editedDetail);
  await remove(findingId);
  await page.waitForFunction((id) => !store.get().findings[id] && store.get().tombstones[id], findingId);
  const stayed = page.url() === findingUrl;
  if (!stayed) await page.goto(findingUrl);
  await page.waitForSelector('#gone-restore');
  const kept = page.getByRole('status').filter({ hasText: 'Unsaved finding edit kept.' });
  const named = await kept.isVisible();
  if (reload) {
    await page.reload();
    await page.waitForSelector('#gone-restore');
  }
  const stillNamed = await kept.isVisible();
  await page.click('#gone-restore');
  await page.waitForSelector('#fe-body');
  const restored = await page.inputValue('#fe-title') === editedTitle
    && await page.textContent('#fe-body') === editedDetail;
  say(`deleted-edit-kept-${title}`, stayed && named && stillNamed && restored && !page.errors.length,
    JSON.stringify({ stayed, named, stillNamed, restored, errors: page.errors }));
}

{
  const { ctx, page } = await fresh();
  const dealId = await indexedDeal(page);
  await checkDeletedEdit(page, dealId, 'Assignment agreement needs consent', async () => {
    await page.click('#f-delete');
    await page.click('#ask-go');
  });
  await checkDeletedEdit(page, dealId, 'Sublease requires a notice', async () => {
    await page.click('#toast .tundo');
  });
  await checkDeletedEdit(page, dealId, 'Amendment lacks a signature', async (findingId) => {
    await page.evaluate((id) => __peer.remove(id), findingId);
    await page.click('#conflict .cfl-v:has-text("Deleted")');
    await page.click('#conflict .cfl-keep:has-text("Keep It Deleted")');
  }, true);
  await ctx.close();
}

// 2 person-raised finding (red while open, like any other), linked response → Reassess → previous assessment kept
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page, 'Trey');
  await page.click('#f-new'); await page.fill('#af-title', 'Step-in period is short'); await page.selectOption('#af-ws', 'Legal'); await page.fill('#af-body', 'The direct agreement gives 20 days.'); await page.click('#af-create');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 4);
  const raised = await page.evaluate(() => { const r = [...document.querySelectorAll('.flagrow')].find((x) => /Step-in/.test(x.textContent)); return r.querySelector('.stripe').classList.contains('High') && !r.classList.contains('raised'); });
  const fid = await page.evaluate(() => Object.values(store.get().findings).find((f) => /Step-in/.test(f.title)).id);
  await page.evaluate(async ([id, fid]) => { await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: id, text: 'Please confirm the step-in period.', linkedFinding: fid }); const q = Object.values(store.get().questions)[0]; await store.dispatch(store.commandNamed('SetResponse'), { dealId: id, questionId: q.id, response: 'It is 20 business days.' }); }, [id, fid]);
  await page.waitForSelector('.flagrow .upd');
  await page.goto(URL + `#finding-${id}-${fid}`); await page.waitForSelector('#f-reassess');
  // the finding's history loads after the page opens, and the line under the title names its latest event from it
  await page.waitForFunction(() => /Response received/.test(document.querySelector('.fmeta')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const meta = await page.textContent('.fmeta');
  await page.click('#f-reassess'); await page.waitForSelector('.opening .ai.pending'); await page.waitForSelector('details.prev', { timeout: 6000 });
  const after = await page.evaluate(() => ({ body: document.querySelector('.opening .dtxt').textContent, prev: document.querySelector('details.prev').textContent, btn: !!document.getElementById('f-reassess') }));
  say('raised-reassess', raised && /Raised by jdoe/.test(meta) && /Response received on Q1/.test(meta) && after.body === 'Reassessed.' && /20 days/.test(after.prev) && !after.btn, JSON.stringify({ raised, meta, after }));
  say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// 3 the findings heading is one row that gives up only what it must; checking everything again marks findings for a person and changes nothing else
for (const scheme of ['light', 'dark']) { const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(URL); await page.waitForSelector('#fr-new');
  const id = await indexedDeal(page); await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3);
  const over = async () => { await page.click('.dtabs a:has-text("Overview")'); await page.waitForSelector('#ov-standing'); }; const finds = async () => { await page.click('.dtabs a:has-text("Findings")'); await page.waitForSelector('.fhead'); };
  const head = () => page.evaluate(() => { const h = document.querySelector('.fhead'); const r = h.getBoundingClientRect(); const kids = [...h.children].filter((k) => k.getBoundingClientRect().width > 0);
    return { mode: +h.dataset.fhead, oneRow: r.height <= 30 && kids.every((k) => Math.abs((k.getBoundingClientRect().top + k.getBoundingClientRect().bottom) / 2 - (r.top + r.bottom) / 2) < 6), inside: kids.every((k) => k.getBoundingClientRect().right <= r.right + 1 && k.getBoundingClientRect().left >= r.left - 1), seg: [...h.querySelectorAll('.seg button')].map((b) => b.textContent).join('|'), funnel: !!h.querySelector('#f-filter'), funnelOn: !!h.querySelector('#f-filter.on'),
      acts: [...h.querySelectorAll('.btn.act')].map((b) => b.textContent.trim() || `(${b.getAttribute('aria-label')})`).join('|'), named: [...h.querySelectorAll('.btn')].every((b) => (b.textContent.trim() || b.getAttribute('aria-label') || '').length > 0), noScroll: document.documentElement.scrollWidth <= innerWidth }; });
  const settle = async () => { await page.mouse.move(1200, 700); await page.waitForTimeout(250); return head(); };
  // nothing to filter: no filter is shown, and the buttons keep their words
  const fresh0 = await settle();
  say(`findings-head-in-words-when-it-fits-${scheme}`, fresh0.mode === 0 && fresh0.oneRow && fresh0.inside
    && !fresh0.seg && !fresh0.funnel && fresh0.acts === 'New Finding', JSON.stringify(fresh0));
  // nothing is due: no line on Overview; the deal's ⋯ menu says when it was last checked
  await over();
  await page.click('#deal-more');
  await page.waitForFunction(() => document.getElementById('deal-check')?.textContent.includes('Last checked'));
  const chk0 = await page.evaluate(() => ({
    line: !!document.getElementById('ov-check'),
    item: document.getElementById('deal-check').textContent,
  }));
  say(`last-checked-says-what-it-means-${scheme}`, !chk0.line
    && /^Check AgainLast checked [A-Z][a-z]{2} \d{1,2}$/.test(chk0.item), JSON.stringify(chk0));
  // check everything: two findings come back marked, with the reason, at the top; nothing else about them changes
  const before = await page.evaluate((i) => Object.values(store.get().findings).filter((f) => f.dealId === i).map((f) => [f.id, f.title, f.body.join('|'), f.status, f.reviewed].join('~')).sort().join('\n'), id);
  await page.evaluate(() => { window.__check = { mark: 2, spot: { size: 5, overturned: 2 } }; });
  await page.click('#deal-check'); await page.waitForSelector('#ov-check button[aria-disabled="true"]'); const busy = await page.evaluate(() => document.querySelector('#ov-check button').textContent);
  await page.waitForSelector('#f-check-deep'); const seen = await page.evaluate(() => ({ toast: document.getElementById('toast')?.textContent ?? '', offer: document.getElementById('ov-check').textContent }));
  await finds(); await page.waitForFunction(() => document.querySelectorAll('.flagrow .upd').length === 2);
  const after = await page.evaluate((i) => ({ same: Object.values(store.get().findings).filter((f) => f.dealId === i).map((f) => [f.id, f.title, f.body.join('|'), f.status, f.reviewed].join('~')).sort().join('\n'), rows: [...document.querySelectorAll('.flagrow')].map((r) => [!!r.querySelector('.upd'), r.querySelector('.fm').textContent]), tab: document.querySelector('.dtabs a.on').textContent }), id); Object.assign(after, seen);
  say(`check-everything-marks-and-changes-nothing-else-${scheme}`, busy === 'Checking' && after.same === before && after.rows.filter((r) => r[0]).length === 2 && after.rows.filter((r) => r[0]).every((r) => / · May be out of date · Found by the check on [A-Z][a-z]{2} \d{1,2}$/.test(r[1])) && /Checklist and findings checked: 2 to update/.test(after.toast) && /3 open/.test(after.tab), JSON.stringify({ busy, after }));
  say(`spot-check-offer-${scheme}`,
    /^[A-Z][a-z]{2} \d{1,2} spot check disagreed with 2 of its 5 resultsCheck Again in Depth$/.test(after.offer.trim()),
    after.offer);
  // now there is something to filter: the status filter joins the row. The list has the full width of the page, so the buttons keep their words
  const marked = await settle();
  say(`findings-head-keeps-its-words-beside-the-filter-${scheme}`, marked.mode === 0 && marked.oneRow && marked.inside
    && marked.seg === 'Open 3|To update 2|All' && !marked.funnel && marked.acts === 'New Finding' && marked.named
    && marked.noScroll, JSON.stringify(marked));
  // in a window narrower than the app is designed for, New finding and ⋯ still fit in words
  await page.setViewportSize({ width: 720, height: 640 }); await page.waitForTimeout(400); const tight = await settle(); await page.setViewportSize({ width: 1280, height: 736 }); await page.waitForTimeout(400);
  const tightOk = tight.mode === 0 && tight.oneRow && tight.inside && tight.seg === 'Open 3|To update 2|All'
    && !tight.funnel && tight.acts === 'New Finding' && tight.named && tight.noScroll;
  say(`findings-head-keeps-its-words-in-a-narrow-window-${scheme}`, tightOk, JSON.stringify(tight));
  await page.click('[data-fstatusf="reassess"]'); const only = await page.evaluate(() => [...document.querySelectorAll('.flagrow')].map((r) => !!r.querySelector('.upd')));
  say(`to-reassess-filter-${scheme}`, only.length === 2 && only.every(Boolean), JSON.stringify(only)); await page.click('[data-fstatusf="open"]');
  // a reassessment clears the mark and its reason
  await page.click('.flagrow:has(.upd)'); await page.waitForSelector('#f-reassess');   // a marked one: the list is grouped by workstream, so it need not be first
  // the finding's controls keep their place and width whatever its state; the mark, its reason and its action are one line of their own
  const ctl = () => page.evaluate(() => ['#f-review', '#f-status', '#f-edit', '#f-delete'].map((x) => { const r = document.querySelector(x).getBoundingClientRect(); return `${Math.round(r.left)}:${Math.round(r.width)}`; }).join());
  await page.waitForTimeout(700);                       // the queue strip has finished folding the sidebar away
  const c0 = await ctl(); const note0 = await page.evaluate(() => ({ text: document.getElementById('f-outdated').textContent, inRow: !!document.querySelector('.fctl #f-reassess'), label: document.getElementById('f-review').textContent.trim(), pressed: document.getElementById('f-review').getAttribute('aria-pressed') }));
  await page.click('#f-review'); await page.waitForFunction(() => document.getElementById('f-review').getAttribute('aria-pressed') === 'true'); const c1 = await ctl(); const label1 = await page.evaluate(() => document.getElementById('f-review').textContent.trim());
  await page.click('#f-reassess'); await page.waitForFunction(() => !document.getElementById('f-reassess')); await page.waitForSelector('details.prev');
  const c2 = await ctl(); const rv = await page.evaluate(() => ({ pressed: document.getElementById('f-review').getAttribute('aria-pressed'), toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'), prev: document.querySelector('details.prev summary').textContent, meta: document.querySelector('.opening .fmeta > span').textContent }));
  say(`finding-controls-keep-their-place-${scheme}`, c0 === c1 && c1 === c2
    && /^May be out of date · Found by the check on [A-Z][a-z]{2} \d{1,2}Update from Documents$/.test(note0.text)
    && !note0.inRow && note0.label === 'Reviewed' && note0.pressed === 'false' && label1 === 'Reviewed',
    JSON.stringify({ c0, c1, c2, note0, label1 }));
  say(`an-update-that-replaces-the-words-clears-the-review-${scheme}`, rv.pressed === 'false' && /updated · review cleared/.test(rv.toast) && /^Previous version · [A-Z][a-z]{2} \d{1,2} · reviewed by jdoe$/.test(rv.prev) && !/reviewed by/.test(rv.meta), JSON.stringify(rv));
  const cleared = await page.evaluate(() => { const f = Object.values(store.get().findings).find((x) => location.hash.endsWith(x.id)); return [f.updated, f.updatedWhy]; }); say(`reassess-clears-the-mark-${scheme}`, cleared[0] === false && cleared[1] === '', JSON.stringify(cleared));
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#f-check-deep');
  // the offer: the standard model on everything; then the offer is gone
  await page.evaluate(() => { window.__check = {}; }); await page.click('#f-check-deep'); await page.waitForFunction(() => /^Checking the checklist and findings in depth$/.test(document.querySelector('#ov-check .when')?.textContent ?? '')); await page.waitForFunction(() => !document.getElementById('ov-check'));
  say(`deep-check-withdraws-the-offer-${scheme}`, !(await page.$('#f-check-deep')) && !(await page.$('#ov-check')));
  await finds();
  // with a closed finding too there are four statuses to choose from (one not marked is closed, wherever its workstream puts it)
  await page.click('.flagrow:not(:has(.upd)) >> nth=0'); await page.waitForSelector('.opening'); await page.click('#f-status'); await page.click('.stmenu .mi:has-text("Closed")'); await page.click('#fnote-save'); await page.waitForFunction(() => /Closed/.test(document.getElementById('f-status').textContent));
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.fhead'); const wide = await settle();
  await page.setViewportSize({ width: 1024, height: 640 }); await page.waitForTimeout(400); const floor = await settle();
  say(`findings-head-fits-in-words-at-the-smallest-window-${scheme}`, wide.mode === 0
    && wide.seg === 'Open 2|To update 1|Closed 1|All' && floor.mode === 0 && floor.oneRow && floor.inside
    && floor.seg === wide.seg && floor.acts === 'New Finding' && floor.noScroll, JSON.stringify({ wide, floor }));
  // narrower than the app is designed for: four statuses no longer fit, so the filter folds into its symbol; with Import beside
  // at 640 the status filter folds into the filter menu, and New finding keeps its words
  await page.setViewportSize({ width: 640, height: 640 }); await page.waitForTimeout(400); const narrow = await settle();
  const narrowOk = narrow.mode === 2 && narrow.oneRow && narrow.inside && !narrow.seg && narrow.funnel
    && !narrow.funnelOn && narrow.acts === 'New Finding' && narrow.noScroll;
  say(`findings-head-filter-folds-at-640-${scheme}`, narrowOk, JSON.stringify({ narrow }));
  // the folded filter: opens on the current choice, works from the keyboard, says when it is on, and closes on Escape with focus back on it
  await page.focus('#f-filter'); await page.keyboard.press('Enter'); await page.waitForSelector('.fmenu'); const opened = await page.evaluate(() => ({ items: [...document.querySelectorAll('.fmenu .mi')].map((b) => b.textContent).join('|'), focus: document.activeElement.textContent, inView: document.querySelector('.fmenu').getBoundingClientRect().bottom <= innerHeight && document.querySelector('.fmenu').getBoundingClientRect().right <= innerWidth }));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForSelector('.fmenu', { state: 'detached' });
  const closedOnly = await page.evaluate(() => ({ rows: document.querySelectorAll('.flagrow').length, status: store.get().ui.findingFilter.status, on: !!document.querySelector('#f-filter.on'), label: document.getElementById('f-filter').getAttribute('aria-label') }));
  await page.click('#f-filter'); await page.waitForSelector('.fmenu'); await page.keyboard.press('Escape'); await page.waitForSelector('.fmenu', { state: 'detached' }); const back = await page.evaluate(() => document.activeElement.id);
  say(`folded-filter-menu-${scheme}`, opened.items === 'Open 2|To update 1|Closed 1|All' && opened.focus === 'Open 2' && opened.inView && closedOnly.rows === 1 && closedOnly.status === 'closed' && closedOnly.on && closedOnly.label === 'Filter (on)' && back === 'f-filter', JSON.stringify({ opened, closedOnly, back }));
  // back to a wide window: the row takes its words and its filter back
  await page.evaluate(() => store.ui({ findingFilter: { status: 'open', workstream: '', text: '', reviewed: '' } })); await page.setViewportSize({ width: 1280, height: 736 }); await page.waitForTimeout(400); const again = await settle();
  say(`findings-head-recovers-when-there-is-room-${scheme}`, again.mode === 0 && again.acts === 'New Finding'
    && again.seg === 'Open 2|To update 1|Closed 1|All' && again.oneRow, JSON.stringify(again));
  say(`no-page-errors-check-${scheme}`, page.errors.length === 0, JSON.stringify(page.errors));
  // a check held back only by a folder no PC could open says so in one line, whatever the name: the name gives way, the rest shows
  for (const [w, h] of [[1280, 736], [1024, 640]]) for (const name of ['04 MATERIAL CONTRACTS AND AGREEMENTS', '法律文件与重大合同协议及附件资料汇编保密版本', '03 Legal']) {
    await page.setViewportSize({ width: w, height: h }); await page.evaluate((n) => { window.__check = { unread: [n] }; }, name);
    await page.evaluate((i) => store.checkEverything(i), id); await page.waitForFunction((n) => document.querySelector('#toast .tsplit .sr-only')?.textContent === n, name);
    // the notice's words (notice.tsx): the bold title, then the detail, whose name gives way;
    // " · " is heard, not shown
    const n = await page.evaluate(() => {
      const t = document.querySelector('#toast .ttext');
      const r = t.getBoundingClientRect();
      const a = t.querySelector('.ttitle');
      const c = t.querySelector('.tsplit .tcut');
      const b = t.querySelector('.tsplit').lastElementChild;
      const k = [a, c, b].map((x) => x.getBoundingClientRect());
      const whole = k[0].left >= r.left - 0.5 && k[2].right <= r.right + 0.5 && k[2].width > 100;
      const tight = Math.abs(k[2].left - k[1].right) < 0.5 && c.scrollWidth <= c.clientWidth + 1;
      const seen = `${a.textContent} · ${c.textContent}${b.textContent}`;
      // one line of the notice's 24px line height
      const heard = t.textContent.replace(c.textContent, '');
      return { seen, cut: c.textContent, heard, oneLine: r.height < 25, whole, tight, title: t.title };
    });
    // shortened, it is a start of the name, ending in "…" right against " could not be opened"
    const fair = n.cut === name || (n.cut.endsWith('…') && n.cut.length > 1 && name.startsWith(n.cut.slice(0, -1)) && !/\s…$/.test(n.cut));
    say(`not-complete-notice-one-line-${w}-${name.slice(0, 8)}-${scheme}`, fair && n.seen === `Not complete · ${n.cut} could not be opened` && n.heard === `Not complete · ${name} could not be opened` && n.oneLine && n.whole && n.tight && n.title.startsWith(`Not complete: the folder ${name} could not be opened.`), JSON.stringify(n));
  }
  await page.setViewportSize({ width: 1280, height: 736 });
  await page.evaluate(() => { delete window.__check; }); await ctx.close(); }

// the closing note opens under the title and a closed finding has no next step; the stripe says what it
// means on hover; a finding deleted from the Checklist goes back to the Checklist
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page); await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3);
  const tip = await page.evaluate(() => document.querySelector('.flagrow .stripe').getAttribute('title'));
  await page.click('.flagrow'); await page.waitForSelector('.opening .qtxt'); const y0 = await page.evaluate(() => document.querySelector('.opening .qtxt').getBoundingClientRect().top);
  await page.click('#f-status'); await page.click('.stmenu .mi:has-text("Closed")'); await page.waitForSelector('#fnote-text');
  const y1 = await page.evaluate(() => ({ title: document.querySelector('.opening .qtxt').getBoundingClientRect().top, below: document.querySelector('.opening .qtxt').compareDocumentPosition(document.querySelector('.fnote')) & Node.DOCUMENT_POSITION_FOLLOWING }));
  await page.click('#fnote-save'); await page.waitForFunction(() => /Closed/.test(document.getElementById('f-status').textContent));
  const next = await
    page.evaluate(() => document.querySelector('.opening').textContent.includes('Suggested Next Step'));
  say('close note under the title, no next step once closed, stripe explained', tip === 'Open' && y1.title <= y0 + 1 && !!y1.below && !next, JSON.stringify({ tip, y0, y1, next }));
  await page.goto(URL + '#checklist-' + id); await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.click('#ck-open-finding'); await page.waitForSelector('#f-delete');
  await page.click('#f-delete'); await page.click('#ask-go'); await page.waitForFunction(() => location.hash.startsWith('#checklist-'), null, { timeout: 5000 }).catch(() => {});
  const back = await page.evaluate(() => location.hash.replace(/-d_.*/, ''));
  say('a finding deleted after opening it from the Checklist goes back there', back === '#checklist' && page.errors.length === 0, JSON.stringify({ back, errors: page.errors }));
  await ctx.close(); }

// #564: the detail overflows within the notice text at the smaller viewport.
{
  const { ctx, page } = await fresh();
  await page.setViewportSize({ width: 1024, height: 640 });
  const text = 'Finding updated · ' + 'W'.repeat(85);
  await page.evaluate((text) => store.toast(text, undefined, true), text);
  const noticeText = page.locator('#toast .ttext');
  await noticeText.hover();
  const title = await noticeText.getAttribute('title');
  say('truncated-notice-shows-full-text', title === text, JSON.stringify({ title, expected: text }));
  await page.mouse.move(5, 400);
  await page.evaluate(() => store.toast('Finding updated · Atlas', undefined, true));
  await page.waitForFunction(() => document.querySelector('#toast .tbody')?.textContent === 'Atlas');
  await noticeText.hover();
  const shortTitle = await noticeText.getAttribute('title');
  say('fitting-notice-has-no-redundant-tooltip', !shortTitle, JSON.stringify({ title: shortTitle }));
  await page.evaluate(() => store.toast('Finding updated · Not renewed', undefined, true));
  await page.waitForFunction(() => document.querySelector('#toast .tbody')?.textContent === 'Not renewed');
  const icon = await page.locator('#toast .tg path').getAttribute('d');
  say('notice-detail-does-not-turn-a-completed-write-into-a-warning-1369', icon === 'm5 12 5 5L20 7', icon);
  await ctx.close();
}

{
  const { ctx, page } = await fresh();
  const name = 'Project Full Circle';
  await page.click('#fr-new');
  await page.fill('#nd-name', name);
  await page.click('#nd-create');
  const notice = page.locator('#toast .tg path').first();
  const noticeText = (message) => page.waitForFunction((text) =>
    document.querySelector('#toast .ttext')?.textContent === text, message);
  await noticeText(`${name} created`);
  const created = await notice.getAttribute('d');
  await page.evaluate((name) => {
    const deal = Object.values(store.get().deals).find((candidate) => candidate.name === name);
    store.ui({ deleteDeal: { dealId: deal.id, typed: '', error: '' } });
  }, name);
  await page.fill('#dd-name', name);
  await page.click('#dd-next');
  await page.click('#dd-go');
  await noticeText(`${name} deleted`);
  const deleted = await notice.getAttribute('d');
  say('deal-name-does-not-change-the-create-or-delete-notice-glyph-1369',
    created === 'm5 12 5 5L20 7' && deleted === created, JSON.stringify({ created, deleted }));
  await ctx.close();
}

async function findingEditLayout(page) {
  return page.evaluate(() => {
    const composer = document.querySelector('#pcomposer').getBoundingClientRect();
    const chat = document.querySelector('.chat');
    const thread = chat.getBoundingClientRect();
    const header = chat.querySelector('.chathead');
    const top = getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().bottom : thread.top;
    const bottom = Math.min(thread.bottom, composer.top);
    const control = (id) => {
      const element = document.getElementById(id);
      const bounds = element.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      const inView = bounds.top >= top && bounds.bottom <= bottom;
      const hit = inView && [bounds.top + 2, y, bounds.bottom - 2].every((point) =>
        element.contains(document.elementFromPoint(x, point)));
      return { hit, x, y };
    };
    return { save: control('fe-save'), cancel: control('fe-cancel'), title: control('fe-title'),
      focus: document.activeElement.id };
  });
}

async function openFindingEditor(page) {
  await page.locator('#f-edit').scrollIntoViewIfNeeded();
  await page.press('#f-edit', 'Enter');
  await page.waitForSelector('#fe-title');
  await page.waitForTimeout(500);
  return findingEditLayout(page);
}

async function checkFindingEditLayouts(page, scenario) {
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, colorScheme);
    for (const [width, height] of [[1280, 736], [1024, 640]]) {
      await page.setViewportSize({ width, height });
      const layout = await openFindingEditor(page);
      say(`finding-edit-${scenario}-${width}-${colorScheme}`,
        layout.save.hit && layout.cancel.hit && layout.title.hit && layout.focus === 'fe-title',
        JSON.stringify(layout));
      await page.press('#fe-title', 'Escape');
      await page.waitForSelector('#fe-title', { state: 'detached' });
    }
  }
}

async function scrollAwayAndBack(page) {
  const chat = page.locator('.chat');
  const start = await chat.evaluate((thread) => thread.scrollTop);
  await chat.evaluate((thread) => { thread.scrollTop = thread.scrollHeight; });
  await page.waitForFunction((start) => {
    const thread = document.querySelector('.chat');
    const title = document.getElementById('fe-title');
    return thread.scrollTop > start && title.getBoundingClientRect().bottom <= thread.getBoundingClientRect().top;
  }, start);
  await chat.evaluate((thread, start) => { thread.scrollTop = start; }, start);
  await page.waitForFunction((start) => document.querySelector('.chat').scrollTop === start, start);
}

async function checkCrowdedFindingEdit(page, followup) {
  const names = [
    'Executed master services agreement and latest schedule of open orders.pdf',
    'First amendment to agreement for the supply and distribution of equipment.pdf',
    'Schedule of service levels and notices that will survive closing.pdf',
    'Side letter concerning the consent rights of lenders and their successors.pdf',
    'Executed written consent covering the transfer of the operating assets.pdf',
    'Supply agreement assignment and transition services obligations.pdf',
    'Consolidated purchase orders with pricing and assignment requirements.pdf',
    'Regulatory and tax approvals required for the asset transfer.pdf',
  ];
  await page.setInputFiles('#pcomposer input[type=file]', names.map((name, index) => ({
    name, mimeType: 'application/pdf', buffer: longPdf(index + 1),
  })));
  const files = page.locator('#pcomposer .chip.att:not(.pending)');
  await page.waitForFunction(() => document.querySelectorAll('#pcomposer .chip.att:not(.pending)').length === 8);
  await page.evaluate(() => store.ui({ toasts: [] }));
  const layout = await openFindingEditor(page);
  const detailFits = await page.locator('#fe-body').evaluate((box) => {
    const style = getComputedStyle(box);
    const textHeight = box.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return textHeight >= parseFloat(style.lineHeight);
  });
  say('finding-edit-keeps-focus-and-actions-visible-with-eight-unsent-files',
    layout.title.hit && layout.save.hit && layout.cancel.hit && layout.focus === 'fe-title' && detailFits,
    JSON.stringify(layout));
  if (layout.cancel.hit) await page.mouse.click(layout.cancel.x, layout.cancel.y);
  else await page.press('#fe-title', 'Escape');
  await page.waitForSelector('#fe-title', { state: 'detached' });
  const kept = await files.locator('button[aria-label^="Remove"]').evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('aria-label')));
  say('closing-finding-edit-keeps-followup-and-attachments', (await page.inputValue('#pask')) === followup
    && names.every((name) => kept.includes(`Remove ${name}`)));
  for (const remove of (await files.locator('button[aria-label^="Remove"]').all()).reverse()) await remove.click();
}

{ // #597: a long finding should open for editing with its actions clear of the conversation composer.
  const { ctx, page } = await fresh();
  const dealId = await indexedDeal(page, 'Asset transfer');
  const title = 'Consent required before assigning the supply agreement';
  const body = [
    'The supply agreement requires written consent before the operating assets can be assigned to another owner.',
    'The consent request must identify the proposed assignee and explain how service will continue after closing.',
    'The latest amendment does not remove that requirement. The notice period begins on receipt of the request.',
    'The draft assignment does not yet identify which purchase orders will transfer with the agreement.',
    'The parties have not settled which of them is responsible for obtaining consent before the effective date.',
    'Any accepted orders should be reconciled before the parties send the transfer notice to their suppliers.',
    'The assignment package should include the entire signed agreement and the latest schedule of open orders.',
    'The available filing shows a consent in principle, subject to a further review of the proposed assignee.',
  ];
  const findingId = await page.evaluate(async ({ dealId, title, body }) => {
    const finding = Object.values(store.get().findings).find((finding) => finding.sources.length);
    await store.dispatch(store.commandNamed('EditFinding'), {
      dealId, findingId: finding.id, title, workstream: finding.workstream, body,
    });
    return finding.id;
  }, { dealId, title, body });
  await page.goto(URL + `#finding-${dealId}-${findingId}`);
  await checkFindingEditLayouts(page, 'without-messages');
  await openFindingEditor(page);
  const revised = 'Written consent required before assignment';
  await page.fill('#fe-title', revised);
  for (const id of ['fe-ws', 'fe-body', 'fe-save', 'fe-cancel']) {
    await page.keyboard.press('Tab');
    await page.waitForFunction((id) => document.activeElement.id === id, id);
  }
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await page.waitForFunction((title) => document.querySelector('.opening h1, .opening .qtxt')?.textContent === title,
    revised);
  await page.fill('#pask', 'Which contracts need written consent before assignment?');
  await page.press('#pask', 'Enter');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed)');
  await checkFindingEditLayouts(page, 'with-conversation');
  await openFindingEditor(page);
  const draft = 'Confirm which purchase orders are included';
  await page.fill('#fe-title', draft);
  await scrollAwayAndBack(page);
  const kept = await page.inputValue('#fe-title');
  const { cancel } = await findingEditLayout(page);
  if (cancel.hit) await page.mouse.click(cancel.x, cancel.y);
  const titleAfterCancel = await page.evaluate((id) => store.get().findings[id].title, findingId);
  say('finding-edit-draft-survives-scrolling-and-cancel-stays-reachable',
    kept === draft && titleAfterCancel === revised && !(await page.$('#fe-title')) && !page.errors.length);
  if (!cancel.hit) await page.press('#fe-title', 'Escape');
  const followup = [
    'Identify the contracts that restrict assignment.',
    'Confirm whether amendments changed the consent terms.',
    'Check which orders remain open.',
    'Summarize the notice requirements.',
    'Compare the draft assignment with the latest order schedule.',
    'List any documents that are still missing.',
    'Keep the supporting citations with each point.',
  ].join('\n');
  await page.fill('#pask', followup);
  await page.waitForFunction(() => document.querySelector('#pask').getBoundingClientRect().height > 120);
  await checkFindingEditLayouts(page, 'above-expanded-composer');
  await checkCrowdedFindingEdit(page, followup);
  await page.locator('.opening .rsch-chip').first().click();
  await page.waitForSelector('.docpanel');
  await page.setInputFiles('#pcomposer input[type=file]', {
    name: 'Assignment schedule.pdf', mimeType: 'application/pdf', buffer: longPdf(1),
  });
  await page.waitForSelector('#pcomposer .chip.att:not(.pending)');
  const reading = await openFindingEditor(page);
  say('finding-edit-keeps-focus-and-actions-clear-of-the-reading-breadcrumb',
    reading.title.hit && reading.save.hit && reading.cancel.hit && reading.focus === 'fe-title',
    JSON.stringify(reading));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
