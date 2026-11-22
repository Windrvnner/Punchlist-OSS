// The deal header's ⋯ menu holds Check again, Deal memo…, Rename and Delete deal…: the suites
// open it here.

/** Opens the deal header's ⋯ menu and waits for it. */
export async function openDealMenu(page) {
  await page.click('#deal-more');
  await page.waitForSelector('#deal-menu');
}

/** Opens the deal name's rename box from the ⋯ menu. */
export async function openRename(page) {
  await openDealMenu(page);
  await page.click('#deal-rename');
}

/** Opens the Delete deal dialog from the ⋯ menu. */
export async function openDelete(page) {
  await openDealMenu(page);
  await page.click('#deal-delete');
}
