// The Checklist page: how an item stands as its finding moves on, and the list and the open item's pane at the window
// sizes and themes the app supports. One check per reported item, each named by its issue number.
import { launchChrome } from './chrome.mjs';
import { openCopy, saveIndexedDeal } from './savedDeal.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note); };
const browser = await launchChrome();
const SIZES = [[1280, 736], [1024, 640]];

// The deal every check starts from is made once, then copied into each check's own context (savedDeal.mjs).
const proseware = await saveIndexedDeal(browser);
/**
 * A copy of a deal whose first pass has run, opened on its Checklist: three flagged items, two gaps, nineteen
 * satisfied.
 */
async function checklist(scheme = 'light', [w, h] = SIZES[0]) {
  const options = { width: w, height: h, colorScheme: scheme, hash: `#checklist-${proseware.id}` };
  const { ctx, page, start, asMade } = await openCopy(browser, proseware, options);
  if (!asMade) throw new Error(`The copied deal did not start as it was made: ${JSON.stringify(start)}`);
  await page.waitForSelector('#ck-rows .ckrow');
  return { ctx, page, id: proseware.id };
}
const LOCKUP = 'Lock-up ratio in the credit agreement draft differs from the term sheet';
const findingId = (page, title = LOCKUP) => page.evaluate((t) => Object.values(store.get().findings).find((f) => f.title === t).id, title);
const filters = (page) => page.evaluate(() => [...document.querySelectorAll('#ck-filter button')].map((b) => b.textContent).join('|'));
const rowOf = (page, text) => page.evaluate((t) => { const r = [...document.querySelectorAll('#ck-rows .ckrow')].find((x) => x.querySelector('.it').textContent === t); const g = r && [...document.querySelectorAll('#ck-rows .ckgroup, #ck-rows .ckrow')].slice(0, [...document.querySelectorAll('#ck-rows .ckgroup, #ck-rows .ckrow')].indexOf(r)).reverse().find((x) => x.classList.contains('ckgroup')); const ok = document.querySelector('#ck-rows .ckrow .mk.k-satisfied'); return r && { group: g?.firstChild.textContent, oc: r.querySelector('.oc').textContent, checkMark: !!r.querySelector('.mk svg'), green: !!ok && getComputedStyle(r.querySelector('.mk')).color === getComputedStyle(ok).color }; }, text);   // its check mark in the satisfied items' green

{ // closing the finding behind a flagged item resolves the item (linking design 10.7): it leaves Flagged, Overview no longer counts it, and Ask is not offered
  const { ctx, page, id } = await checklist(); const f = await findingId(page);
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.waitForSelector('#ck-ask');
  await page.evaluate(([dealId, findingId]) => store.dispatch(store.commandNamed('SetFindingStatus'), { dealId, findingId, status: 'closed', note: 'Sponsor confirmed 1.30x' }), [id, f]);
  await page.waitForFunction(() => !document.getElementById('ck-ask'), null, { timeout: 5000 }).catch(() => {}); const pane = await page.evaluate(() => ({ kind: document.querySelector('#ck-detail .dmeta .n').textContent, lbl: [...document.querySelectorAll('#ck-detail .lbl')].map((l) => l.textContent).join('|') }));
  await page.click('#ck-close'); await page.waitForFunction(() => /closed by/.test(document.querySelector('#ck-rows').textContent), null, { timeout: 5000 }).catch(() => {});
  const row = await rowOf(page, 'Lock-up ratio matches the term sheet'); const fl = await filters(page);
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-checklist .plab');
  await page.waitForFunction(() => /^4 to resolve/.test(document.querySelector('#ov-checklist .plab').textContent), null, { timeout: 5000 }).catch(() => {});
  const ov = await page.evaluate(() => { const box = document.getElementById('ov-checklist').getBoundingClientRect(); return { labs: [...document.querySelectorAll('#ov-checklist .plab')].map((e) => e.textContent).join('|'), open: document.querySelector('#ov-findings .plab').textContent, fits: [...document.querySelectorAll('#ov-checklist .plab')].every((a) => a.getBoundingClientRect().right <= box.right + 1 && a.getBoundingClientRect().left >= box.left - 1) }; });
  say('an item whose finding is closed is resolved by a person, everywhere', pane.kind === 'Resolved by a person'
    && pane.lbl === 'Finding · Closed' && fl === 'All 24|Flagged 2|Gaps 2|Resolved by a Person 1|Satisfied 19'
    && row.group === 'Resolved by a Person' && row.oc === `Raised “${LOCKUP}” · closed by jdoe` && row.checkMark && row.green
    && ov.labs === '4 to resolve · 2 flagged · 2 gaps|20 settled · 19 satisfied · 1 by a person' && ov.open === '2 open' && ov.fits && !page.errors.length, JSON.stringify({ pane, fl, row, ov, errors: page.errors }));
  await ctx.close();
}

{ // deleting the finding behind a flagged item puts the item under Finding deleted, "Its finding was deleted" (linking design 10.7), and the pane can put the finding back
  const { ctx, page, id } = await checklist(); const f = await findingId(page);
  await page.evaluate(([dealId, findingId]) => store.dispatch(store.commandNamed('DeleteFinding'), { dealId, findingId }), [id, f]);
  await page.waitForFunction(() => /Its finding was deleted/.test(document.querySelector('#ck-rows').textContent), null, { timeout: 5000 }).catch(() => {});
  const row = await rowOf(page, 'Lock-up ratio matches the term sheet'); const fl = await filters(page);
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.waitForSelector('#ck-detail');
  const pane = await page.evaluate(() => ({ kind: document.querySelector('#ck-detail .dmeta .n').textContent, finding: document.getElementById('ck-finding').textContent, ask: !!document.getElementById('ck-ask') }));
  await page.click('#ck-restore').catch(() => {}); await page.waitForFunction((t) => Object.values(store.get().findings).some((x) => x.title === t), LOCKUP, { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('#ck-detail .dmeta .n').textContent === 'Flagged', null, { timeout: 5000 }).catch(() => {});
  const back = await page.evaluate(() => ({ kind: document.querySelector('#ck-detail .dmeta .n').textContent, link: !!document.querySelector('#ck-finding a'), ask: !!document.getElementById('ck-ask') }));
  say('an item whose finding was deleted is under Finding deleted, and Restore puts the finding back',
    fl === 'All 24|Flagged 2|Finding Deleted 1|Gaps 2|Satisfied 19' && row.group === 'Finding Deleted'
    && row.oc === 'Its finding was deleted' && !row.checkMark
    && pane.kind === 'Finding deleted' && pane.finding === `“${LOCKUP}” was deleted. Restore it` && !pane.ask && back.kind === 'Flagged' && back.link && back.ask && !page.errors.length, JSON.stringify({ fl, row, pane, back, errors: page.errors }));
  await ctx.close();
}

{ // a finding in two versions keeps its item Flagged, says so on the row and in the pane, and no question can be linked to it until a version is chosen
  const { ctx, page } = await checklist(); const f = await findingId(page);
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.click('#ck-ask'); await page.fill('#ck-ask-text', 'Which ratio was agreed?');
  await page.evaluate((id) => window.__peer.edit(id, { status: 'closed' }), f); await page.waitForFunction((id) => !!store.get().conflicts[id], f, { timeout: 8000 });
  await page.waitForFunction(() => /Two versions/.test(document.querySelector('#ck-rows').textContent), null, { timeout: 5000 }).catch(() => {});
  const narrow = await rowOf(page, 'Lock-up ratio matches the term sheet');
  const pane = await page.evaluate(() => ({ kind: document.querySelector('#ck-detail .dmeta .n').textContent, lbl: document.querySelector('#ck-detail .lbl').textContent, log: document.getElementById('ck-ask-log').disabled, why: document.getElementById('ck-ask-log').title, hover: (() => { const r = document.getElementById('ck-ask-log').getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[title]')?.getAttribute('title') ?? null; })() }));   // on hover too
  await page.click('#ck-ask-cancel'); const ask = await page.evaluate(() => ({ disabled: document.getElementById('ck-ask').disabled, why: document.getElementById('ck-ask').parentElement.title, said: document.getElementById('ck-ask').getAttribute('aria-description') }));
  await page.click('#ck-close'); const wide = await rowOf(page, 'Lock-up ratio matches the term sheet'); const red = await page.evaluate(() => { const c = document.querySelector('#ck-rows .oc .cf'); return !!c && getComputedStyle(c).color === getComputedStyle(document.querySelector('.ckrow .mk.k-finding'), '::before').backgroundColor; });
  const why = 'The finding “Lock-up ratio in the credit agreement draft differs from th…” has two versions. Choose one first';   // named as everywhere else (findingName)
  say('an item whose finding is in two versions stays Flagged, is marked, and cannot be asked about',
    narrow.oc === 'Two versions' && wide.group === 'Flagged' && wide.oc === 'Two versions' && red
    && pane.kind === 'Flagged' && pane.lbl === 'Finding · Two Versions' && pane.log && pane.why === why
      && pane.hover === why && ask.disabled && ask.why === why && ask.said === why && !page.errors.length,
      JSON.stringify({ narrow, wide, red, pane, ask, errors: page.errors }));
  await ctx.close();
}

{ // an open item that the filter would hide stays listed and selected beside its pane, as on the Findings and Q&A pages, until the pane is closed
  const { ctx, page } = await checklist(); const listed = () => page.evaluate(() => ({ rows: [...document.querySelectorAll('#ck-rows .ckrow')].map((r) => r.querySelector('.it').textContent), on: document.querySelector('#ck-rows .ckrow.on .it')?.textContent ?? null, pane: document.querySelector('#ck-detail .cktitle')?.textContent ?? null }));
  await page.click('#ck-rows .ckrow:has-text("Financial model has been audited")'); await page.waitForSelector('#ck-detail');
  await page.click('#ck-filter [data-filter="finding"]'); const flagged = await listed();
  await page.click('#ck-filter [data-filter="gap"]'); const gaps = await listed();
  await page.click('#ck-close'); const closed = await listed();
  say('the open item stays listed and selected when the filter would hide it', flagged.rows.length === 4 && flagged.rows[3] === 'Financial model has been audited' && flagged.on === flagged.rows[3] && flagged.pane === flagged.on
    && gaps.rows.length === 3 && gaps.on === 'Financial model has been audited' && closed.rows.length === 2 && closed.on === null && closed.pane === null && !page.errors.length, JSON.stringify({ flagged, gaps, closed, errors: page.errors }));
  await ctx.close();
}

for (const size of SIZES) { // logging a question from the pane leaves the list as it was: no row's status moves and no title wraps anew. The wide list still names the question.
  const { ctx, page } = await checklist('light', size); const at = () => page.evaluate(() => [...document.querySelectorAll('#ck-rows .ckrow')].map((r) => `${Math.round(r.querySelector('.oc').getBoundingClientRect().left)}/${Math.round(r.querySelector('.it').getBoundingClientRect().height)}`).join());
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.click('#ck-ask'); const before = await at();
  await page.fill('#ck-ask-text', 'Which lock-up ratio was agreed?'); await page.click('#ck-ask-log'); await page.waitForSelector('#ck-asked'); await page.waitForTimeout(150); const after = await at();
  await page.click('#ck-close'); const wide = await rowOf(page, 'Lock-up ratio matches the term sheet');
  say(`logging a question moves nothing in the list (${size[0]})`, before === after && wide.oc === 'Q1 open'
    && !page.errors.length, JSON.stringify({ before, after, wide, errors: page.errors }));
  await ctx.close();
}

for (const size of SIZES) { // the question asked about a finding is shown whole in the pane, wrapped, with its line breaks
  const { ctx, page } = await checklist('light', size); const asked = 'Please confirm which lock-up ratio was agreed between the sponsor and the lenders.\nSend the signed side letter or the amended credit agreement that records it, with the date it was agreed.';
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.click('#ck-ask'); await page.fill('#ck-ask-text', asked); await page.click('#ck-ask-log'); await page.waitForSelector('#ck-asked');
  const q = await page.evaluate(() => { const c = document.querySelector('#ck-asked .cqt'); return { text: c.innerText, whole: c.scrollWidth <= c.clientWidth && c.scrollHeight <= c.clientHeight, lines: Math.round(c.getBoundingClientRect().height / parseFloat(getComputedStyle(c).lineHeight)), inside: c.getBoundingClientRect().right <= document.getElementById('ck-detail').getBoundingClientRect().right };   });
  say(`the asked question is shown whole (${size[0]})`, q.text === asked && q.whole && q.lines >= 3 && q.inside && !page.errors.length, JSON.stringify({ q, errors: page.errors }));
  await ctx.close();
}

for (const scheme of ['light', 'dark']) { // the open item's row stands out more than a row under the pointer, and keeps that when the pointer is on it
  const { ctx, page } = await checklist(scheme); const alpha = (sel) => page.evaluate((q) => { const m = getComputedStyle(document.querySelector(q)).backgroundColor.match(/[\d.]+/g).map(Number); return m.length > 3 ? m[3] : m.length === 3 ? 1 : 0; }, sel);
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.waitForSelector('#ck-detail');
  await page.hover('#ck-rows .ckrow:has-text("Executed direct agreement")'); await page.waitForTimeout(250); const on = await alpha('#ck-rows .ckrow.on'); const hover = await alpha('#ck-rows .ckrow:hover');
  await page.hover('#ck-rows .ckrow.on'); await page.waitForTimeout(250); const onHover = await alpha('#ck-rows .ckrow.on');
  say(`the open row is stronger than a hovered one (${scheme})`, hover > 0 && on > hover && onHover === on && !page.errors.length, JSON.stringify({ on, hover, onHover }));
  await ctx.close();
}

{ // a row is as tall as its words whatever its mark, and a gap's ring is as wide as the drawn check mark
  const { ctx, page } = await checklist(); const m = await page.evaluate(() => {
    const one = [...document.querySelectorAll('#ck-rows .ckrow')].filter((r) => r.querySelector('.it').getBoundingClientRect().height < 24);
    const heights = [...new Set(one.map((r) => `${r.querySelector('.mk').classList[1]}:${Math.round(r.getBoundingClientRect().height)}`))].sort();
    const ring = parseFloat(getComputedStyle(document.querySelector('.ckrow .mk.k-gap'), '::before').width);
    const svg = document.querySelector('.ckrow .mk.k-satisfied svg'); const glyph = svg.querySelector('path').getBBox().width * svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
    return { heights, ring, glyph: Math.round(glyph * 10) / 10 };
  });
  say('rows are one height whatever their mark, and the ring matches the check mark', m.heights.join() === 'k-finding:43,k-gap:43,k-satisfied:43' && m.ring >= m.glyph && m.ring - m.glyph <= 1.5 && !page.errors.length, JSON.stringify(m));
  await ctx.close();
}

for (const size of SIZES) { // a quote with no spaces wraps inside the pane, and a long sheet reference gives way before the document's name does
  const { ctx, page, id } = await checklist('light', size); const loc = 'Decommissioning reserve schedule (base case)!AB1024:AC1090'; const quote = 'https://dataroom.example.com/deals/proseware/financial-model/reserves/decommissioning/DecommissioningReserveScheduleBaseCaseFinalVersion3.xlsx';
  await page.evaluate(async ([dealId, loc, quote]) => { const ai = store.services.ai; const c0 = ai.checklist;
    ai.checklist = async (d) => { const x = await c0(d); x.value = x.value.map((r) => r.text.startsWith('Decommissioning') ? { ...r, sources: [{ ...r.sources[0], loc, quote }] } : r); return x; };
    await store.refreshChecklist(dealId); }, [id, loc, quote]);
  await page.click('#ck-rows .ckrow:has-text("Decommissioning reserve")'); await page.waitForSelector('#ck-sources blockquote');
  const m = await page.evaluate(() => { const det = document.getElementById('ck-detail'); const right = det.getBoundingClientRect().right - parseFloat(getComputedStyle(det).paddingRight); const b = det.querySelector('.ckopen'); const r = (e) => e.getBoundingClientRect();
    return { sideways: det.scrollWidth > det.clientWidth, quoteIn: r(det.querySelector('blockquote')).right <= right + 0.5, rowIn: r(b).right <= right + 0.5, name: Math.round(r(b.querySelector('.cdn')).width), nameWhole: b.querySelector('.cdn').scrollWidth <= b.querySelector('.cdn').clientWidth, place: b.querySelector('.clc').scrollWidth > b.querySelector('.clc').clientWidth, title: b.title }; });
  say(`a long quote and a long sheet reference stay inside the pane (${size[0]})`, !m.sideways && m.quoteIn && m.rowIn && m.name > 0 && m.nameWhole && m.place && m.title === `Financial model.xlsx, ${loc}` && !page.errors.length, JSON.stringify(m));
  await ctx.close();
}

for (const size of SIZES) { // beside the pane the list ends where the pane does, and where rows are cut they fade out (top and bottom), not at the list's ends
  const { ctx, page } = await checklist('light', size); const at = () => page.evaluate(() => { const l = document.getElementById('ck-rows'); const cs = getComputedStyle(l); return { list: Math.round(l.getBoundingClientRect().bottom), pane: Math.round(document.getElementById('ck-detail').getBoundingClientRect().bottom), rail: Math.round(document.querySelector('.rail').getBoundingClientRect().bottom), top: cs.getPropertyValue('--qa-fade'), end: cs.getPropertyValue('--ck-end'), mask: cs.maskImage.includes('--ck-end') || /gradient/.test(cs.maskImage) }; });
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")');
  await page.waitForSelector('#ck-detail');
  const list = page.locator('#ck-rows');
  await list.evaluate((element) => { element.scrollTop = 0; });
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.getElementById('ck-rows'));
    return style.getPropertyValue('--qa-fade') === '0px' && style.getPropertyValue('--ck-end') === '22px';
  });
  const first = await at();
  await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForFunction(() => {
    const style = getComputedStyle(document.getElementById('ck-rows'));
    return style.getPropertyValue('--qa-fade') === '40px' && style.getPropertyValue('--ck-end') === '0px';
  });
  const last = await at();
  say(`the list ends with the pane, and fades where it is cut (${size[0]})`, first.list === first.pane
    && first.pane === first.rail && first.mask && first.top === '0px' && first.end === '22px' && last.top === '40px'
    && last.end === '0px' && !page.errors.length, JSON.stringify({ first, last }));
  await ctx.close();
}
{ // a deal in two versions pushes the list and the pane down; they get shorter and still end on the sidebar's bottom line, so Ask stays in the window
  const { ctx, page, id } = await checklist('light', SIZES[1]);
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.waitForSelector('#ck-ask');
  await page.evaluate((d) => window.__peer.edit(d, { name: 'Project Proseware (sroe)' }), id); await page.waitForFunction((d) => !!store.get().conflicts[d], id, { timeout: 8000 }); await page.waitForTimeout(200);
  await page.evaluate(() => document.getElementById('ck-ask').scrollIntoView({ block: 'nearest' }));
  const m = await page.evaluate(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const v = document.querySelector('.view'); return { page: v.scrollTop, list: Math.round(r('ck-rows').bottom), pane: Math.round(r('ck-detail').bottom), rail: Math.round(document.querySelector('.rail').getBoundingClientRect().bottom), ask: Math.round(r('ck-ask').bottom) }; });
  say('with the deal in two versions, the pane and its Ask stay in the window (1024)', m.page === 0 && m.list === m.rail && m.pane === m.rail && m.ask <= m.pane && !page.errors.length, JSON.stringify(m));
  await ctx.close();
}

for (const size of SIZES) { // opening the question box keeps Log question and Cancel in sight, clear of the fade; the box grows with its text instead of scrolling inside itself, and the pane's header stays put
  const { ctx, page } = await checklist('light', size); const at = () => page.evaluate(() => { const r = (e) => e.getBoundingClientRect(); const body = document.querySelector('#ck-detail .ckbody') ?? document.getElementById('ck-detail'); const t = document.getElementById('ck-ask-text');
    return { body: Math.round(r(body).bottom), log: Math.round(r(document.getElementById('ck-ask-log')).bottom), cancel: Math.round(r(document.getElementById('ck-ask-cancel')).bottom), head: Math.round(r(document.querySelector('#ck-detail .dmeta')).top), inside: t.scrollHeight <= t.clientHeight + 1 && t.scrollTop === 0 }; });
  await page.click('#ck-rows .ckrow:has-text("Lock-up ratio matches the term sheet")'); await page.waitForSelector('#ck-detail'); const head = await page.evaluate(() => Math.round(document.querySelector('#ck-detail .dmeta').getBoundingClientRect().top));
  // the box slides 8px up as it appears (.card's enter animation): measure where it comes to rest, not partway
  await page.click('#ck-ask'); await page.evaluate(() => Promise.all(document.querySelector('#ck-detail .ckask').getAnimations().map((a) => a.finished))); const opened = await at();
  await page.keyboard.type('Line one of the question\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven\nLine eight'); await page.waitForTimeout(100); const typed = await at();
  const clear = (m) => m.log <= m.body - 22 && m.cancel <= m.body - 22 && m.head === head;
  say(`the question box's buttons stay in sight and its text never scrolls inside it (${size[0]})`, clear(opened) && clear(typed) && typed.inside && !page.errors.length, JSON.stringify({ head, opened, typed }));
  await ctx.close();
}

for (const size of SIZES) { // the deal's Ask box grows a line at a time as a question is typed, up to its seven lines, rather than scrolling inside one line with its top line cut
  const { ctx, page } = await checklist('light', size); const at = () => page.evaluate(() => { const t = document.getElementById('hask'); return { h: t.clientHeight, all: t.scrollHeight, top: t.scrollTop }; });
  await page.click('#hask'); for (let i = 1; i <= 4; i++) { if (i > 1) await page.keyboard.press('Shift+Enter'); await page.keyboard.type(`Line ${i} of the question`); } await page.waitForTimeout(100); const four = await at();
  for (let i = 5; i <= 10; i++) { await page.keyboard.press('Shift+Enter'); await page.keyboard.type(`Line ${i} of the question`); } await page.waitForTimeout(100); const ten = await at();
  say(`the Ask box grows with the question instead of scrolling inside one line (${size[0]})`, four.h === 4 * 24 && four.all === four.h && four.top === 0 && ten.h === 7 * 24 && ten.all === 10 * 24 && !page.errors.length, JSON.stringify({ four, ten, errors: page.errors }));
  await ctx.close();
}

// a screen reader hears each item's group and how it stands, with the pane open too
{ const { ctx, page } = await checklist();
  await page.click('#ck-rows .ckrow[data-result="satisfied"]'); await page.waitForSelector('#ck-detail');
  const sr = await page.evaluate(() => { const name = (r) => r.textContent.replace(/\s+/g, ' ').trim(); const all = [...document.querySelectorAll('#ck-rows .ckrow')]; const ok = all.find((r) => r.dataset.result === "satisfied"), gap = all.find((r) => r.dataset.result === 'gap'); return { ok: name(ok), gap: name(gap), desc: ok.getAttribute('aria-description'), headsHidden: [...document.querySelectorAll('#ck-rows .ckgroup, #ck-rows .cksec, #ck-rows .cksub')].every((h) => h.getAttribute('aria-hidden') === 'true') }; });
  say('checklist-items-say-their-group-and-standing', /, Satisfied$/.test(sr.ok) && /, Gap/.test(sr.gap) && /^\S.*, \d+/.test(sr.desc ?? '') && sr.headsHidden, JSON.stringify(sr));
  await ctx.close(); }

{ // #2: a gap can be asked about. The question names the item, the pane lists it under Asked, and the wide row says so in place of the need
  const { ctx, page, id } = await checklist(); const GAP = 'Insurance advisor report (final)';
  await page.click(`#ck-rows .ckrow:has-text("${GAP}")`); await page.click('#ck-ask'); const card = await page.evaluate(() => document.querySelector('.ckask .clink').textContent);
  await page.fill('#ck-ask-text', 'Please provide the final insurance advisor report.'); await page.click('#ck-ask-log'); await page.waitForSelector('#ck-asked');
  const q = await page.evaluate(([d, t]) => { const rows = store.get().checklists[d]; const r = rows.find((x) => x.text === t); const q = Object.values(store.get().questions).find((x) => x.dealId === d); return { linked: q.linkedItem?.id === r.id, finding: q.linkedFinding ?? null, asked: document.querySelector('#ck-asked li').textContent }; }, [id, GAP]);
  await page.click('#ck-close'); const row = await rowOf(page, GAP);
  say('#2 asking about a gap links the question to the item', card === `Linked to “${GAP}”` && q.linked && q.finding === null && q.asked === 'Q1openPlease provide the final insurance advisor report.' && row.oc === 'Gap · Q1 open' && !page.errors.length, JSON.stringify({ card, q, row, errors: page.errors }));
  await ctx.close(); }

for (const size of SIZES) { // #2: questions whose item the checklist has settled: one line on Q&A, a preview, one change with Undo, and Close this question in the panel
  const { ctx, page, id } = await checklist('dark', size);
  const ids = await page.evaluate(async (d) => { const rows = store.get().checklists[d]; const ok = rows.find((r) => r.result === 'satisfied'), gap = rows.find((r) => r.result === 'gap'); const C = store.commandNamed('CreateQuestion');
    for (const [r, t] of [[ok, 'Has the model been audited?'], [ok, 'Who audited the model?'], [gap, 'Provide the final insurance report.']]) await store.dispatch(C, { dealId: d, text: t, linkedItem: r.id }, { quiet: true });
    return { ok: ok.text, qs: Object.values(store.get().questions).filter((q) => q.dealId === d).sort((a, b) => a.n - b.n).map((q) => q.id) }; }, id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-settled');
  const line = await page.textContent('#qa-settled');
  await page.click('#qa-settled-review'); await page.waitForSelector('#cs-list .lrow');
  const dlg = await page.evaluate(() => { const d = document.querySelector('.lnkdlg').getBoundingClientRect(); return { rows: [...document.querySelectorAll('#cs-list .lrow')].map((r) => r.querySelector('.lq').firstChild.textContent + ' ' + r.querySelector('.lfor').textContent), go: document.getElementById('cs-go').textContent, count: document.getElementById('cs-count').textContent, inside: d.top >= 0 && d.bottom <= innerHeight && [...document.querySelectorAll('.lnkdlg *')].every((e) => e.getBoundingClientRect().right <= d.right + 1) }; });
  await page.click('#cs-list .lrow >> nth=1'); const one = await page.textContent('#cs-go');
  // a stray close loses no uncheck: opened again, the same question is still unchecked (lost work first)
  await page.keyboard.press('Escape'); await page.waitForSelector('.lnkdlg', { state: 'detached' }); await page.click('#qa-settled-review'); await page.waitForSelector('#cs-list .lrow');
  const kept = await page.evaluate(() => [...document.querySelectorAll('#cs-list .lrow input')].map((i) => i.checked).join());
  await page.click('#cs-go'); await page.waitForFunction(() => !document.querySelector('.lnkdlg'));
  const after = await page.evaluate((qs) => qs.map((q) => store.get().questions[q].status), ids.qs);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'));
  // the one left open offers Close this question in its panel, named by what settled it; it closes on its own
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), ids.qs[1]); await page.waitForSelector('#q-close-settled');
  const btn = await page.evaluate(() => { const b = document.getElementById('q-close-settled'); return { text: b.innerText, tip: b.title, beside: !!b.closest('.racts')?.querySelector('#q-draft'), wrapped: b.parentElement.classList.contains('needs') }; });
  await page.click('#q-close-settled'); await page.waitForFunction((q) => store.get().questions[q].status === 'closed', ids.qs[1], { timeout: 5000 }).catch(() => {});
  const gone = await page.evaluate((q) => ({ status: store.get().questions[q].status, line: !!document.getElementById('qa-settled') }), ids.qs[1]);
  say(`#2 questions the checklist settled are closed by a person, with Undo (${size[0]})`, line === '2 open questions are settled on the checklist. Review' && dlg.rows.length === 2 && dlg.rows.every((r) => r.startsWith('Q') && r.includes(ids.ok)) && kept === 'true,false' && dlg.go === 'Close 2 questions' && dlg.count === '2 questions' && dlg.inside
    && one === 'Close 1 question' && after.join() === 'closed,open,open' && /1 question closed.*Undo/.test(toast)
    && btn.text === (size[0] < 1180 ? 'Close Q2' : 'Close This Question')
      && btn.tip.startsWith(`Close this question · ${ids.ok}: satisfied · `) && btn.beside && btn.wrapped
      && gone.status === 'closed' && !gone.line && !page.errors.length,
      JSON.stringify({ line, dlg, one, kept, after, toast, btn, gone, errors: page.errors }));
  await ctx.close();
}

for (const size of SIZES) { // #2: Add all unresolved to Q&A: from ⋯, a preview of one phrased question per gap and open finding, written as one change with Undo
  const { ctx, page, id } = await checklist('light', size);
  await page.evaluate((d) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Has the insurance advisor issued its final report?' }, { quiet: true }), id);   // open and unlinked: offered as a link
  await page.click('#ck-pmore'); const menu = await page.evaluate(() => [...document.querySelectorAll('#ck-menu .mi')].map((m) => [m.textContent, getComputedStyle(m).fontWeight]).join('|'));
  await page.click('#ck-add-unresolved'); await page.waitForSelector('#au-list .lrow', { timeout: 10000 });
  const pre = await page.evaluate(() => { const d = document.querySelector('.lnkdlg').getBoundingClientRect(); return { groups: [...document.querySelectorAll('#au-list .lgrp')].map((g) => g.textContent), rows: [...document.querySelectorAll('#au-list .lrow')].map((r) => [r.querySelector('input').checked, r.querySelector('.lfor').textContent]), go: document.getElementById('au-go').textContent, count: document.getElementById('au-count').textContent, inside: d.top >= 0 && d.bottom <= innerHeight + 1 }; });
  await page.click('#au-list .lrow:has-text("Link to") input'); const linked = await page.evaluate(() => ({ go: document.getElementById('au-go').textContent, count: document.getElementById('au-count').textContent }));
  // checking that point's new question again unchecks the link, so a point is never asked twice; then the link is chosen again
  await page.click('#au-list .lrow:not(:has-text("Link to")):has(input:not(:checked)) input'); const back = await page.evaluate(() => [...document.querySelectorAll('#au-list .lrow input')].filter((i) => i.checked).length + '/' + [...document.querySelectorAll('#au-list .lrow')].find((r) => r.textContent.includes('Link to')).querySelector('input').checked);
  await page.click('#au-list .lrow:has-text("Link to") input');
  await page.click('#au-go'); await page.waitForFunction(() => !document.querySelector('.lnkdlg'), null, { timeout: 5000 });
  const qs = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).sort((a, b) => a.n - b.n).map((q) => [q.n, !!q.linkedItem, !!q.linkedFinding]), id);
  const toast = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent).join('|'));
  await page.click('.toast button:has-text("Undo"), .toast .tundo').catch(() => {}); await page.waitForFunction((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length === 1, id, { timeout: 5000 }).catch(() => {});
  const undone = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).map((q) => !!q.linkedItem), id);
  say(`#2 Add all unresolved: preview, one change, one Undo (${size[0]})`, menu === 'Add All Unresolved to Q&A…,400'
    && pre.groups.join() === 'New Questions 5,Already Asked? 1' && pre.rows.length === 6
    && pre.rows.slice(0, 5).every(([on]) => on) && !pre.rows[5][0]
    && pre.rows.filter(([, f]) => f.startsWith('Finding · ')).length === 3 && pre.rows[5][1] === 'Link to Gap · Insurance advisor report (final)' && pre.go === 'Add 5 questions' && pre.count === '5 questions' && pre.inside
    && back === '5/false' && linked.go === 'Add 4 questions' && linked.count === '4 questions · 1 linked' && qs.length === 5 && JSON.stringify(qs[0]) === '[1,true,false]' && qs.slice(1).filter(([, i, f]) => i || f).length === 4 && /4 questions added · 1 linked.*Undo/.test(toast)
    && undone.join() === 'false' && !page.errors.length, JSON.stringify({ menu, pre, linked, back, qs, toast, undone, errors: page.errors }));
  await ctx.close();
}

const certificate = 'Certificate renewal lender compliance';
const alphaTitle = `${certificate} Alpha`;
const betaTitle = `${certificate} Beta`;
const openUnresolved = async (page) => {
  await page.click('#ck-pmore');
  await page.click('#ck-add-unresolved');
  await page.waitForSelector('#au-list .lrow input', { timeout: 10000 });
};

async function certificateSetup(page, dealId, partial) {
  return page.evaluate(async ({ dealId, partial, alphaTitle, betaTitle, certificate }) => {
    const run = (name, input) => store.dispatch(store.commandNamed(name), { dealId, ...input }, { quiet: true });
    const ai = store.services.ai;
    const rows = store.get().checklists[dealId];
    ai.checklist = async () => ({ ok: true, value: rows.map((row) => ({ ...row, result: 'satisfied' })) });
    for (const finding of Object.values(store.get().findings)) {
      await run('SetFindingStatus', { findingId: finding.id, status: 'closed' });
    }
    await store.refreshChecklist(dealId);
    ai.phrase = async ({ items }) => ({
      ok: true,
      value: items.map(({ what }) => partial && what === betaTitle ? null : `Please document ${what}.`),
    });
    for (const title of [betaTitle, alphaTitle]) await run('CreateFinding', { title, workstream: 'Legal' });
    await run('CreateQuestion', { text: certificate });
    const alpha = Object.values(store.get().findings).find((finding) => finding.title === alphaTitle).id;
    const beta = Object.values(store.get().findings).find((finding) => finding.title === betaTitle).id;
    return { alpha, beta };
  }, { dealId, partial, alphaTitle, betaTitle, certificate });
}

async function unresolvedSnapshot(page) {
  return page.evaluate(() => {
    const dialog = document.querySelector('.lnkdlg').getBoundingClientRect();
    const go = document.getElementById('au-go');
    const box = go.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(go);
    const text = range.getBoundingClientRect();
    return {
      rows: [...document.querySelectorAll('#au-list .lrow')].map((row) => ({
        question: row.querySelector('b')?.textContent,
        target: row.querySelector('.lfor').textContent,
        checked: row.querySelector('input').checked,
      })),
      button: go.textContent,
      inside: dialog.top >= 0 && dialog.bottom <= innerHeight + 1 && box.bottom <= dialog.bottom,
      centered: Math.abs((box.top + box.bottom - text.top - text.bottom) / 2) <= 1,
    };
  });
}

async function retainedLinkCase(scheme, size, partial) {
  const { ctx, page, id } = await checklist(scheme, size);
  const targets = await certificateSetup(page, id, partial);
  await openUnresolved(page);
  await page.click(`#au-list .lrow:has-text("Link to Finding · ${alphaTitle}") input`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.lnkdlg', { state: 'detached' });
  await page.evaluate(([dealId, text]) => store.dispatch(
    store.commandNamed('CreateQuestion'), { dealId, text }, { quiet: true },
  ), [id, alphaTitle]);
  await openUnresolved(page);
  await page.waitForTimeout(500);
  const preview = await unresolvedSnapshot(page);
  if (process.env.SHOTS) {
    const path = `${process.env.SHOTS}/kept-link-${scheme}-${size.join('x')}.png`;
    await page.screenshot({ path });
  }
  await page.click('#au-go');
  const closed = await page.waitForSelector('.lnkdlg', { state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  const written = await page.evaluate(({ alpha, beta }) => {
    const questions = Object.values(store.get().questions);
    return {
      first: questions.find((q) => q.n === 1)?.linkedFinding,
      alpha: questions.filter((q) => q.linkedFinding === alpha).length,
      beta: questions.filter((q) => q.linkedFinding === beta).length,
    };
  }, targets);
  const checkedLinks = preview.rows.filter((row) => row.question && row.checked);
  const betaDraft = preview.rows.find((row) => !row.question && row.target.endsWith(betaTitle));
  say(`#88 keeps the exact approved link ${scheme} ${size[0]} (partial=${partial})`,
    checkedLinks.length === 1 && checkedLinks[0].question === 'Q1' && checkedLinks[0].target.endsWith(alphaTitle)
    && preview.rows.find((row) => !row.question && row.target.endsWith(alphaTitle))?.checked === false
    && (partial ? !betaDraft : betaDraft?.checked)
    && preview.button === (partial ? 'Link 1 question' : 'Add 1 question')
    && preview.inside && preview.centered && closed && written.first === targets.alpha && written.alpha === 1
    && written.beta === (partial ? 0 : 1) && !page.errors.length,
    JSON.stringify({ preview, closed, written, errors: page.errors }));
  await ctx.close();
}

for (const [index, size] of SIZES.entries()) {
  await retainedLinkCase('light', size, index === 1);
  await retainedLinkCase('dark', size, index === 0);
}

{ // a checklist that cannot be read is said so, never taken for an empty one; and one phrasing per deal however often the dialog is opened
  const { ctx, page, id } = await checklist('light', SIZES[1]);
  await page.evaluate(() => { const ai = store.services.ai; const was = ai.phrase.bind(ai); window.__phrased = 0; ai.phrase = (i) => { window.__phrased++; return new Promise((r) => setTimeout(() => r(was(i)), 1500)); }; const read = ai.checklist.bind(ai); ai.checklist = (d) => (window.__ckFail ? Promise.resolve({ ok: false, error: { kind: 'failed', message: 'checklist failed' } }) : read(d)); });
  for (let i = 0; i < 3; i++) { await page.click('#ck-pmore'); await page.click('#ck-add-unresolved'); await page.waitForSelector('#au-list .phrow'); await page.waitForTimeout(400); await page.keyboard.press('Escape'); await page.waitForSelector('.lnkdlg', { state: 'detached' }); }
  await page.click('#ck-pmore'); await page.click('#ck-add-unresolved'); await page.waitForSelector('#au-list .lrow', { timeout: 10000 });
  const phrased = await page.evaluate(() => window.__phrased); await page.keyboard.press('Escape'); await page.waitForSelector('.lnkdlg', { state: 'detached' });
  // a gap asked about elsewhere in between changes the points: the rest were phrased already, so the model is not asked again
  await page.evaluate((d) => { const s = store.get(); const asked = new Set(Object.values(s.questions).map((q) => q.linkedItem?.id)); const g = s.checklists[d].find((r) => r.result === 'gap' && !asked.has(r.id)); return store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Asked elsewhere', linkedItem: g.id }, { quiet: true }); }, id);
  await page.click('#ck-pmore'); await page.click('#ck-add-unresolved'); await page.waitForSelector('#au-list .lrow', { timeout: 10000 });
  const again = await page.evaluate(() => window.__phrased); await page.keyboard.press('Escape'); await page.waitForSelector('.lnkdlg', { state: 'detached' });
  await page.evaluate(() => { window.__ckFail = true; });
  await page.click('#ck-pmore'); await page.click('#ck-add-unresolved'); await page.waitForSelector('#au-retry', { timeout: 10000 });
  const add = await page.evaluate(() => ({ said: document.getElementById('au-failed').textContent, foot: !!document.querySelector('.lnkdlg .xfoot'), tall: document.querySelector('.lnkdlg').classList.contains('tall'), none: !!document.getElementById('au-none'), rows: document.querySelectorAll('#au-list .lrow').length }));
  await page.evaluate(() => { window.__ckFail = false; }); await page.click('#au-retry'); const back = await page.waitForSelector('#au-list .lrow', { timeout: 10000 }).then(() => true, () => false);
  await page.keyboard.press('Escape'); await page.waitForSelector('.lnkdlg', { state: 'detached' });
  await page.evaluate(() => { window.__ckFail = true; });
  await page.evaluate((d) => store.ui({ dialog: { kind: 'closeSettled', dealId: d } }), id); await page.waitForSelector('#cs-failed', { timeout: 10000 });
  const cs = await page.evaluate(() => ({ text: document.getElementById('cs-failed').textContent, foot: !!document.querySelector('.lnkdlg .xfoot'), tall: document.querySelector('.lnkdlg').classList.contains('tall'), empty: !!document.querySelector('#cs-list .emptyline') }));
  await page.evaluate(() => { window.__ckFail = false; });
  say('a checklist that cannot be read is said so with Retry, and the dialog asks the model once however often it is opened', phrased === 1 && again === 1 && add.said === 'Couldn’t load the checklist. Retry' && !add.foot && !add.tall && !add.none && add.rows === 0 && back
    && cs.text === 'Couldn’t load the checklist. Retry' && !cs.foot && !cs.tall && !cs.empty && !page.errors.length, JSON.stringify({ phrased, again, add, back, cs, errors: page.errors }));
  await ctx.close();
}

{ // points the model gives no question are one line with Retry for just those, and the rest can be added; a run that failed shows no count above an empty list
  const { ctx, page } = await checklist('dark', SIZES[0]);
  await page.evaluate(() => { const ai = store.services.ai; const was = ai.phrase.bind(ai); ai.phrase = async (i) => { if (window.__slow) await new Promise((r) => setTimeout(r, 800)); if (window.__cutAll) return { ok: false, error: { kind: 'failed', message: 'Intelligence’s reply was cut off, so nothing was added' } }; window.__last = i.items.length; const r = await was(i); return r.ok ? { ok: true, value: r.value.map((t, n) => (n === 1 && !window.__heal ? null : t)) } : r; }; window.__cutAll = true; });
  await page.click('#ck-pmore'); await page.click('#ck-add-unresolved'); await page.waitForSelector('#au-retry', { timeout: 10000 });
  const cut = await page.evaluate(() => ({ groups: document.querySelectorAll('#au-list .lgrp').length, rows: document.querySelectorAll('#au-list .phrow, #au-list .lrow').length, foot: document.getElementById('au-count').textContent }));
  await page.evaluate(() => { window.__cutAll = false; }); await page.click('#au-retry'); await page.waitForSelector('#au-out', { timeout: 10000 });
  const left = await page.evaluate(() => ({ out: document.getElementById('au-out').textContent, inView: !!document.getElementById('au-out').closest('.xfoot'), rows: document.querySelectorAll('#au-list .lrow input:checked').length, go: document.getElementById('au-go').textContent, off: document.getElementById('au-go').disabled }));
  // a Retry that brings nothing again leaves the count as it was, with no alert beside a working Add
  await page.evaluate(() => { window.__cutAll = true; }); await page.click('#au-retry-out'); await page.waitForSelector('#au-retry-out', { timeout: 10000 });
  const still = await page.evaluate(() => ({ out: document.getElementById('au-out').textContent, alert: !!document.querySelector('#au-count.err, [role=alert]'), off: document.getElementById('au-go').disabled }));
  // Retry on that line asks for the one point only, and its question joins the list, checked; Add stays usable meanwhile
  await page.evaluate(() => { window.__heal = true; window.__cutAll = false; window.__slow = true; }); await page.click('#au-retry-out');
  const during = await page.evaluate(() => ({ out: document.getElementById('au-out').textContent, off: document.getElementById('au-go').disabled }));
  await page.waitForSelector('#au-out', { state: 'detached', timeout: 10000 }); await page.evaluate(() => { window.__slow = false; });
  const healed = await page.evaluate(() => ({ last: window.__last, rows: document.querySelectorAll('#au-list .lrow input:checked').length }));
  await page.click('#au-go'); await page.waitForSelector('.lnkdlg', { state: 'detached', timeout: 10000 });
  say('a point with no question is counted beside the count with Retry for just it, a Retry that fails again changes nothing, the rest are added, and a failed run shows no count over an empty list', cut.groups === 0 && cut.rows === 0 && /cut off/.test(cut.foot)
    && left.out === '· 1 point could not be drafted. Retry' && still.out === left.out && !still.alert && !still.off
    && left.inView && left.rows > 0 && left.go === `Add ${left.rows.toLocaleString('en-US')} question${left.rows === 1 ? '' : 's'}` && !left.off
    && during.out === '· Drafting 1 more…' && !during.off && healed.last === 1 && healed.rows === left.rows + 1 && !page.errors.length, JSON.stringify({ cut, left, still, during, healed, errors: page.errors }));
  await ctx.close();
}

{ // Add pressed while a Retry is drafting adds the questions listed, and the Retry coming back later breaks nothing
  const { ctx, page } = await checklist('dark', SIZES[0]);
  await page.evaluate(() => { const ai = store.services.ai; const was = ai.phrase.bind(ai); ai.phrase = async (i) => { if (window.__slow) await new Promise((r) => setTimeout(r, 1500)); const r = await was(i); return r.ok ? { ok: true, value: r.value.map((t, n) => (n === 1 && !window.__heal ? null : t)) } : r; }; });
  await page.click('#ck-pmore'); await page.click('#ck-add-unresolved'); await page.waitForSelector('#au-retry-out', { timeout: 10000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  const before = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id);
  const rows = await page.evaluate(() => document.querySelectorAll('#au-list .lrow input:checked').length);
  await page.evaluate(() => { window.__heal = true; window.__slow = true; }); await page.click('#au-retry-out'); await page.click('#au-go');
  await page.waitForSelector('.lnkdlg', { state: 'detached', timeout: 10000 }); await page.waitForTimeout(2000);
  const after = await page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id);
  await page.evaluate(() => { window.__heal = false; window.__slow = false; });
  say('Add pressed while a Retry drafts adds the questions listed, and the Retry coming back later breaks nothing', rows > 0 && after - before === rows && !page.errors.length, JSON.stringify({ rows, before, after, errors: page.errors }));
  await ctx.close();
}

{ // (lost work): a question being typed on a gap stays when someone else asks about that gap first, and can still be logged
  const { ctx, page, id } = await checklist('light', SIZES[0]);
  const gap = await page.evaluate((d) => { const asked = new Set(Object.values(store.get().questions).map((q) => q.linkedItem?.id)); const g = store.get().checklists[d].find((r) => r.result === 'gap' && r.need && !asked.has(r.id)); return { id: g.id, text: g.text, need: g.need }; }, id);
  await page.locator('#ck-rows .ckrow').filter({ hasText: gap.text }).first().click(); await page.click('#ck-ask');
  const start = await page.inputValue('#ck-ask-text');
  await page.fill('#ck-ask-text', 'Could you send the signed certificate, please?');
  await page.evaluate(([d, g]) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Another PC asked this', linkedItem: g }, { quiet: true }), [id, gap.id]);
  await page.waitForSelector('#ck-asked'); await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({ box: document.getElementById('ck-ask-text')?.value ?? null, ask: !!document.getElementById('ck-ask'), log: document.getElementById('ck-ask-log')?.disabled ?? null }));
  await page.click('#ck-ask-log'); await page.waitForFunction(() => !document.getElementById('ck-ask-text'), null, { timeout: 5000 }).catch(() => {});
  const logged = await page.evaluate((g) => Object.values(store.get().questions).filter((q) => q.linkedItem?.id === g).map((q) => q.text), gap.id);
  say('a question typed on a gap stays when another PC asks about the gap first, and can still be logged; the box starts from the need and Ask goes once asked', start === gap.need && after.box === 'Could you send the signed certificate, please?' && after.log === false && !after.ask
    && logged.includes('Could you send the signed certificate, please?') && logged.length === 2 && !(await page.$('#ck-ask')) && !page.errors.length, JSON.stringify({ gap, start, after, logged, errors: page.errors }));
  await ctx.close();
}

{ // (lost work): Escape never leaves a kept question with no way back, in either order, and Log question stays in sight
  for (const [scheme, size] of [['light', SIZES[0]], ['dark', SIZES[1]]]) {
    const { ctx, page, id } = await checklist(scheme, size);
    const gaps = await page.evaluate((d) => { const asked = new Set(Object.values(store.get().questions).map((q) => q.linkedItem?.id)); return store.get().checklists[d].filter((r) => r.result === 'gap' && !asked.has(r.id)).slice(0, 2).map((g) => ({ id: g.id, text: g.text })); }, id);
    const other = (g) => page.evaluate(([d, x]) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Another PC asked this', linkedItem: x }, { quiet: true }), [id, g.id]);
    const state = () => page.evaluate(() => { const pane = document.getElementById('ck-detail').getBoundingClientRect(); const log = document.getElementById('ck-ask-log')?.getBoundingClientRect(); return { box: document.getElementById('ck-ask-text')?.value ?? null, ask: !!document.getElementById('ck-ask'), logIn: log ? log.bottom <= pane.bottom : null }; });
    // another PC asks while typing, then Escape
    await page.locator('#ck-rows .ckrow').filter({ hasText: gaps[0].text }).first().click(); await page.click('#ck-ask'); await page.fill('#ck-ask-text', 'First kept question');
    await other(gaps[0]); await page.waitForSelector('#ck-asked'); await page.waitForTimeout(300); const typing = await state();
    await page.press('#ck-ask-text', 'Escape'); await page.waitForTimeout(200); const esc1 = await state();
    await page.click('#ck-ask'); const back1 = await state();
    // Escape first, then another PC asks
    await page.locator('#ck-rows .ckrow').filter({ hasText: gaps[1].text }).first().click(); await page.click('#ck-ask'); await page.fill('#ck-ask-text', 'Second kept question');
    await page.press('#ck-ask-text', 'Escape'); await other(gaps[1]); await page.waitForSelector('#ck-asked'); await page.waitForTimeout(300); const esc2 = await state();
    await page.click('#ck-ask'); const back2 = await state();
    say(`Escape never hides a kept question for good, in either order, and Log question stays in sight (${scheme})`, typing.box === 'First kept question' && typing.logIn === true && !typing.ask
      && esc1.box === null && esc1.ask && back1.box === 'First kept question' && esc2.ask && back2.box === 'Second kept question' && !page.errors.length, JSON.stringify({ typing, esc1, back1, esc2, back2, errors: page.errors }));
    await ctx.close();
  }
}

{ // an item held back by documents that cannot be read names them; a long file name wraps in the pane rather than widening it
  const LONG = 'Proseware_Credit_Agreement_Execution_Version_Clean_incorporating_all_lender_comments_received_2026-11-14_FINAL_v12.pdf';   // no space to break at
  for (const scheme of ['light', 'dark']) for (const size of SIZES) {
    const { ctx, page, id } = await checklist(scheme, size);
    await page.evaluate(async ([dealId, long]) => { const ai = store.services.ai; const c0 = ai.checklist;
      ai.checklist = async (d) => { const x = await c0(d); x.value = [{ id: 'u1', text: 'Credit agreement is executed by all parties', result: 'unsettled', docs: [], why: `The documents chosen for it could not be opened on this PC: ${long}, Shareholders Agreement.pdf and 3 more.` }, ...x.value]; return x; };
      await store.refreshChecklist(dealId); }, [id, LONG]);
    await page.click('#ck-rows .ckrow:has-text("Credit agreement is executed by all parties")'); await page.waitForSelector('#ck-why');
    const why = await page.evaluate(() => { const p = document.getElementById('ck-why'); const pane = document.getElementById('ck-detail'); const box = p.getBoundingClientRect(), pb = pane.getBoundingClientRect(); return { text: p.textContent, inside: box.right <= pb.right + 0.5 && box.left >= pb.left - 0.5, sideways: [...pane.querySelectorAll('*')].some((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible') || pane.scrollWidth > pane.clientWidth + 1 }; });
    say(`a long file name in why an item could not be checked wraps in the pane (${scheme} ${size.join('x')})`, why.text.includes(LONG) && why.inside && !why.sideways && !page.errors.length, JSON.stringify(why));
    if (process.env.SHOTS) { await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 }).catch(() => {}); } if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/why-wraps-${scheme}-${size.join('x')}.png` });
    await ctx.close();
  }
}

{ // #2: Add all unresolved can also be typed in the ask box, and opens the same preview
  const { ctx, page } = await checklist('dark', SIZES[0]);
  await page.click('#dask textarea'); await page.fill('#dask textarea', 'Add all unresolved to Q&A'); await page.press('#dask textarea', 'Enter');
  const opened = await page.waitForSelector('#au-list .lrow', { timeout: 10000 }).then(() => true, () => false);
  const left = await page.evaluate(() => ({ text: document.querySelector('#dask textarea').value, threads: Object.keys(store.get().threads).length }));
  say('#2 typing Add all unresolved in the ask box opens its preview, and asks nothing', opened && left.text === '' && left.threads === 0 && !page.errors.length, JSON.stringify({ opened, left, errors: page.errors }));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
