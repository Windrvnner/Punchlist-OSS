import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
async function fresh() { const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(URL); await page.waitForSelector('#fr-new'); return { ctx, page }; }
async function dealWithQuestions(page, texts) {
  // a deal with documents: a draft is only ever found in what the first pass read
  await page.click('#fr-new'); await page.fill('#nd-name', 'Draft QA'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  const ids = [];
  for (const t of texts) { await page.evaluate(() => { window.__prevQ = store.get().ui.selectedQuestion; }); await page.click('#qa-add'); await page.waitForFunction(() => { const q = store.get().ui.selectedQuestion; return !!q && q !== window.__prevQ && !document.querySelector('.det[inert]') && !!document.querySelector('.det textarea.qtext'); }); await page.fill('.det textarea.qtext', t); await page.press('.det textarea.qtext', 'Tab'); await questionSaved(page, t); ids.push(await page.evaluate(() => store.get().ui.selectedQuestion)); }
  return { id, ids };
}
/** Waits until the selected question holds exactly `text` in the store: the save has landed (#101). */
async function questionSaved(page, text) {
  await page.waitForFunction((expected) => {
    const state = store.get();
    return state.questions[state.ui.selectedQuestion]?.text === expected;
  }, text);
}
// what the response label says about the draft (design G: the draft's state sits beside "Response")
const word = (page) => page.evaluate(() => document.querySelector('.qpanel .qright .qlbl .sub')?.textContent || '');

// 1 draft → pending → accept → provenance shown; undo
{ const { ctx, page } = await fresh();
  const { ids } = await dealWithQuestions(page, ['Please confirm the distribution lock-up test.']);
  await page.click('#q-draft'); await page.waitForSelector('.draft.pending');
  const pendingWord = await word(page);
  await page.waitForSelector('.draft:not(.pending) .dtext', { timeout: 5000 });
  const ready = await word(page);
  // no Draft column: a ready draft shows in its row's Response cell after the AI mark, named in the tooltip
  const cell = await page.evaluate((id) => { const c = document.querySelector(`.md .li[data-q="${id}"] .rs`); return { draft: c.hasAttribute('data-draft'), ai: c.querySelector('.aim')?.textContent, text: c.textContent, tip: c.title, dr: c.classList.contains('dr'), heads: document.querySelector('.md .lh').textContent }; }, ids[0]);
  say('ready-draft-in-the-response-cell-with-the-ai-mark', cell.draft && cell.ai === 'AI' && cell.dr
    && cell.text.length > 20 && cell.tip === 'Draft from the documents' && !/Draft$/.test(cell.heads),
    JSON.stringify(cell));
  // with the Response column switched off in More, the row's tooltip still says a draft is waiting
  await page.evaluate(() => store.setPrefs({ hideCols: { ...store.get().prefs.hideCols, response: true } })); await page.waitForTimeout(200);
  const off = await page.evaluate((id) => { const r = document.querySelector(`.md .li[data-q="${id}"]`); return { tip: r.title, desc: r.getAttribute('aria-description'), cell: !!r.querySelector('.rs') }; }, ids[0]);
  await page.evaluate(() => store.setPrefs({ hideCols: { ...store.get().prefs.hideCols, response: false } })); await page.waitForTimeout(200);
  say('with-response-off-the-row-tooltip-names-the-waiting-draft', !off.cell && off.tip === 'Draft from the documents'
    && off.desc === off.tip, JSON.stringify(off));
  // a draft that answers the question is used as its response: one button, the question is answered
  const btns = await page.evaluate(() => [...document.querySelectorAll('.qpanel .racts button')].map((b) => b.textContent).join('|'));
  await page.click('.qpanel .racts button:has-text("Use as response")'); await page.waitForTimeout(500);
  const q = await page.evaluate((id) => store.get().questions[id], ids[0]);
  const lbl = await page.evaluate(() => [...document.querySelectorAll('.qpanel .qlbl')].map((x) => x.textContent).join(' | '));
  const used = await page.evaluate((id) => !document.querySelector(`.md .li[data-q="${id}"] .rs`).hasAttribute('data-draft'), ids[0]);
  say('a-used-draft-is-the-response-no-longer-marked', used);
  say('draft-used-as-response', btns === 'Use as Response|Discard' && pendingWord === 'Drafting from the documents'
    && ready === 'Draft Response' && q.status === 'answered' && q.provenance?.origin === 'ai'
      && !('internal' in q.provenance) && /drafted by AI/i.test(lbl) && !/internally/.test(lbl),
      JSON.stringify({ btns, pendingWord, ready, st: q.status, lbl }));
  await page.click('#toast .tundo'); await page.waitForTimeout(500);
  const q2 = await page.evaluate((id) => store.get().questions[id], ids[0]);
  say('draft-take-undo', q2.status === 'open' && q2.response === '' && q2.draft?.status === 'found');
  await ctx.close(); }

// 2 stale draft after editing the question
{ const { ctx, page } = await fresh();
  await dealWithQuestions(page, ['Please provide the executed capacity agreement.']);
  await page.click('#q-draft'); await page.waitForSelector('.draft:not(.pending) .dtext', { timeout: 5000 });
  await page.fill('.det textarea.qtext', 'Please confirm the tax indemnity cap and governing limitation period.'); await page.press('.det textarea.qtext', 'Tab'); await page.waitForTimeout(700);
  const stale = await page.evaluate(() => ({ cls: !!document.querySelector('.draft.stale'),
    accept: [...document.querySelectorAll('.qpanel .racts button')].some((b) => /Use as Response/.test(b.textContent)),
    again: [...document.querySelectorAll('.qpanel .racts button')].some((b) => b.textContent === 'Draft Again'),
    word: document.querySelector('.qpanel .qright .qlbl .sub')?.textContent }));
  say('stale-draft', stale.cls && !stale.accept && stale.again && stale.word === 'Drafted for the previous wording', JSON.stringify(stale));
  await page.click('.qpanel .racts button:has-text("Draft again")'); await page.waitForSelector('.draft.pending'); await page.waitForSelector('.draft:not(.pending)', { timeout: 5000 });
  const redrafted = await page.evaluate(() => !document.querySelector('.draft.stale'));
  say('redraft-clears-stale', redrafted);
  await ctx.close(); }

// #174: reload with one request still in flight, leaving that draft available to retry.
{ const { ctx, page } = await fresh();
  const texts = Array.from({ length: 10 }, (_, i) => `Please confirm item ${i + 1} of the distribution lock-up test.`);
  const { ids: [heldId] } = await dealWithQuestions(page, texts);
  await page.evaluate((id) => {
    const ai = store.services.ai;
    const draft = ai.draft.bind(ai);
    ai.draft = (input) => input.questionId === id ? new Promise(() => {}) : draft(input);
  }, heldId);
  await page.click('#qa-draftall');
  const confirm = await page.textContent('#qa-draftall');
  await page.click('#qa-draftall');
  await page.waitForFunction((id) => store.get().questions[id]?.draft?.status === 'pending', heldId);
  const progress = await page.textContent('#qa-draftall');
  await page.reload();
  await page.waitForFunction((id) => window.store?.get().questions[id]?.draft?.status === 'failed', heldId);
  const started = /confirm/.test(confirm) && /Drafting \d+ of 10/.test(progress);
  say('draft-all-confirm-progress', started, JSON.stringify({ confirm, progress }));
  say('reload-mid-batch-recovers-failed-draft', true);
  await ctx.close(); }

{ const { ctx, page } = await fresh();
  const { ids: [id] } = await dealWithQuestions(page, ['Please confirm the distribution lock-up test.']);
  await page.evaluate(() => { window.__fail = { draft: true }; });
  await page.click('#q-draft');
  await page.waitForFunction((id) => store.get().questions[id].draft?.status === 'failed', id);
  await page.evaluate(() => { window.__fail = {}; });
  await page.locator('.qpanel .racts').getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction((id) => store.get().questions[id].draft?.status === 'found', id);
  say('failed-retry', true);
  await ctx.close(); }

// 4 stop halts the batch
{ const { ctx, page } = await fresh();
  const texts = Array.from({ length: 12 }, (_, i) => `Please confirm point ${i + 1}.`);
  await dealWithQuestions(page, texts);
  await page.click('#qa-draftall'); await page.click('#qa-draftall'); await page.waitForTimeout(150); await page.click('#qa-draftall'); // Stop
  await page.waitForFunction(() => !store.get().ui.batch, null, { timeout: 8000 });
  const requested = await page.evaluate(() => Object.values(store.get().questions).filter((q) => q.draft).length);
  say('draft-all-stop', requested < 12 && requested >= 4, 'requested=' + requested);
  say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

{
  const { ctx, page } = await fresh();
  const dealId = await page.evaluate(async () => {
    await store.dispatch(store.commandNamed('CreateDeal'), { name: 'Draft warning', folders: [] }, { quiet: true });
    const id = Object.keys(store.get().deals)[0];
    for (const text of ['Question one?', 'Question two?', 'Question three?']) {
      await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: id, text }, { quiet: true });
    }
    store.services.ai.draft = async () => ({
      ok: false, error: { kind: 'failed', message: 'Drafting service failed' },
    });
    return id;
  });
  await page.goto(URL + '#qa-' + dealId);
  await page.click('#qa-draftall');
  await page.click('#qa-draftall');
  await page.waitForFunction(() => document.querySelector('#toast .ttext')?.textContent === '0 drafted · 3 failed');
  const icon = await page.locator('#toast .tg path').first().getAttribute('d');
  say('draft-all-failures-show-a-warning-1369', /^M10\.3 4\.2/.test(icon), icon);
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
