// An issues list pasted into the import dialog's paste box and sent with Next is read as a chosen file is, the way
// a checklist is pasted. The paste is a real Ctrl+V from the system clipboard. "change" shows the paste box again,
// with the paste as it was typed.
const LIST_TEXT = [
  'Comments',
  '1. Change of control definition omits the sponsor fund vehicles',
  '2. Fees letter is not yet agreed',
].join('\n');

/** Put `text` on the clipboard and press Ctrl+V, as a person pastes. */
async function pasteText(page, text) {
  await page.evaluate((words) => navigator.clipboard.writeText(words), text);
  await page.keyboard.press('Control+V');
}

/** Count the documents attached from here on: each read of a list attaches its file first. */
const countAttaches = (page) => page.evaluate(() => {
  const docs = store.services.docs;
  const attach = docs.attach.bind(docs);
  window.__attaches = 0;
  docs.attach = (...args) => {
    window.__attaches++;
    return attach(...args);
  };
});

/** Close the dialog with its × and open it again from the ⋯ menu. */
async function reopen(page) {
  await page.click('.ilf .shead .x');
  await page.waitForSelector('.ilf', { state: 'detached' });
  await page.click('#f-more');
  await page.click('#f-import');
  await page.waitForSelector('#il-paste');
}

/**
 * With the import dialog open and no list read, paste a list into the box, keep it over a close, send it with Next and
 * check its points; go back with change, read a file, and go back again; then start over, leaving the dialog open with
 * no list, as it was found. The context needs clipboard access.
 */
export async function checkPastedList(page, say, w) {
  await countAttaches(page);
  const box = await page.waitForSelector('#il-paste', { timeout: 5000 }).then(() => true, () => false);
  if (!box) return say(`the dialog has a paste box (${w})`, false);
  const offAtFirst = await page.isDisabled('#il-paste-next');
  // spaces and line breaks alone are not a list: Next stays off
  await page.fill('#il-paste', '  \n \n');
  const offForSpaces = await page.isDisabled('#il-paste-next');
  await page.fill('#il-paste', '');
  await page.focus('#il-paste');
  await pasteText(page, LIST_TEXT);
  const typed = {
    offAtFirst,
    line: await page.textContent('#il-line'),
    attaches: await page.evaluate(() => window.__attaches),
    onAfter: !(await page.isDisabled('#il-paste-next')),
  };
  say(`a paste fills the box and reads nothing until Next (${w})`, typed.offAtFirst && offForSpaces
    && typed.line === '3 lines' && typed.attaches === 0 && typed.onAfter, JSON.stringify(typed));
  await reopen(page);
  const keptPaste = await page.inputValue('#il-paste');
  say(`closing keeps what was pasted in the box (${w})`, keptPaste === LIST_TEXT, JSON.stringify(keptPaste));

  await page.click('#il-paste-next');
  const shown = await page.waitForSelector('#il-raised', { timeout: 10000 }).then(() => true, () => false);
  const read = await page.evaluate(() => ({
    count: document.querySelector('#il-count')?.textContent,
    raised: document.querySelectorAll('#il-raised .ilr').length,
    fresh: [...document.querySelectorAll('#il-new .iln .t')].map((title) => title.textContent),
    file: document.querySelector('.ilfile .fnw')?.getAttribute('title'),
    attaches: window.__attaches,
  }));
  say(`Next reads the pasted list, attached as a text file (${w})`, shown && read.count === '2 points'
    && read.raised === 1 && read.fresh.join() === 'Fees letter is not yet agreed'
    && read.file === 'Pasted issues list.txt' && read.attaches === 1, JSON.stringify(read));

  // "change" goes back to the paste box with the paste as it was typed, as the checklist's does
  await page.click('#il-change');
  const back = await page.waitForSelector('#il-paste', { timeout: 5000 }).then(() => true, () => false);
  const shownAgain = back ? await page.inputValue('#il-paste') : null;
  say(`change shows the paste box with what was pasted (${w})`, shownAgain === LIST_TEXT, JSON.stringify(shownAgain));
  if (!back) return;
  // a file read in its place leaves the paste kept: change shows it again
  await page.setInputFiles('#il-file', {
    name: 'Lender counsel comments.txt', mimeType: 'text/plain', buffer: Buffer.from('1. Hedging policy is due'),
  });
  await page.waitForSelector('#il-count');
  const fromFile = await page.textContent('.ilfile .fnw');
  await page.click('#il-change');
  await page.waitForSelector('#il-paste');
  const afterFile = await page.inputValue('#il-paste');
  say(`after a file is read, change still shows the paste (${w})`,
    fromFile === 'Lender counsel comments' && afterFile === LIST_TEXT, JSON.stringify({ fromFile, afterFile }));

  await page.click('#il-paste-next');
  await page.waitForSelector('#il-restart');
  await page.click('#il-restart');
  await page.click('#il-restart-ask-go');
  await page.waitForSelector('#il-drop');
  say(`start over empties the paste box (${w})`, (await page.inputValue('#il-paste')) === '');
}
