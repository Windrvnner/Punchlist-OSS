import fs from 'node:fs';

// Build the import at deal scale from the existing technology checklist and the project's separate sites.
const items = [...fs.readFileSync(new URL('../fixtures/pastedList.ts', import.meta.url), 'utf8')
  .split('export const NOT_TAKEN')[0].matchAll(/^ {4}'((?:[^'\\]|\\.)+)',?$/gm)]
  .map((match) => match[1].replace(/\\'/g, "'"));
const sites = Array.from({ length: 18 }, (_, index) => `Site ${index + 1}`);
const preview = '.imprev:not(.imchg) tbody';

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
async function holdRead(page, choice) {
  await page.evaluate((choice) => {
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
      }
      return read(bytes, name, opts);
    };
  }, choice);
}

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
  const note = page.locator('.imwhere .efstate.fail');
  const action = page.locator(prefix === 'cl' ? '#cl-next' : '#im-go');
  const waitPreview = (text) => page.waitForFunction(
    ([selector, expected]) => document.querySelector(selector)?.rows[0]?.textContent.includes(expected),
    [preview, text],
  );
  const focused = () => field.evaluate((input) => input === document.activeElement);
  const initial = await body.textContent();
  const ready = await action.isEnabled();
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
  await page.waitForFunction(() => !!window.__resumeHeading);
  await field.fill('3.5');
  const duringRead = await body.textContent() === initial && await action.isDisabled();
  await page.evaluate(() => window.__resumeHeading());
  await waitPreview(fixture.next);
  const newerEdit = await field.inputValue() === '3.5' && await note.isVisible() && await focused();
  await field.fill('1');
  await waitPreview(fixture.first);
  const valid = await field.inputValue() === '1' && !(await note.isVisible()) && await focused();
  await holdRead(page, { headerRow: 3 });
  await field.fill('3');
  await page.waitForFunction(() => !!window.__resumeHeading);
  await field.fill('1');
  await page.evaluate(() => window.__resumeHeading());
  const latestValid = await field.inputValue() === '1' && await focused() && await body.textContent() === initial;
  await field.fill('0');
  await page.selectOption(`#${prefix}-sheet`, 'Supplement');
  await waitPreview(fixture.other);
  const changedSheet = await field.inputValue() === '4' && !(await note.isVisible());
  await page.selectOption(`#${prefix}-sheet`, 'Main');
  await waitPreview(fixture.first);
  await holdRead(page, { sheet: 'Supplement' });
  await page.selectOption(`#${prefix}-sheet`, 'Supplement');
  await page.waitForFunction(() => !!window.__resumeHeading);
  const duringSheet = await action.isDisabled();
  await field.fill('6');
  await page.evaluate(() => window.__resumeHeading());
  const switched = await waitPreview(fixture.other).then(() => true, () => false);
  const newSheetBounds = switched && await field.inputValue() === '6' && await note.isVisible() && await focused();
  return { invalid, noReads, keyboard, ready, duringRead, newerEdit, valid, latestValid, changedSheet, duringSheet,
    newSheetBounds };
}
