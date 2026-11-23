// The checklist review at deal size, with duplicate replies held until the test releases them (#378).
async function openReview(page) {
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
  await page.setInputFiles('#cl-file', {
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
  return { page, finish, next, retry, calls, review, pair, itemCount: rows.length };
}

const failed = (kind) => ({ ok: false, error: { kind, message: kind } });

async function wholeFailure({ next, retry, finish, calls, review, itemCount }, say) {
  await next.click();
  await finish(failed('failed'));
  const initial = await review();
  await retry.evaluate((button) => {
    button.click();
    button.click();
  });
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

export async function checkDuplicateRetries(start, say) {
  const { ctx, page } = await start();
  const review = await openReview(page);
  await wholeFailure(review, say);
  await partialFailure(review, say);
  await overlappingRetries(review, say);
  say('no errors during duplicate retries', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}
