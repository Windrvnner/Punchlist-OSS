// Screenshots for the README, from the browser build on its stand-in services, at a realistic deal's size: a deal with
// two data room folders, its first pass of findings and checklist, and a Q&A log of 2,000 questions across the
// workstreams; a few more deals fill the sidebar. Each screen in dark and light at 1440x900, into docs/images/.
//   npm run build && npm run serve &      then      node scripts/readme-shots.mjs
import { chromium } from 'playwright'; import fs from 'node:fs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const outDir = 'docs/images'; fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome' });

// The demo holds no page images, so reading mode is shown with one page of the credit agreement's blackline, made here as a PDF
// (the same hook as npm run screens -- --pdfs): it backs the finding the conversation is about.
const REPORT = `<!doctype html><meta charset="utf-8"><style>
@page { size: Letter; margin: 0.9in 0.95in 0.8in; } body { font: 10.5pt/1.55 Georgia, serif; color: #1d1d1f; }
.top { display: flex; justify-content: space-between; font: 8pt Helvetica, Arial, sans-serif; color: #6e6e73; border-bottom: 0.5pt solid #b0b0b5; padding-bottom: 6pt; margin-bottom: 20pt; }
h2 { font: bold 11pt Helvetica, Arial, sans-serif; margin: 0 0 10pt; text-transform: uppercase; letter-spacing: 0.04em; } p { margin: 0 0 9pt; text-align: justify; } .cl { padding-left: 28pt; text-indent: -28pt; } .sub { padding-left: 56pt; text-indent: -28pt; }
del { color: #b3261e; } ins { color: #1d4ed8; text-decoration: underline; } .foot { position: fixed; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-between; font: 8pt Helvetica, Arial, sans-serif; color: #6e6e73; }
</style>
<div class="top"><span>Project Proseware · Credit agreement · Blackline of draft 1 against the sponsor's draft</span><span>Lenders' counsel draft</span></div>
<h2>22. Distributions</h2>
<p class="cl">22.1&emsp;The Borrower shall not make any Distribution unless each of the conditions in Clause 22.2 is met on the date of the Distribution.</p>
<p class="cl">22.2&emsp;The conditions are that:</p>
<p class="sub">(a)&emsp;the Distribution is made within 30 days after a Calculation Date;</p>
<p class="sub">(b)&emsp;the Historic Debt Service Coverage Ratio for the Calculation Period ending on that Calculation Date is not less than <del>1.20:1</del> <ins>1.25:1</ins>;</p>
<p class="sub">(c)&emsp;the Projected Debt Service Coverage Ratio for the next Calculation Period is not less than <del>1.20:1</del> <ins>1.25:1</ins>;</p>
<p class="sub">(d)&emsp;the Debt Service Reserve Account is funded to the Required Balance <ins>and the Maintenance Reserve Account to its Required Balance</ins>;</p>
<p class="sub">(e)&emsp;no Default is continuing or would result from the Distribution; and</p>
<p class="sub">(f)&emsp;the first Repayment Date has occurred.</p>
<p class="cl">22.3&emsp;If the conditions in Clause 22.2 are not met on <del>two</del> <ins>three</ins> consecutive Calculation Dates, the amounts standing to the credit of the Distribution Account shall be applied in prepayment of the Loans in accordance with Clause 8.4 (<i>Mandatory prepayment</i>).</p>
<p class="cl">22.4&emsp;The Agent shall notify the Borrower within five Business Days after receiving the Compliance Certificate for a Calculation Period whether the conditions in Clause 22.2 are met.</p>
<div class="foot"><span>Confidential · Subject to contract</span><span>12</span></div>`;
const reportPdf = 'out/readme-report.pdf'; fs.mkdirSync('out', { recursive: true });
{ const p = await (await browser.newContext()).newPage(); await p.setContent(REPORT); await p.pdf({ path: reportPdf, format: 'Letter', preferCSSPageSize: true }); await p.context().close(); }

// what a project finance Q&A log asks: each workstream's questions about its own subjects, every pair once, then follow-ups
const ASKS = {
  Legal: [['Provide the executed {s} and all amendments.', 'Confirm whether the {s} needs lender consent to assign.', 'Are there any defaults or disputes under the {s}?', 'Confirm the governing law and the termination rights in the {s}.'], ['revenue contract', 'interconnection agreement', 'EPC contract', 'O&M agreement', 'land lease', 'direct agreement', 'module supply agreement', 'balance of plant contract', 'cable route easement', 'shareholders’ agreement']],
  Technical: [['Confirm the {s} assumed in the base case and its source.', 'Provide the technical advisor’s view on the {s}.', 'What risk remains in the {s}?', 'Explain the change in the {s} since the last model.'], ['energy yield', 'degradation rate', 'availability guarantee', 'curtailment assumption', 'construction schedule', 'substation works', 'inverter replacement cycle', 'wake loss estimate']],
  Commercial: [['Provide the offtaker’s position on the {s}.', 'How is the {s} priced after year ten?', 'Confirm the volumes covered by the {s}.', 'What happens to the {s} on a change in law?'], ['revenue contract', 'merchant tail', 'capacity payment', 'renewable energy credit sales', 'balancing arrangement', 'offtaker credit support']],
  Financial: [['Reconcile the {s} in the model with the term sheet.', 'Provide the sensitivity of the debt sizing to the {s}.', 'Confirm how the {s} is treated in the cash flow waterfall.', 'Provide the figures behind the {s}.'], ['debt service reserve', 'lock-up ratio', 'sponsor equity commitment', 'hedging strategy', 'decommissioning reserve', 'maintenance reserve', 'contingency budget', 'operating cost forecast']],
  Insurance: [['Confirm the deductible and the limit for the {s}.', 'Is the {s} placed with insurers of the required rating?', 'Provide the broker’s letter on the {s}.'], ['construction all risks cover', 'delay in start-up cover', 'business interruption cover', 'third-party liability cover', 'marine cargo cover']],
  Tax: [['Confirm the tax treatment of the {s}.', 'Has a ruling been obtained on the {s}?', 'Provide the tax advisor’s memo on the {s}.'], ['tax equity structure', 'property tax abatement', 'investment tax credit', 'depreciation schedule', 'transfer of tax credits']],
  'Environmental & social': [['List the conditions attached to the {s}.', 'Provide the monitoring reports for the {s}.', 'Confirm the {s} meets the Equator Principles.'], ['wetlands delineation', 'environmental permit', 'noise assessment', 'bird and bat study', 'cultural heritage survey', 'stakeholder engagement plan']],
};
const ASKED_BY = { Legal: ['Lender A', 'Lender B'], Technical: ['Technical advisor', 'Lender A'], Commercial: ['Lender B', 'Market advisor'], Financial: ['Model auditor', 'Lender A'], Insurance: ['Insurance advisor'], Tax: ['Lender B'], 'Environmental & social': ['Lender A', 'Technical advisor'] };
const ANSWERS = ['Provided in the data room.', 'See the updated draft in the data room.', 'Confirmed: no change from the term sheet.', 'Covered in the advisor’s report, section 4.', 'Not applicable to this project.', 'The executed copy will follow at signing.'];
const ROUNDS = ['', ' Please also confirm the position at financial close.', ' Please update for the latest draft.', ' Please confirm for the final draft.'];
function questions(n) {
  // every workstream's questions about its own subjects, interleaved so the log reads as a real one does
  const pools = Object.entries(ASKS).map(([w, [asks, subjects]]) => ({ w, list: subjects.flatMap((s, i) => asks.map((a, j) => a.replace('{s}', s)).slice(i % asks.length).concat(asks.map((a) => a.replace('{s}', s)).slice(0, i % asks.length))) }));
  const rows = []; const day = (k) => new Date(Date.UTC(2026, 6, 1) + Math.floor(k / 20) * 86400000).toISOString().slice(0, 10);
  for (let round = 0, k = 0; rows.length < n; round++) for (let i = 0; rows.length < n && i < 200; i++) for (const { w, list } of pools) {
    if (rows.length >= n || i >= list.length) continue;
    const answered = k % 5 < 3; const closed = k % 11 === 0; const by = ASKED_BY[w][k % ASKED_BY[w].length];
    rows.push({
      line: rows.length + 2,
      n: rows.length + 1,
      text: list[i] + ROUNDS[round % ROUNDS.length] + (round >= ROUNDS.length ? ` (round ${round + 1})` : ''),
      response: answered ? ANSWERS[k % ANSWERS.length] : '',
      askedBy: by,
      received: day(k),
      workstream: w,
      priority: ['High', 'Medium', 'Low'][k % 3],
      respondedBy: answered ? 'Contoso Wind Partners' : '',
      responded: answered ? day(k + 60) : '',
      status: closed ? 'closed' : '',
    });
    k++;
  }
  return rows;
}

const FINDINGS = [['Legal', 'Direct agreement is unsigned two weeks before financial close'], ['Legal', 'Land lease term ends before the final debt maturity'], ['Technical', 'Energy yield assessment uses wind data from a single met mast'], ['Technical', 'Module degradation rate is lower than the supplier warranty supports'], ['Commercial', 'Offtaker can terminate the revenue contract on a change in law'], ['Financial', 'Debt service reserve is funded from the first drawdown, not at close'], ['Financial', 'Model applies the lock-up test before the reserve top-up'], ['Insurance', 'Delay in start-up cover is three months shorter than the construction float'], ['Tax', 'Property tax abatement lapses if commercial operation slips past 2028'], ['Environmental & social', 'Wetlands delineation is not yet confirmed for the cable route']];

for (const scheme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: +(process.env.W || 1440), height: +(process.env.H || 900) }, colorScheme: scheme }); const page = await ctx.newPage();
  await page.route('**/sample-pdf/*', (route) => route.fulfill({ path: reportPdf, contentType: 'application/pdf' }));
  const snap = async (name) => { await page.mouse.move(2, 450); await page.waitForTimeout(600); await page.screenshot({ path: `${outDir}/${name}-${scheme}.jpg`, type: 'jpeg', quality: 90 }); };
  await page.goto(URL); await page.waitForSelector('#fr-new');
  // other deals, so the sidebar looks like a team's
  await page.evaluate(async () => {
    const run = (n, i) => store.dispatch(store.commandNamed(n), i, { quiet: true });
    const more = [['Wingtip', 'Northwind Capital', 'live'], ['Trey', 'Woodgrove Infrastructure', 'live'], ['Alpine', 'Fabrikam Partners', 'monitor'], ['Lucerne', 'Tailspin Energy', 'pitch'], ['Humongous', 'Litware Renewables', 'pitch'], ['Adventure Works', 'Adatum Power', 'closed']];
    for (const [name, counterparty, group] of more) { await run('CreateDeal', { name, folders: [], counterparty }); const d = Object.values(store.get().deals).find((x) => x.name === `Project ${name}`); await run('EditDeal', { dealId: d.id, group }); }
    store.ui({ toasts: [] });
  });
  // the deal shown: two data room folders, indexed, with its first pass done
  await page.goto(URL); await page.waitForSelector('#fr-new, .dealrow');
  await page.click('button[aria-label="Add deal"]');
  await page.waitForSelector('#nd-name, #add-new'); if (await page.$('#add-new')) await page.click('#add-new');
  await page.fill('#nd-name', 'Proseware'); await page.fill('#nd-cp', 'Contoso Wind Partners').catch(() => {});
  await page.click('#nd-paste'); for (const [i, p] of ['C:\\Deals\\Proseware\\Data room', 'C:\\Deals\\Proseware\\Advisor reports'].entries()) { await page.fill('#nd-path', p); await page.press('#nd-path', 'Enter'); await page.waitForFunction((n) => document.querySelectorAll('.ndrow').length === n, i + 1); }
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  const id = await page.evaluate(() => Object.values(store.get().deals).find((d) => d.name === 'Project Proseware').id);
  await page.waitForFunction((d) => Object.values(store.get().findings).filter((f) => f.dealId === d).length >= 3, id, { timeout: 60000 });
  await page.evaluate(async (dealId) => { await store.dispatch(store.commandNamed('EditDeal'), { dealId, product: 'Project finance', sector: 'Renewables', technology: 'Offshore wind' }, { quiet: true }); }, id);
  // more findings, as a deal part way through diligence has, beside the three from the first pass
  await page.evaluate(async ([dealId, more]) => { for (const [workstream, title] of more) await store.dispatch(store.commandNamed('CreateFinding'), { dealId, workstream, title }, { quiet: true }); }, [id, FINDINGS]);
  // reading mode: a short question on the deal, its answer complete, and the cited page beside it
  await page.evaluate(() => { window.__pdf = { '*': { url: 'sample-pdf/blackline.pdf', pages: 1 } }; });
  await page.goto(URL + '#overview-' + id); const ask = page.locator('textarea[placeholder^="Ask about"]'); await ask.click(); await ask.fill('What changed in the lock-up ratio in the latest draft?'); await page.keyboard.press('Enter');
  await page.waitForSelector('.msgs .ai:not(.pending):not(.failed) .acts', { timeout: 20000 }); await page.waitForTimeout(600);
  await page.click('.msgs .ai :text("Credit agreement (blackline).pdf") >> nth=0'); await page.waitForSelector('.docpanel');
  await page.waitForSelector('.docbody .page.pdf.ready', { timeout: 20000 }); await page.waitForTimeout(800); await snap('reading');
  await page.keyboard.press('Escape'); await page.waitForSelector('.docpanel', { state: 'detached' });
  await page.evaluate(async ([dealId, rows]) => { await store.dispatch(store.commandNamed('ImportQuestions'), { dealId, mode: 'append', rows, answerResponded: true }, { quiet: true }); store.ui({ toasts: [] }); }, [id, questions(2000)]);
  await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 20000 }).catch(() => {});
  await page.goto(URL + '#overview-' + id); await page.waitForSelector('#ov-docs .dcrow'); await page.waitForTimeout(1500); await snap('overview');
  await page.goto(URL + '#deal-' + id); await page.waitForSelector('.flagrow'); await snap('findings');
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('.ckrow[data-result="finding"]'); await page.click('.ckrow[data-result="finding"] >> nth=0'); await page.waitForTimeout(400); await snap('checklist');
  // Q3 open, as the person left it, so the list stays at its top with the deal's header row showing
  await page.evaluate((d) => { const q = Object.values(store.get().questions).find((x) => x.dealId === d && x.n === 3); store.setPrefs({ qaOpen: { ...store.get().prefs.qaOpen, [d]: q.id } }); store.ui({ qaFilter: { status: 'all', workstream: '', text: '' } }); }, id);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.qpos'); await snap('qa');   // the list back at its top, with the deal's header row showing
  await ctx.close();
}
await browser.close(); console.log('README screenshots in', outDir);
