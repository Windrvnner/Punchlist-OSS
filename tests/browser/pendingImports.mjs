// A reload while the master checklist is written keeps the paste and its review (#931). The write is held before it
// starts, so the reload lands while it is pending, as a closed window or a crash would.

/** Holds every repository transaction that writes a record of `kind`, so it never finishes in this window. */
async function holdWrites(page, kind) {
  await page.evaluate((held) => {
    const repo = store.services.repo;
    const original = repo.transaction.bind(repo);
    repo.transaction = (transaction) => transaction.writes.some((write) => write.kind === held)
      ? new Promise(() => {}) : original(transaction);
  }, kind);
}

/** Long enough for the kept imports' queued writes to reach IndexedDB, as they would before a person reloads. */
const settle = (page) => page.waitForTimeout(800);

async function openChecklistImport(page) {
  await page.click('#u-menu'); await page.waitForSelector('#s-checklist-open'); await page.click('#s-checklist-open');
  await page.waitForSelector('#fl-import'); await page.click('#fl-import');
}

const SITES = ['Northwind Solar', 'Trey Wind', 'Fabrikam Storage', 'Contoso Hydro', 'Litware Biogas'];
const REQUESTS = [
  'Provide the executed EPC contract, with all amendments and change orders',
  'Confirm whether the interconnection agreement has been assigned to the project company',
  'List all permits held and confirm none are subject to appeal',
  'Provide the PPA, including the offtaker credit support and any termination notices',
  'Provide the O&M agreement and the last 12 monthly performance reports',
  'Describe any liquidated damages paid or claimed under the construction contract',
  'Provide the title report and survey for the site',
  'Confirm whether any lender consents are needed for the sale',
  'Provide the land lease, with the rent schedule and extension options',
  'Describe the environmental studies performed and any open remediation',
];

/** A 2,000-line paste, read and reviewed, then a reload while its list is written. */
export async function checkChecklistPasteReload(page, say) {
  const lines = Array.from({ length: 2000 }, (_, at) => {
    const request = REQUESTS[Math.floor(at / SITES.length) % REQUESTS.length];
    return `${request} for ${SITES[at % SITES.length]}, phase ${Math.floor(at / 100) + 1}`;
  });
  await openChecklistImport(page);
  await page.fill('#cl-paste', ['Facility checklist', ...lines].join('\n'));
  await page.click('#cl-paste-next'); await page.waitForSelector('#cl-line');
  await page.waitForFunction(() => !/^Asking/.test(document.querySelector('#cl-line')?.textContent ?? 'Asking'), null,
    { timeout: 30000 });
  await page.click('[data-layer=broad]'); await page.click('#cl-next'); await page.waitForSelector('#cl-go');
  const before = await page.textContent('#cl-line');
  await holdWrites(page, 'firmList');
  await page.click('#cl-go'); await settle(page);
  await page.reload(); await page.waitForSelector('#u-menu');
  await openChecklistImport(page);
  const shown = await page.waitForSelector('#cl-go', { timeout: 5000 }).then(() => true, () => false);
  const after = shown ? await page.textContent('#cl-line') : await page.inputValue('#cl-paste').catch(() => '');
  const written = await page.evaluate(() => Object.keys(store.get().firmList).length);
  say('#931 a reload while the pasted checklist is written keeps the paste and its review',
    shown && after === before && written === 0, JSON.stringify({ before, after, written }));
  await page.keyboard.press('Escape');
}
