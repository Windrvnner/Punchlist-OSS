// The Deal memo button: in the deal header beside Deal status on every deal page, one press makes the memo and
// saves it (the stand-in saves the laid-out document as a download), spinning meanwhile; a failure says so with Retry.
import { launchChrome } from './chrome.mjs';
import { openDealMenu } from './dealMenu.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, ok ? '' : note); };
const browser = await launchChrome();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-memo-'));
async function fresh(scheme = 'light', w = 1280, h = 736) { const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, acceptDownloads: true }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message)); await page.goto(URL); await page.waitForSelector('#fr-new'); return { ctx, page }; }
async function newDeal(page, name) {
  await page.click('#fr-new'); await page.waitForSelector('#nd-name'); await page.fill('#nd-name', name); await page.click('#nd-paste'); await page.fill('#nd-path', 'C:\\Deals\\vdr'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow');
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('#ov-checklist', { timeout: 60000 });
  return page.evaluate((n) => Object.values(store.get().deals).find((d) => d.name === `Project ${n}`).id, name);
}

{ const { ctx, page } = await fresh();
  const id = await newDeal(page, 'Proseware');
  // in the header's ⋯ menu beside Deal status, after Check again and before Rename and Delete deal…,
  // on every deal page
  const menuOf = () => page.evaluate(() => ({
    kids: [...document.querySelector('.hacts').children].map((e) => e.querySelector('button')?.id),
    // an item's own words, without Check again's last-checked date
    items: [...document.querySelectorAll('#deal-menu .mi')].map((b) => `${b.id}:${b.firstChild.textContent}`),
  }));
  const items = 'deal-check:Check Again|deal-memo:Deal Memo…|deal-rename:Rename|deal-delete:Delete Deal…';
  for (const hash of ['overview', 'deal', 'checklist', 'qa']) {
    await page.goto(`${URL}#${hash}-${id}`);
    await openDealMenu(page);
    const at = await menuOf();
    await page.keyboard.press('Escape');
    const ok = at.kids.join() === 'deal-group,deal-more' && at.items.join('|') === items;
    say(`in-the-header-menu-${hash}`, ok, JSON.stringify(at));
  }
  // two presses: ⋯ spins and the item says the memo is being made, then the memo is saved and a notice says so
  await page.goto(`${URL}#overview-${id}`);
  await page.waitForSelector('#deal-more');
  await page.evaluate(() => {
    const ai = store.services.ai;
    const memo = ai.memo;
    ai.memo = async (d) => {
      await new Promise((r) => setTimeout(r, 900));
      return memo(d);
    };
  });
  const makeMemo = async () => {
    await openDealMenu(page);
    await page.click('#deal-memo');
  };
  const busyNow = () => page.evaluate(() => {
    const more = document.getElementById('deal-more');
    const item = document.getElementById('deal-memo');
    const rename = !document.getElementById('deal-rename').disabled;
    const spin = !!more.querySelector('.rsch-spin');
    return { spin, name: more.title, item: item.textContent, off: item.disabled, rename };
  });
  const whileMade = async () => {
    await page.waitForSelector('#deal-more .rsch-spin');
    await openDealMenu(page);
    const busy = await busyNow();
    await page.keyboard.press('Escape');
    const said = busy.name === 'Making the deal memo' && busy.item === 'Making the deal memo…';
    say('spins-while-made', busy.spin && said && busy.off && busy.rename, JSON.stringify(busy));
  };
  const [dl] = await Promise.all([page.waitForEvent('download'), makeMemo().then(whileMade)]);
  const out = path.join(tmp, 'memo.fodt');
  await dl.saveAs(out);
  const xml = fs.readFileSync(out, 'utf8');
  const toastSays = (text) => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes(text));
  await page.waitForFunction(toastSays, 'Deal memo saved');
  const hasRecords = xml.includes('>Project Proseware</text:h>') && xml.includes('Key risks')
    && xml.includes('Technical report and information memorandum disagree');
  const name = dl.suggestedFilename();
  say('saved-with-the-deals-records', name === 'Project Proseware deal memo.fodt' && hasRecords, name);
  const back = await page.evaluate(() => {
    const more = document.getElementById('deal-more');
    return more.title === 'More' && !!more.querySelector('svg') && !more.querySelector('.rsch-spin');
  });
  say('button-back', back);
  // and the memo's item can be used again
  await openDealMenu(page);
  const item = await page.evaluate(() => {
    const memo = document.getElementById('deal-memo');
    return !memo.disabled && memo.textContent === 'Deal Memo…';
  });
  await page.keyboard.press('Escape');
  say('back-in-the-menu', item);
  // a failure says so, with Retry
  await page.evaluate(() => { window.__fail = { memo: true }; });
  await makeMemo();
  await page.waitForFunction(toastSays, 'Couldn’t make the deal memo');
  const retry = await page.evaluate(() => {
    const toasts = [...document.querySelectorAll('.toast')];
    const failed = toasts.find((t) => t.textContent.includes('Couldn’t make the deal memo'));
    return failed?.querySelector('.tundo')?.textContent;
  });
  say('failure-offers-retry', retry === 'Retry', retry);
  await page.evaluate(() => { window.__fail = {}; });
  const [again] = await Promise.all([page.waitForEvent('download'), page.click('.toast .tundo:has-text("Retry")')]);
  say('retry-makes-it', again.suggestedFilename() === 'Project Proseware deal memo.fodt');
  say('no-page-errors', page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close(); }

// it fits the header at the smallest window, dark and light
for (const scheme of ['dark', 'light']) { const { ctx, page } = await fresh(scheme, 1024, 640); await newDeal(page, 'Wingtip');
  const fit = await page.evaluate(() => { const row = document.querySelector('.headrow').getBoundingClientRect(); const bs = [...document.querySelectorAll('.hacts > *')].map((e) => e.getBoundingClientRect()); return { inRow: bs.every((r) => r.right <= row.right + 1), oneLine: new Set(bs.map((r) => Math.round(r.top + r.height / 2))).size === 1, overflow: document.documentElement.scrollWidth > innerWidth }; });
  say(`fits-1024-${scheme}`, fit.inRow && fit.oneLine && !fit.overflow, JSON.stringify(fit)); await ctx.close(); }

async function refusePickedMemoWrite(page) {
  await page.evaluate(() => {
    const { fs, sheets, ai } = store.services;
    const calls = window.memoSaveCalls = [];
    const memo = ai.memo;
    ai.memo = (dealId) => {
      calls.push('model');
      return memo(dealId);
    };
    sheets.document = async () => {
      calls.push('convert');
      return { ok: true, value: { docx: new Uint8Array([1]), pdf: new Uint8Array([2]) } };
    };
    fs.pickSave = async () => {
      calls.push('pick');
      return { ok: true, value: { id: 'picked', ext: 'pdf' } };
    };
    fs.writePicked = async (id, bytes) => {
      const write = `${id}/${bytes.join()}`;
      const retried = calls.includes(write);
      calls.push(write);
      return retried ? { ok: true, value: 'saved' } : {
        ok: false, error: { kind: 'failed', message: 'Couldn’t save the file · Open elsewhere' },
      };
    };
    fs.openPicked = async (id) => {
      calls.push(`open ${id}`);
      return { ok: true, value: 'opened' };
    };
  });
}

async function memoRefusalLayout(toast) {
  return toast.evaluate(async (notice) => {
    await document.fonts.ready;
    const animations = notice.getAnimations({ subtree: true });
    await Promise.allSettled(animations.map((item) => item.finished));
    const title = notice.querySelector('.ttitle');
    const detail = notice.querySelector('.tbody');
    const retry = notice.querySelector('.tundo').getBoundingClientRect();
    const icon = notice.querySelector('.tg svg').getBoundingClientRect();
    const text = notice.querySelector('.ttext').getBoundingClientRect();
    const center = (rect) => rect.top + rect.height / 2;
    return {
      title: title.textContent,
      detail: detail?.textContent,
      textFits: [title, detail].every((part) => part && part.scrollWidth <= part.clientWidth),
      retrySize: [retry.width, retry.height],
      iconSize: icon.width,
      offsets: [center(icon) - center(retry), center(text) - center(retry)],
    };
  });
}

async function checkPickedMemoRetry(scheme, width, height) {
  const { ctx, page } = await fresh(scheme, width, height);
  try {
    const id = await page.evaluate(async () => {
      await store.dispatch(store.commandNamed('CreateDeal'), { name: 'Cedar', folders: [] }, { quiet: true });
      return Object.keys(store.get().deals)[0];
    });
    await page.goto(`${URL}#overview-${id}`);
    await page.evaluate((theme) => store.setPrefs({ theme }), scheme);
    await refusePickedMemoWrite(page);
    await openDealMenu(page);
    await page.click('#deal-memo');
    const toast = page.locator('#toast');
    const retry = toast.getByRole('button', { name: 'Retry', exact: true });
    await retry.waitFor();
    const layout = await memoRefusalLayout(toast);
    const fits = layout.title === 'Couldn’t save the file' && layout.detail === 'Open elsewhere'
      && layout.textFits && layout.retrySize[0] >= 59.5 && Math.abs(layout.retrySize[1] - 24) <= 0.5
      && Math.abs(layout.iconSize - 16) <= 0.5
      && layout.offsets.every((offset) => Math.abs(offset) <= 0.5);
    await retry.click();
    await toast.getByRole('button', { name: 'Open', exact: true }).click();
    const calls = await page.evaluate(() => window.memoSaveCalls.join('|'));
    const retried = calls === 'pick|model|convert|picked/2|picked/2|open picked';
    say(`locked-memo-${scheme}-${width}x${height}`, fits && retried, JSON.stringify({ layout, calls }));
  } finally {
    await ctx.close();
  }
}

for (const [width, height] of [[1280, 736], [1024, 640]]) {
  for (const scheme of ['dark', 'light']) await checkPickedMemoRetry(scheme, width, height);
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
