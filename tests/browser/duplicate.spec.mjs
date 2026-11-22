// The duplicate-deal check: a new deal that looks like one the team has is asked about first, and nothing typed is lost;
// a deal whose documents another deal's data room holds says so on Overview.
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
const ROOM = 'D:\\Downloads\\Lucerne data room 2026-11-14';

/** The confirm's layout: the Data Room row first, Create Anyway left of Back, 44px rows, no rule over
 *  the buttons, and 23px from the buttons to the dialog's bottom edge */
function twinLayout() {
  const box = (sel) => document.querySelector(sel).getBoundingClientRect();
  const rows = [...document.querySelectorAll('#tw-rows .srow')];
  return {
    roomFirst: rows[0].contains(document.getElementById('tw-room')),
    anywayLeft: box('#tw-anyway').right < box('#tw-back').left,
    gap: Math.round(box('.twdlg').bottom - box('#tw-go').bottom),
    rule: getComputedStyle(document.querySelector('.twdlg .xfoot')).borderTopStyle !== 'none',
    rows: rows.map((r) => r.offsetHeight),   // the layout's height: the dialog may still be lifting in, scaled
  };
}

for (const [w, h, scheme] of [[1280, 736, 'dark'], [1024, 640, 'light']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  // the team's deals: 40, several sharing a name, one of them Project Lucerne for Woodgrove Capital, not in this
  // person's list
  const lucerne = await page.evaluate(async () => {
    const C = (n) => store.commandNamed(n); let lucerne = null;
    for (let i = 0; i < 40; i++) {
      const r = await store.dispatch(C('CreateDeal'), { name: ['Lucerne', 'Proseware', 'Bellows', 'Nod'][i % 4], folders: [], counterparty: `Sponsor ${i}` }, { quiet: true });
      const id = store.get().ops[r.value.opId].targets.find((t) => t.startsWith('d_'));
      if (i === 8) {
        lucerne = id;
        const edit = { dealId: id, counterparty: 'Woodgrove Capital', sector: 'Solar', technology: 'Storage' };
        await store.dispatch(C('EditDeal'), edit, { quiet: true });
        await store.dispatch(C('SetDealMember'), { dealId: id, on: false }, { quiet: true });
      }
    }
    store.ui({ toasts: [] }); return lucerne;
  });
  const count = () => page.evaluate(() => Object.keys(store.get().deals).length);
  const open = async (name, cp, path) => {
    await page.evaluate(() => { location.hash = 'deals'; }); await page.click('#new-deal'); await page.click('#add-new');
    await page.fill('#nd-name', name); if (cp) await page.fill('#nd-cp', cp);
    if (path) { await page.click('#nd-paste'); await page.fill('#nd-path', path); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); }
  };
  const was = await count();

  // a shared name, another counterparty and a data room nobody has: made at once, no question
  await open('Lucerne', 'Litware Capital', 'D:\\Deals\\New room');
  await page.click('#nd-create'); await page.waitForSelector('.dtabs');
  say(`a shared name alone is not asked about (${w})`, (await count()) === was + 1 && !(await page.$('#tw-go')));

  // the same data room as Project Lucerne: asked, with what tells the deals apart and what was found
  await page.evaluate(([p, id]) => { window.__sameRoom = { [p]: id }; }, [ROOM, lucerne]);
  await open('Lucerne', '', ROOM);
  await page.evaluate(() => store.ui((ui) => ({ newDeal: { ...ui.newDeal, kinds: { sector: 'solar', technology: 'Gas-fired' } } })));   // one alike, one not
  await page.click('#nd-create'); await page.waitForSelector('#tw-go');
  const asked = await page.evaluate(() => ({ title: document.querySelector('#tw-title').textContent, cp: document.querySelector('#tw-cp')?.textContent, room: document.querySelector('#tw-room')?.textContent, sector: document.querySelector('#tw-sector')?.textContent, others: !!document.querySelector('#tw-technology, #tw-product'), go: document.querySelector('#tw-go').textContent, focus: document.activeElement?.id, blur: !!document.querySelector('.scrim.blur') }));
  const lay = await page.evaluate(twinLayout);
  say(`the same data room asks "Is this Project Lucerne?" (${w})`, asked.title === 'Is this Project Lucerne?'
    && asked.cp === 'Woodgrove Capital' && asked.room === '1,840 of 2,100 files match' && asked.sector === 'Solar'
    && !asked.others && asked.go === 'Add Project Lucerne to My Deals' && asked.focus === 'tw-go' && asked.blur
    && lay.roomFirst && lay.anywayLeft && Math.abs(lay.gap - 23) <= 1 && !lay.rule && lay.rows.every((r) => r === 44),
    JSON.stringify({ asked, lay }));
  // Escape goes back to the form as it was
  await page.keyboard.press('Escape'); await page.waitForSelector('#nd-name');
  const kept = await page.evaluate(() => ({ name: document.querySelector('#nd-name').value, rows: document.querySelectorAll('.ndrow').length }));
  say(`Escape goes back to the form with nothing lost (${w})`, kept.name === 'Lucerne' && kept.rows === 1 && (await count()) === was + 1, JSON.stringify(kept));
  // Create Anyway makes the deal
  await page.click('#nd-create'); await page.waitForSelector('#tw-anyway'); await page.click('#tw-anyway'); await page.waitForSelector('#nd-name', { state: 'detached' }); await page.waitForSelector('.dtabs');
  say(`Create Anyway makes the new deal (${w})`, (await count()) === was + 2);
  // Overview: another deal's data room holds most of this one's documents; the two best show, a same-named one with its counterparty and date
  const mine = await page.evaluate((id) => { const me = location.hash.split('-').slice(1).join('-'); const others = Object.keys(store.get().deals).filter((x) => x !== id && x !== me).slice(0, 2);
    const twins = others.map((o, i) => ({ dealId: o, docs: 1500 - i, of: 2100 }));
    window.__alsoIn = { [me]: [{ dealId: id, docs: 1840, of: 2100 }, ...twins] }; return me; }, lucerne);
  await page.waitForFunction(() => !document.querySelector('.fbar .ix.live'), null, { timeout: 60000 }).catch(() => {});
  await page.evaluate((id) => store.refreshProgress(id), mine); await page.waitForSelector('.dcrow.also');
  const also = await page.evaluate(() => { const rows = [...document.querySelectorAll('.dcrow.also')]; const r = rows[0].getBoundingClientRect(), a = rows[0].querySelector('.fn').getBoundingClientRect();
    return { n: rows.length, first: rows[0].dataset.also, text: rows[0].querySelector('.an').textContent, twin: !!rows[0].querySelector('.copies'), files: rows[0].querySelector('.rd').textContent, top: Math.round(a.top - r.top), bottom: Math.round(r.bottom - a.bottom) }; });
  say(`Overview says "Also in Project Lucerne", the two best at most, with room above and below (${w})`,
    also.n === 2 && also.first === lucerne && also.text === 'Also in Project Lucerne' && also.twin
      && also.files === '1,840 of 2,100 files' && also.top >= 7 && also.bottom >= 7, JSON.stringify(also));
  // the main action adds the deal that is there, makes nothing, and opens it
  await open('Lucerne', '', ROOM); await page.click('#nd-create'); await page.click('#tw-go');
  await page.waitForFunction((id) => location.hash.endsWith(id), lucerne);
  const added = await page.evaluate((id) => ({ mine: Object.values(store.get().members).some((m) => m.dealId === id && m.on), dialog: !!document.querySelector('.dlg') }), lucerne);
  say(`"Add Project Lucerne to My Deals" adds it and opens it (${w})`,
    added.mine && !added.dialog && (await count()) === was + 2, JSON.stringify(added));
  // now it is one of theirs: the same name and counterparty is asked about, and the main action opens it
  await page.evaluate(() => { window.__sameRoom = {}; });
  await open('Lucerne', 'woodgrove capital', ''); await page.click('#nd-create'); await page.waitForSelector('#tw-go');
  const named = await page.evaluate(() => ({ go: document.querySelector('#tw-go').textContent, room: !!document.querySelector('#tw-room') }));
  say(`the same name and counterparty asks, and opens a deal already theirs (${w})`, named.go === 'Open Project Lucerne' && !named.room, JSON.stringify(named));
  say(`no page errors (${w})`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
