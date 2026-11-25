import { immapReady } from './importReady.mjs';
import { launchChrome } from './chrome.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { openOnFindings } from './landing.mjs';
import { portfolioQuestions } from '../fixtures/portfolioQuestions.ts';

/** the stand-in exports CSV (the app itself writes .xlsx through LibreOffice): read it back the way Excel would */
const readCsvFile = (file) => { const t = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"' && t[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\r' || c === '\n') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c; }
  return rows; };

const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();
openOnFindings(browser);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-transfer-'));
async function fresh(opts = {}) { const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, acceptDownloads: true, ...opts }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(URL); await page.waitForSelector('#fr-new, #ov-standing', { timeout: 10000 }); return { ctx, page }; }
const newDeal = async (page, name, folder = '') => {
  await page.click('#fr-new, #new-deal'); await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new'); await page.fill('#nd-name', name);
  if (folder) { await page.click('#nd-paste'); await page.fill('#nd-path', folder); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); }
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  return page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === 'Project ' + n).id, name);
};
const addQuestion = async (page, text) => { await page.evaluate(() => { window.__prevQ = store.get().ui.selectedQuestion; }); await page.click('#qa-add'); await page.waitForFunction(() => { const q = store.get().ui.selectedQuestion; return !!q && q !== window.__prevQ && !document.querySelector('.det[inert]') && !!document.querySelector('.det textarea.qtext'); }); await page.fill('.det textarea.qtext', text); await page.press('.det textarea.qtext', 'Tab'); await page.waitForTimeout(700); return page.evaluate(() => store.get().ui.selectedQuestion); };
const file = (name, content) => { const p = path.join(tmp, name); fs.writeFileSync(p, content); return p; };
const qs = (page, dealId) => page.evaluate((id) => Object.values(store.get().questions).filter((q) => q.dealId === id).sort((a, b) => a.n - b.n).map((q) => ({ n: q.n, text: q.text, status: q.status, response: q.response, received: q.received, askedBy: q.askedBy })), dealId);
const focusId = (page) => page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName);

// ---- 1 More menu, columns, export Q&A ------------------------------------------------
{ const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Export QA');
  await page.goto(URL + '#qa-' + dealId); await page.waitForSelector('#qa-add');
  await page.click('#qa-cols'); await page.waitForSelector('#colmenu');
  say('export-disabled-when-empty', await page.isDisabled('#qa-export'));
  // the spreadsheet is the "Q&A log" in the menu, as in the dialogs it opens (decisions.md, One name per thing)
  const named = await page.evaluate(() => ['qa-import', 'qa-export'].map((id) => document.getElementById(id).textContent));
  say('more-menu-names-the-q&a-log', named.join('|') === 'Import Q&A Log…|Export Q&A Log…', named.join('|'));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('colmenu'), null, { timeout: 2000 }).catch(() => {});
  say('menu-escape-returns-focus', !(await page.$('#colmenu')) && (await focusId(page)) === 'qa-cols', await focusId(page));
  const q1 = await addQuestion(page, 'What is the DSCR covenant?\nAnd the lock-up level?');
  await page.fill('.det input[aria-label="Submitted by"]', 'Lender A'); await page.press('.det input[aria-label="Submitted by"]', 'Tab'); await page.waitForTimeout(600);
  await page.fill('.det textarea.rtext', '1.20x & <1.10x> lock-up'); await page.press('.det textarea.rtext', 'Tab'); await page.waitForTimeout(600);
  await addQuestion(page, 'Second question');
  await page.fill('.det input[aria-label="Submitted by"]', 'Lender B'); await page.press('.det input[aria-label="Submitted by"]', 'Tab'); await page.waitForTimeout(600);

  // columns: hide Priority and Submitted by; survives a reload (a per-user preference)
  await page.click('#qa-cols'); await page.click('#colmenu [data-col="priority"]'); await page.click('#colmenu [data-col="askedBy"]');
  const hidden = await page.evaluate(() => ({ cls: document.querySelector('.md').className, pr: !!document.querySelector('.md .li .pr'), by: !!document.querySelector('.md .li .by') }));
  await page.reload(); await page.waitForSelector('.md .li');
  const hiddenAfter = await page.evaluate(() => ({ cls: document.querySelector('.md').className, by: !!document.querySelector('.md .li .by') }));
  say('columns-hide-and-persist', /nopr/.test(hidden.cls) && /noby/.test(hidden.cls) && !hidden.pr && !hidden.by && /nopr/.test(hiddenAfter.cls) && !hiddenAfter.by, JSON.stringify({ hidden, hiddenAfter }));
  await page.click('#qa-cols'); await page.click('#colmenu [data-col="priority"]'); await page.click('#colmenu [data-col="askedBy"]');
  say('columns-show-again', await page.evaluate(() => !!document.querySelector('.md .li .by') && !/nopr|noby/.test(document.querySelector('.md').className)));

  // export dialog: starts from the list's filter, counts follow the choices
  await page.click('#qa-export'); await page.waitForSelector('.xdlg');
  const start = await page.evaluate(() => ({ status: document.querySelector('#x-status .on').textContent, count: document.getElementById('x-count').textContent, firms: [...document.querySelectorAll('#x-by label')].map((l) => l.textContent), focus: !!document.activeElement.closest('.xdlg') && !document.activeElement.classList.contains('x') && /INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName), inert: document.getElementById('app').inert }));
  say('export-dialog-opens', start.status === 'Open' && start.count === '2 questions' && start.firms.join('|') === 'All firms2|Lender A1|Lender B1' && start.focus === true && start.inert, JSON.stringify(start));
  // the status row is named Status, as on the Findings export
  const statusLabel = await page.textContent('#x-status >> xpath=preceding-sibling::div[@class="k"]');
  say('export-status-row-named-status', statusLabel === 'Status', statusLabel);
  // the Submitted by boxes start where the Status control and the Workstream field start, with no sideways scroll
  const edges = await page.evaluate(() => { const l = (s) => Math.round(document.querySelector(s).getBoundingClientRect().left); const by = document.getElementById('x-by');
    return { seg: l('#x-status'), ws: l('#x-ws'), boxes: [...document.querySelectorAll('#x-by input')].map((i) => Math.round(i.getBoundingClientRect().left)), scroll: by.scrollWidth - by.clientWidth }; });
  say('export-boxes-aligned', edges.seg === edges.ws && edges.boxes.every((x) => x === edges.seg) && edges.scroll === 0, JSON.stringify(edges));
  await page.click('#x-by label:has-text("Lender B") input');
  say('export-count-follows-firms', (await page.textContent('#x-count')) === '1 question');
  await page.click('#x-status button:has-text("Closed")');
  say('export-empty-disables', (await page.textContent('#x-count')) === '0 questions' && await page.isDisabled('#x-go'));
  await page.click('#x-status button:has-text("All")');
  // a failed save stays in the dialog and can be retried
  await page.evaluate(() => { window.__save = store.services.fs.save; store.services.fs.save = async () => ({ ok: false, error: { kind: 'failed', message: 'disk' } }); });
  await page.click('#x-go'); await page.waitForFunction(() => /Couldn’t build the export/.test(document.getElementById('x-count').textContent));
  say('export-failure-stays', !!(await page.$('.xdlg')) && (await page.textContent('#x-go')) === 'Retry');
  await page.evaluate(() => { store.services.fs.save = window.__save; });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#x-go')]);
  const out = path.join(tmp, 'qa.csv'); await dl.saveAs(out);
  await page.waitForFunction(() => !document.querySelector('.xdlg'));
  const rows = readCsvFile(out);
  const toast = await page.textContent('#toast');
  say('export-file', dl.suggestedFilename() === 'Project Export QA Q&A log - Lender A.csv' && rows.length === 2 && rows[1][0] === '1' && rows[1][3] === 'Lender A' && rows[1][4] === 'What is the DSCR covenant?\nAnd the lock-up level?' && rows[1][7] === '1.20x & <1.10x> lock-up' && rows[1][6] === 'Open' && /Exported 1 question to Excel/.test(toast), JSON.stringify({ name: dl.suggestedFilename(), rows, toast }));
  say('export-changes-nothing', (await qs(page, dealId)).map((q) => q.status).join() === 'open,open');
  say('export-returns-focus-to-more', (await focusId(page)) === 'qa-cols', await focusId(page));

  // ---- import the exported file back: nothing differs ------------------------------
  await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.imdlg');
  await page.setInputFiles('#im-file', out); await immapReady(page);
  const map = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.immap select')].map((s) => [s.dataset.immap, s.options[s.selectedIndex].textContent])));
  say('import-mapping-suggested', map.n === '#' && map.text === 'Question' && map.askedBy === 'Submitted by' && map.received === 'Received' && map.workstream === 'Workstream' && map.response === 'Response' && map.responded === 'Date', JSON.stringify(map));
  say('import-counts-roundtrip', /Import 1 question · 0 new · 0 existing will change/.test(await page.textContent('#im-line')), await page.textContent('#im-line'));
  await page.click('#im-go'); await page.waitForFunction(() => !document.querySelector('.imdlg'));
  say('import-roundtrip-noop', /Nothing in the file differs/.test(await page.textContent('#toast')) && !(await page.$('#toast .tundo')), await page.textContent('#toast'));

  // ---- import a real file: merge, new rows, status only from the Status column, a bad date, Undo ----
  const csv = file('log.csv', '﻿Number,Question,Submitted by,Received,Response,Status,Priority\n1,"What is the DSCR covenant?\nAnd the lock-up level?",Lender A,11/02/2026,Updated response,,High\n,New with a response,Lender C,"Feb 31, 2026",Has a response,,urgent\n7,Closed on arrival,Lender C,2026-11-03,,Closed,Low\n,,,,,,\n');
  await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.imdlg');
  await page.setInputFiles('#im-file', csv); await immapReady(page);
  const step2 = await page.evaluate(() => ({ file: document.querySelector('.imfile').textContent, line: document.getElementById('im-line').textContent, head: [...document.querySelectorAll('.imprev:not(.imchg) th')].map((x) => x.textContent), first: [...document.querySelectorAll('.imprev:not(.imchg) tbody tr:first-child td')].map((x) => x.textContent), second: [...document.querySelectorAll('.imprev:not(.imchg) tbody tr:nth-child(2) td')].map((x) => x.textContent), rows: document.querySelectorAll('.imprev:not(.imchg) tbody tr').length, changes: [...document.querySelectorAll('#im-changes tbody tr')].map((r) => [...r.children].map((c) => c.textContent)) }));
  say('import-preview', /log\.csv · 3 rows/.test(step2.file) && step2.rows === 3 && step2.first[2] === 'Nov 2' && step2.second[2] === '—' && /Import 3 questions · 2 new · 1 existing will change · 1 date not read · 1 value not recognized/.test(step2.line), JSON.stringify(step2));
  // which they are, on hover and to a screen reader
  await page.hover('#im-line'); await page.waitForSelector('.tip'); const which = { tip: await page.textContent('.tip'), sr: await page.getAttribute('#im-line', 'aria-description') };
  say('import-names-what-it-did-not-read', which.tip === 'Row 3 Priority: urgent · Row 3 Received: Feb 31, 2026' && which.sr === which.tip, JSON.stringify(which));
  await page.mouse.move(5, 5);
  // before anything is written: which question a merge overwrites, field by field, now and after
  say('import-shows-what-it-overwrites', step2.changes.length >= 2 && step2.changes.every((c) => c[0] === '1') && !step2.changes.some((c) => c[1] === 'Question') && step2.changes.some((c) => c[1] === 'Response' && c[3] === 'Updated response'), JSON.stringify(step2.changes));
  await page.click('[data-immode="append"]');
  say('import-append-counts', /Import 3 questions · 3 new · 1 date/.test(await page.textContent('#im-line')) && !(await page.$('#im-changes')), await page.textContent('#im-line'));
  await page.click('[data-immode="merge"]');
  await page.selectOption('.immap select[data-immap="text"]', '');
  say('import-needs-question-column', /Choose the question column/.test(await page.textContent('#im-line')) && await page.isDisabled('#im-go'));
  await page.selectOption('.immap select[data-immap="text"]', '1');
  const beforeImport = await qs(page, dealId);
  await page.click('#im-go'); await page.waitForFunction(() => !document.querySelector('.imdlg'));
  const after = await qs(page, dealId); const t2 = await page.textContent('#toast');
  say('import-applied', after.length === 4 && after[0].text === 'What is the DSCR covenant?\nAnd the lock-up level?' && after[0].response === 'Updated response' && after[0].received === '2026-11-02' && after[0].status === 'open'
    && after[2].n === 3 && after[2].response === 'Has a response' && after[2].status === 'open' && after[2].received === '' && after[3].n === 7 && after[3].status === 'closed' && /Imported · 2 new · 1 updated/.test(t2), JSON.stringify({ after, t2 }));
  await page.click('#toast .tundo'); await page.waitForFunction((n) => Object.values(store.get().questions).length === n, beforeImport.length);
  say('import-undo', JSON.stringify(await qs(page, dealId)) === JSON.stringify(beforeImport), JSON.stringify(await qs(page, dealId)));
  await page.reload(); await page.waitForSelector('.md .li');
  say('import-undo-survives-reload', JSON.stringify(await qs(page, dealId)) === JSON.stringify(beforeImport));

  // ---- failures stay in the dialog and change nothing --------------------------------
  await page.click('#qa-cols'); await page.click('#qa-import'); await page.waitForSelector('.imdlg');
  await page.setInputFiles('#im-file', file('broken.xlsx', Buffer.from([1, 2, 3, 4, 5]))); await page.waitForSelector('#im-error');
  say('import-unreadable-file', /Could not read broken\.xlsx/.test(await page.textContent('#im-error')) && !(await page.$('.immap')), await page.textContent('#im-error'));
  await page.setInputFiles('#im-file', file('rule.csv', 'Number,Question,Status\n20,Fine,Open\n21,Answered without a response,Answered\n')); await immapReady(page);
  // a row that breaks a rule is reported before anything is imported, and Import stays off
  await page.waitForFunction(() => /Can’t import this file/.test(document.getElementById('im-line').textContent));
  say('import-rule-failure-atomic', /Row 3/.test(await page.textContent('#im-line')) && (await page.isDisabled('#im-go')) && !!(await page.$('.imdlg')) && (await qs(page, dealId)).length === beforeImport.length, await page.textContent('#im-line'));
  // storage full: the whole import is refused, the dialog stays, and it works once there is room
  await page.click('#im-back'); await page.setInputFiles('#im-file', csv); await immapReady(page);
  await page.evaluate(() => { let i = 0; for (const size of [262144, 16384, 512]) { for (;;) { try { localStorage.setItem('qaQuotaFixture' + (i++), 'x'.repeat(size)); } catch { break; } } } });
  // what the change files hold: an import refused for want of room writes nothing to them
  const stored = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('dil/2/shared/')).reduce((n, k) => n + localStorage.getItem(k).length, 0)); const storedBefore = await stored();
  await page.click('#im-go'); await page.waitForFunction(() => /Couldn’t import/.test(document.getElementById('im-line').textContent));
  const full = { n: (await qs(page, dealId)).length, toast: await page.textContent('#toast'), stored: await stored(), storedBefore };
  say('import-storage-full-atomic', full.n === beforeImport.length && full.stored === storedBefore && storedBefore > 0 && /storage is full/.test(full.toast), JSON.stringify(full));
  await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('qaQuotaFixture')) localStorage.removeItem(k); });
  await page.click('#im-go'); await page.waitForFunction(() => !document.querySelector('.imdlg'));
  say('import-after-room', (await qs(page, dealId)).length === 4);

  // a second tab sees the import
  const page2 = await ctx.newPage(); await page2.goto(URL + '#qa-' + dealId); await page2.waitForSelector('.md .li'); await page2.click('.seg button:has-text("All")');
  const before2 = await page2.evaluate(() => document.querySelectorAll('.md .li').length);
  await page.click('#qa-cols'); await page.click('#qa-import'); await page.setInputFiles('#im-file', file('more.csv', 'Question\nFrom the other tab\n')); await immapReady(page); await page.click('#im-go'); await page.waitForFunction(() => !document.querySelector('.imdlg'));
  await page2.waitForFunction((n) => document.querySelectorAll('.md .li').length === n + 1, before2, { timeout: 5000 }).catch(() => {});
  say('import-seen-in-second-tab', (await page2.evaluate(() => document.querySelectorAll('.md .li').length)) === before2 + 1);
  say('no-page-errors-1', page.errors.length === 0 && true, JSON.stringify(page.errors));
  await ctx.close(); }

// A complete, scrollable overwrite preview for a deal-scale merge (#272).
{
  const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Import review');
  await page.goto(`${URL}#qa-${dealId}`);
  const count = 2_000;
  const questions = portfolioQuestions().slice(0, count);
  const before = 'Approval is pending.';
  const after = 'Approval is complete.';
  async function openCsv(page, response) {
    const rows = questions.map((question, index) => `${index + 1},"${question.replaceAll('"', '""')}",${response}`);
    const csv = file('merge-review.csv', ['Number,Question,Response', ...rows].join('\n'));
    await page.click('#qa-cols');
    await page.click('#qa-import');
    await page.setInputFiles('#im-file', csv);
    await immapReady(page);
  }
  await openCsv(page, before);
  await page.click('#im-go');
  await page.waitForSelector('.imdlg', { state: 'detached' });
  const storageState = await ctx.storageState();
  await ctx.close();

  async function checkPreview(colorScheme, width, height) {
    const label = `${colorScheme}-${width}x${height}`;
    const context = await browser.newContext({ colorScheme, viewport: { width, height }, storageState });
    try {
      const review = await context.newPage();
      await review.goto(`${URL}#qa-${dealId}`);
      await openCsv(review, after);
      const table = review.locator('#im-changes');
      await table.waitFor();
      await table.locator('tbody tr').last().scrollIntoViewIfNeeded();

      const preview = await table.evaluate((pane, { before, after }) => {
        const rows = [...pane.querySelectorAll('tbody tr')];
        const allPairsMatch = rows.every((row, index) => {
          const cells = [...row.cells].map((cell) => cell.textContent);
          return cells.join('|') === [String(index + 1), 'Response', before, after].join('|');
        });
        const last = rows.at(-1);
        const frame = pane.getBoundingClientRect();
        const row = last.getBoundingClientRect();
        const cellsExposed = [...last.cells].every((cell) => {
          const rect = cell.getBoundingClientRect();
          return cell.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
        });
        const lastVisible = pane.scrollTop > 0 && row.top >= frame.top && row.bottom <= frame.bottom && cellsExposed;
        return { rows: rows.length, allPairsMatch, lastVisible, theme: document.documentElement.dataset.theme };
      }, { before, after });
      say(`merge-previews-every-overwrite-${label}`,
        preview.rows === count && preview.allPairsMatch && preview.lastVisible && preview.theme === colorScheme,
        JSON.stringify(preview));

      const importReachable = await review.locator('#im-go').click({ trial: true, timeout: 3_000 })
        .then(() => true, () => false);
      say(`merge-import-stays-reachable-${label}`, importReachable);
      const saved = await qs(review, dealId);
      say(`merge-preview-leaves-responses-unchanged-${label}`,
        saved.length === count && saved.every((question) => question.response === before));
    } finally {
      await context.close();
    }
  }

  for (const theme of ['dark', 'light']) {
    await checkPreview(theme, 1280, 736);
    await checkPreview(theme, 1024, 640);
  }
}

// Rows that match no question exactly are suggested one to slot in as; nothing is applied until it is accepted.
{
  const { ctx, page } = await fresh();
  const dealId = await newDeal(page, 'Could match');
  await page.goto(`${URL}#qa-${dealId}`);
  const questions = portfolioQuestions().slice(0, 2_000);
  const csvOf = (rows) => file('could-match.csv', ['Number,Question,Response', ...rows.map((q, i) => `${i + 1},"${q.replaceAll('"', '""')}",${'Answer ' + (i + 1)}`)].join('\n'));
  const open = async (target, path) => { await target.click('#qa-cols'); await target.click('#qa-import'); await target.setInputFiles('#im-file', path); await immapReady(target); };
  await open(page, csvOf(questions));
  await page.click('#im-go'); await page.waitForSelector('.imdlg', { state: 'detached' });
  const storageState = await ctx.storageState(); await ctx.close();
  const SHOWN = 8;
  const reworded = questions.map((q, i) => (i < SHOWN ? q.toLowerCase().replace(/[?.]+$/, '') : q));
  const shots = path.join(tmp, 'could-match'); fs.mkdirSync(shots, { recursive: true });
  for (const [scheme, width, height] of [['dark', 1280, 736], ['light', 1280, 736], ['dark', 1024, 640], ['light', 1024, 640]]) {
    const label = `${scheme}-${width}x${height}`;
    const context = await browser.newContext({ colorScheme: scheme, viewport: { width, height }, storageState });
    try {
      const review = await context.newPage(); review.errors = []; review.on('pageerror', (e) => review.errors.push(e.message));
      await review.goto(`${URL}#qa-${dealId}`); await open(review, csvOf(reworded));
      await review.waitForSelector('#im-suggest');
      const found = await review.evaluate(() => ({ rows: document.querySelectorAll('#im-suggest tbody tr').length, line: document.getElementById('im-line').textContent, buttons: document.querySelectorAll('#im-suggest [data-accept]').length }));
      say(`could-match-lists-each-row-${label}`, found.rows === SHOWN && found.buttons === SHOWN && new RegExp(`${SHOWN} new`).test(found.line), JSON.stringify(found));
      await review.screenshot({ path: path.join(shots, `${label}.png`) });
      const geometry = await review.evaluate(() => { const pane = document.getElementById('im-suggest'); const frame = pane.getBoundingClientRect(); const dlg = document.querySelector('.imdlg').getBoundingClientRect(); return { inside: frame.left >= dlg.left && frame.right <= dlg.right, overflowX: pane.scrollWidth > pane.clientWidth + 1, goInView: document.getElementById('im-go').getBoundingClientRect().bottom <= window.innerHeight }; });
      say(`could-match-fits-${label}`, geometry.inside && geometry.goInView, JSON.stringify(geometry));
      await review.click('#im-suggest [data-accept]');
      const after = await review.evaluate(() => ({ rows: document.querySelectorAll('#im-suggest tbody tr').length, line: document.getElementById('im-line').textContent }));
      say(`could-match-accept-${label}`, after.rows === SHOWN - 1 && new RegExp(`${SHOWN - 1} new · 1 existing will change`).test(after.line), JSON.stringify(after));
      if (label === 'dark-1280x736') {
        await review.click('.imdlg .xfoot, .imdlg'); await review.keyboard.press('Escape'); await review.waitForTimeout(300);
        if (await review.$('.imdlg')) await review.click('#im-close, [aria-label=Close]').catch(() => {});
        await review.click('#qa-cols'); await review.click('#qa-import'); await immapReady(review);
        const kept = await review.evaluate(() => document.querySelectorAll('#im-suggest tbody tr').length);
        say('could-match-accepted-is-kept-when-reopened', kept === SHOWN - 1, String(kept));
        await review.click('#im-go'); await review.waitForSelector('.imdlg', { state: 'detached' });
        const saved = await qs(review, dealId);
        say('could-match-import-adds-only-the-unaccepted', saved.length === 2_000 + SHOWN - 1 && saved[0].text === reworded[0], JSON.stringify({ n: saved.length, first: saved[0].text }));
      }
      say(`could-match-no-page-errors-${label}`, review.errors.length === 0, JSON.stringify(review.errors));
    } finally { await context.close(); }
  }
  console.log('screenshots in', shots);
}

// ---- 2 Excel's two date systems: read through LibreOffice, tested in tests/backend/sheets.test.ts (the stand-in reads CSV only)

// ---- 3 findings export, settings, search ----------------------------------------------
{ const { ctx, page } = await fresh({ colorScheme: 'dark' });
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  const proseware = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await page.click('#f-more'); await page.click('#f-export'); await page.waitForSelector('.xdlg');
  say('findings-export-dialog', (await page.textContent('#fx-count')) === '3 findings');
  await page.check('#fx-rev'); say('findings-export-reviewed-only', (await page.textContent('#fx-count')) === '0 findings' && await page.isDisabled('#fx-go'));
  await page.uncheck('#fx-rev');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#fx-go')]); const out = path.join(tmp, 'f.csv'); await dl.saveAs(out);
  const rows = readCsvFile(out);
  say('findings-export-file', dl.suggestedFilename() === 'Project Proseware findings.csv' && rows.length === 4 && rows[0][0] === 'Title' && rows[0][1] === 'Detail' && !rows[0].includes('Id') && !rows[0].includes('Reviewed by') && rows[1][1].length > 20 && !/\[\d\]/.test(rows[1][1]) && rows[1][3] === 'Open' && rows[1][5] === 'AI' && /\.pdf|\.xlsx/.test(rows[1][7]), JSON.stringify(rows.slice(0, 2)));

  // settings
  await page.click('#u-menu'); await page.waitForSelector('#s-theme');
  const s0 = await page.evaluate(() => ({ name: document.getElementById('s-name').textContent, on: document.querySelector('#s-theme .on').textContent, theme: document.documentElement.dataset.theme, models: document.querySelectorAll('#s-model button').length, keys: document.querySelectorAll('.keylist dt').length }));
  say('settings-opens', s0.name === 'jdoe' && s0.on === 'Match Windows' && s0.theme === 'dark' && s0.models === 3 && s0.keys === 8, JSON.stringify(s0));
  await page.click('[data-theme-pick="light"]');
  say('theme-light-applies', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light');
  await page.click('#s-model button:has-text("Thorough")');
  await page.keyboard.press('Control+k'); await page.waitForTimeout(150);
  say('ctrl-k-ignored-over-dialog', !(await page.evaluate(() => store.get().ui.palette || document.activeElement?.id === 'pal-in')) && !!(await page.$('#s-theme')));
  await page.keyboard.press('Escape');
  say('settings-escape-returns-focus', !(await page.$('#s-theme')) && (await focusId(page)) === 'u-menu' && !(await page.evaluate(() => document.getElementById('app').inert)), await focusId(page));
  await page.reload(); await page.waitForSelector('.flagrow');
  const s1 = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, model: store.get().model }));
  say('settings-persist', s1.theme === 'light' && s1.model === 'thorough', JSON.stringify(s1));
  await page.click('#u-menu'); await page.click('[data-theme-pick="system"]'); await page.keyboard.press('Escape');
  await page.emulateMedia({ colorScheme: 'light' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'light', null, { timeout: 2000 }).catch(() => {}); const sysL = await page.evaluate(() => document.documentElement.dataset.theme);
  await page.emulateMedia({ colorScheme: 'dark' }); await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 2000 }).catch(() => {}); const sysD = await page.evaluate(() => document.documentElement.dataset.theme);
  say('theme-follows-windows', sysL === 'light' && sysD === 'dark', sysL + '/' + sysD);

  // a second deal with a question, then a fresh session where neither deal has been opened
  const other = await newDeal(page, 'Wingtip');
  await page.goto(URL + '#qa-' + other); await page.waitForSelector('#qa-add');
  const qid = await addQuestion(page, 'Who holds the substation lease?');
  await page.click('.det #q-status'); await page.click('#q-st-closed'); await page.waitForTimeout(500);
  await page.goto(URL + '#deals'); await page.reload(); await page.waitForSelector('#hask');
  say('search-starts-unloaded', await page.evaluate(() => Object.keys(store.get().questions).length === 0));
  // search is the field in the rail: Ctrl K puts the cursor in it, nothing opens in the middle of the window, the app stays live
  await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in');
  const p0 = await page.evaluate(() => ({
    focus: document.activeElement.id,
    inRail: !!document.querySelector('.rail #pal-in'),
    drop: !!document.getElementById('pal-drop'),
    inert: document.getElementById('app').inert,
    centered: !!document.querySelector('.pal'),
    fields: document.querySelectorAll('#pal-in').length,
    button: !!document.getElementById('open-search'),
  }));
  say(
    'search-is-one-field-in-the-rail',
    p0.focus === 'pal-in' && p0.inRail && !p0.drop && !p0.inert && !p0.centered && p0.fields === 1 && !p0.button,
    JSON.stringify(p0),
  );
  const glass = await page.evaluate(() => [getComputedStyle(document.querySelector('.askbox.glass')).backdropFilter, getComputedStyle(document.querySelector('.rail')).backdropFilter]);
  say('built-css-keeps-glass-blur', glass.every((x) => /blur\(/.test(x)), JSON.stringify(glass));
  const opts = '#pal-res button:not(.pmore)';
  await page.keyboard.type('substation'); await page.waitForFunction((o) => document.querySelectorAll(o).length >= 1, opts);
  const p1 = await page.evaluate((o) => { const f = document.getElementById('rsearch').getBoundingClientRect(), d = document.getElementById('pal-drop').getBoundingClientRect(); return { where: [...document.querySelectorAll(o)].map((b) => b.querySelector('.where').textContent), labels: [...document.querySelectorAll('#pal-res .plbl')].map((l) => l.textContent), below: d.top >= f.bottom && d.top - f.bottom < 12, aligned: Math.abs(d.left - f.left) < 1, onScreen: d.right <= innerWidth && d.bottom <= innerHeight, glass: getComputedStyle(document.getElementById('pal-drop')).backdropFilter }; }, opts);
  say('search-finds-unvisited-question', p1.where.some((w) => /Project Wingtip · Q1/.test(w)) && p1.labels.join() === 'Questions', JSON.stringify(p1));
  say('results-drop-from-the-field', p1.below && p1.aligned && p1.onScreen && /blur\(12px\)/.test(p1.glass), JSON.stringify(p1));
  await page.keyboard.press('Enter'); await page.waitForSelector('.det');
  const landed = await page.evaluate(() => ({ hash: location.hash, sel: store.get().ui.selectedQuestion, filter: store.get().ui.qaFilter.status, det: document.querySelector('.det textarea.qtext').value, pal: store.get().ui.palette, drop: !!document.getElementById('pal-drop'), text: document.getElementById('pal-in').value }));
  say('search-opens-question', landed.hash === '#qa-' + other && landed.sel === qid && landed.filter === 'all' && /substation/.test(landed.det) && !landed.pal && !landed.drop && landed.text === '', JSON.stringify(landed));

  // results are grouped by type; a type shows its first five and says how many more there are
  await page.evaluate(async (dealId) => { const c = store.commandNamed('CreateQuestion'); for (let i = 1; i <= 7; i++) await store.dispatch(c, { dealId, text: `Covenant compliance item ${i}` }, { quiet: true }); }, other);
  await page.click('#pal-in'); await page.keyboard.type('covenant'); await page.waitForFunction((o) => document.querySelectorAll(o).length === 5, opts);
  const g0 = await page.evaluate((o) => ({ n: document.querySelectorAll(o).length, more: document.querySelector('#pal-res .pmore')?.textContent, labels: [...document.querySelectorAll('#pal-res .plbl')].map((l) => l.textContent) }), opts);
  await page.click('#pal-res .pmore'); await page.waitForFunction((o) => document.querySelectorAll(o).length === 7, opts);
  const g1 = await page.evaluate((o) => ({ n: document.querySelectorAll(o).length, more: !!document.querySelector('#pal-res .pmore'), focus: document.activeElement.id }), opts);
  const firstFive = g0.n === 5 && g0.more === 'Show 2 More' && g0.labels.join() === 'Questions';
  const all = g1.n === 7 && !g1.more && g1.focus === 'pal-in';
  say('search-groups-and-says-how-many-more', firstFive && all, JSON.stringify({ g0, g1 }));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');

  // a cited document opens reading mode at that document; arrows move the selection
  await page.click('#pal-in'); await page.keyboard.type('.pdf'); await page.waitForFunction((o) => document.querySelectorAll(o).length >= 1, opts);
  const docs = await page.evaluate(() => [...document.querySelectorAll('#pal-res button')].map((b) => [b.firstChild.textContent, b.querySelector('.where')?.textContent ?? '']));
  const onIdx = () => page.evaluate(() => [...document.querySelectorAll('#pal-res button')].findIndex((b) => b.classList.contains('on')));
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150); const sel1 = await onIdx();
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(150); const sel0 = await onIdx();
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(150); const wrap = await onIdx(); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150);
  say('search-arrows', docs.length > 1 && sel1 === 1 && sel0 === 0 && wrap === docs.length - 1 && (await onIdx()) === 0, JSON.stringify({ sel1, sel0, wrap, n: docs.length }));
  await page.keyboard.press('Enter'); await page.waitForSelector('#doc-close', { state: 'attached', timeout: 5000 });
  const reading = await page.evaluate(() => ({ hash: location.hash, doc: store.get().ui.doc, name: document.querySelector('#doc-menu')?.textContent || '', body: document.body.className }));
  say('search-opens-document', /^#finding-/.test(reading.hash) && reading.doc != null && reading.name.includes(docs[0][0]), JSON.stringify({ reading, first: docs[0] }));
  // with the rail folded away, Ctrl K brings the same field up beside it, and Escape puts it away
  await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in');
  const fl = await page.evaluate(() => { const f = document.getElementById('rsearch'); const r = f.getBoundingClientRect(); return { float: f.classList.contains('float'), inRail: !!f.closest('.rail'), fields: document.querySelectorAll('#pal-in').length, left: r.left, top: r.top }; });
  await page.keyboard.type('lock'); await page.waitForFunction((o) => document.querySelectorAll(o).length >= 1, opts);
  await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.getElementById('pal-in'));
  say('search-floats-beside-a-folded-rail', fl.float && !fl.inRail && fl.fields === 1 && fl.left < 120 && fl.top < 40 && (await page.evaluate(() => store.get().ui.doc != null && !store.get().ui.palette)), JSON.stringify(fl));
  await page.keyboard.press('Escape'); await page.waitForFunction(() => store.get().ui.doc == null);
  // Escape hands the cursor back to where it came from
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask'); await page.focus('#hask'); await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.press('Escape');
  say('search-escape-returns-focus', (await focusId(page)) === 'hask' && !(await page.evaluate(() => store.get().ui.palette)), await focusId(page));
  await page.keyboard.press('Control+k'); await page.waitForFunction(() => document.activeElement?.id === 'pal-in'); await page.keyboard.type('zzzz-nothing'); await page.waitForFunction(() => /No matches/.test(document.getElementById('pal-res')?.textContent ?? ''), null, { timeout: 4000 }).catch(() => {});
  say('search-no-matches', /No matches/.test(await page.textContent('#pal-res')));
  await page.keyboard.press('Control+k'); await page.waitForTimeout(100);
  say('ctrl-k-toggles', await page.evaluate(() => !store.get().ui.palette && document.activeElement?.id !== 'pal-in' && !document.getElementById('pal-drop')));
  say('no-page-errors-3', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

async function overwriteComparisonLayout(page) {
  return page.locator('#im-changes').evaluate((pane) => {
    const bounds = pane.getBoundingClientRect();
    const headerBottom = pane.querySelector('th').getBoundingClientRect().bottom;
    const footerTop = pane.closest('.imdlg').querySelector('.xfoot').getBoundingClientRect().top;
    const visibleBottom = Math.min(bounds.bottom, footerTop);
    const values = [...pane.querySelectorAll('tbody td:nth-child(n+3)')].map((cell) => {
      const text = cell.firstChild;
      const newline = text.textContent.indexOf('\n');
      const range = document.createRange();
      const lineAt = (offset) => {
        range.setStart(text, offset);
        range.setEnd(text, offset + 1);
        return range.getBoundingClientRect().top;
      };
      const keptLineBreak = lineAt(newline + 1) > lineAt(newline - 1);
      range.setStart(text, text.length - 8);
      range.setEnd(text, text.length);
      const end = range.getBoundingClientRect();
      const cellBounds = cell.getBoundingClientRect();
      return {
        value: text.textContent,
        keptLineBreak,
        readable: end.top >= headerBottom && end.bottom <= visibleBottom && end.right <= cellBounds.right,
        widthFits: cell.scrollWidth === cell.clientWidth,
      };
    });
    return { values, scrolled: pane.scrollTop > 0, widthFits: pane.scrollWidth === pane.clientWidth };
  });
}

// A merge must show where long responses with the same opening differ (#269).
const question = 'Confirm the amount and timing of the debt service reserve.';
const prefix = 'The reserve uses the next twelve months of scheduled principal and interest in both projections. '
  + 'The amount will be funded from the first disbursement.';
const now = `${prefix}\nThe approved illustration shows a twelve-month reserve.`;
const after = `${prefix}\nThe revised illustration shows a six-month reserve.\n`
  + 'AmendmentAcknowledgmentAndReserveFundingDocumentationReference';
const mergeFile = file('reserve.csv', `Number,Question,Response\n1,"${question}","${after}"\n`);
for (const [width, height] of [[1280, 736], [1024, 640]]) {
  for (const colorScheme of ['light', 'dark']) {
    const { ctx, page } = await fresh({ viewport: { width, height }, colorScheme });
    const dealId = await newDeal(page, 'Import preview');
    await page.goto(URL + '#qa-' + dealId);
    await addQuestion(page, question);
    await page.fill('.det textarea.rtext', now);
    await page.press('.det textarea.rtext', 'Tab');
    await page.waitForFunction((expected) => Object.values(store.get().questions)
      .some((row) => row.response === expected), now);

    await page.click('#qa-cols');
    await page.click('#qa-import');
    await page.setInputFiles('#im-file', mergeFile);
    await immapReady(page);
    await page.waitForSelector('#im-changes tbody td');
    await page.focus('#im-answered');
    // Bring the comparison above the sticky footer before scrolling inside it.
    await page.keyboard.press('End');
    await page.waitForFunction(() => {
      const dialog = document.querySelector('.imdlg');
      return dialog.scrollTop + dialog.clientHeight >= dialog.scrollHeight - 1;
    });
    await page.keyboard.press('Tab');
    const focused = await focusId(page);
    await page.keyboard.press('End');
    const reachedEnd = await page.waitForFunction(() => {
      const pane = document.getElementById('im-changes');
      return pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1;
    }, null, { timeout: 5000 }).then(() => true, () => false);

    const layout = await overwriteComparisonLayout(page);
    const exactText = layout.values.map(({ value }) => value).join('|') === [now, after].join('|');
    const valuesFit = layout.values.every(({ keptLineBreak, readable, widthFits }) =>
      keptLineBreak && readable && widthFits);
    const view = `${colorScheme}-${width}x${height}`;
    say(`overwrite-values-show-both-endings-with-keyboard-${view}`, focused === 'im-changes' && reachedEnd
      && layout.scrolled && layout.widthFits && exactText && valuesFit, JSON.stringify({ focused, ...layout }));
    say(`overwrite-comparison-does-not-write-${view}`, (await qs(page, dealId))[0].response === now);
    await ctx.close();
  }
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
