// Import an issues list into Findings, at deal scale: 126 findings on the deal and a 164-point list, 23 points
// repeating a finding and 4 an earlier point. Only those 27 are listed; the rest become findings, and every finding a
// point is on says "#N on issues list". A list the stand-in reads from a text file is checked end to end too.
import { launchChrome } from './chrome.mjs';
import { checkRemovalApproval } from './issueslistRemoval.mjs';
import { checkPastedList } from './issueslistPaste.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
const LIST = 'Credit Agreement Issues List – Sponsor counsel (Nov 14).pdf';

/**
 * The text of the tooltip that `show` brings up over finding `findingId`'s `.ilh` mark, once its page has arrived: the
 * route is that finding, focus has moved off the old page, and two frames have been drawn since. A tooltip that does
 * not come fails its check, with what the page looked like, rather than ending the suite with no result (#142).
 */
async function tipAfter(page, findingId, show) {
  const arrived = (id) => store.get().ui.route.findingId === id && !!document.querySelector('.ilh')
    && !!document.activeElement && document.activeElement !== document.body;
  const here = await page.waitForFunction(arrived, findingId, { timeout: 10000 }).catch(() => null);
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  await page.evaluate(() => {
    const mark = document.querySelector('.ilh');
    if (mark) mark.dataset.asked = '1';
  });
  await show().catch(() => undefined);
  const tip = here && await page.waitForSelector('.tip', { timeout: 10000 }).catch(() => null);
  if (tip) return tip.innerText();
  const seen = await page.evaluate(() => ({
    sameMark: document.querySelector('.ilh')?.dataset.asked === '1',
    focus: document.activeElement?.id,
    route: store.get().ui.route,
  }));
  console.log('no tooltip:', JSON.stringify({ arrived: !!here, ...seen }));
  return '';
}

async function listStatus(page) {
  return page.evaluate(() => {
    const { findings, tombstones } = store.get();
    return [
      Object.keys(findings).length,
      Object.values(findings).filter((finding) => finding.onLists?.length).length,
      Object.keys(tombstones).length,
    ].join('/');
  });
}

for (const [w, h, scheme] of [[1280, 736, 'dark'], [1024, 640, 'light']]) {
  // clipboard access lets a paste be a real Ctrl+V
  const permissions = ['clipboard-read', 'clipboard-write'];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, permissions });
  const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-create'); await page.waitForSelector('.dtabs');
  const dealId = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  const ids = await page.evaluate(async (d) => {
    const out = [];
    for (let k = 0; k < 126; k++) { const r = await store.dispatch(store.commandNamed('CreateFinding'), { dealId: d, title: k === 0 ? 'Change of control definition omits the sponsor fund vehicles' : `Finding ${k} on the credit agreement`, workstream: 'Legal', body: k === 0 ? [] : [`What finding ${k} says.`] }, { quiet: true }); out.push(store.get().ops[r.value.opId].targets.find((t) => t.startsWith('f_')) ?? Object.keys(store.get().findings).at(-1)); }
    store.ui({ toasts: [] }); return out;
  }, dealId);
  await page.goto(`${URL}#deal-${dealId}`); await page.waitForSelector('.flagrow');
  // New finding is the one button; the ⋯ menu holds Import…, Export… and, apart from them, Deleted…
  //
  await page.click('#f-more');
  const heads = await page.$$eval('.fhead .btn.act, .fhead .fmore .mi', (els) => els.map((b) => b.id));
  await page.keyboard.press('Escape');
  say(`Import sits just before Export in the ⋯ menu (${w})`, heads.join() === 'f-new,f-import,f-export,f-deleted',
    heads.join());

  // a list read from a text file by the stand-in: one point repeats a finding
  await page.click('#f-more'); await page.click('#f-import'); await page.waitForSelector('#il-drop');
  await page.setInputFiles('#il-file', { name: 'Lender counsel comments.txt', mimeType: 'text/plain', buffer: Buffer.from('Comments\n1. Change of control definition omits the sponsor fund vehicles\n2. Fees letter is not yet agreed\n3. Hedging policy must be delivered before first drawdown') });
  await page.waitForSelector('#il-raised');
  const small = await page.evaluate(() => ({ count: document.querySelector('#il-count').textContent, rows: document.querySelectorAll('#il-raised .ilr').length, line: document.querySelector('#il-line').textContent, was: document.querySelector('#il-raised .was')?.textContent, fresh: [...document.querySelectorAll('#il-new .iln')].map((r) => [...r.children].map((c) => c.textContent).filter(Boolean).join(' ')).join(' · ') }));
  say(`a text list: 3 points, the repeat listed with its finding (${w})`, small.count === '3 points' && small.rows === 1 && small.line === '2 new findings' && small.was === 'JoinsChange of control definition omits the sponsor fund vehicles' && small.fresh === '#2 Fees letter is not yet agreed Financial · #3 Hedging policy must be delivered before first drawdown Legal', JSON.stringify(small));
  // closing keeps the list as read: the × closes at once, asking nothing, and Import opens it again as it was left
  await page.click('.ilf .shead .x'); const closed = await page.waitForSelector('.ilf', { state: 'detached', timeout: 2000 }).then(() => true, () => false);
  await page.click('#f-more'); await page.click('#f-import'); await page.waitForSelector('#il-raised');
  const again = await page.evaluate(() => ({ count: document.querySelector('#il-count').textContent, rows: document.querySelectorAll('#il-raised .ilr').length, line: document.querySelector('#il-line').textContent }));
  say(`closing keeps the list as read, and Import opens it again as it was (${w})`, closed && again.count === small.count && again.rows === small.rows && again.line === small.line, JSON.stringify(again));
  // start over asks first, in the footer, and then clears the list for good
  await page.click('#il-restart'); await page.waitForSelector('#il-restart-ask');
  const restart = { ask: await page.textContent('#il-restart-ask span'), go: await page.textContent('#il-restart-ask-go') };
  await page.click('#il-restart-ask-go'); await page.waitForSelector('#il-drop');
  await page.keyboard.press('Escape'); await page.waitForSelector('.ilf', { state: 'detached' });

  // a file that is not a list: said so, nothing changed
  await page.click('#f-more'); await page.click('#f-import'); await page.waitForSelector('#il-drop');
  say(`start over asks first and clears the list (${w})`, restart.ask === 'Clear this import and start over?' && restart.go === 'Start Over' && !(await page.$('#il-raised')), JSON.stringify(restart));
  await checkPastedList(page, say, w);
  await page.setInputFiles('#il-file', { name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe]) });
  await page.waitForSelector('#il-error');
  say(`a file that is not a list says so (${w})`, (await page.textContent('#il-error')).startsWith('Couldn’t read scan.pdf'), await page.textContent('#il-error'));

  // deal scale: the model's 164 points
  await page.evaluate((ids) => {
    const same = new Map(Array.from({ length: 23 }, (_, k) => [k * 7, { finding: ids[k * 5] }])); for (const [a, b] of [[60, 25], [79, 29], [103, 61], [141, 112]]) same.set(a, { point: b });
    window.__issues = Array.from({ length: 164 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1}: the clause should follow the agreed term sheet position on item ${k + 1}, as the sponsor proposed in the last turn of the draft.`, title: `Issue ${k + 1} on the credit agreement`, workstream: k % 2 ? 'Legal' : 'Financial', ...(same.has(k) ? { same: same.get(k) } : {}) }));
  }, ids);
  await page.setInputFiles('#il-file', { name: LIST, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await page.waitForSelector('#il-raised');
  const big = await page.evaluate(() => { const d = document.querySelector('.ilf'); return { count: document.querySelector('#il-count').textContent, rows: document.querySelectorAll('#il-raised .ilr').length, raised: document.querySelector('.ilf .srow.top .k').textContent, line: document.querySelector('#il-line').textContent, over: d.scrollWidth - d.clientWidth, fits: d.getBoundingClientRect().bottom <= innerHeight, cut: [...document.querySelectorAll('.ilfile .fnw span')].map((s) => s.textContent).join('') }; });
  say(`164 points: 27 already raised, 137 new (${w})`, big.count === '164 points' && big.rows === 27
    && big.raised === 'Already Raised27' && big.line === '137 new findings', JSON.stringify(big));
  say(`the dialog fits the window with no sideways scroll (${w})`, big.over <= 0 && big.fits, JSON.stringify(big));
  say(`the file's name shows without its extension (${w})`, big.cut === LIST.replace(/\.pdf$/, ''), big.cut);
  // the label stays in sight as the points scroll
  // each section's label stays in sight as its points scroll: Already raised at its last point, New findings at the list's end
  const stuck = await page.evaluate(async () => {
    const b = document.querySelector('.ilf-body'), [a, n] = document.querySelectorAll('.ilf .srow.top .k'); const seen = (k) => { const x = k.getBoundingClientRect(), r = b.getBoundingClientRect(); return x.top >= r.top && x.bottom <= r.bottom; };
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.querySelector('#il-raised .ilr:last-child').scrollIntoView({ block: 'end' }); await frame(); const one = seen(a);
    b.scrollTop = b.scrollHeight; await frame(); return { one, two: seen(n) };
  });
  say(`each section's label stays in sight to its last point (${w})`, stuck.one && stuck.two, JSON.stringify(stuck));
  // each already-raised point says what it joins, and every new finding is listed, read only, with its workstream
  const rows = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#il-raised .ilr')], n = [...document.querySelectorAll('#il-new .iln')];
    const line = (x) => ({ n: x.querySelector('.n').textContent, was: x.querySelector('.was').textContent, box: x.querySelector('.keep').textContent });
    return { first: line(r[0]), closed: r.length, chain: line(r.find((x) => x.querySelector('.n').textContent === '#142')), point: line(r.find((x) => x.querySelector('.n').textContent === '#61')),
      head: document.querySelectorAll('.ilf .srow.top .k')[1]?.textContent, newRows: n.length, firstNew: [...n[0].children].map((c) => c.textContent), inputs: document.querySelectorAll('#il-new input,#il-new button').length,
      lefts: [...new Set([...r.slice(0, 3), ...n.slice(0, 3)].map((x) => Math.round(x.children[1].getBoundingClientRect().left)))] };
  });
  say(`an already-raised point says what it joins, by the finding Import will put it on (${w})`, rows.first.n === '#1' && rows.first.was === 'JoinsChange of control definition omits the sponsor fund vehicles' && rows.first.box === 'Keep separate' && rows.chain.was === 'JoinsFinding 80 on the credit agreement' && rows.point.was === 'Joins#26 Issue 26 on the credit agreement', JSON.stringify(rows));
  say(`every new finding is listed, read only, with its title and workstream (${w})`, rows.head === 'New Findings137'
    && rows.newRows === 137 && rows.firstNew.join('|') === '#2|Issue 2 on the credit agreement|Legal'
    && rows.inputs === 0, JSON.stringify(rows));
  say(`the titles in both sections start at the same place (${w})`, rows.lefts.length === 1, JSON.stringify(rows.lefts));
  await page.click('#il-raised .ilr:nth-child(2) .keep');
  const checked = await page.evaluate(() => { const r = document.querySelector('#il-raised .ilr:nth-child(2)'); return { off: r.querySelector('.was').classList.contains('off'), strike: getComputedStyle(r.querySelector('.was')).textDecorationLine, n: r.querySelector('.n').textContent, listed: [...document.querySelectorAll('#il-new .iln .n')].map((x) => x.textContent).includes(r.querySelector('.n').textContent), head: document.querySelectorAll('.ilf .srow.top .k')[1].textContent }; });
  say(`checking a point keeps it as its own finding: its join is struck through and it is listed as new (${w})`,
    (await page.textContent('#il-line')) === '138 new findings' && checked.off && checked.strike === 'line-through'
    && checked.listed && checked.head === 'New Findings138', JSON.stringify(checked));
  // a point joining an earlier one follows it: kept separate, the earlier point is a new finding, and the later joins that
  await page.click('#il-raised .ilr:nth-child(20) .keep');
  const follow = await page.evaluate(() => [...document.querySelectorAll('#il-raised .ilr')].find((x) => x.querySelector('.n').textContent === '#142').querySelector('.was').textContent);
  say(`a point joining a kept-separate point joins that point's new finding (${w})`, follow === 'Joins#113 Issue 113 on the credit agreement' && (await page.textContent('#il-line')) === '139 new findings', follow);
  await page.click('#il-raised .ilr:nth-child(20) .keep');
  // with a point checked, another list would drop the check mark: asked first, and Keep going keeps it
  await page.click('#il-change'); await page.waitForSelector('#il-swap');
  const swap = { ask: await page.textContent('#il-swap span'), go: await page.textContent('#il-swap-go') };
  await page.click('#il-swap .btn:not(.pri)'); await page.waitForSelector('#il-line');
  say(`with a check mark, choosing another list asks first and the check mark stays (${w})`, swap.ask === 'Choose another list?' && swap.go === 'Choose' && (await page.isChecked('#il-raised .ilr:nth-child(2) input')) && (await page.textContent('#il-line')) === '138 new findings', JSON.stringify(swap));
  // a reload keeps the 164 points as read and the check mark, with no second read
  const model = await page.evaluate(() => window.__issues);   // the stand-in's reading, which the checks after use again
  await page.reload(); await page.waitForSelector('.flagrow');
  await page.evaluate((x) => { window.__issues = x; }, model); await page.click('#f-more');
  await page.click('#f-import'); await page.waitForSelector('#il-raised');
  const reloaded = { count: await page.textContent('#il-count'), checked: await page.isChecked('#il-raised .ilr:nth-child(2) input'), line: await page.textContent('#il-line') };
  say(`a reload keeps the list as read and its check mark (${w})`, reloaded.count === '164 points' && reloaded.checked && reloaded.line === '138 new findings', JSON.stringify(reloaded));
  await page.click('#il-go'); await page.waitForSelector('.ilf', { state: 'detached' });
  const after = await page.evaluate((ids) => { const fs = Object.values(store.get().findings); const madeBy = (f, n) => f.onLists?.length === 1 && f.onLists[0].n === n && f.id !== ids[0]; // the list is grouped by workstream: point 2's row is found by its finding, and each group keeps the list's order
    const row = () => document.querySelector(`a.flagrow[href$="${fs.find((f) => madeBy(f, '2')).id}"]`); const byId = new Map(fs.map((f) => [f.id, f])); const groups = () => { const out = new Map(); for (const a of document.querySelectorAll('a.flagrow')) { const f = [...byId.values()].find((x) => a.getAttribute('href').endsWith(x.id)); if (!f || f.id === ids[0] || f.onLists?.length !== 1 || ids.includes(f.id)) continue; const g = out.get(f.workstream) ?? []; g.push(+f.onLists[0].n); out.set(f.workstream, g); } return [...out.values()]; }; const t = store.get().ui.toasts.at(-1); return { n: fs.length, toast: t?.text, undo: t?.action?.label, op: t?.action?.opId, marked: fs.filter((f) => f.onLists?.length).length, first: row().querySelector('.ft').textContent, meta: row().querySelector('.fm').textContent, inOrder: groups().every((g) => g.every((n, k) => !k || g[k - 1] < n)), joined: store.get().findings[ids[0]].onLists?.map((m) => m.n), older: document.querySelector(`a.flagrow[href$="${ids[0]}"] .fm`)?.textContent, aim: row().querySelector('.ft .aim')?.title, olderAim: !!document.querySelector(`a.flagrow[href$="${ids[0]}"] .aim`) }; }, ids);
  say(`Import makes 138 findings, in the list's order, with one Undo (${w})`, after.n === 264 && after.toast === 'Imported 138 findings · 26 already raised' && after.undo === 'Undo' && after.first.endsWith('Issue 2 on the credit agreement') && after.inOrder, JSON.stringify(after));
  say(`an imported finding's title is the point's own words, with no AI mark (${w})`,
    after.first === 'Issue 2 on the credit agreement' && !after.aim && !after.olderAim, JSON.stringify(after));
  say(`every finding a point is on says so in its row (${w})`, after.marked === 160 && after.meta.endsWith(' · #2 on issues list') && after.joined?.join() === '1' && !!after.older?.endsWith(' · #1 on issues list'), JSON.stringify(after));
  // the finding's page: the mark, and the list and the point's words on hover
  await page.goto(`${URL}#finding-${dealId}-${ids[0]}`); await page.waitForSelector('.ilh');
  const tip = { tip: await tipAfter(page, ids[0], () => page.hover('.ilh')), mark: await page.textContent('.ilh') };
  say(`the finding's page shows its point, with the list and the words on hover (${w})`, tip.mark === '#1 on issues list' && tip.tip.startsWith('Credit Agreement Issues List – Sponsor counsel (Nov 14)\n#1 · Point 1: the clause'), JSON.stringify(tip));
  say(`the mark is plain text, not a button (${w})`, await page.evaluate(() => document.querySelector('.ilh').tagName === 'SPAN' && getComputedStyle(document.querySelector('.ilh')).textDecorationLine === 'none'));
  // a finding on several points: every point shows some of its words, a line each under the list's name
  const many = await page.evaluate(() => Object.values(store.get().findings).find((f) => (f.onLists?.length ?? 0) > 1)?.id);
  await page.goto(`${URL}#finding-${dealId}-${many}`); await page.waitForSelector('.ilh');
  const tipText2 = await tipAfter(page, many, () => page.focus('.ilh'));
  const tip2 = { lines: tipText2.split('\n'), mark: await page.textContent('.ilh') };
  say(`several points: the list's name, then each point's number and words on a line (${w})`, /^#\d+, #\d+ on issues list$/.test(tip2.mark) && tip2.lines.length === 3 && tip2.lines[0] === LIST.replace(/\.pdf$/, '') && tip2.lines.slice(1).every((l) => /^#\d+ · \S/.test(l) && l.length <= 90), JSON.stringify(tip2));
  // the same list chosen again: every point is already raised, by the point its finding holds, whatever the model says
  await page.goto(`${URL}#deal-${dealId}`); await page.waitForSelector('.flagrow');
  await page.evaluate(() => { window.__issues = window.__issues.map((p) => ({ ...p, same: undefined })); store.ui({ toasts: [] }); });
  await page.click('#f-more'); await page.click('#f-import'); await page.waitForSelector('#il-drop');
  await page.setInputFiles('#il-file', { name: LIST, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') }); await page.waitForSelector('#il-raised');
  const twice = await page.evaluate(() => ({ rows: document.querySelectorAll('#il-raised .ilr').length, line: document.querySelector('#il-line').textContent }));
  await page.click('#il-go'); await page.waitForSelector('.ilf', { state: 'detached' });
  const n2 = await page.evaluate(() => Object.keys(store.get().findings).length);
  say(`the same list again: all 164 already raised, nothing made twice (${w})`, twice.rows === 164 && twice.line === '0 new findings' && n2 === 264, JSON.stringify({ twice, n2 }));
  // long after its notice: the list is taken back from Deleted, whose button shows while there is a list to remove
  await page.evaluate(() => store.ui({ toasts: [] }));
  await page.click('#f-more'); const btn = await page.textContent('#f-deleted');
  await page.click('#f-deleted'); await page.waitForSelector('.deldlg [data-del="list"]');
  // a group label's own words, without the count beside them
  const labels = await page.$$eval('.deldlg .lbl', (all) => all.map((l) => l.firstChild.textContent));
  const row = await page.evaluate(() => {
    const r = document.querySelector('.deldlg [data-del="list"]');
    const dlg = document.querySelector('.deldlg');
    return {
      name: r.querySelector('b').textContent,
      meta: r.querySelector('.dmeta').textContent,
      go: r.querySelector('button').textContent,
      tip: r.querySelector('button').title,
      over: dlg.scrollWidth - dlg.clientWidth,
    };
  });
  say(`Deleted lists the issues list with Remove (${w})`, btn === 'Deleted…' && labels.join() === 'Issues Lists'
    && row.name === LIST.replace(/\.pdf$/, '') && row.meta === '138 findings · 26 already raised' && row.go === 'Remove'
    && row.tip.startsWith('Send its 138 findings to Deleted') && row.over <= 0, JSON.stringify({ btn, row }));
  const removeList = page.locator('.deldlg [data-del="list"] button');
  const beforeRemove = await listStatus(page);
  for (const keep of ['button', 'Escape']) {
    await removeList.click();
    await page.waitForSelector('#ask-go', { timeout: 4000 });
    const prompt = await page.textContent('#ask-title');
    const impact = await page.textContent('#ask-text');
    const safeFocus = await page.evaluate(() => document.activeElement?.id === 'ask-keep');
    say(`Remove asks what will change and writes nothing before approval (${w}, ${keep})`,
      prompt === `Remove ${LIST}?`
      && impact === '138 findings go to Deleted. Marks are removed from 22 findings.'
      && safeFocus && (await listStatus(page)) === beforeRemove, JSON.stringify({ prompt, impact, safeFocus }));
    if (keep === 'Escape') await page.keyboard.press('Escape');
    else await page.click('#ask-keep');
    await removeList.waitFor();
    await page.waitForFunction(() => document.activeElement?.matches('.deldlg [data-del="list"] button'));
    say(`Cancel keeps the list and restores focus (${w}, ${keep})`, (await listStatus(page)) === beforeRemove);
  }
  await removeList.click();
  await page.click('#ask-go');
  await page.waitForSelector('.deldlg [data-del="finding"]');
  await page.waitForFunction(() => document.activeElement?.matches('.deldlg [data-restore]'), null, { timeout: 2000 }).catch(() => {});
  const removed = await page.evaluate(() => ({ n: Object.keys(store.get().findings).length, marked: Object.values(store.get().findings).filter((f) => f.onLists?.length).length, rows: document.querySelectorAll('.deldlg [data-del="finding"]').length, list: !!document.querySelector('.deldlg [data-del="list"]'), toast: store.get().ui.toasts.at(-1), focus: !!document.activeElement?.matches('.deldlg [data-restore]') }));
  say(`Remove sends its findings to Deleted and takes its marks off, with Undo (${w})`, removed.n === 126 && removed.marked === 0 && removed.rows === 138 && !removed.list && removed.toast?.text === 'Removed 138 findings' && removed.toast?.action?.label === 'Undo' && removed.focus, JSON.stringify({ ...removed, toast: removed.toast?.text }));
  await page.keyboard.press('Escape'); await page.waitForSelector('.deldlg', { state: 'detached' });
  await page.evaluate((op) => store.dispatch(store.commandNamed('Undo'), { opId: op }), removed.toast.action.opId);
  const back = await page.evaluate(() => ({ n: Object.keys(store.get().findings).length, marked: Object.values(store.get().findings).filter((f) => f.onLists?.length).length }));
  say(`its Undo brings the list back whole (${w})`, back.n === 264 && back.marked === 160, JSON.stringify(back));
  // the findings put back are new versions, so the import's own Undo is refused; Remove takes it back to the 126 findings as they were
  const late = await page.evaluate((op) => store.dispatch(store.commandNamed('Undo'), { opId: op }), after.op);
  await page.evaluate((d) => store.dispatch(store.commandNamed('RemoveIssuesList'), { dealId: d, doc: Object.values(store.get().findings).find((f) => f.onLists?.length).onLists[0].doc }), dealId);
  const undone = await page.evaluate(() => ({ n: Object.keys(store.get().findings).length, marked: Object.values(store.get().findings).filter((f) => f.onLists?.length).length }));
  say(`Remove leaves the 126 findings as they were (${w})`, !late.ok && undone.n === 126 && undone.marked === 0, JSON.stringify(undone));
  // a revised list counsel sends under the same file name is its own list: Deleted shows each, and Remove takes only the one chosen
  const pick = async (pts, bytes) => {
    await page.evaluate((x) => { window.__issues = x; store.ui({ toasts: [] }); }, pts);
    await page.click('#f-more'); await page.click('#f-import'); await page.waitForSelector('#il-drop');
    await page.setInputFiles('#il-file', { name: LIST, mimeType: 'application/pdf', buffer: Buffer.from(bytes) }); await page.waitForSelector('#il-go:not([disabled])');
    await page.click('#il-go'); await page.waitForSelector('.ilf', { state: 'detached' });
  };
  const pts = (n, how) => Array.from({ length: n }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1}, as counsel ${how} it: the clause should follow the agreed term sheet position.`, title: `${how} point ${k + 1}`, workstream: 'Legal' }));
  await pick(pts(164, 'first wrote'), '%PDF-1.4 first'); await pick(pts(120, 'revised'), '%PDF-1.4 revised');
  await page.click('#f-more'); await page.click('#f-deleted'); await page.waitForSelector('.deldlg [data-del="list"]');
  const twins = await page.evaluate(() => [...document.querySelectorAll('.deldlg [data-del="list"]')].map((r) => ({ name: r.querySelector('b').textContent, meta: r.querySelector('.dmeta').textContent })));
  say(`two lists under one name are two rows, each with when it came in (${w})`, twins.length === 2 && twins.every((t) => t.name === LIST.replace(/\.pdf$/, '') && /^Imported \w{3} \d+, \d+:\d\d(:\d\d)? [AP]M · /.test(t.meta)) && twins[0].meta.endsWith('164 findings · 0 already raised') && twins[1].meta.endsWith('120 findings · 0 already raised'), JSON.stringify(twins));
  await page.locator('.deldlg [data-del="list"]').nth(1).locator('button').click();
  const revisedTime = twins[1].meta.split(' · ')[0].replace(/^Imported /, '');
  const revisedAsk = await page.textContent('#ask-title');
  say(`Confirmation distinguishes revisions with the same name (${w})`,
    revisedAsk === `Remove ${LIST} (imported ${revisedTime})?`, revisedAsk);
  await page.click('#ask-go');
  await page.waitForFunction(() => document.querySelectorAll('.deldlg [data-del="list"]').length === 1 && /^Removed/.test(store.get().ui.toasts.at(-1)?.text ?? ''), null, { timeout: 5000 }).catch(() => {});
  const one = await page.evaluate(() => { const fs = Object.values(store.get().findings); return { n: fs.length, first: fs.filter((f) => f.title.startsWith('first wrote')).length, revised: fs.filter((f) => f.title.startsWith('revised')).length, rows: [...document.querySelectorAll('.deldlg [data-del="list"]')].map((r) => r.querySelector('.dmeta').textContent), toast: store.get().ui.toasts.at(-1)?.text }; });
  say(`Remove takes only the revised list; the first stays whole (${w})`, one.n === 126 + 164 && one.first === 164 && one.revised === 0 && one.toast === 'Removed 120 findings' && one.rows.length === 1 && one.rows[0] === '164 findings · 0 already raised', JSON.stringify(one));
  await page.keyboard.press('Escape'); await page.waitForSelector('.deldlg', { state: 'detached' });
  await checkRemovalApproval(page, dealId, say, w);
  say(`no page errors (${w})`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
