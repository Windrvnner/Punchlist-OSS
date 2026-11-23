// Text typed into a finding's cards is never lost: while Save or Create Finding is still out (#32, #115), and on a finding's page when the
// finding is deleted under a question being typed (#340); and in an answer's Add as question and Add as finding
// cards, which keep what was typed per answer (#51). At deal scale: a log of 2,000 questions in the deal.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note);
};
const browser = await launchChrome();
openOnFindings(browser);
const N = 2000;

/** the log a deal has by now: 2,000 questions, a third without a response */
const logRows = (n) => Array.from({ length: n }, (_, k) => ({
  line: k + 2, n: k + 1, text: `What is the position on condition precedent ${k + 1} of the credit agreement?`,
  response: k % 3 ? `See section ${k + 1} of the disclosure schedule.` : '', askedBy: k % 2 ? 'Lender A' : 'Bidder C',
  received: '', workstream: '', priority: 'High', respondedBy: '', responded: '', status: '',
}));

/** runs a command in the page */
const run = (page, name, input) => page.evaluate(async ([n, i]) => {
  const done = await store.dispatch(store.commandNamed(n), i, { quiet: true });
  if (!done.ok) throw new Error(done.error.message);
}, [name, input]);

/** A deal whose first pass has run, with a Q&A log of 2,000 questions, opened on its first finding's page. */
async function findingPage() {
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
  await run(page, 'ImportQuestions', { dealId: id, mode: 'append', rows: logRows(N) });
  await page.evaluate(() => store.ui({ toasts: [] }));
  await page.click('.flagrow >> nth=0');
  await page.waitForSelector('#f-edit');
  const fid = await page.evaluate(() => location.hash.split('-').slice(2).join('-'));
  return { ctx, page, id, fid };
}

/** Holds the next run of `command` until `window.resume()`; later runs go straight through. */
const holdNext = (page, command) => page.evaluate((name) => {
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
const titleOf = (page, fid) => page.evaluate((f) => store.get().findings[f]?.title, fid);

{ // #32: text typed into a finding's edit while Save is out stays in the edit, and a second Save writes it
  const { ctx, page, fid } = await findingPage();
  const hash = await page.evaluate(() => location.hash);
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Submitted title');
  await holdNext(page, 'EditFinding');
  await page.click('#fe-save');
  await page.fill('#fe-title', 'New title typed while saving');
  await page.evaluate(() => window.resume());
  await page.waitForFunction((f) => store.get().findings[f].title === 'Submitted title', fid);
  await page.waitForTimeout(200);
  const kept = await page.evaluate(() => document.querySelector('#fe-title')?.value ?? null);
  // away and back: the edit comes back from its kept draft
  await page.goto(URL + '#deals');
  await page.goto(URL + hash);
  await page.waitForSelector('#fe-title', { timeout: 5000 }).catch(() => {});
  const back = await page.evaluate(() => document.querySelector('#fe-title')?.value ?? null);
  if (back) await page.click('#fe-save');
  await page.waitForSelector('#fe-title', { state: 'detached' });
  const second = await titleOf(page, fid);
  const err = await page.evaluate(() => !!document.querySelector('#fe-err'));
  say('#32 text typed while Save is out is kept, survives leaving, and a second Save writes it',
    kept === 'New title typed while saving' && back === kept && second === kept && !err && !page.errors.length,
    JSON.stringify({ kept, back, second, err, errors: page.errors }));
  // control: nothing typed during the save closes the edit as before
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Saved with nothing typed after');
  await holdNext(page, 'EditFinding');
  await page.click('#fe-save');
  await page.evaluate(() => window.resume());
  const closed = await page.waitForSelector('#fe-title', { state: 'detached', timeout: 5000 }).then(() => true, () => false);
  say('#32 a save with nothing typed during it still closes the edit',
    closed && await titleOf(page, fid) === 'Saved with nothing typed after' && !page.errors.length,
    JSON.stringify({ closed, errors: page.errors }));
  await ctx.close();
}

{ // #32: another PC changes the detail while Save is out; the later typing and the other PC's detail both stay
  const { ctx, page, fid } = await findingPage();
  await page.click('#f-edit');
  await page.fill('#fe-title', 'First title');
  await holdNext(page, 'EditFinding');
  await page.click('#fe-save');
  await page.fill('#fe-title', 'Second title');
  await page.evaluate(() => window.resume());
  await page.waitForFunction((f) => store.get().findings[f].title === 'First title', fid);
  await page.evaluate((f) => __peer.change(f, { body: ['Changed on the other PC.'] }, { by: 'jdoe', from: 'PC B' }), fid);
  await page.waitForFunction((f) => store.get().findings[f].body[0] === 'Changed on the other PC.', fid);
  await page.click('#fe-save');
  const settled = await page.waitForSelector('#fe-title', { state: 'detached', timeout: 5000 }).then(() => 'closed',
    () => 'open');
  const now = await page.evaluate((f) => store.get().findings[f], fid);
  const err = await page.evaluate(() => document.querySelector('#fe-err')?.textContent ?? '');
  const bothKept = now.title === 'Second title' && now.body[0] === 'Changed on the other PC.';
  // or, if the detail sent is taken as a clash, Save says so and the typing stays in the field
  const askedInstead = settled === 'open' && /changed elsewhere/.test(err)
    && await page.evaluate(() => document.querySelector('#fe-title').value) === 'Second title';
  say('#32 a second Save after typing during the first never overwrites another PC\'s change',
    (bothKept || askedInstead) && !page.errors.length, JSON.stringify({ settled, now, err, errors: page.errors }));
  await ctx.close();
}

/** the deal's findings with a title */
const titled = (page, dealId, title) => page.evaluate(([d, t]) => Object.values(store.get().findings)
  .filter((f) => f.dealId === d && f.title === t && !f.deleted), [dealId, title]);

{ // #115: text typed into a new finding while Create Finding is out goes to that finding, as an open edit of it
  const { ctx, page, id } = await findingPage();
  await page.goto(`${URL}#deal-${id}`);
  await page.click('#f-new');
  await page.fill('#af-title', 'Step-in period is short');
  await page.selectOption('#af-ws', 'Legal');
  await page.fill('#af-body', 'The direct agreement gives 20 days.');
  await holdNext(page, 'CreateFinding');
  await page.click('#af-create');
  await page.fill('#af-title', 'Step-in period is too short');
  await page.fill('#af-body', 'The direct agreement gives 20 days; lenders asked for 60.');
  await page.evaluate(() => window.resume());
  await page.waitForSelector('#fe-title', { timeout: 5000 }).catch(() => {});
  const made = await titled(page, id, 'Step-in period is short');
  const opened = await page.evaluate(() => ({
    hash: location.hash, title: document.querySelector('#fe-title')?.value ?? null,
    body: document.querySelector('#fe-body')?.innerText.trim() ?? null, form: !!document.querySelector('#af-title'),
  }));
  const onIt = made.length === 1 && opened.hash.endsWith(made[0].id);
  say('#115 the finding is made as sent, and its page opens in Edit with what was typed since',
    onIt && opened.title === 'Step-in period is too short'
    && opened.body === 'The direct agreement gives 20 days; lenders asked for 60.' && !page.errors.length,
    JSON.stringify({ made: made.length, opened, errors: page.errors }));
  if (onIt) await page.click('#fe-save');
  await page.waitForSelector('#fe-title', { state: 'detached', timeout: 5000 }).catch(() => {});
  const after = made.length ? await page.evaluate((f) => store.get().findings[f], made[0].id) : null;
  const all = await page.evaluate((d) => Object.values(store.get().findings).filter((f) => f.dealId === d).length, id);
  // a new form on the Findings page starts empty: the later text went to the finding, not back into the form
  await page.goto(`${URL}#deal-${id}`);
  await page.click('#f-new');
  const fresh = await page.evaluate(() => document.querySelector('#af-title').value);
  say('#115 one Save puts the later text on that same finding, and no second finding is made',
    after?.title === 'Step-in period is too short' && after.body.join() === 'The direct agreement gives 20 days; lenders '
    + 'asked for 60.' && all === 4 && fresh === '' && !page.errors.length,
    JSON.stringify({ after: after && { title: after.title, body: after.body }, all, fresh, errors: page.errors }));
  // control: nothing typed during Create closes the form on the Findings page, as before
  await page.fill('#af-title', 'Deposit not posted');
  await page.selectOption('#af-ws', 'Tax');
  await page.click('#af-create');
  await page.waitForSelector('#af-title', { state: 'detached', timeout: 5000 }).catch(() => {});
  const stayed = await page.evaluate(() => ({ hash: location.hash, form: !!document.querySelector('#af-title') }));
  say('#115 a Create with nothing typed during it closes the form and stays on Findings',
    stayed.hash === `#deal-${id}` && !stayed.form && (await titled(page, id, 'Deposit not posted')).length === 1,
    JSON.stringify(stayed));
  await ctx.close();
}

/** opens an answer's Add as question ('q') or Add as finding ('f') card under the answer at `nth` */
const openAdd = async (page, which, nth = 0) => {
  const name = which === 'q' ? 'Add as question' : 'Add as finding';
  await page.click(`.msgs .ai >> nth=${nth} >> .acts button[aria-label="${name}"]`);
  await page.waitForSelector(which === 'q' ? '#aq-text' : '#af-title');
};
/** what an open card holds */
const cardHolds = (page, which) => page.evaluate((w) => ({
  text: document.querySelector(w === 'q' ? '#aq-text' : '#af-title')?.value ?? null,
  ws: document.querySelector(w === 'q' ? '#aq-ws' : '#af-ws')?.value ?? null,
}), which);
/** asks the deal a question and waits for the answer at `nth` */
const ask = async (page, words, nth) => {
  await page.fill('#pcomposer textarea, #hask', words);
  await page.keyboard.press('Enter');
  await page.waitForSelector(`.msgs .ai:not(.pending):not(.failed) >> nth=${nth}`, { timeout: 15000 });
};

{ // #51: an answer's Add as question and Add as finding cards keep what was typed on Escape, on leaving and on reload;
  // Cancel and a save clear it; each answer keeps its own
  const { ctx, page, id } = await findingPage();
  await page.goto(`${URL}#deal-${id}`);
  await page.waitForSelector('#hask');
  await ask(page, 'What are the three biggest issues?', 0);
  await ask(page, 'What does the credit agreement say about the lock-up?', 1);
  const chat = await page.evaluate(() => location.hash);
  const QUESTION = 'Negotiated diligence question the banker typed';
  await openAdd(page, 'q');
  const proposed = await cardHolds(page, 'q');
  await page.fill('#aq-text', QUESTION);
  await page.selectOption('#aq-ws', 'Antitrust & FDI');
  await page.keyboard.press('Escape');
  await openAdd(page, 'q');
  const afterEsc = await cardHolds(page, 'q');
  await page.goto(`${URL}#deal-${id}`);
  await page.goto(URL + chat);
  await page.reload();
  await page.waitForSelector('.msgs .ai:not(.pending) >> nth=1');
  await openAdd(page, 'q');
  const afterReload = await cardHolds(page, 'q');
  const want = { text: QUESTION, ws: 'Antitrust & FDI' };
  const same = (a, b) => a.text === b.text && a.ws === b.ws;
  await page.keyboard.press('Escape');
  await openAdd(page, 'q', 1);
  const other = await cardHolds(page, 'q');
  await page.keyboard.press('Escape');
  say('#51 Add as question keeps what was typed on Escape, leaving and reload; another answer keeps its own',
    same(afterEsc, want) && same(afterReload, want) && other.text !== QUESTION && !page.errors.length,
    JSON.stringify({ proposed, afterEsc, afterReload, other, errors: page.errors }));
  await openAdd(page, 'q');
  await page.click('.addq .btn:not(.pri)');
  await openAdd(page, 'q');
  const afterCancel = await cardHolds(page, 'q');
  await page.fill('#aq-text', QUESTION);
  await page.selectOption('#aq-ws', 'Antitrust & FDI');
  await page.click('#aq-log');
  await page.waitForSelector('#aq-text', { state: 'detached' });
  await openAdd(page, 'q');
  const afterLog = await cardHolds(page, 'q');
  await page.keyboard.press('Escape');
  say('#51 Cancel and Log Question clear what Add as question kept',
    same(afterCancel, proposed) && same(afterLog, proposed) && !page.errors.length,
    JSON.stringify({ proposed, afterCancel, afterLog, errors: page.errors }));
  // Add as finding: the same, and typing during Create Finding goes to the finding made (#115's decision)
  const TITLE = 'Banker customized finding title';
  await openAdd(page, 'f');
  const generated = await cardHolds(page, 'f');
  await page.fill('#af-title', TITLE);
  await page.selectOption('#af-ws', 'Legal');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForSelector('.msgs .ai:not(.pending) >> nth=1');
  await openAdd(page, 'f');
  const keptF = await cardHolds(page, 'f');
  await page.click('.addf .btn:not(.pri)');
  await openAdd(page, 'f');
  const clearedF = await cardHolds(page, 'f');
  say('#51 Add as finding keeps its title and workstream on Escape and reload; Cancel clears them',
    same(keptF, { text: TITLE, ws: 'Legal' }) && same(clearedF, generated) && !page.errors.length,
    JSON.stringify({ generated, keptF, clearedF, errors: page.errors }));
  await page.fill('#af-title', TITLE);
  await page.selectOption('#af-ws', 'Legal');
  await holdNext(page, 'CreateFinding');
  await page.click('#af-create');
  await page.fill('#af-title', 'Retitled while it saved');
  await page.evaluate(() => window.resume());
  await page.waitForSelector('#af-title', { state: 'detached', timeout: 5000 }).catch(() => {});
  const made = await titled(page, id, TITLE);
  await openAdd(page, 'f');
  const nextOpen = await cardHolds(page, 'f');
  await page.keyboard.press('Escape');
  if (made.length) await page.goto(`${URL}#finding-${id}-${made[0].id}`);
  await page.waitForSelector('#fe-title', { timeout: 5000 }).catch(() => {});
  const edit = await page.evaluate(() => document.querySelector('#fe-title')?.value ?? null);
  say('#51 typing during Add as finding\'s Create goes to the finding made, as an open edit; the card starts afresh',
    made.length === 1 && edit === 'Retitled while it saved' && same(nextOpen, generated) && !page.errors.length,
    JSON.stringify({ made: made.length, edit, nextOpen, errors: page.errors }));
  await ctx.close();
}

{ // #340: a question being typed on a finding's page stays in sight, kept and editable, when the finding is deleted
  const { ctx, page, id, fid } = await findingPage();
  await page.click('#f-ask');
  await page.fill('#f-ask-text', 'Half-typed question');
  await run(page, 'DeleteFinding', { dealId: id, findingId: fid });
  await page.waitForSelector('#gone');
  const seen = () => page.evaluate(() => ({
    text: document.querySelector('#f-ask-text')?.value ?? null,
    logOff: document.querySelector('#f-ask-log')?.disabled ?? null,
    why: document.querySelector('#f-ask-log')?.title ?? null,
    linked: document.querySelector('.clink')?.textContent ?? null,
  }));
  const deleted = await seen();
  if (deleted.text !== null) await page.fill('#f-ask-text', 'Half-typed question, finished after the delete');
  await page.reload();
  await page.waitForSelector('#gone');
  const reloaded = await seen();
  await page.click('#gone-restore');
  await page.waitForSelector('#f-edit');
  const restored = await page.evaluate(() => document.querySelector('#f-ask-text')?.value ?? null);
  say('#340 a question being typed stays in sight on the deleted finding\'s page, and Restore brings it back',
    deleted.text === 'Half-typed question' && deleted.logOff && deleted.why === 'This finding was deleted'
    && /^Linked to “.+”$/.test(deleted.linked) && reloaded.text === 'Half-typed question, finished after the delete'
    && restored === reloaded.text && !page.errors.length,
    JSON.stringify({ deleted, reloaded, restored, errors: page.errors }));
  // deleted on another PC without seeing this one: the finding shows its two versions, and the question stays in sight
  await page.evaluate((f) => __peer.remove(f, { by: 'jdoe', from: 'PC B' }), fid);
  await page.waitForFunction((f) => !!store.get().conflicts[f], fid);
  await page.waitForTimeout(300);
  const twoVersions = await seen();
  if (twoVersions.text !== null) await page.click('#f-ask-cancel');
  const cleared = await seen();
  // deleted with nothing being typed: the page that says so shows no card
  const other = await page.evaluate(([d, f]) => Object.values(store.get().findings)
    .find((x) => x.dealId === d && x.id !== f).id, [id, fid]);
  await page.goto(`${URL}#finding-${id}-${other}`);
  await page.waitForSelector('#f-edit');
  await run(page, 'DeleteFinding', { dealId: id, findingId: other });
  await page.waitForSelector('#gone');
  const none = await seen();
  say('#340 in two versions the question stays in sight; Cancel clears it; nothing typed shows no card',
    twoVersions.text === restored && cleared.text === null && none.text === null && !page.errors.length,
    JSON.stringify({ twoVersions, cleared, none, errors: page.errors }));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
