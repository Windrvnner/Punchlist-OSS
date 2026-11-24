// The finding editor's citations as tags (#636), and the reading bar's document arrows' tooltips.
// Each check is what a person would do: type, delete, cut and paste, leave and come back, save.
import { launchChrome } from './chrome.mjs';
import { openOnFindings } from './landing.mjs';
const URL = `http://127.0.0.1:${process.env.PUNCHLIST_PORT || 4178}/`;
const results = [];
const say = (id, ok, note = '') => {
  results.push([id, ok]);
  console.log(ok ? 'PASS' : 'FAIL', id, note);
};
const browser = await launchChrome();
openOnFindings(browser);
const SHOTS = process.env.SHOTS || '';

const SENTENCE_1 = 'The technical advisor supports a lower figure than the one the information memorandum relies on.';
const SENTENCE_2 = 'The base case uses the higher figure throughout.';
const STORED = `${SENTENCE_1} [1] ${SENTENCE_2} [2]`;

async function start() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 736 } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#fr-new');
  await page.click('#fr-new');
  await page.fill('#nd-name', 'Proseware');
  await page.click('#nd-paste');
  await page.fill('#nd-path', 'reports');
  await page.press('#nd-path', 'Enter');
  await page.waitForSelector('.ndrow');
  await page.click('#nd-create');
  await page.waitForFunction(() => document.querySelectorAll('.flagrow').length === 3, null, { timeout: 30000 });
  const fid = await findingIn(page, 'Technical');
  await openFinding(page, fid);
  return { ctx, page, fid };
}

const findingIn = (page, workstream) =>
  page.evaluate((w) => Object.values(store.get().findings).find((f) => f.workstream === w).id, workstream);
const openFinding = async (page, fid) => {
  await page.evaluate((id) => { location.hash = `#finding-${store.get().findings[id].dealId}-${id}`; }, fid);
  await page.waitForSelector('#f-edit');
};
/** a paste into the editor, carrying the given clipboard types */
const paste = (page, types) => page.evaluate((all) => {
  const data = new DataTransfer();
  for (const [type, value] of Object.entries(all)) data.setData(type, value);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  document.querySelector('#fe-body').dispatchEvent(event);
}, types);
/** Copy of everything in the editor: every clipboard type it gives */
const copyAll = (page) => page.evaluate(() => {
  const box = document.querySelector('#fe-body');
  box.focus();
  getSelection().selectAllChildren(box);
  const data = new DataTransfer();
  box.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
  return Object.fromEntries(data.types.map((type) => [type, data.getData(type)]));
});
const body = (page, fid) => page.evaluate((id) => store.get().findings[id].body, fid);
const tags = (page) => page.$$eval('#fe-body .ctag', (all) => all.map((t) => t.textContent));
/** the caret just after the given words in the editor's text, as a click there would put it */
const caretAfter = (page, words) => page.evaluate((w) => {
  const box = document.querySelector('#fe-body');
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.nodeValue.indexOf(w);
    if (at < 0) continue;
    box.focus();
    getSelection().collapse(node, at + w.length);
    return true;
  }
  return false;
}, words);
const saveEdit = async (page) => {
  await page.click('#fe-save');
  await page.waitForSelector('#fe-body', { state: 'detached' });
};
const openEdit = async (page) => {
  await page.click('#f-edit');
  await page.waitForSelector('#fe-body .ctag');
};

{ const { ctx, page, fid } = await start();
  await openEdit(page);
  const limit = 32_767;
  const detail = 'The facility agreement requires the annual budget and a compliance certificate. ';
  const prefix = detail.repeat(Math.ceil(limit / detail.length)).slice(0, limit - 1).replace(/ $/, '.');
  await page.locator('#fe-body').fill(prefix);
  await page.keyboard.press('Control+End');
  await paste(page, { 'text/plain': '[see schedule]' });
  const clipboard = await copyAll(page);
  const stored = JSON.parse(clipboard['application/x-punchlist-cited']).text;
  say('paste-at-limit-keeps-literal-bracket', stored === `${prefix}[` && stored.length === limit);
  await page.keyboard.press('Control+z');
  const undone = await copyAll(page);
  say('undo-paste-at-limit', JSON.parse(undone['application/x-punchlist-cited']).text === prefix);

  await page.click('#fe-cancel');
  const uncitedId = await findingIn(page, 'Legal');
  await openFinding(page, uncitedId);
  await page.evaluate((id) => { store.get().findings[id].sources = []; }, uncitedId);
  await page.click('#f-edit');
  await page.locator('#fe-body').fill('[1] in the compliance schedule.');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await page.click('#fe-cancel');
  await openFinding(page, fid);
  await openEdit(page);
  const clipboardPrefix = `${prefix.slice(0, -2)}.`;
  await page.locator('#fe-body').fill(clipboardPrefix);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Control+v');
  const copiedText = await page.locator('#fe-body').textContent();
  say('native-paste-at-limit-keeps-copied-literal-number', copiedText === `${clipboardPrefix}[1`);
  await page.keyboard.press('Control+z');
  say('undo-native-paste-at-limit', await page.locator('#fe-body').textContent() === clipboardPrefix);
  await ctx.close();
}

{ const { ctx, page, fid } = await start();
  await openEdit(page);
  const shown = await page.evaluate(() => document.querySelector('#fe-body').innerText);
  const named = JSON.stringify(await tags(page)) === '["Technical advisor report","Information memorandum"]';
  say('tags-name-their-sources', named && !/\[\d\]/.test(shown), shown);
  // the tag follows the end of its sentence on the same line, with the words' baseline
  const line = await page.evaluate(() => {
    const tag = document.querySelector('#fe-body .ctag').getBoundingClientRect();
    const range = document.createRange();
    const text = document.querySelector('#fe-body').firstChild;
    range.setStart(text, text.nodeValue.length - 2);
    range.setEnd(text, text.nodeValue.length - 1);
    const word = range.getBoundingClientRect();
    return { tagMid: (tag.top + tag.bottom) / 2, wordMid: (word.top + word.bottom) / 2, gap: tag.left - word.right };
  });
  say('a-tag-sits-on-its-sentence-line', Math.abs(line.tagMid - line.wordMid) <= 2 && line.gap >= 0 && line.gap < 12,
    JSON.stringify(line));

  // unchanged, Save writes nothing new: the stored text comes back exactly as it was
  await saveEdit(page);
  say('save-unchanged-keeps-the-stored-text', JSON.stringify(await body(page, fid)) === JSON.stringify([STORED]));

  // words typed inside the sentence: its tag stays after it
  await openEdit(page);
  await caretAfter(page, 'supports a lower figure');
  await page.keyboard.type(' (about 7% lower)');
  await saveEdit(page);
  const typed = (await body(page, fid))[0];
  const expected = STORED.replace('lower figure', 'lower figure (about 7% lower)');
  say('a-tag-moves-with-its-sentence-as-it-is-typed', typed === expected, typed);

  // Backspace right after a tag takes the tag, and only the tag
  await openEdit(page);
  await page.focus('#fe-body');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Backspace');
  await saveEdit(page);
  const untagged = (await body(page, fid))[0];
  say('backspace-takes-a-tag-whole', untagged === typed.replace(/ \[2\]$/, ''), untagged);

  // Cut the first sentence with its tag and paste it at the end: the tag moves with it
  await openEdit(page);
  await page.evaluate(() => {
    const box = document.querySelector('#fe-body');
    const range = document.createRange();
    range.setStart(box.firstChild, 0);
    range.setEndAfter(box.querySelector('.ctag'));
    box.focus();
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await page.keyboard.press('Control+x');
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' ');
  await page.keyboard.press('Control+v');
  const moved = await page.evaluate(() => [...document.querySelectorAll('#fe-body .ctag')].map((t) => t.textContent));
  await saveEdit(page);
  const reordered = (await body(page, fid))[0];
  const swapped = /^The base case uses the higher figure throughout\. The technical advisor .* relies on\. \[1\]$/;
  say('cut-and-paste-moves-the-tag-with-its-sentence',
    swapped.test(reordered) && JSON.stringify(moved) === '["Technical advisor report"]', reordered);

  // Enter starts a new paragraph; Ctrl B makes nothing bold; a pasted "[2]" becomes a tag, a "[9]" stays words
  await openEdit(page);
  await page.focus('#fe-body');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('Bold? No.');
  await paste(page, { 'text/plain': ' Seen twice. [2] See note [9].' });
  const styled = await page.$$eval('#fe-body b, #fe-body strong, #fe-body [style]', (all) => all.length);
  const pastedTags = await tags(page);
  await saveEdit(page);
  const paragraphs = await body(page, fid);
  say('enter-makes-a-paragraph-and-nothing-is-styled', paragraphs.length === 2 && styled === 0,
    JSON.stringify(paragraphs));
  const pastedOk = pastedTags.length === 2 && paragraphs[1] === 'Bold? No. Seen twice. [2] See note [9].';
  say('a-pasted-marker-becomes-a-tag', pastedOk, JSON.stringify({ pastedTags, paragraphs }));

  // a paste that ends in a line break at the very end: what is typed next starts the new line
  await openEdit(page);
  await page.focus('#fe-body');
  await page.keyboard.press('Control+End');
  await paste(page, { 'text/plain': ' Line one.\r\n' });
  await page.keyboard.type('Line two.');
  await saveEdit(page);
  const broken = await body(page, fid);
  say('a-pasted-line-break-at-the-end-starts-a-new-line',
    broken.length === 3 && broken[1].endsWith('Line one.') && broken[2] === 'Line two.', JSON.stringify(broken));

  // a paste of many lines lands as it was, quickly, and one Undo takes all of it back
  await openEdit(page);
  await page.focus('#fe-body');
  await page.keyboard.press('Control+Home');
  const before = await page.evaluate(() => document.querySelector('#fe-body').innerText);
  const many = Array.from({ length: 2000 }, (_, i) => `Line ${i}. [1]`).join('\n');
  const started = Date.now();
  await paste(page, { 'text/plain': many });
  const took = Date.now() - started;
  const landed = await page.evaluate(() => ({
    tags: document.querySelectorAll('#fe-body .ctag').length,
    start: document.querySelector('#fe-body').innerText.slice(0, 22),
  }));
  const whole = landed.tags === 2002 && landed.start === 'Line 0. Technical advi';
  say('a-long-paste-lands-whole-and-fast', whole && took < 3000,
    JSON.stringify({ ...landed, took }));
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => document.querySelector('#fe-body').innerText);
  say('one-undo-takes-a-paste-back', undone === before, undone.slice(0, 80));
  await page.click('#fe-cancel');

  // Copy gives other apps the words without markers (decisions: Conversations), and the app the markers too
  await openEdit(page);
  const copied = await copyAll(page);
  const plain = copied['text/plain'] ?? '';
  const inApp = JSON.parse(copied['application/x-punchlist-cited'] ?? '{}');
  say('copy-leaves-the-markers-out-of-plain-text', !/\[[12]\]/.test(plain) && plain.includes('relies on.'), plain);
  say('copy-gives-the-app-the-markers-and-their-sources',
    /relies on\. \[1\]/.test(inApp.text) && inApp.sources?.length === 2, JSON.stringify(inApp));

  // pasted into another finding, a sentence shows no source that finding does not cite
  await page.click('#fe-cancel');
  await openFinding(page, await findingIn(page, 'Legal'));
  await page.click('#f-edit');
  await page.waitForSelector('#fe-body .ctag');
  await page.focus('#fe-body');
  await page.keyboard.press('Control+End');
  await paste(page, copied);
  const legal = await page.evaluate(() => ({
    tags: document.querySelectorAll('#fe-body .ctag').length,
    text: document.querySelector('#fe-body').innerText,
  }));
  say('a-sentence-pasted-in-another-finding-keeps-no-wrong-source',
    legal.tags === 2 && legal.text.includes('relies on.\n') && !/\[[12]\]/.test(legal.text), JSON.stringify(legal));

  // text dropped from outside goes in where it is dropped, its markers as tags
  await page.evaluate(() => {
    const box = document.querySelector('#fe-body');
    const at = box.getBoundingClientRect();
    const data = new DataTransfer();
    data.setData('text/plain', 'Dropped words. [1] ');
    const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true,
      clientX: at.left + 14, clientY: at.top + 14 });
    box.dispatchEvent(event);
  });
  const dropped = await page.evaluate(() => ({
    tags: document.querySelectorAll('#fe-body .ctag').length,
    start: document.querySelector('#fe-body').innerText.slice(0, 15),
  }));
  say('dropped-text-goes-in-where-it-is-dropped', dropped.tags === 3 && dropped.start === 'Dropped words. ',
    JSON.stringify(dropped));
  // dropped on a tag, text goes in just after it
  await page.evaluate(() => {
    const tag = document.querySelector('#fe-body .ctag:last-of-type').getBoundingClientRect();
    const data = new DataTransfer();
    data.setData('text/plain', ' On the tag.');
    const event = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true,
      clientX: tag.left + 8, clientY: tag.top + 8 });
    document.querySelector('#fe-body').dispatchEvent(event);
  });
  const onTag = await page.evaluate(() => document.querySelector('#fe-body').innerHTML);
  say('text-dropped-on-a-tag-goes-in-after-it', /class="ctag"[^>]*>[^<]*<\/span> On the tag\./.test(onTag), onTag);
  await page.click('#fe-cancel');
  await openFinding(page, fid);
  await openEdit(page);
  await page.focus('#fe-body');

  // half-done work comes back with its tags when the finding is left and opened again (lost work)
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Still writing');
  await page.evaluate(() => { location.hash = `#deal-${store.get().ui.route.dealId}`; });
  await page.waitForSelector('#fe-body', { state: 'detached' });
  await page.goBack();
  await page.waitForSelector('#fe-body .ctag');
  const kept = await page.evaluate(() => ({
    text: document.querySelector('#fe-body').innerText,
    tags: document.querySelectorAll('#fe-body .ctag').length,
  }));
  say('a-half-done-edit-comes-back-with-its-tags', kept.text.endsWith('Still writing') && kept.tags === 2,
    JSON.stringify(kept));
  await page.click('#fe-cancel');

  // a long name is cut to 30 characters with an ellipsis, and its tooltip gives it whole
  const long = 'Independent technical advisor report on the energy yield (final, signed).pdf';
  await page.evaluate(([id, name]) => { store.get().findings[id].sources[0].doc = name; }, [fid, long]);
  await openEdit(page);
  const label = (await tags(page))[0];
  await page.hover('#fe-body .ctag >> nth=0');
  await page.waitForSelector('.tip', { timeout: 3000 }).catch(() => null);
  const tip = await page.evaluate(() => document.querySelector('.tip')?.textContent ?? null);
  say('a-long-name-is-cut-and-whole-in-its-tooltip', [...label].length === 30 && label.endsWith('…') && tip === long,
    JSON.stringify({ label, tip }));
  say('no-page-errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

{ const { ctx, page } = await start();
  await page.click('.opening .ref .rb');
  await page.waitForSelector('.docnav');
  const titles = await page.evaluate(() => ['#doc-prev', '#doc-next'].map((id) => document.querySelector(id).title));
  const wanted = '["Previous document · Left","Next document · Right"]';
  say('document-arrows-have-tooltips', JSON.stringify(titles) === wanted, JSON.stringify(titles));
  await ctx.close();
}

const cursor = (ref) => ref.evaluate((node) => getComputedStyle(node).cursor);

async function openCitation(page, ref, activation = 'click') {
  const pointer = await cursor(ref);
  const pop = ref.locator('..').locator('.pop');
  await ref.hover();
  await pop.waitFor();
  const name = await pop.locator('.psrc .docnm').first().textContent();
  const place = (await pop.locator('.psrc .loc').first().textContent()).replace(/^ · /, '');
  let focused = true;
  if (activation === 'popover') {
    await pop.locator('.pfoot').click();
  } else if (activation === 'click') {
    await ref.click();
  } else {
    await page.mouse.move(2, 2);
    await page.keyboard.press('Shift+Tab');
    await ref.focus();
    await pop.waitFor();
    focused = await ref.evaluate((node) =>
      node.matches(':focus-visible') && getComputedStyle(node).outlineStyle === 'solid');
    await page.keyboard.press(activation);
  }
  await page.waitForFunction(([doc, loc]) => document.querySelector('.docnav .docname .docnm')?.textContent === doc
    && document.querySelector('.docnav .loc')?.textContent === loc, [name, place]);
  return { pointer, focused, name, place };
}

{ const { ctx, page, fid } = await start();
  const dealId = await page.evaluate((id) => store.get().findings[id].dealId, fid);
  const finding = page.locator('.opening .ref .rb[role="button"]');
  const findingCursors = [];
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction((scheme) => document.documentElement.dataset.theme === scheme, colorScheme);
    for (const [width, height] of [[1280, 736], [1024, 640]]) {
      await page.setViewportSize({ width, height });
      findingCursors.push(...await finding.evaluateAll((refs) => refs.map((ref) => getComputedStyle(ref).cursor)));
      if (SHOTS) {
        await finding.first().hover();
        await page.waitForSelector('.opening .ref:hover .pop');
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${SHOTS}/440-${colorScheme}-${width}.png`, animations: 'disabled' });
        await page.mouse.move(2, 2);
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 736 });
  const fromFinding = await openCitation(page, finding.first(), 'Enter');
  await page.click('#doc-close');
  const ask = async () => {
    await page.fill('#pask', 'What changed in the lock-up ratio in the latest draft?');
    await page.press('#pask', 'Enter');
    return page.locator('.msgs .ai .ref .rb[role="button"]').first();
  };
  const fromChat = await openCitation(page, await ask(), 'Space');

  await page.goto(`${URL}#qa-${dealId}`);
  await page.click('#qa-add');
  const question = page.locator('.det:not([inert]) textarea.qtext');
  await question.fill('What lock-up test does the facility draft set?');
  await question.press('Tab');
  await page.click('#q-draft');
  const readOnly = page.locator('.qpanel .draft .ref .rb:not([role])').first();
  await readOnly.hover();
  await page.waitForSelector('.qpanel .draft .ref:hover .pop');
  const readOnlyCursor = await cursor(readOnly);
  const untabbable = await readOnly.getAttribute('tabindex') === null;
  await readOnly.click();
  const staysInQa = await page.locator('.docpanel').count() === 0;
  await page.click('#q-discuss');
  const fromQa = await openCitation(page, page.locator('.opening .ref .rb[role="button"]').first());

  await page.goto(`${URL}#checklist-${dealId}`);
  await page.click('#ck-filter [data-filter="all"]');
  await page.locator('#ck-rows .ckrow[data-result="satisfied"]').first().click();
  const source = page.locator('#ck-sources .ckopen').first();
  const checklistCursor = await cursor(source);
  await source.click();
  await page.waitForSelector('#from-item');
  const fromChecklist = await openCitation(page, await ask(), 'popover');
  const interactive = [fromFinding, fromChat, fromQa, fromChecklist];
  say('only-interactive-citations-get-the-pointer-cursor', findingCursors.length >= 4
    && findingCursors.every((value) => value === 'pointer') && checklistCursor === 'pointer'
    && interactive.every(({ pointer, focused }) => pointer === 'pointer' && focused)
    && readOnlyCursor === 'default' && untabbable && staysInQa && page.errors.length === 0,
    JSON.stringify({ findingCursors, checklistCursor, interactive, readOnlyCursor, untabbable, staysInQa }));
  await ctx.close();
}

await browser.close();
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
