// An issues list pasted with Ctrl+V into the import dialog is read as a chosen file is; once a list is shown, a paste
// starts no new read. The paste is a real key press on the system clipboard, so it reaches the dialog's own listener.
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

/**
 * With the import dialog open and no list read, paste a list and check its points; paste again and check nothing is
 * read; then start over, leaving the dialog open with no list, as it was found. The context needs clipboard access.
 */
export async function checkPastedList(page, say, w) {
  await countAttaches(page);
  await pasteText(page, LIST_TEXT);
  const shown = await page.waitForSelector('#il-raised', { timeout: 10000 }).then(() => true, () => false);
  const read = await page.evaluate(() => ({
    count: document.querySelector('#il-count')?.textContent,
    raised: document.querySelectorAll('#il-raised .ilr').length,
    fresh: [...document.querySelectorAll('#il-new .iln .t')].map((title) => title.textContent),
    file: document.querySelector('.ilfile .fnw')?.getAttribute('title'),
    attaches: window.__attaches,
  }));
  say(`Ctrl+V reads the pasted list, attached as a text file (${w})`, shown && read.count === '2 points'
    && read.raised === 1 && read.fresh.join() === 'Fees letter is not yet agreed'
    && read.file === 'Pasted issues list.txt' && read.attaches === 1, JSON.stringify(read));

  await pasteText(page, '1. Another point pasted over the list');
  // a read would attach the paste at once and say "Reading the list"; give it time to start
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => ({
    count: document.querySelector('#il-count')?.textContent,
    line: document.querySelector('#il-line')?.textContent,
    attaches: window.__attaches,
  }));
  say(`once a list is shown, a paste starts no new read (${w})`, after.count === '2 points'
    && after.line === '1 new finding' && after.attaches === 1, JSON.stringify(after));

  await page.click('#il-restart');
  await page.click('#il-restart-ask-go');
  await page.waitForSelector('#il-drop');
}
