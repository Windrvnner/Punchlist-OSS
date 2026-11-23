// #771: a finding's edit, its New Finding form, or an answer's Add as card closed (Escape, or leaving the page) and
// opened again while its save is out. What is typed in the form opened again is kept, in one place only: still in the
// form, or, after Create, in an open edit of the finding made, never both. At deal scale: a log of 2,000 questions.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { URL, ask, cardHolds, findingPage, holdNext, openAdd, titleOf, titled } from './cardPage.mjs';
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note);
};
const browser = await launchChrome();
openOnFindings(browser);

/** what the page shows: an open form's title, the refusal beside Save, and whether Save or Create is off */
const formState = (page) => page.evaluate(() => ({
  title: document.querySelector('#fe-title, #af-title')?.value ?? null,
  err: document.querySelector('#fe-err')?.textContent ?? '',
  off: document.querySelector('#fe-save, #af-create')?.disabled ?? null,
}));
/** waits for a held save to land on the finding */
const landed = (page, fid, title) =>
  page.waitForFunction(([f, t]) => store.get().findings[f].title === t, [fid, title]);
/** the deal's live findings */
const findingCount = (page, dealId) => page.evaluate((d) => Object.values(store.get().findings)
  .filter((f) => f.dealId === d && !f.deleted).length, dealId);

{ // a finding's edit: Escape or leaving during Save, open it again, type, the save lands
  const { ctx, page, id, fid } = await findingPage(browser);
  const hash = await page.evaluate(() => location.hash);
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Sent, then Escape');
  await holdNext(page, 'EditFinding');
  await page.click('#fe-save');
  await page.keyboard.press('Escape');
  await page.click('#f-edit');
  const whileOut = await formState(page);
  await page.fill('#fe-title', 'Typed after opening again');
  await page.evaluate(() => window.resume());
  await landed(page, fid, 'Sent, then Escape');
  await page.waitForTimeout(300);
  const afterLanding = await formState(page);
  if (afterLanding.title !== null) await page.click('#fe-save');
  await page.waitForSelector('#fe-title', { state: 'detached', timeout: 5000 }).catch(() => {});
  const saved = { title: await titleOf(page, fid), form: await formState(page) };
  say('an edit opened again during a save keeps what is typed in it, and its Save writes it unrefused',
    whileOut.off === true && afterLanding.title === 'Typed after opening again' && saved.title === afterLanding.title
    && saved.form.title === null && !page.errors.length,
    JSON.stringify({ whileOut, afterLanding, saved, errors: page.errors }));
  // leaving the finding during Save and coming back: what is typed there, before and after it lands, saves unrefused
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Sent, then left');
  await holdNext(page, 'EditFinding');
  await page.click('#fe-save');
  await page.goto(`${URL}#deal-${id}`);
  await page.goto(URL + hash);
  await page.waitForSelector('#fe-title');
  await page.fill('#fe-title', 'Typed on coming back');
  await page.evaluate(() => window.resume());
  await landed(page, fid, 'Sent, then left');
  await page.waitForTimeout(300);
  const back = await formState(page);
  if (back.title !== null) await page.fill('#fe-title', 'Typed on coming back, and after it landed');
  if (back.title !== null) await page.click('#fe-save');
  await page.waitForSelector('#fe-title', { state: 'detached', timeout: 5000 }).catch(() => {});
  const afterBack = { title: await titleOf(page, fid), form: await formState(page) };
  say('an edit left during a save keeps what is typed on coming back, and saves it unrefused',
    back.title === 'Typed on coming back' && afterBack.title === 'Typed on coming back, and after it landed'
    && afterBack.form.title === null && !page.errors.length, JSON.stringify({ back, afterBack, errors: page.errors }));
  // refused: the held save meets a change made elsewhere; the edit opened again says so and keeps its typing
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Sent, then refused');
  await holdNext(page, 'EditFinding');
  await page.click('#fe-save');
  await page.keyboard.press('Escape');
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Typed before the refusal');
  const elsewhere = { by: 'jdoe', from: 'PC B' };
  await page.evaluate(([f, who]) => __peer.change(f, { title: 'Retitled on the other PC' }, who), [fid, elsewhere]);
  await landed(page, fid, 'Retitled on the other PC');
  await page.evaluate(() => window.resume());
  await page.waitForSelector('#fe-err', { timeout: 5000 }).catch(() => {});
  const refused = await formState(page);
  say('an edit opened again during a save that is refused says why and keeps its typing',
    refused.title === 'Typed before the refusal' && /changed elsewhere/.test(refused.err) && !page.errors.length,
    JSON.stringify({ refused, errors: page.errors }));
  await page.click('#fe-cancel').catch(() => {});
  // control: opened again and nothing typed, the save landing closes it as before
  await page.click('#f-edit');
  await page.fill('#fe-title', 'Sent, nothing typed after');
  await holdNext(page, 'EditFinding');
  await page.click('#fe-save');
  await page.keyboard.press('Escape');
  await page.click('#f-edit');
  await page.evaluate(() => window.resume());
  await landed(page, fid, 'Sent, nothing typed after');
  const closed = await page.waitForSelector('#fe-title', { state: 'detached', timeout: 5000 })
    .then(() => true, () => false);
  say('an edit opened again with nothing typed closes when the save lands', closed && !page.errors.length,
    JSON.stringify({ closed, errors: page.errors }));
  await ctx.close();
}

{ // New Finding: Escape or leaving during Create, open the form again, type, Create lands
  const { ctx, page, id } = await findingPage(browser);
  const before = await findingCount(page, id);
  const deal = `${URL}#deal-${id}`;
  await page.goto(deal);
  /** Create sent from a filled form, then the form closed by `close` and opened again, and `typed` put in it */
  const reopenDuringCreate = async (title, close, typed) => {
    await page.click('#f-new');
    await page.fill('#af-title', title);
    await page.selectOption('#af-ws', 'Legal');
    await holdNext(page, 'CreateFinding');
    await page.click('#af-create');
    await close();
    if (!await page.$('#af-title')) await page.click('#f-new');
    const whileOut = await formState(page);
    await page.fill('#af-title', typed);
    await page.evaluate(() => window.resume());
    await page.waitForSelector('#af-title', { state: 'detached', timeout: 5000 }).catch(() => {});
    const made = await titled(page, id, title);
    await page.waitForSelector('#fe-title', { timeout: 5000 }).catch(() => {});
    const edit = await formState(page);
    await page.goto(deal);
    await page.click('#f-new');
    const fresh = await formState(page);
    await page.keyboard.press('Escape');
    return { whileOut, made: made.length, edit: edit.title, onIt: made.length ? edit.title !== null : false, fresh };
  };
  const escaped = await reopenDuringCreate('Made with the form closed', () => page.keyboard.press('Escape'),
    'Typed in the form opened again');
  say('New Finding opened again during Create: what is typed goes to the finding made, and the form starts empty',
    escaped.whileOut.off === true && escaped.made === 1 && escaped.edit === 'Typed in the form opened again'
    && escaped.fresh.title === '' && !page.errors.length, JSON.stringify({ escaped, errors: page.errors }));
  const left = await reopenDuringCreate('Made while away', async () => {
    await page.goto(`${URL}#qa-${id}`);
    await page.goto(deal);
  }, 'Typed after coming back');
  say('New Finding left during Create: what is typed on coming back goes to the finding made, once',
    left.made === 1 && left.edit === 'Typed after coming back' && left.fresh.title === '' && !page.errors.length,
    JSON.stringify({ left, errors: page.errors }));
  // Cancel during Create, then a new form typed in: Create lands as sent and leaves that form alone
  await page.click('#f-new');
  await page.fill('#af-title', 'Made, then cancelled');
  await page.selectOption('#af-ws', 'Tax');
  await holdNext(page, 'CreateFinding');
  await page.click('#af-create');
  await page.click('#af-cancel');
  await page.click('#f-new');
  await page.fill('#af-title', 'A different finding');
  await page.selectOption('#af-ws', 'Tax');
  await page.evaluate(() => window.resume());
  await page.waitForFunction((d) => Object.values(store.get().findings)
    .some((f) => f.dealId === d && f.title === 'Made, then cancelled'), id);
  await page.waitForTimeout(300);
  const kept = await formState(page);
  await page.click('#af-cancel').catch(() => {});
  const count = await findingCount(page, id);
  say('Cancel during Create leaves a form opened since as typed; each Create made one finding',
    kept.title === 'A different finding' && kept.off === false && count === before + 3 && !page.errors.length,
    JSON.stringify({ kept, before, count, errors: page.errors }));
  await ctx.close();
}

{ // an answer's Add as question and Add as finding cards closed and opened again while the save is out
  const { ctx, page, id } = await findingPage(browser);
  await page.goto(`${URL}#deal-${id}`);
  await page.waitForSelector('#hask');
  await ask(page, 'What are the three biggest issues?', 0);
  await openAdd(page, 'q');
  await page.fill('#aq-text', 'Logged, then Escape');
  await page.selectOption('#aq-ws', 'Legal');
  await holdNext(page, 'CreateQuestion');
  await page.click('#aq-log');
  await page.keyboard.press('Escape');
  await openAdd(page, 'q');
  await page.fill('#aq-text', 'Typed in the card opened again');
  await page.evaluate(() => window.resume());
  await page.waitForFunction(() => Object.values(store.get().questions).some((q) => q.text === 'Logged, then Escape'));
  await page.waitForTimeout(300);
  const question = await cardHolds(page, 'q');
  await page.keyboard.press('Escape');
  say('Add as question opened again during Log keeps what is typed in it',
    question.text === 'Typed in the card opened again' && !page.errors.length,
    JSON.stringify({ question, errors: page.errors }));
  await openAdd(page, 'f');
  await page.fill('#af-title', 'Made from the answer, then Escape');
  await page.selectOption('#af-ws', 'Legal');
  await holdNext(page, 'CreateFinding');
  await page.click('#af-create');
  await page.keyboard.press('Escape');
  await openAdd(page, 'f');
  await page.fill('#af-title', 'Retitled in the card opened again');
  await page.evaluate(() => window.resume());
  await page.waitForSelector('#af-title', { state: 'detached', timeout: 5000 }).catch(() => {});
  const made = await titled(page, id, 'Made from the answer, then Escape');
  const card = await page.evaluate(() => !!document.querySelector('#af-title'));
  if (made.length) await page.goto(`${URL}#finding-${id}-${made[0].id}`);
  await page.waitForSelector('#fe-title', { timeout: 5000 }).catch(() => {});
  const edit = await formState(page);
  say('Add as finding opened again during Create: what is typed goes to the finding made, and the card closes',
    made.length === 1 && !card && edit.title === 'Retitled in the card opened again' && !page.errors.length,
    JSON.stringify({ made: made.length, card, edit, errors: page.errors }));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
