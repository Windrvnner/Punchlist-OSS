// What the reading list covers. Each check is the exact thing a person would do.
import { launchChrome } from './chrome.mjs';
import { openDelete } from './dealMenu.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const SHOTS = process.env.SHOTS || '';
async function start(scheme = 'light', name = 'Proseware') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = []; page.console = []; page.bad = [];
  page.on('pageerror', (e) => page.errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') page.console.push(m.text()); }); page.on('response', (r) => { if (r.status() >= 400) page.bad.push(r.status() + ' ' + r.url()); });
  await page.goto(URL); await page.waitForSelector('#fr-new'); await page.waitForTimeout(600);
  const loadClean = page.console.length === 0 && page.bad.length === 0 && page.errors.length === 0;
  const icon = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute('href'));
  await page.click('#fr-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  return { ctx, page, id: await page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === 'Project ' + n).id, name), loadClean, icon };
}
const shot = async (page, name, sels) => { if (!SHOTS) return; const c = await page.evaluate((sels) => { const rs = sels.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter(Boolean); const x = Math.min(...rs.map((r) => r.left)) - 16, y = Math.min(...rs.map((r) => r.top)) - 16; return { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(...rs.map((r) => r.right)) - x + 16, height: Math.max(...rs.map((r) => r.bottom)) - y + 14 }; }, sels); await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: c }); };

{ const { ctx, page, id, loadClean, icon } = await start('light');
  say('nothing-fails-to-load', loadClean && icon === 'data:,', JSON.stringify({ console: page.console, bad: page.bad, icon }));

  // ---- each sentence carries the citation that follows it; nothing is linked to the wrong source or to nothing
  const f = await page.evaluate(() => { const x = Object.values(store.get().findings).find((f) => /Lock-up/.test(f.title)); return { id: x.id, sources: x.sources.map((s) => s.doc + ' · ' + s.loc), body: x.body[0] }; });
  await page.goto(`${URL}#finding-${id}-${f.id}`); await page.waitForSelector('.opening .dtxt .ref .rb');
  const cites = await page.evaluate(() => [...document.querySelectorAll('.opening .dtxt .ref')].map((r) => ({ text: r.querySelector('.rb').textContent, src: [...r.querySelectorAll('.pop i.psrc')].map((i) => i.querySelector('.docnm').textContent + i.querySelector('.loc').textContent) })));
  const whole = await page.evaluate(() => document.querySelector('.opening .dtxt').innerText.replace(/\s+/g, ' ').trim());
  say('each-sentence-has-its-own-source', cites.length === 2 && cites[0].text === 'The draft sets the distribution lock-up at 1.25x.' && cites[0].src.join() === f.sources[0] && cites[1].text === 'The signed term sheet has 1.30x.' && cites[1].src.join() === f.sources[1], JSON.stringify(cites));
  say('no-empty-citation-and-text-unchanged', cites.every((c) => c.text.trim().length > 0) && whole.startsWith('The draft sets the distribution lock-up at 1.25x. The signed term sheet has 1.30x.'), whole);

  // ---- Escape closes a menu, only the menu, and hands focus back
  await page.click('#f-status'); await page.waitForSelector('.stmenu'); await page.keyboard.press('Escape');
  say('escape-closes-status-menu', !(await page.$('.stmenu')) && (await page.evaluate(() => document.activeElement?.id)) === 'f-status' && /^#finding-/.test(await page.evaluate(() => location.hash)));
  await page.click('#pcomposer .mwrap button'); await page.waitForSelector('.mmenu'); await page.keyboard.press('Escape');
  say('escape-closes-model-menu', !(await page.$('.mmenu')) && await page.evaluate(() => !!document.activeElement?.closest('.mwrap')));

  // ---- the reading list is the finding's own evidence
  await page.click('.opening .dtxt .ref .rb'); await page.waitForSelector('#doc-close', { state: 'attached' }); await page.waitForSelector('.docpanel .page:not(.ph-page)');
  const bar = await page.evaluate(() => ({ name: document.querySelector('.docnav .docnm').textContent, loc: document.querySelector('.docnav .loc').textContent, cnt: document.querySelector('.docnav .cnt')?.textContent }));
  say('opens-the-source-of-the-sentence-clicked', bar.name + ' · ' + bar.loc === f.sources[0] && bar.cnt === 'Citation 1 of 2', JSON.stringify(bar));
  await page.click('#doc-menu'); await page.waitForSelector('.docmenu');
  const list0 = await page.evaluate(() => ({ rows: [...document.querySelectorAll('.docmenu .dm-r')].map((r) => [r.querySelector('.docnm').textContent, [...r.querySelectorAll('.dm-p')].map((p) => p.textContent).join(), r.classList.contains('on')]), heads: [...document.querySelectorAll('.docmenu .dm-h')].map((h) => h.textContent) }));
  say('list-is-the-findings-sources-no-headings', list0.rows.length === 2 && list0.heads.length === 0 && list0.rows[0][2] && !list0.rows[1][2] && list0.rows.map((r) => r[0] + ' · ' + r[1]).join('|') === f.sources.join('|'), JSON.stringify(list0));
  await page.mouse.move(640, 80); await page.waitForTimeout(250); await shot(page, 'list-finding-light', ['.docmenu', '.docnav']);
  await page.keyboard.press('Escape');
  say('escape-closes-the-list-not-the-document', !(await page.$('.docmenu')) && !!(await page.$('#doc-close')) && (await page.evaluate(() => document.activeElement?.id)) === 'doc-menu');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.docpanel'));

  // ---- a follow-up answer cites other documents: they open on their own and do not join the list
  await page.evaluate(([dealId, fid]) => { const other = Object.values(store.get().findings).find((x) => x.id !== fid && x.sources.some((s) => /\.xlsx$/.test(s.doc))); const now = new Date().toISOString(); store.setThread(`f:${dealId}:${fid}`, [{ id: 'm1', role: 'me', text: 'What does the model assume for the lock-up test?', state: 'done', at: now }, { id: 'm2', role: 'ai', text: 'The base case tests it at the higher ratio.', sources: [other.sources.find((s) => /\.xlsx$/.test(s.doc))], state: 'done', at: now }]); }, [id, f.id]);
  await page.waitForSelector('.msgs .ai .ref .rb'); await page.click('.msgs .ai .ref .rb'); await page.waitForSelector('.docpanel .sheet');
  const aside = await page.evaluate(() => ({ name: document.querySelector('.docnav .docnm').textContent, cnt: document.querySelector('.docnav .cnt')?.textContent ?? null, prevOff: document.getElementById('doc-prev').disabled, ui: [store.get().ui.doc, !!store.get().ui.docAside] }));
  say('answer-citation-opens-on-its-own', aside.name === 'Financial model.xlsx' && aside.cnt === null && !aside.prevOff && aside.ui[0] === null && aside.ui[1], JSON.stringify(aside));
  await page.click('#doc-menu'); await page.waitForSelector('.docmenu');
  const list1 = await page.evaluate(() => ({ heads: [...document.querySelectorAll('.docmenu .dm-h')].map((h) => h.textContent), rows: [...document.querySelectorAll('.docmenu .dm-r')].map((r) => [r.querySelector('.docnm').textContent, r.classList.contains('on')]) }));
  say('list-shows-it-apart-under-the-question-asked', list1.heads.join('|') === 'The finding|What does the model assume for the lock-up test?' && list1.rows.length === 3 && list1.rows[2][0] === 'Financial model.xlsx' && list1.rows[2][1] && !list1.rows[0][1], JSON.stringify(list1));
  await page.mouse.move(640, 80); await page.waitForTimeout(250); await shot(page, 'list-aside-light', ['.docmenu', '.docnav']);
  await page.keyboard.press('Escape'); await page.click('#doc-next'); await page.waitForFunction(() => store.get().ui.doc === 0 && !store.get().ui.docAside);
  say('arrows-step-back-into-the-findings-sources', (await page.textContent('.docnav .cnt')) === 'Citation 1 of 2');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.docpanel'));
  say('no-page-errors-1', page.errors.length === 0, JSON.stringify(page.errors));

  // ---- drafts: questions the findings bear on get a draft; an unrelated one honestly does not
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  await page.evaluate(async (dealId) => { const cmd = store.commandNamed('ImportQuestions'); const row = (text) => ({ n: null, text, askedBy: 'Lender', received: '', workstream: '', priority: '', response: '', respondedBy: '', responded: '', status: '' }); await store.dispatch(cmd, { dealId, mode: 'append', rows: ['What lock-up ratio applies to distributions?', 'How much capacity is contracted under the revenue contract?', 'Which operating assumption does the technical advisor support?', 'Who is the company secretary?'].map(row) }, { quiet: true }); }, id);
  await page.waitForSelector('.md .li'); await page.click('#qa-draftall'); await page.click('#qa-draftall');
  await page.waitForFunction(() => { const qs = Object.values(store.get().questions); return qs.length === 4 && qs.every((q) => q.draft && q.draft.status !== 'pending') && !store.get().ui.batch; }, null, { timeout: 20000 });
  const drafts = await page.evaluate(() => Object.values(store.get().questions).sort((a, b) => a.n - b.n).map((q) => [q.draft.status, q.draft.sources.length]));
  say('draft-all-finds-what-the-findings-support', drafts.slice(0, 3).every(([st, n]) => st === 'found' && n >= 1) && drafts[3][0] === 'none', JSON.stringify(drafts));
  await ctx.close(); }

// ---- regressions
{ const { ctx, page, id } = await start('light');
  // a number in brackets that is not a citation stays exactly as typed
  await page.click('#f-new'); await page.waitForSelector('.card.addf');
  const fields = await page.evaluate(() => [...document.querySelectorAll('.card.addf input, .card.addf textarea, .card.addf select')].map((e) => [e.tagName, e.id, e.getAttribute('aria-label') || e.getAttribute('placeholder')]));
  await page.fill('.card.addf input', 'Amount check'); const sel = await page.$('.card.addf select'); if (sel) await sel.selectOption({ index: 1 });
  const ta = await page.$('.card.addf textarea'); if (ta) await ta.fill('See clause [4] of the SFA and Schedule [12]; the amount is [100] m.');
  await page.click('#af-create'); await page.waitForFunction(() => Object.values(store.get().findings).some((f) => f.title === 'Amount check'));
  const fid = await page.evaluate(() => Object.values(store.get().findings).find((f) => f.title === 'Amount check').id);
  await page.goto(`${URL}#finding-${id}-${fid}`); await page.waitForSelector('.opening');
  const shown = await page.evaluate(() => document.querySelector('.opening .dtxt')?.innerText ?? '');
  say('bracketed-numbers-stay-as-typed', shown.includes('See clause [4] of the SFA and Schedule [12]; the amount is [100] m.'), JSON.stringify({ shown, fields }));
  // with a menu open the arrow keys do not step to another finding
  const before = await page.evaluate(() => location.hash);
  await page.focus('#f-status'); await page.keyboard.press('Enter'); await page.waitForSelector('.stmenu'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowUp'); await page.waitForTimeout(300);
  say('arrows-with-a-menu-open-stay-put', (await page.evaluate(() => location.hash)) === before && !!(await page.$('.stmenu')));
  await page.keyboard.press('Escape');
  // a deal name typed with a space after it is created, opened and indexed
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask'); await page.click('#new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', 'Munson '); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create');
  await page.waitForFunction(() => /^#deal-/.test(location.hash) && Object.values(store.get().deals).some((d) => d.name === 'Project Munson' && location.hash === '#deal-' + d.id), null, { timeout: 5000 }).catch(() => {});
  const made = await page.evaluate(() => { const d = Object.values(store.get().deals).find((x) => x.name === 'Project Munson'); return d && { here: location.hash === '#deal-' + d.id, dialog: !!document.querySelector('#nd-name') }; });
  // progress under way is shown from state.indexing; the deal record is written only when indexing finishes
  await page.waitForFunction(() => { const d = Object.values(store.get().deals).find((x) => x.name === 'Project Munson'); return d && (store.get().indexing[d.id]?.folders ?? d.folders).some((f) => f.indexed > 0); }, null, { timeout: 15000 }).catch(() => {});
  const indexing = await page.evaluate(() => { const d = Object.values(store.get().deals).find((x) => x.name === 'Project Munson'); return d && (store.get().indexing[d.id]?.folders ?? d.folders).map((f) => f.indexed); });
  say('deal-name-with-a-trailing-space', !!made && made.here && !made.dialog && indexing?.[0] > 0 && page.errors.length === 0, JSON.stringify({ made, indexing, errors: page.errors }));
  // deleting a deal raises no error
  const errsBefore = page.errors.length + page.console.length;
  const munson = await page.evaluate(async () => {
    const d = Object.values(store.get().deals).find((x) => x.name === 'Project Munson');
    const ask = { dealId: d.id, text: 'Who holds the land rights?' };
    await store.dispatch(store.commandNamed('CreateQuestion'), ask, { quiet: true }); return d.id;
  });
  await openDelete(page);
  await page.fill('#dd-name', 'Project Munson');
  await page.click('#dd-next');
  await page.waitForSelector('#dd-keep');
  await page.click('#dd-go');
  await page.waitForFunction(() => location.hash === '#deals');
  await page.waitForTimeout(300);
  say('deleting-a-deal-raises-no-error', page.errors.length + page.console.length === errsBefore && !(await page.$('#dd-name')), JSON.stringify({ errors: page.errors, console: page.console }));
  // the deletion is final: what was filed under the deal has gone at once, the notice says so and offers nothing, and Ctrl Z brings nothing back
  // kept: whether anything filed under it still reads back
  const gone = await page.evaluate(async (id) => {
    const t = [...document.querySelectorAll('.toast')].find((x) => /deleted/.test(x.textContent));
    const r = await store.services.repo.list('question', id);
    return {
      text: t?.querySelector('.ttext')?.textContent, undo: !!t?.querySelector('.tundo'),
      listed: !!store.get().deals[id],
      rail: [...document.querySelectorAll('.rail a')].some((a) => /Munson/.test(a.textContent)),
      kept: !r.ok || r.value.length > 0,
    };
  }, munson);
  await page.keyboard.press('Control+z'); await page.waitForTimeout(400);
  const after = await page.evaluate((id) => !!store.get().deals[id], munson);
  say('a-deleted-deal-is-gone-for-good', gone.text === 'Project Munson deleted' && !gone.undo && !gone.listed && !gone.rail && !gone.kept && !after && page.errors.length + page.console.length === errsBefore, JSON.stringify({ gone, after, errors: page.errors }));
  await ctx.close(); }

// ---- dates are the person's calendar date (a North American evening is still today)
{ const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, timezoneId: 'America/Los_Angeles' }); const page = await ctx.newPage();
  await page.clock.install({ time: new Date('2026-11-10T02:07:00Z') });          // 6:07 pm on Nov 9 in Los Angeles
  await page.goto(URL); await page.waitForSelector('#fr-new'); await page.click('#fr-new'); await page.fill('#nd-name', 'Evening'); await page.click('#nd-create'); await page.clock.runFor(2000); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  // a deal with no folders is not a dead end: it offers Add folders
  await page.click('#add-first-folder'); const offered = !!(await page.waitForSelector('#nd-browse', { timeout: 3000 }).catch(() => null)); await page.keyboard.press('Escape');
  say('a-deal-with-no-folders-offers-add-folders', offered);
  const made = page.evaluate((dealId) => store.dispatch(store.commandNamed('CreateFinding'), { dealId, title: 'Raised this evening', workstream: 'Legal' }), id); await page.clock.runFor(2000); await made;
  await page.waitForFunction(() => Object.values(store.get().findings).length === 1); const fid = await page.evaluate(() => Object.values(store.get().findings)[0].id);
  await page.goto(`${URL}#finding-${id}-${fid}`); await page.clock.runFor(1500); await page.waitForSelector('.opening'); await page.click('#f-review'); await page.clock.runFor(1500);
  await page.waitForFunction(() => /reviewed by/.test(document.querySelector('.fmeta > span')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  const txt = await page.evaluate(() => ({ meta: document.querySelector('.fmeta')?.textContent, review: /reviewed by [^·]+/.exec(document.querySelector('.fmeta > span')?.textContent || '')?.[0] ?? '' }));
  say('evening-dates-are-today-not-tomorrow', /Nov 9/.test(txt.meta) && !/Nov 10/.test(txt.meta) && /Nov 9/.test(txt.review) && !/Nov 10/.test(txt.review), JSON.stringify(txt));
  await ctx.close(); }

// ---- asking across deals: an answer with citations, and a citation opens the right deal's document
for (const scheme of ['light', 'dark']) { const { ctx, page, id } = await start(scheme, 'Proseware');
  await page.click('#new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', 'Wingtip'); await page.click('#nd-paste'); await page.fill('#nd-path', 'vdr export'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 40000 });
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask'); await page.fill('#hask', 'What needs my attention across the deals?'); await page.press('#hask', 'Enter');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed)', { timeout: 10000 });
  const ans = await page.evaluate(() => { const m = Object.entries(store.get().threads).find(([k]) => k.startsWith('all:'))[1].at(-1); return { text: m.text, n: (m.sources || []).length, deals: (m.sources || []).map((s) => s.dealId), linked: !!document.querySelector('.msgs .ai .ref .rb') }; });
  say(`${scheme}:across-deals-answers-with-citations`, /6 open findings across 2 deals/.test(ans.text) && ans.n === 2 && ans.deals.every(Boolean) && ans.linked, JSON.stringify(ans));
  await page.click('.msgs .ai .ref .rb'); await page.waitForSelector('#doc-close', { state: 'attached', timeout: 5000 }).catch(() => {}); await page.waitForSelector('.docpanel .page:not(.ph-page), .docpanel .sheet', { timeout: 8000 }).catch(() => {});
  const rd = await page.evaluate(() => ({ open: !!document.querySelector('.docpanel'), err: !!document.getElementById('doc-error'), name: document.querySelector('.docnav .docnm')?.textContent, reading: document.body.classList.contains('reading') }));
  say(`${scheme}:across-deals-citation-opens`, rd.open && !rd.err && !!rd.name && rd.reading, JSON.stringify(rd));
  await page.click('#doc-menu'); await page.waitForSelector('.docmenu');
  const heads = await page.evaluate(() => [...document.querySelectorAll('.docmenu .dm-h')].map((h) => h.textContent));
  say(`${scheme}:deal-conversations-are-grouped-by-question`, heads.join() === 'What needs my attention across the deals?', heads.join());
  await page.mouse.move(640, 80); await page.waitForTimeout(250); await shot(page, `list-chat-${scheme}`, ['.docmenu', '.docnav']);
  if (scheme === 'dark') { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); const f = await page.evaluate(() => { const x = Object.values(store.get().findings)[0]; return [x.dealId, x.id]; }); await page.goto(`${URL}#finding-${f[0]}-${f[1]}`); await page.waitForSelector('.opening .dtxt .ref .rb'); await page.click('.opening .dtxt .ref .rb'); await page.waitForSelector('.docpanel .page:not(.ph-page), .docpanel .sheet'); await page.click('#doc-menu'); await page.waitForSelector('.docmenu'); await page.mouse.move(640, 80); await page.waitForTimeout(250); await shot(page, 'list-finding-dark', ['.docmenu', '.docnav']); }
  say(`${scheme}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
