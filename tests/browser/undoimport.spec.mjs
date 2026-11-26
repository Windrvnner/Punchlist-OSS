// "Undo last import…" in the Q&A ⋯ menu: apart from Import, it asks first, saying what will happen, and acts only
// on "Undo import". A 1,000-question log imported again by Append (the demo's storage holds no more: #503, #507).
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note); };
const browser = await launchChrome();
const PARTIES = ['Lender counsel', 'Bidder 1', 'Bidder 2', 'Sponsor'];
const TOPICS = ['revenue by customer', 'EBITDA adjustments', 'change of control clauses', 'pending litigation', 'pension deficit', 'capex plan', 'working capital peg', 'key employee retention'];
const SIZE = 1000;

const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: 'dark' }); const page = await ctx.newPage(); const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(URL); await page.waitForSelector('#fr-new');
const id = await page.evaluate(async ([P, T, M]) => {
  await store.dispatch(store.commandNamed('CreateDeal'), { name: 'Proseware', folders: [] }, { quiet: true });
  const d = Object.values(store.get().deals).find((x) => x.name.endsWith('Proseware')).id; await store.loadDeal(d, { gaps: false });
  const rows = Array.from({ length: M }, (_, i) => ({ n: i + 1, text: `Please provide ${T[i % T.length]} for entity ${Math.floor(i / T.length) + 1}, item ${i + 1}.`, askedBy: P[i % P.length], received: '2026-11-02', workstream: i % 2 ? 'Legal' : 'Financial', priority: '', response: i % 5 === 0 ? `See data room folder 3.${i}` : '', respondedBy: i % 5 === 0 ? 'Target' : '', responded: '', status: '' }));
  const imp = store.commandNamed('ImportQuestions');
  await store.dispatch(imp, { dealId: d, mode: 'merge', rows }, { quiet: true });
  await store.dispatch(imp, { dealId: d, mode: 'append', rows }, { quiet: true });
  const qs = Object.values(store.get().questions).filter((q) => q.dealId === d);
  for (const n of [M + 4, M + 17, M + 350]) await store.dispatch(store.commandNamed('EditQuestionField'), { dealId: d, questionId: qs.find((x) => x.n === n).id, field: 'workstream', value: 'Tax' }, { quiet: true });
  store.ui({ toasts: [] }); return d;
}, [PARTIES, TOPICS, SIZE]);
const count = () => page.evaluate((d) => Object.values(store.get().questions).filter((q) => q.dealId === d).length, id);
await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li');
say('the log holds both imports', (await count()) === 2 * SIZE, String(await count()));

await page.click('#qa-cols'); await page.waitForSelector('#colmenu');
const order = await page.evaluate(() => [...document.querySelectorAll('#colmenu > .mi, #colmenu > .msep, #colmenu > .mirow')].map((e) => e.id || e.className));
say('the item sits after Deleted…, a rule away from Import', JSON.stringify(order.slice(order.indexOf('qa-import'), order.indexOf('qa-unimport') + 1)).includes('"msep","qa-deleted","qa-unimport"') && order.indexOf('qa-unimport') - order.indexOf('qa-import') > 2, JSON.stringify(order));
await page.click('#qa-unimport'); await page.waitForSelector('#ui-what');
const what = await page.textContent('#ui-what'); const kept = await page.textContent('#ui-kept');
say('the confirmation says what will happen', what === '997 questions go to Deleted.', what);
say('it names what changed since and stays', kept === '3 questions changed since and stay as they are: Q1004, Q1017, Q1350.', kept);
say('Keep the Import has the focus', await page.evaluate(() => document.activeElement?.id) === 'ui-keep');
await page.click('#ui-keep'); await page.waitForSelector('#ui-what', { state: 'detached' });
say('Keep the Import changes nothing', (await count()) === 2 * SIZE);
await page.click('#qa-cols'); await page.click('#qa-unimport'); await page.waitForSelector('#ui-go');
await page.keyboard.press('Escape'); await page.waitForSelector('#ui-what', { state: 'detached' });
say('Escape changes nothing', (await count()) === 2 * SIZE);
await page.click('#qa-cols'); await page.click('#qa-unimport'); await page.click('#ui-go');
await page.waitForFunction((n) => Object.values(store.get().questions).length === n, SIZE + 3);
const toast = await page.textContent('#toast .ttext');
say('Undo Import takes the import back, leaving the 3 changed since', (await count()) === SIZE + 3);
say('its notice names them and offers no Undo', toast === 'Import undone, except 3 changed since: Q1004, Q1017, Q1350' && !(await page.$('#toast .tundo')), toast);
await page.click('#qa-cols'); await page.waitForSelector('#qa-unimport');
say('nothing more is offered', await page.$eval('#qa-unimport', (b) => b.disabled));
// refused (nothing left to undo): the message, closed by the × alone, with no Close button of its own (#1069)
await page.keyboard.press('Escape');
await page.evaluate((d) => store.ui({ dialog: { kind: 'undoImport', dealId: d } }), id);
await page.waitForSelector('#ui-what');
const refused = await page.$$eval('.dlg button', (bs) => bs.map((b) => b.getAttribute('aria-label') || b.textContent));
say('a refused undo closes by the × alone', JSON.stringify(refused) === '["Close"]' && !(await page.$('#ui-keep')),
  JSON.stringify(refused));
await page.keyboard.press('Escape'); await page.waitForSelector('#ui-what', { state: 'detached' });
say('no page errors', !errors.length, errors.join(' | '));
await ctx.close();

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
