// Deal folders on another PC (#307), at deal scale: 12 deals and 46 folders recorded on drive N:, found on this PC on a
// network share (\\server\deals) and, for another team's share, on Z:. The stand-in says which folders open here (window.__away).
import { launchChrome } from './chrome.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();

const DEALS = ['Proseware', 'Wingtip', 'Coho', 'Alpine', 'Munson', 'Margie', 'Trey', 'Yonder', 'Fourth Coffee', 'Wide World', 'City Power', 'First Up'];
const COUNTS = [6, 5, 3, 4, 4, 3, 5, 3, 4, 3, 3, 3];
const SUBS = ['01 Corporate', '02 Commercial Contracts', '03 Finance', '04 Technical', '05 Permits and Consents', '06 Insurance'];
const team = (d, k) => d === 'Coho' || (d === 'First Up' && k === 0);
const recorded = (d, k) =>
  team(d, k) ? `X:\\Team\\Shared\\Project ${d}\\${SUBS[k]}` : `X:\\Deals\\2026\\Project ${d}\\Data Room\\${SUBS[k]}`;
const here = (d, k) => team(d, k) ? `Z:\\Shared\\Project ${d}\\${SUBS[k]}` : `\\\\server\\deals\\2026\\Project ${d}\\Data Room\\${SUBS[k]}`;

/** a browser whose store holds the 12 deals; `away` is set before the app opens again, as on a PC that has just started */
/** `away.empty` names a deal whose folders open where recorded but hold nothing (#663); the rest are then all here */
async function withDeals(away, wait, look = {}) {
  const ctx = await browser.newContext({ viewport: look.size ? { width: look.size[0], height: look.size[1] } : { width: 1280, height: 736 }, ...(look.scheme ? { colorScheme: look.scheme } : {}) }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  for (const [i, d] of DEALS.entries()) await page.evaluate(([d, folders]) => store.dispatch(store.commandNamed('CreateDeal'), { name: d, folders: folders.map((path) => ({ path, label: '', files: 120, size: '0.3 GB' })) }, { quiet: true }), [d, Array.from({ length: COUNTS[i] }, (_, k) => recorded(d, k))]);
  const ids = await page.evaluate(() => Object.fromEntries(Object.values(store.get().deals).map((x) => [x.name.replace(/^Project /, ''), x.id])));
  const folders = DEALS.flatMap((d, i) => Array.from({ length: COUNTS[i] }, (_, k) => ({ dealId: ids[d], folder: recorded(d, k) })));
  const dirs = ['\\\\server\\deals\\2026', 'Z:\\Shared', 'C:\\Elsewhere', ...DEALS.flatMap((d, i) => Array.from({ length: COUNTS[i] }, (_, k) => here(d, k)))];
  const empty = away.empty ? folders.filter((f) => f.dealId === ids[away.empty]) : null;
  if (empty) for (let k = 0; k < empty.length; k++) dirs.push(`E:\\Moved\\Project ${away.empty}\\Data Room\\${SUBS[k]}`);   // where its files went
  await page.addInitScript(([a, w]) => { window.__away = a; window.__folderWait = w; }, [{ folders: empty ? [] : folders, dirs, ...(empty ? { empty } : {}), ...(away.back ? { back: Date.now() + away.back } : {}) }, wait]);
  await page.reload(); await page.waitForFunction(() => window.store?.get().boot.stage === 'ready');
  return { ctx, page, ids, folders };
}
/** in the browser: whether the dialog lists `n` rows of folders found */
const foundRows = (n) => document.querySelectorAll('.lfrow:not(.miss)').length === n;
const toastText = (page) => page.evaluate(() => [...document.querySelectorAll('.toast .ttext')].map((t) => t.textContent).join('|'));

async function renameDeals(page, names) {
  await page.evaluate((names) => {
    const state = store.get();
    const deals = { ...state.deals };
    for (const [id, value] of Object.entries(names)) {
      const patch = typeof value === 'string' ? { name: value } : value;
      deals[id] = { ...deals[id], ...patch };
    }
    store.set({ ...state, deals });
  }, names);
}

// 1 nothing flashes while the app is still looking; then one notice, which stays, with Locate; the Overview says it once
{ const { ctx, page, ids, folders } = await withDeals({}, 2500);
  say('scale', folders.length === 46 && Object.keys(ids).length === 12, `${folders.length} folders, ${Object.keys(ids).length} deals`);
  await page.goto(URL + '#overview-' + ids.Proseware).catch(() => {}); await page.waitForTimeout(800);
  const during = { toast: await toastText(page), missing: await page.evaluate(() => store.get().ui.missingFolders), locate: await page.$('#f-locate') };
  say('quiet-while-looking', during.toast === '' && during.missing === null && !during.locate, JSON.stringify(during.toast));
  await page.waitForFunction(() => document.querySelector('.toast .ttext')?.textContent?.includes('on this PC'), null, { timeout: 8000 });
  const said = await toastText(page);
  await page.waitForTimeout(9000);                                       // a notice goes after 8 seconds; this one stays
  say('notice-stays-with-locate', said === '46 deal folders aren’t on this PC' && (await toastText(page)) === said && (await page.$eval('.toast .tundo', (b) => b.textContent)) === 'Locate', said);
  await page.goto(URL + '#deal-' + ids.Proseware); await page.waitForTimeout(300);
  const tabs = await page.$$('.dtabs [role=tab], .dtabs a, .dtabs button'); for (const t of tabs) if (/Overview/.test(await t.textContent())) { await t.click(); break; }
  await page.waitForSelector('#f-locate');
  const rows = await page.$$eval('#ov-docs .dcrow[data-away]', (r) => r.map((x) => x.querySelector('.rd')?.textContent ?? ''));
  say('overview-says-once', rows.length === 7 && rows[0] === 'Not on this PC' && rows.slice(1).every((t) => t === '') && !(await page.$('#f-folders')), JSON.stringify(rows));

  // the deal's core documents are in those folders too: their line says no count read, and "Not on this PC" stays said once
  await page.evaluate(async ([id, fs]) => { const p0 = store.services.ai.progress; store.services.ai.progress = async (d) => { const x = await p0?.(d); const v = x?.ok ? x.value : {};
    const list = fs.map((folder) => ({ folder, files: 120, read: 0, core: 5, coreRead: 2 }));
    return d === id ? { ok: true, value: { ...v, folders: list } } : x; };
    await store.refreshProgress(id);
  }, [ids.Proseware, folders.filter((f) => f.dealId === ids.Proseware).map((f) => f.folder)]);
  await page.waitForSelector('#ov-core');
  const core = await page.$eval('#ov-core', (r) => ({ away: r.hasAttribute('data-away'), rd: r.querySelector('.rd').textContent, bar: !!r.querySelector('.fbar') }));
  say('core-documents-not-read', core.away && core.rd === '' && !core.bar, JSON.stringify(core));

  // 2 the dialog asks for two top folders, not 46
  await page.click('#f-locate'); await page.waitForSelector('.lfdlg');
  const tops = await page.$$eval('.lfdlg .lfrow', (r) => r.map((x) => [x.querySelector('.n').textContent, x.querySelector('.p').textContent]));
  const twoTops = [['X:\\Deals\\2026', 'Not found on this PC · 42 folders · Proseware, Wingtip, Alpine and 8 more'],
    ['X:\\Team\\Shared', 'Not found on this PC · 4 folders · Coho, First Up']];
  const useOff = await page.$eval('#lf-use', (b) => b.disabled);
  say('two-top-folders', JSON.stringify(tops) === JSON.stringify(twoTops) && useOff, JSON.stringify(tops));

  await renameDeals(page, { [ids.Proseware]: 'Project-Proseware' });
  const names = await page.locator('.lfdlg .lfrow .p').first().textContent();
  say('locate-uses-the-shared-project-word-1370', names.includes('· Proseware,') &&
    !names.includes('Project-Proseware'), names);
  await renameDeals(page, { [ids.Proseware]: 'Project 🚀', [ids.Wingtip]: 'Project #7', [ids.Alpine]: 'Project 7' });
  const symbols = await page.locator('.lfdlg .lfrow .p').first().textContent();
  say('locate-keeps-meaningful-symbols-in-deal-names-1370', symbols.includes('· 🚀, #7, 7 and 8 more'), symbols);
  await renameDeals(page, { [ids.Proseware]: 'Project-Atlas', [ids.Wingtip]: 'Project Atlas' });
  const aliases = await page.locator('.lfdlg .lfrow .p').first().evaluate((row) => ({
    text: row.textContent, tip: row.title,
  }));
  say('locate-keeps-deals-that-share-a-shortened-name-1370',
    aliases.text.includes('· Project-Atlas, Project Atlas, 7 and 8 more') &&
    aliases.tip.startsWith('Project-Atlas, Project Atlas, 7, '), JSON.stringify(aliases));
  await renameDeals(page, { [ids.Alpine]: 'Project Project Atlas' });
  const nested = await page.locator('.lfdlg .lfrow .p').first().getAttribute('title');
  say('locate-keeps-full-and-shortened-labels-distinct-1370',
    nested.startsWith('Project-Atlas, Project Atlas, Project Project Atlas, '), nested);
  const day = await page.evaluate((id) => new Date(store.get().deals[id].createdAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  }), ids.Proseware);
  const namedTwin = `Project Atlas (Alpha · ${day})`;
  await renameDeals(page, {
    [ids.Proseware]: { name: 'Project Atlas', counterparty: 'Alpha' },
    [ids.Wingtip]: { name: 'Project Atlas', counterparty: 'Beta' },
    [ids.Alpine]: `Project ${namedTwin}`,
  });
  const twins = await page.locator('.lfdlg .lfrow .p').first().getAttribute('title');
  say('locate-keeps-twin-descriptions-distinct-from-deal-names-1370',
    twins.startsWith(`${namedTwin}, Project Atlas (Beta · `) && twins.includes(`, Project ${namedTwin}, `), twins);
  await renameDeals(page, {
    [ids.Proseware]: { name: 'Project Proseware', counterparty: '' },
    [ids.Wingtip]: { name: 'Project Wingtip', counterparty: '' },
    [ids.Alpine]: 'Project Alpine',
  });
  await renameDeals(page, { [ids.Proseware]: 'Project-Atlas', [ids.Coho]: 'Project Atlas' });
  const acrossRoots = await page.locator('.lfdlg .lfrow .p').evaluateAll((rows) => rows.map((row) => row.title));
  say('locate-keeps-aliases-in-different-roots-distinct-1370',
    acrossRoots[0].startsWith('Project-Atlas, ') && acrossRoots[1].startsWith('Project Atlas, '),
    JSON.stringify(acrossRoots));
  await renameDeals(page, { [ids.Proseware]: 'Project Proseware', [ids.Coho]: 'Project Coho' });

  // 3 a folder with none of the deal folders in it finds nothing, and says so
  await page.evaluate(() => { window.__pickFolder = 'C:\\Elsewhere'; }); await page.click('.lfrow[data-top="X:\\\\Deals\\\\2026"] .btn');
  await page.waitForFunction(() => /None of the deal folders/.test(document.querySelector('.lfcount')?.textContent ?? ''));
  say('wrong-folder-finds-nothing', (await page.$$('.lfrow')).length === 2);

  // 4 fix one, fix all: pointing X:\Deals\2026 at \\server\deals\2026 finds all 42 folders under it, each at its own place
  await page.evaluate(() => { window.__pickFolder = '\\\\server\\deals\\2026'; }); await page.click('.lfrow[data-top="X:\\\\Deals\\\\2026"] .btn');
  await page.waitForFunction(foundRows, 1);
  // the folder still missing comes first and says why in red; those found follow under "Found 42", each with Change…
  const after1 = await page.evaluate(() => {
    const l = store.get().ui.locate;
    const why = document.querySelector('.lfrow.miss .lfwhy');
    return {
      count: document.querySelector('.lfcount').textContent,
      labels: [...document.querySelectorAll('.lflbl')].map((x) => x.textContent),
      first: document.querySelector('.lfbody').firstElementChild.classList.contains('miss'),
      why: why.textContent,
      red: getComputedStyle(why).color === getComputedStyle(document.querySelector('.lfrow.miss .lficon')).color,
      change: [...document.querySelectorAll('.lfrow:not(.miss) .btn')].map((b) => b.textContent),
      places: l.located.flatMap((x) => x.places),
    };
  });
  const right = after1.places.every((p) => p.local === p.folder.replace('X:\\Deals', '\\\\server\\deals'));
  say('fix-one-fixes-42', after1.places.length === 42 && right && after1.count === ''
    && after1.labels.join() === 'Found42'
    && after1.first && after1.why === 'Not found on this PC' && after1.red && after1.change.join() === 'Change…',
    JSON.stringify({ ...after1, places: after1.places.length, right }));
  const saved0 = await page.evaluate(() => store.get().ui.missingFolders?.missing);
  say('nothing-used-before-confirm', saved0 === 46, String(saved0));

  // 5 the other team's share is located on its own
  await page.evaluate(() => {
    window.__pickFolder = 'Z:\\Shared';
  });
  await page.click('.lfrow[data-top="X:\\\\Team\\\\Shared"] .btn');
  await page.waitForFunction(foundRows, 2);
  const z = await page.evaluate(() => store.get().ui.locate.located.find((x) => x.picked === 'Z:\\Shared').places.map((p) => p.local));
  say('second-share-on-its-own', z.length === 4 && z.every((p) => p.startsWith('Z:\\Shared\\Project '))
    && (await page.$$eval('.lflbl', (ls) => ls.map((x) => x.textContent).join())) === 'Found46', JSON.stringify(z));

  // 6 Use these folders: every folder is used, the notice goes, Folders is back on the Overview
  await page.evaluate(() => { const ix = store.services.docs.index; window.__read = []; store.services.docs.index = (d, f) => { window.__read.push([d, f.length]); return ix(d, f); }; });
  await page.click('#lf-use'); await page.waitForSelector('.lfdlg', { state: 'detached' }); await page.waitForTimeout(600);
  const read = await page.evaluate(() => window.__read);
  say('placed-folders-read-again', new Set(read.map(([d]) => d)).size === 12 && read.reduce((n, [, k]) => n + k, 0) === 46, JSON.stringify(read.length));
  const done = { missing: await page.evaluate(() => store.get().ui.missingFolders), toast: await toastText(page), folders: !!(await page.$('#f-folders')), away: (await page.$$('#ov-docs .dcrow[data-away]')).length };
  say('confirm-uses-all', done.missing === null && !/on this PC/.test(done.toast) && done.folders && done.away === 0, JSON.stringify(done));
  say('no-page-errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close(); }

// 7 the notice is said again when the dialog closes with folders still missing: closed with nothing used, then after only some are used
{ const { ctx, page } = await withDeals({}, 300);
  await page.waitForFunction(() => document.querySelector('.toast .ttext')?.textContent?.includes('on this PC'), null, { timeout: 8000 });
  await page.click('.toast .tundo'); await page.waitForSelector('.lfdlg');
  const gone = await toastText(page); await page.click('.lfdlg .x'); await page.waitForSelector('.lfdlg', { state: 'detached' }); await page.waitForTimeout(300);
  const back = await toastText(page);
  await page.click('.toast .tundo'); await page.waitForSelector('.lfdlg');
  await page.evaluate(() => { window.__pickFolder = '\\\\server\\deals'; }); await page.click('.lfrow[data-top="X:\\\\Deals\\\\2026"] .btn');   // one above the folder asked for
  await page.waitForFunction(foundRows, 1);
  const above = await page.evaluate(() => store.get().ui.locate.located.flatMap((x) => x.places).filter((p) => p.local === p.folder.replace('X:\\Deals', '\\\\server\\deals')).length);
  say('one-above-finds-42', above === 42, String(above));
  await page.click('#lf-use'); await page.waitForSelector('.lfdlg', { state: 'detached' }); await page.waitForTimeout(600);
  const left = await toastText(page);
  say('notice-said-again', !/on this PC/.test(gone) && back === '46 deal folders aren’t on this PC' && left === '4 deal folders aren’t on this PC', JSON.stringify({ gone, back, left }));
  await ctx.close(); }

// 8 a slow network drive that answers during the wait: nothing is ever said
{ const { ctx, page } = await withDeals({ back: 1200 }, 3000);
  await page.waitForTimeout(4500);
  const quiet = { toast: await toastText(page), missing: await page.evaluate(() => store.get().ui.missingFolders) };
  say('slow-drive-says-nothing', !/on this PC/.test(quiet.toast) && quiet.missing === null, JSON.stringify(quiet));
  await ctx.close(); }

// 9 a deal whose folders open with nothing in them (#663): no notice, each folder says so on the Overview, Locate sits beside
// Folders, and pointing at where the files went places all six; the other 11 deals say nothing
for (const scheme of ['light', 'dark']) for (const size of [[1280, 736], [1024, 640]]) {
  const { ctx, page, ids } = await withDeals({ empty: 'Proseware' }, 300, { scheme, size }); const tag = `${scheme} ${size.join('x')}`;
  await page.waitForTimeout(900);
  const state = await page.evaluate(() => store.get().ui.missingFolders);
  say(`empty-no-notice (${tag})`, !/on this PC/.test(await toastText(page)) && state?.missing === 0 && state?.empty?.length === 6, JSON.stringify(state?.empty?.length));
  await page.goto(URL + '#deal-' + ids.Proseware); await page.waitForTimeout(300);
  const tabs = await page.$$('.dtabs [role=tab], .dtabs a, .dtabs button'); for (const t of tabs) if (/Overview/.test(await t.textContent())) { await t.click(); break; }
  await page.waitForSelector('#f-locate');
  const rows = await page.$$eval('#ov-docs .dcrow[data-empty]', (r) => r.map((x) => x.querySelector('.rd')?.textContent ?? ''));
  const head = await page.$$eval('.lbl.flagsl .lblacts .btn', (b) => b.map((x) => x.textContent));
  say(`empty-said-once (${tag})`, rows.length === 7 && rows[0] === 'Files not found' && (await page.$eval('#ov-docs .dcrow[data-empty] .rd', (e) => e.title)).startsWith('These folders open but have no files') && rows.slice(1).every((t) => t === '') && !(await page.$('#ov-docs .dcrow[data-empty] .fbar')) && (await page.$$('#ov-docs .dcrow[data-away]')).length === 0, JSON.stringify(rows));
  say(`empty-locate-beside-folders (${tag})`, head.includes('Locate…') && head.includes('Folders'), JSON.stringify(head));
  const fit = await page.evaluate(() => { const docs = document.getElementById('ov-docs'); return docs.scrollWidth <= docs.clientWidth + 1 && [...docs.querySelectorAll('.dcrow')].every((r) => r.scrollWidth <= r.clientWidth + 1); });
  say(`empty-rows-fit (${tag})`, fit);
  if (process.env.SHOTS) { await page.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 }).catch(() => {}); await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(800); await page.screenshot({ path: `${process.env.SHOTS}/empty-folder-${scheme}-${size.join('x')}.png` }); }
  if (scheme === 'light' && size[0] === 1280) {
    await page.click('#f-locate'); await page.waitForSelector('.lfdlg');
    const tops = await page.$$eval('.lfdlg .lfrow', (r) => r.map((x) => x.dataset.top));
    say('empty-listed-to-locate', tops.length === 1 && tops[0] === 'X:\\Deals\\2026\\Project Proseware\\Data Room', JSON.stringify(tops));
    await page.evaluate(() => { window.__pickFolder = 'E:\\Moved\\Project Proseware\\Data Room'; }); await page.click('.lfdlg .lfrow .btn');
    await page.waitForFunction(foundRows, 1);
    await page.click('#lf-use'); await page.waitForSelector('.lfdlg', { state: 'detached' }); await page.waitForTimeout(600);
    const after = { missing: await page.evaluate(() => store.get().ui.missingFolders), empty: (await page.$$('#ov-docs .dcrow[data-empty]')).length, locate: !!(await page.$('#f-locate')), toast: await toastText(page) };
    say('empty-located-clears', after.missing === null && after.empty === 0 && !after.locate && !/on this PC/.test(after.toast), JSON.stringify(after));
  }
  if (scheme === 'dark' && size[0] === 1024) {
    // the drive connects late: the next look at the deal's folders, here on opening it again, takes "Files not found" away
    await page.evaluate(() => { window.__away = { ...window.__away, empty: [] }; });
    await page.goto(URL + '#overview-' + ids.Wingtip); await page.waitForTimeout(300);
    await page.goto(URL + '#overview-' + ids.Proseware);
    await page.waitForFunction(() => !document.querySelector('#ov-docs .dcrow[data-empty]') && !!document.querySelector('#f-folders'), null, { timeout: 5000 }).catch(() => {});
    say('empty-clears-when-files-are-back', (await page.$$('#ov-docs .dcrow[data-empty]')).length === 0 && !(await page.$('#f-locate')), String((await page.$$('#ov-docs .dcrow[data-empty]')).length));
  }
  say(`empty-no-page-errors (${tag})`, page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
