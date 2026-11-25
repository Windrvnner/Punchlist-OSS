// The open question across the top of the Q&A page: its boxes, its label lines and how it sits with the table below,
// in both schemes, at 1280×736 and 1024×640.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { settled, trackSettle } from './settle.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const ROWS = [
  ['Confirm the lock-up ratio that applies from financial close, and which document prevails.', 'The credit agreement prevails. Lock-up is tested at 1.25x from financial close.', 'Northwind Sponsor LP', '2026-11-02', 'High'],
  ['Provide the executed revenue contract and all amendments.', '', '', '', ''],
  ['What is the basis for the operating assumption in the base case?', 'The technical advisor’s P50 case, less a 2% availability haircut.', 'Northwind Sponsor LP', '2026-11-05', 'Medium'],
  ['Has the interconnection agreement been signed, and what are its conditions?', '', '', '', ''],
];
async function newDeal(page, name, rows = ROWS) {
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  const id = await page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === 'Project ' + n).id, name);
  await page.waitForFunction((d) => Object.values(store.get().findings).filter((f) => f.dealId === d).length === 3, id, { timeout: 30000 });
  await page.evaluate(([d, rows]) => store.dispatch(store.commandNamed('ImportQuestions'), { dealId: d, mode: 'append', rows: rows.map(([text, response, respondedBy, responded, priority]) => ({ n: null, text, askedBy: 'Lamna Capital', received: '2026-10-28', workstream: 'Legal', priority, response, respondedBy, responded, status: response ? 'answered' : '' })) }, { quiet: true }), [id, rows]);
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .list');
  await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' } })); await page.waitForFunction((n) => document.querySelectorAll('.md .li').length === n, rows.length);
  return id;
}
// opens the question numbered n and waits for the panel to settle
const openQ = async (page, n) => { await page.click(`.md .li:has(.n:text-is("${n}"))`); await page.waitForFunction((n) => document.querySelector('.qpanel .qph .n')?.textContent === 'Q' + n, n); await page.waitForTimeout(250); };

async function holdSubmittedBySave(page, field, beforeWrite) {
  await page.evaluate(({ field, beforeWrite }) => {
    const question = store.get().questions[store.get().ui.selectedQuestion];
    const repo = store.services.repo;
    const transaction = repo.transaction.bind(repo);
    const dispatch = store.dispatch.bind(store);
    const run = { held: false };
    const gate = new Promise((resolve) => { run.release = resolve; });
    window.__queuedQuestionPick = run;
    repo.transaction = async (tx) => {
      const operation = tx.writes.find((write) => write.kind === 'op')?.data;
      const isFieldSave = operation?.state === 'succeeded'
        && operation.input?.questionId === question.id && operation.input.field === 'askedBy';
      const writesQuestion = tx.writes.some((write) => write.kind === 'question' && write.id === question.id);
      if (isFieldSave && writesQuestion === beforeWrite) {
        repo.transaction = transaction;
        run.held = true;
        await gate;
      }
      return transaction(tx);
    };
    store.dispatch = (command, input, options) => {
      const promise = dispatch(command, input, options);
      if (input?.questionId === question.id) {
        if (input.field === 'askedBy') run.first = promise;
        if (input.field === field) {
          store.dispatch = dispatch;
          run.picked = promise;
        }
      }
      return promise;
    };
  }, { field, beforeWrite });
}

async function savedPickFields(page, field) {
  return page.evaluate(async (field) => {
    const result = await store.services.repo.get('question', store.get().ui.selectedQuestion);
    if (!result.ok || !result.value) throw new Error('Could not read the saved question');
    const data = result.value.envelope.data;
    return { submitted: data.askedBy, choice: data[field] };
  }, field);
}

async function syncQuestionPick(page, field, value) {
  const pick = { field, value };
  await page.evaluate(({ field, value }) => __peer.change(store.get().ui.selectedQuestion, { [field]: value }), pick);
  await page.waitForFunction(({ field, value }) => {
    const { questions, ui } = store.get();
    return questions[ui.selectedQuestion][field] === value;
  }, pick);
}

async function pickWhileSaving(page, field, button, option, peerValue, beforeWrite) {
  const submitted = page.getByRole('textbox', { name: 'Submitted by' });
  const original = await submitted.inputValue();
  const typed = original === 'The lender' ? 'The reviewer' : 'The lender';
  await holdSubmittedBySave(page, field, beforeWrite);
  await submitted.fill(typed);
  await submitted.press('Enter');
  await page.waitForFunction(() => window.__queuedQuestionPick.held);
  await page.click(button);
  await page.click(option);
  await syncQuestionPick(page, field, peerValue);
  const outcome = await page.evaluate(async () => {
    const run = window.__queuedQuestionPick;
    run.release();
    const first = await run.first;
    const picked = await run.picked;
    return { first: first.ok, picked: picked?.ok };
  });
  const saved = await savedPickFields(page, field);
  const notices = page.locator('.toast', { has: page.locator('.ttitle').filter({ hasText: /^Changed elsewhere$/ }) });
  if (outcome.picked === false) await notices.first().waitFor({ timeout: 3000 });
  const count = await notices.count();
  await notices.evaluateAll((nodes) => {
    for (const node of nodes) node.querySelector('.tclose').click();
  });
  const result = { ...outcome, notices: count, saved, original, typed };
  if (!beforeWrite || outcome.first) return result;
  const retry = page.locator('.qprops').getByRole('button', { name: 'Not saved · Retry', exact: true });
  await retry.waitFor();
  const retained = await submitted.inputValue();
  await retry.click();
  await page.waitForFunction((text) => store.get().questions[store.get().ui.selectedQuestion].askedBy === text, typed);
  return { ...result, retained, retried: await savedPickFields(page, field) };
}

for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await newDeal(page, 'Proseware');

  // ---- the response box: its clear bottom edge stays clear when it has the focus ----------------------------------
  await openQ(page, 1); await page.focus('.qpanel .rtext');
  const edge = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('.qpanel .rtext')); return { color: cs.borderBottomColor, width: cs.borderBottomWidth, outline: cs.outlineColor }; });
  say(`${scheme}:a-focused-response-box-keeps-its-bottom-edge-clear`, edge.color === 'rgba(0, 0, 0, 0)' && edge.width === '9px', JSON.stringify(edge));
  await page.keyboard.press('Escape');

  // ---- saving: the panel keeps its height, and the response box still ends on a whole line ------------------------
  const fit = () => page.evaluate(() => { const p = document.querySelector('.qpanel'); const r = p.querySelector('.rtext'); const cs = getComputedStyle(r); const lh = parseFloat(cs.lineHeight); const room = r.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    return { h: Math.round(p.getBoundingClientRect().height), lines: +(room / lh).toFixed(2), whole: Math.abs(room / lh - Math.round(room / lh)) < 0.05 }; });
  await openQ(page, 1); const f0 = await fit();
  await page.focus('.qpanel .rtext'); await page.keyboard.press('End'); await page.keyboard.type(' Confirmed by the lenders.');
  await page.waitForFunction(() => store.get().questions[store.get().ui.selectedQuestion].response.endsWith('lenders.'), null, { timeout: 5000 }); await page.waitForTimeout(300); const f1 = await fit();
  say(`${scheme}:saving-the-response-keeps-the-panels-height-and-whole-lines`, f0.whole && f1.whole && f1.h === f0.h && f1.lines === f0.lines, JSON.stringify({ f0, f1 }));
  await page.keyboard.press('Escape');

  // ---- a save the record refuses says why, in full and inside the panel, with no Retry ----------------------
  const note = (sel) => page.evaluate((sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect(); let shown = true;
    for (let e = n.parentElement; e && !e.classList.contains('home'); e = e.parentElement) { if (getComputedStyle(e).overflowX !== 'visible') { const b = e.getBoundingClientRect(); if (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1) shown = false; } }
    return { text: n.textContent, shown, cut: n.scrollWidth > n.clientWidth + 1 }; }, sel);
  await openQ(page, 1); await page.fill('.qpanel .rtext', ''); await page.click('.qpanel .qleft .qlbl');
  await page.waitForSelector('.qpanel .qright .efstate.fail'); const cleared = await note('.qpanel .qright .rtext ~ .efstate.fail');
  say(`${scheme}:clearing-an-answered-response-says-to-change-the-status-first`, cleared?.text === 'Not saved: This question is marked Answered. Change its status before clearing the response' && cleared.shown && !cleared.cut, JSON.stringify(cleared));
  await page.fill('.qpanel .rtext', 'The credit agreement prevails.'); await page.click('.qpanel .qleft .qlbl'); await page.waitForSelector('.qpanel .qright .efstate.fail', { state: 'detached' });
  await page.focus('.qpanel .qlbl .dedit'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.type('202611'); await page.click('.qpanel .qleft .qlbl');
  await page.waitForSelector('.qpanel .qlbl .efstate.fail'); const year = await note('.qpanel .qlbl .efstate.fail');
  say(`${scheme}:a-date-with-a-six-digit-year-says-why-it-was-not-saved`, year?.text === 'Not saved: Enter a real date' && year.shown && !year.cut && /^202611-/.test(await page.inputValue('.qpanel .qlbl .dedit')), JSON.stringify(year));
  await page.keyboard.press('Escape');
  // who responded and when show only once filled: a response with neither shows no empty fields beside its label
  const byShown = async (n) => { await openQ(page, n); return page.evaluate(() => { const e = document.querySelector('.qpanel .qlbl .sub.by input'); return !!e && getComputedStyle(e, '::placeholder').color !== 'rgba(0, 0, 0, 0)'; }); };
  await page.evaluate(() => { const q = Object.values(store.get().questions).find((x) => x.dealId === location.hash.slice(4) && x.n === 4); return store.dispatch(store.commandNamed('SetResponse'), { dealId: q.dealId, questionId: q.id, response: 'Uploaded to the data room, folder 2.1.' }, { quiet: true }); });
  const emptyBy = await byShown(4);
  // empty, they still show to the keyboard, so a responder can be typed for a response that came in by hand
  await page.focus('.qpanel .qlbl .sub.by [aria-label="Responded by"]'); await page.waitForTimeout(300);
  const onFocus = await page.evaluate(() => getComputedStyle(document.querySelector('.qpanel .qlbl .sub.by input'), '::placeholder').color !== 'rgba(0, 0, 0, 0)');
  await page.click('.qpanel .qleft .qlbl'); await page.mouse.move(0, 0);
  await page.evaluate(() => { const q = Object.values(store.get().questions).find((x) => x.dealId === location.hash.slice(4) && x.n === 4); return store.dispatch(store.commandNamed('EditQuestionField'), { dealId: q.dealId, questionId: q.id, field: 'respondedBy', value: 'Northwind Sponsor LP' }, { quiet: true }); });
  await page.waitForFunction(() => document.querySelector('.qpanel .qlbl .sub.by [aria-label="Responded by"]')?.value === 'Northwind Sponsor LP' ); const filledBy = await page.inputValue('.qpanel .qlbl .sub.by [aria-label="Responded by"]');
  // emptied while open, they stay for the rest of this question, so nothing typed next goes nowhere
  await page.fill('.qpanel .qlbl .sub.by [aria-label="Responded by"]', ''); await page.click('.qpanel .qleft .qlbl');
  await page.waitForFunction(() => Object.values(store.get().questions).find((x) => x.dealId === location.hash.slice(4) && x.n === 4).respondedBy === '');
  const stays = await page.evaluate(() => !document.querySelector('.qpanel .qlbl .sub.by.unfilled') && !!document.querySelector('.qpanel .qlbl .sub.by input'));
  say(`${scheme}:responded-by-and-its-date-show-only-once-filled`, !emptyBy && onFocus && filledBy === 'Northwind Sponsor LP' && stays, JSON.stringify({ emptyBy, onFocus, filledBy, stays }));
  // a responder typed by hand whose save fails stays drawn, with its "Not saved · Retry", once focus and the pointer leave
  await openQ(page, 1); await openQ(page, 4);
  await page.focus('.qpanel .qlbl .sub.by [aria-label="Responded by"]');
  await page.evaluate(() => { let i = 0; for (const size of [262144, 16384, 512]) { for (;;) { try { localStorage.setItem('qaQuotaFixture' + (i++), 'x'.repeat(size)); } catch { break; } } } });
  await page.keyboard.type('Lamna Capital'); await page.click('.qpanel .qleft .qlbl'); await page.mouse.move(0, 0);
  await page.waitForSelector('.qpanel .qlbl .sub.by .efstate.fail', { timeout: 5000 }); await page.waitForTimeout(300);
  const failed = await page.evaluate(() => { const i = document.querySelector('.qpanel .qlbl .sub.by [aria-label="Responded by"]'), n = document.querySelector('.qpanel .qlbl .sub.by .efstate.fail'); const clear = (e) => getComputedStyle(e).color === 'rgba(0, 0, 0, 0)';
    return { value: i.value, textShown: !clear(i), noteShown: !clear(n), note: n.textContent }; });
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('qaQuotaFixture')) localStorage.removeItem(k); });
  await page.click('.qpanel .qlbl .sub.by .efstate.fail');
  await page.waitForFunction(() => Object.values(store.get().questions).find((x) => x.dealId === location.hash.slice(4) && x.n === 4).respondedBy === 'Lamna Capital', null, { timeout: 5000 }).catch(() => {});
  const retried = await page.evaluate(() => Object.values(store.get().questions).find((x) => x.dealId === location.hash.slice(4) && x.n === 4).respondedBy);
  say(`${scheme}:a-responder-that-could-not-be-saved-stays-drawn-with-its-retry`, failed.value === 'Lamna Capital' && failed.textShown && failed.noteShown && /^Not saved/.test(failed.note) && retried === 'Lamna Capital', JSON.stringify({ failed, retried }));
  await openQ(page, 1);

  // ---- Status from the keyboard: the first arrow opens the list and changes nothing; arrows move, Enter picks, Escape
  // closes it unchanged; the focus stays on Status throughout ------------------------------------------
  const status = () => page.evaluate(() => { const s = document.querySelector('.qpanel .stsel'); const l = document.getElementById('q-stlist');
    // null-safe: before this was fixed, Escape closed the panel, and this reports that rather than stopping the suite
    return { saved: store.get().questions[store.get().ui.selectedQuestion]?.status ?? null, value: s?.value ?? null, list: !!l, hi: l?.querySelector('[aria-selected="true"]')?.textContent ?? null, active: s?.getAttribute('aria-activedescendant') ?? null, expanded: s?.getAttribute('aria-expanded') ?? null, focus: !!s && document.activeElement === s, panel: !!document.querySelector('.qpanel') }; });
  await openQ(page, 2); await page.focus('.qpanel .stsel');
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); const k1 = await status();
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); const k2 = await status();
  await page.keyboard.press('Escape'); await page.waitForTimeout(150); const k3 = await status();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await page.waitForTimeout(300); const k4 = await status();
  say(`${scheme}:status-opens-its-list-on-the-first-arrow-and-changes-nothing-until-enter`, k1.saved === 'open' && k1.value === 'open' && k1.list && k1.hi === 'Open' && k1.expanded === 'true' && k1.focus
    && k2.saved === 'open' && k2.value === 'open' && k2.hi === 'Closed' && k2.active === 'q-st-closed' && k2.focus
    && k3.saved === 'open' && k3.value === 'open' && !k3.list && k3.expanded === 'false' && k3.focus && k3.panel
    && k4.saved === 'closed' && k4.value === 'closed' && !k4.list && k4.focus, JSON.stringify({ k1, k2, k3, k4 }));
  // with the mouse: a click opens the list, the disabled Answered (no response yet) does nothing, a click on Closed picks it
  const reopen = () => page.evaluate(() => { const q = Object.values(store.get().questions).find((x) => x.text.startsWith('Provide the executed revenue contract')); return store.dispatch(store.commandNamed('SetQuestionStatus'), { dealId: q.dealId, questionId: q.id, status: 'open' }); });
  await reopen();
  await page.waitForFunction(() => document.querySelector('.qpanel .stsel')?.value === 'open');
  await page.click('.qpanel .stsel'); const m1 = await status(); await page.click('#q-st-answered', { force: true }); const m2 = await status(); await page.click('#q-st-closed'); await page.waitForTimeout(300); const m3 = await status();
  say(`${scheme}:status-opens-and-picks-with-the-mouse`, m1.list && m1.hi === 'Open' && m2.list && m2.saved === 'open' && m3.saved === 'closed' && !m3.list && m3.focus, JSON.stringify({ m1, m2, m3 }));
  await reopen();

  // ---- Workstream and Priority as Status: the first arrow opens the list and changes nothing; arrows move, Enter or Space
  // picks, Escape closes it unchanged with the focus kept; Tab or a click elsewhere closes it unchanged ------
  const prop = (label, list) => page.evaluate(([label, list]) => { const b = document.querySelector(`.qpanel [aria-label="${label}"]`); const l = document.getElementById(list); const q = store.get().questions[store.get().ui.selectedQuestion];
    // the last option must be seen, not cut off by the header's details or covered by the table below; in a list long enough
    // to scroll that is the "No …" option at its foot, as the names above it scroll
    const last = (l ? [...l.querySelectorAll('[role="option"]')].at(-1) : null)?.getBoundingClientRect(); const top = last && document.elementFromPoint(last.left + last.width / 2, last.top + last.height / 2);
    return { ws: q?.workstream ?? null, pr: q?.priority ?? null, list: !!l, glass: !!l?.classList.contains('glass'), seen: !!top && !!l?.contains(top), opts: l ? [...l.querySelectorAll('[role="option"]')].map((o) => o.textContent).join('|') : '', hi: l?.querySelector('[aria-selected="true"]')?.textContent ?? null, expanded: b?.getAttribute('aria-expanded') ?? null, focus: !!b && document.activeElement === b, panel: !!document.querySelector('.qpanel') }; }, [label, list]);
  // another question's own workstream is one of this deal's, so it is offered here too
  await page.evaluate(() => { const q = Object.values(store.get().questions).find((x) => x.text.startsWith('Has the interconnection')); return store.dispatch(store.commandNamed('EditQuestionField'), { dealId: q.dealId, questionId: q.id, field: 'workstream', value: 'Permitting' }, { quiet: true }); });
  await openQ(page, 2); await page.focus('.qpanel [aria-label="Workstream"]');
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); const w1 = await prop('Workstream', 'q-wslist');
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); const w2 = await prop('Workstream', 'q-wslist');
  await page.keyboard.press('Escape'); await page.waitForTimeout(150); const w3 = await prop('Workstream', 'q-wslist');
  await page.keyboard.press(' '); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Tab'); await page.waitForTimeout(150); const w4 = await prop('Workstream', 'q-wslist');
  await page.focus('.qpanel [aria-label="Workstream"]'); await page.keyboard.press('Enter'); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.waitForTimeout(300); const w5 = await prop('Workstream', 'q-wslist');
  say(`${scheme}:workstream-opens-its-list-on-the-first-arrow-and-changes-nothing-until-enter`, w1.ws === 'Legal' && w1.list && w1.glass && w1.seen && w1.hi === 'Legal' && w1.expanded === 'true' && w1.focus
    && w1.opts === 'Antitrust & FDI|Commercial|Compliance|Environmental & social|Financial|HR & benefits|Insurance|IT & cyber|Legal|Permitting|Real estate|Regulatory & permits|Structure|Tax|Technical|No workstream'   // A to Z, the deal's own name among them, "No workstream" last
    && w2.ws === 'Legal' && w2.hi === 'Permitting' && w2.focus && w3.ws === 'Legal' && !w3.list && w3.expanded === 'false' && w3.focus && w3.panel
    && w4.ws === 'Legal' && !w4.list && w5.ws === '' && !w5.list && w5.focus, JSON.stringify({ w1, w2, w3, w4, w5 }));
  await page.focus('.qpanel [aria-label="Priority"]');
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(150); const p1 = await prop('Priority', 'q-prlist');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press(' '); await page.waitForTimeout(300); const p2 = await prop('Priority', 'q-prlist');
  // a press elsewhere lands on the menu backdrop, which closes the list: forced, as Playwright otherwise waits for the backdrop to go
  await page.click('.qpanel [aria-label="Priority"]'); const p3 = await prop('Priority', 'q-prlist'); await page.click('.qpanel .qright .qlbl', { force: true }); await page.waitForTimeout(150); const p4 = await prop('Priority', 'q-prlist');
  await page.click('.qpanel [aria-label="Priority"]'); await page.click('#q-prlist [role="option"]:has-text("Low")', { timeout: 3000 }).catch(() => {}); await page.waitForTimeout(300); const p5 = await prop('Priority', 'q-prlist');
  say(`${scheme}:priority-opens-its-list-without-saving-and-picks-with-keys-or-mouse`, p1.pr === 'High' && p1.list && p1.seen && p1.hi === 'High' && p1.opts === 'High|Medium|Low' && p1.focus
    && p2.pr === 'Medium' && !p2.list && p2.focus && p3.list && p3.hi === 'Medium' && p4.pr === 'Medium' && !p4.list && p5.pr === 'Low' && !p5.list && p5.focus, JSON.stringify({ p1, p2, p3, p4, p5 }));
  for (const [field, button, option, start, settledPeer, beforeWritePeer] of [
    ['workstream', '#q-ws', '#q-ws-tax', 'Legal', 'Technical', 'Compliance'],
    ['priority', '#q-pr', '#q-pr-medium', 'Low', 'High', 'High'],
  ]) {
    const pick = await pickWhileSaving(page, field, button, option, settledPeer, false);
    say(`${scheme}:queued-${field}-pick-keeps-the-synced-choice-and-says-why`,
      pick.first && pick.picked === false && pick.saved.choice === settledPeer && pick.notices === 1
        && pick.saved.submitted === pick.typed, JSON.stringify(pick));
    await syncQuestionPick(page, field, start);
    const pending = await pickWhileSaving(page, field, button, option, beforeWritePeer, true);
    const textKept = pending.first ? pending.saved.submitted === pending.typed
      : pending.saved.submitted === pending.original && pending.retained === pending.typed
        && pending.retried.submitted === pending.typed && pending.retried.choice === beforeWritePeer;
    say(`${scheme}:queued-${field}-pick-keeps-the-peer-choice-and-earlier-typing`,
      pending.picked === false && pending.saved.choice === beforeWritePeer && pending.notices === 1 && textKept,
      JSON.stringify(pending));
  }
  await page.evaluate(async () => { for (const q of Object.values(store.get().questions).filter((x) => x.text.startsWith('Provide the executed') || x.text.startsWith('Has the interconnection'))) for (const [field, value] of [['workstream', 'Legal'], ['priority', 'High']]) await store.dispatch(store.commandNamed('EditQuestionField'), { dealId: q.dealId, questionId: q.id, field, value }, { quiet: true }); });

  // ---- Draft all open, with nothing left to draft, says why it is off: on hover and to a screen reader -------------
  await page.evaluate(() => Promise.all(Object.values(store.get().questions).filter((q) => q.status === 'open').map((q) => store.dispatch(store.commandNamed('RequestDraft'), { dealId: q.dealId, questionId: q.id }))));
  await page.waitForFunction(() => document.getElementById('qa-draftall')?.disabled, null, { timeout: 30000 });
  const off = await page.evaluate(() => { const b = document.getElementById('qa-draftall'); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { description: b.getAttribute('aria-description'), hover: hit?.closest('[title]')?.getAttribute('title') ?? null }; });
  say(`${scheme}:draft-all-open-says-why-it-is-off`, off.description === 'Nothing left to draft' && off.hover === 'Nothing left to draft', JSON.stringify(off));

  say(`${scheme}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

// ---- the response's label line at 1280 and 1024, at 100% and at 150% zoom (a 150% window is 2/3 as many CSS pixels) -----
// Nothing on it is cut or runs past the panel, and each column's text sits right under its own label, so a label
// line that wraps moves only the response.
for (const scheme of ['dark', 'light']) for (const zoom of [1, 1.5]) {
  const at = (w, h) => ({ width: Math.round(w / zoom), height: Math.round(h / zoom) });
  const ctx = await browser.newContext({ viewport: at(1280, 736), deviceScaleFactor: zoom, colorScheme: scheme }); const page = await ctx.newPage();
  const id = await newDeal(page, 'Wingtip');
  await page.evaluate((d) => { const q = Object.values(store.get().questions).find((x) => x.dealId === d && x.n === 2); return store.dispatch(store.commandNamed('RequestDraft'), { dealId: d, questionId: q.id }); }, id);
  const line = () => page.evaluate(() => { const p = document.querySelector('.qpanel'); const edge = p.getBoundingClientRect().right - parseFloat(getComputedStyle(p).paddingRight); const l = p.querySelector('.qright .qlbl');
    // who responded may give way, ending in an ellipsis inside its capsule (1024 at 150%): its capsule and its field are not counted as cut
    const givesWay = (e) => !!e.closest('.efcap:has([aria-label="Responded by"])') && e.getBoundingClientRect().right <= edge + 0.5;
    const bad = [...l.querySelectorAll('*')].filter((e) => e.getClientRects().length && !e.closest('.efstate')).flatMap((e) => { const r = e.getBoundingClientRect(); const cut = e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible' && !givesWay(e); return r.right > edge + 0.5 || cut ? [`${e.className || e.tagName}${cut ? ' cut' : ''} ${Math.round(r.right - edge)}`] : []; });
    const q = p.querySelector('.qleft .qtext').getBoundingClientRect().top - p.querySelector('.qleft .qlbl').getBoundingClientRect().bottom, r = p.querySelector('.qright .rtext, .qright .rbox').getBoundingClientRect().top - l.getBoundingClientRect().bottom;
    const top = (lbl) => { const g = document.createRange(); g.selectNodeContents(lbl.firstChild); return g.getBoundingClientRect().top; };   // the label's own word, Question or Response
    return { bad, under: Math.round(r - q), labels: Math.round(top(l) - top(p.querySelector('.qleft .qlbl'))), sub: p.querySelector('.qright .qlbl .sub:not(.by)')?.textContent ?? null }; });
  for (const [w, h] of [[1280, 736], [1024, 640]]) {
    await page.setViewportSize(at(w, h)); await openQ(page, 2); await page.waitForSelector('.qpanel .draft:not(.pending)'); await page.waitForTimeout(400); const d = await line();   // after the draft's entry animation (8px)
    say(`${scheme}:${w}-at-${zoom * 100}%:a-waiting-draft's-label-line-shows-in-full`, d.sub === 'Draft Response'
      && !d.bad.length && d.under === 0 && d.labels === 0, JSON.stringify(d));
    await openQ(page, 1); const a = await line(); const date = await page.evaluate(() => { const i = document.querySelector('.qpanel .qlbl .dedit'); const r = i.getBoundingClientRect(); return { w: Math.round(r.width), need: i.scrollWidth - i.clientWidth }; });
    say(`${scheme}:${w}-at-${zoom * 100}%:the-response's-date-shows-in-full-inside-the-panel`, !a.bad.length && a.under === 0 && a.labels === 0 && date.need <= 0, JSON.stringify({ a, date }));
  }
  await ctx.close();
}

// ---- with a question open the table below fits the space left, so the wheel scrolls the list and the page stays put ----
for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); await trackSettle(ctx); const page = await ctx.newPage();
  await newDeal(page, 'Munson', Array.from({ length: 14 }, (_, i) => [`Provide the schedule of lender consents, item ${i + 1}.`, i % 2 ? 'Attached in the data room.' : '', i % 2 ? 'Litware' : '', i % 2 ? '2026-11-06' : '', 'High']));
  const fits = () => page.evaluate(() => { const v = document.getElementById('view'), l = document.querySelector('.md .list'); const vb = v.getBoundingClientRect().bottom, lb = l.getBoundingClientRect().bottom;
    return { pageOver: v.scrollHeight - v.clientHeight, listPast: Math.round(lb - vb), listScrolls: l.scrollHeight > l.clientHeight + 1, inline: l.style.maxHeight }; });
  for (const [w, h] of [[1280, 736], [1024, 640]]) {
    // the question is opened with the header row tucked away (the list scrolled down), so opening it scrolls the list to the top and
    // brings the header back as the panel sizes the list; measured once the page has stopped moving
    await page.setViewportSize({ width: w, height: h }); await page.evaluate(() => { const l = document.querySelector('.md .list'); l.scrollTop = l.scrollHeight; });
    await page.waitForSelector('.home.qapage.tuck'); await settled(page); await openQ(page, 1); await settled(page); const f = await fits();
    await page.mouse.move(700, h - 60); await page.mouse.wheel(0, 300);
    await page.waitForFunction(() => document.getElementById('view').scrollTop > 0 || document.querySelector('.md .list').scrollTop > 0).catch(() => {}); await settled(page);   // the scroll, and the header tucking away for it, have finished
    const after = await page.evaluate(() => ({ page: document.getElementById('view').scrollTop, list: document.querySelector('.md .list').scrollTop, head: Math.round(document.querySelector('.qpanel').getBoundingClientRect().top) }));
    say(`${scheme}:${w}:with-a-question-open-the-list-fits-the-window-and-the-wheel-scrolls-it`, f.pageOver <= 0 && f.listPast <= 0 && f.listScrolls && after.page === 0 && after.list > 0, JSON.stringify({ f, after }));
    // scrolled back to the top, the header row slides back in: the list makes room for it as it starts, so at no frame of the slide
    // does the page run past the window, where the wheel would scroll the page
    const back = await page.evaluate(async () => { const v = document.getElementById('view'), l = document.querySelector('.md .list'); const tucked = !!document.querySelector('.home.qapage.tuck');
      l.scrollTop = 0; let most = -Infinity, frames = 0; const t0 = performance.now();
      while (performance.now() - t0 < 500) { await new Promise((r) => requestAnimationFrame(r)); most = Math.max(most, v.scrollHeight - v.clientHeight); frames++; }
      return { tucked, back: !document.querySelector('.home.qapage.tuck'), most, frames }; });
    say(`${scheme}:${w}:the-header-coming-back-never-lets-the-page-overflow`, back.tucked && back.back && back.most <= 0, JSON.stringify(back));
    await settled(page);
    // the panel is sized again whenever anything changes: a list scrolled to its end stays there
    const end = await page.evaluate(() => { const l = document.querySelector('.md .list'); l.scrollTop = l.scrollHeight; return l.scrollTop; });
    await page.evaluate(() => store.ui({ qaFilter: { ...store.get().ui.qaFilter } })); await settled(page); const kept = await page.evaluate(() => { const l = document.querySelector('.md .list'); return { top: l.scrollTop, short: l.scrollHeight - l.clientHeight - l.scrollTop }; });
    // still at its end: not the same scrollTop, as a list fitted again a few px taller under load (357 to 349) is at its end with less of it
    say(`${scheme}:${w}:the-list-keeps-its-place-when-the-panel-is-sized-again`, end > 0 && kept.short <= 1, JSON.stringify({ end, kept }));
    await page.click('#q-close'); await page.waitForSelector('.qpanel', { state: 'detached' }); await settled(page); const closed = await fits();
    say(`${scheme}:${w}:closing-the-question-gives-the-list-its-own-height-back`, closed.inline === '' && closed.pageOver <= 0, JSON.stringify(closed));
  }
  await ctx.close();
}

// ---- a long question at 1024×640 leaves the table room below it, so the page doesn't scroll as it is stepped to ----
{
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 640 }, colorScheme: 'dark' });
  await trackSettle(ctx);
  const page = await ctx.newPage();
  const long = 'Confirm the lock-up ratio that applies from financial close, which document prevails where the agreements differ, how the cure rights work and what the lenders require before any distribution. '.repeat(3);
  await newDeal(page, 'Fourth Coffee', Array.from({ length: 8 }, (_, i) => i % 2 ? [`Provide item ${i + 1}.`, '', '', '', 'Low'] : [long, long, 'Northwind', '2026-11-02', 'High']));
  const at = () => page.evaluate(() => { const v = document.getElementById('view'), l = document.querySelector('.md .list'), r = document.querySelector('.qpanel .rtext'); const cs = getComputedStyle(r); const lh = parseFloat(cs.lineHeight);
    return { pageOver: v.scrollHeight - v.clientHeight, list: Math.round(l.getBoundingClientRect().height), lines: +((r.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / lh).toFixed(2) }; });
  await openQ(page, 2);
  await settled(page);
  const short = await at();
  await openQ(page, 1);
  await settled(page);
  const tall = await at();
  say('a-long-question-leaves-the-table-room-and-the-page-still', short.pageOver <= 0 && tall.pageOver <= 0 && tall.list >= 140 && Math.abs(tall.lines - Math.round(tall.lines)) < 0.05 && tall.lines > 3.95, JSON.stringify({ short, tall }));
  // ---- a save changes only what it changed: not the theme, the table's height or the other rows' empty cells, each of which
  // lays the whole table out again, about 100ms a save with 2,000 questions ----
  await page.evaluate(() => store.ui({ qaFilter: { status: 'all', workstream: '', text: '' } }));
  await openQ(page, 2);
  await page.evaluate(() => { window.__muts = []; new MutationObserver((ms) => { for (const m of ms) { const t = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (t.closest('.qpanel, #toast, .netbar') || m.target === document.head || t.closest('head')) continue; window.__muts.push(`${m.type} ${t.tagName}.${t.className} ${m.attributeName ?? ''}`); } }).observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true }); });
  await page.click('.qpanel .rtext'); await page.keyboard.type('In schedule 4.'); await page.waitForFunction(() => Object.values(store.get().questions).some((q) => q.response === 'In schedule 4.'), null, { timeout: 5000 }); await page.waitForTimeout(400);
  const muts = await page.evaluate(() => window.__muts.filter((m) => !/SPAN\.rs |SPAN\.stc |BUTTON\.li /.test(m) || !/^(childList|characterData)/.test(m)));
  const rowTexts = await page.evaluate(() => window.__muts.filter((m) => /^characterData SPAN\.rs /.test(m)).length);
  say('a-save-leaves-the-theme-the-table-height-and-the-other-rows-alone', !muts.some((m) => /^attributes HTML\.|^attributes DIV\.list/.test(m)) && rowTexts <= 1, JSON.stringify({ muts: muts.slice(0, 12), rowTexts }));
  await ctx.close();
}

// ---- eight short questions at 1280×736, one open: the page has no pixel of overflow left to scroll ----
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: 'light' }); const page = await ctx.newPage();
  await newDeal(page, 'Bellows', Array.from({ length: 8 }, (_, i) => [`Provide item ${i + 1}.`, '', '', '', 'High']));
  await openQ(page, 1);
  const over = await page.evaluate(() => { const v = document.getElementById('view'); return v.scrollHeight - v.clientHeight; });
  say('a-short-log-with-a-question-open-leaves-no-overflow', over <= 0, JSON.stringify({ over }));
  await ctx.close();
}

// ---- the details are plain words on one 20px rhythm, the labels are quiet, Delete sits before Discuss, and the
// position reads in en-US at deal scale ----
/** The left and right of what is drawn in a header detail: its icon's paths and its words, not its box. */
function inkOf(el) {
  const sides = [];
  for (const icon of el.querySelectorAll('svg')) {
    if (!icon.getClientRects().length) continue;   // the chevron, hidden on a detail
    const box = icon.getBBox();
    const rect = icon.getBoundingClientRect();
    const scale = rect.width / 24;
    sides.push([rect.left + box.x * scale, rect.left + (box.x + box.width) * scale]);
  }
  for (const words of el.querySelectorAll('.pv,.dshow')) {
    if (!words.getClientRects().length) continue;
    const rect = words.getBoundingClientRect();
    sides.push([rect.left, rect.right]);
  }
  const typed = el.querySelector('input:not([type=date])');
  if (typed) {
    const pen = document.createElement('canvas').getContext('2d');
    pen.font = getComputedStyle(typed).font;
    const left = typed.getBoundingClientRect().left;
    sides.push([left, left + pen.measureText(typed.value).width]);
  }
  return { left: Math.min(...sides.map((x) => x[0])), right: Math.max(...sides.map((x) => x[1])) };
}
/** The gaps between drawn ink along the header (status to each detail) and the Response label line. */
function inkGaps(inkOfSrc) {
  const ink = new Function(`return ${inkOfSrc}`)();
  const status = document.querySelector('#q-status').getBoundingClientRect();
  const details = [...document.querySelectorAll('.qprops>*')].map(ink);
  const head = details.map((d, i) => Math.round(d.left - (i ? details[i - 1].right : status.right)));
  const label = document.createRange();
  label.selectNodeContents(document.querySelector('.qright>.qlbl').firstChild);
  const by = [...document.querySelectorAll('.qright .sub.by>.efwrap')].map(ink);
  const response = [Math.round(by[0].left - label.getBoundingClientRect().right), Math.round(by[1].left - by[0].right)];
  return { head, response };
}
/** A computed style of a detail or a sidebar row, with or without the pointer on it. */
const looks = (page, sel) => page.evaluate((sel) => {
  const style = getComputedStyle(document.querySelector(sel));
  return { fill: style.backgroundColor, edge: style.borderTopColor, radius: style.borderTopLeftRadius };
}, sel);
/** Imports questions up to `count` into the deal, for the position at deal scale. */
async function growTo(page, dealId, count) {
  await page.evaluate(([d, count]) => {
    const have = Object.values(store.get().questions).filter((q) => q.dealId === d).length;
    const row = (k) => ({ n: null, text: `Provide item ${k + 1}.`, askedBy: 'Humongous Capital', received: '2026-10-28',
      workstream: 'Legal', priority: '', response: '', respondedBy: '', responded: '', status: 'open' });
    const rows = Array.from({ length: count - have }, (_, k) => row(k));
    return store.dispatch(store.commandNamed('ImportQuestions'), { dealId: d, mode: 'append', rows }, { quiet: true });
  }, [dealId, count]);
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
}
for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme });
  const page = await ctx.newPage();
  const id = await newDeal(page, 'Margie');
  await openQ(page, 1);
  await page.mouse.move(640, 700);
  const gaps = await page.evaluate(inkGaps, inkOf.toString());
  const near = (x) => Math.abs(x - 20) <= 1;
  say(`${scheme}:the-details-and-the-response-line-are-20px-apart-on-the-ink`,
    gaps.head.length === 4 && gaps.head.every(near) && gaps.response.every(near), JSON.stringify(gaps));
  const rest = await looks(page, '.qprops .qp[title="Workstream"]');
  await page.hover('.qprops .qp[title="Workstream"]');
  await page.waitForTimeout(300);
  const hover = await looks(page, '.qprops .qp[title="Workstream"]');
  await page.hover('.rail a');
  await page.waitForTimeout(300);
  const row = await looks(page, '.rail a');
  const clear = 'rgba(0, 0, 0, 0)';
  say(`${scheme}:a-detail-is-bare-at-rest-and-takes-the-sidebar-rows-hover`, rest.fill === clear && rest.edge === clear
    && hover.fill === row.fill && hover.radius === row.radius && hover.radius === '9px',
    JSON.stringify({ rest, hover, row }));
  await page.focus('.qprops .efcap[title="Submitted by"] input');
  await page.waitForTimeout(300);   // the fill fades in over --fast
  const typing = await looks(page, '.qprops .efcap[title="Submitted by"]');
  const button = await looks(page, '#q-discuss');
  await page.click('.qpanel .qleft .qlbl');   // leaves the field; Escape would close the panel
  say(`${scheme}:a-detail-being-typed-in-shows-the-control-level`,
    typing.fill === button.fill && typing.edge === button.edge, JSON.stringify({ typing, button }));
  const type = await page.evaluate(() => {
    const font = (sel) => {
      const style = getComputedStyle(document.querySelector(sel));
      return [style.fontSize, style.fontWeight, style.color];
    };
    const sizes = [...document.querySelectorAll('.qpanel *')].map((e) => parseFloat(getComputedStyle(e).fontSize));
    const labels = [font('.qleft>.qlbl'), font('.qright>.qlbl')];
    return { labels, gray: font('.qnav .qpos')[2], text: font('.qleft .qtext'), largest: Math.max(...sizes) };
  });
  const quiet = ([size, weight, color]) => size === '13px' && weight === '500' && color === type.gray;
  say(`${scheme}:the-labels-are-13px-500-gray-and-the-question-stays-400`,
    type.labels.every(quiet) && type.text[1] === '400' && type.largest === 15, JSON.stringify(type));
  const order = await page.evaluate(() => [...document.querySelector('.qnav').children]
    .map((e) => e.id || (e.querySelector('.del') ? 'delete' : e.className)));
  say(`${scheme}:delete-sits-before-discuss-and-never-next-to-close`,
    order.join(' ') === 'qpos q-prev q-next delete q-discuss q-close', JSON.stringify(order));
  await growTo(page, id, 2000);
  await page.evaluate((d) => {
    const q1334 = Object.values(store.get().questions).find((q) => q.dealId === d && q.n === 1334);
    store.ui({ selectedQuestion: q1334.id });
  }, id);
  await page.waitForFunction(() => document.querySelector('.qpanel .qph .n')?.textContent === 'Q1334');
  const position = await page.textContent('.qnav .qpos');
  say(`${scheme}:the-position-reads-with-a-thousands-comma`, position === '1,334 of 2,000', position);
  await ctx.close();
}

// ---- high contrast: the clear bottom edge of the question, response and draft boxes stays the color behind it ----
for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme, forcedColors: 'active' }); const page = await ctx.newPage();
  const id = await newDeal(page, 'Coho');
  // each box's bottom border against what is painted behind it: its own background if that is solid, else the nearest solid one, else the window's
  const edges = () => page.evaluate(() => [...document.querySelectorAll('.qpanel .qtext, .qpanel .rtext, .qpanel .draft .rbox')].map((el) => {
    const solid = (c) => c && !/rgba\(.*, 0\)$/.test(c) && !/rgba\(.*, 0\.\d+\)$/.test(c);
    let bg = null; for (let e = el; e && !bg; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (solid(c)) bg = c; }
    if (!bg) { const p = document.createElement('i'); p.style.background = 'Canvas'; document.body.append(p); bg = getComputedStyle(p).backgroundColor; p.remove(); }
    return { box: el.classList.contains('rbox') ? 'draft' : el.classList.contains('qtext') ? 'question' : 'response', edge: getComputedStyle(el).borderBottomColor, bg, ok: getComputedStyle(el).borderBottomColor === bg };
  }));
  await openQ(page, 1); const a = await edges(); await page.focus('.qpanel .rtext'); const b = await edges();
  await page.evaluate((d) => { const q = Object.values(store.get().questions).find((x) => x.dealId === d && x.n === 2); return store.dispatch(store.commandNamed('RequestDraft'), { dealId: d, questionId: q.id }); }, id);
  await openQ(page, 2); await page.waitForSelector('.qpanel .draft:not(.pending) .rbox'); const c = await edges();
  const all = [...a, ...b, ...c];
  say(`${scheme}:in-high-contrast-the-boxes-bottom-edges-stay-clear`, all.length === 6 && all.every((x) => x.ok) && c.some((x) => x.box === 'draft'), JSON.stringify(all.filter((x) => !x.ok)));
  // a main button that can't be pressed doesn't look like one that can
  const pri = await page.evaluate(() => { const look = (off) =>
    { const b = document.createElement('button'); b.className = 'btn sm pri'; b.textContent = 'Log Question';
    b.disabled = off; document.querySelector('.qpanel').append(b); const s = getComputedStyle(b);
    const r = { bg: s.backgroundColor, ink: s.color }; b.remove(); return r; };
    return { on: look(false), off: look(true) }; });
  say(`${scheme}:in-high-contrast-a-disabled-main-button-looks-disabled`, pri.on.bg !== pri.off.bg && pri.on.ink !== pri.off.ink, JSON.stringify(pri));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
