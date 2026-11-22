// Read-only while nobody is signed in to Intelligence (decisions: "Intelligence sign-in"), at deal scale
// (2,000 questions): the bar says Read-only with Sign in, the account row says it too, every change and AI action is off with
// the reason on hover, nothing typed is lost, and signing in from Settings brings everything back.
import { launchChrome } from './chrome.mjs';
import { openDealMenu, openRename } from './dealMenu.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
await page.addInitScript(() => { window.__signin = { signedIn: true }; });
await page.goto(URL + '#'); await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
const id = await page.evaluate(async () => {
  const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
  await run('CreateDeal', { name: 'Proseware', folders: [] }); const dealId = Object.values(store.get().deals)[0].id;
  const rows = Array.from({ length: 2000 }, (_, k) => ({ line: k + 2, n: k + 1, text: `Provide the executed copy of contract ${k + 1} and all amendments.`, response: '', askedBy: 'Lender A', received: '', workstream: 'Legal', priority: 'High', respondedBy: '', responded: '', status: '' }));
  await run('ImportQuestions', { dealId, mode: 'append', rows }); store.ui({ toasts: [] }); return dealId;
});
await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li');
// something typed in the ask box before the sign-in lapses
await page.click('#hask'); await page.keyboard.type('Which consents are outstanding?');
// a change with its Undo on offer when the sign-in lapses
const undoOp = await page.evaluate(async (d) => { const r = await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Undo me later' }, { quiet: true }); return r.value.opId; }, id);
await page.evaluate(() => { window.__signin.signedIn = false; }); await page.waitForSelector('#signin-bar', { timeout: 6000 });
await page.evaluate((opId) => store.toast('Question added', { label: 'Undo', opId }), undoOp);   // its notice, as the app posts it, still showing
await page.click('.toast:has-text("Question added") .tundo'); await page.mouse.move(5, 700); await page.waitForTimeout(9000);   // past the 8 seconds a notice stays
say('undo-pressed-signed-out-stays-on-offer', !!(await page.$('.toast:has-text("Question added") .tundo')) && await page.evaluate(() => Object.values(store.get().questions).some((q) => q.text === 'Undo me later')));
say('the-bar-says-read-only-with-sign-in', await page.evaluate(() => { const b = document.querySelector('#signin-bar'); return /Read-only/.test(b.textContent) && /Not signed in to Intelligence/.test(b.textContent) && !!b.querySelector('#signin-bar-go'); }));
say('the-account-row-says-read-only', (await page.textContent('#u-ro')) === 'Read-only' && !!(await page.$('#u-dot.out')));
// Check again, the memo, Rename and Delete deal… are in the header's ⋯ menu
await openDealMenu(page);
const controls = [
  '#qa-draftall', '#qa-add', '#deal-check', '#deal-memo', '#deal-rename', '.ddel', '#deal-group', '#new-deal',
  '.askbox .send',
];
const off = await page.evaluate((list) => list.map((s) => [s, document.querySelector(s)?.disabled]), controls);
await page.keyboard.press('Escape');
await page.waitForSelector('#deal-menu', { state: 'detached' });
say('change-and-ai-controls-are-off', off.every(([, d]) => d === true), JSON.stringify(off));
const why = await page.evaluate(() => [document.querySelector('#qa-add').closest('.needs')?.title, document.querySelector('.askbox .send').closest('.needs')?.title]);
say('the-reason-is-on-hover', why.every((t) => t === 'Sign in to Intelligence to make changes'), JSON.stringify(why));
say('reading-still-works',
  await page.evaluate(() => { const f = document.querySelector('input[aria-label="Filter questions"]'),
  w = document.querySelector('#qa-ws'); return !!f && !!w && !f.disabled && !w.disabled; }));
say('typed-ask-text-is-kept', (await page.inputValue('#hask')) === 'Which consents are outstanding?');
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
say('enter-sends-nothing-and-keeps-the-text', (await page.inputValue('#hask')) === 'Which consents are outstanding?' && (await page.evaluate(() => location.hash)).startsWith('#qa-'));
const refused = await page.evaluate((d) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'Blocked?' }, { quiet: true }), id);
say('the-store-refuses-a-change', !refused.ok && refused.error.message === 'Sign in to Intelligence to make changes');
// Sign in on the bar opens Settings at its sign-in row; a refused key stays; a good one signs in and everything comes back
await page.click('#signin-bar-go'); await page.waitForSelector('.setdlg #s-signin');
await page.click('#s-key-open'); await page.fill('#s-key', 'not-it'); await page.click('#s-key-use'); await page.waitForSelector('#s-signin-error');
say('a-refused-key-stays-in-the-field', (await page.inputValue('#s-key')) === 'not-it' && /didn’t accept that key/.test(await page.textContent('#s-signin-error')));
await page.fill('#s-key', 'good-key'); await page.click('#s-key-use'); await page.waitForSelector('#s-signin-change');
await page.waitForSelector('#signin-bar', { state: 'detached', timeout: 6000 });
await page.keyboard.press('Escape');
await page.click('.toast:has-text("Question added") .tundo'); await page.waitForTimeout(300);
say('signed-in-the-undo-goes-through', await page.evaluate(() => !Object.values(store.get().questions).some((q) => q.text === 'Undo me later' && !q.deletedAt)));
const back = await page.evaluate(() => ['#qa-add', '#new-deal', '.askbox .send'].map((s) => document.querySelector(s)?.disabled));
say('signed-in-again-everything-is-back', back.every((d) => d === false) && !(await page.$('#u-ro')), JSON.stringify(back));
say('the-ask-text-is-still-there', (await page.inputValue('#hask')) === 'Which consents are outstanding?');
// a deal name being typed when the sign-in lapses is kept on this PC as it is typed; the box gives the page back, and
// "Rename not saved" opens it again on purpose; after sign-in it is saved
await openRename(page);
await page.keyboard.press('Control+A');
await page.keyboard.type('Proseware Renamed Holdco');
await page.evaluate(() => { window.__signin.signedIn = false; }); await page.waitForSelector('#signin-bar', { timeout: 6000 });
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
say('signed-out-the-box-closes-and-the-name-waits', !(await page.$('#deal-name')) && !!(await page.$('#deal-name-kept')));
await page.evaluate(() => { location.hash = '#deals'; }); await page.waitForTimeout(300);
await page.evaluate((d) => { location.hash = '#qa-' + d; }, id); await page.waitForSelector('#deal-name-kept', { timeout: 3000 }).catch(() => null);
// the page is the person's: typing in Filter goes to Filter, and the name stays as typed
await page.click('input[aria-label="Filter questions"]'); await page.keyboard.type('consent'); await page.waitForTimeout(200);
say('the-kept-name-never-takes-the-focus', !(await page.$('#deal-name')) && (await page.inputValue('input[aria-label="Filter questions"]')) === 'consent' && !!(await page.$('#deal-name-kept')));
await page.fill('input[aria-label="Filter questions"]', '');
await page.evaluate(() => { window.__signin.signedIn = true; }); await page.waitForSelector('#signin-bar', { state: 'detached', timeout: 6000 });
// Escape on a reopened kept name only closes the box: the name stays kept
await page.click('#deal-name-kept'); await page.waitForSelector('#deal-name'); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
say('escape-on-a-kept-name-keeps-it', !(await page.$('#deal-name')) && !!(await page.$('#deal-name-kept')));
// typing over it and then Escape puts the kept name back, as Escape does in a one-line field
for (const keys of [['Z'], ['Backspace']]) {
  await page.click('#deal-name-kept'); await page.waitForSelector('#deal-name'); for (const k of keys) await page.keyboard.press(k); await page.keyboard.press('Escape'); await page.waitForTimeout(200);
  say(`typed-over-then-escape-keeps-the-kept-name-${keys[0]}`, !(await page.$('#deal-name')) && (await page.getAttribute('#deal-name-kept', 'title')) === 'Proseware Renamed Holdco');
}
await page.click('#deal-name-kept'); await page.waitForSelector('#deal-name');
say('rename-not-saved-opens-the-name-as-typed', (await page.inputValue('#deal-name')) === 'Proseware Renamed Holdco');
await page.keyboard.press('Enter'); await page.waitForTimeout(300);
say('signed-in-the-name-is-saved', await page.evaluate((d) => store.get().deals[d].name === 'Project Proseware Renamed Holdco', id) && !(await page.$('#deal-name-kept')), await page.evaluate((d) => store.get().deals[d].name, id));
// a coworker renames the deal while this PC's name waits: nothing is written over, and the person chooses
await openRename(page);
await page.keyboard.press('Control+A');
await page.keyboard.type('Proseware Mine');
await page.evaluate(() => { window.__signin.signedIn = false; }); await page.waitForSelector('#signin-bar', { timeout: 6000 });
await page.keyboard.press('Enter'); await page.waitForTimeout(200);
await page.evaluate((d) => window.__peer.change(d, { name: 'Project Proseware Coworker' }), id); await page.waitForTimeout(500);
await page.evaluate(() => { window.__signin.signedIn = true; }); await page.waitForSelector('#signin-bar', { state: 'detached', timeout: 6000 });
await page.click('#deal-name-kept'); await page.waitForSelector('#deal-name'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
say('a-coworkers-rename-is-not-written-over', await page.evaluate((d) => store.get().deals[d].name === 'Project Proseware Coworker', id) && !!(await page.$('#deal-name-moved')), await page.evaluate((d) => store.get().deals[d].name, id));
// Escape while Changed elsewhere shows is not Take theirs: the name stays kept, and asks again when opened
await page.keyboard.press('Escape'); await page.waitForTimeout(200);
say('escape-on-changed-elsewhere-keeps-the-name', !!(await page.$('#deal-name-kept')) && await page.evaluate((d) => store.get().deals[d].name === 'Project Proseware Coworker', id));
await page.click('#deal-name-kept'); await page.waitForSelector('#deal-name');
say('reopened-it-is-the-name-as-typed', (await page.inputValue('#deal-name')) === 'Proseware Mine');
await page.keyboard.press('Enter'); await page.waitForSelector('#deal-name-moved', { timeout: 3000 });
await page.click('#deal-name-moved button:has-text("Keep mine")', { timeout: 3000 }); await page.waitForTimeout(300);
say('keep-mine-saves-it', await page.evaluate((d) => store.get().deals[d].name === 'Project Proseware Mine', id), await page.evaluate((d) => store.get().deals[d].name, id));
say('no-page-errors', !page.errors.length, page.errors.join(' | '));
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
