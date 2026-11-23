import fs from 'node:fs';

// Build the import at deal scale from the existing technology checklist and the project's separate sites.
const items = [...fs.readFileSync(new URL('../fixtures/pastedList.ts', import.meta.url), 'utf8')
  .split('export const NOT_TAKEN')[0].matchAll(/^ {4}'((?:[^'\\]|\\.)+)',?$/gm)]
  .map((match) => match[1].replace(/\\'/g, "'"));
const sites = Array.from({ length: 18 }, (_, index) => `Site ${index + 1}`);
const preview = '.imprev:not(.imchg) tbody';
const unused = '.imwhere .efstate.fail';

export async function headingWorkbook(page, prefix) {
  const qa = prefix === 'im';
  const name = qa ? 'Lender Q&A.xlsx' : 'Solar diligence checklist.xlsx';
  const headings = qa ? ['#', 'Question', 'Response'] : ['Section', 'Item'];
  const rows = sites.flatMap((site) => items.map((item) => [site, item.replaceAll('’', "'")])).slice(0, 2000)
    .map(([site, item], index) => qa
      ? [String(index + 1), `${site}: Could you provide the latest evidence for this requirement? ${item}`,
        index % 3 ? 'The current version is filed in the site diligence folder.' : '']
      : [site, item]);
  const grid = [headings, rows[0], headings, ...rows.slice(1)];
  const sheets = [{ name: 'Main', grid }, { name: 'Supplement', grid: [[], [], [], headings, rows.at(-1)] }];
  await page.evaluate(([name, sheets]) => { window.__sheets = { [name]: sheets }; }, [name, sheets]);
  await page.setInputFiles(`#${prefix}-file`, {
    name, mimeType: 'application/octet-stream', buffer: Buffer.from('PK'),
  });
  return { lastRow: grid.length, first: rows[0][1], next: rows[1][1], other: rows.at(-1)[1] };
}

/** Hold a read for a particular row or sheet, then let later reads run. */
async function holdRead(page, choice, errorMessage) {
  await page.evaluate(([choice, errorMessage]) => {
    const codec = store.services.sheets;
    const read = codec.read;
    const calls = window.__headingReads = [];
    window.__resumeHeading = undefined;
    codec.read = async (bytes, name, opts) => {
      calls.push(opts?.headerRow);
      if (Object.entries(choice).every(([key, value]) => opts?.[key] === value)) {
        codec.read = read;
        await new Promise((resume) => {
          window.__resumeHeading = async () => {
            resume();
            // Give the read and the resulting UI render time to settle before taking a snapshot.
            await new Promise(requestAnimationFrame);
          };
        });
        if (errorMessage) return { ok: false, error: { kind: 'failed', message: errorMessage } };
      }
      return read(bytes, name, opts);
    };
  }, [choice, errorMessage]);
}

const waitForRead = (page) => page.waitForFunction(() => !!window.__resumeHeading);
const finishRead = (page) => page.evaluate(() => window.__resumeHeading());
const ready = (page, prefix) => page.waitForFunction(
  (id) => !document.getElementById(id).disabled,
  prefix === 'cl' ? 'cl-next' : 'im-go',
);
const firstRow = (page) => page.locator(`${preview} tr`).first().textContent();

async function checkStepping(field, waitFirst, focused) {
  await field.fill('1');
  await field.press('ArrowUp');
  const steppedUp = await field.inputValue() === '2';
  await field.press('ArrowDown');
  await waitFirst();
  return steppedUp && await field.inputValue() === '1' && await focused();
}

export async function checkHeadingRow(page, prefix, fixture, toggle) {
  const field = page.locator(`#${prefix}-header`);
  const body = page.locator(preview);
  const note = page.locator(unused);
  const action = page.locator(prefix === 'cl' ? '#cl-next' : '#im-go');
  const waitPreview = (text) => page.waitForFunction(
    ([selector, expected]) => document.querySelector(selector)?.rows[0]?.textContent.includes(expected),
    [preview, text],
  );
  const focused = () => field.evaluate((input) => input === document.activeElement);
  const initial = await body.textContent();
  const initiallyReady = await action.isEnabled();
  await holdRead(page, { headerRow: 3 });
  const invalid = [];
  for (const value of ['', '0', '-1', '1.5', '-01.50', String(fixture.lastRow + 1)]) {
    await field.fill(value);
    await page.locator(toggle).click();
    invalid.push(await field.inputValue() === value && await note.isVisible() && await body.textContent() === initial);
  }
  const noReads = await page.evaluate(() => window.__headingReads.length === 0);
  const keyboard = await checkStepping(field, () => waitPreview(fixture.first), focused);
  await field.fill('3');
  await waitForRead(page);
  await field.fill('3.5');
  const duringRead = await body.textContent() === initial && await action.isDisabled();
  await finishRead(page);
  await waitPreview(fixture.next);
  const newerEdit = await field.inputValue() === '3.5' && await note.isVisible() && await focused();
  await field.fill('1');
  await waitPreview(fixture.first);
  const valid = await field.inputValue() === '1' && !(await note.isVisible()) && await focused();
  await holdRead(page, { headerRow: 3 });
  await field.fill('3');
  await waitForRead(page);
  await field.fill('1');
  await finishRead(page);
  const latestValid = await field.inputValue() === '1' && await focused() && await body.textContent() === initial;
  await field.fill('3.0');
  await ready(page, prefix);
  const integralDecimal = await field.inputValue() === '3.0' && !(await note.isVisible())
    && (await firstRow(page)).includes(fixture.next);
  await field.fill('0');
  await page.selectOption(`#${prefix}-sheet`, 'Supplement');
  await waitPreview(fixture.other);
  const changedSheet = await field.inputValue() === '4' && !(await note.isVisible());
  await page.selectOption(`#${prefix}-sheet`, 'Main');
  await waitPreview(fixture.first);
  await holdRead(page, { sheet: 'Supplement' });
  await page.selectOption(`#${prefix}-sheet`, 'Supplement');
  await waitForRead(page);
  const duringSheet = await action.isDisabled();
  await field.fill('6');
  await finishRead(page);
  const switched = await waitPreview(fixture.other).then(() => true, () => false);
  const newSheetBounds = switched && await field.inputValue() === '6' && await note.isVisible() && await focused();
  return { invalid, noReads, keyboard, initiallyReady, duringRead, newerEdit, valid, latestValid, integralDecimal,
    changedSheet, duringSheet, newSheetBounds };
}

export async function checkHeadingRecovery(page, prefix, fixture) {
  const field = page.locator(`#${prefix}-header`);
  const sheet = page.locator(`#${prefix}-sheet`);
  const note = page.locator(unused);
  await holdRead(page, { headerRow: 3 }, 'The file is locked');
  await field.fill('3');
  await waitForRead(page);
  await finishRead(page);
  await ready(page, prefix);
  const failedRead = await field.inputValue() === '3' && await note.isVisible()
    && (await firstRow(page)).includes(fixture.first)
    && (await page.locator(`#${prefix}-line`).textContent()).includes('The file is locked');

  // The earlier Main/3 read is held across two sheet choices, so it cannot stand in for the new Main/3 choice.
  await field.fill('1');
  await holdRead(page, { headerRow: 3 });
  await field.fill('3');
  await waitForRead(page);
  await page.evaluate(() => { window.__finishOldHeading = window.__resumeHeading; });
  await sheet.selectOption('Supplement');
  await ready(page, prefix);
  await holdRead(page, { sheet: 'Main' });
  await sheet.selectOption('Main');
  await waitForRead(page);
  await field.fill('3');
  await finishRead(page);
  await page.evaluate(() => window.__finishOldHeading());
  await ready(page, prefix);
  const queuedValidRow = await field.inputValue() === '3' && !(await note.isVisible())
    && (await firstRow(page)).includes(fixture.next);
  await field.fill('1');
  await ready(page, prefix);
  return { failedRead, queuedValidRow };
}

/** An unused row typed during the sheet read is kept with that sheet through closing and reloading. */
export async function checkKeptHeading(page, prefix, fixture, reopen) {
  const field = page.locator(`#${prefix}-header`);
  const kept = async () => await field.inputValue() === '6' && await page.locator(unused).isVisible()
    && (await firstRow(page)).includes(fixture.other);
  await page.keyboard.press('Escape');
  await field.waitFor({ state: 'detached' });
  await reopen();
  const afterClose = await kept();
  await page.reload();
  await reopen();
  return { afterClose, afterReload: await kept() };
}

/** Keep a failed layout proposal in flight until a manual row choice has taken over. */
export async function checkManualLayout(page, fixture) {
  await page.evaluate(() => {
    store.services.ai.layout = async () => {
      await new Promise((resolve) => { window.__finishLayout = resolve; });
      return { ok: false, error: { kind: 'failed', message: 'Table not found' } };
    };
  });
  await page.click('#im-ask');
  await page.waitForFunction(() => !!window.__finishLayout);
  await page.fill('#im-header', '3');
  await page.evaluate(() => window.__finishLayout());
  await ready(page, 'im');
  const manualLayout = !(await page.locator(unused).isVisible()) && (await firstRow(page)).includes(fixture.next);
  await page.fill('#im-header', '1');
  await ready(page, 'im');
  return manualLayout;
}
