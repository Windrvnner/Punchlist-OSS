// Shared work between PCs, as a person meets it: a record changed in two places, a deal whose changes cannot be read,
// and how current the other PCs are. window.__peer stands in for the other PC (see shell/main.tsx).
import { launchChrome } from './chrome.mjs';
import { openDealMenu } from './dealMenu.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
async function start(scheme = 'dark', name = 'Proseware') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  return { ctx, page, id: await page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === 'Project ' + n).id, name) };
}
const newQ = (page, dealId, text) => page.evaluate(async ([d, t]) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal', askedBy: 'Lender group' }); return store.get().ops[r.value.opId].targets.find((x) => store.get().questions[x]); }, [dealId, text]);
// the pointer is moved off first: toasts stack in one place now, and one under the pointer waits
const toastsGone = async (page) => { await page.mouse.move(2, 400); return page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 12000 }); };
// What the other PCs have written, and which deals wait on a change that has not arrived: __peer.sync writes it as lines from
// those PCs. This PC is the demo's own ("This PC"); a PC that has written nothing is not known until it writes.
const SYNC = (holding = []) => ({ self: { id: 'pc1', label: 'PC A' }, peers: [{ id: 'pc2', label: 'PC B', by: 'jdoe', lastChangeAt: '2026-11-09T23:14:00.000Z' }, { id: 'pc3', label: 'HC-LT-0412', by: 'sroe', lastChangeAt: null }], holding });

for (const scheme of ['dark', 'light']) {
  const { ctx, page, id } = await start(scheme);
  await page.evaluate((x) => __peer.sync(x), SYNC());
  const qs = []; for (const t of ['Please confirm the distribution lock-up ratio.', 'Provide the executed capacity agreement.', 'Which operating assumption does the base case use?']) qs.push(await newQ(page, id, t));
  await page.evaluate(async ([d, q]) => { await store.dispatch(store.commandNamed('SetResponse'), { dealId: d, questionId: q, response: 'The draft sets the lock-up at 1.25x.' }); }, [id, qs[0]]);

  // ---- a question changed in two places --------------------------------------------------------------------------
  const same = await page.evaluate((q) => __peer.edit(q, {}, { by: 'jdoe', from: 'PC B', at: '2026-11-09T23:14:00.000Z' }), qs[1]);
  const made = await page.evaluate((q) => __peer.edit(q, { response: 'Lock-up is 1.30x, as in the signed term sheet.', respondedBy: 'Sponsor', status: 'answered' }, { by: 'jdoe', from: 'PC B', at: '2026-11-09T23:14:00.000Z' }), qs[0]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li[data-conflict]');
  const marks = {};
  for (const f of ['Open', 'Answered', 'Closed', 'All']) { await page.click(`.trk-tools .seg button:has-text("${f}")`); marks[f] = await page.evaluate(() => ({ rows: document.querySelectorAll('.md .li').length, marked: [...document.querySelectorAll('.md .li[data-conflict]')].map((e) => e.title) })); }
  await page.click('.trk-tools .seg button:has-text("Open")');
  say(`${scheme}:same-content-is-not-a-clash`, same === 'same' && made === 'conflict' && marks.All.marked.length === 1, JSON.stringify({ same, made }));
  // listed under either version's status (one Open, one Answered), and not under Closed, which neither is; its row says Two versions
  say(`${scheme}:a-clash-is-marked-on-its-row-under-either-versions-status`, ['Open', 'Answered', 'All'].every((f) => marks[f].marked.join() === 'Two versions: open it to choose one') && marks.Closed.rows === 0 && marks.All.rows === 3, JSON.stringify(marks));
  await page.click('.md .li[data-conflict]'); await page.waitForSelector('#conflict');
  const view = await page.evaluate(() => { const vs = [...document.querySelectorAll('#conflict .cfl-v')]; const top = (v, f) => Math.round(v.querySelector(`[data-field="${f}"]`).getBoundingClientRect().top);
    return {
      head: document.querySelector('#conflict .cfl-sub').title,
      title: document.querySelector('#conflict .cfl-title').textContent,
      who: vs.map((v) => v.querySelector('.cfl-who').textContent),
      fields: vs.map((v) => [...v.querySelectorAll('[data-field]')].map((e) => e.dataset.field)),
      response: vs.map((v) => v.querySelector('[data-field="response"] .cfl-val').textContent),
      aligned: ['response', 'status', 'respondedBy'].every((f) => top(vs[0], f) === top(vs[1], f)), sideBySide: vs[0].getBoundingClientRect().right <= vs[1].getBoundingClientRect().left, keeps: document.querySelectorAll('#conflict .cfl-v[role="radio"]').length, keepOff: document.querySelector('#conflict .cfl-keep')?.disabled, editors: document.querySelectorAll('.det textarea, .det select, .det input').length }; });
  // design B: the question's own text heads it, and what happened is the "Two Versions" line's tooltip
  const viewHead = view.head === 'Q1 was changed in two places at once. Choose the version to keep.'
    && view.title === 'Please confirm the distribution lock-up ratio.';
  const responses = ['Lock-up is 1.30x, as in the signed term sheet.', 'The draft sets the lock-up at 1.25x.'];
  const viewFields = view.fields.every((f) => f.join() === 'response,status,respondedBy')
    && view.response.join('|') === responses.join('|');
  const viewCards = /^PC B/.test(view.who[0]) && /^This PC/.test(view.who[1]) && view.aligned && view.sideBySide;
  // design B: nothing picked until a person picks
  say(`${scheme}:both-versions-side-by-side-only-where-they-differ`,
    viewHead && viewFields && viewCards && view.keeps === 2 && view.keepOff === true, JSON.stringify(view));
  say(`${scheme}:a-record-in-a-clash-has-nothing-to-type-in`, view.editors === 0);
  // the Q&A panel heads the versions with the question's number, as Resolve does, and has the stepper
  const panelHead = await page.evaluate(() => ({
    number: document.querySelector('#conflict .cfl-head .rsv-k')?.textContent,
    stepper: !!document.querySelector('#conflict #cfl-pos'),
  }));
  say(`${scheme}:the-qa-panel-numbers-the-question-and-steps`, panelHead.number === 'Q1' && panelHead.stepper,
    JSON.stringify(panelHead));
  // on the question's Discuss page there is no stepper, as stepping would leave the page, and Keep stays on it
  await page.goto(URL + `#q-${id}-${qs[0]}`);
  await page.waitForSelector('.opening #conflict');
  await page.click('#conflict .cfl-v >> nth=0');
  const discuss = await page.evaluate(() => ({
    stepper: document.querySelectorAll('#conflict #cfl-pos, #conflict #cfl-prev, #conflict #cfl-next').length,
    keep: !!document.querySelector('#conflict .cfl-keep:not(:disabled)'),
  }));
  const discussHash = await page.evaluate(() => location.hash);
  await page.click('#conflict .cfl-keep');
  await page.waitForFunction((q) => !store.get().conflicts[q], qs[0]);
  await page.waitForTimeout(300);
  const keptHash = await page.evaluate(() => location.hash);
  say(`${scheme}:a-discuss-page-has-no-stepper-and-keep-stays-on-it`,
    discuss.stepper === 0 && discuss.keep && keptHash === discussHash,
    JSON.stringify({ discuss, discussHash, keptHash }));
  // Undo brings the two versions back for the steps below
  await page.waitForSelector('#toast .tundo', { timeout: 3000 });
  await page.click('#toast .tundo');
  await page.waitForFunction((q) => !!store.get().conflicts[q], qs[0]);
  await toastsGone(page);
  await page.goto(URL + '#qa-' + id);
  await page.waitForSelector('.md .li[data-conflict]');
  // nothing else in the log is affected
  await page.click('.md .li >> nth=1'); await page.waitForSelector('.det textarea.qtext'); await page.fill('.det textarea.qtext', 'Provide the executed capacity agreement, with schedules.'); await page.press('.det textarea.qtext', 'Tab');
  await page.waitForFunction((q) => store.get().questions[q].text === 'Provide the executed capacity agreement, with schedules.', qs[1]);
  const others = await page.evaluate(() => ({ clashes: Object.keys(store.get().conflicts).length, rows: document.querySelectorAll('.md .li').length, marked: document.querySelectorAll('.md .li[data-conflict]').length, selects: document.querySelectorAll('.det [role="combobox"]').length }));
  say(
    `${scheme}:the-other-questions-stay-editable`,
    // selects: Status and Workstream; Priority shows only when a question has one
    others.clashes === 1 && others.rows === 3 && others.marked === 1 && others.selects >= 2,
    JSON.stringify(others),
  );
  // a command aimed at the record in a clash is refused, with the reason
  const refused = await page.evaluate(async ([d, q]) => { const r = await store.dispatch(store.commandNamed('DeleteQuestion'), { dealId: d, questionId: q }); return { ok: r.ok, toast: document.querySelector('#toast .ttext')?.textContent }; }, [id, qs[0]]);
  say(`${scheme}:an-action-on-it-is-refused-and-says-why`, refused.ok === false && refused.toast === 'Q1 has two versions. Choose one first', JSON.stringify(refused));
  await toastsGone(page);
  // choosing, and taking the choice back
  await page.click('.md .li[data-conflict]');
  await page.waitForSelector('#conflict');
  await page.click('#conflict .cfl-v >> nth=0');
  await page.waitForTimeout(300);   // the edge's color fades in
  // a pick is marked in gray: the card's edge in --ink-2, and Keep names the choice
  const pickedCard = await page.evaluate(() => {
    const probe = document.createElement('i'); probe.style.color = 'var(--ink-2)'; document.body.append(probe);
    const ink2 = getComputedStyle(probe).color; probe.remove();
    const card = document.querySelector('#conflict .cfl-v.on');
    const keep = document.querySelector('#conflict .cfl-keep').textContent;
    return { gray: getComputedStyle(card).borderTopColor === ink2, keep };
  });
  const keepNamed = pickedCard.keep === 'Keep PC B’s Version';
  say(`${scheme}:a-picked-version-is-gray-and-keep-names-it`, pickedCard.gray && keepNamed, JSON.stringify(pickedCard));
  await page.click('#conflict .cfl-keep');
  await page.waitForFunction((q) => !store.get().conflicts[q], qs[0]); await page.waitForSelector('#toast .ttext', { timeout: 3000 }).catch(() => {});   // said once the journal has the choice
  const kept = await page.evaluate((q) => ({ response: store.get().questions[q].response, status: store.get().questions[q].status, toast: document.querySelector('#toast .ttext')?.textContent, undo: document.querySelector('#toast .tundo')?.textContent, marked: document.querySelectorAll('.md .li[data-conflict]').length }), qs[0]);
  say(`${scheme}:keeping-a-version-ends-the-clash`, kept.response === 'Lock-up is 1.30x, as in the signed term sheet.' && kept.status === 'answered' && kept.toast === 'Kept the version from PC B' && kept.undo === 'Undo' && kept.marked === 0, JSON.stringify(kept));
  await page.click('#toast .tundo'); await page.waitForFunction((q) => !!store.get().conflicts[q], qs[0]);
  const back = await page.evaluate((q) => ({ versions: store.get().conflicts[q].versions.map((v) => v.from), marked: document.querySelectorAll('.md .li[data-conflict]').length }), qs[0]);
  say(`${scheme}:undo-brings-both-versions-back`, back.versions.join() === 'PC B,This PC' && back.marked === 1, JSON.stringify(back));
  await page.reload(); await page.waitForSelector('.md .li[data-conflict]');
  say(`${scheme}:a-clash-is-still-there-after-a-restart`, (await page.evaluate(() => Object.keys(store.get().conflicts).length)) === 1);
  await toastsGone(page);

  // ---- a finding changed in two places ---------------------------------------------------------------------------
  const fs = await page.evaluate((d) => Object.values(store.get().findings).filter((x) => x.dealId === d).sort((a, b) => ['Technical', 'Lock-up', 'Revenue'].findIndex((t) => a.title.startsWith(t)) - ['Technical', 'Lock-up', 'Revenue'].findIndex((t) => b.title.startsWith(t))).map((f) => f.id), id);
  await page.evaluate((f) => __peer.edit(f, { status: 'closed', note: 'Sponsor confirmed 1.30x.' }, { by: 'sroe', from: 'HC-LT-0412', at: '2026-11-10T09:05:00.000Z' }), fs[1]);
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow [data-conflict]');
  const flist = await page.evaluate(() => ({ rows: document.querySelectorAll('.flagrow').length, marked: [...document.querySelectorAll('.flagrow')].filter((r) => r.querySelector('[data-conflict]')).length, mark: document.querySelector('.flagrow [data-conflict]').textContent }));
  say(`${scheme}:a-finding-in-a-clash-stays-in-the-list-and-is-marked`, flist.rows === 3 && flist.marked === 1 && flist.mark === 'Two versions', JSON.stringify(flist));
  await page.click('.flagrow:has([data-conflict])'); await page.waitForSelector('#conflict');
  const fview2 = await page.evaluate(() => ({
    head: document.querySelector('#conflict .cfl-sub').title,
    f0: [...document.querySelector('#conflict .cfl-v').querySelectorAll('[data-field]')].map((e) => e.dataset.field),
    controls: document.querySelectorAll('#f-review, #f-status, #f-edit, #f-delete').length,
    wide: document.querySelector('#conflict .cfl-v').getBoundingClientRect().width,
  }));
  say(`${scheme}:a-finding-shows-its-versions-in-place-of-its-controls`, /^The finding “Lock-up ratio in the credit agreement draft differs from th…” was changed in two places at once\./.test(fview2.head) && fview2.f0.join() === 'status,note' && fview2.controls === 0 && fview2.wide > 300, JSON.stringify(fview2));
  // the stepper stays on the page's kind of record: Q1 is in two versions too, but this is the only
  // finding
  const step = await page.evaluate(() => ({
    pos: document.querySelector('#cfl-pos')?.textContent,
    next: document.querySelector('#cfl-next')?.title,
    off: document.querySelector('#cfl-prev')?.disabled && document.querySelector('#cfl-next')?.disabled,
  }));
  say(`${scheme}:a-findings-stepper-goes-through-findings-only`,
    step.pos === '1 of 1' && step.next === 'Next finding with two versions' && step.off, JSON.stringify(step));
  await page.goto(URL + `#finding-${id}-${fs[0]}`); await page.waitForSelector('#f-review'); await page.click('#f-review');
  await page.waitForFunction((f) => !!store.get().findings[f].reviewed, fs[0]);
  say(`${scheme}:the-other-findings-are-not-affected`, (await page.evaluate(() => Object.keys(store.get().conflicts).length)) === 2);
  await toastsGone(page);

  // ---- the deal's own details changed in two places: only those details wait -------------------------------------
  await page.evaluate((d) => __peer.edit(d, { counterparty: 'Northwind Energy' }, { by: 'jdoe', from: 'PC B', at: '2026-11-09T23:20:00.000Z' }), id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.home.top > #conflict');
  // Rename and Delete deal… are in the header's ⋯ menu
  await openDealMenu(page);
  const dview = await page.evaluate(() => {
    const hov = (sel) => {
      const b = document.querySelector(sel);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const under = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return under?.closest('[title]')?.getAttribute('title') ?? null;
    };
    return {
      rename: hov('#deal-rename'),
      head: document.querySelector('.home.top > #conflict .cfl-sub').title,
      fields: [...document.querySelectorAll('.home.top > #conflict .cfl-v:first-child [data-field]')]
        .map((e) => e.dataset.field),
      ro: [...document.querySelectorAll('.tfacts input')].every((i) => i.readOnly),
    };
  });
  await page.keyboard.press('Escape');
  await page.click('.md .li >> nth=2'); await page.waitForSelector('.det textarea.rtext'); await page.fill('.det textarea.rtext', 'P50, per the technical advisor.'); await page.press('.det textarea.rtext', 'Tab');
  await page.waitForFunction((q) => store.get().questions[q].response === 'P50, per the technical advisor.', qs[2]);
  say(`${scheme}:a-clash-on-the-deal-details-does-not-stop-its-questions`, dview.head === 'Project Proseware was changed in two places at once. Choose the version to keep.' && dview.fields.join() === 'counterparty' && dview.ro
    && dview.rename === 'Project Proseware has two versions. Choose one first', JSON.stringify(dview));   // why Rename is off shows on hover
  await page.click('.home.top > #conflict .cfl-v >> nth=0'); await page.click('.home.top > #conflict .cfl-keep'); await page.waitForFunction((d) => !store.get().conflicts[d], id);
  const dkept = await page.evaluate((d) => ({ cp: store.get().deals[d].counterparty, shown: document.querySelector('.tfacts input').value, ro: document.querySelector('.tfacts input').readOnly }), id);
  say(`${scheme}:choosing-the-deal-version-frees-its-details`, dkept.cp === 'Northwind Energy' && dkept.shown === 'Northwind Energy' && !dkept.ro, JSON.stringify(dkept));
  await toastsGone(page);

  // ---- Home is the composer alone, even with other PCs and records in two versions ----------------------------
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask');
  const home = await page.evaluate(() => ({ sections: document.querySelectorAll('.home section').length, text: document.querySelector('.home').innerText.replace(/\s+/g, ' ').trim(), clashes: Object.keys(store.get().conflicts).length, peers: store.get().sync?.peers.length }));
  say(`${scheme}:home-is-the-composer-alone-with-other-pcs`, home.sections === 0 && home.clashes > 0 && home.peers > 0 && !/other PCs|versions/i.test(home.text), JSON.stringify(home));

  // ---- a change from another PC that waits on one that has not arrived stops nothing: the deal stays editable ----------------------------------
  await page.evaluate(([x, d]) => __peer.sync(x), [SYNC([id]), id]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li'); await page.click('.md .li >> nth=1'); await page.waitForSelector('.det textarea.qtext');
  // Rename and Delete deal… are in the header's ⋯ menu
  await openDealMenu(page);
  const open = await page.evaluate(() => { const hov = (sel) => { const b = document.querySelector(sel); if (!b) return null; const r = b.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[title]')?.getAttribute('title') ?? null; }; return { delHover: hov('.ddel'), waiting: store.get().sync?.waiting.length, fields: [...document.querySelectorAll('.det .ef, .tfacts .ef')].some((e) => e.readOnly), off: ['.det #q-status', '#qa-add', '#deal-rename', '.ddel'].filter((sel) => document.querySelector(sel)?.disabled), del: document.querySelector('.ddel')?.title }; });
  await page.keyboard.press('Escape');
  await page.fill('.det textarea.qtext', 'Provide the executed capacity agreement, all schedules.'); await page.press('.det textarea.qtext', 'Tab');
  await page.waitForFunction((q) => store.get().questions[q].text === 'Provide the executed capacity agreement, all schedules.', qs[1]);
  say(`${scheme}:a-held-change-stops-nothing-but-delete-deal`, open.waiting === 1 && !open.fields && open.off.join() === '.ddel' && open.del === 'Project Proseware can’t be deleted while changes to it from PC B are still arriving' && open.delHover === open.del, JSON.stringify(open));
  // the card above the account row says what waits, on hover; it is gone once nothing is wrong
  await page.hover('#u-menu'); await page.waitForSelector('#conncard:not([hidden])');
  const card = await page.evaluate(() => [...document.querySelectorAll('#conncard .cr')].map((r) => r.textContent.trim()));
  say(`${scheme}:the-card-says-what-waits`, card.length === 4 && card[3] === 'Sync: Waiting for PC B. 1 change from PC B.', JSON.stringify(card));
  await page.mouse.move(600, 300);
  await page.evaluate((x) => __peer.sync(x), SYNC()); await page.waitForFunction(() => store.get().sync?.waiting.length === 0);
  await page.hover('#u-menu'); say(`${scheme}:no-card-when-nothing-is-wrong`, await page.evaluate(() => !document.querySelector('#conncard')));
  await page.mouse.move(600, 300);

  // ---- the same number given twice: both kept and marked, and a person renumbers one ----------------------------------
  const twin = await page.evaluate((q) => __peer.add(q, { text: 'Added on PC B before PC A had synced.', response: '', status: 'open' }), qs[2]);
  await page.click('.trk-tools .seg button:has-text("All")'); await page.waitForSelector('.md .li[data-samenumber]');
  const both = await page.evaluate(() => ({ marks: [...document.querySelectorAll('.md .li[data-samenumber]')].map((e) => e.title), numbers: [...document.querySelectorAll('.md .li .n')].map((e) => e.textContent), clashes: Object.keys(store.get().conflicts).length }));
  await page.evaluate((t) => store.ui({ selectedQuestion: t }), twin); await page.waitForSelector('#q-samenumber');
  const offer = await page.evaluate(() => ({ line: document.getElementById('q-samenumber').textContent, editable: !document.querySelector('.det textarea.qtext').readOnly }));
  await page.click('#q-renumber'); await page.waitForFunction((t) => store.get().questions[t].n === 4, twin); await page.waitForSelector('#toast .ttext', { timeout: 3000 }).catch(() => {});   // said once the journal has it
  const after = await page.evaluate(([t, q]) => ({ twin: store.get().questions[t].n, other: store.get().questions[q].n, marks: document.querySelectorAll('.md .li[data-samenumber]').length, line: !!document.getElementById('q-samenumber'), toast: document.querySelector('#toast .ttext')?.textContent, undo: document.querySelector('#toast .tundo')?.textContent }), [twin, qs[2]]);
  say(`${scheme}:the-same-number-twice-keeps-and-marks-both`, both.marks.join() === 'Same number,Same number' && both.numbers.filter((n) => n === '3').length === 2 && both.clashes === 2 && offer.line === 'Another question is also numbered 3. Make this one Q4' && offer.editable, JSON.stringify({ both, offer }));
  say(`${scheme}:a-person-renumbers-one-of-them`, after.twin === 4 && after.other === 3 && after.marks === 0 && !after.line && after.toast === 'Q3 is now Q4' && after.undo === 'Undo', JSON.stringify(after));
  await toastsGone(page);

  // ---- deleted on another PC while it was being changed here -------------------------------------------------
  const dq = await newQ(page, id, 'Is there a decommissioning bond?');
  await page.evaluate(async ([d, q]) => { await store.dispatch(store.commandNamed('SetResponse'), { dealId: d, questionId: q, response: 'Yes, issued March 3.' }, { quiet: true }); }, [id, dq]);
  await page.evaluate((q) => __peer.remove(q, { by: 'sroe', from: 'PC B', at: '2026-11-12T15:04:00.000Z' }), dq);
  await page.goto(URL + '#qa-' + id); await page.click(`.md .li[data-q="${dq}"], .md .li:has-text("decommissioning bond")`); await page.waitForSelector('#conflict');
  const dn = await page.evaluate((q) => store.get().questions[q].n, dq);
  const dv = await page.evaluate(() => ({
    head: document.querySelector('#conflict .cfl-sub').title,
    cards: [...document.querySelectorAll('#conflict .cfl-v')].map((v) => [
      v.querySelector('.cfl-who b').textContent,
      v.querySelector('[data-field="text"] .cfl-val')?.textContent ?? null,
    ]),
  }));
  say(`${scheme}:deleted-and-changed-are-two-versions-to-choose-between`, dv.head === `Q${dn} was deleted on PC B while it was being changed on This PC.` && JSON.stringify(dv.cards) === JSON.stringify([['This PC', 'Is there a decommissioning bond?'], ['PC BDeleted', 'Is there a decommissioning bond?']]), JSON.stringify(dv));   // the deleted version shows the words it held
  const qstep = await page.evaluate(() => ['#cfl-pos', '#cfl-prev'].map((sel) => {
    const part = document.querySelector(sel);
    return sel === '#cfl-pos' ? part?.textContent : part?.title;
  }));
  await page.click('#conflict .cfl-v >> nth=1');
  await page.click('#conflict .cfl-keep:has-text("Keep It Deleted")');
  await page.waitForFunction((q) => !store.get().questions[q], dq);
  await page.waitForSelector('#toast .ttext', { timeout: 3000 }).catch(() => {});
  const kd = await page.evaluate((q) => ({ tomb: !!store.get().tombstones[q], toast: document.querySelector('#toast .ttext')?.textContent, undo: document.querySelector('#toast .tundo')?.textContent }), dq);
  // Keep settles this question only: the panel stays on the Q&A page and does not open another record
  const stayed = await page.evaluate(() => location.hash.startsWith('#qa-'));
  const questionSteps = qstep.join() === '2 of 2,Previous question with two versions';
  say(`${scheme}:keep-on-a-questions-panel-stays-on-the-qa-page`, questionSteps && stayed,
    JSON.stringify({ qstep, stayed }));
  await page.click('#toast .tundo'); await page.waitForFunction((q) => !!store.get().conflicts[q], dq);
  await page.click('.md .li:has-text("decommissioning bond")');
  await page.waitForSelector('#conflict');
  await page.click('#conflict .cfl-v >> nth=0');
  await page.click('#conflict .cfl-keep:has-text("Keep This PC’s Version")');
  await page.waitForFunction((q) => !store.get().conflicts[q], dq);
  const kv = await page.evaluate((q) => ({ q: store.get().questions[q]?.response, tomb: !!store.get().tombstones[q] }), dq);
  say(`${scheme}:either-can-be-kept-with-undo`, kd.tomb && kd.toast === 'Kept it deleted' && kd.undo === 'Undo' && kv.q === 'Yes, issued March 3.' && !kv.tomb, JSON.stringify({ kd, kv }));
  await toastsGone(page);

  // ---- the version a choice did not keep is under Deleted, marked "Superseded by" whoever chose -------
  const sq = await newQ(page, id, 'Is the O&M agreement assignable to the lenders?');
  await page.evaluate(async ([d, q]) => { await store.dispatch(store.commandNamed('SetResponse'), { dealId: d, questionId: q, response: 'Yes, with notice to the operator.' }, { quiet: true }); }, [id, sq]);
  await page.evaluate((q) => __peer.edit(q, { ...store.get().questions[q], response: 'Only with the operator’s consent; see section 14.2.' }, { by: 'sroe', from: 'PC B', at: '2026-11-12T16:10:00.000Z' }), sq);
  await page.waitForFunction((q) => !!store.get().conflicts[q], sq);
  await page.evaluate(([d, q]) => store.dispatch(store.commandNamed('ResolveConflict'), { dealId: d, recordId: q, keep: store.get().conflicts[q].versions.find((v) => !v.here).id }, { quiet: true }), [id, sq]);
  await page.evaluate((d) => store.ui({ dialog: { kind: 'deleted', dealId: d } }), id); await page.waitForSelector('.delrow');
  const sup = await page.evaluate(() => [...document.querySelectorAll('.delrow')].filter((r) => r.textContent.includes('Yes, with notice to the operator.')).map((r) => r.querySelector('.dmeta').textContent));
  say(`${scheme}:a-version-not-kept-is-marked-superseded-under-deleted`, sup.length === 1 && /^This PC · Superseded by jdoe · \w{3} \d+, \d+:\d\d\s[AP]M$/.test(sup[0]), JSON.stringify(sup));
  await page.keyboard.press('Escape'); await page.waitForSelector('.delrow', { state: 'detached' });

  // ---- emptying a response says so, with Undo -----------------------------------------------------------------
  await page.click('.md .li:has-text("decommissioning bond")'); await page.waitForSelector('.det');
  const box = '.det textarea.rtext, .det .rtext textarea'; await page.fill(box, ''); await page.press(box, 'Tab');
  await page.waitForFunction(() => /Response removed/.test(document.querySelector('#toast .ttext')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  const wd = await page.evaluate((q) => ({ toast: document.querySelector('#toast .ttext')?.textContent, undo: document.querySelector('#toast .tundo')?.textContent, r: store.get().questions[q].response }), dq);
  await page.click('#toast .tundo'); await page.waitForFunction((q) => store.get().questions[q].response === 'Yes, issued March 3.', dq, { timeout: 5000 }).catch(() => {});
  const wb = await page.evaluate((q) => store.get().questions[q].response, dq);
  say(`${scheme}:emptying-a-response-says-so-with-undo`, wd.toast === `Response removed from Q${dn}` && wd.undo === 'Undo' && wd.r === '' && wb === 'Yes, issued March 3.', JSON.stringify({ wd, wb }));
  await toastsGone(page);

  // ---- the mark reads against its background -----------------------------------------------------------------------
  const ratio = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); const hex = (v) => { const h = v.trim().replace('#', ''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); }; const lum = (c) => { const f = (x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }; const a = lum(hex(cs.getPropertyValue('--high'))), b = lum(hex(cs.getPropertyValue('--surface'))); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); });
  say(`${scheme}:the-mark-meets-4.5-to-1`, ratio >= 4.5, ratio.toFixed(2));
  say(`${scheme}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
