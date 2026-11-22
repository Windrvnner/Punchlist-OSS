/**
 * Sends a follow-up from the composer under a conversation, as a person types it. No conversation has suggested
 * questions to click, so suites and scripts that need an answer ask through the composer.
 */
export async function followUp(page, text) {
  await page.waitForSelector('#pask');
  await page.fill('#pask', text);
  await page.press('#pask', 'Enter');
}
