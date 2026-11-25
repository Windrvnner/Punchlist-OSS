// Confirm the exact import revision and removal impact when another PC syncs a mark.
const firstDoc = 'approval-earlier';
const secondDoc = 'approval-later';
const filename = 'CreditAgreement_InitialDraft_ConsolidatedCovenantReview_BorrowerAndFacilityAgentComments_'
  + 'WithUpdatedDebtServiceReserveRequirementsAndSecurityReleaseTests_PreExecutionCopy.pdf';
const remove = (page, doc) => page.locator(`.deldlg [data-restore="list:${doc}"]`);

async function seedRemovalExamples(page, dealId) {
  return page.evaluate(async ({ dealId, firstDoc, secondDoc, filename }) => {
    const clock = store.services.clock;
    const now = clock.now;
    const second = Math.ceil(Date.parse(now()) / 1000) * 1000;
    const revisions = [
      [145, firstDoc, 'Replacement reserve', 'The contract omits a reserve for replacement equipment.'],
      [570, secondDoc, 'Initial funding deadline', 'The reserve covenant omits the initial funding date.'],
    ];
    try {
      for (const [offset, doc, title, text] of revisions) {
        clock.now = () => new Date(second + offset).toISOString();
        const points = [{ n: '1', title, text, workstream: 'Legal' }];
        const result = await store.dispatch(store.commandNamed('ImportIssuesList'), {
          dealId, doc, list: filename, points,
        }, { quiet: true });
        if (!result.ok) throw Error(result.error.message);
      }
    } finally {
      clock.now = now;
    }
    const text = 'The coverage certificate omits extraordinary items and the reconciliation to audited statements.';
    const result = await store.dispatch(store.commandNamed('CreateFinding'), {
      dealId, title: 'Coverage certificate reconciliation', workstream: 'Legal', body: [text],
    }, { quiet: true });
    if (!result.ok) throw Error(result.error.message);
    const findings = Object.values(store.get().findings);
    return {
      madeId: findings.find((finding) => finding.onLists?.some((mark) => mark.doc === firstDoc)).id,
      joinedId: findings.find((finding) => finding.body.includes(text)).id,
      mark: { doc: firstDoc, list: filename, n: '2', text, at: now() },
    };
  }, { dealId, firstDoc, secondDoc, filename });
}

async function checkRevisionPrompts(page, say, width) {
  const titles = [];
  for (const [index, doc] of [firstDoc, secondDoc].entries()) {
    const row = page.locator(`.deldlg [data-del="list"]:has([data-restore="list:${doc}"])`);
    const label = await row.locator('.dmeta').textContent();
    await remove(page, doc).click();
    const title = await page.textContent('#ask-title');
    titles.push(title);
    say(`The confirmation identifies the revision selected in Deleted (${width}, ${index + 1})`,
      title.includes(filename) && title.includes(`revision ${index + 1}`) && label.includes(`Revision ${index + 1}`),
      JSON.stringify({ title, label }));
    if (!index) {
      await page.waitForTimeout(550);
      const layout = await page.evaluate(() => {
        const dialog = document.querySelector('.dddlg');
        const close = dialog.querySelector('.x').getBoundingClientRect();
        const panel = dialog.getBoundingClientRect();
        const title = document.querySelector('#ask-title');
        const range = document.createRange();
        range.selectNodeContents(title);
        return {
          wrapped: [...range.getClientRects()].every((rect) => rect.right <= close.left),
          closeVisible: close.right <= panel.right,
          overflow: dialog.scrollWidth - dialog.clientWidth,
        };
      });
      say(`A long unbroken filename wraps without hiding Close (${width})`,
        layout.wrapped && layout.closeVisible && layout.overflow === 0, JSON.stringify(layout));
    }
    await page.keyboard.press('Escape');
    await remove(page, doc).waitFor();
  }
  say(`Same-name, same-second imports have distinct prompts (${width})`, titles[0] !== titles[1]);
}

async function checkStaleApproval(page, example, say, width) {
  await remove(page, firstDoc).click();
  await page.waitForSelector('#ask-go');
  const impact = await page.evaluate(({ joinedId, mark }) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      stop();
      reject(Error('The peer mark did not sync'));
    }, 5000);
    const stop = store.subscribe((state) => {
      if (!state.findings[joinedId]?.onLists?.length) return;
      stop();
      clearTimeout(timeout);
      const text = document.querySelector('#ask-text').textContent;
      document.querySelector('#ask-go').click();
      resolve(text);
    });
    void __peer.change(joinedId, { onLists: [mark], updatedAt: mark.at });
  }), example);
  await page.waitForFunction(({ madeId }) => !store.get().findings[madeId]
    || store.get().ui.toasts.at(-1)?.text.startsWith('This issues list changed.'), example);
  const preserved = await page.evaluate(({ madeId, joinedId }) => !!store.get().findings[madeId]
    && store.get().findings[joinedId].onLists?.length === 1, example);
  say(`A synced mark prevents an undisclosed removal (${width})`,
    impact === '1 finding goes to Deleted.' && preserved);
  if (!preserved) return;
  await remove(page, firstDoc).click();
  const updated = await page.textContent('#ask-text');
  await page.click('#ask-go');
  await page.waitForFunction(({ madeId }) => !store.get().findings[madeId], example);
  const cleared = await page.evaluate(({ joinedId }) => !store.get().findings[joinedId].onLists?.length, example);
  say(`A new confirmation shows and removes the approved mark (${width})`,
    updated === '1 finding goes to Deleted. Marks are removed from 1 finding.' && cleared, updated);
}

export async function checkRemovalApproval(page, dealId, say, width) {
  const example = await seedRemovalExamples(page, dealId);
  await page.click('#f-more');
  await page.click('#f-deleted');
  await checkRevisionPrompts(page, say, width);
  await checkStaleApproval(page, example, say, width);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.deldlg', { state: 'detached' });
}
