// Reported bugs that need a real screen, each scenario set up in this app.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
async function start(name = 'Datum') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: 'dark' }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  return { ctx, page, id: await page.evaluate(() => Object.values(store.get().deals)[0].id) };
}

{ // a finding with no sources must not break later answers about the deal.
  // Mockup: "Add as finding" on an answer without sources made a finding whose missing source crashed the next deal answer.
  const { ctx, page, id } = await start();
  const made = await page.evaluate(async (d) => { const r = await store.dispatch(store.commandNamed('CreateFinding'), { dealId: d, title: 'Raised by hand, with nothing cited', workstream: 'Legal', body: ['No document is cited for this.'] }); return r.ok && Object.values(store.get().findings).find((f) => f.title.startsWith('Raised by hand')); }, id);
  await page.goto(URL + '#deal-' + id); await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 4);
  const listed = await page.evaluate(() => [...document.querySelectorAll('.flagrow')].some((r) => /Raised by hand/.test(r.textContent)));
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('#pask'); await page.fill('#pask', 'What are the three biggest issues?'); await page.press('#pask', 'Enter');
  await page.waitForSelector('.msgs .ai:not(.pending)', { timeout: 15000 }); await page.waitForTimeout(300);
  const answer = await page.evaluate(() => { const a = document.querySelector('.msgs .ai'); return { failed: a.classList.contains('failed'), text: a.textContent.length, boot: document.body.classList.contains('booting') }; });
  await page.goto(URL + `#finding-${id}-${made.id}`); await page.waitForSelector('.opening .qtxt'); const opened = await page.textContent('.opening .qtxt');
  say('a finding with no sources does not break the deal’s answers or its own page', made && made.sources.length === 0 && listed && !answer.failed && answer.text > 20 && !answer.boot && /Raised by hand/.test(opened) && page.errors.length === 0, JSON.stringify({ answer, errors: page.errors }));
  await ctx.close();
}

{ // opened while the backend cannot be reached, partway through indexing. Once the app has started, indexing
  // picks up where it stopped and the first pass follows, with no reload (it stayed at "Indexing · 0 of n" with no Resume).
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await ctx.addInitScript(() => { if (sessionStorage.getItem('downOnce')) { sessionStorage.removeItem('downOnce'); window.__down = true; } });
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  await page.waitForFunction(() => { const d = Object.values(store.get().deals)[0]; const f = d && store.get().indexing[d.id]?.folders[0]; return f && f.indexed > 0 && f.indexed < f.files; }, null, { timeout: 15000 });
  await page.evaluate(() => sessionStorage.setItem('downOnce', '1')); await page.reload(); await page.waitForSelector('.netbar', { timeout: 8000 });
  const offline = await page.evaluate(() => store.get().boot.stage);
  await page.evaluate(() => { window.__down = false; }); await page.click('.netbar .tundo');
  await page.waitForFunction(() => store.get().boot.stage === 'ready', null, { timeout: 8000 });
  const moved = await page.waitForFunction(() => { const d = Object.values(store.get().deals)[0]; return d.stage === 'ready' || (store.get().indexing[d.id]?.folders[0].indexed ?? 0) > 0; }, null, { timeout: 15000 }).then(() => true, () => false);
  const firstPass = await page.waitForFunction(() => Object.keys(store.get().findings).length === 3 && Object.values(store.get().deals)[0].stage === 'ready', null, { timeout: 40000 }).then(() => true, () => false);
  const end = await page.evaluate(() => { const d = Object.values(store.get().deals)[0]; return { stage: d.stage, findings: Object.keys(store.get().findings).length, stalled: store.get().ui.indexStalled.includes(d.id) }; });
  say('indexing left unfinished resumes, and the first pass runs, once a start that could not connect succeeds', offline !== 'ready' && moved && firstPass && !end.stalled && page.errors.length === 0, JSON.stringify({ offline, moved, firstPass, end, errors: page.errors }));
  await ctx.close();
}

{ // a question deleted while the shared folder cannot be written stays, the app says the delete did not happen
  // and offers Retry (the offline bar's Retry only reconnects); once the folder is back, that Retry deletes it.
  const { ctx, page, id } = await start('Coho');
  const q = await page.evaluate(async (d) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Please confirm the lock-up ratio.', workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), q); await page.waitForSelector('.qpanel [aria-label="Delete question"]');
  await page.evaluate(() => { const f = store.services.repo.shared; window.__append = f.append; f.append = () => { throw new Error('The network path was not found'); }; });
  await page.click('.qpanel [aria-label="Delete question"]'); await page.click('#ask-go');
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /Couldn’t save/.test(t.textContent)), null, { timeout: 5000 }).catch(() => {});
  const failed = await page.evaluate((q) => ({ still: !!store.get().questions[q], bar: !!document.querySelector('.netbar'), toasts: [...document.querySelectorAll('.toast')].map((t) => `${t.querySelector('.ttext').textContent}|${t.querySelector('.tundo')?.textContent ?? ''}`) }), q);
  await page.evaluate(() => { store.services.repo.shared.append = window.__append; });
  const retry = page.locator('.toast', { hasText: 'Couldn’t save' }).locator('.tundo');
  if (await retry.count()) await retry.click();
  const gone = await page.waitForFunction((q) => !store.get().questions[q], q, { timeout: 5000 }).then(() => true, () => false);
  say('a delete that could not be saved says so, with a Retry that deletes it once the folder is back', failed.still && failed.bar && failed.toasts.includes('Couldn’t save ·|Retry') && gone && page.errors.length === 0, JSON.stringify({ failed, gone, errors: page.errors }));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
