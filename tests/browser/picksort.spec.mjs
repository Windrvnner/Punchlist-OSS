// Every list a person picks from is A to Z, with a "No …", "None" or "Not recorded" option last. Names
// the app, the firm or an import brought sit together in one order: lower case, accents and numbers ("Phase 2" before
// "Phase 10") as a person reads them. At deal scale: 2,000 questions from 30 parties, 40 technology lists.
// SHOTS=dir also saves screenshots of the lists, dark and light, at 1280x736 and 1024x640.
import { launchChrome } from './chrome.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const SHOTS = process.env.SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();

// the order a person reads: case and accents aside, numbers by value
const az = (xs) => [...xs].sort(new Intl.Collator('en-US', { sensitivity: 'base', numeric: true }).compare);
const TECH = ['Solar', 'battery storage', 'Wind', 'Éolien offshore', 'Phase 10 gas', 'Phase 2 gas', 'LNG', 'Data centers', 'Behind-the-meter power', 'Midstream',
  ...Array.from({ length: 30 }, (_, i) => `Tech ${String.fromCharCode(90 - (i % 26))}${i}`)];
const PARTIES = [...Array.from({ length: 29 }, (_, i) => `Lender ${String.fromCharCode(90 - i % 26)}${i >= 26 ? i : ''}`), 'agent bank'];
const OWN_WS = ['Permitting', 'accounting', 'Água e meio'];   // workstreams an imported log brought

async function start(size, scheme, room) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware');
  // a data room (the stand-in's "reports") gives the Findings page, where a finding is added and edited
  if (room) { await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); }
  await page.click('#nd-create'); await page.waitForSelector('#ov-details');
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.evaluate(async ([tech]) => {
    for (const name of tech) await store.dispatch(store.commandNamed('BringInList'), { list: { layer: 'technology', name, items: [{ id: `i_${name}`, text: `Item for ${name}` }] } }, { quiet: true });
  }, [TECH]);
  // 2,000 questions: every party, and the app's workstreams with the log's own; one in fifty names no party, one in forty no workstream
  const ws = ['Technical', 'Legal', 'Commercial', 'Financial', 'Structure', 'Insurance', 'Tax', 'Regulatory & permits', 'Real estate', 'HR & benefits', 'IT & cyber', 'Antitrust & FDI', 'Compliance', 'Environmental & social', ...OWN_WS];
  await page.evaluate(([d, parties, ws]) => store.dispatch(store.commandNamed('ImportQuestions'), { dealId: d, mode: 'append', rows: Array.from({ length: 2000 }, (_, i) => ({
    n: null, text: `Question ${i + 1} on the project's ${['permits', 'offtake', 'grid', 'insurance'][i % 4]}`, askedBy: i % 50 === 7 ? '' : parties[i % parties.length], received: '2026-10-28',
    workstream: i % 40 === 3 ? '' : ws[i % ws.length], priority: '', response: '', respondedBy: '', responded: '', status: '' })) }, { quiet: true }), [id, PARTIES, ws]);
  return { ctx, page, id };
}
const shot = async (page, name, scheme, size) => { if (SHOTS) await page.waitForTimeout(600); if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}-${size[0]}x${size[1]}.png`) }); };
// the menu ends inside the window, and the row is whole and on top where it is drawn
const inView = (page, menu, row) => page.evaluate(([m, r]) => { const a = document.querySelector(m)?.getBoundingClientRect(); const b = document.querySelector(r)?.getBoundingClientRect(); if (!a || !b) return false;
  const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return a.bottom <= innerHeight && b.top >= a.top && b.bottom <= a.bottom && !!top && document.querySelector(r).contains(top); }, [menu, row]);
// a scrolling list ends at the foot of a row: no part of the next row shows above the rule under it
const whole = (page, sel) => page.evaluate((s) => { const sc = document.querySelector(s); if (!sc || sc.scrollHeight <= sc.clientHeight) return false; const b = sc.getBoundingClientRect().bottom;
  return [...sc.children].some((r) => Math.abs(r.getBoundingClientRect().bottom - b) < 0.75); }, sel);
const texts = (page, sel) => page.$$eval(sel, (os) => os.map((o) => o.textContent.trim()));

for (const [size, scheme] of [[[1280, 736], 'dark'], [[1280, 736], 'light'], [[1024, 640], 'dark'], [[1024, 640], 'light']]) {
  const tag = `${scheme} ${size[0]}`; const first = size[0] === 1280 && scheme === 'dark'; const full = true;   // every list, in each theme and size
  const { ctx, page, id } = await start(size, scheme, full);
  const allWs = az(['Technical', 'Legal', 'Commercial', 'Financial', 'Structure', 'Insurance', 'Tax', 'Regulatory & permits', 'Real estate', 'HR & benefits', 'IT & cyber', 'Antitrust & FDI', 'Compliance', 'Environmental & social', ...OWN_WS]);

  // Overview: the technology pick lists the firm's 40 lists A to Z, None last; typing keeps that order
  await page.click('#pick-technology > button'); await page.waitForSelector('#pick-technology-menu');
  const tech = await page.$$eval('#pick-technology-menu .scroll [data-pick]', (b) => b.map((x) => x.dataset.pick));
  const last = await page.$$eval('#pick-technology-menu > .mi', (b) => b.map((x) => x.textContent));
  say(`${tag}: technology pick is A to Z, None last`, JSON.stringify(tech) === JSON.stringify(az(TECH)) && last.at(-1) === 'None', JSON.stringify({ tech: tech.slice(0, 8), last }));
  say(`${tag}: with 40 lists the menu stays in the window and None is in view`, await inView(page, '#pick-technology-menu', '#pick-technology-menu > .mi:last-child'));
  say(`${tag}: the technology names scroll and show whole rows only`, await whole(page, '#pick-technology-menu .scroll'));
  await shot(page, 'technology-pick', scheme, size);
  if (first) {
    await page.keyboard.type('phase'); const typed = await page.$$eval('#pick-technology-menu .scroll [data-pick]', (b) => b.map((x) => x.dataset.pick));
    say('a search keeps the A to Z order', JSON.stringify(typed) === '["Phase 2 gas","Phase 10 gas"]', JSON.stringify(typed));
  }
  await page.keyboard.press('Escape');

  if (first) {   // the sidebar is not a dropdown: each group lists the newest deal first
    await page.evaluate(async () => { for (const name of ['zeta', 'Datum 10', 'beta', 'Datum 2']) await store.dispatch(store.commandNamed('CreateDeal'), { name, folders: [], counterparty: '' }, { quiet: true }); });
    await page.waitForFunction(() => document.querySelectorAll('.rail a.dealrow').length === 5);
    const rail = await page.$$eval('.rail a.dealrow .dn1', (a) => a.map((x) => x.textContent));
    say('the sidebar lists a group’s newest deal first', JSON.stringify(rail) === JSON.stringify(['Project Datum 2', 'Project beta', 'Project Datum 10', 'Project zeta', 'Project Proseware']), JSON.stringify(rail));
  }

  // Q&A: the workstream filter, then an open question's workstream, A to Z with the log's own names among the app's
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-ws');
  await page.click('#qa-ws'); await page.waitForSelector('.wsmenu');
  const filter = await texts(page, '.wsmenu label'); await page.keyboard.press('Escape');
  const filterOrder = JSON.stringify(['All Workstreams', ...allWs, 'No workstream']);
  say(`${tag}: Q&A workstream filter is All, then A to Z, No workstream last`, JSON.stringify(filter) === filterOrder,
    JSON.stringify(filter));
  await page.click('.list [role="option"]'); await page.waitForSelector('.qpanel #q-ws');
  await page.click('.qpanel #q-ws'); await page.waitForSelector('#q-wslist');
  const pick = await texts(page, '#q-wslist [role="option"]');
  say(`${tag}: a question's workstream is A to Z, No workstream last`, JSON.stringify(pick) === JSON.stringify([...allWs, 'No workstream']), JSON.stringify(pick));
  say(`${tag}: No workstream is in view at the foot of the long list`, await inView(page, '#q-wslist', '#q-wslist > [role="option"]:last-child'));
  await shot(page, 'question-workstream', scheme, size);
  await page.keyboard.press('Escape'); await page.waitForTimeout(150);

  if (full) {   // the dialogs: the same lists in the same order
    await page.evaluate((d) => store.ui({ dialog: { kind: 'exportQa', dealId: d } }), id); await page.waitForSelector('#x-by');
    const firms = await page.$$eval('#x-by label > span:not(.c)', (s) => s.map((x) => x.textContent));
    const xws = await texts(page, '#x-ws option');
    say(`${tag}: ` + 'Q&A export: the Submitted by check marks are as before, a blank party named Not recorded', firms[0] === 'All firms' && firms.includes('Not recorded') && firms.length === PARTIES.length + 2, JSON.stringify(firms));
    // No workstream last, as the page's filter has it
    const xOrder = JSON.stringify(['All Workstreams', ...allWs, 'No workstream']);
    say(`${tag}: ` + 'Q&A export: workstreams All, then A to Z, No workstream last', JSON.stringify(xws) === xOrder,
      JSON.stringify(xws));
    await shot(page, 'export-qa', scheme, size);
    await page.keyboard.press('Escape'); await page.waitForSelector('#x-by', { state: 'detached' });

    // findings: a new finding's workstream, an edit's (with an imported name of its own), and the export's
    await page.goto(URL + '#deal-' + id); await page.waitForSelector('#f-new', { timeout: 60000 });
    await page.click('#f-new'); await page.waitForSelector('#af-ws');
    const add = await texts(page, '#af-ws option');
    const app = az(['Technical', 'Legal', 'Commercial', 'Financial', 'Structure', 'Insurance', 'Tax', 'Regulatory & permits', 'Real estate', 'HR & benefits', 'IT & cyber', 'Antitrust & FDI', 'Compliance', 'Environmental & social']);
    say(`${tag}: ` + 'New finding: Workstream prompt, then A to Z', JSON.stringify(add) === JSON.stringify(['Workstream', ...app]), JSON.stringify(add));
    await page.fill('#af-title', 'Interconnection deposit not posted'); await page.selectOption('#af-ws', 'Tax'); await page.fill('#af-body', 'Not posted.'); await page.click('#af-create');
    await page.waitForFunction(() => Object.values(store.get().findings).some((f) => f.title === 'Interconnection deposit not posted'));
    const fid = await page.evaluate(() => Object.values(store.get().findings).find((f) => f.title === 'Interconnection deposit not posted').id);
    await page.evaluate(async ([d, f]) => { const x = store.get().findings[f]; await store.dispatch(store.commandNamed('EditFinding'), { dealId: d, findingId: f, title: x.title, workstream: 'Permitting', body: x.body, next: x.next }, { quiet: true }); }, [id, fid]);
    await page.goto(URL + `#finding-${id}-${fid}`); await page.waitForSelector('#f-edit'); await page.click('#f-edit'); await page.waitForSelector('#fe-ws');
    const edit = await texts(page, '#fe-ws option');
    say(`${tag}: ` + 'Editing a finding: its own workstream takes its place A to Z', JSON.stringify(edit) === JSON.stringify(az([...app, 'Permitting'])), JSON.stringify(edit));
    await page.keyboard.press('Escape');
    // the Findings page's own workstream filter, in its filter menu once the list is long
    await page.evaluate(async (d) => { for (const [i, w] of ['Phase 10 grid', 'Phase 2 grid', 'accounting', 'Água e meio', 'Legal', 'Tax', 'Commercial', 'Insurance', 'Technical', 'Legal'].entries())
      await store.dispatch(store.commandNamed('CreateFinding'), { dealId: d, title: `Point ${i + 1} on the grid`, workstream: w }, { quiet: true }); }, id);
    await page.goto(URL + '#deal-' + id); await page.waitForSelector('#f-filter'); await page.click('#f-filter');
    await page.waitForSelector('.fmenu [aria-label="Workstream"]');
    const ff = await texts(page, '.fmenu [aria-label="Workstream"] label');
    const fused = await page.evaluate(() => Object.values(store.get().findings).map((f) => f.workstream));
    say(`${tag}: ` + 'Findings filter: workstreams All, then A to Z, No workstream last as the list heads them', JSON.stringify(ff) === JSON.stringify(['All Workstreams', ...az(new Set(fused.map((w) => w.trim()).filter(Boolean))), ...(fused.some((w) => !w.trim()) ? ['No workstream'] : [])]), JSON.stringify(ff));
    await page.keyboard.press('Escape');
    await page.evaluate((d) => store.ui({ dialog: { kind: 'exportFindings', dealId: d } }), id); await page.waitForSelector('#fx-ws');
    const fx = await texts(page, '#fx-ws option'); const all = await page.evaluate(() => Object.values(store.get().findings).map((f) => f.workstream)); const used = all.map((w) => w.trim()).filter(Boolean);
    say(`${tag}: ` + 'Findings export: workstreams All, then A to Z', used.includes('Permitting')
      && JSON.stringify(fx) === JSON.stringify(['All Workstreams', ...az(new Set(used)),
      ...(all.some((w) => !w.trim()) ? ['No workstream'] : [])]), JSON.stringify(fx));
    await page.keyboard.press('Escape');

    // Settings, the firm's checklist: the technology lists A to Z, and the name field suggests them A to Z
    await page.goto(URL + '#overview-' + id); await page.waitForSelector('#u-menu');   // the finding page's slim rail has no account row
    await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open'); await page.waitForSelector('#fl-import');
        await shot(page, 'firm-lists', scheme, size);
    const csv = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'picksort-')), 'List.csv');
    fs.writeFileSync(csv, ['Area,Requirement,Owner', 'Grid,Interconnection agreement executed,AM', 'Land,Site control in place,PN'].join('\n'));
    // the column picks are the fallback when the model cannot read the list: Choose columns from the not-read line
    await page.evaluate(() => { window.__fail = { readList: true }; });
    await page.click('#fl-import'); await page.setInputFiles('#cl-file', csv); await page.waitForSelector('#cl-bycolumns'); await page.click('#cl-bycolumns'); await page.waitForSelector('[data-clmap="item"]');
    await page.evaluate(() => { window.__fail = {}; });
    await page.click('[data-layer=technology]'); await page.waitForSelector('#cl-names', { state: 'attached' });
    const sugg = await page.$$eval('#cl-names option', (o) => o.map((x) => x.value));
    const sec = await texts(page, '[data-clmap="section"] option'); const item = await texts(page, '[data-clmap="item"] option');
    say(`${tag}: ` + 'the list name suggests the firm’s lists A to Z', JSON.stringify(sugg) === JSON.stringify(az(TECH)), JSON.stringify(sugg.slice(0, 8)));
    say(`${tag}: ` + 'a column pick keeps the file’s order, with "not in file" last and the prompt first',
      JSON.stringify(sec) === '["Area","Requirement","Owner","— not in file —"]'
        && JSON.stringify(item) === '["Choose a Column","Area","Requirement","Owner"]', JSON.stringify({ sec, item }));
  }
  if (page.errors.length) say(`${tag}: no page errors`, false, page.errors.join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
