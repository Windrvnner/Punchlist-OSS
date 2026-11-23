// The firm's checklist: bringing a list in from Settings, its review, the pick lists on Overview, and Undo.
// Runs on the mock services, whose rewording and duplicate check stand in for the fast model.
import { launchChrome } from './chrome.mjs';
import { checkDuplicateRetries } from './firmlistRetries.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firmlist-'));
const csv = path.join(dir, 'Solar checklist.csv');
fs.writeFileSync(csv, ['Area,Requirement,Owner', 'Interconnection,Interconnection agreement executed; conditions to energization identified,AM', 'Interconnection,Network upgrade costs allocated and capped,AM',
  'Equipment,Inverter supply / LTSA in place,SL', 'Land,Site control covers the whole array and the gen-tie,PN', 'Interconnection,interconnection agreement executed; conditions to energization identified.,AM'].join('\n'));
const general = path.join(dir, 'General.csv');
fs.writeFileSync(general, ['Checklist item', 'Insurance is in place', 'Site control covers the whole array and the gen-tie'].join('\n'));
const browser = await launchChrome();

async function start(size = [1280, 736], scheme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-create'); await page.waitForSelector('#ov-details');
  return { ctx, page, id: await page.evaluate(() => Object.values(store.get().deals)[0].id) };
}
async function bring(page, file, layer, name, beforeGo = async () => {}) {
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open');
  await page.waitForSelector('#fl-import'); await page.click('#fl-import'); await page.setInputFiles('#cl-file', file); await page.waitForSelector('#cl-next');
  await page.click(`[data-layer=${layer}]`); if (name) await page.fill('#cl-name', name);
  await page.click('#cl-next'); await page.waitForSelector('#cl-go'); await beforeGo(); await page.click('#cl-go'); await page.waitForSelector('#fl-count');
}
/** waits for the model's reading of the list to finish */
const read = (page) => page.waitForFunction(() => !/^Asking/.test(document.querySelector('#cl-line')?.textContent ?? 'Asking'), null, { timeout: 30000 });
const itemsOf = (page, id) => page.evaluate((d) => Object.values(store.get().items).filter((i) => i.dealId === d).map((i) => [i.text, i.off]).sort(), id);

{ // The general list goes to the deal at once; the review offers wording and duplicates, and changes only what is checked
  const { ctx, page, id } = await start();
  await bring(page, general, 'broad', '');
  const afterGeneral = await itemsOf(page, id);
  await page.keyboard.press('Escape');
  await bring(page, csv, 'technology', 'Solar', async () => {
    const seen = await page.evaluate(() => ({ rewords: document.querySelectorAll('#cl-rewords [data-reword]').length, pairs: document.querySelectorAll('#cl-pairs .rv-pair').length, checked: document.querySelectorAll('#cl-rewords input:checked, #cl-pairs input:checked').length, general: [...document.querySelectorAll('#cl-pairs .tag')].map((t) => t.textContent) }));
    say('review: suggestions and duplicates are listed, none checked, a match in the general list cannot be checked', seen.rewords >= 2 && seen.pairs === 2 && seen.checked === 0 && seen.general.includes('General'), JSON.stringify(seen));
    await page.click('#cl-rewords [data-reword="2"]'); await page.click('#cl-pairs [data-remove="4"]');
    const line = await page.textContent('#cl-line');
    say('review: the line counts what will be imported', /Import 4 items · 1 reworded · 1 removed/.test(line), line);
    // Esc closes at once and keeps the import: opened again, the review comes back with its check marks; Back and Next show the same review, check marks and all
    await page.keyboard.press('Escape'); const closes = await page.waitForSelector('.imdlg', { state: 'detached', timeout: 2000 }).then(() => true, () => false);
    await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import'); await page.waitForSelector('#cl-go');
    const kept = await page.evaluate(() => !!document.querySelector('#cl-go') && document.querySelectorAll('#cl-rewords input:checked, #cl-pairs input:checked').length === 2);
    await page.click('#cl-line ~ .btn:not(.pri)'); await page.waitForSelector('#cl-next'); await page.click('#cl-next'); await page.waitForSelector('#cl-go');
    const back = await page.evaluate(() => document.querySelectorAll('#cl-rewords input:checked, #cl-pairs input:checked').length === 2);
    say('Esc closes an import and keeps it, review and check marks, and Back keeps them too', closes && kept && back, JSON.stringify({ closes, kept, back }));
  });
  const lists = await page.evaluate(() => Object.values(store.get().firmList).sort((a, b) => ['broad', 'product', 'sector', 'technology'].indexOf(a.layer) - ['broad', 'product', 'sector', 'technology'].indexOf(b.layer)).map((l) => [l.layer, l.name, l.items.map((i) => i.text)]));
  say('the general list is on the deal at once; a technology list is not, until the deal has that technology', afterGeneral.length === 2 && (await itemsOf(page, id)).length === 2, JSON.stringify(afterGeneral));
  say('only what was checked is reworded or removed', JSON.stringify(lists[1]) === JSON.stringify(['technology', 'Solar', ['Interconnection agreement executed; conditions to energization identified', 'Network upgrade costs allocated and capped', 'Inverter supply and long-term service agreement in place.', 'Site control covers the whole array and the gen-tie']]), JSON.stringify(lists));
  await page.keyboard.press('Escape');
  // the same file brought in again: the rewording taken last time comes back checked, so the old wording is not added beside it
  await bring(page, csv, 'technology', 'Solar', async () => {
    const again = await page.evaluate(() => ({ checked: [...document.querySelectorAll('#cl-rewords input:checked')].map((i) => i.dataset.reword), tip: document.querySelector('#cl-rewords [data-reword="2"]')?.closest('label')?.title }));
    say('importing the same file again offers the earlier rewording checked, with why in its tooltip',
      JSON.stringify(again.checked) === '["2"]' && /last imported/.test(again.tip ?? ''), JSON.stringify(again));
    await page.click('#cl-pairs [data-remove="4"]');
  });
  const relisted = await page.evaluate(() => Object.values(store.get().firmList).find((l) => l.layer !== 'broad').items.map((i) => [i.text, i.was ?? '']));
  say('the list brought in again keeps the rewording and the file’s own wording beside it', JSON.stringify(relisted.map(([t]) => t)) === JSON.stringify(lists[1][2]) && relisted[2][1] === 'Inverter supply / LTSA in place', JSON.stringify(relisted));
  await page.keyboard.press('Escape');
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#pick-technology > button');
  await page.click('#pick-technology > button'); await page.waitForSelector('.pk-menu [data-pick="Solar"]');
  const menu = await page.evaluate(() => { const m = document.querySelector('.pk-menu').getBoundingClientRect(); return { right: m.right <= innerWidth, focus: document.activeElement?.closest('.pk-menu') !== null }; });
  await page.click('.pk-menu [data-pick="Solar"]'); await page.waitForFunction(() => /Technology set to Solar/.test(document.body.innerText));
  const after = await itemsOf(page, id); const askedSolar = !!(await page.$('.scrim'));
  say('picking Solar adds its items the deal does not hold, without asking, with a list that stays in the window', !askedSolar && menu.right && menu.focus && after.length === 5 && after.every(([, off]) => !off), JSON.stringify({ askedSolar, menu, after }));
  await page.click('#toast .tundo'); await page.waitForFunction(() => !Object.values(store.get().deals)[0].technology);
  const undone = await itemsOf(page, id);
  say('Undo puts the technology back and turns its items off, removing none', undone.length === 5 && undone.filter(([, off]) => off).length === 3, JSON.stringify(undone));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // The New deal form picks from the firm's lists, with search once there are many; changing a list offers to turn off the old one's items
  const { ctx, page } = await start();
  const one = (name, rows) => { const f = path.join(dir, `${name}.csv`); fs.writeFileSync(f, ['Item', ...rows].join('\n')); return f; };
  await bring(page, one('LNG', ['LNG supply agreement executed', 'Marine terminal permits in place', 'Insurance is in place']), 'technology', 'LNG'); await page.keyboard.press('Escape');
  await bring(page, one('CCGT', ['Air permit issued', 'Insurance is in place']), 'technology', 'CCGT'); await page.keyboard.press('Escape');
  for (const t of ['Biomass', 'Geothermal', 'Hydro', 'Nuclear', 'Offshore wind', 'Onshore wind', 'Solar']) { await bring(page, one(t, [`${t} study reviewed`]), 'technology', t); await page.keyboard.press('Escape'); }
  await page.click('#new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', 'Coho'); await page.click('#nd-technology > button'); await page.waitForSelector('#nd-technology-menu input');
  const searchFirst = await page.evaluate(() => document.activeElement?.matches('#nd-technology-menu input'));
  await page.keyboard.type('ln'); const shown = await page.$$eval('#nd-technology-menu .scroll [data-pick]', (b) => b.map((x) => x.dataset.pick));
  await page.keyboard.press('Escape'); const keptDialog = !!(await page.$('#nd-name')) && !(await page.$('#nd-technology-menu'));
  await page.click('#nd-technology > button'); await page.keyboard.type('lng'); await page.keyboard.press('Enter');
  say('New deal: 9 lists open on a search box, typing narrows them, Escape closes only the menu, Enter picks the first', searchFirst && JSON.stringify(shown) === '["LNG"]' && keptDialog && (await page.textContent('#nd-technology > button')) === 'LNG', JSON.stringify({ searchFirst, shown, keptDialog }));
  await page.click('#nd-create'); await page.waitForFunction(() => /Coho/.test(document.querySelector('h1')?.textContent ?? '') && document.querySelector('#pick-technology > button'));
  const id = await page.evaluate(() => Object.values(store.get().deals).find((d) => d.name.includes('Coho')).id); await page.evaluate(() => { for (const t of store.get().ui.toasts) store.dismissToast(t.id); });
  const made = await itemsOf(page, id);
  say('a deal created with LNG starts with LNG’s items', made.length === 3 && made.every(([, off]) => !off), JSON.stringify(made));
  const coho = () => page.evaluate(() =>
    Object.values(store.get().deals).find((d) => d.name.includes('Coho')).technology);
  // a swap that turns items off asks first; Keep it, and Escape, leave the deal as it was
  await page.click('#pick-technology > button'); await page.keyboard.type('ccgt'); await page.keyboard.press('Enter');
  await page.waitForSelector('#ask-keep:focus');
  const ask = await page.evaluate(() => ({ title: document.querySelector('#ask-title').textContent, text: document.querySelector('#ask-text').textContent, go: document.querySelector('#ask-go').textContent }));
  await page.click('#ask-keep'); await page.waitForFunction(() => !document.querySelector('.scrim'));
  const kept = { tech: await coho(), items: await itemsOf(page, id) };
  await page.click('#pick-technology > button'); await page.keyboard.type('ccgt'); await page.keyboard.press('Enter'); await page.waitForSelector('#ask-keep:focus');
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.scrim'));
  const escaped = await coho();
  say('picking CCGT asks first, with how many items go off and come on; Keep it and Escape change nothing', ask.title === 'Switch Technology to CCGT?' && ask.text === '2 checklist items go off and 1 comes on.' && ask.go === 'Switch'
    && kept.tech === 'LNG' && JSON.stringify(kept.items) === JSON.stringify(made) && escaped === 'LNG', JSON.stringify({ ask, kept, escaped }));
  await page.click('#pick-technology > button'); await page.keyboard.type('ccgt'); await page.keyboard.press('Enter'); await page.waitForSelector('#ask-go'); await page.click('#ask-go');
  await page.waitForFunction(() => /Technology set to CCGT/.test(document.querySelector('#toast')?.textContent ?? ''));
  const toast = await page.textContent('#toast');
  const changed = await itemsOf(page, id);
  say('Switch swaps lists: the 2 items only LNG brought go off, the shared item stays on, the toast says so', /Technology set to CCGT · 2 items off · 1 added/.test(toast)
    && JSON.stringify(changed) === JSON.stringify([['Air permit issued', false], ['Insurance is in place', false], ['LNG supply agreement executed', true], ['Marine terminal permits in place', true]]), JSON.stringify({ toast, changed }));
  await page.click('#toast .tundo'); await page.waitForFunction(() => Object.values(store.get().deals).find((d) => d.name.includes('Coho')).technology === 'LNG');
  const undone = await itemsOf(page, id);
  say('Undo puts LNG back with its items on and turns CCGT’s new item off', JSON.stringify(undone) === JSON.stringify([['Air permit issued', true], ['Insurance is in place', false], ['LNG supply agreement executed', false], ['Marine terminal permits in place', false]]), JSON.stringify(undone));
  await page.click('#pick-technology > button'); await page.keyboard.type('ccgt'); await page.keyboard.press('Enter'); await page.waitForSelector('#ask-go'); await page.click('#ask-go');
  for (let i = 0; i < 50 && (await coho()) !== 'CCGT'; i++) await page.waitForTimeout(50);
  const again = await itemsOf(page, id);
  say('picked again, CCGT’s turned-off item comes back on and LNG’s go off', JSON.stringify(again) === JSON.stringify(changed), JSON.stringify(again));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // The Checklist is grouped by list, then section, then subsection, read from the file's Section and Subsection columns
  const { ctx, page, id } = await start();
  const f = path.join(dir, 'Sections.csv');
  fs.writeFileSync(f, ['Section,Sub-section,Item', 'Finance,Model,The model is audited', ',,Reserves are funded', ',Funding,Equity is committed', 'Legal,,Approvals are in place'].join('\n'));
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  await page.setInputFiles('#cl-file', f); await page.waitForSelector('#cl-next'); await read(page);
  const head = await page.$$eval('.imprev th', (t) => t.map((x) => x.textContent));
  const rows = await page.$$eval('.imprev tbody tr', (t) => t.map((r) => [...r.cells].map((c) => c.textContent).join('/')));
  say('the import reads a Sub-section column, carries a section filled in once down to the rows under it, and previews it', JSON.stringify(head) === '["Section","Subsection","Item"]' && JSON.stringify(rows) === JSON.stringify(['Finance/Model/The model is audited', 'Finance/Model/Reserves are funded', 'Finance/Funding/Equity is committed', 'Legal//Approvals are in place']), JSON.stringify({ head, rows }));
  await page.click('#cl-next'); await page.waitForSelector('#cl-go'); await page.click('#cl-go'); await page.waitForSelector('#fl-count'); await page.keyboard.press('Escape');
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('#ck-rows .ckrow');
  const seen = await page.$$eval('#ck-rows > *', (els) => els.map((e) => e.classList.contains('ckrow') ? e.querySelector('.it').textContent : `${e.className}:${e.firstChild.textContent}`));
  say('the Checklist shows each list, section and subsection above its items, in the file’s order', JSON.stringify(seen) === JSON.stringify(['ckgroup:General', 'cksec:Finance', 'cksub:Model', 'The model is audited', 'Reserves are funded', 'cksub:Funding', 'Equity is committed', 'cksec:Legal', 'Approvals are in place']), JSON.stringify(seen));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // A pasted list: read by the model, every line tied out, lines left out listed to bring in where they sit; a reading that fails says so, with Retry
  const { ctx, page, id } = await start();
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  const paste = ['Proseware Solar checklist', '', '1. Site', '   1.1  Title report for the whole site', '   1.2  Leases cover the array and the', '        gen-tie route', 'Page 2 of 6', '2. Permits', '   2.1  Conditional use permit issued', '   2.2  Wetlands delineation complete; any Section 404 permit in hand'].join('\n');
  await page.fill('#cl-paste', paste); await page.click('#cl-paste-next'); await page.waitForSelector('#cl-line'); await read(page);
  const first = await page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, source: document.querySelector('.imfile').textContent, left: [...document.querySelectorAll('#cl-leftout .rv-new')].map((x) => x.textContent), tip: document.querySelector('#cl-line').closest('[title]')?.title ?? '', rows: [...document.querySelectorAll('.imprev tbody tr')].map((r) => [...r.cells].map((c) => c.textContent).join('/')) }));
  say('a paste is read into items under their headings, a wrapped item joined, and the lines left out listed', first.line === '4 items · 2 lines left out' && /^Pasted · 10 lines/.test(first.source) && JSON.stringify(first.left) === '["Proseware Solar checklist","Page 2 of 6"]' && first.rows[1] === 'Site/Leases cover the array and the gen-tie route', JSON.stringify(first));
  say('the count’s tooltip ties out every line', /^10 lines: 4 items \(1 more line of wrapped items\), 2 headings, 1 blank line, 2 lines left out$/.test(first.tip), first.tip);
  await page.click('[data-bringin="7"]');
  const checked = await page.evaluate(() => document.querySelector('#cl-line').textContent);
  say('checking a line left out brings it in as an item', checked === '5 items · 1 line left out', checked);
  await page.click('[data-layer=broad]'); await page.click('#cl-next'); await page.waitForSelector('#cl-go');
  const review = await page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, rows: [...document.querySelectorAll('.rv-new')].map((x) => x.textContent) }));
  say('an item joining two conditions is offered as two items in the review', review.rows.some((r) => r.endsWith('Wetlands delineation complete.')) && review.rows.some((r) => r.endsWith('Section 404 permit in hand (if applicable).')), JSON.stringify(review));
  await page.click('#cl-go'); await page.waitForSelector('#fl-count');
  const saved = await page.evaluate((d) => Object.values(store.get().items).filter((i) => i.dealId === d).map((i) => i.text), id);
  say('the items brought in include the checked line, where it sits', saved.includes('Page 2 of 6') && saved.includes('Leases cover the array and the gen-tie route'), JSON.stringify(saved));
  await page.keyboard.press('Escape');
  // the model cannot be reached: the preview says Not read, with Retry, and Retry reads it once it can
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  await page.evaluate(() => { window.__fail = { readList: true }; });
  await page.fill('#cl-paste', 'Insurance is in place\nSurvey delivered'); await page.click('#cl-paste-next'); await page.waitForSelector('#cl-notread');
  const notread = await page.evaluate(() => ({ text: document.querySelector('#cl-notread').textContent, columns: !!document.querySelector('#cl-bycolumns'), next: document.querySelector('#cl-next').disabled }));
  await page.evaluate(() => { window.__fail = {}; }); await page.click('#cl-read-retry'); await page.waitForSelector('.imprev'); await read(page);
  const retried = await page.evaluate(() => document.querySelector('#cl-line').textContent);
  // change goes back to the paste, kept; Back from there leaves for the lists at once, and the import opens again as it was left
  await page.click('#cl-back'); await page.waitForSelector('#cl-paste'); const kept = await page.inputValue('#cl-paste');
  await page.click('.imdlg .xfoot .btn:not(.pri)'); await page.waitForSelector('#fl-import'); await page.click('#fl-import'); await page.waitForSelector('#cl-next'); await read(page);
  const reopened = await page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, source: document.querySelector('.imfile').textContent }));
  say('Back leaves for the lists at once, and the import opens again as it was left', kept === 'Insurance is in place\nSurvey delivered' && reopened.line === '2 items' && reopened.source.startsWith('Pasted · 2 lines'), JSON.stringify({ kept, reopened }));
  say('a reading that fails says Not read, with Retry and no column picks for a paste, and Retry reads it', /^Not read/.test(notread.text) && /Retry$/.test(notread.text) && !notread.columns && notread.next && retried === '2 items', JSON.stringify({ notread, retried }));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // Items the duplicate check missed (a part the service did not answer) are counted, and Retry, or Back then Next, asks about them alone, keeping the check marks
  const { ctx, page } = await start();
  const w = (i) => String.fromCharCode(97 + Math.floor(i / 26) % 26, 97 + (i % 26), 97 + Math.floor(i / 676));
  const item = (i) => `Deliver the ${w(i)}xa ${w(i)}yb ${w(i)}zc report`; const again = (i) => `The ${w(i)}zc ${w(i)}xa ${w(i)}yb report, deliver it`;
  // 300 rows: 270 items, repeats of the first 10 at 270 to 279, and 10 items at 280 to 289 repeated at 290 to 299
  const rows = [...Array.from({ length: 270 }, (_, i) => item(i)), ...Array.from({ length: 10 }, (_, i) => again(i)), ...Array.from({ length: 10 }, (_, i) => item(400 + i)), ...Array.from({ length: 10 }, (_, i) => again(400 + i))];
  const f = path.join(dir, 'Missed.csv'); fs.writeFileSync(f, ['Item', ...rows].join('\n'));
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  await page.setInputFiles('#cl-file', f); await page.waitForSelector('#cl-next'); await page.click('[data-layer=broad]');
  await page.evaluate(() => { window.__sameMissed = 20; }); await page.click('#cl-next'); await page.waitForSelector('#cl-go');
  const first = await page.evaluate(() => ({ pairs: document.querySelectorAll('#cl-pairs .rv-pair').length, missed: document.querySelector('#cl-missed')?.textContent ?? '', retry: document.querySelector('#cl-retry')?.textContent ?? '', tip: document.querySelector('#cl-retry')?.title ?? '' }));
  say('the items not compared are counted beside the duplicates found, with Retry beside them', first.pairs === 10 && /could not be reached for 20 items$/.test(first.missed) && first.retry === 'Retry' && first.tip === 'Ask about them again', JSON.stringify(first));
  await page.click('#cl-pairs [data-remove="270"]');
  // Retry while the service is still down: the review stays as it was, check mark and all, and its line says so
  await page.evaluate(() => { window.__down = true; });
  await page.click('#cl-retry'); await page.waitForFunction(() => /again$/.test(document.querySelector('#cl-line').textContent));
  const down = await page.evaluate(() => ({ pairs: document.querySelectorAll('#cl-pairs .rv-pair').length, checked: document.querySelector('#cl-pairs [data-remove="270"]')?.checked, missed: !!document.querySelector('#cl-missed'), line: document.querySelector('#cl-line').textContent }));
  say('Retry while the service is down leaves the review unchanged, check mark kept, and the line says so', down.pairs === 10 && down.checked === true && down.missed && /could not be reached again$/.test(down.line), JSON.stringify(down));
  // Back while Retry waits drops its answer, so the setup page does not report a request the person no longer sees
  await page.evaluate(() => { document.querySelector('#cl-retry').click(); document.querySelector('#cl-line ~ .btn:not(.pri)').click(); });
  await page.waitForSelector('#cl-next'); await page.waitForTimeout(600);
  const backed = await page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, next: !document.querySelector('#cl-next').disabled }));
  say('Back while Retry waits leaves no "again" line on the setup page, and Next can be pressed', !/again/.test(backed.line) && backed.next, JSON.stringify(backed));
  await page.evaluate(() => { window.__down = false; });
  await page.click('#cl-next'); await page.waitForSelector('#cl-go'); await page.waitForFunction(() => !document.querySelector('#cl-missed'));
  const second = await page.evaluate(() => ({ pairs: document.querySelectorAll('#cl-pairs .rv-pair').length, checked: document.querySelector('#cl-pairs [data-remove="270"]')?.checked, retry: !!document.querySelector('#cl-retry'), line: document.querySelector('#cl-line').textContent }));
  say('Back then Next asks about the missed items again, adds their pairs, keeps the check mark and takes Retry away',
    second.pairs === 20 && second.checked === true && !second.retry && second.line === 'Import 299 items · 1 removed',
    JSON.stringify(second));
  // a check that failed outright is asked again by Retry, the list brought in afresh in a new window
  const fresh = await start(); const p2 = fresh.page;
  await p2.click('#u-menu'); await p2.waitForSelector('#s-checklist-open'); await p2.click('#s-checklist-open'); await p2.waitForSelector('#fl-import'); await p2.click('#fl-import');
  // the list is read before the service goes down: only the duplicate check is to fail
  await p2.setInputFiles('#cl-file', f); await p2.waitForSelector('#cl-next'); await read(p2); await p2.click('[data-layer=broad]');
  await p2.evaluate(() => { window.__down = true; }); await p2.click('#cl-next'); await p2.waitForSelector('#cl-go');
  const failed = await p2.evaluate(() => ({ pairs: document.querySelectorAll('#cl-pairs .rv-pair').length, head: [...document.querySelectorAll('.rv-h')].map((h) => h.textContent).join(' | ') }));
  await p2.evaluate(() => { window.__down = false; }); await p2.click('#cl-retry'); await p2.waitForFunction(() => document.querySelectorAll('#cl-pairs .rv-pair').length > 0);
  const after = await p2.evaluate(() => ({ pairs: document.querySelectorAll('#cl-pairs .rv-pair').length, head: [...document.querySelectorAll('.rv-h')].map((h) => h.textContent).join(' | ') }));
  say('a duplicate check that failed outright is asked again by Retry', failed.pairs === 0 && /only same wording was checked/.test(failed.head) && after.pairs === 20 && !/only same wording/.test(after.head), JSON.stringify({ failed, after }));
  say('no errors on the second page', p2.errors.length === 0, JSON.stringify(p2.errors));
  await fresh.ctx.close();
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

await checkDuplicateRetries(start, say);

{ // A list of deal size (2,400 rows, alike in wording, 200 of them repeated) is reviewed and brought in within seconds, counted in en-US
  const { ctx, page, id } = await start();
  const W = ['lender', 'insurance', 'interconnection', 'permit', 'easement', 'offtake', 'warranty', 'reserve', 'survey', 'turbine', 'inverter', 'substation', 'hedge', 'audit', 'zoning', 'transmission'];
  const unique = Array.from({ length: 2200 }, (_, i) => `${W[i % 16]} ${W[(i * 7 + 3) % 16]} schedule ${i + 1} delivered${i % 9 === 0 ? ' / LTSA reviewed' : ''}`);
  const big = path.join(dir, 'Big.csv'); fs.writeFileSync(big, ['Section,Item', ...[...unique, ...unique.slice(0, 200)].map((t, i) => `Part ${Math.floor(i / 100) + 1},${t}`)].join('\n'));
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  await page.setInputFiles('#cl-file', big); await page.waitForSelector('#cl-next'); await read(page);
  const mapStep = await page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, buttons: [...document.querySelectorAll('.imdlg .xfoot .btn')].map((b) => b.textContent), file: document.querySelector('.imfile').textContent, note: !!document.querySelector('#cl-namenote') }));
  // why Next is off shows on hover, not only in its title
  await page.click('[data-layer=technology]'); const unnamed = await page.evaluate(() => { const b = document.querySelector('#cl-next'); const r = b.getBoundingClientRect(); const hover = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[title]')?.getAttribute('title'); return hover === b.title ? b.title : `hover: ${hover}`; }); await page.fill('#cl-name', 'Solar');
  const named = await page.evaluate((unnamed) => ({ note: !!document.querySelector('#cl-namenote'), tip: document.querySelector('#cl-name').title, unnamed, next: document.querySelector('#cl-next').title }), unnamed);
  await page.click('[data-layer=broad]');
  say('what a list name does is the name field’s tooltip, and why Next waits for one is Next’s, not lines beside them', !named.note && named.tip === 'A new technology list' && named.unnamed === 'Name the technology, as deals will pick it' && !named.next, JSON.stringify(named));
  say('the import counts in en-US, has no Cancel button (the × closes it) and no line under the general list', mapStep.line === '2,400 items' && /2,400 rows/.test(mapStep.file) && JSON.stringify(mapStep.buttons) === '["Next"]' && !mapStep.note, JSON.stringify(mapStep));
  let t = Date.now(); await page.click('#cl-next'); await page.waitForSelector('#cl-go', { timeout: 60000 }); const reviewed = Date.now() - t;
  const review = await page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, pairs: document.querySelectorAll('#cl-pairs .rv-pair').length, rewords: document.querySelectorAll('#cl-rewords [data-reword]').length, head: [...document.querySelectorAll('.rv-h b')].map((b) => b.textContent) }));
  say(`2,400 rows are reviewed within 10 seconds, every repeat listed (${reviewed} ms)`,
    reviewed < 10000 && review.line === 'Import 2,400 items' && review.pairs === 200
      && review.head.includes('200 found') && review.rewords === 245,
    JSON.stringify({ reviewed, ...review }));
  const close = await page.evaluate(() => { document.querySelector('#cl-pairs .rv-pair:last-child').scrollIntoView(); const d = document.querySelector('.imdlg').getBoundingClientRect(); const x = document.querySelector('.imdlg .shead .x').getBoundingClientRect(); return x.top >= d.top && x.bottom <= d.bottom && document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2)?.closest('.x') !== null; });
  say('scrolled to the end of the review, the title and × stay in view', close);
  await page.click('#cl-pairs [data-remove="2200"]'); const checked = await page.textContent('#cl-line');
  t = Date.now(); await page.click('#cl-go'); await page.waitForSelector('#fl-count', { timeout: 60000 }); const brought = Date.now() - t;
  const held = (await itemsOf(page, id)).length; const count = await page.textContent('#fl-count');
  say(`and imported within 10 seconds, onto the deal at once (${brought} ms)`,
    brought < 10000 && checked === 'Import 2,399 items · 1 removed' && held === 2200
      && count === '1 list · 2,399 items',
    JSON.stringify({ brought, checked, held, count }));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // One list changed on two PCs at once: only its row asks for a choice, the others stay as they are, and keeping a version ends it
  const { ctx, page } = await start();
  await bring(page, general, 'broad'); await page.keyboard.press('Escape'); await bring(page, csv, 'sector', 'Solar');
  const sid = await page.evaluate(async () => { const l = Object.values(store.get().firmList).find((x) => x.name === 'Solar');
    await __peer.edit(l.id, { items: [...l.items.slice(1), ...l.items.slice(0, 1), { text: 'Spare inverters held on site' }] }); return l.id; });
  await page.waitForSelector('[data-choose]');
  const row = await page.evaluate(() => [...document.querySelectorAll('.fl-row')].map((r) => [r.dataset.list, r.querySelector('.cf')?.textContent ?? '', r.querySelector('.linkb').textContent]));
  say('only the list changed on two PCs shows Two versions and Choose…; the general list keeps Replace…', JSON.stringify(row) === JSON.stringify([['', '', 'Replace…'], ['Solar', 'Two versions', 'Choose…']]), JSON.stringify(row));
  // importing that list again says so at Next, before any review is made
  await page.click('#fl-import'); await page.setInputFiles('#cl-file', csv); await page.waitForSelector('#cl-next'); await read(page);
  await page.click('[data-layer=sector]'); await page.fill('#cl-name', 'solar');
  const next = await page.$eval('#cl-next', (b) => ({ disabled: b.disabled, why: b.title }));
  say('Next waits, saying why, when the list picked is in two versions', next.disabled && next.why === 'The Solar list has two versions. Choose one first', JSON.stringify(next));
  await page.fill('#cl-name', 'Wind'); const other = await page.$eval('#cl-next', (b) => b.disabled);
  say('another list can still be imported meanwhile', !other);
  // started over, so the import after this starts from a file
  await page.click('#cl-restart'); await page.click('#cl-restart-ask-go'); await page.waitForSelector('#cl-file', { state: 'attached' }); await page.keyboard.press('Escape'); await page.waitForSelector('#cl-file', { state: 'detached' });
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('[data-choose]');
  await page.click('[data-choose]'); await page.waitForSelector('#fl-back');
  const view = await page.evaluate(() => [...document.querySelectorAll('.cfl-f[data-field=items] .cfl-val')].map((v) => v.innerText));
  say('the choice names the item only the other PC’s version holds', view.length === 2 && view.some((t) => t.includes('· Spare inverters held on site')), JSON.stringify(view));
  await page.click('#fl-back'); await page.waitForSelector('[data-choose]');
  await page.click('[data-choose]'); await page.waitForSelector('#fl-back');
  await page.click('.cfl-v[role="radio"] >> nth=0'); await page.click('.cfl-keep'); await page.waitForFunction((id) => !store.get().conflicts[id], sid, { timeout: 10000 });
  const after = await page.waitForSelector('.fl-row[data-list=Solar] .linkb').then((b) => b.textContent());
  say('Back returns to the lists, and keeping a version ends the choice and returns there too', after === 'Replace…' && !(await page.$('[data-choose]')), after);
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // The list splits while its review is open: Choose… is offered there, and Back returns to the review with its check marks
  const { ctx, page } = await start();
  await bring(page, csv, 'sector', 'Solar');
  await page.click('#fl-import'); await page.setInputFiles('#cl-file', csv); await page.waitForSelector('#cl-next');
  await page.click('[data-layer=sector]'); await page.fill('#cl-name', 'Solar'); await page.click('#cl-next'); await page.waitForSelector('#cl-go');
  await page.click('[data-remove]'); const checked = await page.$$eval('[data-remove]:checked', (b) => b.length); await page.focus('#cl-go');
  await page.evaluate(async () => { const l = Object.values(store.get().firmList).find((x) => x.name === 'Solar'); await __peer.edit(l.id, { items: [...l.items, { text: 'Spare inverters held on site' }] }); });
  await page.waitForSelector('#cl-choose');
  const focus = await page.evaluate(() => document.activeElement?.id);
  say('the focus goes to Choose…, not the page, when the list splits', focus === 'cl-choose', String(focus));
  const waits = await page.$eval('#cl-go', (b) => ({ disabled: b.disabled, why: b.parentElement.title }));
  say('a list split during its review waits at Import, with Choose… beside it',
    waits.disabled && waits.why === 'The Solar list has two versions. Choose one first', JSON.stringify(waits));
  await page.click('#cl-choose'); await page.waitForSelector('#cl-choose-back');
  const cards = await page.$$eval('.cfl-f[data-field=items] .cfl-val', (v) => v.map((x) => x.innerText));
  say('a version missing the other’s item never reads as the same items', cards.length === 2 && !cards.some((t) => t.includes('The same items')) && cards.some((t) => t.includes('1 not in this version:\n· Spare inverters held on site')) && cards.some((t) => t.includes('1 only in this version:\n· Spare inverters held on site')), JSON.stringify(cards));
  await page.click('#cl-choose-back'); await page.waitForSelector('#cl-go');
  const kept = await page.$$eval('[data-remove]:checked', (b) => b.length);
  say('Back from the choice returns to the review, check marks kept', checked === 1 && kept === 1, JSON.stringify({ checked, kept }));
  await page.click('#cl-choose'); await page.waitForSelector('.cfl-v[role="radio"]'); await page.click('.cfl-v[role="radio"] >> nth=0'); await page.click('.cfl-keep');
  await page.waitForSelector('#cl-go:not([disabled])', { timeout: 10000 });
  const after = { checkMarks: await page.$$eval('[data-remove]:checked', (b) => b.length), choose: !!(await page.$('#cl-choose')) };
  say('once a version is kept, the review is back, check marks kept, and it can be brought in', after.checkMarks === 1 && !after.choose, JSON.stringify(after));
  // split again, then Back to the mapping: Choose… is there too, and Next brings back the same review with its check marks
  await page.evaluate(async () => { const l = Object.values(store.get().firmList).find((x) => x.name === 'Solar'); await __peer.edit(l.id, { items: [...l.items, { text: 'Tracker stow strategy' }] }); });
  await page.waitForSelector('#cl-choose');
  await page.click('#cl-line ~ button.btn:not(.pri):not(#cl-go)'); await page.waitForSelector('#cl-next');
  const mapStep = await page.$eval('#cl-next', (b) => ({ disabled: b.disabled, choose: !!document.querySelector('#cl-choose'), line: document.querySelector('#cl-line').textContent }));
  say('Back to the mapping while split still offers Choose…, and says why', mapStep.disabled && mapStep.choose && mapStep.line === 'The Solar list has two versions', JSON.stringify(mapStep));
  await page.click('#cl-choose'); await page.waitForSelector('.cfl-v[role="radio"]'); await page.click('.cfl-v[role="radio"] >> nth=0'); await page.click('.cfl-keep');
  await page.waitForSelector('#cl-next:not([disabled])', { timeout: 10000 }); await page.click('#cl-next'); await page.waitForSelector('#cl-go:not([disabled])');
  const back = await page.$$eval('[data-remove]:checked', (b) => b.length);
  say('then Next shows the same review, check marks kept', back === 1, String(back));
  await page.click('#cl-go'); await page.waitForSelector('#fl-count');
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // Each dialog fits the window without sideways scrolling, in dark and light, at the two sizes screens are checked at
  for (const size of [[1280, 736], [1024, 640]]) for (const scheme of ['dark', 'light']) {
    const { ctx, page } = await start(size, scheme);
    // measured with no notice showing: while one shows, a dialog sits below it and may scroll (polish.spec checks that case)
    await page.waitForFunction(() => !document.querySelector('.toasts .toast'), null, { timeout: 15000 });
    await page.click('#u-menu'); await page.waitForSelector('#s-checklist');
    // the desktop app adds a Punchlist folder row (connect.tsx) and a sign-in row (signin.tsx); they are put in as rendered there, so Settings is checked with them too
    const settings = await page.evaluate(() => { const fits = () => { const d = document.querySelector('.setdlg'); return d.scrollHeight <= d.clientHeight + 1; }; const browser = fits();
      document.querySelector('#s-theme').closest('.srow').insertAdjacentHTML('beforebegin',
        '<div class="srow top" id="s-shared"><div class="k">Punchlist Folder</div>'
        + '<div class="cf-set"><div class="cf-line"><span class="cf-now">C:\\Deals\\Shared</span>'
        + '<button type="button" class="btn sm">Change…</button></div></div></div>');
      document.querySelector('.setdlg .srow').insertAdjacentHTML('afterend',
        '<div class="srow top" id="s-signin"><div class="k">Intelligence Sign-In</div>'
        + '<div class="cf-set"><div class="cf-line"><span class="cf-now">Signed in</span>'
        + '<button type="button" class="btn sm">Sign Out</button></div></div></div>');
      const desktop = fits(); document.querySelector('#s-shared').remove(); document.querySelector('#s-signin').remove(); return browser && desktop; });
    await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import'); await page.setInputFiles('#cl-file', csv); await page.waitForSelector('#cl-next');
    const fits = await page.evaluate(() => { const d = document.querySelector('.imdlg'); const r = d.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && d.scrollWidth <= d.clientWidth + 1; });
    say(`Settings fits without scrolling, and the import dialog fits across · ${size.join('x')} ${scheme}`, settings && fits, JSON.stringify({ settings, fits }));
    await ctx.close();
  }
}

{ // Wording suggestions that failed after the quiet retries (decisions: Retries) say so with Retry, which asks again and keeps the check marks; at deal size
  const { ctx, page } = await start();
  const rows = [...Array.from({ length: 2100 }, (_, i) => (i % 7 ? `Item ${i + 1}: the report on part ${i + 1} is delivered` : `Item ${i + 1}: the LTSA on part ${i + 1} runs 5 yrs`)), 'Item 1: the LTSA on part 1 runs 5 yrs'];   // the last row repeats the first: offered for removal, never a rewording
  const f = path.join(dir, 'Wording.csv'); fs.writeFileSync(f, ['Item', ...rows].join('\n'));
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  await page.setInputFiles('#cl-file', f); await page.waitForSelector('#cl-next'); await page.click('[data-layer=broad]');
  await page.evaluate(() => { window.__fail = { reword: true }; }); await page.click('#cl-next'); await page.waitForSelector('#cl-go');
  const failed = await page.evaluate(() => ({ head: document.querySelector('.rv-h').textContent, retry: document.querySelector('#cl-reword-retry')?.textContent ?? '', tip: document.querySelector('#cl-reword-retry')?.title ?? '', rows: document.querySelectorAll('#cl-rewords .rv-row').length }));
  say('wording that failed says Not asked, with Retry beside it', /^Not asked/.test(failed.head) && failed.retry === 'Retry' && failed.tip === 'Ask for them again' && failed.rows === 0, JSON.stringify(failed));
  const pairsBefore = await page.evaluate(() => document.querySelectorAll('#cl-pairs .rv-pair').length);
  await page.click('#cl-reword-retry'); await page.waitForFunction(() => /again$/.test(document.querySelector('#cl-line').textContent));
  const still = await page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, retry: !!document.querySelector('#cl-reword-retry') }));
  say('Retry while it still fails keeps the review and says so', /again$/.test(still.line) && still.retry, JSON.stringify(still));
  await page.evaluate(() => { window.__fail = {}; }); await page.click('#cl-reword-retry'); await page.waitForSelector('#cl-rewords .rv-row');
  const after = await page.evaluate(() => ({ head: document.querySelector('.rv-h').textContent, rows: document.querySelectorAll('#cl-rewords .rv-row').length, checked: document.querySelectorAll('#cl-rewords input:checked').length, retry: !!document.querySelector('#cl-reword-retry'), pairs: document.querySelectorAll('#cl-pairs .rv-pair').length }));
  const twice = await page.evaluate(() => ({ reworded: [...document.querySelectorAll('#cl-rewords [data-reword]')].map((x) => +x.dataset.reword).filter((at) => at === 0 || at === 2100), removable: !!document.querySelector('#cl-pairs [data-remove="2100"]') }));
  say('Retry that works shows the suggestions unchecked, takes Retry away and leaves the duplicates as they were', after.rows === 300 && after.checked === 0 && !after.retry && /^300 suggestions/.test(after.head) && after.pairs === pairsBefore && pairsBefore === 1, JSON.stringify(after));
  say('a repeated row is offered for removal, and only its first copy a rewording', JSON.stringify(twice.reworded) === '[0]' && twice.removable, JSON.stringify(twice));
  // a reload keeps the review of 2,101 items and its check marks, with nothing asked again
  for (const at of [7, 14, 700]) await page.click(`#cl-rewords [data-reword="${at}"]`); await page.click('#cl-pairs [data-remove="2100"]');
  const checkMarks = () => page.evaluate(() => ({ line: document.querySelector('#cl-line').textContent, reword: [...document.querySelectorAll('#cl-rewords input:checked')].map((x) => x.dataset.reword), remove: [...document.querySelectorAll('#cl-pairs input:checked')].map((x) => x.dataset.remove), rows: document.querySelectorAll('#cl-rewords .rv-row').length }));
  const before = await checkMarks();
  await page.reload(); await page.waitForSelector('#ov-details');
  await page.evaluate(() => { window.__fail = { reword: true, sameMeaning: true, readList: true }; });   // nothing may be asked again: a call would fail and show
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  const reviewBack = await page.waitForSelector('#cl-go', { timeout: 5000 }).then(() => true, () => false); const afterReload = reviewBack ? await checkMarks() : null;
  say('a reload keeps the review and its check marks, asking nothing again',
    reviewBack && JSON.stringify(afterReload) === JSON.stringify(before)
      && before.line === 'Import 2,100 items · 3 reworded · 1 removed',
    JSON.stringify({ before, afterReload }));
  // Back, then start over: asks first, then clears the import, after a reload too
  await page.evaluate(() => { window.__fail = {}; });
  await page.click('#cl-line ~ .btn:not(.pri)'); await page.waitForSelector('#cl-restart'); await page.click('#cl-restart'); await page.waitForSelector('#cl-restart-ask');
  const ask = await page.textContent('#cl-restart-ask [role="alert"]'); await page.click('#cl-restart-ask-go'); await page.waitForSelector('#cl-paste');
  await page.reload(); await page.waitForSelector('#ov-details'); await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); await page.click('#fl-import');
  await page.waitForSelector('#cl-paste'); const fresh = { paste: await page.inputValue('#cl-paste'), next: !!(await page.$('#cl-next')) };
  say('start over asks first and clears the import for good', ask === 'Clear this import and start over?' && fresh.paste === '' && !fresh.next, JSON.stringify({ ask, fresh }));
  say('no errors on the wording page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // A kept "Import a list…" never opens in place of the list "Replace…" names, and each comes back on its own way in
  const { ctx, page } = await start();
  await bring(page, general, 'broad', ''); await page.keyboard.press('Escape');
  const lists = async () => { await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import'); };
  await lists(); await page.click('#fl-import'); await page.setInputFiles('#cl-file', csv); await page.waitForSelector('#cl-next'); await read(page);
  await page.click('[data-layer=technology]'); await page.fill('#cl-name', 'Solar'); await page.keyboard.press('Escape'); await page.waitForSelector('.imdlg', { state: 'detached' });
  await lists(); await page.click('.fl-row[data-list=""] .linkb'); await page.waitForSelector('#cl-paste');
  const replace = { file: !!(await page.$('#cl-next')), title: await page.textContent('.imdlg h2') };
  await page.keyboard.press('Escape'); await lists(); await page.click('#fl-import'); await page.waitForSelector('#cl-next');
  const kept = { name: await page.inputValue('#cl-name'), source: await page.textContent('.imfile') };
  say('Replace… opens on its own list, and Import a List… comes back as it was left', !replace.file
    && kept.name === 'Solar' && kept.source.startsWith('Solar checklist.csv'), JSON.stringify({ replace, kept }));
  say('no errors on the page', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // No lists yet: one drop area with the import icon stands in for the empty sections
  for (const [size, scheme] of [[[1280, 736], 'dark'], [[1024, 640], 'light']]) {
    const { ctx, page } = await start(size, scheme);
    const open = async () => {
      await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open');
      await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import');
    };
    await open();
    const empty = await page.evaluate(() => {
      const zone = document.querySelector('#fl-drop'); const dialog = zone?.closest('.dlg');
      return {
        zone: zone?.offsetHeight, dialog: dialog?.offsetHeight,   // as laid out, not mid-way through the opening scale
        icon: !!zone?.querySelector('svg'), words: zone?.textContent.trim(),
        sections: document.querySelectorAll('.fl-sec').length, count: !!document.querySelector('#fl-count'),
      };
    });
    say(`no lists: one 160px drop area with the icon, in a dialog at least 360px tall (${size[0]})`,
      empty.zone === 160 && empty.dialog >= 360 && empty.icon
        && empty.words === 'Drop a checklist here, or choose a file…' && empty.sections === 0 && !empty.count,
      JSON.stringify(empty));
    await page.setInputFiles('#fl-file', csv); await page.waitForSelector('#cl-next'); await read(page);
    const opened = { title: await page.textContent('.imdlg h2'), source: await page.textContent('.imfile') };
    say(`a file chosen there opens Import a checklist with it read (${size[0]})`,
      opened.title === 'Import a Checklist' && opened.source.startsWith('Solar checklist.csv'), JSON.stringify(opened));
    // the import under way is kept: a second file on the empty dialog opens it as it was left, the choices in it kept
    await page.click('[data-layer=technology]'); await page.fill('#cl-name', 'Solar');
    await page.keyboard.press('Escape'); await page.waitForSelector('.imdlg', { state: 'detached' });
    await open(); await page.setInputFiles('#fl-file', general); await page.waitForSelector('#cl-next');
    const kept = { name: await page.inputValue('#cl-name'), source: await page.textContent('.imfile') };
    say(`an import under way is never replaced by a file dropped on the empty dialog (${size[0]})`,
      kept.name === 'Solar' && kept.source.startsWith('Solar checklist.csv'), JSON.stringify(kept));
    await page.click('#cl-next'); await page.waitForSelector('#cl-go'); await page.click('#cl-go');
    await page.waitForSelector('#fl-count');
    say(`with a list, the layers and the count come back (${size[0]})`,
      !(await page.$('#fl-drop')) && (await page.$$('.fl-sec')).length === 4, await page.textContent('#fl-count'));
    await page.click('#fl-import'); await page.waitForSelector('#cl-drop');
    const iconFirst = !!(await page.$('#cl-drop > svg + div'));
    say(`the import's own drop area has the icon above its words (${size[0]})`, iconFirst);
    say(`no errors on the page (${size[0]})`, page.errors.length === 0, JSON.stringify(page.errors));
    await ctx.close();
  }
}

await browser.close(); fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
