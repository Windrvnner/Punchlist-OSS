/**
 * A deal made once through the real new-deal flow and copied into each check's own browser context (#96). Making the
 * deal and waiting for its first pass takes most of a check's time, so a suite whose checks all start from the same
 * indexed deal makes it once. Every copy is a context of its own, so no check can reach another's changes. The
 * new-deal, indexing and first-pass steps keep their own tests (regress.spec.mjs).
 */
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;

/** Fills an empty session storage with the saved entries; runs in the page before the app. */
function restoreSession(entries) {
  if (sessionStorage.length) return;
  for (const [key, value] of Object.entries(entries)) sessionStorage.setItem(key, value);
}

/** A new browser context at this size and scheme, on the start page; with `saved`, holding that saved state. */
export async function fresh(browser, width = 1280, height = 736, colorScheme = 'light', saved = undefined) {
  const storageState = saved?.state;
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, storageState });
  // the tab's own session storage (its install id and change files) is not in a storageState: put back, so the copy
  // is the PC that made the deal rather than another one
  if (saved) await ctx.addInitScript(restoreSession, saved.session);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL);
  // with a deal in the saved state the app may open on it, so the ready app is waited for rather than the start page
  if (storageState) await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
  else await page.waitForSelector('#fr-new');
  return { ctx, page };
}

/** Makes the deal Proseware on the reports folder through the New Deal dialog and waits for its first pass. */
async function indexedDeal(page) {
  await page.click('#fr-new');
  await page.fill('#nd-name', 'Proseware');
  await page.click('#nd-paste');
  await page.fill('#nd-path', 'reports');
  await page.press('#nd-path', 'Enter');
  await page.waitForSelector('.ndrow');
  await page.click('#nd-create');
  await page.waitForSelector('#nd-create', { state: 'detached' });
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 30000 });
  return page.evaluate(() => Object.keys(store.get().deals)[0]);
}

/** The indexed deal's id and stored state, made in a context of its own that is closed again. */
export async function saveIndexedDeal(browser) {
  const { ctx, page } = await fresh(browser);
  const id = await indexedDeal(page);
  // copied only once nothing is in flight, so no copy boots with an interrupted save
  await page.waitForFunction(() => !Object.values(store.get().ops).some((op) => op.state === 'pending'));
  const state = await ctx.storageState();
  const session = await page.evaluate(() => ({ ...sessionStorage }));
  await ctx.close();
  return { id, state, session };
}

/**
 * A fresh context holding a copy of the saved deal, open at `hash`, and whether it starts as it was made: the one deal
 * with its three findings, no questions or conversations, and no change left unsaved.
 */
export async function openCopy(browser, saved, { width, height, colorScheme, hash }) {
  const { ctx, page } = await fresh(browser, width, height, colorScheme, saved);
  await page.goto(URL + hash);
  await page.waitForFunction(() => Object.values(store.get().findings).length === 3, null, { timeout: 30000 });
  const start = await page.evaluate(() => {
    const state = store.get();
    return {
      deals: Object.keys(state.deals), questions: Object.keys(state.questions).length,
      threads: Object.keys(state.threads).length,
      unsettled: Object.values(state.ops).filter((op) => op.state === 'pending' || op.state === 'interrupted').length,
    };
  });
  const asMade = start.deals.join() === saved.id && !start.questions && !start.threads && !start.unsettled;
  return { ctx, page, start, asMade };
}
