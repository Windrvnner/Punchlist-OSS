// The cached mark: shown beside a document that is loaded in the user's store right now, and nothing more.
// A document without it still opens and can still be asked about.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const SHOTS = process.env.SHOTS || '';
async function start(scheme, limit) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  if (limit) await page.evaluate((n) => { window.__cacheLimit = n; }, limit);
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  return { ctx, page, id: await page.evaluate(() => Object.values(store.get().deals)[0].id) };
}
const popMarks = (page) => page.evaluate(() => [...document.querySelectorAll('.opening .ref .pop i.psrc')].map((i) => [i.querySelector('.docnm').textContent + (i.querySelector('.loc')?.textContent ?? ''), !!i.querySelector('.cmark')]));
const openFinding = async (page, id, n) => { await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); await page.click(`.flagrow:nth-of-type(${n})`).catch(() => page.locator('.flagrow').nth(n - 1).click()); await page.waitForSelector('.opening .ref .rb'); };

async function samplePreview(page, name, number) {
  await page.waitForFunction((n) => document.querySelector('.docbody .page .pg')?.textContent === `Page ${n}`, number);
  const paper = page.locator('.docbody .page');
  const title = await paper.locator('h4').textContent();
  const message = await paper.locator(':scope > p').allTextContents();
  const cached = await page.locator('.docnav .cmark').count() === 1;
  const controls = await page.locator('.docnav button#doc-close, .pgstack button:not(:disabled)').count() === 6;
  await page.click('#doc-close');
  return title === name && message[0] === 'Preview unavailable for this sample document.' && cached && controls;
}

async function samplePreviews(page, area) {
  const citations = page.locator(`${area} .ref .rb`);
  await citations.first().click();
  const report = await samplePreview(page, 'Technical advisor report', 41);
  await citations.nth(1).click();
  const memorandum = await samplePreview(page, 'Information memorandum', 22);
  return [report, memorandum];
}

// #443: the newly indexed demo's sample citations explain the missing preview wherever reading mode opens.
{ const { ctx, page, id } = await start('light');
  await page.locator('.flagrow').filter({ hasText: 'Technical report and information memorandum disagree' }).click();
  const finding = await samplePreviews(page, '.opening');
  await page.fill('#pask', 'Why does this matter?');
  await page.press('#pask', 'Enter');
  const chat = await samplePreviews(page, '.msgs .ai:not(.pending):not(.failed)');
  await page.goto(URL + '#checklist-' + id);
  await page.getByRole('option', { name: /Technical advisor confirms the energy yield/ }).click();
  const source = page.locator('#ck-sources .ckopen');
  const number = Number((await source.locator('.clc').textContent()).replace('p. ', ''));
  await source.click();
  const direct = await samplePreview(page, 'Technical advisor report', number);
  await page.getByRole('option', { name: /Operating assumptions agree across the advisors’ reports/ }).click();
  await page.click('#ck-open-finding');
  const linked = await samplePreviews(page, '.opening');
  say('demo-citations-explain-the-unavailable-preview',
    direct && [...finding, ...chat, ...linked].every(Boolean), JSON.stringify({ finding, chat, direct, linked }));
  await ctx.close();
}

// 1 everything the first pass read is loaded: every cited document carries the mark
{ const { ctx, page, id } = await start('light');
  await page.waitForFunction(() => Object.keys(store.get().cached).length === 6, null, { timeout: 5000 }).catch(() => {});
  await page.locator('.flagrow').first().click(); await page.waitForSelector('.opening .ref .rb');
  await page.hover('.opening .ref .rb'); await page.waitForSelector('.opening .ref .pop', { state: 'visible' }); await page.waitForTimeout(350);
  const m = await popMarks(page);
  const lab = await page.evaluate(() => { const c = document.querySelector('.opening .ref .pop .cmark'); return c && [c.getAttribute('aria-label'), c.getAttribute('title') ?? '', c.getAttribute('role'), getComputedStyle(c).cursor, c.tagName]; });
  const inline = await page.evaluate(() => { const i = document.querySelector('.opening .ref .pop i.psrc'); const a = (i.querySelector('.loc') ?? i.querySelector('.docnm')).getBoundingClientRect(), b = i.querySelector('.cmark').getBoundingClientRect(); return b.left >= a.right && Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < 4; });
  say('mark-sits-beside-the-name', inline);
  const whole = await page.evaluate(() => { const p = document.querySelector('.opening .ref:hover .pop'); const r = p.getBoundingClientRect(); return [...p.children].every((c) => { const b = c.getBoundingClientRect(); return b.height > 0 && b.height < 30 && b.top >= r.top && b.bottom <= r.bottom + 0.5 && getComputedStyle(c).position === 'static'; }) && p.lastElementChild.textContent === 'Open document →'; });
  say('pop-shows-every-line-inside-itself', whole);
  await page.hover('.opening .ref .pop .cmark'); await page.waitForSelector('.tip', { timeout: 2000 }).catch(() => {}); const tipText = await page.evaluate(() => document.querySelector('.tip')?.textContent ?? '');
  // a status dot, not a control: named for assistive tech, says "Cached" on hover, and does not look or act like a button
  say('mark-on-loaded-documents', m.length >= 1 && m.every(([, on]) => on) && lab && lab.slice(0, 3).join() === 'Cached,,img' && lab[3] !== 'pointer' && lab[4] === 'SPAN' && tipText === 'Cached', JSON.stringify({ m, lab, tipText }));
  if (SHOTS) { const r = await page.evaluate(() => { const b = document.querySelector('.opening .ref .pop').getBoundingClientRect(); return { x: b.x - 20, y: b.y - 40, width: b.width + 40, height: b.height + 60 }; }); await page.screenshot({ path: `${SHOTS}/cached-pop-light.png`, clip: r }); }
  say('no-page-errors-1', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

for (const scheme of ['dark', 'light']) {
  // 2 a store of two: the four documents read first have rotated out
  const { ctx, page, id } = await start(scheme, 2);
  await page.waitForFunction(() => Object.keys(store.get().cached).length === 2, null, { timeout: 5000 }).catch(() => {});
  const state = await page.evaluate(() => ({ cached: Object.keys(store.get().cached), all: Object.values(store.get().findings).flatMap((f) => f.sources.map((s) => s.docId)) }));
  say(`${scheme}:store-rotates`, state.cached.length === 2 && state.all.length === 6 && state.cached.every((c) => state.all.includes(c)), JSON.stringify(state.cached));
  // which finding cites the loaded pair, and which cites only documents that have rotated out
  const split = await page.evaluate(() => { const c = store.get().cached; const fs = Object.values(store.get().findings); return { loaded: fs.find((f) => f.sources.every((s) => c[s.docId])).id, out: fs.find((f) => f.sources.every((s) => !c[s.docId])).id }; });
  const openFindingById = async (fid) => { await page.goto(URL + `#finding-${id}-${fid}`); await page.waitForSelector('.opening .ref .rb'); };
  // a finding whose documents have rotated out: no marks, and it still opens
  await openFindingById(split.out);
  await page.hover('.opening .ref .rb'); await page.waitForSelector('.opening .ref .pop', { state: 'visible' }); await page.waitForTimeout(350);
  const none = await popMarks(page);
  say(`${scheme}:no-mark-when-rotated-out`, none.length >= 1 && none.every(([, on]) => !on), JSON.stringify(none));
  if (SHOTS) { const r = await page.evaluate(() => { const b = document.querySelector('.opening .ref .pop').getBoundingClientRect(); return { x: b.x - 20, y: b.y - 40, width: b.width + 40, height: b.height + 60 }; }); await page.screenshot({ path: `${SHOTS}/uncached-pop-${scheme}.png`, clip: r }); }
  const t0 = Date.now(); await page.click('.opening .ref .rb'); await page.waitForSelector('.docpanel .page:not(.ph-page), .docpanel .sheet', { timeout: 8000 }); const took = Date.now() - t0;
  await page.waitForSelector('.docnav .docname .cmark', { timeout: 4000 }).catch(() => {});
  const nav = await page.evaluate(() => ({ mark: !!document.querySelector('.docnav .docname .cmark'), name: document.querySelector('.docnav .docname b').firstChild.textContent, n: Object.keys(store.get().cached).length, err: !!document.getElementById('doc-error') }));
  const navInline = await page.evaluate(() => { const b = document.querySelector('.docnav .docname b'); const m = b.querySelector('.cmark').getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(b.firstChild); const t = r.getBoundingClientRect(); return m.left >= t.right && Math.abs((t.top + t.bottom) / 2 - (m.top + m.bottom) / 2) < 4; });
  say(`${scheme}:nav-mark-sits-beside-the-name`, navInline);
  say(`${scheme}:uncached-opens-and-becomes-loaded`, took >= 800 && nav.mark && nav.n === 2 && !nav.err, JSON.stringify({ took, nav }));
  if (SHOTS) { const r = await page.evaluate(() => { const b = document.querySelector('.docnav').getBoundingClientRect(); return { x: b.x - 20, y: b.y - 16, width: b.width + 40, height: b.height + 32 }; }); await page.screenshot({ path: `${SHOTS}/cached-nav-${scheme}.png`, clip: r }); }
  await page.click('#doc-menu'); await page.waitForSelector('.docmenu');
  const menu = await page.evaluate(() => [...document.querySelectorAll('.docmenu .dm-r')].map((g) => [g.querySelector('.docnm').textContent, !!g.querySelector('.cmark')]));
  say(`${scheme}:document-menu-marks-only-loaded`, menu.length === 2 && menu[0][1] === true && menu[1][1] === false, JSON.stringify(menu));
  if (SHOTS) { const r = await page.evaluate(() => { const b = document.querySelector('.docmenu').getBoundingClientRect(); return { x: b.x - 20, y: b.y - 16, width: b.width + 40, height: b.height + 32 }; }); await page.screenshot({ path: `${SHOTS}/cached-menu-${scheme}.png`, clip: r }); }
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  // chat is not limited to what is loaded: a follow-up on this finding is answered with its sources
  await page.waitForFunction(() => !document.querySelector('.docpanel'));
  await page.fill('#pask', 'Why does this matter?'); await page.press('#pask', 'Enter'); await page.waitForSelector('.msgs .ai:not(.pending):not(.failed)', { timeout: 8000 });
  const ans = await page.evaluate((fid) => { const k = Object.keys(store.get().threads).find((x) => x.includes(fid)); const m = store.get().threads[k].at(-1); return { state: m.state, sources: (m.sources || []).length }; }, split.out);
  say(`${scheme}:chat-answers-from-any-document`, ans.state === 'done' && ans.sources >= 1, JSON.stringify(ans));
  // the mark survives a reload, because it is the backend's state, not the window's
  const settled = () => page.waitForFunction(() => Object.keys(store.get().cached).sort().join() === JSON.parse(localStorage.getItem('dil/mock/cached') || '[]').sort().join(), null, { timeout: 5000 });
  await settled(); const before = await page.evaluate(() => Object.keys(store.get().cached).sort().join());
  await page.reload(); await page.waitForSelector('.opening'); await page.waitForFunction(() => Object.keys(store.get().cached).length === 2, null, { timeout: 5000 }).catch(() => {}); await settled();
  say(`${scheme}:loaded-set-survives-reload`, (await page.evaluate(() => Object.keys(store.get().cached).sort().join())) === before);
  // search marks loaded documents only
  await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.type('.pdf'); await page.waitForFunction(() => document.querySelectorAll('#pal-res button:not(.pmore)').length >= 4);
  const hits = await page.evaluate(() => { const c = store.get().cached; const all = Object.values(store.get().findings).flatMap((f) => f.sources); return [...document.querySelectorAll('#pal-res button:not(.pmore)')].map((b) => { const name = b.querySelector('.ttl').firstChild.textContent; const src = all.find((s) => s.doc === name); return [name, !!b.querySelector('.cmark'), !!c[src.docId]]; }); });
  say(`${scheme}:search-marks-only-loaded`, hits.length >= 4 && hits.every(([, shown, loaded]) => shown === loaded) && hits.some(([, shown]) => shown) && hits.some(([, shown]) => !shown), JSON.stringify(hits));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/cached-search-${scheme}.png`, clip: { x: 300, y: 70, width: 680, height: 330 } });
  await page.keyboard.press('Escape');
  // a file the backend cannot find: its message, in place of the page
  await page.evaluate(() => { window.__fail = { pageMissing: true }; });
  await openFindingById(split.loaded);
  await page.click('.opening .ref .rb'); await page.waitForSelector('#doc-error', { timeout: 8000 });
  const err = await page.textContent('#doc-error');
  say(`${scheme}:file-not-found-message`, /could not be found in the deal’s folders\. Retry/.test(err), err);
  await page.evaluate(() => { window.__fail = {}; }); await page.click('#doc-error .tundo'); await page.waitForSelector('.docpanel .page:not(.ph-page), .docpanel .sheet', { timeout: 8000 });
  say(`${scheme}:found-again-on-retry`, !(await page.$('#doc-error')));
  say(`${scheme}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
