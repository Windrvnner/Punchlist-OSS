// Resolve: questions in two versions with the Q&A log, at a deal's scale (2,140 questions, 112 in two
// versions, 207 changed in the log). A row opens it; 1 and 2 pick; the main button names the choice, steps on, and has
// Undo; Merge Both Versions is a third choice card and drafts one answer; a Status that differs goes with the version
// picked.
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
const N = 2140, TWO = 112, CHANGED = 207;
const APP = 'No notices served since COD.', LOG = 'No notices served since COD. Confirmed by seller’s counsel on November 14.';

async function keepDisplayedStatusAfterRefresh(page, dealId, tag) {
  const questionId = await page.evaluate((dealId) => {
    const question = Object.values(store.get().questions).find((q) => q.n === 119 && q.dealId === dealId);
    store.ui({ dialog: { kind: 'resolveQa', dealId, questionId: question.id } });
    return question.id;
  }, dealId);
  const status = (side) => page.locator(`.rsv-keep .seg button:nth-child(${side})`);
  await page.click('#rsv-merge');
  await page.waitForFunction(() => document.querySelector('#rsv-merged')?.value);
  await status(2).click();
  const savedSide = ([id, present]) => {
    const kept = JSON.parse(localStorage.getItem('dil/1/kept-drafts') ?? '{}')['qa-merge-sides'] ?? [];
    return kept.some(([key]) => key === id) === present;
  };
  await page.waitForFunction(savedSide, [questionId, true]);
  await page.evaluate(async ([dealId, id]) => {
    const { last } = store.get().deals[dealId].qaLogs[0];
    await window.__peer.change(id, { logPick: { of: last.at, sent: last.kept[id] } });
  }, [dealId, questionId]);
  await page.waitForSelector('#rsv-done');
  await page.waitForFunction(savedSide, [questionId, false]);

  await page.evaluate(async ([dealId, id]) => {
    const { last, name } = store.get().deals[dealId].qaLogs[0];
    const next = Object.values(store.get().questions).find((q) => q.n === 138 && q.dealId === dealId);
    const kept = { ...last.kept, [id]: { response: 'Final notice register received.', status: 'Closed' },
      [next.id]: { ...last.kept[next.id], status: 'Open' } };
    const input = { dealId, name, last: { ...last, kept, at: '2026-11-16T16:02:00.000Z' } };
    const result = await store.dispatch(store.commandNamed('RecordQaLogExport'), input, { quiet: true });
    if (!result.ok) throw new Error(result.error.message);
  }, [dealId, questionId]);
  await page.click('#rsv-merge');
  await page.waitForFunction(() => document.querySelector('#rsv-merged')?.value);
  const pressed = await status(2).getAttribute('aria-pressed');
  const shown = await status(2).textContent();
  await page.click('#rsv-keep');
  await page.waitForFunction(() => document.querySelector('.rsv-k')?.textContent === 'Q138');
  const saved = await page.evaluate((id) => store.get().questions[id].status, questionId);
  say(tag + 'keeping-a-merge-after-a-log-refresh-applies-the-displayed-side',
    pressed === 'true' && shown === 'Closed' && saved === 'closed', JSON.stringify({ pressed, shown, saved }));

  const reset = await page.locator('#rsv-keep').isDisabled();
  await page.click('#rsv-merge');
  const nextSide = await status(1).getAttribute('aria-pressed');
  say(tag + 'stepping-to-the-next-question-resets-the-pick-and-uses-its-own-side', reset && nextSide === 'true');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.rsvdlg', { state: 'detached' });
}

/** #939: a merge typed by hand outlives another PC resolving its question, in the response box, until used */
async function keepTypedMergeResolvedElsewhere(page, dealId, tag) {
  const TYPED = 'No notices served since COD. Seller’s counsel confirmed on November 14; the register is in 4.2.';
  const questionId = await page.evaluate((dealId) => {
    const question = Object.values(store.get().questions).find((q) => q.n === 81 && q.dealId === dealId);
    store.ui({ selectedQuestion: question.id, dialog: { kind: 'resolveQa', dealId, questionId: question.id } });
    return question.id;
  }, dealId);
  await page.click('#rsv-merge');
  await page.waitForFunction(() => document.querySelector('#rsv-merged')?.value);
  await page.fill('#rsv-merged', TYPED);
  const keptMerge = ([id, text]) => (JSON.parse(localStorage.getItem('dil/1/kept-drafts') ?? '{}')['qa-merge'] ?? [])
    .some(([key, draft]) => key === id && draft.text === text);
  await page.waitForFunction(keptMerge, [questionId, TYPED]);
  await page.evaluate(async ([dealId, id, LOG]) => {
    const { last } = store.get().deals[dealId].qaLogs[0];
    await window.__peer.change(id, { response: LOG, logPick: { of: last.at, sent: last.kept[id] } });
  }, [dealId, questionId, LOG]);
  await page.waitForSelector('#rsv-done');
  const tip = await page.getAttribute('#rsv-done', 'title');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.rsvdlg', { state: 'detached' });
  const box = () => page.evaluate(() => ({
    text: document.querySelector('textarea.rtext')?.value,
    note: document.querySelector('.efstate.ext')?.textContent ?? '',
  }));
  await page.waitForFunction((text) => document.querySelector('textarea.rtext')?.value === text, TYPED, { timeout: 8000 })
    .catch(() => {});
  const shown = await box();
  say(tag + 'a-typed-merge-resolved-elsewhere-waits-in-the-response-box',
    shown.text === TYPED && /^Changed elsewhere/.test(shown.note) && !!tip, JSON.stringify({ shown, tip }));

  await page.reload(); await page.waitForSelector('.dtabs', { state: 'attached' });
  await page.evaluate((id) => store.ui({ selectedQuestion: id }), questionId);
  await page.waitForFunction((text) => document.querySelector('textarea.rtext')?.value === text, TYPED, { timeout: 8000 })
    .catch(() => {});
  const reloaded = await box();
  await page.click('.efstate.ext button:first-of-type');
  await page.waitForFunction(([id, text]) => store.get().questions[id].response === text, [questionId, TYPED], { timeout: 8000 })
    .catch(() => {});
  const used = await page.evaluate((id) => store.get().questions[id].response, questionId);
  say(tag + 'the-typed-merge-survives-a-reload-and-keep-mine-uses-it',
    reloaded.text === TYPED && /^Changed elsewhere/.test(reloaded.note) && used === TYPED,
    JSON.stringify({ reloaded, used }));
}

for (const [w, h] of [[1280, 736], [1024, 640]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-create'); await page.waitForSelector('.dtabs');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  // through the app's own commands, as an import and an update leave them: every 19th question answered and in two
  // versions (every fifth of those with an Open status in the log), 207 others changed in the log
  await page.evaluate(async ([d, N, TWO, CHANGED, APP, LOG]) => {
    const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true }); const both = (n) => n % 19 === 5 && Math.floor(n / 19) < TWO;
    const rows = Array.from({ length: N }, (_, k) => ({ line: k + 2, n: k + 1, text: `Has any party served notice under PPA ${k + 1}?`, response: both(k + 1) ? APP : '', askedBy: 'Lender A', received: '', workstream: 'Legal', priority: 'High', respondedBy: '', responded: '', status: both(k + 1) ? 'answered' : 'open' }));
    await run('ImportQuestions', { dealId: d, mode: 'append', rows });
    const kept = {}, changed = {}, sent = {}; let two = 0, chg = 0;
    for (const q of Object.values(store.get().questions).filter((x) => x.dealId === d).sort((a, b) => a.n - b.n)) {
      // what the update wrote, for every row, as a real update leaves it: the log's record is then the size of the whole log
      sent[q.id] = { text: q.text, response: q.response, askedBy: q.askedBy, workstream: q.workstream, priority: q.priority, status: q.status };
      if (both(q.n)) { kept[q.id] = { response: LOG, ...(two % 5 === 1 ? { status: 'Open' } : {}) }; two++; } else if (q.n % 10 === 3 && chg < CHANGED) { changed[q.id] = { priority: 'Low' }; chg++; }
    }
    await run('KeepQaLog', { dealId: d, log: { name: 'Q&A log', file: 'Q&A log.xlsx', folder: 'X:\\Deals\\Proseware', sheet: 'Log', headerRow: 1, mapping: {} } });
    await run('RecordQaLogExport', {
      dealId: d,
      name: 'Q&A log',
      last: { archive: '', at: '2026-11-15T16:02:00.000Z', by: 'jdoe', sent, kept, changed },
    });
  }, [id, N, TWO, CHANGED, APP, LOG]);
  const qid = (n) => page.evaluate((n) => Object.values(store.get().questions).find((q) => q.n === n).id, n); const [Q5, Q24] = [await qid(5), await qid(24)];
  await page.goto(URL + '#qa-' + id); await page.waitForTimeout(300);
  await page.evaluate(() => { store.ui({ qaFilter: { status: 'versions', workstream: '', text: '' } }); for (const t of store.get().ui.toasts) store.dismissToast(t.id); });
  await page.waitForSelector('.md .li.cfrow');
  const tag = `${w}:`;
  const count = () => page.evaluate(() => ((e) => e.title || e.textContent)(document.querySelector('[data-qaf="versions"]')));
  say(tag + 'the-filter-lists-all-in-two-versions-and-offers-resolve', (await count()).includes(String(TWO)) && !!(await page.$('#qa-resolve')), await count());

  // with Changed and Two versions beside the other filters the controls still fit: the row never wraps, so it gives way in
  // steps until nothing runs past its right edge, Add and More included, and a named workstream button keeps #430's
  // floor
  const fits = await page.evaluate(() => {
    const t = document.querySelector('.trk-tools');
    const width = (el) => Math.round(el.getBoundingClientRect().width);
    const named = t.querySelector('#qa-ws.named');
    return { lvl: t.className, over: t.scrollWidth - t.clientWidth, r: Math.round(t.getBoundingClientRect().right),
      last: Math.round(t.querySelector('.qacts').getBoundingClientRect().right), ws: named ? width(named) : 64,
      filter: width(t.querySelector('input.field') ?? t.querySelector('#qa-find')) };
  });
  say(tag + 'the-controls-fit-with-changed-and-two-versions-shown', fits.over <= 1 && fits.last <= fits.r && fits.ws >= 63, JSON.stringify(fits));

  // a row opens Resolve at that question
  await page.click('.md .li.cfrow >> nth=1'); await page.waitForSelector('.rsvdlg');
  const opened = await page.evaluate(() => ({
    pos: document.querySelector('#rsv-pos').textContent,
    title: document.querySelector('.rsvdlg h2').textContent,
    number: document.querySelector('.rsv-k').textContent,
    keep: document.querySelector('#rsv-keep').disabled,
    marks: document.querySelectorAll('.rsvdlg mark').length,
  }));
  // the differing words are not underlined: most versions differ in every word
  const openedRight = opened.pos === `2 of ${TWO}` && opened.title === 'Resolve Two Versions'
    && opened.number === 'Q24' && opened.keep && opened.marks === 0;
  say(tag + 'a-row-opens-resolve-at-that-question-with-nothing-underlined', openedRight,
    JSON.stringify(opened));
  // the body scrolls as one: no box scrolls on its own
  const own = await page.evaluate(() => [...document.querySelectorAll('.rsv-r')].some((r) => r.scrollHeight > r.clientHeight + 1));
  say(tag + 'no-version-box-scrolls-on-its-own', !own);

  // 2 picks the log's, which also brings its Open status; the main button says so; it steps on with Undo
  await page.keyboard.press('2');
  const picked = await page.evaluate(() => ({ main: document.querySelector('#rsv-keep').textContent, checked: document.querySelector('[data-pick="log"]').getAttribute('aria-checked') }));
  say(tag + 'key-2-picks-the-logs-and-keep-selected-is-on', picked.main === 'Keep Selected'
    && picked.checked === 'true', JSON.stringify(picked));
  // design B: Previous, Next and the position in the footer, on Keep Selected's line, what is left as the position's
  // tooltip; a picked card's edge in gray (--ink-2)
  const foot = await page.evaluate(() => {
    const mid = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return r.top + r.height / 2;
    };
    const parts = ['#rsv-prev', '#rsv-next', '#rsv-pos'];
    const probe = document.createElement('i'); probe.style.color = 'var(--ink-2)'; document.body.append(probe);
    const ink2 = getComputedStyle(probe).color; probe.remove();
    return {
      inFoot: parts.every((sel) => document.querySelector(sel).closest('.xfoot')),
      off: Math.max(...parts.map((sel) => Math.abs(mid(sel) - mid('#rsv-keep')))),
      left: document.querySelector('#rsv-pos').title,
      gray: getComputedStyle(document.querySelector('[data-pick="log"]')).outlineColor === ink2,
    };
  });
  const footRight = foot.inFoot && foot.off <= 0.5 && foot.left === `${TWO} left to resolve`;
  say(tag + 'the-stepper-sits-in-the-footer-and-a-pick-is-gray', footRight && foot.gray, JSON.stringify(foot));
  await page.click('#rsv-keep'); await page.waitForFunction(() => document.querySelector('#rsv-pos')?.textContent.startsWith('3 of'));
  const took = await page.evaluate((Q24) => ({
    q: store.get().questions[Q24],
    toast: document.querySelector('#toast .ttext')?.textContent,
    undo: document.querySelector('#toast .tundo')?.textContent,
    number: document.querySelector('.rsv-k').textContent,
    left: document.querySelector('#rsv-pos').title,
  }), Q24);
  const tookRight = took.q.response === LOG && took.q.status === 'open' && took.number === 'Q43';
  const tookSaid = /^Q24: the log’s version taken/.test(took.toast) && took.undo === 'Undo'
    && took.left === `${TWO - 1} left to resolve`;
  say(tag + 'taking-the-logs-sets-its-response-and-status-and-steps-on', tookRight && tookSaid,
    JSON.stringify({ ...took, q: [took.q.response, took.q.status] }));
  await page.keyboard.press('Escape'); await page.click('#toast .tundo');
  await page.waitForFunction((Q24) => store.get().questions[Q24].response !== 'No notices served since COD. Confirmed by seller’s counsel on November 14.', Q24, { timeout: 5000 });
  const undone = await page.evaluate((Q24) => ({ st: store.get().questions[Q24].status, n: ((e) => e.title || e.textContent)(document.querySelector('[data-qaf="versions"]')) }), Q24);
  say(tag + 'undo-puts-it-back-in-two-versions', undone.st === 'answered' && undone.n.includes(String(TWO)), JSON.stringify(undone));

  // Resolve from the toolbar starts at the first; 1 keeps the app's; a merged response is one answer, never with notes to confirm
  await page.click('#qa-resolve'); await page.waitForSelector('.rsvdlg');
  const first = await page.evaluate(() => {
    const pos = document.querySelector('#rsv-pos');
    return [pos.textContent, pos.title];
  });
  const firstRight = first.join() === `1 of ${TWO},${TWO} left to resolve`;
  say(tag + 'resolve-starts-at-the-first-and-undo-counts-it-again', firstRight,
    JSON.stringify(first));
  // the third choice: a card in the same group as the two versions, the same width as both and under them
  const third = await page.evaluate(() => { const m = document.querySelector('#rsv-merge'), r = (e) => e.getBoundingClientRect(), a = r(document.querySelector('[data-pick="app"]')), l = r(document.querySelector('[data-pick="log"]')), b = r(m);
    return { text: m.textContent, role: m.getAttribute('role'), group: m.closest('[role="radiogroup"]')?.querySelectorAll('[role="radio"]').length, same: getComputedStyle(m).borderRadius === getComputedStyle(document.querySelector('[data-pick="app"]')).borderRadius, wide: Math.abs(b.left - a.left) < 1 && Math.abs(b.right - l.right) < 1, under: b.top > a.bottom, head: document.querySelector('.rsv-m .rsv-l b').textContent }; });
  const thirdPlace = third.role === 'radio' && third.group === 3 && third.same && third.wide && third.under;
  say(tag + 'merge-both-versions-is-a-third-choice-card-under-the-two',
    third.text === 'AIMerge Both Versions' && thirdPlace && third.head === 'Merged', JSON.stringify(third));
  await page.keyboard.press('3'); await page.waitForFunction(() => document.querySelector('#rsv-merged')?.value);
  const m = await page.evaluate(() => ({ again: !!document.querySelector('#rsv-again'), button: !!document.querySelector('#rsv-merge'), text: document.querySelector('#rsv-merged').value, main: document.querySelector('#rsv-keep').textContent, label: document.querySelector('.rsv-m .rsv-l span').textContent }));
  say(tag + 'a-merged-draft-is-one-answer-labeled-ai', m.main === 'Keep Selected' && m.again && !m.button
    && m.label === 'Drafted by AI' && !/\[|to confirm/i.test(m.text)
    && m.text.split('No notices served since COD.').length === 2, JSON.stringify(m));
  // an edited merged response survives stepping away, Escape and opening Resolve again (lost work comes first)
  await page.fill('#rsv-merged', m.text + ' Edited by hand.');
  // picking a version leaves the edited draft as the third card, with its text; 3, a click and Enter pick it again as it was, never drafting anew
  await page.click('.rsv-q'); await page.keyboard.press('1');
  const aside = await page.evaluate(() => ({ text: document.querySelector('#rsv-merge')?.textContent, checked: document.querySelector('[data-pick="app"]').getAttribute('aria-checked'), label: document.querySelector('.rsv-m .rsv-l span').textContent }));
  await page.keyboard.press('3'); await page.waitForSelector('#rsv-merged'); const by3 = await page.inputValue('#rsv-merged');
  const head = await page.evaluate(() => ((h) => ({ role: h.getAttribute('role'), checked: h.getAttribute('aria-checked'), radios: document.querySelectorAll('[role="radiogroup"] [role="radio"]').length }))(document.querySelector('#rsv-mhead')));
  await page.keyboard.press('2'); await page.click('#rsv-merge'); await page.waitForSelector('#rsv-merged'); const byClick = await page.inputValue('#rsv-merged');
  await page.click('.rsv-q'); await page.keyboard.press('2'); await page.focus('#rsv-merge'); await page.keyboard.press('Enter'); await page.waitForSelector('#rsv-merged'); const byEnter = await page.inputValue('#rsv-merged');
  say(tag + 'an-edited-draft-set-aside-stays-as-the-third-card-and-is-picked-again-as-it-was', aside.text.endsWith('Edited by hand.') && aside.checked === 'true' && aside.label === 'Drafted by AI, edited' && [by3, byClick, byEnter].every((t) => t === m.text + ' Edited by hand.'), JSON.stringify({ aside, by3: by3.slice(-16), byClick: byClick.slice(-16), byEnter: byEnter.slice(-16) }));
  say(tag + 'picked-the-merged-heading-is-the-checked-radio-of-three', head.role === 'radio' && head.checked === 'true' && head.radios === 3, JSON.stringify(head));
  // stepping away and back, or closing and opening again, keeps the edited merge and that side, and opens with nothing picked
  await page.click('#rsv-next'); await page.click('#rsv-prev'); await page.waitForSelector('#rsv-merge');
  const shown = () => page.evaluate(() => ({ card: document.querySelector('#rsv-merge')?.textContent, keep: document.querySelector('#rsv-keep').disabled, picked: [...document.querySelectorAll('[aria-checked="true"]')].length }));
  const back = await shown();
  await page.keyboard.press('Escape'); await page.waitForSelector('.rsvdlg', { state: 'detached' });
  await page.click('#qa-resolve'); await page.waitForSelector('#rsv-merge'); const reopened = await shown();
  await page.waitForTimeout(300);   // the dialog's keys are listened for once it has drawn
  await page.keyboard.press('3'); await page.waitForSelector('#rsv-merged');
  const again = await page.evaluate(() => ({ text: document.querySelector('#rsv-merged').value, side: [...document.querySelectorAll('.rsv-keep .seg button')].map((b) => b.getAttribute('aria-pressed')).join('|') }));
  say(tag + 'an-edited-merge-and-its-sides-are-kept-across-stepping-and-closing-and-it-opens-with-nothing-picked', [back, reopened].every((x) => x.card.endsWith('Edited by hand.') && x.keep && x.picked === 0) && again.text.endsWith('Edited by hand.'), JSON.stringify({ back, reopened, again }));
  await page.click('#rsv-keep'); await page.waitForFunction(() => document.querySelector('#rsv-pos')?.textContent.startsWith('2 of'));
  // a merged response's side for Status (here the log's "Open") is kept with it across stepping
  await page.keyboard.press('3'); await page.waitForSelector('.rsv-keep .seg button'); await page.click('.rsv-keep .seg button:nth-child(2)');
  await page.click('#rsv-next'); await page.click('#rsv-prev'); await page.waitForSelector('#rsv-merge'); await page.keyboard.press('3'); await page.waitForSelector('.rsv-keep .seg button');
  const side = await page.evaluate(() => [...document.querySelectorAll('.rsv-keep .seg button')].map((b) => b.getAttribute('aria-pressed')).join('|'));
  say(tag + 'a-merged-responses-status-side-is-kept-with-it', side === 'false|true', side);
  await page.click('.rsv-q'); await page.keyboard.press('1'); await page.click('#rsv-keep'); await page.waitForFunction(() => document.querySelector('#rsv-pos')?.textContent.startsWith('3 of'));
  const kept = await page.evaluate(([Q5, Q24]) => ({ q5: store.get().questions[Q5], q24: store.get().questions[Q24], n: ((e) => e.title || e.textContent)(document.querySelector('[data-qaf="versions"]')) }), [Q5, Q24]);
  say(tag + 'merged-and-the-apps-are-used-and-leave-the-filter', kept.q5.response.includes('seller’s counsel') && kept.q24.response === APP && kept.q24.status === 'answered' && kept.n.includes(String(TWO - 2)), JSON.stringify({ q5: kept.q5.response, q24: kept.q24.response, n: kept.n }));
  // a draft on its way is asked for once, however often 3 is pressed; Keep Selected works on a version meanwhile; what
  // is typed after it lands stays
  await page.evaluate(() => { const ai = store.services.ai, real = ai.merge; window.__asked = 0; ai.merge = (i) => new Promise((done) => { window.__asked++; window.__land = () => { ai.merge = real; done(real(i)); }; }); });
  await page.keyboard.press('3'); await page.keyboard.press('1');
  const waiting = await page.evaluate(() => ({ label: document.querySelector('.rsv-m .rsv-l span')?.textContent, keep: document.querySelector('#rsv-keep').disabled }));
  await page.keyboard.press('3'); await page.keyboard.press('1'); await page.click('#rsv-merge');
  const asked = await page.evaluate(() => { const n = window.__asked; window.__land(); return n; }); await page.waitForFunction(() => document.querySelector('#rsv-merged')?.value && !document.querySelector('#rsv-merged').disabled);
  say(tag + 'a-draft-on-its-way-is-asked-for-once-and-does-not-hold-keep-selected', asked === 1 && waiting.label === 'Drafting' && waiting.keep === false, JSON.stringify({ asked, waiting }));
  // emptied, it is the offer again; a draft that fails says so, and the card offers it again
  await page.fill('#rsv-merged', ''); await page.click('.rsv-q'); await page.keyboard.press('1');
  const emptied = await page.textContent('#rsv-merge');
  await page.evaluate(() => { window.__fail = { merge: true }; }); await page.keyboard.press('3'); await page.waitForSelector('.rsv-m [role="alert"]');
  const failed = await page.evaluate(() => ({ alert: document.querySelector('.rsv-m [role="alert"]').textContent, keep: document.querySelector('#rsv-keep').disabled, box: !!document.querySelector('#rsv-merged') }));
  await page.evaluate(() => { window.__fail = {}; }); await page.keyboard.press('1'); await page.keyboard.press('3'); await page.waitForFunction(() => document.querySelector('#rsv-merged')?.value);
  say(tag + 'an-emptied-draft-is-the-offer-again-and-a-failed-one-says-so-and-can-be-asked-again',
    emptied === 'AIMerge Both Versions' && /^No merged draft/.test(failed.alert) && failed.keep && !failed.box,
    JSON.stringify({ emptied, failed }));
  await page.click('.rsv-q'); await page.keyboard.press('1');
  // a choice writes its question only, so another PC resolving a different question at the same
  // time puts nothing in two versions, and every choice is small whatever the size of the log
  // a reply that comes in after Resolve was closed and opened again is shown at once
  await page.evaluate(() => { const ai = store.services.ai, real = ai.merge; ai.merge = (i) => new Promise((done) => { window.__land = () => { ai.merge = real; done(real(i)); }; }); });
  await page.keyboard.press('3'); await page.keyboard.press('Escape'); await page.waitForSelector('.rsvdlg', { state: 'detached' });
  await page.evaluate(() => store.ui({ dialog: { kind: 'resolveQa', dealId: Object.values(store.get().deals)[0].id, questionId: Object.values(store.get().questions).find((q) => q.n === 43).id } })); await page.waitForSelector('#rsv-merge');
  await page.evaluate(() => window.__land()); await page.waitForTimeout(300);
  const late = await page.evaluate(() => ({ label: document.querySelector('.rsv-m .rsv-l span')?.textContent ?? '', card: document.querySelector('#rsv-merge')?.textContent ?? '' }));
  say(tag + 'a-reply-that-comes-in-after-reopening-is-shown', late.label === 'Drafted by AI' && late.card.startsWith('No notices'), JSON.stringify(late));
  // the arrow keys move between the three choices, picking a version as they go
  await page.focus('[data-pick="app"]'); await page.keyboard.press('ArrowRight');
  const r1 = await page.evaluate(() => [document.activeElement?.dataset.pick, document.querySelector('[data-pick="log"]').getAttribute('aria-checked')]);
  await page.keyboard.press('ArrowDown'); await page.waitForSelector('#rsv-merged'); await page.waitForFunction(() => document.activeElement?.id === 'rsv-mhead', null, { timeout: 2000 }).catch(() => {}); const r2 = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.press('ArrowDown'); const r3 = await page.evaluate(() => [document.activeElement?.dataset.pick, document.querySelector('[data-pick="app"]').getAttribute('aria-checked')]);
  say(tag + 'arrow-keys-move-between-the-three-choices', r1.join() === 'log,true' && r2 === 'rsv-mhead' && r3.join() === 'app,true', JSON.stringify([r1, r2, r3]));
  await page.click('.rsv-q');
  // another PC resolves Q195 (keeps the app's), and this one Q43, at the same time
  const other = await page.evaluate(async (LOG) => { const q = Object.values(store.get().questions).find((x) => x.n === 195); const of = store.get().deals[q.dealId].qaLogs[0].last.at;
    await window.__peer.change(q.id, { logPick: { of, sent: { response: LOG } } }); return q.id; }, LOG);
  await page.waitForFunction((id) => !!store.get().questions[id].logPick, other, { timeout: 8000 });
  await page.click('.rsv-q');
  await page.keyboard.press('1');
  await page.click('#rsv-keep');
  await page.waitForFunction(() => document.querySelector('.rsv-k')?.textContent !== 'Q43');
  const two = await page.evaluate(() => ({ conflicts: Object.keys(store.get().conflicts).length, n: ((e) => e.title || e.textContent)(document.querySelector('[data-qaf="versions"]')), toast: document.querySelector('#toast .ttext')?.textContent }));
  say(tag + 'another-pc-resolving-another-question-puts-nothing-in-two-versions', two.conflicts === 0 && two.n.includes(String(TWO - 4)) && /^Q43: the app’s version kept/.test(two.toast), JSON.stringify(two));
  await page.keyboard.press('Escape'); await page.waitForSelector('.rsvdlg', { state: 'detached' });
  if (w === 1280) await keepDisplayedStatusAfterRefresh(page, id, tag);
  if (w === 1280) await keepTypedMergeResolvedElsewhere(page, id, tag);
  say(tag + 'no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
