// A document's drafts in reading mode: the open draft's date in the reading bar opens the list of drafts,
// newest first; an earlier draft opens on its own and is marked so under its name. Checked in both themes and both sizes.
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
const SHOTS = process.env.SHOTS || '';
/** the reading bar and the drafts list stay inside the document pane, and nothing in the bar wraps */
const fits = (page) => page.evaluate(() => {
  const pane = document.querySelector('.docpanel').getBoundingClientRect(); const inside = (el) => { if (!el) return true; const r = el.getBoundingClientRect(); return r.left >= pane.left - 1 && r.right <= pane.right + 1 && r.top >= 0; };
  return inside(document.querySelector('.docnav')) && inside(document.querySelector('.dl')) && document.querySelector('#doc-drafts').getBoundingClientRect().height <= 31;
});

async function chipsInReadingMode(page, selected, shot) {
  const chips = page.locator('.msgs .ai:not(.pending) .rsch-chip');
  await chips.nth(selected).click();
  await page.waitForSelector('.docpanel .page:not(.ph-page)');
  // Let the layout settle after the reader opens and narrows the conversation.
  await page.waitForTimeout(500);
  const measurements = await chips.evaluateAll((items) => items.map((chip) => {
    const name = chip.querySelector('.docnm');
    const head = name.querySelector('.dnh');
    const lastNamePart = name.querySelector('.dnt') ?? head;
    const location = chip.querySelector('em');
    const tag = chip.querySelector('.rdg');
    const bounds = chip.getBoundingClientRect();
    const column = chip.closest('.msgs').getBoundingClientRect();
    const nameOverflow = name.scrollWidth - name.clientWidth;
    const locationGap = location.getBoundingClientRect().left - lastNamePart.getBoundingClientRect().right;
    const textFits = (part) => {
      const range = document.createRange();
      range.selectNodeContents(part);
      const text = range.getBoundingClientRect();
      const box = part.getBoundingClientRect();
      return text.left >= box.left - 0.5 && text.right <= box.right + 0.5
        && box.right <= bounds.right && Math.abs((text.top + text.bottom - bounds.top - bounds.bottom) / 2) <= 1;
    };
    return {
      label: chip.getAttribute('aria-label'), name: name.textContent, location: location.textContent,
      tag: tag?.textContent ?? '', ellipsis: getComputedStyle(head).textOverflow === 'ellipsis',
      shortened: head.scrollWidth > head.clientWidth + 1,
      fits: bounds.height === 28 && bounds.left >= column.left && bounds.right <= column.right + 0.5
        && chip.scrollWidth <= chip.clientWidth && nameOverflow <= 1 && locationGap >= 5.5,
      nameOverflow, locationGap,
      detailsFit: [location, tag].filter(Boolean).every(textFits),
    };
  }));
  if (shot) await page.screenshot({ path: shot, animations: 'disabled' });
  const hover = measurements.findIndex((chip) => chip.shortened);
  let tooltip = '';
  if (hover >= 0) {
    await chips.nth(hover).locator('.docnm').hover();
    await page.waitForSelector('.tip');
    tooltip = await page.textContent('.tip');
    await page.mouse.move(2, 2);
  }
  return { measurements, tooltip, fullName: measurements[hover]?.name ?? '' };
}

for (const [scheme, w, h] of [['dark', 1280, 736], ['light', 1280, 736], ['dark', 1024, 640], ['light', 1024, 640]]) {
  const tag = `${scheme}-${w}`;
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create');
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 60000 });
  const id = await page.evaluate(() => Object.keys(store.get().deals)[0]);
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow');
  await page.locator('.flagrow:has-text("Lock-up ratio")').click(); await page.waitForSelector('.opening .ref .rb');

  // 1 the newest draft open: its date in the bar, no earlier-draft mark
  await page.locator('.opening .ref .rb').first().click(); await page.waitForSelector('#doc-drafts', { timeout: 8000 });
  const bar = await page.evaluate(() => [document.querySelector('#doc-drafts').textContent, document.querySelector('#doc-drafts').title, !!document.querySelector('.docnav .docname small')]);
  say(`${tag}:newest-shows-its-date`, bar[0] === 'Apr 15' && bar[1] === '3 drafts' && !bar[2], JSON.stringify(bar));
  // a document in no family has no control
  await page.click('#doc-next'); await page.waitForFunction(() => /Term sheet/.test(document.querySelector('.docnav .docname').textContent)); await page.waitForTimeout(300);
  say(`${tag}:no-control-without-drafts`, !(await page.$('#doc-drafts')));
  await page.click('#doc-prev'); await page.waitForSelector('#doc-drafts');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/A-newest-${tag}.png` });

  // 2 the list: newest first, the open one marked, inside the pane
  await page.click('#doc-drafts'); await page.waitForSelector('.dl');
  const rows = await page.evaluate(() => [...document.querySelectorAll('.dl .dm-r')].map((r) => [r.querySelector('.dt').textContent, r.querySelector('.nw').textContent, r.getAttribute('aria-checked')]));
  say(`${tag}:list-newest-first`, JSON.stringify(rows) === JSON.stringify([['Apr 15, 2026', 'Newest', 'true'], ['Mar 20, 2026', '', 'false'], ['Mar 1, 2026', '', 'false']]), JSON.stringify(rows));
  say(`${tag}:list-fits`, await fits(page));
  say(`${tag}:focus-in-list`, await page.evaluate(() => !!document.activeElement?.closest('.dl')));
  if (SHOTS) { await page.waitForTimeout(500); await page.screenshot({ path: `${SHOTS}/B-list-${tag}.png` }); }
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);
  say(`${tag}:escape-closes`, !(await page.$('.dl')));

  // 3 an earlier draft: opens on its own at its first page, marked under its name, the newest named in the tooltip
  await page.click('#doc-drafts'); await page.waitForSelector('.dl'); await page.locator('.dl .dm-r').nth(2).click();
  await page.waitForSelector('.docnav .docname small', { timeout: 8000 }); await page.waitForFunction(() => /^p\. 1 of/.test(document.querySelector('.docnav .loc').textContent), null, { timeout: 8000 }).catch(() => {});
  const early = await page.evaluate(() => [document.querySelector('.docnav .docname small').textContent, document.querySelector('.docnav .docname small').title, document.querySelector('#doc-drafts').textContent, document.querySelector('.docnav .loc').textContent, store.get().ui.docAside?.docId !== undefined]);
  // it is not a citation, so the bar gives its page of how many, never "Not cited"
  say(`${tag}:earlier-marked`, JSON.stringify(early.filter((_, i) => i !== 3)) === JSON.stringify(['Earlier draft', 'The newest is Apr 15, 2026', 'Mar 1', true]) && /^p\. 1 of \d+$/.test(early[3]) && !(await page.$('.docnav .cnt.off')), JSON.stringify(early));
  say(`${tag}:earlier-fits`, await fits(page));
  if (SHOTS) { await page.waitForSelector('.docpanel .page:not(.ph-page)'); await page.waitForTimeout(400); await page.screenshot({ path: `${SHOTS}/C-earlier-${tag}.png` }); }
  // and back to the newest from the list: the cited page again
  await page.click('#doc-drafts'); await page.locator('.dl .dm-r').first().click(); await page.waitForFunction(() => !document.querySelector('.docnav .docname small'));
  say(`${tag}:back-to-newest-at-its-citation`, await page.evaluate(() => document.querySelector('.docnav .loc').textContent === 'p. 142' && store.get().ui.docAside === null));
  // 4 an answer that cites a blackline: its chip says "reading", the tooltip says why, and it fits the column
  await page.goto(URL + `#overview-${id}`); await page.waitForSelector('#hask');
  await page.fill('#hask', 'What changed in the lock-up ratio in the latest draft?');
  await page.press('#hask', 'Enter');
  await page.waitForSelector('.msgs .ai:not(.pending) .rsch-chip', { timeout: 15000 }); await page.waitForTimeout(300);
  const chips = await page.evaluate(() => [...document.querySelectorAll('.msgs .ai:not(.pending) .rsch-chip')].map((c) => { const r = c.querySelector('.rdg'); const b = c.getBoundingClientRect(), m = document.querySelector('.msgs').getBoundingClientRect(); return [c.querySelector('.docnm')?.textContent ?? c.textContent, r?.textContent ?? '', r?.title ?? '', b.right <= m.right + 1 && b.height <= 30]; }));
  say(`${tag}:blackline-chip-reading`, chips.length === 2 && chips[0][1] === 'reading'
    && /AI's reading/.test(chips[0][2]) && chips[1][1] === '' && chips.every((c) => c[3]), JSON.stringify(chips));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/D-reading-${tag}.png` });
  const blackline = await chipsInReadingMode(page, 0, SHOTS && `${SHOTS}/441-${tag}.png`);
  // 5 an answer that cites another project's document beside this deal's own: its chip says "precedent", the tooltip says why
  await page.goto(URL + `#overview-${id}`); await page.waitForSelector('#hask'); await page.fill('#hask', 'How does the lock-up compare with the precedent?'); await page.press('#hask', 'Enter');
  await page.waitForSelector('.msgs .ai:not(.pending) .rsch-chip', { timeout: 15000 }); await page.waitForTimeout(300);
  const pre = await page.evaluate(() => [...document.querySelectorAll('.msgs .ai:not(.pending) .rsch-chip')].map((c) => { const r = c.querySelector('.rdg'); const b = c.getBoundingClientRect(), m = document.querySelector('.msgs').getBoundingClientRect(); return [r?.textContent ?? '', r?.title ?? '', b.right <= m.right + 1 && b.height <= 30]; }));
  say(`${tag}:precedent-chip`, pre.length === 2 && pre[0][0] === '' && pre[1][0] === 'precedent' && pre[1][1] === "Another project's document, not this deal's terms." && pre.every((c) => c[2]), JSON.stringify(pre));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/E-precedent-${tag}.png` });
  const precedent = await chipsInReadingMode(page, 1, SHOTS && `${SHOTS}/441-precedent-${tag}.png`);
  const shown = [...blackline.measurements, ...precedent.measurements];
  const details = shown.map(({ name, location, tag: badge }) => [name, location, badge]);
  const expected = [
    ['Credit agreement (blackline).pdf', 'p. 12', 'reading'],
    ['Credit agreement (draft 1).pdf', 'p. 142', ''],
    ['Credit agreement (draft 1).pdf', 'p. 142', ''],
    ['Coho Solar credit agreement (executed).pdf', 'p. 88', 'precedent'],
  ];
  say(`${tag}:chip-places-and-tags-stay-whole-in-reading-mode`,
    JSON.stringify(details) === JSON.stringify(expected)
    && shown.every(({ fits, detailsFit, ellipsis, label, name, location }) =>
      fits && detailsFit && ellipsis && label === `Open ${name}, ${location}`)
    && [blackline, precedent].every(({ tooltip, fullName }) => fullName && tooltip === fullName),
    JSON.stringify({ blackline, precedent }));
  say(`${tag}:no-page-errors`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
