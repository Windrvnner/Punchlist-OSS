/**
 * The suites written for the Findings page open deals on it. They make the choice a person makes in Settings
 * ("Deals open on: Findings") before the app starts, and only when no preferences are stored yet, so a suite that
 * changes a preference and reloads still finds its own change. The Overview suite does not use this: it tests the
 * page a deal opens on when nothing has been chosen.
 */
export function openOnFindings(browser) {
  const make = browser.newContext.bind(browser);
  browser.newContext = async (options) => {
    const ctx = await make(options);
    await ctx.addInitScript(() => { const k = 'dil/1/local/prefs'; try { if (!localStorage.getItem(k)) localStorage.setItem(k, JSON.stringify({ schema: 1, data: { theme: 'system', model: null, landing: 'findings' } })); } catch { /* storage is off: the app says so itself */ } });
    return ctx;
  };
}
