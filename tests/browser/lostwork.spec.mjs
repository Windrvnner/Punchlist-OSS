// Work a person typed must never be thrown away. One check per reported lost-work item,
// each named by its issue number.
import { launchChrome } from './chrome.mjs';
import { openRename } from './dealMenu.mjs';
import { openOnFindings } from './landing.mjs';
import { checkChecklistPasteReload } from './pendingImports.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  return { ctx, page };
}

async function dealOnFindings(page, name = 'Proseware') {
  await page.click('#fr-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  return page.evaluate(() => Object.values(store.get().deals)[0].id);
}

{ // Escape or the × on the New deal dialog keeps what was typed for the next time it opens; Cancel discards it
  const { ctx, page } = await open();
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'C:\\Deals\\Proseware');
  await page.keyboard.press('Escape'); await page.waitForSelector('#nd-name', { state: 'detached' });
  await page.click('#fr-new'); await page.waitForSelector('#nd-name');
  const back = await page.evaluate(() => ({ name: document.querySelector('#nd-name').value, path: document.querySelector('#nd-path')?.value }));
  // the × dismisses as Escape does (no Cancel button), so it keeps what was typed too
  await page.click('#nd-x'); await page.waitForSelector('#nd-name', { state: 'detached' }); await page.click('#fr-new'); await page.waitForSelector('#nd-name');
  const again = await page.evaluate(() => document.querySelector('#nd-name').value);
  say('a dismissed New Deal comes back as it was left, by Escape or the ×', back.name === 'Proseware'
    && back.path === 'C:\\Deals\\Proseware' && again === 'Proseware' && !page.errors.length,
    JSON.stringify({ back, again, errors: page.errors }));
  await ctx.close();
}

{ // a path typed but not yet added is part of the deal on Create, not silently dropped
  const { ctx, page } = await open();
  await page.click('#fr-new'); await page.fill('#nd-name', 'Coho'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports');
  await page.click('#nd-create'); await page.waitForFunction(() => /^#(overview|deal)-d_/.test(location.hash), null, { timeout: 15000 }).catch(() => {});
  const folders = await page.evaluate(() => Object.values(store.get().deals).find((d) => d.name.endsWith('Coho'))?.folders.map((f) => f.path) ?? null);
  say('a typed but un-added folder path goes into the deal on Create', JSON.stringify(folders) === '["reports"]' && !page.errors.length, JSON.stringify({ folders, errors: page.errors }));
  await ctx.close();
}

{ // #35: a path typed while the first one is still being read stays in the field when the first scan finishes
  const { ctx, page } = await open();
  await page.click('#fr-new');
  await page.fill('#nd-name', 'Coho');
  await page.click('#nd-paste');
  await page.evaluate(() => {
    const scan = store.services.docs.scanFolder.bind(store.services.docs);
    store.services.docs.scanFolder = async (...args) => {
      await new Promise((resume) => { window.resumeScan = resume; });
      return scan(...args);
    };
  });
  await page.fill('#nd-path', 'reports');
  await page.click('#nd-addpath');
  await page.waitForFunction(() => typeof window.resumeScan === 'function');
  await page.fill('#nd-path', 'C:\\Deals\\Coho\\Second folder');
  await page.evaluate(() => window.resumeScan());
  await page.waitForSelector('.ndrow');
  const typed = await page.inputValue('#nd-path');
  const rows = await page.locator('.ndrow').count();
  say('#35 a path typed during a scan is kept', typed === 'C:\\Deals\\Coho\\Second folder' && rows === 1
    && !page.errors.length, JSON.stringify({ typed, rows, errors: page.errors }));
  // the path that was added, left unchanged, is still cleared once it is on the list
  await page.evaluate(() => { window.resumeScan = null; });
  await page.fill('#nd-path', 'models');
  await page.click('#nd-addpath');
  await page.waitForFunction(() => typeof window.resumeScan === 'function');
  await page.evaluate(() => window.resumeScan());
  await page.waitForFunction(() => document.querySelectorAll('.ndrow').length === 2);
  const cleared = await page.inputValue('#nd-path');
  say('#35 an added path is still cleared', cleared === '' && !page.errors.length, JSON.stringify({ cleared }));
  await ctx.close();
}

{ // a half-typed question in the Checklist pane survives moving to another item, closing the pane and Escape; Cancel clears it
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow');
  await page.click('#ck-rows .ckrow >> nth=0'); await page.click('#ck-ask'); await page.fill('#ck-ask-text', 'Please send the signed lock-up waiver');
  await page.click('#ck-rows .ckrow >> nth=1'); await page.waitForTimeout(150); await page.click('#ck-rows .ckrow >> nth=0'); await page.waitForTimeout(150);
  const afterMove = await page.evaluate(() => document.querySelector('#ck-ask-text')?.value ?? null);
  await page.focus('#ck-ask-text'); await page.keyboard.press('Escape'); await page.waitForTimeout(100); await page.click('#ck-ask'); await page.waitForTimeout(100);
  const afterEscape = await page.evaluate(() => document.querySelector('#ck-ask-text')?.value ?? null);
  await page.click('#ck-ask-cancel'); await page.click('#ck-ask'); const afterCancel = await page.evaluate(() => document.querySelector('#ck-ask-text')?.value ?? null);
  say(
    'a half-typed Checklist question is kept until it is logged or canceled',
    afterMove === 'Please send the signed lock-up waiver' &&
      afterEscape === afterMove &&
      afterCancel === '' &&
      !page.errors.length,
    JSON.stringify({ afterMove, afterEscape, afterCancel, errors: page.errors }),
  );
  await ctx.close();
}

{ // a start-up that fails for a reason other than the network says so and offers Retry, instead of loading for ever
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await ctx.addInitScript(() => { window.__fail = { startFails: true }; });
  await page.goto(URL); await page.waitForSelector('#boot-retry', { timeout: 8000 }).catch(() => {});
  const shown = await page.evaluate(() => ({ text: document.querySelector('#boot-error')?.textContent ?? null, booting: document.body.classList.contains('booting') }));
  await page.evaluate(() => { window.__fail = {}; }); await page.click('#boot-retry').catch(() => {}); await page.waitForSelector('#fr-new', { timeout: 8000 }).catch(() => {});
  const started = await page.evaluate(() => !!document.querySelector('#fr-new'));
  say('a failed start says why and Retry starts the app', /could not be read/.test(shown.text ?? '') && started && !page.errors.length, JSON.stringify({ shown, started, errors: page.errors }));
  await ctx.close();
}

{ // nobody signed in at start-up shows on the start screen with Retry, not the offline bar
  const { ctx, page } = await open();
  await ctx.addInitScript(() => { window.__fail = { signedOut: true }; });
  await page.goto(URL); await page.waitForSelector('#boot-retry', { timeout: 8000 }).catch(() => {});
  const shown = await page.evaluate(() => ({ text: document.querySelector('#boot-error')?.textContent ?? null, offline: !!document.querySelector('.netbar') }));
  await page.evaluate(() => { window.__fail = {}; }); await page.click('#boot-retry').catch(() => {}); await page.waitForSelector('#fr-new', { timeout: 8000 }).catch(() => {});
  const started = await page.evaluate(() => !!document.querySelector('#fr-new'));
  say('nobody signed in says so on the start screen, and Retry starts the app', /^Nobody is signed in\. Retry$/.test(shown.text ?? '') && !shown.offline && started && !page.errors.length, JSON.stringify({ shown, started, errors: page.errors }));
  await ctx.close();
}

{ // text typed in a response just before another PC's change to the same question arrives is not wiped
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  await page.evaluate(() => __peer.sync({ self: { id: 'pc1', label: 'PC A' }, peers: [{ id: 'pc2', label: 'PC B', by: 'jdoe', lastChangeAt: '2026-11-09T23:14:00.000Z' }] }));
  const q = await page.evaluate(async (d) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Please confirm the lock-up ratio.', workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li, .qt tr, #qa-add');
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), q); await page.waitForSelector('.qpanel textarea.rtext, .qpanel [aria-label="Response"]');
  const typed = 'The sponsor confirms 1.25x, per the signed term sheet';
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type(typed, { delay: 0 });
  await page.evaluate((q) => __peer.edit(q, { priority: 'Low' }, { by: 'jdoe', from: 'PC B', at: '2026-11-09T23:14:00.000Z' }), q);   // before the half-second save
  await page.waitForTimeout(1500);
  const clash = await page.evaluate(() => !!document.querySelector('#conflict'));
  if (clash) { await page.click('#conflict .cfl-v >> nth=0'); await page.click('#conflict .cfl-keep').catch(() => {}); await page.waitForSelector('#conflict', { state: 'detached', timeout: 5000 }).catch(() => {}); await page.waitForTimeout(400); }
  const where = await page.evaluate((t) => ({ field: [...document.querySelectorAll('.qpanel textarea')].find((e) => e.value.includes(t))?.value ?? null, notSaved: /Not saved|Changed elsewhere/.test(document.querySelector('.qpanel')?.textContent ?? ''), saved: Object.values(store.get().questions).some((x) => x.response.includes(t)) }), typed);
  say('typing is never wiped by another PC\'s change to the same record', clash && ((where.field === typed && where.notSaved) || where.saved) && !page.errors.length, JSON.stringify({ clash, where, errors: page.errors }));
  await ctx.close();
}

{ // a response that could not be saved stays, marked, when another question is opened and when another PC changes it
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  const mk = (t) => page.evaluate(async ([d, t]) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, [id, t]);
  const q1 = await mk('Please confirm the lock-up ratio.'); const q2 = await mk('Provide the budget.');
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await page.evaluate((q) => store.ui({ selectedQuestion: q }), q1); await page.waitForSelector('.qpanel [aria-label="Response"]');
  // the browser's storage refuses every write of a change to a question while the person types
  await page.evaluate(() => { const set = Storage.prototype.setItem; window.__realSet = set; Storage.prototype.setItem = function (k, v) { if (String(v).includes('"kind":"question"')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return set.call(this, k, v); }; });
  const typed = 'Confirmed at 1.25x by the sponsor';
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type(typed); await page.click('.qpanel .qlbl, .qpanel h3, body', { position: { x: 5, y: 5 } }).catch(() => {}); await page.waitForTimeout(900);
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), q2); await page.waitForTimeout(300); await page.evaluate((q) => store.ui({ selectedQuestion: q }), q1); await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({ text: document.querySelector('.qpanel [aria-label="Response"]')?.value ?? null, mark: /Not saved/.test(document.querySelector('.qpanel')?.textContent ?? '') }));
  await page.evaluate(() => { Storage.prototype.setItem = window.__realSet; });
  say('unsaved response text survives opening another question', back.text === typed && back.mark && !page.errors.length, JSON.stringify({ back, errors: page.errors }));
  await ctx.close();
}

{ // a rename box or a half-typed counterparty never carries over to the deal Back goes to
  const { ctx, page } = await open(); const a = await dealOnFindings(page, 'Trey');
  await page.click('#fr-new, #new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', 'Datum'); await page.click('#nd-create'); await page.waitForFunction(() => Object.values(store.get().deals).length === 2);
  const b = await page.evaluate(() => Object.values(store.get().deals).find((d) => d.name.endsWith('Datum')).id);
  await page.goto(URL + '#overview-' + a);
  await page.waitForSelector('#deal-more');
  await page.goto(URL + '#overview-' + b);
  await page.waitForSelector('#deal-more');
  await openRename(page);
  await page.fill('#deal-name', 'Renamed by mistake');
  await page.goBack(); await page.waitForFunction((a) => location.hash.endsWith(a), a); await page.waitForTimeout(300);
  const boxOnA = await page.evaluate(() => !!document.querySelector('#deal-name')); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  const names = await page.evaluate(() => Object.values(store.get().deals).map((d) => d.name).sort());
  say('a rename box does not survive Back and rename the other deal', !boxOnA && !names.some((n) => n.includes('Renamed by mistake')) && names.includes('Project Trey'), JSON.stringify({ boxOnA, names }));
  await page.goto(URL + '#overview-' + b); await page.waitForSelector('[aria-label="Counterparty"]');
  await page.focus('[aria-label="Counterparty"]'); await page.keyboard.type('Datum Sponsor LLC');
  await page.goBack(); await page.waitForFunction((a) => location.hash.endsWith(a), a); await page.waitForTimeout(200); await page.keyboard.press('Enter'); await page.waitForTimeout(900);
  const cp = await page.evaluate(([a, b]) => ({ a: store.get().deals[a].counterparty, b: store.get().deals[b].counterparty, fieldOnA: document.querySelector('[aria-label="Counterparty"]')?.value }), [a, b]);
  say('a counterparty typed on one deal is saved there and never lands on the deal Back goes to', cp.a === '' && cp.b === 'Datum Sponsor LLC' && cp.fieldOnA === '' && !page.errors.length, JSON.stringify({ cp, errors: page.errors }));
  await ctx.close();
}

{ // Down on a finding page never moves away from an open edit, so the edit is not thrown away
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  await page.click('.flagrow >> nth=0'); await page.waitForSelector('#f-edit'); const first = await page.evaluate(() => location.hash);
  await page.click('#f-edit'); await page.fill('#fe-title', 'A title I am still writing'); await page.focus('#fe-save'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ hash: location.hash, title: document.querySelector('#fe-title')?.value ?? null }));
  say('Down does not leave a finding with an edit open', after.hash === first && after.title === 'A title I am still writing' && !page.errors.length, JSON.stringify({ first, after, errors: page.errors }));
  void id; await ctx.close();
}

{ // an open edit and a half-typed closing note stay with their finding when another finding is opened
  const { ctx, page } = await open(); await dealOnFindings(page);
  await page.click('.flagrow >> nth=1'); await page.waitForSelector('#f-edit'); const second = await page.evaluate(() => location.hash);
  await page.goBack(); await page.click('.flagrow >> nth=0'); await page.waitForSelector('#f-edit'); const first = await page.evaluate(() => location.hash);
  await page.click('#f-edit');
  await page.fill('#fe-title', 'A title I am still writing');
  await page.fill('#fe-body', 'Ask for the step-in letter');
  await page.goto(URL + second); await page.waitForSelector('#f-edit');
  await page.click('#f-status'); await page.click('.stmenu .mi:not(.on)'); await page.fill('#fnote-text', 'Settled on the call');
  const away = await page.evaluate(() => ({ editOpen: !!document.querySelector('#fe-title') }));
  await page.goto(URL + first); await page.waitForSelector('#fe-title');
  const edit = await page.evaluate(() => ({
    title: document.querySelector('#fe-title').value,
    body: document.querySelector('#fe-body').innerText.trim(),
    note: !!document.querySelector('#fnote-text'),
  }));
  await page.goto(URL + second); await page.waitForSelector('#fnote-text');
  const note = await page.evaluate(() => document.querySelector('#fnote-text').value);
  await page.keyboard.press('Escape'); await page.click('#f-status'); await page.click('.stmenu .mi:not(.on)'); await page.waitForSelector('#fnote-text');
  const afterEsc = await page.evaluate(() => document.querySelector('#fnote-text').value);
  await page.click('.fnote .btn:not(.pri)'); await page.click('#f-status'); await page.click('.stmenu .mi:not(.on)'); await page.waitForSelector('#fnote-text');
  const afterCancel = await page.evaluate(() => document.querySelector('#fnote-text').value);
  await page.goto(URL + first); await page.waitForSelector('#fe-cancel'); await page.click('#fe-cancel'); await page.click('#f-edit');
  // #fe-body is the cited editor, an editable box, so its text is innerText, not a value
  const fresh = await page.evaluate(() => document.querySelector('#fe-body').innerText.trim());
  const editKept = edit.title === 'A title I am still writing' && edit.body === 'Ask for the step-in letter';
  const editCleared = fresh !== 'Ask for the step-in letter';
  say('an open finding edit is kept on opening another finding; Cancel clears it',
    !away.editOpen && editKept && !edit.note && editCleared && !page.errors.length, JSON.stringify({ away, edit, fresh,
      errors: page.errors }));
  say('a half-typed closing note is kept on opening another finding and on Escape; Cancel clears it', note === 'Settled on the call' && afterEsc === 'Settled on the call' && afterCancel === '' && !page.errors.length, JSON.stringify({ note, afterEsc, afterCancel, errors: page.errors }));
  await ctx.close();
}

{ // a half-written new finding survives changing tab and coming back; Cancel clears it
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  await page.click('#f-new'); await page.fill('#af-title', 'Step-in rights are thin'); await page.fill('#af-body', 'Only 30 days to step in.');
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await page.goBack(); await page.waitForSelector('.flagrow');
  const back = await page.evaluate(() => ({ title: document.querySelector('#af-title')?.value ?? null, body: document.querySelector('#af-body')?.value ?? null }));
  await page.click('#af-cancel'); await page.click('#f-new'); const fresh = await page.evaluate(() => document.querySelector('#af-title')?.value ?? null);
  say(
    'a half-written new finding is kept across tabs until created or canceled',
    back.title === 'Step-in rights are thin' &&
      back.body === 'Only 30 days to step in.' &&
      fresh === '' &&
      !page.errors.length,
    JSON.stringify({ back, fresh, errors: page.errors }),
  );
  await ctx.close();
}

{ // a delete that is slow to save does not move the person off the question they opened meanwhile, nor drop their typing
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  const qs = []; for (const t of ['One?', 'Two?', 'Three?', 'Four?', 'Five?']) qs.push(await page.evaluate(async ([d, t]) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, [id, t]));
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), qs[1]); await page.waitForSelector('.qpanel [aria-label="Delete question"]');
  await page.evaluate(() => { const repo = store.services.repo; const t = repo.transaction.bind(repo); repo.transaction = async (x) => { if (window.__slow) await new Promise((r) => setTimeout(r, 1500)); return t(x); }; window.__slow = true; });
  await page.click('.qpanel [aria-label="Delete question"]'); await page.click('#ask-go');
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), qs[4]); await page.waitForSelector('.qpanel [aria-label="Response"]');
  await page.evaluate(() => { window.__slow = false; });
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type('Typed while the delete was saving', { delay: 60 });
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({ on: store.get().ui.selectedQuestion, field: document.querySelector('.qpanel [aria-label="Response"]')?.value ?? null }));
  say('a slow delete leaves the newly opened question and its typing alone', after.on === qs[4] && after.field === 'Typed while the delete was saving' && !page.errors.length, JSON.stringify({ after, want: qs[4], errors: page.errors }));
  await ctx.close();
}

{ // the response box fills its column in the question panel (it shrank to one line when the field was wrapped for Draft all)
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  const q = await page.evaluate(async (d) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Please confirm the lock-up ratio.', workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, id);
  await page.evaluate(([d, q]) => store.dispatch(store.commandNamed('SetResponse'), { dealId: d, questionId: q, response: Array.from({ length: 12 }, (_, i) => `Line ${i + 1} of a long response.`).join('\n') }), [id, q]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await page.evaluate((q) => store.ui({ selectedQuestion: q }), q); await page.waitForSelector('.qpanel [aria-label="Response"]'); await page.waitForTimeout(300);
  const h = await page.evaluate(() => Math.round(document.querySelector('.qpanel [aria-label="Response"]').getBoundingClientRect().height));
  say('the response box in the question panel is not squeezed to one line', h > 150 && !page.errors.length, JSON.stringify({ height: h, errors: page.errors }));
  await ctx.close();
}

{ // what was typed in a form that is not a record yet comes back after the app is closed and opened again (a reload here)
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  const restart = async (sel) => { await page.reload(); await page.waitForSelector(sel); await page.waitForTimeout(300); };
  // a new finding
  await page.click('#f-new'); await page.fill('#af-title', 'Step-in period is short'); await page.fill('#af-body', 'Only 30 days to step in.');
  await restart('.flagrow');
  const made = await page.evaluate(() => [document.querySelector('#af-title')?.value, document.querySelector('#af-body')?.value]);
  say('a half-written new finding comes back after a restart', made[0] === 'Step-in period is short' && made[1] === 'Only 30 days to step in.', JSON.stringify(made));
  await page.click('#af-cancel');
  // a finding's edit, and its closing note
  await page.click('.flagrow >> nth=0'); await page.waitForSelector('#f-edit'); await page.click('#f-edit'); await page.fill('#fe-title', 'A title I am still writing');
  await restart('#f-edit');
  const edit = await page.evaluate(() => document.querySelector('#fe-title')?.value);
  await page.click('#fe-cancel');
  await page.click('#f-status'); await page.click('.stmenu .mi:has-text("Closed")'); await page.fill('#fnote-text', 'Confirmed with counsel');
  await restart('#f-edit');
  const note = await page.evaluate(() => document.querySelector('#fnote-text')?.value);
  say('a finding edit and a closing note come back after a restart', edit === 'A title I am still writing' && note === 'Confirmed with counsel', JSON.stringify({ edit, note }));
  // a question asked from the Checklist
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow'); await page.click('#ck-rows .ckrow >> nth=0'); await page.click('#ck-ask'); await page.fill('#ck-ask-text', 'Which lock-up ratio was agreed?');
  await restart('#ck-rows .ckrow'); if (!(await page.$('#ck-ask-text'))) await page.click('#ck-rows .ckrow >> nth=0');   // the item, opened again if the page did not keep it open
  await page.waitForSelector('#ck-ask-text', { timeout: 3000 }).catch(() => {});
  const asked = await page.evaluate(() => document.querySelector('#ck-ask-text')?.value);
  say('a half-typed Checklist question comes back after a restart', asked === 'Which lock-up ratio was agreed?', JSON.stringify(asked));
  // the ask box on a deal's page, and the composer under a conversation
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist'); await page.fill('.askbox textarea', 'What does the lock-up test?');
  await restart('#ov-checklist');
  const ask = await page.inputValue('.askbox textarea');
  say('the ask box keeps its text after a restart', ask === 'What does the lock-up test?', JSON.stringify(ask));
  say('no page errors', !page.errors.length, JSON.stringify(page.errors));
  // a crash gives no page-hide: what was typed a moment before is kept all the same
  await page.fill('.askbox textarea', 'Typed just before a crash'); await page.waitForTimeout(800);
  const cdp = await ctx.newCDPSession(page); void cdp.send('Page.crash').catch(() => {}); await page.waitForEvent('crash', { timeout: 5000 }).catch(() => {});   // the call itself never answers: the page is gone
  const again = await ctx.newPage(); await again.goto(URL + '#overview-' + id); await again.waitForSelector('#ov-checklist'); await again.waitForTimeout(300);
  const crashed = await again.inputValue('.askbox textarea');
  say('a crash keeps what was typed', crashed === 'Typed just before a crash', JSON.stringify(crashed));
  await ctx.close();
}

{ // #60: files attached on Home and on a deal and not yet sent come back after a restart, and go with the message
  const { ctx, page } = await open();
  const id = await dealOnFindings(page);
  const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: Buffer.from('%PDF stand-in') });
  await page.goto(URL + '#deals');
  await page.waitForSelector('#homeask #p-attach');
  await page.fill('#homeask textarea', 'What do the board minutes approve?');
  await page.setInputFiles('#homeask input[type=file]', pdf('Board minutes.pdf'));
  await page.waitForSelector('#homeask .chip.att:not(.pending)');
  await page.goto(URL + '#overview-' + id);
  await page.waitForSelector('#ov-checklist');
  await page.fill('.askbox textarea', 'Please review the attached renewal schedule for its outstanding covenants.');
  await page.setInputFiles('.askbox input[type=file]', pdf('Renewal schedule.pdf'));
  await page.waitForSelector('.askbox .chip.att:not(.pending)');
  await page.waitForTimeout(800);                       // past the kept drafts' save delay, with no page-hide
  const cdp = await ctx.newCDPSession(page);
  void cdp.send('Page.crash').catch(() => {});                      // the call itself never answers: the page is gone
  await page.waitForEvent('crash', { timeout: 5000 }).catch(() => {});
  const again = await ctx.newPage();
  again.errors = [];
  again.on('pageerror', (e) => again.errors.push(e.message));
  const chips = async (box) => {
    await again.waitForSelector(box + ' .chip.att', { timeout: 5000 }).catch(() => {});
    return again.evaluate((sel) => [...document.querySelectorAll(sel)].map((c) => c.textContent), box + ' .chip.att');
  };
  await again.goto(URL + '#overview-' + id);
  await again.waitForSelector('#ov-checklist');
  const onDeal = await chips('.askbox');
  await again.goto(URL + '#deals');
  await again.waitForSelector('#homeask');
  const onHome = await chips('#homeask');
  await again.press('#homeask textarea', 'Enter');
  const sentWith = await chips('.msgs .matt');
  const back = onDeal.join() === 'Renewal schedule.pdf' && onHome.join() === 'Board minutes.pdf';
  say('#60 unsent attachments come back after a restart, on a deal and on Home', back,
    JSON.stringify({ onDeal, onHome }));
  const sent = sentWith.join() === 'Board minutes.pdf' && !again.errors.length;
  say('#60 a restored attachment goes with its message', sent, JSON.stringify({ sentWith, errors: again.errors }));
  await ctx.close();
}

{ // the Q&A import is kept on this PC as it was left. Escape, the ×, a reload or "change" lose nothing: opening it
  // again picks it up, the column choices included. Only "start over", which asks first, or the import itself lets it go
  const { ctx, page } = await open();
  await page.click('#fr-new'); await page.fill('#nd-name', 'Mapping'); await page.click('#nd-create'); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  // a deal-scale log: 2,000 questions with the usual columns
  const lines = ['Number,Question,Submitted by,Received,Workstream,Response'];
  for (let i = 1; i <= 2000; i++) lines.push(`${i},"Question ${i}: provide the schedule of lease obligations, part ${i}",Lender ${'ABCD'[i % 4]},2026-11-${String((i % 28) + 1).padStart(2, '0')},${['Legal', 'Commercial', 'Financial', 'Technical'][i % 4]},`);
  const file = { name: 'log-2000.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) };
  const openImport = async () => { await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.imdlg'); };
  await openImport(); await page.setInputFiles('#im-file', file); await page.waitForSelector('.immap');
  // the person changes the mapping by hand, and picks Append
  await page.selectOption('[data-immap="workstream"]', ''); await page.selectOption('[data-immap="askedBy"]', ''); await page.click('[data-immode="append"]');
  const state = () => page.evaluate(() => ({ map: Object.fromEntries([...document.querySelectorAll('.immap select')].map((s) => [s.dataset.immap, s.value])), mode: document.querySelector('[data-immode].on')?.dataset.immode, file: document.querySelector('.imfile')?.textContent }));
  const before = await state();
  const r = {};
  // a press on the backdrop never closes a dialog
  await page.mouse.click(8, 400); await page.waitForTimeout(200); r.outside = !!(await page.$('#im-go'));
  // Escape closes at once, asking nothing, and the import comes back as it was left
  await page.keyboard.press('Escape'); r.escCloses = await page.waitForSelector('.imdlg', { state: 'detached', timeout: 2000 }).then(() => true, () => false);
  await openImport(); await page.waitForSelector('.immap'); r.afterEsc = JSON.stringify(await state()) === JSON.stringify(before);
  await page.click('.imdlg .shead .x'); await page.waitForSelector('.imdlg', { state: 'detached' });
  await openImport(); await page.waitForSelector('.immap'); r.afterX = JSON.stringify(await state()) === JSON.stringify(before);
  say('closing the Q&A import keeps it: Escape and the × close at once, and opening it again shows the mapping as left', r.outside && r.escCloses && r.afterEsc && r.afterX && /2,000 rows/.test(before.file), JSON.stringify({ r, before }));
  // a reload straight after a change, with no pause, keeps that change too
  await page.selectOption('[data-immap="priority"]', '1'); const changed = await state();
  await page.reload(); await page.waitForSelector('#qa-add'); await openImport(); r.reloaded = await page.waitForSelector('.immap', { timeout: 5000 }).then(() => true, () => false);
  r.afterReload = r.reloaded && JSON.stringify(await state()) === JSON.stringify(changed);
  say('a reload keeps the Q&A import, the change made just before it included', r.afterReload, JSON.stringify({ changed, now: r.reloaded ? await state() : null }));
  // "change" goes back to the file, and loses nothing until another file is read in its place
  await page.click('#im-back'); await page.waitForSelector('#im-file', { state: 'attached' }); await page.keyboard.press('Escape'); await page.waitForSelector('.imdlg', { state: 'detached' });
  await openImport(); r.afterChange = await page.waitForSelector('.immap', { timeout: 2000 }).then(async () => JSON.stringify(await state()) === JSON.stringify(changed), () => false);
  say('change, then closing, keeps the import as it was', r.afterChange);
  // start over asks first, in the footer; Keep going keeps everything and hands the focus back
  await page.click('#im-restart'); await page.waitForSelector('#im-restart-ask');
  await page.waitForFunction(() => document.activeElement?.textContent === 'Keep Going', null,
    { timeout: 2000 }).catch(() => {});
  r.ask = { text: await page.textContent('#im-restart-ask [role="alert"]'), go: await page.textContent('#im-restart-ask-go'), focus: await page.evaluate(() => document.activeElement?.textContent), noImport: !(await page.$('#im-go')) };
  await page.click('#im-restart-ask button:has-text("Keep going")'); await page.waitForSelector('#im-go');
  r.focusBack = await page.waitForFunction(() => document.activeElement?.id === 'im-restart', null, { timeout: 2000 }).then(() => true, () => false);
  r.keptByKeepGoing = JSON.stringify(await state()) === JSON.stringify(changed);
  say('start over asks first, and Keep Going keeps the import', r.ask.text === 'Clear this import and start over?'
    && r.ask.go === 'Start Over' && r.ask.focus === 'Keep Going' && r.ask.noImport && r.focusBack && r.keptByKeepGoing,
    JSON.stringify(r.ask));
  // Start over clears it: the file step, and it stays clear after closing and after a reload
  await page.click('#im-restart'); await page.click('#im-restart-ask-go'); r.cleared = await page.waitForSelector('#im-drop', { timeout: 2000 }).then(() => true, () => false);
  await page.keyboard.press('Escape'); await page.waitForSelector('.imdlg', { state: 'detached' }); await openImport(); r.clearOnOpen = !!(await page.$('#im-drop'));
  await page.keyboard.press('Escape'); await page.reload(); await page.waitForSelector('#qa-add'); await openImport(); await page.waitForTimeout(300); r.clearAfterReload = !!(await page.$('#im-drop'));
  say('Start over clears the import, for good', r.cleared && r.clearOnOpen && r.clearAfterReload, JSON.stringify(r));
  // an import that goes through lets go of what was kept: opening Import again starts afresh, and nothing is imported twice
  await page.setInputFiles('#im-file', file); await page.waitForSelector('.immap'); await page.click('#im-go'); await page.waitForSelector('.imdlg', { state: 'detached', timeout: 30000 });
  const n = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id);
  await openImport(); await page.waitForTimeout(300); r.freshAfterImport = !!(await page.$('#im-drop'));
  await page.keyboard.press('Escape'); await page.reload(); await page.waitForSelector('#qa-add'); await openImport(); await page.waitForTimeout(300); r.freshAfterReload = !!(await page.$('#im-drop'));
  say('an import done is not kept', n === 2000 && r.freshAfterImport && r.freshAfterReload, JSON.stringify({ n, r }));
  // each deal keeps its own import
  await page.setInputFiles('#im-file', file); await page.waitForSelector('.immap'); await page.keyboard.press('Escape'); await page.waitForSelector('.imdlg', { state: 'detached' });
  await page.evaluate(() => store.ui({ newDeal: { name: '', folders: [], error: '', busy: false } })); await page.fill('#nd-name', 'Other'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  const other = await page.evaluate((d) => Object.values(store.get().deals).find((x) => x.id !== d).id, id);
  await page.goto(URL + '#qa-' + other); await page.waitForSelector('#qa-add'); await openImport(); await page.waitForTimeout(300); r.otherFresh = !!(await page.$('#im-drop'));
  await page.keyboard.press('Escape'); await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await openImport(); r.ownKept = await page.waitForSelector('.immap', { timeout: 2000 }).then(() => true, () => false);
  say('each deal keeps its own Q&A import', r.otherFresh && r.ownKept, JSON.stringify(r));
  say('no page errors', !page.errors.length, JSON.stringify(page.errors));
  await ctx.close();
}

{ // a kept import this build cannot use opens as a new import rather than not at all; a failed import keeps
  // the check marks as they were when it failed, and they are not open to change while it runs
  const { ctx, page } = await open();
  await page.click('#fr-new'); await page.fill('#nd-name', 'Broken'); await page.click('#nd-create'); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  const title = 'Change of control definition omits the sponsor fund vehicles';
  const body = ['Change of control definition', 'Omits the sponsor fund vehicles'];
  await page.evaluate(async ({ dealId, title, body }) => {
    await store.dispatch(store.commandNamed('CreateFinding'), { dealId, title, workstream: 'Legal', body },
      { quiet: true });
  }, { dealId: id, title, body });
  // stored values of a shape this build does not read: a table with no sheets, points with no words
  await page.evaluate((d) => new Promise((done) => { const r = indexedDB.open('dil-kept-imports', 1); r.onsuccess = () => { const tx = r.result.transaction('parts', 'readwrite'); const os = tx.objectStore('parts');
    os.put({ rows: [], columns: [], bytes: new Uint8Array(1), name: 'x.csv' }, [`qa:${d}`, 'table']); os.put({ mapping: {}, mode: 'merge' }, [`qa:${d}`, 'choices']);
    os.put({ doc: { doc: 'list.pdf', docId: 'x' }, points: [{}] }, [`issues:${d}`, 'list']); os.put(new Set(), [`issues:${d}`, 'kept']); tx.oncomplete = done; }; }), id);
  await page.reload(); await page.waitForSelector('.dtabs');
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await page.click('#qa-cols'); await page.click('#qa-import');
  const qa = await page.waitForSelector('#im-drop', { timeout: 3000 }).then(() => true, () => false); await page.keyboard.press('Escape');
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('#f-more'); await page.click('#f-more');
  await page.click('#f-import');
  const il = await page.waitForSelector('#il-drop', { timeout: 3000 }).then(() => true, () => false);
  say('a kept import this build cannot use opens as a new import', qa && il && !page.errors.length, JSON.stringify({ qa, il, errors: page.errors }));
  // #171: an import compares the whole finding, including its later paragraphs.
  await page.evaluate((title) => {
    const ai = store.services.ai;
    const issuesList = ai.issuesList.bind(ai);
    ai.issuesList = (input) => {
      window.__findingTextSent = input.findings.find((finding) => finding.title === title)?.text;
      return issuesList(input);
    };
  }, title);
  const list = `Comments\n1. ${title}\n2. Fees letter is not yet agreed`;
  await page.setInputFiles('#il-file', {
    name: 'Lender counsel comments.txt', mimeType: 'text/plain', buffer: Buffer.from(list),
  });
  await page.waitForSelector('#il-raised');
  const sent = await page.evaluate(() => window.__findingTextSent);
  say('#171 an issues-list import sends every paragraph of a finding', sent === body.join('\n\n'), sent);
  // a failed import keeps the check marks as they then are, across a reload
  await page.click('#il-raised .keep input');
  await page.evaluate(() => { const was = store.dispatch.bind(store); store.dispatch = async (c, ...a) => { if (c === store.commandNamed('ImportIssuesList')) { await new Promise((r) => setTimeout(r, 800)); return { ok: false, error: { kind: 'failed', message: 'the folder could not be written' } }; } return was(c, ...a); }; });
  await page.click('#il-go'); await page.waitForSelector('#il-raised .keep input:disabled', { timeout: 2000 }).catch(() => {});
  const whileImporting = await page.evaluate(() => document.querySelector('#il-raised .keep input').disabled);
  await page.waitForFunction(() => /Couldn’t import/.test(document.querySelector('#il-line').textContent));
  await page.reload(); await page.waitForSelector('#f-more'); await page.click('#f-more');
  await page.click('#f-import'); await page.waitForSelector('#il-raised');
  const kept = await page.isChecked('#il-raised .keep input');
  say('a failed import keeps its check marks, which cannot change while it runs', whileImporting && kept, JSON.stringify({ whileImporting, kept }));
  // the Q&A import too: its columns and mode cannot change while it runs, and a failure keeps them as they were
  await page.keyboard.press('Escape'); await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('#im-drop');
  await page.setInputFiles('#im-file', { name: 'log.csv', mimeType: 'text/csv', buffer: Buffer.from('Number,Question,Workstream\n1,What is the lock-up test?,Legal\n2,Who signs the waiver?,Legal') }); await page.waitForSelector('.immap');
  await page.selectOption('[data-immap="workstream"]', ''); await page.click('[data-immode="append"]');
  await page.evaluate(() => { const was = store.dispatch.bind(store); store.dispatch = async (c, ...a) => { if (c === store.commandNamed('ImportQuestions')) { await new Promise((r) => setTimeout(r, 800)); return { ok: false, error: { kind: 'failed', message: 'the folder could not be written' } }; } return was(c, ...a); }; });
  await page.click('#im-go'); const locked = await page.evaluate(() => document.querySelector('[data-immap="workstream"]').disabled && document.querySelector('[data-immode="merge"]').disabled);
  await page.waitForFunction(() => /Couldn’t import/.test(document.querySelector('#im-line').textContent));
  await page.reload(); await page.waitForSelector('#qa-add'); await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.immap');
  const qaKept = await page.evaluate(() => ({ ws: document.querySelector('[data-immap="workstream"]').value, mode: document.querySelector('[data-immode].on')?.dataset.immode }));
  say('a failed Q&A import keeps its columns and mode, which cannot change while it runs', locked && qaKept.ws === '' && qaKept.mode === 'append', JSON.stringify({ locked, qaKept }));
  say('no page errors', !page.errors.length, JSON.stringify(page.errors));
  await ctx.close();
}

{ // a question closed while its draft is being written, here or by a coworker on another PC, still gets the draft, and Use as response keeps it Closed
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  // a question in a finding's own words, so the stand-in model finds a draft for it
  const title = await page.evaluate((d) => Object.values(store.get().findings).find((f) => f.dealId === d && f.sources.length).title, id);
  const mk = (t) => page.evaluate(async ([d, t]) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, [id, t]);
  const here = await mk(`What is the position on ${title}?`); const there = await mk(`Please explain: ${title}`);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  const run = async (q, close) => {
    await page.evaluate((q) => {
      const ai = store.services.ai;
      const draft = ai.draft;
      const held = new Promise((release) => { window.__releaseDraft = release; });
      ai.draft = async (input) => {
        ai.draft = draft;
        await held;
        return draft.call(ai, input);
      };
      store.ui({ selectedQuestion: q });
    }, q);
    await page.click('.qpanel #q-draft');
    await page.waitForFunction((q) => store.get().questions[q].draft?.status === 'pending', q);
    await close(q);
    await page.waitForFunction((q) => store.get().questions[q].status === 'closed', q);
    await page.evaluate(() => window.__releaseDraft());
    await page.waitForSelector('.qpanel button:has-text("Use as response")');
    const waiting = await page.evaluate((q) => ({ status: store.get().questions[q].status, draft: store.get().questions[q].draft?.status ?? null }), q);
    await page.click('.qpanel button:has-text("Use as response")');
    await page.waitForFunction((q) => !!store.get().questions[q].response, q);
    return { waiting, after: await page.evaluate((q) => ({ status: store.get().questions[q].status, response: store.get().questions[q].response }), q) };
  };
  const a = await run(here, async () => {
    await page.click('.qpanel #q-status, .qpanel [aria-haspopup="menu"]');
    await page.click('[role=menuitemradio]:has-text("Closed"), .mi:has-text("Closed")');
  });
  say('closed here mid-draft: the draft arrives and Use as Response keeps it Closed', a.waiting.status === 'closed'
    && a.waiting.draft === 'found' && a.after.status === 'closed'
    && /^The documents bear on this/.test(a.after.response), JSON.stringify(a));
  const b = await run(there, (q) => page.evaluate((q) => __peer.change(q, { status: 'closed' }, { by: 'jdoe', from: 'PC B' }), q));
  say('closed by a coworker on another PC mid-draft: the draft arrives and Use as Response keeps it Closed',
    b.waiting.status === 'closed' && b.waiting.draft === 'found' && b.after.status === 'closed'
    && /^The documents bear on this/.test(b.after.response), JSON.stringify(b));
  say('no page errors', !page.errors.length, JSON.stringify(page.errors));
  await ctx.close();
}

{ // a response being typed when a coworker on another PC closes the question is not thrown away
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  const q = await page.evaluate(async (d) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Please confirm the lock-up ratio.', workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add'); await page.evaluate((q) => store.ui({ selectedQuestion: q }), q); await page.waitForSelector('.qpanel [aria-label="Response"]');
  const typed = 'The sponsor confirms 1.25x, per the signed term sheet';
  await page.focus('.qpanel [aria-label="Response"]'); await page.keyboard.type(typed.slice(0, 20), { delay: 0 });
  await page.evaluate((q) => __peer.change(q, { status: 'closed' }, { by: 'jdoe', from: 'PC B' }), q);
  await page.keyboard.type(typed.slice(20), { delay: 0 }); await page.waitForTimeout(1500);
  const where = await page.evaluate((q) => ({ field: document.querySelector('.qpanel [aria-label="Response"]')?.value ?? null, status: store.get().questions[q].status, response: store.get().questions[q].response, conflict: !!store.get().conflicts[q] }), q);
  say('typing survives a coworker closing the question', where.field === typed && where.response === typed && where.status === 'closed' && !where.conflict && !page.errors.length, JSON.stringify({ where, errors: page.errors }));
  await ctx.close();
}

{ // a coworker on another PC closes the question before the pending draft has reached their PC: no second version, the draft arrives, and Use as response keeps it Closed
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  const title = await page.evaluate((d) => Object.values(store.get().findings).find((f) => f.dealId === d && f.sources.length).title, id);
  const q = await page.evaluate(async ([d, t]) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal' }); return store.get().ops[r.value.opId].targets.find((x) => x.startsWith('q_')); }, [id, `What is the position on ${title}?`]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-add');
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), q); await page.waitForSelector('.qpanel #q-draft'); await page.click('.qpanel #q-draft');
  await page.waitForFunction((q) => store.get().questions[q].draft?.status === 'pending', q);
  // made without knowledge of this PC's version: the question as it was before the draft was asked for, closed
  await page.evaluate((q) => __peer.edit(q, { status: 'closed', draft: undefined }, { by: 'jdoe', from: 'PC B' }), q);
  await page.waitForSelector('.qpanel button:has-text("Use as response")', { timeout: 8000 }).catch(() => {});
  const waiting = await page.evaluate((q) => ({ status: store.get().questions[q].status, draft: store.get().questions[q].draft?.status ?? null, conflict: !!store.get().conflicts[q] }), q);
  await page.click('.qpanel button:has-text("Use as response")').catch(() => {}); await page.waitForTimeout(400);
  const after = await page.evaluate((q) => ({ status: store.get().questions[q].status, response: store.get().questions[q].response, conflict: !!store.get().conflicts[q] }), q);
  say('a coworker\'s close crossing the pending draft: one version, the draft arrives, and Use as response keeps it Closed', !waiting.conflict && waiting.status === 'closed' && waiting.draft === 'found' && !after.conflict && after.status === 'closed' && /^The documents bear on this/.test(after.response) && !page.errors.length, JSON.stringify({ waiting, after, errors: page.errors }));
  await ctx.close();
}

{ // a date typed in part is never dropped when its field is left, nor drawn over by another PC's date; at deal scale (2,000 questions)
  const { ctx, page } = await open(); const id = await dealOnFindings(page);
  // every other question answered with a date, the others answered without one
  const rows = Array.from({ length: 2000 }, (_, i) => ({ n: null, text: `Item ${String(i + 1).padStart(4, '0')}: provide the executed agreement and all amendments.`, askedBy: 'Lamna Capital', received: '2026-10-28', workstream: 'Legal', priority: '', response: 'Uploaded to the data room, folder 2.1.', respondedBy: 'Northwind Sponsor LP', responded: i % 2 ? '' : '2026-11-02', status: 'answered' }));
  const r = await page.evaluate(([d, rows]) => store.dispatch(store.commandNamed('ImportQuestions'), { dealId: d, mode: 'append', rows }, { quiet: true }), [id, rows]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .list');
  const qOf = (n) => page.evaluate((n) => Object.values(store.get().questions).find((q) => q.n === n), n);
  const D = '.qpanel .qlbl [aria-label="Date"]';
  const at = (sel = D) => page.evaluate((sel) => { const i = document.querySelector(sel); return { v: i.value, type: i.type, inPart: i.validity.badInput, notes: [...i.closest('.efwrap').querySelectorAll('.efstate')].map((e) => e.textContent) }; }, sel);
  const open1 = async (n) => { await page.evaluate((n) => store.ui({ selectedQuestion: Object.values(store.get().questions).find((q) => q.n === n).id }), n); await page.waitForFunction((n) => document.querySelector('.qpanel .qph .n')?.textContent === 'Q' + n, n); await page.waitForTimeout(200); };
  const into = async () => { await page.focus('.qpanel .qlbl [aria-label="Responded by"]'); await page.keyboard.press('Tab'); };
  const leave = async () => { await page.click('.qpanel .qleft .qlbl'); await page.waitForTimeout(700); };
  const NOTE = 'Not saved: Enter a real date';
  // an empty date: month and day typed, then the field left
  await open1(2); await into(); await page.keyboard.type('11'); await page.keyboard.type('02'); await leave();
  const a = await at(); const a2 = (await qOf(2)).responded;
  // a saved date with its month taken out, then left: the parts stay, the saved date is untouched
  await open1(1); await into(); await page.keyboard.press('Backspace'); await leave();
  const b = await at(); const b2 = (await qOf(1)).responded;
  // ... and finishing it later saves it
  await page.focus(D); await page.keyboard.type('12'); await leave(); const b3 = (await qOf(1)).responded;
  say('a date typed in part stays in its field with "Not saved: Enter a real date"; the saved date is untouched', r.ok && a.inPart && a.type === 'date' && a.notes.join() === NOTE && a2 === '' && b.inPart && b.notes.join() === NOTE && b2 === '2026-11-02' && b3 === '2026-12-02', JSON.stringify({ a, a2, b, b2, b3 }));
  // another PC changes some other part of the question: the parts stay
  await open1(4); const q4 = (await qOf(4)).id; await into(); await page.keyboard.type('11'); await page.keyboard.type('02'); await leave();
  await page.evaluate((q) => __peer.change(q, { priority: 'Low' }, { by: 'jdoe', from: 'PC B' }), q4); await page.waitForFunction((q) => store.get().questions[q].priority === 'Low', q4); await page.waitForTimeout(300);
  const c = await at();
  // another PC dates the question while it is typed in part: asked about, not drawn over
  await open1(6); const q6 = (await qOf(6)).id; await into(); await page.keyboard.type('11'); await page.keyboard.type('02');
  await page.evaluate((q) => __peer.change(q, { responded: '2026-12-01' }, { by: 'jdoe', from: 'PC B' }), q6); await page.waitForFunction((q) => store.get().questions[q].responded === '2026-12-01', q6); await page.waitForTimeout(300);
  const d = await at(); await leave(); const d2 = await at();
  await page.click('.qpanel .qlbl .efstate.ext button:has-text("Keep mine")'); await page.waitForTimeout(200); const d3 = await at();
  await page.focus(D); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('2026'); await leave(); const d4 = (await qOf(6)).responded;
  say('another PC never draws over a date typed in part: a change elsewhere is asked about, and Keep mine keeps the parts', c.inPart && c.notes.join() === NOTE && d.inPart && /^Changed elsewhere/.test(d.notes.join()) && d2.inPart && d2.notes.length === 1 && d3.inPart && d3.notes.join() === NOTE && d4 === '2026-11-02', JSON.stringify({ c, d, d2, d3, d4 }));
  // Take theirs puts the other PC's date over the parts; Escape takes the parts back to what the field held
  await open1(8); const q8 = (await qOf(8)).id; await into(); await page.keyboard.type('11'); await page.keyboard.type('02'); await leave();
  await page.evaluate((q) => __peer.change(q, { responded: '2026-12-01' }, { by: 'jdoe', from: 'PC B' }), q8); await page.waitForFunction((q) => store.get().questions[q].responded === '2026-12-01', q8); await page.waitForTimeout(300);
  await page.click('.qpanel .qlbl .efstate.ext button:has-text("Take theirs")'); await page.waitForTimeout(300); const e = await at();
  await open1(10); await into(); await page.keyboard.type('11'); await page.keyboard.press('Escape'); await page.waitForTimeout(300); const f = await at();
  await open1(11); await into(); await page.keyboard.press('Backspace'); await page.keyboard.press('Escape'); await page.waitForTimeout(500); const g = await at(); const g2 = (await qOf(11)).responded;
  say('Take Theirs and Escape put a whole date back over the parts', e.v === '2026-12-01' && !e.inPart
    && !e.notes.length && !f.inPart && f.v === '' && !g.inPart && g.v === '2026-11-02' && g2 === '2026-11-02',
    JSON.stringify({ e, f, g, g2 }));
  // the Received date beside the question's details does the same
  await open1(13); await page.focus('.qpanel .qph [aria-label="Received"]'); await page.keyboard.press('Backspace'); await leave();
  const h = await at('.qpanel .qph [aria-label="Received"]'); const h2 = (await qOf(13)).received;
  say('the Received date typed in part stays too', h.inPart && h.notes.join() === NOTE && h2 === '2026-10-28', JSON.stringify({ h, h2 }));
  say('no page errors', !page.errors.length, JSON.stringify(page.errors));
  await ctx.close();
}

{ // #931: a reload while the master checklist is written keeps the paste and its review
  const { ctx, page } = await open();
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-create');
  await page.waitForSelector('#u-menu');
  await checkChecklistPasteReload(page, say);
  say('#931 no page errors', !page.errors.length, JSON.stringify(page.errors));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
