// A response typed, saved or not, is never hidden or written over by an AI draft, on a deal of 2,000 questions.
// "Draft from documents" is offered with part of a response typed, and the draft keeps those words; the draft goes under
// the box, so both are in sight; "Use as response" asks before it replaces the text, and Undo puts the text back; Draft all
// leaves a question whose typed text is not saved alone (decisions.md, Q&A).
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const N = 2000;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
await page.goto(URL + '#'); await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
const dealId = await page.evaluate(async (N) => {
  const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
  await run('CreateDeal', { name: 'Proseware', folders: [] }); const dealId = Object.values(store.get().deals).find((d) => d.name.endsWith('Proseware')).id;
  // two questions in three have a response; the rest are open and can be drafted
  const rows = Array.from({ length: N }, (_, k) => ({ line: k + 2, n: k + 1, text: `Question ${k + 1}: please confirm the lock-up ratio for item ${(k * 7919) % 10007}.`, response: k % 3 ? `Answer ${k + 1}` : '', askedBy: 'Lender A', received: '', workstream: '', priority: 'High', respondedBy: '', responded: '', status: '' }));
  await run('ImportQuestions', { dealId, mode: 'append', rows }); store.ui({ toasts: [] }); return dealId;
}, N);
const qid = (n) => page.evaluate((n) => Object.values(store.get().questions).find((q) => q.n === n).id, n);
const open = async (id) => { await page.evaluate((id) => store.ui({ selectedQuestion: id }), id); await page.waitForFunction((id) => store.get().ui.selectedQuestion === id && !!document.querySelector('.qpanel [aria-label="Response"], .qpanel .draft'), id); await page.waitForTimeout(150); };
const panel = () => page.evaluate(() => ({ draftBtn: !!document.querySelector('#q-draft'),
  box: document.querySelector('.qpanel [aria-label="Response"]')?.value ?? null,
  draftShown: !!document.querySelector('.qpanel .draft'),
  under: !!document.querySelector('.qpanel .qstack.stacked .draft'),
  inBox: document.activeElement?.getAttribute('aria-label') === 'Response',
  notSaved: /Not saved/.test(document.querySelector('.qpanel .qright')?.textContent ?? ''),
  use: [...document.querySelectorAll('.qpanel .racts button')].some((b) => /Use as Response/.test(b.textContent)) }));
// the browser's storage refuses every write of a change to a question, as in the issue
const refuse = () => page.evaluate(() => { window.__realSet ??= Storage.prototype.setItem; const set = window.__realSet; Storage.prototype.setItem = function (k, v) { if (String(v).includes('"kind":"question"')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return set.call(this, k, v); }; });
const allow = () => page.evaluate(() => { if (window.__realSet) Storage.prototype.setItem = window.__realSet; });

await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('.md .li'); await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' } }));
const a = await qid(1), b = await qid(4), c = await qid(7);
const typed = 'The sponsor confirms 1.25x, per the signed term sheet';

{ // "Draft from documents" stays while the box holds text, so part of an answer can be drafted on
  await open(c); const before = await panel();
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type('Th', { delay: 0 }); const typing = await panel();
  await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.waitForTimeout(800); const cleared = await panel();
  say('Draft from Documents is offered with the box empty or holding text', before.draftBtn && typing.draftBtn
    && cleared.draftBtn && cleared.box === '', JSON.stringify({ before, typing, cleared }));
}

{ // the issue's steps: the save fails, and Draft from documents is not offered beside the text that is not saved
  await open(a); await refuse();
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type(typed, { delay: 0 }); await page.locator('.qpanel .qlbl').first().click(); await page.waitForTimeout(900);
  const p = await panel();
  say('Draft from Documents is still offered beside a response that could not be saved', p.box === typed
    && p.notSaved && p.draftBtn, JSON.stringify(p));
  // stepping away and back (the field goes and comes back with its kept text) does not bring the button back either
  await open(b); await open(a); const back = await panel();
  say('the kept text comes back, marked not saved', back.box === typed && back.notSaved && back.draftBtn, JSON.stringify(back));
}

{ // Draft all leaves the question with text not saved alone, and counts it out
  await allow(); await open(b);
  const eligible = await page.evaluate(() => Object.values(store.get().questions).filter((q) => q.status === 'open' && !q.response.trim() && q.text.trim() && !q.draft).length);
  await page.click('#qa-draftall'); const label = await page.textContent('#qa-draftall');
  await page.click('#qa-draftall'); await page.waitForFunction(() => !!store.get().ui.batch); const total = await page.evaluate(() => store.get().ui.batch.total);
  await page.click('#qa-draftall');   // Stop
  await page.waitForFunction(() => !store.get().ui.batch, null, { timeout: 30000 });
  const qa = await page.evaluate((a) => store.get().questions[a], a);
  say('Draft All skips a question whose typed response is not saved', total === eligible - 1
    && label.includes(String(eligible - 1)) && !qa.draft && qa.response === '',
    JSON.stringify({ eligible, total, label, draft: qa.draft ?? null }));
}

{ // a draft that reaches the question anyway (asked for on another PC) goes under the typed text: neither is lost
  await page.evaluate(([d, q]) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: d, questionId: q }, { quiet: true }), [dealId, a]);
  await page.waitForFunction((a) => ['found', 'none'].includes(store.get().questions[a].draft?.status), a, { timeout: 8000 });
  await open(a); const p = await panel();
  say('a draft from elsewhere goes under text that is not saved, never in front of it', p.box === typed && p.notSaved && p.under, JSON.stringify(p));
  const row = await page.evaluate((a) => document.querySelector(`.md .li[data-q="${a}"] .rs`)?.hasAttribute('data-draft') ?? null, a);
  say('its row still shows the draft is waiting, so it is never out of sight', row === (await page.evaluate((a) => store.get().questions[a].draft?.status === 'found', a)), JSON.stringify({ row }));
  // Retry saves the typed text; the draft never wrote over it
  await page.click('.qpanel .efstate.fail'); await page.waitForTimeout(900);
  const q = await page.evaluate((a) => store.get().questions[a], a);
  say('Retry saves the typed text as the response', q.response === typed && !(await panel()).notSaved, JSON.stringify({ response: q.response }));
}

{ // a draft asked for elsewhere while the person is typing, before the save, never takes the box from under the typing
  const d = await qid(1999); await open(d);   // far down the list, so the Draft all above did not reach it
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type('The lock-up ', { delay: 0 });
  await page.evaluate(([dl, q]) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: dl, questionId: q }, { quiet: true }), [dealId, d]);
  await page.waitForTimeout(100); await page.keyboard.type('is 1.25x', { delay: 0 }); await page.waitForTimeout(2500);
  const p = await panel(); const q = await page.evaluate((d) => store.get().questions[d], d);
  say('typing goes on in the box while a draft from elsewhere arrives, and is saved', p.box === 'The lock-up is 1.25x' && p.inBox && q.response === 'The lock-up is 1.25x', JSON.stringify({ p, response: q.response, draft: q.draft?.status ?? null }));
}

{ // emptying the box to write it again, with a draft waiting behind it, keeps the box and the keys typed next
  const e = await qid(1996); await open(e);
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type('First try', { delay: 0 });
  await page.evaluate(([dl, q]) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: dl, questionId: q }, { quiet: true }), [dealId, e]);
  await page.waitForFunction((e) => ['found', 'none'].includes(store.get().questions[e].draft?.status), e, { timeout: 8000 });
  await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); await page.waitForTimeout(200);
  await page.keyboard.type('Rewritten answer', { delay: 0 }); await page.waitForTimeout(1500);
  const p = await panel(); const q = await page.evaluate((e) => store.get().questions[e], e);
  say('emptying the box with a draft waiting keeps the box and what is typed next', p.box === 'Rewritten answer' && p.inBox && q.response === 'Rewritten answer' && q.status === 'open', JSON.stringify({ p, response: q.response, status: q.status }));
}

{ // ... and leaving the emptied box (Tab, then Space) shows the draft but never puts the focus on its buttons
  // (with no response saved: a draft under a saved response is in sight, and Tab reaching its buttons is ordinary)
  const e = await qid(1993); await open(e);
  await page.focus('.qpanel [aria-label="Response"]');
  await page.evaluate(([dl, q]) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: dl, questionId: q }, { quiet: true }), [dealId, e]);
  await page.waitForFunction((e) => ['found', 'none'].includes(store.get().questions[e].draft?.status), e, { timeout: 8000 });
  await page.keyboard.type('First', { delay: 0 }); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); await page.keyboard.press('Tab'); await page.waitForTimeout(200);
  const active = await page.evaluate(() => (document.activeElement?.tagName === 'BUTTON' ? document.activeElement.textContent : document.activeElement?.className ?? '')); await page.keyboard.press('Space'); await page.waitForTimeout(800);
  const p = await panel(); const q = await page.evaluate((e) => store.get().questions[e], e);
  say('leaving the emptied box shows the draft, and the next key does not take or discard it', p.box === null
    && p.draftShown && !!q.draft && q.response === '' && q.status === 'open' && !/Use as Response|Discard/.test(active),
    JSON.stringify({ p, active, draft: q.draft?.status ?? null, status: q.status }));
}

{ // what the box said on one visit to a question does not carry over to the next
  const g = await qid(1984), withDraft = await qid(1993);
  await open(g); await page.focus('.qpanel [aria-label="Response"]');
  await open(withDraft);   // a question showing a draft, so no box says anything here
  await page.evaluate(([dl, q]) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: dl, questionId: q }, { quiet: true }), [dealId, g]);
  await page.waitForFunction((g) => ['found', 'none'].includes(store.get().questions[g].draft?.status), g, { timeout: 8000 });
  await open(g); const p = await panel();
  say('a draft that arrived while away shows on coming back', p.draftShown && p.box === null, JSON.stringify(p));
}

{ // clicking into the empty box and then pressing Draft from documents still shows the draft being written
  const f = await qid(1987); await open(f);
  await page.focus('.qpanel [aria-label="Response"]'); await page.click('#q-draft'); await page.waitForTimeout(200);
  const p = await panel();
  say('Draft from Documents after clicking into the empty box shows the draft', p.draftShown && p.box === null,
    JSON.stringify(p));
}

{ // with the typed text cleared away, the waiting draft is shown again
  await page.evaluate(([d, q]) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: d, questionId: q }, { quiet: true }), [dealId, c]);
  await page.waitForFunction((c) => ['found', 'none'].includes(store.get().questions[c].draft?.status), c, { timeout: 8000 });
  await open(c); const p = await panel();
  say('a draft with no typed text in its way still takes the response place', p.draftShown && p.box === null, JSON.stringify(p));
}

// the stand-in model finds this finding for every question here, so a draft is found and its words can be checked
await page.evaluate((d) => store.dispatch(store.commandNamed('CreateFinding'), { dealId: d, title: 'Distribution lock-up', workstream: 'Legal', body: ['Distributions are blocked below a lock-up of 1.25x, tested semi-annually.'], sources: [{ doc: 'Credit agreement.pdf', loc: 'p. 142', docId: 'doc_fa' }] }, { quiet: true }), dealId);
const h = await qid(1981); const start = 'The sponsor confirms';
const shown = (id) => page.evaluate((id) => store.get().questions[id], id);

{ // part of an answer typed and saved: the draft, from the documents alone, goes under the box
  await open(h); await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type(start, { delay: 0 }); await page.waitForTimeout(900);
  await page.click('#q-draft');
  await page.waitForFunction((h) => ['found', 'none', 'failed'].includes(store.get().questions[h].draft?.status), h, { timeout: 8000 }); await page.waitForTimeout(150);
  const p = await panel(); const q = await shown(h);
  say('a draft asked for over typed words shows under the box, and leaves them be', q.draft?.status === 'found' && q.draft.text.startsWith('The documents bear on this') && q.response === start && p.box === start && p.under, JSON.stringify({ p, draft: q.draft, response: q.response }));
  const row = await page.evaluate((h) => { const r = document.querySelector(`.md .li[data-q="${h}"] .rs`); return r && { draft: r.hasAttribute('data-draft'), mark: !!r.querySelector('.aim'), text: r.textContent, title: r.getAttribute('title') }; }, h);
  say('its row keeps the person\'s own words, without the AI mark, and the draft on hover', !!row && row.draft && !row.mark && row.text === start && row.title.includes(q.draft.text), JSON.stringify(row));
}

{ // Use as response asks first, and leaving the question unasked changes nothing
  await page.click('.qpanel .qlbl2 button:has-text("Use as response")'); await page.waitForTimeout(100);
  const asked = await page.evaluate(() => ({ focus: document.activeElement?.id, text: document.querySelector('#q-use-confirm')?.textContent }));
  await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  const after = { confirm: await page.locator('#q-use-confirm').count(), response: (await shown(h)).response, open: await page.evaluate(() => !!document.querySelector('.qpanel')) };
  say('Use as Response over typed text asks first, and Escape takes the ask back', asked.focus === 'q-use-confirm'
    && /Replace Your Text/.test(asked.text) && after.confirm === 0 && after.response === start && after.open,
    JSON.stringify({ asked, after }));
}

{ // confirmed, the draft replaces the text; Undo brings the text and the draft back
  const draft = (await shown(h)).draft.text;
  await page.click('.qpanel .qlbl2 button:has-text("Use as response")'); await page.click('#q-use-confirm'); await page.waitForTimeout(400);
  const used = await shown(h); const toast = await page.textContent('#toast');
  const usedMark = await page.evaluate((h) => !!document.querySelector(`.md .li[data-q="${h}"] .rs .aim`), h);
  await page.click('#toast button:has-text("Undo")'); await page.waitForTimeout(500);
  const back = await shown(h); const p = await panel();
  say('confirmed, the draft is the response; Undo puts the typed words and the draft back', used.response === draft && used.status === 'answered' && /replaced/.test(toast) && usedMark && back.response === start && back.status === 'open' && back.draft?.status === 'found' && p.box === start && p.under, JSON.stringify({ used: used.response, toast, back: back.response, p }));
}

{ // text that cannot be saved is never replaced: the draft waits, and the text stays
  await refuse();
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.press('End'); await page.keyboard.type(' 1.25x', { delay: 0 });
  await page.click('.qpanel .qlbl2 button:has-text("Use as response")'); await page.click('#q-use-confirm'); await page.waitForTimeout(600);
  const q = await shown(h); const p = await panel(); const toast = await page.evaluate(() => document.querySelector('#toast')?.textContent ?? '');
  say('Use as Response over text that cannot be saved changes nothing, and says so', q.response === start
    && q.draft?.status === 'found' && p.box === start + ' 1.25x' && p.under && /couldn’t be saved/.test(toast),
    JSON.stringify({ response: q.response, p, toast }));
  await allow();
}

{ // a coworker's change that synced in while the person typed is never written over by Use as response
  const k = await qid(1978); await open(k);
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type('Base', { delay: 0 }); await page.waitForTimeout(900);
  await page.click('#q-draft'); await page.waitForFunction((k) => store.get().questions[k].draft?.status === 'found', k, { timeout: 8000 });
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.press('End'); await page.keyboard.type(' mine', { delay: 0 });
  await page.evaluate((k) => __peer.change(k, { response: 'Coworker answer' }, { by: 'jdoe', from: 'PC B' }), k); await page.waitForTimeout(900);
  await page.click('.qpanel .qlbl2 button:has-text("Use as response")'); await page.click('#q-use-confirm'); await page.waitForTimeout(600);
  const q = await shown(k); const p = await panel(); const toast = await page.evaluate(() => document.querySelector('#toast')?.textContent ?? '');
  say('Use as Response never writes over a change made elsewhere meanwhile', q.response === 'Coworker answer'
    && q.draft?.status === 'found' && p.box === 'Base mine' && /changed elsewhere/.test(toast),
    JSON.stringify({ response: q.response, p, toast }));
}

{ // a change made elsewhere and put back while the person typed is caught by the box, and Use as response respects it
  const k = await qid(1972); await open(k);
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type('Base', { delay: 0 }); await page.waitForTimeout(900);
  await page.click('#q-draft'); await page.waitForFunction((k) => store.get().questions[k].draft?.status === 'found', k, { timeout: 8000 });
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.press('End'); await page.keyboard.type(' mine', { delay: 0 });
  await page.evaluate((k) => { __peer.change(k, { response: 'Coworker answer' }, { by: 'jdoe', from: 'PC B' }); __peer.change(k, { response: 'Base' }, { by: 'jdoe', from: 'PC B' }); }, k); await page.waitForTimeout(900);
  const asks = await page.evaluate(() => /Changed elsewhere/.test(document.querySelector('.qpanel .qright')?.textContent ?? ''));
  await page.click('.qpanel .qlbl2 button:has-text("Use as response")'); await page.click('#q-use-confirm'); await page.waitForTimeout(600);
  const q = await shown(k); const p = await panel(); const toast = await page.evaluate(() => document.querySelector('#toast')?.textContent ?? '');
  say('a change put back elsewhere is not written over by Use as Response', !asks
    || (q.response === 'Base' && q.draft?.status === 'found' && p.box === 'Base mine'
    && /changed elsewhere/.test(toast)), JSON.stringify({ asks, response: q.response, p, toast }));
}

{ // a coworker's change that syncs in while the confirm is waiting takes the ask back, and is never replaced
  const k = await qid(1969); await open(k);
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type('Base', { delay: 0 }); await page.waitForTimeout(900);
  await page.click('#q-draft'); await page.waitForFunction((k) => store.get().questions[k].draft?.status === 'found', k, { timeout: 8000 });
  await page.click('.qpanel .qlbl2 button:has-text("Use as response")'); await page.waitForSelector('#q-use-confirm');
  await page.evaluate((k) => __peer.change(k, { response: 'Coworker answer' }, { by: 'jdoe', from: 'PC B' }), k); await page.waitForTimeout(600);
  const still = await page.locator('#q-use-confirm').count();
  if (still) { await page.click('#q-use-confirm'); await page.waitForTimeout(600); }
  const q = await shown(k);
  say('a coworker\'s answer that syncs in while the confirm waits is never replaced', q.response === 'Coworker answer' && q.draft?.status === 'found', JSON.stringify({ still, response: q.response, status: q.status }));
}

{ // an open question with a response keeps who responded and when, with Draft from documents beside them
  const m = await qid(1977); await open(m);
  const p = await page.evaluate(() => ({ by: !!document.querySelector('.qpanel [aria-label="Responded by"]'), date: !!document.querySelector('.qpanel [aria-label="Date"]'), draft: !!document.querySelector('#q-draft') }));
  say('responded by and the date stay on an open question with a response', p.by && p.date && p.draft, JSON.stringify(p));
}

{ // a draft held back while the empty box has the focus still shows on the label line
  const n = await qid(1975); await open(n); await page.focus('.qpanel [aria-label="Response"]');
  await page.evaluate(([dl, q]) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: dl, questionId: q }, { quiet: true }), [dealId, n]);
  await page.waitForFunction((n) => ['found', 'none'].includes(store.get().questions[n].draft?.status), n, { timeout: 8000 }); await page.waitForTimeout(150);
  const p = await page.evaluate(() => ({ sub: document.querySelector('.qpanel .qright .qlbl .sub')?.textContent ?? '', inBox: document.activeElement?.getAttribute('aria-label') === 'Response', draft: !!document.querySelector('.qpanel .draft') }));
  const st = (await shown(n)).draft.status;
  say('a draft waiting behind the focused empty box is named on the label line', p.inBox && !p.draft
    && (st === 'none' || p.sub === 'Draft Response'), JSON.stringify({ p, st }));
}

say('no page errors', !page.errors.length, JSON.stringify(page.errors));
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
