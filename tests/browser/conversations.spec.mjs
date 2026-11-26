import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, String(note).slice(0, 240)); };
const browser = await launchChrome();
openOnFindings(browser);
async function fresh() { const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(URL); await page.waitForSelector('#fr-new'); return { ctx, page }; }
async function indexedDeal(page, name = 'Proseware') {
  await page.click('#fr-new, #new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  return page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === 'Project ' + n).id, name);
}
const answered = (page) => page.waitForSelector('.msgs .ai:not(.pending):not(.failed)', { timeout: 8000 });

// 1 deal ask → conversation; a finding named in the answer opens beside it, and from there its page; reload keeps place
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page);
  await page.fill('#hask', 'What are the three biggest issues?'); await page.press('#hask', 'Enter');
  await page.waitForSelector('.msgs .me'); const pending = await page.evaluate(() => !!document.querySelector('.msgs .ai.pending')); await answered(page);
  const hash1 = await page.evaluate(() => location.hash);
  await page.reload(); await page.waitForSelector('.msgs .ai');
  const kept = await page.evaluate(() => document.querySelectorAll('.msgs .me').length);
  await page.click('.msgs .ai .ref .rb'); await page.waitForSelector('#sidepane .opening');
  const pane = await page.evaluate((h) => ({ same: location.hash === h, marked: document.querySelectorAll('.msgs .rb.on').length, chat: !!document.querySelector('.msgs .me') }), hash1);
  await page.click('#side-page'); await page.waitForSelector('.chat > .opening');
  const st = await page.evaluate(() => ({ hash: location.hash, queued: document.body.classList.contains('queued'), strip: !!document.querySelector('#qstrip'), head: document.querySelector('.chathead').textContent }));
  say('deal-ask-and-inline-ref', pending && new RegExp('^#chat-' + id + '-c[0-9a-z]+$').test(hash1) && kept === 1 && pane.same && pane.marked === 1 && pane.chat && /^#finding-/.test(st.hash) && st.queued && st.strip && /Findings/.test(st.head), JSON.stringify({ pending, hash1, kept, pane, st }));
  // 2 queue: Next, reload restores the same finding; ArrowDown steps
  // the finding the answer named may sit anywhere in the list (it is grouped by workstream): start from the first
  const waitForPosition = (position) => page.waitForFunction(
    (expected) => document.querySelector('.qcnt')?.textContent === expected, position,
  );
  const next = '.qarrows [data-qstep="1"]';
  for (let step = 0; step < 3; step++) {
    const position = await page.textContent('.qcnt');
    if (position === '1/3') break;
    await page.click(next);
    await waitForPosition(position === '3/3' ? '1/3' : '3/3');
  }
  await waitForPosition('1/3');
  const f1 = await page.evaluate(() => location.hash);
  await page.click(next);
  await waitForPosition('2/3');
  const f2 = await page.evaluate(() => location.hash);
  await page.reload();
  await waitForPosition('2/3');
  const f2b = await page.evaluate(() => location.hash);
  await page.keyboard.press('ArrowDown');
  await waitForPosition('3/3');
  say('queue-next-reload-arrow', f2 !== f1 && f2b === f2, JSON.stringify({ f1, f2, f2b }));

  // A press wraps from the last finding to the first. Repeats reach the last finding and stop there.
  const f3 = await page.evaluate(() => location.hash);
  for (const position of ['1/3', '2/3', '3/3']) {
    await page.keyboard.down('ArrowDown');
    await waitForPosition(position);
  }
  await page.keyboard.down('ArrowDown');
  await page.keyboard.down('ArrowDown');
  await page.keyboard.up('ArrowDown');
  const held = await page.evaluate(() => ({ hash: location.hash, n: document.querySelector('.qcnt').textContent }));
  say('holding-down-stops-at-the-last-finding', held.hash === f3 && held.n === '3/3', JSON.stringify(held));
  // the open queue: finding titles use the panel's width and all end at one edge (they were cut to six letters, then at
  // uneven points)
  await page.hover('.qgrid .g.on'); await page.waitForTimeout(500);
  const qt = await page.evaluate(() => [...document.querySelectorAll('.qgrid .g span')].map((x) => [Math.round(x.clientWidth), Math.round(x.getBoundingClientRect().right)]));
  say('queue-titles-use-the-width-and-end-at-one-edge', qt.length === 3 && qt.every(([w]) => w > 200) && new Set(qt.map(([, r]) => r)).size === 1, JSON.stringify(qt));
  await page.mouse.move(900, 500); await page.waitForTimeout(400);
  // 3 reading mode (the count says it counts citations): click a cited phrase → document panel; composer does not cover the nav; prev/next; Esc closes
  await page.click('.opening .ref .rb'); await page.waitForSelector('.docpanel .page:not(.ph-page)');
  const rd = await page.evaluate(() => { const hit = (sel) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return el === top || el.contains(top); }; return { reading: document.body.classList.contains('reading'), prev: hit('#doc-prev'), next: hit('#doc-next'), close: hit('#doc-close'), name: document.querySelector('.docname').textContent, comp: document.getElementById('pcomposer').getBoundingClientRect().width, chat: document.querySelector('.chat').getBoundingClientRect().width }; });
  await page.click('#doc-next'); await page.waitForFunction(() => /2 of 2/.test(document.querySelector('.docname .cnt').textContent)); 
  const sheet = await page.evaluate(() => !!document.querySelector('.docbody .sheet .hl') || !!document.querySelector('.docbody .page'));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.docpanel'));
  say('reading-mode', rd.reading && rd.prev && rd.next && rd.close && /1 of 2/.test(rd.name) && rd.comp <= rd.chat && sheet, JSON.stringify(rd));
  // 4 follow-up on a finding; Add as question links to it; response → Reassess offered
  await page.fill('#pask', 'Draft the question for the counterparty'); await page.press('#pask', 'Enter'); await answered(page);
  await page.click('.msgs .ai .acts button[aria-label="Add as question"]'); await page.waitForSelector('#aq-text'); const linked = await page.textContent('.clink'); await page.waitForTimeout(300);
  const logShown = await page.evaluate(() => { const l = document.getElementById('aq-log').getBoundingClientRect(); const at = document.elementFromPoint(l.x + l.width / 2, l.y + l.height / 2); return at?.id === 'aq-log'; });
  say('log-question-is-clear-of-the-composer', logShown);   /* the card scrolls up so its button can be clicked */
  await page.press('#aq-text', 'Control+Enter');   /* Ctrl Enter logs it, as the button does */ await page.waitForFunction(() => !document.querySelector('#aq-text'));
  const q = await page.evaluate(() => Object.values(store.get().questions)[0]);
  say('add-as-question-linked', /^Linked to “.+”$/.test(linked) && !!q.linkedFinding && q.text.length > 5, linked);
  // 5 discuss a question; use as response; provenance from conversation
  await page.goto(URL + '#qa-' + id);
  // The page opens as the full table: open a row before discussing it.
  await page.click('.md .li >> nth=0');
  await page.click('#q-discuss');
  await page.waitForSelector('.opening .qtxt');
  await page.fill('#pask', 'What else in the data room bears on this?'); await page.press('#pask', 'Enter'); await answered(page);
  await page.click('.msgs .ai .acts button[aria-label="Use as response"]'); await page.waitForFunction(() => /Response recorded/.test(document.getElementById('toast')?.textContent || ''));
  const q2 = await page.evaluate((qid) => store.get().questions[qid], q.id);
  say('use-as-response', q2.response.length > 5 && q2.provenance.origin === 'chat' && q2.status === 'open', JSON.stringify({ st: q2.status, o: q2.provenance.origin }));
  // a response on several lines keeps its lines on the Discuss page (it ran together)
  await page.evaluate(async (qq) => store.dispatch(store.commandNamed('SetResponse'), { dealId: qq.dealId, questionId: qq.id, response: 'Resp one\nResp three' }), q);
  await page.waitForFunction(() => /Resp three/.test(document.querySelector('.opening .dtxt')?.textContent || ''));
  const lines = await page.evaluate(() => document.querySelector('.opening .dtxt').innerText);
  say('discuss-keeps-the-response-lines', lines === 'Resp one\nResp three', JSON.stringify(lines));
  const fupd = await page.evaluate((fid) => store.get().findings[fid].updated, q.linkedFinding);
  say('linked-finding-marked', fupd === true);
  // 6 deleted finding: its URL is safe after reload
  const fid = q.linkedFinding; await page.goto(URL + `#finding-${id}-${fid}`); await page.waitForSelector('#f-delete'); await page.click('#f-delete'); await page.click('#ask-go'); await page.waitForSelector('.flagsl');
  await page.goto(URL + `#finding-${id}-${fid}`); await page.reload(); await page.waitForSelector('.chathead');
  say('deleted-finding-safe', /was deleted/.test(await page.textContent('.chat')) && !(await page.$('#pcomposer')));
  say('no-page-errors-1', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// 7 home ask (all deals), navigation intents, add-question intent, failed answer + retry, navigate during a pending answer
{ const { ctx, page } = await fresh();
  const id = await indexedDeal(page, 'Trey');
  await page.goto(URL + '#deals'); await page.waitForSelector('#homeask'); await page.fill('#hask', 'go to Trey Q&A'); await page.press('#hask', 'Enter'); await page.waitForFunction((i) => location.hash === '#qa-' + i, id);
  await page.goto(URL + '#deals'); await page.waitForSelector('#homeask'); await page.fill('#hask', 'open Trey findings'); await page.press('#hask', 'Enter'); await page.waitForFunction((i) => location.hash === '#deal-' + i, id); await page.waitForSelector('.dtabs');   // the deal page, not the home page that was just left
  // a page named after the deal opens that page whatever the deal opens on, and a curly apostrophe is read too
  await page.evaluate(() => store.setPrefs({ landing: 'overview' }));
  for (const [typed, want] of [['go to Trey findings', 'deal'], ['show me the Trey findings', 'deal'], ['open Trey’s findings', 'deal'], ["open Trey's checklist", 'checklist'], ['go to Trey', 'overview']]) {
    await page.goto(URL + '#deals'); await page.waitForSelector('#homeask'); await page.fill('#hask', typed); await page.press('#hask', 'Enter');
    await page.waitForFunction((h) => location.hash === h, `#${want}-${id}`, { timeout: 3000 }).catch(() => undefined);
    const at = await page.evaluate(() => location.hash); if (at !== `#${want}-${id}`) say(`navigation-intent-${typed}`, false, at);
  }
  await page.evaluate(() => store.setPrefs({ landing: 'findings' })); await page.goto(URL + '#deal-' + id); await page.waitForSelector('.dtabs');
  say('navigation-intents', true);
  await page.fill('#hask', 'add a question: Please confirm the insurance program.');
  await page.press('#hask', 'Enter');
  await page.waitForFunction(() => Object.values(store.get().questions).some((q) => /insurance program/.test(q.text)));
  say('add-question-intent', (await page.evaluate(() => location.hash)) === '#deal-' + id);
  await page.goto(URL + '#deals'); await page.waitForSelector('#homeask'); await page.evaluate(() => { window.__fail = { answer: true }; });
  await page.fill('#hask', 'What is outstanding across my deals?'); await page.press('#hask', 'Enter'); await page.waitForSelector('.msgs .ai.failed', { timeout: 8000 });
  await page.evaluate(() => { window.__fail = {}; }); await page.click('.msgs .ai.failed button'); await answered(page);
  say('failed-answer-retry', /^#chat-c[0-9a-z]+$/.test(await page.evaluate(() => location.hash)));
  // pending answer, navigate away and back: it lands on its own thread
  await page.goto(URL + '#chat-' + id);
  await page.fill('#pask', 'How does the lock-up compare with the precedent?');
  await page.press('#pask', 'Enter');
  await page.waitForSelector('.msgs .ai.pending');
  await page.goto(URL + '#chat'); await page.waitForFunction((i) => store.get().threads['deal:' + i].every((m) => m.state === 'done'), id, { timeout: 8000 }).catch(() => undefined);
  const all = await page.evaluate(() => Object.entries(store.get().threads).find(([k]) => k.startsWith('all:'))[1].length); const dealT = await page.evaluate((i) => store.get().threads['deal:' + i].map((m) => m.state), id);
  say('answer-lands-on-its-thread', all === 2 && dealT.join() === 'done,done', JSON.stringify({ all, dealT }));
  // the chat agent's research (option D): "Researched · N steps · N of M documents searched · time" opens the trace; each chip opens its page
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('.msgs .ai:not(.pending) .rsch-pill');
  const pill = await page.textContent('.rsch-pill'); await page.click('.rsch-pill'); await page.waitForSelector('.rsch-trace');
  const steps = await page.$$eval('.rsch-step', (els) => els.map((e) => e.textContent)); const expanded = await page.getAttribute('.rsch-pill', 'aria-expanded');
  say('research-trace', /^Researched· \d+ steps? · \d+ of \d+ documents? searched · \d+s$/.test(pill.trim()) && steps.length >= 1 && /^Searched documents, findings and Q&A for/.test(steps[0]) && expanded === 'true', JSON.stringify({ pill, steps }));
  const citation = page.locator('.rsch').getByRole('button', {
    name: 'Open Credit agreement (draft 1).pdf, p. 142', exact: true,
  });
  await citation.click({ timeout: 5000 });
  await page.waitForSelector('.docbody .page:not(.ph-page)', { timeout: 5000 });
  const name = await page.textContent('#doc-menu .docnm');
  const place = await page.textContent('#doc-menu .loc');
  const shown = await page.textContent('.docbody .page .pg');
  const openedCitation = name.trim() === 'Credit agreement (draft 1).pdf' && place === 'p. 142' && shown === 'Page 142';
  say('research-chip-opens-page', openedCitation, JSON.stringify({ name, place, shown }));
  // attachments: chip is per deal, retry names the deal; across deals Attach is there too
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('#p-attach');
  await page.setInputFiles('#pcomposer input[type=file]', { name: 'side-letter.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') }); await page.waitForSelector('.chip.att:not(.pending)');
  await page.goto(URL + '#chat'); await page.waitForSelector('#pask'); const chipsAll = await page.evaluate(() => document.querySelectorAll('.chip.att').length); const attachAll = await page.$('#p-attach');
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('.askbox .chip.att'); await page.fill('#pask', 'with the side letter'); await page.press('#pask', 'Enter'); await page.waitForFunction(() => !document.querySelector('.askbox .chip.att'));
  // a deal's file stays with its deal; across deals Attach is there too
  say('attachment-per-deal', chipsAll === 0 && !!attachAll);
  // the file leaves the composer and stays on the message it was sent with
  const sentWith = await page.evaluate(() => [...document.querySelectorAll('.msgs .matt .chip.att')].map((c) => c.textContent));
  say('attachment-shown-on-its-message', sentWith.length === 1 && /side-letter\.pdf/.test(sentWith[0]), JSON.stringify(sentWith));
  // on Home a file attaches as on a deal page, is kept with the person's own files (in no deal) and goes with it
  await page.goto(URL + '#deals'); await page.waitForSelector('#homeask #p-attach');
  await page.setInputFiles('#homeask input[type=file]', { name: 'board-minutes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('x') }); await page.waitForSelector('#homeask .chip.att:not(.pending)');
  const homeAtt = await page.evaluate(() => { const a = store.get().ui.attachments.find((x) => x.name === 'board-minutes.pdf'); return { own: /^me_[0-9a-f]{16}$/.test(a?.dealId ?? ''), count: document.querySelector('#homeask .acount')?.textContent }; });
  await page.fill('#hask', 'what do the minutes approve?'); await page.press('#hask', 'Enter'); await page.waitForSelector('.msgs .me'); await answered(page);
  const homeSent = await page.evaluate(() => [...document.querySelectorAll('.msgs .matt .chip.att')].map((c) => c.textContent));
  say('home-attachment-goes-with-its-message', homeAtt.own && homeAtt.count === '1/8' && homeSent.length === 1 && /board-minutes\.pdf/.test(homeSent[0]) && !(await page.$('.askbox .chip.att')), JSON.stringify({ homeAtt, homeSent }));
  await page.goto(URL + '#chat-' + id); await page.waitForSelector('#pask');
  // composer keeps unsent text per conversation
  await page.fill('#pask', 'unsent on deal'); await page.goto(URL + '#chat'); await page.waitForSelector('#pask'); const other = await page.inputValue('#pask'); await page.goto(URL + '#chat-' + id); await page.waitForSelector('#pask');
  say('unsent-text-per-conversation', other === '' && (await page.inputValue('#pask')) === 'unsent on deal');
  // Past conversations: each question from a deal page's ask box starts a conversation; the list finds and opens them
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#dask #past');
  const restLine = await page.evaluate(() => document.querySelector('#dask').getBoundingClientRect().height <= 54);
  await page.fill('#hask', 'Which lock-up ratio did counsel agree?');
  const faded = await page.waitForFunction(() => getComputedStyle(document.querySelector('#past')).visibility === 'hidden', null, { timeout: 3000 }).then(() => true, () => false);
  await page.press('#hask', 'Enter'); await page.waitForFunction((i) => new RegExp('^#chat-' + i + '-c[0-9a-z]+$').test(location.hash), id); await answered(page);
  const firstConv = await page.evaluate(() => location.hash);
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#hask'); await page.fill('#hask', 'What does the technical advisor say?'); await page.press('#hask', 'Enter');
  await page.waitForFunction((a) => /^#chat-d_[0-9A-Z]{26}-c[0-9a-z]+$/.test(location.hash) && location.hash !== a, firstConv); await answered(page);
  const oneEach = await page.evaluate(() => document.querySelectorAll('.msgs .me').length);
  say('ask-box-starts-a-new-conversation', restLine && faded && oneEach === 1, JSON.stringify({ restLine, faded, oneEach }));
  await page.click('#p-past'); await page.waitForSelector('.pastpop');
  const listed = await page.evaluate(() => ({ focus: document.activeElement?.id, rows: [...document.querySelectorAll('.pastpop .prow .pt')].map((e) => e.textContent), cur: document.querySelector('.pastpop .prow[aria-current] .pt')?.textContent }));
  await page.keyboard.type('counsel agree'); await page.waitForFunction(() => document.querySelectorAll('.pastpop .prow').length === 1, null, { timeout: 3000 }).catch(() => {}); await page.keyboard.press('Enter'); await page.waitForFunction((a) => location.hash === a, firstConv);
  await page.waitForFunction(() => /counsel agree/.test(document.querySelector('.msgs .me')?.textContent ?? ''), null, { timeout: 3000 }).catch(() => {});   // the page draws a moment after the address changes
  const opened = await page.evaluate(() => ({ open: !!document.querySelector('.pastpop'), first: document.querySelector('.msgs .me')?.textContent }));
  await page.click('#p-past'); await page.waitForSelector('.pastpop'); await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => ({ open: !!document.querySelector('.pastpop'), focus: document.activeElement?.id }));
  say('past-conversations-find-and-open', listed.focus === 'past-search' && listed.rows.includes('Which lock-up ratio did counsel agree?') && listed.cur === 'What does the technical advisor say?' && !opened.open && /counsel agree/.test(opened.first ?? '') && !closed.open && closed.focus === 'p-past', JSON.stringify({ listed, opened, closed }));
  await page.goto(URL + '#deals'); await page.waitForSelector('#homeask #past'); await page.click('#homeask #past'); await page.waitForSelector('.pastpop');
  const home = await page.evaluate(() => ({ seg: !!document.querySelector('.pastpop .pseg'), rows: document.querySelectorAll('.pastpop .prow').length }));
  say('past-conversations-on-home-cover-every-deal', !home.seg && home.rows >= 4, JSON.stringify(home));
  say('no-page-errors-2', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// a question asked on Home opens a conversation whose trail names it; Home's box shows an example question
// about the person's deal, the conversation's box says what it asks across
{ const { ctx, page } = await fresh();
  await indexedDeal(page);
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask'); const home = await page.getAttribute('#hask', 'placeholder');
  await page.fill('#hask', 'What is the lock-up?'); await page.press('#hask', 'Enter'); await answered(page);
  const there = await page.evaluate(() => ({ trail: document.querySelector('.chathead .back').textContent, here: document.querySelector('.chathead .here')?.textContent, ph: document.querySelector('#pask').placeholder }));
  say('home-conversation-trail-and-box', /^Which permits are still open on .+\?$/.test(home)
    && there.ph === 'Ask across your deals…' && there.trail === 'Home›All deals' && there.here === 'All deals'
    && page.errors.length === 0, JSON.stringify({ home, there, errors: page.errors }));
  await ctx.close(); }

// #172: a folderless deal has zero documents to search, even when explicitly asked to review a folder.
{ const { ctx, page } = await fresh();
  await page.evaluate(() => store.setPrefs({ landing: 'overview' }));
  await page.click('#fr-new');
  await page.fill('#nd-name', 'Empty room');
  await page.click('#nd-create');
  await page.getByText('No data room yet.', { exact: false }).waitFor();
  const id = await page.evaluate(async () => {
    const [dealId] = Object.keys(store.get().deals);
    await store.dispatch(store.commandNamed('CreateQuestion'), { dealId, text: 'When do the permits expire?' },
      { quiet: true });
    return dealId;
  });
  await page.goto(URL + '#qa-' + id);
  await page.click('.md .li');
  await page.click('#q-discuss');
  const prompts = ['What in the data room answers this?', 'Review the permits folder'];
  for (const [index, prompt] of prompts.entries()) {
    await page.fill('#pask', prompt);
    await page.press('#pask', 'Enter');
    const message = page.locator('.msgs .ai').nth(index);
    const pill = message.locator('.rsch-pill');
    await pill.filter({ hasText: 'Researched' }).waitFor({ timeout: 8000 });
    const summary = await pill.textContent();
    await pill.click();
    const trace = await message.locator('.rsch-trace').textContent();
    const empty = summary.includes('0 of 0 documents searched') && trace.includes('0 listed · 0 opened');
    say('empty-room-research: ' + prompt, empty, JSON.stringify({ summary, trace }));
  }
  const research = await page.evaluate(async (dealId) => {
    const sources = [{ doc: 'Permit.pdf', docId: 'doc_permit', loc: 'p. 1' }];
    const finding = { dealId, title: 'Permit condition', workstream: 'Legal', sources };
    await store.dispatch(store.commandNamed('CreateFinding'), finding, { quiet: true });
    const message = 'What does the permit say?';
    const result = await store.services.ai.answer({ dealId, message, history: [], model: '' });
    return result.ok ? result.value : null;
  }, id);
  say('folderless-deal-counts-cited-document',
    research?.sources[0]?.doc === 'Permit.pdf' && research.research?.read?.docs === 1);
  await ctx.close(); }

// reading a whole folder, stopped while it works: Stop sits beside Researching, at its height; pressed, it reads
// "Stopping" and starts nothing more; the answer comes from what was read, the trace ends with Stopped, Stop is gone
{ const { ctx, page } = await fresh();
  await indexedDeal(page);
  await page.fill('#hask', 'Review the permits folder for expiry dates'); await page.press('#hask', 'Enter');
  await page.waitForSelector('#rsch-stop'); await page.waitForTimeout(1500);
  const row = await page.evaluate(() => { const p = document.querySelector('.rsch-pill').getBoundingClientRect(), s = document.querySelector('#rsch-stop').getBoundingClientRect(); return { same: Math.abs(p.top - s.top) < 1 && Math.abs(p.height - s.height) < 1 && s.left > p.right, label: document.querySelector('#rsch-stop').textContent, tip: document.querySelector('#rsch-stop').title }; });
  await page.click('#rsch-stop'); const stopping = await page.evaluate(() => ({ label: document.querySelector('#rsch-stop').textContent, off: document.querySelector('#rsch-stop').disabled }));
  await page.waitForSelector('.msgs .ai:not(.pending)', { timeout: 8000 }); await page.click('.msgs .ai:not(.pending) .rsch-pill'); await page.waitForSelector('.rsch-trace');
  const after = await page.evaluate(() => { const steps = [...document.querySelectorAll('.rsch-step')].map((e) => e.textContent); const reviewed = steps.filter((t) => t.startsWith('Reviewed documents')).length; return { last: steps.at(-1), reviewed, text: document.querySelector('.msgs .ai:not(.pending) .txt, .msgs .ai:not(.pending) p')?.textContent ?? document.querySelector('.msgs .ai:not(.pending)').textContent, stop: !!document.querySelector('#rsch-stop') }; });
  say('folder-read-stops', row.same && row.label === 'Stop' && row.tip === 'Answer now from what has been found so far' && stopping.label === 'Stopping' && stopping.off && after.last.startsWith('Stopped') && after.reviewed > 0 && after.reviewed < 40 && /Stopped after \d+ of the 320 documents/.test(after.text) && !after.stop && page.errors.length === 0, JSON.stringify({ row, stopping, after, errors: page.errors }));
  await ctx.close(); }

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
