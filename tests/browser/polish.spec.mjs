// Small layout and look fixes, each checked on the built app: the numbers are the GitHub issues they answer.
import { launchChrome } from './chrome.mjs';
import { openRename } from './dealMenu.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, note); };
const browser = await launchChrome();

async function start(size = [1280, 736], scheme = 'dark') {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme: scheme }); const page = await ctx.newPage(); page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Datum'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow'); await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' });
  await page.waitForFunction(() => Object.keys(store.get().findings).length >= 3 && Object.values(store.get().deals)[0].stage === 'ready', null, { timeout: 40000 });
  return { ctx, page, id: await page.evaluate(() => Object.values(store.get().deals)[0].id) };
}

for (const scheme of ['dark', 'light']) {
  const { ctx, page, id } = await start([1024, 640], scheme);
  // while a notice shows, an open dialog starts below it, and still fits
  await page.evaluate(() => store.toast('Project Datum moved to Monitoring')); await page.waitForSelector('.toasts .toast'); await page.click('#u-menu'); await page.waitForSelector('.setdlg'); await page.waitForTimeout(400);
  const dlg = await page.evaluate(() => { const d = document.querySelector('.setdlg'); const n = document.querySelector('.notices').getBoundingClientRect(); return { top: Math.round(d.getBoundingClientRect().top), notices: Math.round(n.bottom), shown: !!document.querySelector('.toasts .toast'), fits: d.scrollHeight <= d.clientHeight + 1 }; });
  say(`${scheme}:a-dialog-opens-below-the-notices-showing`, dlg.shown && dlg.top > dlg.notices && dlg.fits, JSON.stringify(dlg));
  await page.keyboard.press('Escape');

  // the finding page's controls are the same height as elsewhere; it suggests no questions to ask, so the page
  // keeps its room for the finding and the follow-up composer
  const f = await page.evaluate(() => Object.values(store.get().findings)[0].id);
  await page.goto(URL + `#finding-${id}-${f}`); await page.waitForSelector('#f-review');
  const fp = await page.evaluate(() => ({
    heights: ['#f-review', '#f-status', '#f-edit', '#f-delete'].map((sel) => {
      return Math.round(document.querySelector(sel).getBoundingClientRect().height);
    }),
    suggestions: document.querySelectorAll('[aria-label="Suggested questions"]').length,
    composer: !!document.querySelector('#pask'),
  }));
  const fpOk = fp.heights.every((h) => h === 28) && fp.suggestions === 0 && fp.composer;
  say(`${scheme}:finding-controls-are-28px-and-no-suggested-questions`, fpOk, JSON.stringify(fp));

  // a date in the Q&A panel reads as the app writes dates until it has the focus, and Status has an arrow
  await page.evaluate(async (d) => { await store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: 'What is the lock-up ratio?', workstream: 'Legal' }); }, id);
  const q = await page.evaluate(() => Object.values(store.get().questions)[0].id);
  await page.evaluate(async ([d, q]) => { await store.dispatch(store.commandNamed('EditQuestionField'), { dealId: d, questionId: q, field: 'received', value: '2025-10-28' }); }, [id, q]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li'); await page.click('.md .li'); await page.waitForSelector('.qp[title=Received] input');
  const rest = await page.evaluate(() => { const w = document.querySelector('.qp[title=Received]'); return { shown: w.querySelector('.dshow')?.textContent, field: getComputedStyle(w.querySelector('input')).opacity, arrow: !!document.querySelector('#q-status .chev') }; });
  await page.focus('.qp[title=Received] input');
  const typing = await page.evaluate(() => { const w = document.querySelector('.qp[title=Received]'); return { shown: !!w.querySelector('.dshow'), field: getComputedStyle(w.querySelector('input')).opacity, value: w.querySelector('input').value }; });
  say(`${scheme}:a-panel-date-reads-oct-28-until-it-has-the-focus`, rest.shown === 'Oct 28, 2025' && rest.field === '0' && rest.arrow && !typing.shown && typing.field === '1' && typing.value === '2025-10-28', JSON.stringify({ rest, typing }));

  // no conversation suggests questions to ask: a question's, a deal's or Home's has only its composer
  const shown = [];
  for (const hash of [`#q-${id}-${q}`, `#chat-${id}`, '#chat']) {
    await page.goto(URL + hash);
    await page.waitForSelector('#pask');
    // any button under a conversation that has nothing said yet, other than the trail's and the record's own
    shown.push(await page.evaluate(() => [...document.querySelectorAll('.chat button')]
      .filter((button) => !button.closest('.chathead, .opening')).length));
  }
  say(`${scheme}:no-conversation-suggests-questions`, shown.every((n) => n === 0), JSON.stringify(shown));
  say(`${scheme}:no-errors-on-the-page`, page.errors.length === 0, JSON.stringify(page.errors));
  await ctx.close();
}

{ // in high contrast the chosen row is filled with the selection colors, not outlined like the focus ring, and rows are not boxed
  const { ctx, page, id } = await start([1280, 736], 'light');
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto(URL + '#checklist-' + id); await page.waitForSelector('.ckrow'); await page.click('.ckrow >> nth=1'); await page.waitForTimeout(300);
  const hc = await page.evaluate(() => { const on = document.querySelector('.ckrow.on'), off = document.querySelector('.ckrow:not(.on)'); const cs = getComputedStyle(on); return { fill: cs.backgroundColor, outline: cs.outlineStyle, boxed: getComputedStyle(off).borderTopStyle, rule: getComputedStyle(off).borderBottomStyle }; });
  say('high-contrast:the-chosen-row-is-filled-and-rows-are-not-boxed', hc.fill !== 'rgba(0, 0, 0, 0)' && hc.outline === 'none' && hc.boxed === 'none' && hc.rule === 'solid', JSON.stringify(hc));
  await ctx.close();
}

// a turned-off button is a flat, faint gray capsule with secondary words: readable (4.5:1), no accent, no edge, not faded;
// an icon button keeps a fainter ring and a dimmed icon with no fill; in high contrast it is drawn in GrayText
for (const scheme of ['dark', 'light']) {
  const { ctx, page, id } = await start([1280, 736], scheme);
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const rgb = (page, sel, prop) => page.evaluate(([sel, prop]) => { const c = document.createElement('canvas').getContext('2d'); c.fillStyle = getComputedStyle(document.querySelector(sel))[prop]; const v = c.fillStyle; return v.startsWith('#') ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : v.startsWith('color(srgb') ? v.match(/[\d.]+/g).slice(0, 3).map((x) => Number(x) * 255) : v.match(/[\d.]+/g).slice(0, 3).map(Number); }, [sel, prop]);
  // the words against what is drawn behind them, read with the words hidden
  const contrast = async (sel) => {
    const el = await page.$(sel); const b = await el.boundingBox();
    await el.evaluate((e) => { e.style.setProperty('transition', 'none', 'important'); e.style.setProperty('color', 'transparent', 'important'); });
    const png = await page.screenshot({ clip: { x: b.x + 4, y: b.y + 4, width: b.width - 8, height: b.height - 8 } }); await el.evaluate((e) => { e.style.removeProperty('color'); });
    const bg = await page.evaluate(async (a) => { const im = new Image(); im.src = 'data:image/png;base64,' + a; await im.decode(); const c = new OffscreenCanvas(im.width, im.height); const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, im.width, im.height).data; const s = [0, 0, 0]; for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; } return s.map((v) => v / (d.length / 4)); }, png.toString('base64'));
    const [hi, lo] = [lum(await rgb(page, sel, 'color')), lum(bg)].sort((p, q) => q - p); return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
  };
  const look = (sel) => page.evaluate((sel) => { const cs = getComputedStyle(document.querySelector(sel)); return { opacity: cs.opacity, bg: cs.backgroundColor, edge: cs.borderTopColor, color: cs.color }; }, sel);
  // a main button (New finding before a title is typed) and a plain one beside it
  await page.goto(URL + '#deal-' + id); await page.click('#f-new'); await page.waitForSelector('#af-create:disabled'); await page.mouse.move(2, 400); await page.waitForTimeout(300);
  const main = await look('#af-create'); const ratio = await contrast('#af-create');
  say(`${scheme}:596-off-main-button-is-gray-and-readable`, main.opacity === '1' && /rgba\(0, 0, 0, 0\)|transparent/.test(main.edge) && !/^rgb\(/.test(main.bg) && Number(main.bg.match(/\/ ([\d.]+)\)/)?.[1] ?? 1) < 0.2 && ratio >= 4.5, JSON.stringify({ ...main, ratio }));
  const plain = await look('#af-cancel'); say(`${scheme}:596-off-differs-from-an-on-plain-button`, plain.color !== main.color && plain.bg !== main.bg, JSON.stringify(plain));
  await page.click('#af-cancel');
  // a main button in a page header, on the bare window rather than glass, where the fill is darkest: Draft all open with nothing to draft
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('#qa-draftall:disabled', { timeout: 8000 }).catch(() => {}); await page.mouse.move(2, 400); await page.waitForTimeout(300);
  const head = await page.$('#qa-draftall:disabled') ? await contrast('#qa-draftall') : 0;
  say(`${scheme}:596-off-header-button-is-readable`, head >= 4.5, JSON.stringify({ head }));
  // an icon button: Previous on the first question
  for (const t of ['Provide the executed credit agreement.', 'Confirm the lock-up ratio.']) await page.evaluate(([d, t]) => store.dispatch(store.commandNamed('CreateQuestion'), { dealId: d, text: t, workstream: 'Legal' }, { quiet: true }), [id, t]);
  await page.goto(URL + '#qa-' + id); await page.waitForSelector('.md .li'); await page.click('.md .li >> nth=0'); await page.waitForSelector('#q-prev:disabled'); await page.mouse.move(2, 400); await page.waitForTimeout(300);
  const icon = await look('#q-prev'); const next = await look('#q-next');
  say(`${scheme}:596-off-icon-button-keeps-a-ring-no-fill`, icon.opacity === '1' && /rgba\(0, 0, 0, 0\)|transparent/.test(icon.bg) && !/rgba\(0, 0, 0, 0\)/.test(icon.edge) && icon.color !== next.color, JSON.stringify({ icon, next }));
  // high contrast: an off button is drawn in GrayText, an on one is not
  if (scheme === 'light') {
    await page.emulateMedia({ forcedColors: 'active' }); await page.goto(URL + '#deal-' + id); await page.click('#f-new'); await page.waitForSelector('#af-create:disabled'); await page.waitForTimeout(300);
    const hc = await page.evaluate(() => { const g = document.createElement('span'); g.style.color = 'GrayText'; document.body.append(g); const gray = getComputedStyle(g).color; g.remove(); return { gray, off: getComputedStyle(document.getElementById('af-create')).color, on: getComputedStyle(document.getElementById('af-cancel')).color }; });
    say('596-off-button-in-high-contrast-is-graytext', hc.off === hc.gray && hc.on !== hc.gray, JSON.stringify(hc));
  }
  if (page.errors.length) say(`${scheme}:596-no-page-errors`, false, page.errors.join(' | '));
  await ctx.close();
}

async function checkRailLoading(page, at) {
  await page.addInitScript(() => { window.__down = true; });
  await page.goto(URL);
  await page.waitForSelector('.netbar');
  const bars = page.locator('#rail-nav .ph i');
  const styles = () => bars.evaluateAll((items) => items.map((item) => {
    const style = getComputedStyle(item);
    return { radius: style.borderRadius, pulse: style.animationName };
  }));
  const loading = await styles();
  const hidden = await page.locator('#rail-nav .ph[aria-hidden="true"]').count() === 1;
  const links = await page.getByRole('navigation', { name: 'Primary' }).getByRole('link').count();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await styles();
  await page.evaluate(() => { window.__down = false; });
  await page.click('.netbar .tundo');
  await page.waitForSelector('#rail-nav a[href="#deals"]');
  say(`${at}:612-rail-loading-bars`, loading.length === 5 && hidden && links === 0
    && loading.every(({ radius, pulse }) => radius === '6px' && pulse === 'phpulse')
    && reduced.every(({ pulse }) => pulse === 'none') && await bars.count() === 0, JSON.stringify(loading));
}

async function seedVisualPolish(page) {
  return page.evaluate(async () => {
    const run = (name, input) => store.dispatch(store.commandNamed(name), input, { quiet: true });
    await run('CreateDeal', { name: 'Datum', folders: [] });
    const dealId = Object.values(store.get().deals)[0].id;
    for (const title of ['First finding', 'Current finding']) {
      await run('CreateFinding', { dealId, title, workstream: 'Legal' });
    }
    const findings = Object.keys(store.get().findings);
    for (const findingId of findings) {
      await run('SetFindingStatus', { dealId, findingId, status: 'closed', note: 'Agreed' });
    }
    await run('CreateQuestion', { dealId, text: 'Confirm the lock-up ratio.' });
    const questionId = Object.keys(store.get().questions)[0];
    await run('DeleteQuestion', { dealId, questionId });
    return { dealId, findingId: findings[1], questionId };
  });
}

async function checkComposerInsets(page, at, dealId, findingId) {
  const measure = (form) => page.locator(form + ' .send').evaluate((send) => {
    const card = send.closest('form').getBoundingClientRect();
    const rect = send.getBoundingClientRect();
    return { right: card.right - rect.right, bottom: card.bottom - rect.bottom, size: rect.width };
  });
  const home = await measure('#homeask');
  await page.goto(URL + '#overview-' + dealId);
  const closed = await measure('#dask');
  await page.locator('#dask textarea').focus();
  await page.locator('#dask.open').waitFor();
  const deal = await measure('#dask');
  await page.goto(URL + `#finding-${dealId}-${findingId}`);
  const conversation = await measure('#pcomposer');
  const equal = ({ right, bottom, size }) => Math.abs(right - bottom) < 0.5 && size === 32;
  say(`${at}:613-open-composers-inset-send-evenly`, [home, deal, conversation].every(equal) && closed.size === 36,
    JSON.stringify({ home, closed, deal, conversation }));
}

async function checkSelection(locator) {
  return locator.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.focus();
      element.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
    }
    const selection = getComputedStyle(element, '::selection');
    const sample = document.createElement('span');
    sample.style.forcedColorAdjust = 'none';
    sample.style.backgroundColor = 'var(--accent)';
    sample.style.color = 'var(--accent-ink)';
    element.after(sample);
    const expected = getComputedStyle(sample);
    const ok = selection.backgroundColor === expected.backgroundColor && selection.color === expected.color;
    sample.remove();
    return ok;
  });
}

async function checkClosedTicks(page, at) {
  await page.evaluate(() => store.ui({ findingFilter: { ...store.get().ui.findingFilter, status: 'all' } }));
  const marks = await page.locator('.g.done:not(.on) i').evaluate((other) => {
    const current = document.querySelector('.g.on.done i');
    const sample = document.createElement('i');
    sample.style.transition = 'none';
    sample.style.backgroundColor = 'color-mix(in srgb, var(--ink-3) 55%, transparent)';
    other.after(sample);
    const gray = getComputedStyle(sample).backgroundColor;
    sample.style.backgroundColor = 'var(--accent)';
    const accent = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return { current: getComputedStyle(current).backgroundColor, other: getComputedStyle(other).backgroundColor,
      accent, gray };
  });
  say(`${at}:615-current-closed-tick-stays-accent`, marks.current === marks.accent && marks.other === marks.gray,
    JSON.stringify(marks));
}

async function checkFallbackLinks(page, at, dealId, questionId) {
  const missing = 'Z'.repeat(26);
  const targets = [
    ['overview-d_' + missing, '.fr-line a', '#deals'],
    ['chat-d_' + missing, '#gone a', '#deals'],
    [`finding-${dealId}-f_${missing}`, '#gone a', dealId],
    [`q-${dealId}-q_${missing}`, '#gone a', dealId],
    [`q-${dealId}-${questionId}`, '#gone a', dealId],
  ];
  const checks = [];
  for (const [route, selector, destination] of targets) {
    await page.goto(URL + '#' + route);
    const link = page.locator(selector);
    const result = await link.evaluate((anchor) => {
      const sample = document.createElement('span');
      sample.style.color = 'var(--accent)';
      anchor.after(sample);
      const actual = { color: getComputedStyle(anchor).color, accent: getComputedStyle(sample).color,
        underline: getComputedStyle(anchor).textDecorationLine, href: anchor.getAttribute('href') };
      sample.remove();
      return actual;
    });
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForURL((url) => url.hash === result.href);
    await link.waitFor({ state: 'detached' });
    checks.push(result.color === result.accent && result.underline === 'underline'
      && result.href.endsWith(destination));
  }
  await page.goto(URL + `#q-${dealId}-${questionId}`);
  await page.click('#gone-restore');
  await page.waitForFunction((id) => !!store.get().questions[id], questionId);
  say(`${at}:620-fallback-links-use-accent-and-keep-navigation`, checks.every(Boolean), JSON.stringify(checks));
}

for (const [width, height] of [[1280, 736], [1024, 640]]) {
  for (const colorScheme of ['dark', 'light']) {
    const at = `${colorScheme}-${width}x${height}`;
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme });
    const page = await ctx.newPage();
    await checkRailLoading(page, at);
    const { dealId, findingId, questionId } = await seedVisualPolish(page);
    await checkComposerInsets(page, at, dealId, findingId);
    await checkClosedTicks(page, at);
    const staticText = await checkSelection(page.locator('.opening .qtxt'));
    const composer = page.locator('#pcomposer textarea');
    await composer.fill('Selected words');
    const editableText = await checkSelection(composer);
    await page.goto(URL + '#overview-' + dealId);
    await openRename(page);
    const rename = page.locator('#deal-name');
    const dealName = await checkSelection(rename);
    await page.emulateMedia({ forcedColors: 'active' });
    const forced = await checkSelection(rename);
    await page.emulateMedia({ forcedColors: 'none' });
    say(`${at}:614-text-selection-uses-theme-colors`, staticText && editableText && dealName && forced);
    await checkFallbackLinks(page, at, dealId, questionId);
    await ctx.close();
  }
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
