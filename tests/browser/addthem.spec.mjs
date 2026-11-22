// The firm's list against a deal's items on the Checklist (linking design, section 5): the icon on items no longer in the
// firm's list, and "Add them" for the firm's items the deal does not hold, on a deal holding a general list of 2,000
// items. Runs on the mock services. With SHOTS=<folder>, it also saves the page in both themes at both sizes.
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const SHOTS = process.env.SHOTS || '';
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note); };
const browser = await launchChrome();

const LONG = "Each lender's counsel has delivered its legal opinion on the finance documents, the security documents and the direct agreements, in final form";
const SAMPLES = ['Operating assumptions agree across the advisors’ reports', 'Lock-up ratio matches the term sheet', 'Contracted revenue covers the base case capacity', 'Insurance advisor report (final)', 'Executed direct agreement', 'Financial model has been audited', LONG];
/** the firm's general list: the sample items and enough others for 2,000, in sections and subsections */
function generalList() {
  const secs = ['Corporate', 'Finance', 'Contracts', 'Permits and land', 'Technical', 'Insurance', 'Tax', 'Environmental and social']; const subs = ['Documents', 'Approvals', 'Conditions', 'Reporting', 'Third parties'];
  const items = SAMPLES.map((text, i) => ({ text, section: secs[0], subsection: subs[i % 2] }));
  for (let i = 0; items.length < 2000; i++) items.push({ text: `Agreement ${i + 1} has been reviewed by counsel`, section: secs[1 + (i % 7)], subsection: subs[Math.floor(i / 7) % 5] });
  return items;
}
/** the list as the firm brings it in again: 12 items gone from it (the long one among them) and 37 new ones */
const DROPPED = [SAMPLES[3], SAMPLES[4], LONG, ...Array.from({ length: 9 }, (_, i) => `Agreement ${i + 1} has been reviewed by counsel`)];
function nextList() {
  const items = generalList().filter((it) => !DROPPED.includes(it.text));
  for (let i = 0; i < 37; i++) items.push({ text: `Consent ${i + 1} from the offtaker is in final form`, section: 'Contracts', subsection: 'Third parties' });
  return items;
}
const bring = (page, items) => page.evaluate((items) => store.dispatch(store.commandNamed('BringInList'), { list: { layer: 'broad', name: '', items, file: 'Firm checklist.xlsx', fileDate: '' } }, { quiet: true }), items);
async function start(size = [1280, 736], scheme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await bring(page, generalList());
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create');
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.waitForFunction((d) => Object.values(store.get().items).filter((i) => i.dealId === d).length === 2000, id, { timeout: 30000 });
  // the list changes on another PC: only the list is written, so this deal is left without the new items
  await bring(page, nextList());
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow[data-result="finding"]');
  return { ctx, page, id };
}
const count = (page, id) => page.evaluate((d) => { const its = Object.values(store.get().items).filter((i) => i.dealId === d); return { all: its.length, on: its.filter((i) => !i.off).length }; }, id);
const marked = (page) => page.evaluate(() => [...document.querySelectorAll('#ck-rows .ckrow')].filter((r) => r.querySelector('.unli')).map((r) => r.querySelector('.it').textContent));

{ // the icon and the line, as the page opens
  const { ctx, page, id } = await start();
  await page.waitForSelector('#ck-add-them');
  const line = await page.textContent('#ck-add-them');
  say('the line says how many of the firm’s items the deal does not hold, with Add Them',
    line === '37 items from the firm’s list are not on this deal. Add Them', line);
  const m = await marked(page);
  say('every item no longer in the firm’s list has the icon, and no other', m.length === 12 && DROPPED.every((t) => m.includes(t)), JSON.stringify(m));
  const tip = await page.evaluate(() => { const r = document.querySelector('#ck-rows .ckrow .unli'); return { title: r.getAttribute('title'), sr: r.closest('.ckrow').querySelector('.sr-only').textContent }; });
  say('the icon names what it means on hover and to a screen reader', tip.title === 'No longer in the firm’s list' && tip.sr.startsWith(', No longer in the firm’s list, '), JSON.stringify(tip));

  // the long item, two lines in the narrow list beside an open pane: its icon stays in sight, inside the row
  await page.click(`#ck-rows .ckrow:has-text("${SAMPLES[0]}")`); await page.waitForSelector('#ck-more');
  const box = await page.evaluate((t) => { const r = [...document.querySelectorAll('#ck-rows .ckrow')].find((x) => x.querySelector('.it').textContent === t); r.scrollIntoView({ block: 'center' }); const i = r.querySelector('.unli').getBoundingClientRect(); const te = r.querySelector('.tx'); const x = te.getBoundingClientRect(); const o = r.querySelector('.it').getBoundingClientRect(); return { iw: i.width, ih: i.height, inside: i.right <= o.right + 0.5 && i.left >= x.right - 0.5 && o.right - i.right < 1, lines: Math.round(x.height / parseFloat(getComputedStyle(te).lineHeight)) }; }, LONG);
  say('a long item keeps its icon in sight after its two lines, in the narrow list', box.iw === 16 && box.inside && box.lines === 2, JSON.stringify(box));
  await page.keyboard.press('Escape');

  // Add them: one change, with Undo
  const before = await count(page, id);
  await page.click('#ck-add-them-go'); await page.waitForFunction(() => !document.querySelector('#ck-add-them'), null, { timeout: 10000 }).catch(() => {});
  const after = await count(page, id); const toast = await page.textContent('#toast');
  const focus = await page.evaluate(() => ({ id: document.activeElement?.id, item: document.activeElement?.dataset?.item ?? null }));
  say('the focus goes to the list, not the page, when the line goes', !!focus.item, JSON.stringify(focus));
  say('Add Them adds the 37 the deal lacked, and the line goes', before.all === 2000 && after.all === 2037
    && after.on === before.on + 37 && !(await page.$('#ck-add-them')), JSON.stringify({ before, after }));
  say('the notice says how many were added, with Undo', /37 items added/.test(toast) && !!(await page.$('#toast .tundo')), toast);
  say('the items no longer in the firm’s list keep their icon and stay on', (await marked(page)).length === 12 && (await count(page, id)).on === 2037);
  await page.click('#toast .tundo'); await page.waitForFunction((d) => Object.values(store.get().items).filter((i) => i.dealId === d && !i.off).length === 2000, id, { timeout: 10000 }).catch(() => {});
  const undone = await count(page, id);
  say('Undo turns the 37 off again; nothing is deleted, and the line does not come back for items turned off', undone.all === 2037 && undone.on === 2000 && !(await page.$('#ck-add-them')), JSON.stringify(undone));
  say('no page errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

{ // not offered on a deal marked Closed, nor while the deal is in two versions
  const { ctx, page, id } = await start();
  await page.waitForSelector('#ck-add-them');
  await page.evaluate((d) => store.dispatch(store.commandNamed('EditDeal'), { dealId: d, group: 'closed' }, { quiet: true }), id);
  await page.waitForFunction(() => !document.querySelector('#ck-add-them'), null, { timeout: 5000 }).catch(() => {});
  say('a deal marked Closed is not offered Add Them', !(await page.$('#ck-add-them')));
  say('its items keep their icon', (await marked(page)).length === 12);
  await page.evaluate((d) => store.dispatch(store.commandNamed('EditDeal'), { dealId: d, group: 'live' }, { quiet: true }), id);
  await page.waitForSelector('#ck-add-them', { timeout: 5000 }).catch(() => {});
  say('reopened, it is offered again', !!(await page.$('#ck-add-them')));
  // pressed after another PC added some of them: only what is still missing is added
  await page.evaluate(([d, items]) => store.dispatch(store.commandNamed('AddDealItems'), { dealId: d, items: items.map((text) => ({ text, from: [{ layer: 'broad', value: '' }] })) }, { quiet: true }), [id, Array.from({ length: 30 }, (_, i) => `Consent ${i + 1} from the offtaker is in final form`)]);
  await page.waitForFunction(() => /^7 items/.test(document.querySelector('#ck-add-them')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  say('what is offered follows what the deal holds', (await page.textContent('#ck-add-them')).startsWith('7 items from the firm’s list'), await page.textContent('#ck-add-them'));
  await page.click('#ck-add-them-go'); await page.waitForFunction(() => !document.querySelector('#ck-add-them'), null, { timeout: 10000 }).catch(() => {});
  say('Add Them then adds the 7 still missing', (await count(page, id)).all === 2037
    && /7 items added/.test(await page.textContent('#toast')), await page.textContent('#toast'));
  say('no page errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

{ // one list in two versions: the icon counts every version's items; Add them offers only what every version holds
  const { ctx, page, id } = await start();
  await page.waitForSelector('#ck-add-them');
  await page.evaluate(() => { const s = store.get(); const l = Object.values(s.firmList)[0]; const other = { ...l, items: [...l.items.slice(0, -10), { text: 'Something only one version holds' }], rev: l.rev + 1 }; store.set({ ...s, conflicts: { ...s.conflicts, [l.id]: { kind: 'firmList', id: l.id, dealId: '', versions: [{ data: l }, { data: other }] } } }); });
  await page.waitForFunction(() => /^27 items/.test(document.querySelector('#ck-add-them')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  say('a list in two versions offers only the items both hold', (await page.textContent('#ck-add-them')).startsWith('27 items from the firm’s list'), await page.textContent('#ck-add-them'));
  say('and marks no item that either version holds', (await marked(page)).length === 12);
  await ctx.close();
}

if (SHOTS) for (const [w, h] of [[1280, 736], [1024, 640]]) for (const scheme of ['dark', 'light']) {
  const { ctx, page } = await start([w, h], scheme);
  await page.waitForSelector('#ck-add-them');
  await page.evaluate(() => { document.querySelector('#ck-rows').scrollTop = 0; });   // from the top: the marked items are among the first rows
  await page.waitForTimeout(400); await page.mouse.move(0, 0);
  await page.screenshot({ path: `${SHOTS}/1-list-${scheme}-${w}x${h}.png` });
  await page.click(`#ck-rows .ckrow:has-text("${SAMPLES[0]}")`); await page.waitForSelector('#ck-more');
  await page.evaluate(() => { document.querySelector('#ck-rows').scrollTop = 0; });   // from the top: the marked items are among the first rows
  await page.waitForTimeout(400);
  await page.hover('#ck-rows .ckrow .unli'); await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/2-pane-open-${scheme}-${w}x${h}.png` });
  await page.click('#ck-add-them-go'); await page.waitForSelector('#toast .tundo'); await page.mouse.move(0, 0); await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/3-added-${scheme}-${w}x${h}.png` });
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
