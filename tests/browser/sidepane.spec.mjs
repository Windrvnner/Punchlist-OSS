// The side pane beside a conversation: a finding named in an answer, and an open question an answer may address;
// and the actions under an answer, as icons.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, String(note).slice(0, 300)); };
const browser = await launchChrome();
openOnFindings(browser);
async function fresh(width = 1280, height = 736, colorScheme = 'light') { const ctx = await browser.newContext({ viewport: { width, height }, colorScheme }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(URL); await page.waitForSelector('#fr-new'); return { ctx, page }; }
async function indexedDeal(page) {
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 30000 });
  return page.evaluate(() => Object.keys(store.get().deals)[0]);
}
/** a conversation on the deal with two answers: the first names the three findings, the second cites the documents */
async function twoAnswers(page, id) {
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('#pask');
  await page.fill('#pask', 'What are the three biggest issues?'); await page.press('#pask', 'Enter'); await page.waitForSelector('.msgs .ai:not(.pending):not(.failed)', { timeout: 8000 });
  await page.fill('#pask', 'Which of these would hold up financial close?'); await page.press('#pask', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.msgs .ai:not(.pending):not(.failed)').length === 2, null, { timeout: 8000 });
}
/** where the pane, the conversation and the composer are, and whether anything runs into anything else */
const layout = (page) => page.evaluate(() => {
  const R = (e) => e.getBoundingClientRect(); const pane = R(document.querySelector('#sidepane')); const rail = R(document.querySelector('.rail'));
  const chat = R(document.querySelector('.chat')); const comp = R(document.getElementById('pcomposer'));
  const out = [...document.querySelectorAll('#sidepane button, #sidepane a, #sidepane p')].filter((e) => e.getClientRects().length && (R(e).right > pane.right - 21 || R(e).left < pane.left + 21 || R(e).bottom > pane.bottom - 17)).length;
  const under = [...document.querySelectorAll('.msgs .me, .msgs .ai, .msgs .acts')].some((e) => R(e).right > pane.left - 12);
  const bar = [...document.querySelectorAll('#pcomposer .bar > *')].filter((e) => e.getClientRects().length).some((e) => R(e).right > comp.right - 8);
  return { rail: Math.abs(pane.top - rail.top) < 1 && Math.abs(pane.bottom - rail.bottom) < 1, chat: Math.round(chat.width), composer: Math.abs(comp.left - chat.left) < 1 && Math.abs(comp.right - chat.right) < 1 && comp.right < pane.left - 12, bar, out, under, actsRow: [...document.querySelectorAll('.msgs .acts')].every((e) => R(e).height <= 32) };
});

/** a question on the deal, with a response when one is given */
const addQ = (page, id, text, response = '') => page.evaluate(async ([d, t, r]) => { await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Technical' }); const q = Object.values(store.get().questions).find((x) => x.text === t); if (r) await store.dispatch(store.commandNamed('SetResponse'), { dealId: d, questionId: q.id, response: r }); return store.get().questions[q.id]; }, [id, text, response]);

// at 1280 light and at 1024 dark: the finding opens beside the conversation, which stays and makes room for it
for (const [w, h, scheme] of [[1280, 736, 'light'], [1024, 640, 'dark']]) {
  const { ctx, page } = await fresh(w, h, scheme);
  const id = await indexedDeal(page); await twoAnswers(page, id); const before = await page.evaluate(() => location.hash);
  await page.locator('.msgs .ai .ref .rb', { hasText: 'lock-up' }).click(); await page.waitForSelector('#sidepane .opening'); await page.waitForTimeout(600);
  const at = await layout(page);
  const shown = await page.evaluate((b) => ({ same: location.hash === b, title: document.querySelector('#sidepane .qtxt')?.textContent, marked: [...document.querySelectorAll('.msgs .rb.on')].map((e) => e.textContent), noEdit: !document.querySelector('#sidepane #f-edit, #sidepane #f-delete'), review: !!document.querySelector('#sidepane #f-review') }), before);
  say(`finding-opens-beside-the-conversation-${w}-${scheme}`, shown.same && /^Lock-up ratio/.test(shown.title) && shown.marked.length === 1 && /lock-up/.test(shown.marked[0]) && shown.noEdit && shown.review, JSON.stringify(shown));
  say(`pane-layout-${w}-${scheme}`, at.rail && at.chat >= 320 && at.composer && !at.bar && !at.out && !at.under && at.actsRow, JSON.stringify(at));
  await ctx.close();
}

// keyboard: Enter on the phrase opens the pane with the focus in it; Escape closes it and the focus goes back to the phrase.
// A document opened from the pane takes the room; a person marks the finding reviewed from the pane; leaving the page closes it.
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page); await twoAnswers(page, id);
  await page.locator('.msgs .ai .ref .rb', { hasText: 'revenue' }).focus(); await page.keyboard.press('Enter'); await page.waitForSelector('#sidepane .opening');
  const inPane = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('#sidepane')); await page.waitForTimeout(100);
  const back = await page.evaluate(() => document.activeElement?.textContent ?? '');
  say('pane-by-keyboard', inPane === 'sidepane' && /revenue/.test(back), JSON.stringify({ inPane, back }));
  await page.locator('.msgs .ai .ref .rb', { hasText: 'lock-up' }).click(); await page.waitForSelector('#sidepane #f-review');
  await page.click('#sidepane #f-review'); await page.waitForFunction(() => Object.values(store.get().findings).some((f) => /Lock-up/.test(f.title) && f.reviewed));
  say('reviewed-from-the-pane', true);
  await page.click('#sidepane .opening .ref .rb'); await page.waitForSelector('.docpanel');
  const doc = await page.evaluate(() => ({ pane: !!document.querySelector('#sidepane'), reading: document.body.classList.contains('reading') }));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.docpanel'));
  say('a-document-takes-the-room', !doc.pane && doc.reading, JSON.stringify(doc));
  await page.locator('.msgs .ai .ref .rb', { hasText: 'lock-up' }).click(); await page.waitForSelector('#sidepane');
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.trk-head, .md'); await page.goBack(); await page.waitForSelector('.msgs .ai');
  say('leaving-the-page-closes-the-pane', !(await page.$('#sidepane')) && (await page.evaluate(() => store.get().ui.side)) === null);
  say('no-page-errors-f1', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// the actions under an answer are icons, left-aligned under it, each named on hover; "Use as response to a question…" opens
// the deal's open questions to pick from, narrowed as a person types (never a number typed from memory)
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page); await twoAnswers(page, id);
  const row = await page.evaluate(() => { const a = document.querySelector('.msgs .ai'); const b = [...a.querySelectorAll('.acts button')]; const p = a.querySelector('p').getBoundingClientRect();
    return { names: b.map((x) => x.getAttribute('aria-label')).join('|'), words: b.some((x) => x.textContent.trim()), icons: b.every((x) => x.querySelector('svg')), left: Math.round(b[0].getBoundingClientRect().left - p.left), box: !!document.querySelector('.touse, .msgs .acts input') }; });
  say('answer-actions-are-icons', row.names === 'Copy|Add as question|Add as finding|Use as response to a question…' && !row.words && row.icons && row.left >= -8 && row.left <= 0 && !row.box, JSON.stringify(row));
  const addFinding = '.msgs .ai .acts button[aria-label="Add as finding"]';
  await page.hover(addFinding);
  const tip = await page.waitForFunction((selector) => {
    const tooltip = document.querySelector('.tip');
    const button = document.querySelector(selector);
    if (!tooltip || !button) return false;
    const text = tooltip.textContent;
    const above = tooltip.getBoundingClientRect().bottom <= button.getBoundingClientRect().top;
    return text === 'Add as finding' && above ? { text, above } : false;
  }, addFinding).then((match) => match.jsonValue());
  say('answer-action-named-on-hover', tip.text === 'Add as finding' && tip.above, JSON.stringify(tip));
  const q = await addQ(page, id, 'Which operating assumption does the base case use?');
  const had = await addQ(page, id, 'Provide the insurance certificates for the construction period.', 'Certificates to follow at financial close.');
  const closed = await addQ(page, id, 'Confirm the interconnection date.'); const shut = await page.evaluate(([d, x]) => store.dispatch(store.commandNamed('SetQuestionStatus'), { dealId: d, questionId: x, status: 'closed' }).then(() => store.get().questions[x].status), [id, closed.id]);
  const use = '.msgs .ai >> nth=1 >> .acts button[aria-label="Use as response to a question…"]';
  const shown = () => page.evaluate(() => ({ focus: document.activeElement?.getAttribute('role'), rows: [...document.querySelectorAll('.usecard [role="option"]')].map((o) => o.textContent), active: document.getElementById(document.activeElement?.getAttribute('aria-activedescendant') || '-')?.textContent ?? null, none: document.querySelector('.usecard .unone')?.textContent ?? null }));
  await page.keyboard.press('Escape'); await page.focus(use); await page.keyboard.press('Enter'); await page.waitForSelector('.usecard [role="combobox"]');
  const opened = await shown();
  await page.keyboard.type('99'); const none = await shown();
  await page.fill('.usecard [role="combobox"]', 'certificates'); const words = await shown();
  await page.fill('.usecard [role="combobox"]', ''); await page.keyboard.press('ArrowDown'); const down = await shown(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp'); const wrap = await shown();
  say('use-list-of-open-questions', shut === 'closed' && opened.focus === 'combobox' && opened.rows.join('|') === `Q${q.n}${q.text}|Q${had.n}${had.text}Has a response` && opened.active === opened.rows[0]
    && none.rows.length === 0 && none.none === 'No open question matches “99”.' && words.rows.length === 1 && words.rows[0].startsWith(`Q${had.n}`) && down.active === opened.rows[1] && wrap.active === opened.rows[1], JSON.stringify({ shut, opened, none, words, down, wrap }));
  await page.keyboard.press('Escape'); await page.waitForSelector('.usecard', { state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Use as response to a question…', null, { timeout: 2000 }).catch(() => {});   // given back on the next frame
  const esc = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  say('use-list-escape-gives-the-focus-back', esc === 'Use as response to a question…', esc);
  // the list opens on the open questions; the filter on its label's line, in the Q&A tab's style, shows all of them, the
  // closed too. Typing narrows within the filter, the keys still work, and Escape gives the focus back
  const seg = () => page.evaluate(() => [...document.querySelectorAll('.usecard .seg button')].map((b) => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join('|'));
  await page.keyboard.press('Enter'); await page.waitForSelector('.usecard [role="combobox"]');
  const f0 = { seg: await seg(), ...(await shown()) };
  await page.click('.usecard .seg [data-filter="all"]', { timeout: 3000 }).catch(() => {}); const f1 = { seg: await seg(), ...(await shown()), clear: await page.evaluate(() => document.querySelector('.usecard').getBoundingClientRect().bottom <= document.getElementById('pcomposer').getBoundingClientRect().top) };   // the longer list is not behind the composer
  await page.keyboard.type('interconnection'); const f2 = await shown();
  await page.click('.usecard .seg [data-filter="open"]', { timeout: 3000 }).catch(() => {}); const f3 = await shown();
  await page.fill('.usecard [role="combobox"]', ''); await page.keyboard.press('Shift+Tab'); await page.keyboard.press(' '); const f4 = { seg: await seg(), ...(await shown()) };
  await page.keyboard.press('Escape'); await page.waitForSelector('.usecard', { state: 'detached', timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Use as response to a question…', null, { timeout: 2000 }).catch(() => {});
  const f5 = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
  await page.keyboard.press('Enter'); await page.waitForSelector('.usecard [role="combobox"]', { timeout: 3000 }).catch(() => {}); const f6 = await seg();
  const every = [`Q${q.n}${q.text}`, `Q${had.n}${had.text}Has a response`, `Q${closed.n}${closed.text}Closed`];
  say('use-list-filter-shows-the-closed-questions-too', f0.seg === 'Open 2*|All' && f0.rows.join('|') === every.slice(0, 2).join('|')
    && f1.seg === 'Open 2|All*' && f1.clear && f1.focus === 'combobox' && f1.rows.join('|') === every.join('|') && f1.active === every[0]
    && f2.focus === 'combobox' && f2.rows.join('|') === every[2] && f2.active === every[2] && f3.rows.length === 0 && f3.none === 'No open question matches “interconnection”.'
    && f4.seg === 'Open 2|All*' && f4.rows.length === 3 && f5 === 'Use as response to a question…' && f6 === 'Open 2*|All', JSON.stringify({ f0, f1, f2, f3, f4, f5, f6 }));
  await page.keyboard.press('Escape'); await page.waitForSelector('.usecard', { state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Use as response to a question…', null, { timeout: 2000 }).catch(() => {});
  // a question that has a response: the list gives way to the Replace prompt; keeping it changes nothing, and the focus goes back
  await page.keyboard.press('Enter'); await page.waitForSelector('.usecard [role="combobox"]'); await page.keyboard.type(`Q${had.n}`); await page.keyboard.press('Enter'); await page.waitForSelector('#use-replace');
  const asked = await page.evaluate(() => ({ list: !!document.querySelector('.usecard'), focus: document.activeElement?.id, text: document.querySelector('.msgs .card.confirm p')?.textContent }));
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter'); await page.waitForSelector('#use-replace', { state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Use as response to a question…', null, { timeout: 2000 }).catch(() => {});
  const kept = await page.evaluate((x) => ({ response: store.get().questions[x].response, focus: document.activeElement?.getAttribute('aria-label') }), had.id);
  say('use-list-asks-before-replacing', !asked.list && asked.focus === 'use-replace' && asked.text === `Q${had.n} already has a response. Replace it with this answer?` && kept.response === 'Certificates to follow at financial close.' && kept.focus === 'Use as response to a question…', JSON.stringify({ asked, kept }));
  // picked by click: the answer becomes the response, the list closes, and the focus goes back to the button
  await page.click(use); await page.waitForSelector('.usecard [role="option"]'); await page.click(`.usecard [role="option"]:has-text("${q.text}")`);
  await page.waitForFunction((x) => store.get().questions[x].response.trim(), q.id); await page.waitForSelector('.usecard', { state: 'detached' });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Use as response to a question…', null, { timeout: 2000 }).catch(() => {});
  const after = await page.evaluate((x) => ({ response: store.get().questions[x].response, status: store.get().questions[x].status, focus: document.activeElement?.getAttribute('aria-label') }), q.id);
  say('use-as-response-picked-from-the-list', /^The closest support in the data room/.test(after.response) && after.status === 'open' && after.focus === 'Use as response to a question…', JSON.stringify(after));
  say('no-page-errors-actions', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// the suggested open question: a card under the newest answer that may address it; clicked, the question opens in the pane
// to be checked. Nothing changes until a person uses it; "Not this one" puts it away.
const Q4 = 'Confirm the operating assumption used in the base case, and where it comes from. If the technical advisor and the information memorandum differ, say which one the model follows and why.';
for (const [w, h, scheme] of [[1280, 736, 'light'], [1024, 640, 'dark']]) {
  const { ctx, page } = await fresh(w, h, scheme);
  const id = await indexedDeal(page); const q = await addQ(page, id, Q4); await addQ(page, id, 'Provide the insurance certificates for the construction period.'); await twoAnswers(page, id);
  const card = await page.evaluate(() => { const R = (e) => e.getBoundingClientRect(); const all = [...document.querySelectorAll('.msgs .suggest')]; const c = all[0]; const ai = [...document.querySelectorAll('.msgs .ai')];
    const within = (b) => R(b).right <= R(c).right - 4 && R(b).left >= R(c).left;
    const inside = c && [...c.querySelectorAll('button')].every(within);
    return { n: all.length, under: c && ai[1].contains(c), text: c?.querySelector('.sq')?.textContent,
      lead: c?.querySelector('.lead')?.textContent, inside,
      fits: c && R(c).right <= R(document.querySelector('.chat')).right + 0.5 }; });
  say(`suggested-question-card-${w}-${scheme}`, card.n === 1 && card.under && card.text === 'Q' + q.n + Q4 && card.lead === 'This may address an open question' && card.inside && card.fits, JSON.stringify(card));
  // a person presses Check: the button keeps the focus, the result (after the AI mark) shows in a line on the card,
  // and nothing changes
  await page.focus('.msgs .suggest .ask'); await page.keyboard.press('Enter'); await page.waitForSelector('.msgs .suggest .verdict b');
  const verdict = await page.evaluate((qid) => { const R = (e) => e.getBoundingClientRect(); const c = document.querySelector('.msgs .suggest'), v = c.querySelector('.verdict');
    return { text: v.textContent, focus: document.activeElement?.textContent, label: c.querySelector('.ask').textContent, lines: Math.round(R(v).height / parseFloat(getComputedStyle(v).lineHeight)), fits: R(v).right <= R(c).right, response: store.get().questions[qid].response, status: store.get().questions[qid].status }; }, q.id);
  const partly = 'AI Partly answers it. It gives some of what the question asks for, not all of it.';
  const again = verdict.focus === 'Check Again' && verdict.label === 'Check Again';
  say(`check-${w}-${scheme}`, verdict.text === partly && again && verdict.lines <= 2 && verdict.fits
    && verdict.response === '' && verdict.status === 'open', JSON.stringify(verdict));
  await page.click('.msgs .suggest .sq'); await page.waitForSelector('#sidepane[aria-label="Question"] #side-new'); await page.waitForTimeout(600);
  const at = await layout(page);
  const pane = await page.evaluate((qid) => ({ q: document.getElementById('side-q').textContent, now: document.getElementById('side-now').textContent, new: document.getElementById('side-new').textContent, on: !!document.querySelector('.msgs .suggest.on'), btns: [...document.querySelectorAll('#sidepane .pacts button')].map((b) => b.textContent).join('|'), response: store.get().questions[qid].response }), q.id);
  say(`suggested-question-in-the-pane-${w}-${scheme}`, pane.q === Q4 && pane.now === 'None yet'
    && /^The closest support in the data room/.test(pane.new) && !/\[\d\]/.test(pane.new) && pane.on
    && pane.btns === 'Use as Response|Not This One' && pane.response === '', JSON.stringify(pane));
  say(`question-pane-layout-${w}-${scheme}`, at.rail && at.composer && !at.bar && !at.out && !at.under && at.actsRow, JSON.stringify(at));
  // "Not this one" from the pane at one size, from the card (which closes the pane too) at the other
  await page.click(scheme === 'light' ? '#side-not' : '.msgs .suggest button[aria-label="Not this one"]'); await page.waitForFunction(() => !document.querySelector('#sidepane'));
  const after = await page.evaluate((qid) => ({ cards: document.querySelectorAll('.msgs .suggest').length, response: store.get().questions[qid].response, status: store.get().questions[qid].status }), q.id);
  say(`not-this-one-${w}-${scheme}`, after.cards === 0 && after.response === '' && after.status === 'open', JSON.stringify(after));
  // remembered on this PC: after a reload the card stays away
  await page.reload(); await page.waitForFunction((qid) => document.querySelectorAll('.msgs .ai:not(.pending)').length === 2 && store.get().questions[qid], q.id); await page.waitForTimeout(300);
  const reloaded = await page.evaluate(() => ({ cards: document.querySelectorAll('.msgs .suggest').length, kept: JSON.parse(localStorage.getItem('dil/1/local/notThese') || 'null')?.data, answer: Object.values(store.get().threads)[0]?.[3]?.id }));
  say(`not-this-one-after-reload-${w}-${scheme}`, reloaded.cards === 0 && reloaded.kept?.length === 1 && reloaded.kept[0] === `${reloaded.answer}|${q.id}`, JSON.stringify(reloaded));
  // asking in words brings the card back under the answer it is about, and the reply names the question
  await page.fill('#pask', 'Does this answer any of our open questions?'); await page.press('#pask', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('.msgs .ai:not(.pending):not(.failed)').length === 3, null, { timeout: 8000 });
  const words = await page.evaluate(() => { const ai = [...document.querySelectorAll('.msgs .ai')]; const c = document.querySelector('.msgs .suggest'); return { reply: ai[2].querySelector('p')?.textContent, under: !!c && ai[1].contains(c), cards: document.querySelectorAll('.msgs .suggest').length }; });
  say(`asked-in-words-${w}-${scheme}`, new RegExp('^The answer above may address Q' + q.n + ': “Confirm the operating').test(words.reply) && words.under && words.cards === 1, JSON.stringify(words));
  say(`no-page-errors-suggest-${w}-${scheme}`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

// a person uses the suggestion: from the card at once, or from the pane, asked first when it would replace a response; the
// pane stays open after and shows the question with its new response, and Undo puts the check back
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page); const q = await addQ(page, id, Q4, 'The base case follows the information memorandum.'); await twoAnswers(page, id);
  await page.click('.msgs .suggest .sq'); await page.waitForSelector('#side-use');
  const now = await page.textContent('#side-now'); await page.click('#side-use'); await page.waitForSelector('#side-replace');
  const asked = await page.evaluate(() => ({ focus: document.activeElement?.id, text: document.querySelector('#sidepane .card.confirm p')?.textContent }));
  await page.click('#side-keep'); const kept = await page.evaluate((x) => store.get().questions[x].response, q.id);
  await page.click('#side-use'); await page.focus('#side-replace'); await page.keyboard.press('Enter'); await page.waitForSelector('#side-used');
  await page.waitForFunction(() => document.activeElement?.id === 'side-used', null, { timeout: 2000 }).catch(() => {});
  const used = await page.evaluate((x) => ({ q: store.get().questions[x], cards: document.querySelectorAll('.msgs .suggest').length, toast: document.querySelector('#toast')?.textContent }), q.id);
  say('use-from-the-pane-asks-before-replacing', now === 'The base case follows the information memorandum.' && asked.focus === 'side-replace' && /already has a response/.test(asked.text) && kept === now && /^The closest support in the data room/.test(used.q.response) && used.q.status === 'open' && used.cards === 0 && /Response to Q\d+ replaced/.test(used.toast), JSON.stringify({ now, asked, kept, used: { response: used.q.response, status: used.q.status, cards: used.cards, toast: used.toast } }));
  const stays = await page.evaluate(() => ({ pane: document.getElementById('sidepane')?.getAttribute('aria-label'), q: document.getElementById('side-q')?.textContent, said: document.getElementById('side-used')?.textContent, now: document.getElementById('side-now')?.textContent, focus: document.activeElement?.id, buttons: [...document.querySelectorAll('#sidepane .spbody button')].length, side: store.get().ui.side?.kind }));
  say('pane-stays-open-with-the-new-response', stays.pane === 'Question' && stays.q === Q4 && stays.said === 'This answer is now its response' && stays.now === used.q.response && stays.focus === 'side-used' && stays.buttons === 0 && stays.side === 'question', JSON.stringify(stays));
  await page.evaluate(() => [...document.querySelectorAll('#toast .tundo')].find((b) => /replaced/.test(b.parentElement.textContent)).click());
  await page.waitForSelector('#side-use'); const undone = await page.evaluate((x) => ({ now: document.getElementById('side-now').textContent, response: store.get().questions[x].response, used: !!document.getElementById('side-used') }), q.id);
  say('undo-puts-the-check-back-in-the-pane', undone.now === now && undone.response === now && !undone.used, JSON.stringify(undone));
  await page.click('#side-use'); await page.click('#side-replace'); await page.waitForSelector('#side-used');      // used again, for what follows
  await page.click('#side-close'); await page.waitForFunction(() => !document.querySelector('#sidepane'));
  const other = await addQ(page, id, 'Which operating assumption does the technical advisor use, and does the base case follow it?');
  await page.waitForSelector('.msgs .suggest'); await page.click('.msgs .suggest .btn.sm:not(.ask)');
  await page.waitForFunction((x) => store.get().questions[x].response.trim(), other.id);
  const card = await page.evaluate((x) => ({ response: store.get().questions[x].response, cards: document.querySelectorAll('.msgs .suggest').length }), other.id);
  say('use-from-the-card', /^The closest support in the data room/.test(card.response) && card.cards === 0, JSON.stringify(card));
  await addQ(page, id, 'Explain the operating assumption the technical advisor and the information memorandum each use in the base case.');
  await page.click('.msgs .suggest .sq'); await page.click('#side-page'); await page.waitForFunction(() => store.get().ui.route.name === 'qa');
  const qa = await page.evaluate(() => ({ sel: store.get().questions[store.get().ui.selectedQuestion]?.n, side: store.get().ui.side }));
  say('open-in-qa', qa.sel === 3 && qa.side === null, JSON.stringify(qa));
  say('no-page-errors-use', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
