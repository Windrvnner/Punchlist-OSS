// Reading mode pages and zoom: Page Up and Page Down and the bar's arrows step through a document's pages, a page
// that is not cited says so in the count, a page another citation names becomes that citation, and the page zooms on its
// own (Ctrl + and −, Ctrl 0, Ctrl and the wheel). Run on a 320-page PDF, deal length.
import pdfPackage from 'pdfjs-dist/package.json' with { type: 'json' };
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
import { longPdf } from './longpdf.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = []; const say = (id, ok, note = '') => { results.push([id, ok]); console.log(ok ? 'PASS' : 'FAIL', id, String(note).slice(0, 240)); };
const browser = await launchChrome();
openOnFindings(browser);
const PAGES = 320; const bytes = longPdf(PAGES);

async function reading({ pdf = true, size = [1280, 736], recordRuntime = false, colorScheme } = {}) {
  const ctx = await browser.newContext({ viewport: { width: size[0], height: size[1] }, colorScheme });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  if (recordRuntime) await ctx.addInitScript(() => {
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, ...options) {
      if (message?.action === 'GetDocRequest') {
        window.__pdfPreviewRuntime = {
          apiVersion: message.data?.apiVersion,
          isEvalSupported: message.data?.evaluatorOptions?.isEvalSupported,
        };
      }
      return send.call(this, message, ...options);
    };
  });
  await page.route('**/long.pdf', (r) => r.fulfill({ body: bytes, contentType: 'application/pdf' }));
  await page.goto(URL); await page.waitForSelector('#fr-new');
  await page.click('#fr-new'); await page.fill('#nd-name', 'Proseware'); await page.click('#nd-paste'); await page.fill('#nd-path', 'reports'); await page.press('#nd-path', 'Enter'); await page.waitForSelector('.ndrow');
  await page.click('#nd-create'); await page.waitForSelector('#nd-create', { state: 'detached' }); await page.waitForSelector('.dtabs');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(store.get().deals)[0].id);
  const fid = await page.evaluate((d) => Object.values(store.get().findings).find((x) => x.dealId === d && x.sources.length > 1 && /p\. \d+/.test(x.sources[0].loc)).id, id);
  if (pdf) await page.evaluate(() => { window.__pdf = { '*': { url: 'long.pdf' } }; });
  await page.goto(URL + `#finding-${id}-${fid}`); await page.waitForSelector('.opening');
  await page.click('.opening .ref .rb'); await page.waitForSelector('.docpanel');
  await page.waitForSelector(pdf ? '.docbody .page.pdf.ready' : '.docbody .page:not(.ph-page)', { timeout: 20000 });
  return { ctx, page, id, fid };
}
const bar = (page) => page.evaluate(() => ({ loc: document.querySelector('#doc-menu .loc')?.textContent, cnt: document.querySelector('#doc-menu .cnt')?.textContent || null, shown: document.querySelector('.docbody .page .pg')?.textContent, prev: document.querySelector('#page-prev')?.disabled, next: document.querySelector('#page-next')?.disabled, zoom: document.querySelector('#zoom-reset:not(.off)')?.textContent ?? null, width: Math.round(document.querySelector('.docbody .page').getBoundingClientRect().width), top: document.querySelector('.docbody').scrollTop }));
const ready = (page, n) => page.waitForFunction((n) => document.querySelector('.docbody .page.pdf.ready .pg')?.textContent === `Page ${n}`, n, { timeout: 8000 });

// 1 Page Down leaves the cited page: the bar says which page of how many, and that it is not cited; Page Up comes back to the citation
{ const { ctx, page } = await reading({ recordRuntime: true });
  const runtime = await page.evaluate(() => window.__pdfPreviewRuntime);
  const worker = page.workers().find((item) => /\/assets\/pdf\.worker\.min-[^/]+\.mjs$/.test(item.url()));
  say('preview-uses-the-installed-pdf-runtime-with-eval-disabled',
    runtime?.apiVersion === pdfPackage.version && runtime.isEvalSupported === false && !!worker,
    JSON.stringify({ runtime, worker: worker?.url() }));
  const cited = await bar(page); const n = +/p\. (\d+)/.exec(cited.loc)[1];
  await page.evaluate(() => { document.querySelector('.docbody').scrollTop = 300; });
  await page.keyboard.press('PageDown'); await ready(page, n + 1); const off = await bar(page);
  await page.keyboard.press('PageUp'); await ready(page, n); const back = await bar(page);
  say('page-down-leaves-the-citation-and-page-up-returns', /^Citation 1 of \d+$/.test(cited.cnt) && off.loc === `p. ${n + 1} of ${PAGES}` && off.cnt === 'Not cited' && off.top === 0 && back.loc === cited.loc && back.cnt === cited.cnt, JSON.stringify({ cited, off, back }));
  // 2 the bar's arrows do the same
  await page.click('#page-next'); await ready(page, n + 1); const b1 = await bar(page); await page.click('#page-prev'); await ready(page, n); const b2 = await bar(page);
  say('bar-arrows-step-pages', b1.cnt === 'Not cited' && b2.cnt === cited.cnt, JSON.stringify({ b1, b2 }));
  // 3 stepped fast to the first page: it stops there, its up arrow is off, and the page shown is the one named
  for (let i = 0; i < n + 5; i++) await page.keyboard.press('PageUp');
  await ready(page, 1); const first = await bar(page);
  say('fast-stepping-stops-at-the-first-page', first.loc === `p. 1 of ${PAGES}` && first.prev === true && first.next === false && !page.errors.length, JSON.stringify({ first, errors: page.errors }));
  // 4 Left and Right still go citation to citation, from a page that is not cited too
  await page.keyboard.press('ArrowRight'); await page.waitForFunction(() => /^Citation 2 of/.test(document.querySelector('#doc-menu .cnt')?.textContent ?? ''), null, { timeout: 5000 }).catch(() => {});
  const right = await bar(page);
  say('left-right-still-step-citations', /^Citation 2 of/.test(right.cnt ?? ''), JSON.stringify(right));
  await ctx.close(); }

// 5 the last page: the down arrow is off and Page Down does nothing more
{ const { ctx, page } = await reading();
  for (let i = 0; i < PAGES; i++) await page.keyboard.press('PageDown');   // more presses than there are pages left
  await page.waitForFunction(() => document.querySelector('#page-next')?.disabled, null, { timeout: 8000 }).catch(() => {}); await ready(page, PAGES).catch(() => {}); const last = await bar(page);
  say('stops-at-the-last-page', last.loc === `p. ${PAGES} of ${PAGES}` && last.next === true && last.shown === `Page ${PAGES}` && !page.errors.length, JSON.stringify({ last, errors: page.errors }));
  await ctx.close(); }

// 6 a page another citation in the list names is that citation: the count says so, rather than "Not cited"
{ const { ctx, page, fid } = await reading();
  const n = await page.evaluate((fid) => {
    const s = store.get(); const f = s.findings[fid]; const src = f.sources[0]; const m = +/p\. (\d+)/.exec(src.loc)[1];
    store.set({ ...s, findings: { ...s.findings, [fid]: { ...f, sources: [...f.sources, { ...src, loc: `p. ${m + 1}` }] } } }); return m;
  }, fid);
  await page.waitForFunction(() => / of 3$/.test(document.querySelector('#doc-menu .cnt')?.textContent ?? ''));
  await page.keyboard.press('PageDown'); await page.waitForFunction(() => document.querySelector('#doc-menu .cnt')?.textContent === 'Citation 3 of 3', null, { timeout: 5000 }).catch(() => {});
  const on = await bar(page);
  say('a-page-another-citation-names-is-that-citation', on.cnt === 'Citation 3 of 3' && on.loc === `p. ${n + 1}`, JSON.stringify(on));
  await ctx.close(); }

// 7 zoom: Ctrl + widens the page and shows the zoom in the bar, Ctrl − narrows it, Ctrl 0 and the zoom button put it back; the page is drawn again at the new size
{ const { ctx, page } = await reading();
  const base = await bar(page);
  await page.keyboard.press('Control+='); await page.keyboard.press('Control+='); await page.waitForTimeout(400); const big = await bar(page);
  const sharp = await page.evaluate(() => { const c = document.querySelector('.docbody .page.pdf canvas'); return Math.round(c.width / (window.devicePixelRatio || 1)) >= Math.round(c.getBoundingClientRect().width) - 2; });
  await page.keyboard.press('Control+0'); await page.waitForTimeout(200); const reset = await bar(page);
  await page.keyboard.press('Control+-'); await page.waitForTimeout(200); const small = await bar(page);
  await page.click('#zoom-reset'); await page.waitForTimeout(200); const clicked = await bar(page);
  say('ctrl-keys-zoom-the-page', base.zoom === null && big.zoom === '125%' && Math.abs(big.width - base.width * 1.25) <= 2 && sharp && reset.zoom === null && reset.width === base.width && small.zoom === '90%' && small.width < base.width && clicked.zoom === null, JSON.stringify({ base, big, sharp, reset, small, clicked }));
  // 8 Ctrl and the wheel over the page zoom it too, and the window itself is not zoomed; the zoom stays on the next page
  await page.mouse.move(800, 300); await page.keyboard.down('Control'); await page.mouse.wheel(0, -100); await page.keyboard.up('Control'); await page.waitForTimeout(300);
  const wheel = await bar(page); const dpr = await page.evaluate(() => window.devicePixelRatio);
  await page.keyboard.press('PageDown'); await page.waitForTimeout(400); const next = await bar(page);
  say('ctrl-wheel-zooms-the-page-and-the-zoom-stays', wheel.zoom === '110%' && dpr === 1 && next.zoom === '110%', JSON.stringify({ wheel, dpr, next }));
  await ctx.close(); }

// 9 a page the demo has no image for steps the same way, by its number
{ const { ctx, page } = await reading({ pdf: false });
  const cited = await bar(page); const n = +/p\. (\d+)/.exec(cited.loc)[1];
  await page.keyboard.press('PageDown'); await page.waitForFunction((n) => document.querySelector('.docbody .page .pg')?.textContent === `Page ${n + 1}`, n);
  const off = await bar(page);
  say('a-page-without-an-image-steps-too', off.cnt === 'Not cited' && /^p\. \d+ of \d+$/.test(off.loc), JSON.stringify(off));
  await ctx.close(); }

// 10 a spreadsheet has no pages to step through: no page arrows
{ const { ctx, page, id } = await reading({ pdf: false });
  await page.evaluate((dealId) => {
    const source = Object.values(store.get().findings).filter((finding) => finding.dealId === dealId)
      .flatMap((finding) => finding.sources).find((ref) => ref.doc === 'Financial model.xlsx');
    if (!source) throw new Error('Missing Financial model.xlsx citation');
    store.ui({ docAside: { ...source, from: 'test' } });
  }, id);
  await page.waitForSelector('.docbody .sheet', { timeout: 8000 });
  const arrows = await page.locator('#page-prev, #page-next').count();
  say('a-spreadsheet-has-no-page-arrows', arrows === 0, String(arrows));
  await ctx.close(); }

// 11 the page arrows and close stay where they are while pages are stepped through and the zoom comes and goes (design.md: repeatedly clicked controls keep their place)
for (const size of [[1280, 736], [1024, 640]]) { const { ctx, page } = await reading({ size });
  const xs = () => page.evaluate(() => ['#page-prev', '#page-next', '#doc-close', '#doc-next'].map((s) => Math.round(document.querySelector(s).getBoundingClientRect().left)).join(','));
  const at = [await xs()]; const n = +/p\. (\d+)/.exec(await page.textContent('#doc-menu .loc'))[1];
  await page.keyboard.press('PageDown'); await ready(page, n + 1); at.push(await xs());
  for (let i = 0; i < 60; i++) await page.keyboard.press('PageDown'); await ready(page, n + 61); at.push(await xs());
  await page.keyboard.press('Control+='); await page.waitForTimeout(300); at.push(await xs());
  await page.keyboard.press('Control+0'); await page.waitForTimeout(300); at.push(await xs());
  // and from citation to citation of the document set (Right, then Left back)
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(600); at.push(await xs()); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(600); at.push(await xs());
  say(`arrows-keep-their-place-${size[0]}`, new Set(at).size === 1, JSON.stringify(at));
  await ctx.close(); }

// 12 zoomed, Page Down scrolls down the page first and turns it at its foot; Page Up from the head goes back to the previous page's foot
{ const { ctx, page } = await reading();
  const n = +/p\. (\d+)/.exec(await page.textContent('#doc-menu .loc'))[1];
  await page.keyboard.press('Control+='); await page.keyboard.press('Control+='); await page.keyboard.press('Control+='); await page.waitForTimeout(400);
  const pos = () => page.evaluate(() => { const b = document.querySelector('.docbody'); return { pg: document.querySelector('.docbody .page .pg')?.textContent, top: Math.round(b.scrollTop), room: b.scrollHeight - b.clientHeight }; });
  await page.keyboard.press('PageDown'); await page.waitForTimeout(150); const first = await pos();
  let turned = null; for (let i = 0; i < 12 && !turned; i++) { await page.keyboard.press('PageDown'); await page.waitForTimeout(150); const p = await pos(); if (p.pg !== `Page ${n}`) turned = p; }
  await ready(page, n + 1); const onNext = await pos();
  await page.keyboard.press('PageUp'); await ready(page, n); await page.waitForTimeout(200); const back = await pos();
  say('zoomed-page-down-scrolls-then-turns', first.pg === `Page ${n}` && first.top > 0 && !!turned && onNext.top === 0 && back.room > 0 && back.top >= back.room - 2, JSON.stringify({ first, turned, onNext, back }));
  await ctx.close(); }

// 13 at 1024 wide, zoomed, the bar stays over the page, at least 12px in from its edges
{ const { ctx, page } = await reading({ size: [1024, 640] });
  for (const z of ['Control+=', 'Control+=', 'Control+=']) await page.keyboard.press(z); await page.waitForTimeout(400);
  const g = await page.evaluate(() => { const n = document.querySelector('.docnav').getBoundingClientRect(), p = document.querySelector('.docbody .page').getBoundingClientRect(), st = document.querySelector('.docbody').getBoundingClientRect(); return { nl: Math.round(n.left), nr: Math.round(n.right), pl: Math.round(p.left), vr: Math.round(Math.min(p.right, st.right)), h: Math.round(n.height) }; });
  say('zoomed-bar-stays-over-the-page-at-1024', g.nl >= g.pl + 11 && g.nr <= g.vr && g.h <= 46, JSON.stringify(g));
  await ctx.close(); }

// 14 a document opened at no cited page (no place, or another draft) shows its page and never "Not cited"
{ const { ctx, page } = await reading();
  await page.evaluate(() => { const c = store.get().ui; const d = Object.values(store.get().findings).flatMap((f) => f.sources).find((x) => /\.pdf$/i.test(x.doc)); store.ui({ docAside: { doc: d.doc, docId: d.docId, loc: '', from: 'From the conversation' } }); return c; });
  await ready(page, 1); const opened = await bar(page);
  await page.keyboard.press('PageDown'); await ready(page, 2); const stepped = await bar(page);
  say('no-not-cited-without-a-citation', opened.loc === `p. 1 of ${PAGES}` && opened.cnt === null && stepped.loc === `p. 2 of ${PAGES}` && stepped.cnt === null, JSON.stringify({ opened, stepped }));
  await ctx.close(); }

// 15 the page and zoom stack (13b) sits at the document's bottom right, clear of the bar, and keeps its place
for (const size of [[1280, 736], [1024, 640]]) {
  const { ctx, page } = await reading({ size });
  const boxes = () => page.evaluate(() => {
    const box = (sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) };
    };
    return { stack: box('.pgstack'), bar: box('.docnav'), panel: box('.docpanel'), plus: box('#zoom-in') };
  });
  const before = await boxes();
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await page.waitForTimeout(300);
  const zoomed = await boxes();
  const big = await bar(page);
  await page.click('#zoom-out');
  await page.waitForTimeout(200);
  const out = await bar(page);
  await page.click('#zoom-reset');
  await page.waitForTimeout(200);
  const back = await bar(page);
  const { stack, bar: nav, panel } = before;
  const clear = stack.b <= nav.t - 10;
  const bottomRight = panel.r - stack.r <= 60 && stack.b > panel.b - 160;
  const still = JSON.stringify(before.plus) === JSON.stringify(zoomed.plus);
  say(`page-and-zoom-stack-at-bottom-right-clear-of-the-bar-${size[0]}`, clear && bottomRight && still,
    JSON.stringify({ before, zoomed }));
  say(`zoom-buttons-zoom-${size[0]}`, big.zoom === '125%' && out.zoom === '110%' && back.zoom === null,
    JSON.stringify({ big, out, back }));
  for (let i = 0; i < 12; i++) await page.keyboard.press('Control+=');
  const top = await page.evaluate(() => document.querySelector('#zoom-in').disabled);
  say(`zoom-in-stops-at-the-largest-${size[0]}`, top, String(top));
  await ctx.close();
}

// Sample what Chromium actually paints. Reuse the same screenshot for every strip in a frame.
async function readingPixels(page, boxes) {
  const png = await page.screenshot();
  return page.evaluate(async ({ png, boxes }) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + png;
    await image.decode();
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d');
    context.drawImage(image, 0, 0);
    return boxes.map(([x, y, width, height]) => Array.from(context.getImageData(x, y, width, height).data));
  }, { png: png.toString('base64'), boxes });
}

async function paneShadow(page, height) {
  const { left, bottom, middle, fits } = await page.evaluate(() => {
    const view = document.querySelector('.view.chatview').getBoundingClientRect();
    const pane = (document.querySelector('.reading-pane') ?? document.querySelector('.chat')).getBoundingClientRect();
    const rail = document.querySelector('.rail').getBoundingClientRect();
    const paper = document.querySelector('.docbody .page').getBoundingClientRect();
    const composer = document.getElementById('pcomposer').getBoundingClientRect();
    const fits = document.documentElement.scrollWidth === innerWidth && document.body.scrollWidth === innerWidth &&
      rail.right < pane.left && pane.right < paper.left && composer.left >= pane.left &&
      composer.right <= pane.right && composer.bottom <= pane.bottom;
    return { left: Math.round(view.left), bottom: Math.round(view.bottom),
      middle: Math.round(pane.left + pane.width / 2), fits };
  });
  const [outer, inner, upper, lower] = await readingPixels(page, [
    [left - 1, height - 210, 1, 20], [left, height - 210, 1, 20],
    [middle - 10, bottom - 1, 20, 1], [middle - 10, bottom, 20, 1],
  ]);
  const lightness = (strip) => strip.reduce((sum, value, i) => sum + (i % 4 === 3 ? 0 : value), 0) / 60;
  return { side: +(lightness(outer) - lightness(inner)).toFixed(1),
    bottom: +(lightness(lower) - lightness(upper)).toFixed(1), fits };
}

async function paneMaterials(page) {
  return page.evaluate(() => {
    const material = (element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.backdropFilter, style.border, style.borderRadius, style.boxShadow,
        getComputedStyle(element, '::after').backgroundImage];
    };
    const reference = JSON.stringify(material(document.querySelector('.rail')));
    const pane = document.querySelector('.reading-pane') ?? document.querySelector('.chat');
    const composer = document.querySelector('#pcomposer');
    return { pane: JSON.stringify(material(pane)) === reference,
      composer: JSON.stringify(material(composer)) === reference };
  });
}

async function placeholderContrast(page) {
  const { color, box } = await page.locator('#pask').evaluate((input) => {
    const { left, top, width, height } = input.getBoundingClientRect();
    return { color: getComputedStyle(input, '::placeholder').color.match(/\d+/g).map(Number),
      box: [Math.ceil(left + 4), Math.ceil(top + 1), Math.floor(Math.min(width - 8, 200)), Math.floor(height - 2)] };
  });
  const style = await page.addStyleTag({ content: '#pask::placeholder{opacity:0}' });
  const [background] = await readingPixels(page, [box]);
  await style.evaluate((node) => node.remove());
  const luminance = (red, green, blue) => {
    const linear = (value) => value <= 10 ? value / 3294.6 : ((value / 255 + 0.055) / 1.055) ** 2.4;
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue) + 0.05;
  };
  const ink = luminance(...color);
  let lowest = Infinity;
  for (let i = 0; i < background.length; i += 4) {
    const pixel = luminance(background[i], background[i + 1], background[i + 2]);
    lowest = Math.min(lowest, Math.max(ink, pixel) / Math.min(ink, pixel));
  }
  return lowest;
}

async function longAnswer(page, dealId, findingId) {
  await page.evaluate(([dealId, findingId]) => {
    const terms = 'The agreement uses the distribution lock-up ratio from the signed term sheet. ' +
      'The draft has a lower figure, so confirm the applicable threshold with the counterparty.';
    const at = new Date().toISOString();
    store.setThread(`f:${dealId}:${findingId}`, [
      { id: 'lock-up-question', role: 'me', text: 'Which distribution threshold applies?', state: 'done', at },
      { id: 'lock-up-answer', role: 'ai', text: Array(20).fill(terms).join(' '), state: 'done', at },
    ]);
  }, [dealId, findingId]);
  await page.waitForSelector('.msgs .acts button');
}

function readingScroll(page, fraction) {
  return page.evaluate((fraction) => {
    const chat = document.querySelector('.chat');
    if (fraction !== undefined) chat.scrollTop = fraction * (chat.scrollHeight - chat.clientHeight);
    return { top: chat.scrollTop, max: chat.scrollHeight - chat.clientHeight,
      head: document.querySelector('.chathead').getBoundingClientRect().top,
      endGap: document.querySelector('#pcomposer').getBoundingClientRect().top -
        document.querySelector('.msgs').getBoundingClientRect().bottom };
  }, fraction);
}

async function compareComposerPixels(page) {
  await page.locator('#pcomposer').evaluate(async (composer) => {
    await Promise.all(composer.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  const boxes = await page.evaluate(() => {
    const composer = document.querySelector('#pcomposer').getBoundingClientRect();
    const x = Math.ceil(composer.left + 18);
    const width = Math.floor(composer.width - 36);
    return [[x, Math.floor(composer.top - 90), width, 70],
      [x, Math.ceil(composer.top + 24), width, Math.floor(composer.height - 40)],
      [x, Math.ceil(composer.bottom), width, 12]];
  });
  const painted = await readingPixels(page, boxes);
  const hidden = await page.addStyleTag({ content: '.chat .opening,.chat .msgs{visibility:hidden}' });
  const background = await readingPixels(page, boxes);
  await hidden.evaluate((style) => style.remove());
  return painted.map((rgba, region) => rgba.filter((value, i) => Math.abs(value - background[region][i]) > 3).length);
}

async function fillComposer(page, text) {
  await page.fill('#pask', text);
  await page.waitForFunction((height) => document.getElementById('pask').offsetHeight === height, text ? 168 : 24);
}

async function answerActionFocus(page) {
  const actions = page.locator('.msgs .acts button');
  await readingScroll(page, 0.5);
  await actions.nth(1).evaluate((button) => button.focus({ preventScroll: true }));
  await page.keyboard.press('Tab');
  return actions.last().evaluate((last) => {
    const box = last.getBoundingClientRect();
    const composer = document.querySelector('#pcomposer').getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return last === document.activeElement && box.bottom <= composer.top && last.contains(hit);
  });
}

async function composerOcclusion(page, note) {
  const evidence = [];
  const before = await readingScroll(page, 0);
  evidence.push(await compareComposerPixels(page));
  const middle = await readingScroll(page, 0.5);
  evidence.push(await compareComposerPixels(page));
  const tall = 'See the signed term sheet.\n'.repeat(7).trimEnd();
  await fillComposer(page, tall);
  const grown = await readingScroll(page);
  evidence.push(await compareComposerPixels(page));
  const top = await readingScroll(page, 0);
  evidence.push(await compareComposerPixels(page));
  const end = await readingScroll(page, 1);
  evidence.push(await compareComposerPixels(page));
  await fillComposer(page, '');
  const shrunk = await readingScroll(page);
  evidence.push(await compareComposerPixels(page));
  const focus = await answerActionFocus(page);
  await page.locator('#pask').focus();
  await readingScroll(page, 0);
  await fillComposer(page, tall);
  const start = await readingScroll(page);
  await fillComposer(page, '');
  const clear = evidence.every(([above, through, below]) => above > 50 && through === 0 && below === 0);
  const anchored = grown.top === middle.top && start.top === 0 && shrunk.top === shrunk.max &&
    [middle, grown, top, end, shrunk, start].every(({ head }) => head === before.head);
  const gaps = [end, shrunk].map(({ endGap }) => +endGap.toFixed(1));
  const endGap = gaps.every((gap) => Math.abs(gap - 34) <= 1.5);
  const extent = Math.abs((grown.max - middle.max) - 144) <= 1;
  say(`reading-text-stays-above-composer-and-remains-reachable-438-${note}`,
    clear && anchored && endGap && extent && focus, JSON.stringify({ evidence, anchored, gaps, extent, focus }));
}

// #437 reuses the rail's pane glass. #442 checks both formerly clipped shadow edges, one pixel at a time.
for (const colorScheme of ['dark', 'light']) {
  const { ctx, page, id, fid } = await reading({ pdf: false, colorScheme });
  await longAnswer(page, id, fid);
  for (const [width, height] of [[1280, 736], [1024, 640], [1440, 900]]) {
    await page.setViewportSize({ width, height });
    await page.mouse.move(width - 2, 1);
    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForTimeout(525);
    if (width !== 1440) {
      const glass = await paneMaterials(page);
      const contrast = await placeholderContrast(page);
      say(`reading-pane-and-composer-use-pane-glass-437-${colorScheme}-${width}`,
        glass.pane && glass.composer && contrast >= 4.5, JSON.stringify({ ...glass, contrast: +contrast.toFixed(2) }));
    }
    const shadow = await paneShadow(page, height);
    say(`reading-pane-shadow-falls-off-beyond-view-442-${colorScheme}-${width}`,
      Math.abs(shadow.side) <= 2 && Math.abs(shadow.bottom) <= 2 && shadow.fits, JSON.stringify(shadow));
    if (width !== 1440) await composerOcclusion(page, `${colorScheme}-${width}`);
  }
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length; console.log(`\n${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
