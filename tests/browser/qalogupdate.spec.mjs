// "Update Q&A log" says how it went in one notice: what it changed, kept cells counted alongside, and a log in use
// said to be in use elsewhere (who has it open named only when the lock file names someone, as written there), tried
// again on its own with Retry now (retry and notify). The browser build has no log files, so a stand-in for them is set
// on the page.
import { launchChrome } from './chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
await page.goto(URL + '#'); await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
const id = await page.evaluate(async () => {
  const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
  await run('CreateDeal', { name: 'Logged', folders: [] }); const dealId = Object.values(store.get().deals).find((d) => d.name.endsWith('Logged')).id;
  await store.loadDeal(dealId);
  await run('ImportQuestions', { dealId, mode: 'append', rows: [{ n: 1, text: 'What is the DSCR?', response: 'Ours' }, { n: 2, text: 'Who is the EPC contractor?', response: '' }].map((r, k) => ({ line: k + 2, askedBy: 'Lender A', received: '', workstream: '', priority: '', respondedBy: '', responded: '', status: '', ...r })) });
  await run('KeepQaLog', { dealId, log: { name: 'Log', file: 'Log.xlsx', folder: 'X:\\Deals\\Logged', sheet: 'Log', headerRow: 1, mapping: { n: 0, text: 1, response: 2 } } });
  // the log holds Q1 with someone else's response, and not Q2; saving says "in use" until told otherwise
  const ok = (value) => ({ ok: true, value });
  window.__save = { status: 'later' }; window.__saves = 0;
  store.services.qaLogs = {
    read: async () => ok({ columns: ['No.', 'Question', 'Response'], cols: [0, 1, 2], lines: [2], lastRow: 2, rows: [['1', 'What is the DSCR?', 'Theirs']], stamp: 's' }),
    save: async () => { window.__saves++; return ok(window.__save); },
    create: async (r) => ok({ file: r.file }),
  };
  store.ui({ toasts: [] }); return dealId;
});
await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li');
const toasts = () => page.evaluate(() => store.get().ui.toasts.map((t) => `${t.text}${t.action ? ` [${t.action.label}]` : ''}`));
await page.click('#qa-cols'); await page.click('#qa-log'); await page.waitForTimeout(300);
let t = await toasts();
say('a-log-in-use-says-it-is-in-use-elsewhere-and-offers-retry-now', t.length === 1
  && t[0] === 'The Q&A log is in use elsewhere · retrying [Retry Now]', JSON.stringify(t));
// a lock file that names someone: the name as it is there
await page.evaluate(() => { window.__save = { status: 'later', by: 'jroe' }; });
  await page.getByRole('button', { name: 'Retry Now' }).click(); await page.waitForTimeout(300);
t = await toasts();
say('a-named-lock-shows-the-name-as-written', t.length === 1
  && t[0] === 'jroe has the Q&A log open · retrying [Retry Now]', JSON.stringify(t));
// the notice reads whole on one line at the smaller window size too
await page.setViewportSize({ width: 1024, height: 640 }); await page.waitForTimeout(150);
const fits = () => page.$eval('#toast .ttext', (e) => e.scrollWidth <= e.clientWidth);
say('the-in-use-notice-fits-on-one-line-at-1024', await fits());
await page.evaluate(() => { window.__save = { status: 'written', archive: 'Log 2026-11-16.xlsx' }; });
await page.getByRole('button', { name: 'Retry Now' }).click(); await page.waitForTimeout(300);
t = await toasts();
say('retry-now-saves-and-says-what-changed-with-the-two-versions-first', t.length === 1 && t[0] === '1 in two versions · 1 added [Resolve]', JSON.stringify(t));
say('the-updated-notice-fits-on-one-line-at-1024', await fits());
// at a real deal's size the end may not fit; what comes first, the kept count, always shows, and the rest is on hover
await page.evaluate(() => {
  store.ui({ toasts: [] });
  store.toast('26 in two versions · 1,900 added, 707 answered, 120 updated', 'warn',
    { label: 'Resolve', run: () => {} }, true);
});
await page.waitForTimeout(150); await page.hover('#toast .ttext');
const big = await page.$eval('#toast .ttext', (e) => ({ fits: e.scrollWidth <= e.clientWidth, title: e.title, shown: e.clientWidth }));
say('a-long-notice-keeps-the-kept-count-in-view-and-the-whole-text-on-hover', big.shown > 150 && (big.fits || big.title === '26 in two versions · 1,900 added, 707 answered, 120 updated'), JSON.stringify(big));
say('one-save-per-try', (await page.evaluate(() => window.__saves)) === 3);
// someone's edit kept aside, filed in the archive with changes the log didn't take: said first; the notice stays
const filedNotice = async (rows) => {
  await page.evaluate((rows) => {
    const ok = (value) => ({ ok: true, value }); const files = store.services.qaLogs; store.ui({ toasts: [] });
    files.read = async () => ok({ columns: ['No.', 'Question', 'Response'], cols: [0, 1, 2], lines: rows.map((_, i) => i + 2), lastRow: rows.length + 1, rows, stamp: 's', kept: { files: [{ name: '~Log 0a1b2c3d.old', hash: 'h', left: true }], steps: [], clashes: [] } });
    files.settle = async (r) => ok({ gone: r.kept.map((k) => k.name) });
  }, rows);
  await page.click('#qa-cols'); await page.click('#qa-log'); await page.waitForTimeout(300);
  return { t: await toasts(), sticky: await page.evaluate(() => store.get().ui.toasts.map((x) => !!x.sticky)), fits: await fits() };
};
let f = await filedNotice([['1', 'What is the DSCR?', 'Theirs']]);
say('an-edit-filed-unmerged-is-said-first-alongside-the-kept-cells', f.t.length === 1 && f.t[0] === '1 edit not fully merged, filed in the archive · 1 in two versions · 1 added [Resolve]' && f.sticky[0], JSON.stringify(f));
f = await filedNotice([['1', 'What is the DSCR?', 'Ours'], ['2', 'Who is the EPC contractor?', '']]);
say('an-edit-filed-unmerged-is-said-on-its-own-and-stays', f.t.length === 1 && f.t[0] === '1 edit not fully merged, filed in the archive' && f.sticky[0] && f.fits, JSON.stringify(f));
// and when the update then can't be recorded, the edit filed is still said, first, and the notice stays
await page.evaluate(() => { const real = store.dispatch.bind(store); window.__realDispatch = real; store.dispatch = (c, ...a) => (c?.name === 'RecordQaLogExport' ? Promise.resolve({ ok: false, error: { kind: 'failed', message: 'disk full' } }) : real(c, ...a)); });
f = await filedNotice([['1', 'What is the DSCR?', 'Ours'], ['2', 'Who is the EPC contractor?', 'Again']]);
await page.evaluate(() => { store.dispatch = window.__realDispatch; });
say('an-edit-filed-unmerged-is-said-when-the-update-cant-be-recorded', f.t.length === 1 && f.t[0] === '1 edit not fully merged, filed in the archive · Q&A log not updated: disk full' && f.sticky[0], JSON.stringify(f));
// an edit to one of two rows that read alike, with nothing to tell which: the person says where it goes
const placeAsk = async () => page.evaluate(() => {
  const ok = (value) => ({ ok: true, value }); const files = store.services.qaLogs; store.ui({ toasts: [] }); window.__steps = null;
  const rows = [['1', 'What is the DSCR?', 'Ours'], ['2', 'Who is the EPC contractor?', ''], ['', 'Provide the cap table.', ''], ['', 'Provide the cap table.', 'Draft from the data room']];
  const at = (row, line, value) => ({ row, line, steps: [{ kind: 'cell', row: line - 1, col: 2, value }], clash: false });
  files.read = async () => ok({ columns: ['No.', 'Question', 'Response'], cols: [0, 1, 2], lines: [2, 3, 4, 5], lastRow: 5, rows, stamp: 's', kept: { files: [{ name: '~Log 0a1b2c3d.old', hash: 'h', steps: true }], steps: [], clashes: [], ask: [{ file: '~Log 0a1b2c3d.old', question: 'Provide the cap table.', cells: [{ heading: 'Response', theirs: 'Final answer, sroe', rows: ['', 'Draft from the data room'], changed: true }], rows: [at(2, 4, 'Final answer, sroe'), at(3, 5, 'Final answer, sroe')], add: [{ col: 1, value: 'Provide the cap table.' }, { col: 2, value: 'Final answer, sroe' }] }] } });
  files.save = async (r) => { window.__steps = r.steps; return ok({ status: 'written', archive: 'Log 2026-11-17.xlsx' }); };
  files.settle = async (r) => ok({ gone: r.kept.map((k) => k.name) });
});
await placeAsk(); await page.click('#qa-cols'); await page.click('#qa-log'); await page.waitForSelector('.pkdlg');
const pk = await page.evaluate(() => ({ title: document.querySelector('.pkdlg h2')?.textContent, rows: [...document.querySelectorAll('.pklist label')].map((l) => l.textContent), go: document.querySelector('#pk-go')?.disabled }));
say('an-edit-to-rows-that-read-alike-asks-where-it-goes', pk.title === 'Where does this edit go?' && JSON.stringify(pk.rows) === JSON.stringify(['Row 4Response: —', 'Row 5Response: Draft from the data room', 'New row', 'Leave out']) && pk.go === true, JSON.stringify(pk));
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
say('closing-it-leaves-the-update-for-later', !(await page.$('.pkdlg')) && (await page.evaluate(() => window.__steps)) === null && (await toasts()).length === 0, JSON.stringify(await toasts()));
await page.click('#qa-cols'); await page.click('#qa-log'); await page.waitForSelector('.pkdlg');
await page.click('.pklist label:nth-child(2)'); await page.click('#pk-go'); await page.waitForTimeout(300);
let steps = await page.evaluate(() => window.__steps);
say('the-row-picked-gets-the-edit', !(await page.$('.pkdlg')) && steps?.some((x) => x.kind === 'cell' && x.row === 4 && x.value === 'Final answer, sroe') && !steps.some((x) => x.row === 3 && x.value === 'Final answer, sroe'), JSON.stringify(steps));
await placeAsk(); await page.click('#qa-cols'); await page.click('#qa-log'); await page.waitForSelector('.pkdlg');
await page.click('.pklist label:nth-child(3)'); await page.click('#pk-go'); await page.waitForTimeout(300);
steps = await page.evaluate(() => window.__steps);
say('a-new-row-is-added-below-the-last', steps?.some((x) => x.kind === 'rows' && x.after === 4) && steps.some((x) => x.kind === 'cell' && x.row === 5 && x.value === 'Final answer, sroe'), JSON.stringify(steps));
// "Make this the deal's Q&A log" starts checked only for a file with two or more parties under Submitted by
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qalogupdate-'));
const one = path.join(tmp, 'Lender A list.csv'), many = path.join(tmp, 'Proseware Q&A log.csv');
fs.writeFileSync(one, 'No.,Question,Asked by\n1,What is the minimum DSCR?,Lender A\n2,Who is the O&M contractor?,Lender A\n');
fs.writeFileSync(many, 'No.,Question,Asked by\n1,What is the minimum DSCR?,Lender A\n2,Who is the O&M contractor?,Bidder C\n');
const checked = await page.evaluate(async () => {
  await store.dispatch(store.commandNamed('CreateDeal'), { name: 'Fresh', folders: [] }, { quiet: true });
  store.services.fs.pathFor = (f) => `X:\\Deals\\Fresh\\${f.name}`; return Object.values(store.get().deals).find((d) => d.name.endsWith('Fresh')).id;
});
await page.goto(URL + '#qa-' + checked); await page.waitForSelector('#qa-cols');
const offered = async (f) => { await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.imdlg'); await page.setInputFiles('#im-file', f); await page.waitForSelector('#im-makelog'); await page.waitForTimeout(200); const v = await page.isChecked('#im-makelog'); await page.click('#im-restart'); await page.click('#im-restart-ask-go'); await page.waitForSelector('#im-drop'); await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.imdlg')); return v; };
const [forOne, forMany] = [await offered(one), await offered(many)];
say('the-log-box-starts-checked-only-for-a-file-with-two-or-more-parties', forOne === false && forMany === true, JSON.stringify({ forOne, forMany }));
say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
