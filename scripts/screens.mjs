// Screenshots of the main screens at given window sizes, in dark and light, gathered into one PDF (one screen per page).
//   npm run build && npm run serve &      then      node scripts/screens.mjs [1440x900 1536x864 ...] [--pdfs <folder of .pdf files>]
// Output: out/screens/<size>-<theme>-<screen>.jpg and out/screens-<version>.pdf
// With --pdfs, reading mode shows real pages from those files (the demo holds no page images of its own).
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
import { openOnFindings } from '../tests/browser/landing.mjs';
import { followUp } from '../tests/browser/followUp.mjs';
const URL = 'http://127.0.0.1:4178/';
const args = process.argv.slice(2); const pi = args.indexOf('--pdfs'); const pdfDir = pi >= 0 ? args[pi + 1] : null;
const sizes = args.filter((arg, index) => /^\d+x\d+$/.test(arg) && (pi < 0 || index !== pi + 1))
  .map((arg) => arg.split('x').map(Number));
if (!sizes.length) sizes.push([1440, 900], [1536, 864]);
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const outDir = 'out/screens'; fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
const pdfs = pdfDir ? fs.readdirSync(pdfDir).filter((f) => /\.pdf$/i.test(f)).sort() : [];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });
openOnFindings(browser);
const shots = [];
for (const [w, h] of sizes) for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme }); const page = await ctx.newPage();
  if (pdfDir) await page.route('**/sample-pdf/*', (route) => route.fulfill({ path: path.join(pdfDir, decodeURIComponent(route.request().url().split('/sample-pdf/')[1])), contentType: 'application/pdf' }));
  const snap = async (name, note) => { await page.waitForTimeout(450); const file = `${outDir}/${w}x${h}-${scheme}-${name}.jpg`; await page.screenshot({ path: file, type: 'jpeg', quality: 90 }); shots.push({ file, label: `${w}×${h} · ${scheme} · ${note}` }); };
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow');
  await snap('01-new-deal', 'New deal dialog');
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  const findingId = await page.evaluate((dealId) => Object.values(store.get().findings)
    .filter((finding) => finding.dealId === dealId).sort((a, b) => a.title.localeCompare(b.title))[0].id, id);
  const texts = ['Confirm the lock-up ratio that applies from financial close, and which document prevails.', 'Provide the executed revenue contract and all amendments.', 'What is the basis for the operating assumption in the base case?', 'Has the interconnection agreement been signed, and what are its conditions?', 'Provide the insurance advisor’s latest report.', 'Who holds the land rights, and when do they expire?', 'Confirm the debt sizing criteria and the sculpting method.', 'List all permits outstanding and their expected dates.'];
  for (const t of texts) await page.evaluate(([d, t]) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal' }, { quiet: true }), [id, t]);
  await page.goto(URL + '#deals'); await page.waitForSelector('#hask'); await snap('02-home', 'Home');
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); await snap('03-deal', 'Deal: findings');
  await page.goto(URL + '#qa-' + id); await page.waitForFunction(() => document.querySelectorAll('.md .li').length >= 8); await page.click('.md .li >> nth=0'); await snap('04-qa', 'Deal: Q&A');
  await page.click('#qa-cols'); await page.waitForSelector('#colmenu'); await page.click('#qa-import'); await page.waitForSelector('.dlg'); await snap('05-import', 'Import dialog'); await page.keyboard.press('Escape');
  await page.goto(URL + `#finding-${id}-${findingId}`);
  await followUp(page, 'Why does this matter?');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed) .acts', { timeout: 15000 });
  await snap('06-finding', 'Finding with an answer');
  if (pdfs.length) await page.evaluate((name) => { window.__pdf = { '*': { url: `sample-pdf/${encodeURIComponent(name)}`, pages: 1 } }; }, pdfs[0]);   // any cited page shows the file's first page
  await page.click('.opening .ref .rb'); await page.waitForSelector('.docpanel'); await page.waitForSelector('.docbody .page.pdf.ready, .docbody .page:not(.ph-page):not(.pdf), .docbody .sheet', { timeout: 20000 }).catch(() => {}); await snap('07-reading', pdfs.length ? `Reading mode: ${pdfs[0]}` : 'Reading mode');
  await page.keyboard.press('Escape');
  // each further sample PDF, first page and a later page, so real pages of different shapes are seen
  for (const f of pdfs) for (const pg of [1, 2]) {
    await page.evaluate(([name]) => { window.__pdf = { '*': { url: `sample-pdf/${encodeURIComponent(name)}` } }; for (const k of Object.keys(store.get().pages)) store.setPage(k, undefined); }, [f, pg]);
    await page.evaluate(([d, name, pg]) => store.ui({ doc: null, docAside: { doc: name, docId: undefined, dealId: d, loc: 'p. ' + pg, from: 'From the conversation' } }), [id, f, pg]);
    await page.waitForSelector('.docpanel'); const ok = await page.waitForSelector('.docbody .page.pdf.ready', { timeout: 20000 }).then(() => true).catch(() => false);
    if (ok || pg === 1) await snap(`08-pdf-${f.replace(/\W+/g, '_')}-p${pg}`, `Real PDF: ${f}, page ${pg}${ok ? '' : ' (did not display)'}`);
    await page.keyboard.press('Escape'); await page.waitForSelector('.docpanel', { state: 'detached' }).catch(() => {});
  }
  await page.goto(URL + '#chat'); await page.waitForSelector('#pask').catch(() => {}); await snap('09-ask-all', 'Ask across deals');
  await page.click('#u-menu'); await page.waitForSelector('#s-theme'); await snap('10-settings', 'Settings'); await page.keyboard.press('Escape');
  await ctx.close();
}
// one PDF, one screen per page, labeled
const html = `<!doctype html><meta charset="utf-8"><style>@page{size:297mm 190mm;margin:6mm}body{margin:0;font:11px system-ui,sans-serif;color:#222}section{page-break-after:always;height:176mm;display:flex;flex-direction:column;gap:3mm}section:last-child{page-break-after:auto}img{max-width:100%;max-height:168mm;object-fit:contain;object-position:left top;border:1px solid #bbb}</style>` + shots.map((s) => `<section><div>${s.label}</div><img src="data:image/jpeg;base64,${fs.readFileSync(s.file).toString('base64')}"></section>`).join('');
const ctx = await browser.newContext(); const page = await ctx.newPage(); await page.setContent(html, { waitUntil: 'load' }); await page.pdf({ path: `out/screens-${version}.pdf`, preferCSSPageSize: true, printBackground: true });
await browser.close(); console.log(`${shots.length} screenshots → out/screens-${version}.pdf`);
