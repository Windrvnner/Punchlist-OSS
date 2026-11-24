// Ask the counterparty from a finding (#2; linking design, sections 6 and 13): a finding names the checklist item
// that raised it and lists the questions asked about it or its item; Ask the counterparty logs a question linked to
// both; what is typed is never lost; and an open question on the Q&A page says what it was asked for. At deal scale:
// a log of 2,000 questions beside the ones asked here.
import { launchChrome } from './chrome.mjs';
import { holdNext } from './cardPage.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note);
};
const browser = await launchChrome();
const LOCKUP = 'Lock-up ratio in the credit agreement draft differs from the term sheet';
const ITEM = 'Lock-up ratio matches the term sheet';
const ASKED = 'Has the sponsor agreed to the 1.30x lock-up ratio in the signed term sheet?';
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

/** A deal whose first pass has run, with a Q&A log of 2,000 questions, opened on the lock-up finding's page. */
async function findingPage(scheme = 'light') {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 }, colorScheme: scheme });
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
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  await run(page, 'ImportQuestions', { dealId: id, mode: 'append', rows: logRows(N) });
  await page.evaluate(() => store.ui({ toasts: [] }));
  const f = await page.evaluate((t) => Object.values(store.get().findings).find((x) => x.title === t), LOCKUP);
  await page.goto(`${URL}#finding-${id}-${f.id}`);
  await page.waitForSelector('#f-ask');
  return { ctx, page, id, f };
}

/** the questions linked to a finding or an item, oldest first */
const linked = (page) => page.evaluate(() => Object.values(store.get().questions)
  .filter((q) => q.linkedFinding || q.linkedItem).sort((a, b) => a.n - b.n));
/** the text of an element, or undefined */
const textOf = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent, sel);
/** whether an element is on the page */
const shown = (page, sel) => page.evaluate((s) => !!document.querySelector(s), sel);
const focusedId = (page) => page.evaluate(() => document.activeElement?.id);
/** whether Ask the counterparty and its card are on the page, and where the focus is */
const askState = async (page) => ({
  ask: await shown(page, '#f-ask'), card: await shown(page, '#f-ask-text'), focus: await focusedId(page),
});
/** the time in the page from a click to the next frame, as the person would feel it */
const clickTimed = (page, sel) => page.evaluate((s) => new Promise((done) => {
  const start = performance.now();
  document.querySelector(s).click();
  requestAnimationFrame(() => setTimeout(() => done(performance.now() - start), 0));
}), sel);
/** opens a question in the Q&A panel and reads what it says it was asked for */
async function askedFor(page, questionId) {
  await page.evaluate((q) => store.ui({ selectedQuestion: q }), questionId);
  await page.waitForSelector('.qpanel');
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const el = document.getElementById('q-for');
    return el ? { text: el.textContent, href: el.querySelector('a').getAttribute('href') } : null;
  });
}

{ // the finding names its item and links to it; Ask logs a question linked to the finding and the item, in its
  // workstream
  const { ctx, page, id, f } = await findingPage();
  await page.waitForSelector('#f-item');
  const item = await textOf(page, '#f-item');
  const open = await clickTimed(page, '#f-ask');
  await page.fill('#f-ask-text', ASKED);
  await page.click('#f-ask-log');
  await page.waitForSelector('#f-asked');
  await page.waitForTimeout(100);
  const qs = await linked(page);
  const asked = await textOf(page, '#f-asked');
  const back = await askState(page);
  console.log(`  at ${N} questions: Ask opens in ${Math.round(open)} ms`);
  const q = qs[0];
  const linksBoth = qs.length === 1 && q.linkedFinding === f.id && !!q.linkedItem && q.workstream === f.workstream;
  say('a finding names its checklist item, and Ask logs a question linked to the finding and the item',
    item === ITEM && linksBoth && q.n === N + 1 && asked === `Q${N + 1}open${ASKED}`
      && back.ask && !back.card && back.focus === 'f-ask' && open < 100 && !page.errors.length,
    JSON.stringify({ item, qs, asked, back, open, errors: page.errors }));
  // the item's link opens the deal's Checklist with the item open
  await page.click('#f-item a');
  await page.waitForSelector('#ck-detail');
  const pane = { hash: await page.evaluate(() => location.hash), title: await textOf(page, '#ck-detail .cktitle'),
    asked: await textOf(page, '#ck-asked') };
  say('the checklist item opens on the Checklist, which lists the question asked from the finding',
    pane.hash === `#checklist-${id}` && pane.title === ITEM && pane.asked?.includes(`Q${N + 1}`) && !page.errors.length,
    JSON.stringify(pane));
  await ctx.close();
}

{ // a question asked about the finding's item (as a gap, before it was flagged) is listed under the finding too
  const { ctx, page, id } = await findingPage();
  await page.waitForSelector('#f-item');
  const itemId = await page.evaluate(([d, t]) => store.get().checklists[d].find((r) => r.text === t).id, [id, ITEM]);
  await run(page, 'CreateQuestion', { dealId: id, text: 'Which ratio was agreed?', linkedItem: itemId });
  await page.waitForSelector('#f-asked');
  const asked = await textOf(page, '#f-asked');
  say('a question asked about the finding\'s item is listed under the finding',
    asked === `Q${N + 1}openWhich ratio was agreed?` && !page.errors.length, JSON.stringify({ asked }));
  await ctx.close();
}

{ // lost work first: a question being typed comes back after leaving the page; Escape sets it aside, and Ask brings
  // it back
  const { ctx, page, id, f } = await findingPage();
  const typed = 'Please confirm the agreed lock-up ratio.';
  await page.click('#f-ask');
  await page.fill('#f-ask-text', typed);
  await page.goto(`${URL}#qa-${id}`);
  await page.waitForSelector('.md .li');
  await page.goto(`${URL}#finding-${id}-${f.id}`);
  await page.waitForSelector('#f-ask-text');
  const kept = await page.inputValue('#f-ask-text');
  await page.press('#f-ask-text', 'Escape');
  await page.waitForTimeout(100);
  const aside = await askState(page);
  await page.click('#f-ask');
  const again = await page.inputValue('#f-ask-text');
  await page.click('#f-ask-cancel');
  await page.click('#f-ask');
  const fresh = await page.inputValue('#f-ask-text');
  const setAside = !aside.card && aside.ask && aside.focus === 'f-ask';
  say('a question being typed is kept across pages, set aside by Escape and cleared only by Cancel',
    kept === typed && setAside && again === typed && fresh === '' && !page.errors.length,
    JSON.stringify({ kept, aside, again, fresh, errors: page.errors }));
  await ctx.close();
}

{ // a question still saving on one finding never touches the question being typed on another: the
  // save is slowed down, as on a slow shared folder, and the person goes back to the other finding before it lands
  const { ctx, page, id, f } = await findingPage();
  const other = await page.evaluate((t) => Object.values(store.get().findings).find((x) => x.title !== t).id, LOCKUP);
  const kept = 'A question on the other finding that must survive';
  await page.goto(`${URL}#finding-${id}-${other}`);
  await page.waitForSelector('#f-ask');
  await page.click('#f-ask');
  await page.fill('#f-ask-text', kept);
  await page.goto(`${URL}#finding-${id}-${f.id}`);
  await page.waitForSelector('#f-ask');
  await page.evaluate(() => {
    const dispatch = store.dispatch.bind(store);
    store.dispatch = async (...args) => {
      if (args[0]?.name === 'CreateQuestion') await new Promise((done) => setTimeout(done, 1500));
      return dispatch(...args);
    };
  });
  await page.click('#f-ask');
  await page.fill('#f-ask-text', 'Which ratio was agreed?');
  await page.click('#f-ask-log');
  await page.goto(`${URL}#finding-${id}-${other}`);
  await page.waitForSelector('#f-ask-text');
  const during = await page.evaluate(() => ({ text: document.getElementById('f-ask-text').value,
    off: document.getElementById('f-ask-log').disabled }));
  const saved = () => Object.values(store.get().questions).some((q) => q.linkedFinding);
  await page.waitForFunction(saved, null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById('f-ask-text')?.value);
  say('a question still saving on one finding never touches the one being typed on another',
    during.text === kept && !during.off && after === kept && !page.errors.length,
    JSON.stringify({ during, after, errors: page.errors }));
  await ctx.close();
}

{ // back on the same finding before its save lands: Log stays off, and words typed meanwhile are
  // kept once the question lands, with the question logged once
  const { ctx, page, id, f } = await findingPage();
  const other = await page.evaluate((t) => Object.values(store.get().findings).find((x) => x.title !== t).id, LOCKUP);
  await page.evaluate(() => {
    const dispatch = store.dispatch.bind(store);
    store.dispatch = async (...args) => {
      if (args[0]?.name === 'CreateQuestion') await new Promise((done) => setTimeout(done, 1500));
      return dispatch(...args);
    };
  });
  await page.click('#f-ask');
  await page.fill('#f-ask-text', 'Which ratio was agreed?');
  await page.click('#f-ask-log');
  await page.goto(`${URL}#finding-${id}-${other}`);
  await page.waitForSelector('#f-ask');
  await page.goto(`${URL}#finding-${id}-${f.id}`);
  await page.waitForSelector('#f-ask-text');
  const during = await page.evaluate(() => document.getElementById('f-ask-log').disabled);
  await page.type('#f-ask-text', ' And when?');
  const saved = () => Object.values(store.get().questions).some((q) => q.linkedFinding);
  await page.waitForFunction(saved, null, { timeout: 8000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.getElementById('f-ask-text')?.value);
  await page.goto(`${URL}#finding-${id}-${other}`);
  await page.waitForSelector('#f-ask');
  await page.goto(`${URL}#finding-${id}-${f.id}`);
  await page.waitForSelector('#f-ask-text', { timeout: 3000 }).catch(() => {});
  const back = await page.evaluate(() => document.getElementById('f-ask-text')?.value);
  const qs = await linked(page);
  const typed = 'Which ratio was agreed? And when?';
  say('back on a finding whose question is still saving, Log is off and words typed meanwhile are kept',
    during && after === typed && back === typed && qs.length === 1 && !page.errors.length,
    JSON.stringify({ during, after, back, qs: qs.length, errors: page.errors }));
  await ctx.close();
}

{ // #843: a new check raises another finding on the same item while the cancelled card's Log is still out.
  const { ctx, page, id, f } = await findingPage();
  const words = 'Please confirm the calculation in the executed agreement.';
  const title = 'Distribution test requires two completed measurement periods';
  const second = await page.evaluate(([first, title]) => __peer.add(first, { title }), [f.id, title]);
  await page.waitForFunction((fid) => !!store.get().findings[fid], second);
  await page.click('#f-item a');
  const itemId = await page.locator('#ck-rows .ckrow.on').getAttribute('data-item');
  const reopen = async () => {
    await page.click('#ck-close');
    await page.click(`#ck-rows [data-item="${itemId}"]`);
  };
  const draft = () => page.evaluate(() => document.querySelector('#ck-ask-text')?.value);
  const targets = async () => (await linked(page)).filter((q) => q.text === words).map((q) => q.linkedFinding);
  await page.click('#ck-ask');
  await page.fill('#ck-ask-text', words);
  await holdNext(page, 'CreateQuestion');
  await page.click('#ck-ask-log');
  await page.click('#ck-ask-cancel');
  await page.evaluate(async ([dealId, itemId, findingId]) => {
    const ai = store.services.ai;
    const checklist = ai.checklist.bind(ai);
    ai.checklist = async (id) => {
      const result = await checklist(id);
      if (result.ok) result.value = result.value.map((row) => row.id === itemId ? { ...row, findingId } : row);
      return result;
    };
    await store.refreshChecklist(dealId);
  }, [id, itemId, second]);
  await page.click('#ck-ask');
  await page.fill('#ck-ask-text', words);
  const busy = await page.isDisabled('#ck-ask-log');
  await page.evaluate(() => window.resume());
  await page.waitForSelector('#ck-asked');
  await page.waitForFunction(() => !document.querySelector('#ck-ask-log')?.disabled);
  const after = await draft();
  await reopen();
  const kept = await draft();
  const linkedTo = await textOf(page, '#ck-detail .clink');
  const saved = await targets();
  say('a cancelled Log saves the first question and keeps identical words for the second finding',
    busy && after === words && kept === words && linkedTo === `Linked to “${title}”` && saved.join() === f.id,
    JSON.stringify({ busy, after, kept, linkedTo, saved }));
  await holdNext(page, 'CreateQuestion');
  await page.click('#ck-ask-log');
  await reopen();
  const pending = await page.isDisabled('#ck-ask-log');
  await page.evaluate(() => window.resume());
  await page.waitForSelector('#ck-ask');
  const both = await targets();
  say('logging the kept question settles its reopened card and saves it against the second finding',
    pending && both.join() === [f.id, second].join() && !page.errors.length,
    JSON.stringify({ pending, both, errors: page.errors }));
  await ctx.close();
}

{ // The deal is recovered while Log is writing. Cancel in the recovered finding still belongs to that save (#843).
  const { ctx, page, id } = await findingPage();
  const words = 'Which debt service period applies under the signed distribution test?';
  const original = page.url();
  await page.click('#f-ask');
  await page.fill('#f-ask-text', words);
  await page.evaluate(() => {
    const repo = store.services.repo;
    const transaction = repo.transaction.bind(repo);
    repo.transaction = async (input) => {
      if (!input.writes.some((write) => write.kind === 'question')) return transaction(input);
      repo.transaction = transaction;
      await new Promise((resume) => { window.resume = resume; });
      const result = await transaction(input);
      window.questionSaved = result.ok;
      return result;
    };
  });
  await page.click('#f-ask-log');
  await page.waitForFunction(() => !!window.resume);
  await page.evaluate((dealId) => __peer.deleteDeal(dealId, {}, true), id);
  await page.waitForFunction((old) => location.href !== old && location.hash.startsWith('#finding-'), original);
  await page.waitForSelector('#f-ask-text');
  const recovered = page.url();
  const copy = await page.evaluate(() => store.get().ui.route.dealId);
  const inherited = await page.inputValue('#f-ask-text');
  const busy = await page.isDisabled('#f-ask-log');
  await page.click('#f-ask-cancel');
  await page.click('#f-ask');
  await page.fill('#f-ask-text', words);
  await page.evaluate(() => window.resume());
  await page.waitForFunction(() => window.questionSaved === true);
  await page.waitForSelector('#f-ask-log:enabled');
  await page.goto(`${URL}#qa-${copy}`);
  await page.waitForSelector('.md .li');
  await page.goto(recovered);
  await page.waitForSelector('#f-ask-text, #f-ask');
  const kept = await page.evaluate(() => document.querySelector('#f-ask-text')?.value);
  say('a pending Log follows its recovered finding and leaves a replacement question there after Cancel',
    copy !== id && inherited === words && busy && kept === words && !page.errors.length,
    JSON.stringify({ inherited, busy, kept, errors: page.errors }));
  await ctx.close();
}

{ // closed while a question is typed (here or on another PC): the card stays with its text and Log says why it is off;
  // a closed finding offers no Ask
  const { ctx, page, id, f } = await findingPage();
  await page.click('#f-ask');
  await page.fill('#f-ask-text', 'Which ratio was agreed?');
  await run(page, 'SetFindingStatus', { dealId: id, findingId: f.id, status: 'closed' });
  const logOff = () => document.getElementById('f-ask-log')?.disabled;
  await page.waitForFunction(logOff, null, { timeout: 5000 }).catch(() => {});
  const card = await page.evaluate(() => {
    const log = document.getElementById('f-ask-log');
    return { text: document.getElementById('f-ask-text')?.value, off: log?.disabled, why: log?.title };
  });
  await page.click('#f-ask-cancel');
  const after = { ask: await shown(page, '#f-ask'), item: await shown(page, '#f-item') };
  const qs = await linked(page);
  const cardKept = card.text === 'Which ratio was agreed?' && card.off && card.why === 'This finding is closed';
  say('a finding closed meanwhile keeps the typed question, and Log says why it is off; a closed finding offers no Ask',
    cardKept && !after.ask && after.item && !qs.length && !page.errors.length,
    JSON.stringify({ card, after, qs, errors: page.errors }));
  await ctx.close();
}

{ // the question says what it was asked for: the finding, or the checklist item of a gap, each linked to its page
  const { ctx, page, id, f } = await findingPage('dark');
  await page.click('#f-ask');
  await page.fill('#f-ask-text', 'Which ratio was agreed?');
  await page.click('#f-ask-log');
  await page.waitForSelector('#f-asked');
  const gap = await page.evaluate((d) => store.get().checklists[d].find((r) => r.result === 'gap'), id);
  await run(page, 'CreateQuestion', { dealId: id, text: 'Please send the final report.', linkedItem: gap.id });
  const [onFinding, onItem] = (await linked(page)).map((q) => q.id);
  const plain = await page.evaluate(() => Object.values(store.get().questions)
    .find((q) => !q.linkedFinding && !q.linkedItem).id);
  await page.goto(`${URL}#qa-${id}`);
  await page.waitForSelector('.md .li');
  const forFinding = await askedFor(page, onFinding);
  const forNone = await askedFor(page, plain);
  const forItem = await askedFor(page, onItem);
  await page.click('#q-for a');
  await page.waitForSelector('#ck-detail');
  const opened = await textOf(page, '#ck-detail .cktitle');
  const findingSaid = forFinding?.text === `Asked for “${LOCKUP}”` && forFinding.href === `#finding-${id}-${f.id}`;
  say('a question says what it was asked for, linked to the finding or the item; one asked for neither says nothing',
    findingSaid && forItem?.text === `Asked for “${gap.text}”` && opened === gap.text && !forNone
      && !page.errors.length,
    JSON.stringify({ forFinding, forItem, forNone, opened, errors: page.errors }));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
