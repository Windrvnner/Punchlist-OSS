// A reload while an import's write is pending keeps what the person pasted, read and checked (#931): the master
// checklist paste with its review, and the issues list with its check mark. Each import's write is held before it
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

/** A 2,000-line paste, read and reviewed, then a reload while its list is written. */
export async function checkChecklistPasteReload(page, say) {
  const lines = Array.from({ length: 2000 }, (_, at) => `Provide the executed agreement for facility ${at + 1}`);
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

/** An issues list with a point kept separate, then a reload while its findings are written. */
export async function checkIssuesListReload(page, say, dealId) {
  await page.evaluate((d) => store.dispatch(store.commandNamed('CreateFinding'),
    { dealId: d, title: 'Change of control definition omits the sponsor fund vehicles', workstream: 'Legal' },
    { quiet: true }), dealId);
  const points = Array.from({ length: 160 }, (_, at) => `${at + 2}. Point ${at + 2}: the covenant needs a cure period`);
  const list = ['Comments', '1. Change of control definition omits the sponsor fund vehicles', ...points].join('\n');
  await page.click('#f-more'); await page.click('#f-import'); await page.waitForSelector('#il-drop');
  await page.setInputFiles('#il-file', { name: 'Lender counsel comments.txt', mimeType: 'text/plain',
    buffer: Buffer.from(list) });
  await page.waitForSelector('#il-raised .ilr input'); await page.click('#il-raised .ilr input');
  const before = await page.textContent('#il-line');
  const count = () => page.evaluate(() => Object.keys(store.get().findings).length);
  const had = await count();
  await holdWrites(page, 'finding');
  await page.click('#il-go'); await settle(page);
  await page.reload(); await page.waitForSelector('#f-more');
  await page.click('#f-more'); await page.click('#f-import');
  const shown = await page.waitForSelector('#il-raised', { timeout: 5000 }).then(() => true, () => false);
  const after = shown
    ? { line: await page.textContent('#il-line'), checked: await page.isChecked('#il-raised .ilr input') } : null;
  const findings = await count();
  say('#931 a reload while an issues list is imported keeps the list and its check mark',
    shown && after.line === before && after.checked && findings === had, JSON.stringify({ before, after, had, findings }));
  await page.keyboard.press('Escape');
}
