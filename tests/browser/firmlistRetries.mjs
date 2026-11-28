// The checklist review at deal size, with model replies held until the test releases them (#378).
async function openReview(page, workbook) {
  const agreements = ['equipment supply agreement', 'construction contract', 'interconnection agreement', 'site lease',
    'maintenance agreement', 'power purchase agreement', 'credit agreement', 'insurance policy'];
  const evidence = ['signature pages', 'schedule of payments', 'notice provisions', 'renewal terms', 'amendments',
    'assignment provisions', 'termination rights', 'insurance requirements', 'conditions to effectiveness'];
  const rows = Array.from({ length: 30 }, (_, site) => agreements.flatMap((agreement) =>
    evidence.map((detail) => `Provide the ${detail} of the ${agreement} for site ${site + 1}.`))).flat();
  rows.push('Produce the signed pages of the equipment supply agreement for site 1.',
    'Provide the equipment supply payment schedule for site 1.');
  await page.click('#u-menu');
  await page.click('#s-checklist-open');
  await page.click('#fl-import');
  await page.setInputFiles('#cl-file', workbook ? await sheetFile(page, rows, workbook) : {
    name: 'Duplicate retries.csv', mimeType: 'text/csv', buffer: Buffer.from(['Item', ...rows].join('\n')),
  });
  const next = page.locator('#cl-next');
  const retry = page.locator('#cl-retry');
  await page.uncheck('#cl-askreword');
  await page.evaluate(() => {
    const pending = [];
    window.__duplicateCalls = [];
    store.services.ai.sameMeaning = ({ items, only }) => {
      const all = only?.length === items.length && only.every((at, index) => at === index);
      window.__duplicateCalls.push({ count: items.length, only: all ? 'all' : only });
      return new Promise((resolve) => pending.push(resolve));
    };
    window.__finishDuplicates = (reply) => {
      for (const resolve of pending.splice(0)) resolve(reply);
    };
  });
  const finish = (reply) => page.evaluate(async (value) => {
    window.__finishDuplicates(value);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }, reply);
  const calls = () => page.evaluate(() => window.__duplicateCalls);
  const pair = { a: 0, b: rows.length - 2, inAgainst: false, why: 'Both request the signed pages' };
  const review = () => page.evaluate((removeAt) => ({
    reason: document.querySelector('#cl-retry')?.parentElement.textContent,
    footer: document.querySelector('#cl-line').textContent,
    pairs: document.querySelectorAll('#cl-pairs .rv-pair').length,
    kept: document.querySelector(`#cl-pairs [data-remove="${removeAt}"]`)?.checked,
    missed: document.querySelector('#cl-missed')?.textContent,
  }), pair.b);
  return { page, finish, next, retry, calls, review, pair, rows, itemCount: rows.length };
}

async function sheetFile(page, rows, { name = 'Checklist workbook.ods', first, second }) {
  await page.evaluate(({ name, rows, first, second }) => {
    const sheet = (name, item) => ({ name, grid: ['Item', item, ...rows].map((value) => [value]) });
    window.__sheets = { [name]: [sheet('Main', first), sheet('Appendix', second)] };
  }, { name, rows, first, second });
  const mimeType = 'application/vnd.oasis.opendocument.spreadsheet';
  return { name, mimeType, buffer: Buffer.alloc(0) };
}

const failed = (kind) => ({ ok: false, error: { kind, message: kind } });
const pressTwice = (control) => control.evaluate((button) => {
  button.click();
  button.click();
});

async function wholeFailure({ next, retry, finish, calls, review, itemCount }, say) {
  await next.click();
  await finish(failed('failed'));
  const initial = await review();
  await pressTwice(retry);
  await finish(failed('unreachable'));
  const whole = await review();
  const double = await calls();
  say('two Duplicates Retry presses in one frame send one full retry', double.length === 2
    && double.every(({ count }) => count === itemCount) && double[1].only === 'all', JSON.stringify(double));
  say('a wholly failed retry updates both reasons', /reply could not be used; only same wording/.test(initial.reason)
    && /could not be reached; only same wording/.test(whole.reason)
    && /could not be reached again$/.test(whole.footer) && !whole.missed, JSON.stringify(whole));
}

async function partialFailure({ page, retry, finish, review, pair }, say) {
  await retry.click();
  await finish({ ok: true, value: { pairs: [pair], missed: { kind: 'unreachable', at: [0, 1] } } });
  await page.check(`#cl-pairs [data-remove="${pair.b}"]`);
  await retry.click();
  await finish(failed('failed'));
  const partial = await review();
  say('a failed partial retry updates both reasons and keeps pairs and checked removals',
    /reply could not be used for 2 items$/.test(partial.missed) && /reply could not be used again$/.test(partial.footer)
      && partial.pairs === 1 && partial.kept, JSON.stringify(partial));

  const nextPair = { a: 1, b: pair.b + 1, inAgainst: false, why: 'Both request the payment schedule' };
  await retry.click();
  await finish({ ok: true, value: { pairs: [nextPair], missed: { kind: 'unreachable', at: [0] } } });
  const improved = await review();
  say('a partly answered retry adds its pair and reports the remaining failure',
    /could not be reached for 1 item$/.test(improved.missed) && /could not be reached again$/.test(improved.footer)
      && improved.pairs === 2 && improved.kept, JSON.stringify(improved));
}

async function overlappingRetries({ page, retry, next, finish, calls, review, pair }, say) {
  await retry.click();
  const beforeBack = await calls();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await next.waitFor();
  const waiting = await next.isDisabled() && /^Asking /.test(await page.locator('#cl-line').textContent());
  await next.evaluate((button) => button.click());
  await page.check('#cl-askreword');
  const changed = await next.isDisabled();
  await next.evaluate((button) => button.click());
  await page.uncheck('#cl-askreword');
  const afterNext = await calls();
  await finish(failed('unreachable'));
  const stayed = await next.isVisible();
  say('Next from Back sends no second duplicate request while Retry is in flight, even after changing the choices',
    stayed && waiting && changed && afterNext.length === beforeBack.length
      && JSON.stringify(beforeBack.at(-1)?.only) === '[0]',
    JSON.stringify({ waiting, changed, before: beforeBack.length, after: afterNext.length }));
  await (stayed ? next : retry).click();
  await finish({ ok: true, value: { pairs: [pair] } });
  const final = await review();
  say('a successful retry restores the import count and keeps the checked removal',
    !final.reason && !final.missed && final.pairs === 2 && final.kept
      && final.footer === 'Import 2,161 items · 1 removed',
    JSON.stringify(final));
}

async function backDuringWording({ page, next, finish, calls }, say) {
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const wording = page.locator('#cl-reword-retry');
  await back.click();
  await page.check('#cl-askreword');
  await page.evaluate((failure) => {
    store.services.ai.reword = () => Promise.resolve(failure);
  }, failed('failed'));
  const beforeFresh = (await calls()).length;
  await pressTwice(next);
  const afterFresh = await calls();
  await finish(failed('failed'));
  say('two Next presses in one frame send one duplicate request for changed review options',
    afterFresh.length === beforeFresh + 1 && afterFresh.at(-1).only === undefined,
    JSON.stringify({ before: beforeFresh, after: afterFresh.length }));
  await page.evaluate(() => {
    store.services.ai.reword = () => new Promise((resolve) => { window.__finishWording = resolve; });
  });
  await wording.click();
  const before = (await calls()).length;
  await back.click();
  const waiting = await next.isDisabled() && /^Asking /.test(await page.locator('#cl-line').textContent());
  await next.evaluate((button) => button.click());
  const after = (await calls()).length;
  await page.evaluate(() => window.__finishWording({
    ok: true, value: [{ at: 0, text: 'Old wording reply', why: 'Overtaken by Back' }],
  }));
  await next.click();
  await finish(failed('failed'));
  say('Next waits for Wording Retry when duplicates also failed, and Back discards the old wording reply',
    waiting && before === after && await wording.isVisible(), JSON.stringify({ waiting, before, after }));
}

async function replaceDuringRetry({ page, next, retry, finish, calls, rows }, say) {
  await retry.click();
  const before = (await calls()).length;
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.uncheck('#cl-askreword');
  await page.click('#cl-back');
  const pasted = 'Provide the final interconnection study.';
  await page.fill('#cl-paste', `- ${pasted}`);
  await page.click('#cl-paste-next');
  await page.locator('.imprev').getByText(`- ${pasted}`, { exact: true }).waitFor();
  await page.click('#cl-back');
  const first = 'Provide the equipment acceptance certificate for each commissioned substation.';
  const appendix = 'Provide the operating permits for the collection network.';
  const name = 'Replacement checklist.ods';
  await page.setInputFiles('#cl-file', await sheetFile(page, rows, { name, first, second: appendix }));
  await page.locator('.imprev').getByText(first, { exact: true }).waitFor();
  const sheetError = await sheetErrorWhileWaiting(page, next, name);
  const sourceControls = await retrySourceRead(page, appendix);
  const waiting = await next.isDisabled() && /^Asking /.test(await page.locator('#cl-line').textContent());
  await next.evaluate((button) => button.click());
  const after = (await calls()).length;
  await finish(failed('unreachable'));
  await next.click();
  await finish({ ok: true, value: { pairs: [] } });
  const latest = (await calls()).at(-1);
  say('Pasting and file replacement work during Retry, and Next waits to review the replacement',
    waiting && before === after && latest.count === rows.length + 1 && latest.only === undefined
      && await page.locator('#cl-line').textContent() === 'Import 2,163 items',
    JSON.stringify({ waiting, before, after, latest }));
  say('Sheet, list reading Retry, and Choose Columns stay available while a review retry is pending', sourceControls);
  say('A worksheet read error shows in place of the review wait, and Next still waits', sheetError);
}

// A worksheet that cannot be read shows its error while a review request is pending, not the wait (#378).
async function sheetErrorWhileWaiting(page, next, name) {
  const kept = await page.evaluate((name) => {
    const sheets = window.__sheets[name];
    window.__sheets[name] = [];
    return sheets;
  }, name);
  await page.locator('#cl-sheet').selectOption('Appendix');
  const error = page.locator('#cl-line').filter({ hasText: /^Could not read / });
  const shown = await error.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const waiting = await next.isDisabled();
  await page.evaluate(({ name, kept }) => { window.__sheets[name] = kept; }, { name, kept });
  return shown && waiting;
}

async function retrySourceRead(page, appendix) {
  const sheet = page.locator('#cl-sheet');
  if (await sheet.isDisabled()) return false;
  await page.evaluate(() => { window.__fail = { readList: true }; });
  await sheet.selectOption('Appendix');
  const retry = page.locator('#cl-read-retry');
  await retry.waitFor();
  const chooseColumns = await page.locator('#cl-bycolumns').isEnabled();
  await page.evaluate(() => { window.__fail = {}; });
  await retry.click();
  await page.locator('.imprev').getByText(appendix, { exact: true }).waitFor();
  return chooseColumns;
}

async function noCallAfterBack({ page, next, retry, finish, calls }, say) {
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await back.click();
  await page.check('#cl-askreword');
  await page.evaluate((failure) => { store.services.ai.reword = () => Promise.resolve(failure); }, failed('failed'));
  await next.click();
  await finish(failed('failed'));
  await retry.click();
  const before = (await calls()).length;
  await back.click();
  await page.uncheck('#cl-askreword');
  await page.uncheck('#cl-asksame');
  const enabled = await next.isEnabled();
  await next.evaluate((button) => button.click());
  const shown = await page.locator('#cl-go').isVisible();
  await finish(failed('unreachable'));
  const after = (await calls()).length;
  const footer = await page.locator('#cl-line').textContent();
  say('Next opens review immediately with both checks off while the old reply is still pending',
    enabled && shown && before === after && footer === 'Import 2,163 items',
    JSON.stringify({ enabled, shown, before, after, footer }));
}

export async function checkDuplicateRetries(start, say) {
  const { ctx, page } = await start();
  const review = await openReview(page);
  await wholeFailure(review, say);
  await partialFailure(review, say);
  await overlappingRetries(review, say);
  await backDuringWording(review, say);
  await replaceDuringRetry(review, say);
  await noCallAfterBack(review, say);
  say('no errors during duplicate retries', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

export async function checkSheetReadDuringRetry(start, say) {
  const first = 'Provide signed easements for the access road.';
  const second = 'Provide the warranty for each installed turbine.';
  const { ctx, page } = await start();
  const { next, retry, finish, calls, itemCount } = await openReview(page, { first, second });
  await next.click();
  await finish(failed('failed'));
  await retry.click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await holdAppendix(page);
  const sheet = page.locator('#cl-sheet');
  await sheet.selectOption('Appendix');
  await page.waitForFunction(() => !!window.__releaseAppendix);
  await finish({ ok: true, value: { pairs: [] } });

  const waiting = await next.isDisabled() && await sheet.inputValue() === 'Appendix';
  const before = (await calls()).length;
  await next.evaluate((button) => button.click());
  const noEarlyRequest = (await calls()).length === before;
  if (!noEarlyRequest) await finish({ ok: true, value: { pairs: [] } });
  const premature = await page.locator('#cl-go').isVisible();
  await page.evaluate(() => { window.__releaseAppendix(); });
  if (!premature) {
    await page.locator('.imprev').getByText(second, { exact: true }).waitFor();
    await next.click();
    await finish({ ok: true, value: { pairs: [] } });
  }
  await page.click('#cl-go');
  await page.waitForSelector('#fl-count');
  const imported = await page.evaluate(() => Object.values(store.get().firmList).flatMap((list) => list.items)
    .map((item) => item.text));
  say('Next waits for the selected checklist sheet after an older duplicate retry settles (#821)',
    waiting && noEarlyRequest && !premature && imported.length === itemCount + 1
      && imported.includes(second) && !imported.includes(first) && !page.errors.length,
    JSON.stringify({ waiting, noEarlyRequest, premature, count: imported.length, first: imported[0] }));
  await ctx.close();
}

async function holdAppendix(page) {
  await page.evaluate(() => {
    const codec = store.services.sheets;
    const read = codec.read;
    codec.read = async (bytes, name, options) => {
      if (options?.sheet === 'Appendix') {
        await new Promise((resolve) => { window.__releaseAppendix = resolve; });
      }
      return read(bytes, name, options);
    };
  });
}
