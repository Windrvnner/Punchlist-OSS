// Helpers for the suites that type into a finding's and an answer's forms (cardtyping, reopensave).
export const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;

/** the log a deal has by now: 2,000 questions, a third without a response */
const logRows = (n) => Array.from({ length: n }, (_, k) => ({
  line: k + 2, n: k + 1, text: `What is the position on condition precedent ${k + 1} of the credit agreement?`,
  response: k % 3 ? `See section ${k + 1} of the disclosure schedule.` : '', askedBy: k % 2 ? 'Lender A' : 'Bidder C',
  received: '', workstream: '', priority: 'High', respondedBy: '', responded: '', status: '',
}));

/** runs a command in the page */
export const run = (page, name, input) => page.evaluate(async ([n, i]) => {
  const done = await store.dispatch(store.commandNamed(n), i, { quiet: true });
  if (!done.ok) throw new Error(done.error.message);
}, [name, input]);

/** A deal whose first pass has run, with a Q&A log of 2,000 questions, opened on its first finding's page. */
export async function findingPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#fr-new');
  await page.click('#fr-new');
  await page.fill('#nd-name', 'Proseware');
  await page.click('#nd-paste');
  await page.fill('#nd-path', 'reports');
  await page.press('#nd-path', 'Enter');
  await page.waitForSelector('.ndrow');
  await page.click('#nd-create');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await run(page, 'ImportQuestions', { dealId: id, mode: 'append', rows: logRows(2000) });
  await page.evaluate(() => store.ui({ toasts: [] }));
  await page.click('.flagrow >> nth=0');
  await page.waitForSelector('#f-edit');
  const fid = await page.evaluate(() => location.hash.split('-').slice(2).join('-'));
  return { ctx, page, id, fid };
}

/** Holds the next run of `command` until `window.resume()`; later runs go straight through. */
export const holdNext = (page, command) => page.evaluate((name) => {
  const dispatch = store.dispatch.bind(store);
  let held = false;
  store.dispatch = async (cmd, ...args) => {
    if (cmd.name === name && !held) {
      held = true;
      await new Promise((resume) => { window.resume = resume; });
    }
    return dispatch(cmd, ...args);
  };
}, command);

/** a finding's title as stored */
export const titleOf = (page, fid) => page.evaluate((f) => store.get().findings[f]?.title, fid);

/** the deal's findings with a title */
export const titled = (page, dealId, title) => page.evaluate(([d, t]) => Object.values(store.get().findings)
  .filter((f) => f.dealId === d && f.title === t && !f.deleted), [dealId, title]);

/** opens an answer's Add as question ('q') or Add as finding ('f') card under the answer at `nth` */
export const openAdd = async (page, which, nth = 0) => {
  const name = which === 'q' ? 'Add as question' : 'Add as finding';
  await page.click(`.msgs .ai >> nth=${nth} >> .acts button[aria-label="${name}"]`);
  await page.waitForSelector(which === 'q' ? '#aq-text' : '#af-title');
};
/** what an open card holds */
export const cardHolds = (page, which) => page.evaluate((w) => ({
  text: document.querySelector(w === 'q' ? '#aq-text' : '#af-title')?.value ?? null,
  ws: document.querySelector(w === 'q' ? '#aq-ws' : '#af-ws')?.value ?? null,
}), which);
/** asks the deal a question and waits for the answer at `nth` */
export const ask = async (page, words, nth) => {
  await page.fill('#pcomposer textarea, #hask', words);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`.msgs .ai:not(.pending):not(.failed) >> nth=${nth}`, { timeout: 15000 });
};
