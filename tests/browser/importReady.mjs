/** The import dialog's heading choices are ready: shown, and the model's layout proposal (if one was asked for) settled. */
export async function immapReady(page) {
  await page.waitForSelector('.immap');
  await page.waitForFunction(() => !/^Asking /.test(document.getElementById('im-line')?.textContent || ''));
}
