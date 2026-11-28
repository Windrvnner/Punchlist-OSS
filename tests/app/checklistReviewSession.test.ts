// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { ChecklistImportSession } from '../../src/app/checklistImportSession';
import { importKey, initializeKeptImports, keptImport, keptImportsReady } from '../../src/app/keptImports';
import { BringInList } from '../../src/app/commands/checklist';
import { listId } from '../../src/domain/checklist';
import { fail, ok } from '../../src/domain/result';
import { checklistSpreadsheet } from '../fixtures/checklistSpreadsheet';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { ELSEWHERE } from '../adapters/memRepo';
import { copyRecoveryDisk, holdRecoveryWrite, recoveryApp } from './recoveryKit';

const key = importKey.checklist();
let app: ReturnType<typeof recoveryApp>;
let drafts: MemoryKeptImports;
const sessions: ChecklistImportSession[] = [];
beforeEach(async () => {
  drafts = new MemoryKeptImports();
  initializeKeptImports(drafts);
  await keptImportsReady;
  app = recoveryApp();
  app.store.services.sheets = checklistSpreadsheet;
  await app.store.boot();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  app.store.closing();
  await app.repo.close();
});

function open() {
  app.store.ui({ firmChecklist: { step: 'import' } });
  const session = new ChecklistImportSession(app.store, {});
  sessions.push(session);
  void session.start();
  return session;
}

it('imports the section and subsection remapped after Back (#56)', async () => {
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  const questions = portfolioQuestions().slice(0, 2_000);
  const headers = ['Area', 'Other area', 'Subsection', 'Other subarea', 'Item'];
  const rows = questions.map((text) => ['Operations', 'Financing', 'Reports', 'Supporting records', text]);
  const encoded = await checklistSpreadsheet.write('Sheet1', [headers, ...rows]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const file = new File([encoded.value.bytes.slice().buffer], 'Portfolio requests.ods');
  const session = open();
  session.setAskReword(false);
  session.setAskSame(false);
  await session.load(file);
  await session.chooseColumns();
  await session.next();
  expect(session.view.step).toBe('review');
  session.backToList();
  session.pickColumn('section', 1);
  session.pickColumn('subsection', 3);
  await session.next();
  await session.bringIn();
  expect(app.store.get().firmList[listId('broad', '')]?.items).toEqual(questions.map((text) => ({
    text, section: 'Financing', subsection: 'Supporting records',
  })));
});

function priorItems(questions: string[], technology: string) {
  return questions.slice(0, 120).map((was) => ({
    text: `${was} Include ${technology} project documents.`, was,
  }));
}

async function technologyReview(questions: string[], name: string, compare = false, reword = false) {
  app.store.services.ai.readList = async ({ lines }) => ok({
    lines: lines.map((_, index) => ({ n: index + 1, k: 'item' })),
  });
  app.store.services.ai.sameMeaning = async () => ok({ pairs: [] });
  const session = open();
  session.setLayer('technology');
  session.setName(name);
  session.setAskReword(reword);
  session.setAskSame(compare);
  session.setPaste(questions.join('\n'));
  await session.pasted();
  await session.next();
  return session;
}

it.each([
  { changed: 'name', layer: 'technology', name: 'Wind' },
  { changed: 'layer', layer: 'sector', name: 'Solar' },
] as const)('imports only the destination’s wording after changing its $changed (#56)', async ({ layer, name }) => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const solarItems = priorItems(questions, 'photovoltaic');
  const targetItems = priorItems(questions, 'grid connection');
  const lists = [
    { layer: 'technology' as const, name: 'Solar', items: solarItems },
    { layer, name, items: targetItems },
  ];
  for (const list of lists) {
    const result = await app.store.dispatch(BringInList, {
      list: { ...list, file: 'Prior requests.csv', fileDate: '' },
    });
    expect(result.ok).toBe(true);
  }
  const session = await technologyReview(questions, 'Solar');
  expect(session.view.listReview.useReword.size).toBe(120);
  expect(session.view.listReview.review?.rewords[0].text).toBe(solarItems[0].text);
  session.flipReword(0);
  session.backToList();
  await session.next();
  expect(session.view.listReview.useReword.has(0)).toBe(false);
  session.backToList();
  if (layer === 'technology') session.setName(name);
  else session.setLayer(layer);
  session.close();
  const reopened = open();
  await reopened.next();
  expect(reopened.view.listReview.review?.rewords.map(({ text }) => text)).toEqual(targetItems.map(({ text }) => text));
  await reopened.bringIn();
  const saved = app.store.get().firmList;
  const originalItems = questions.slice(120).map((text) => ({ text }));
  expect(saved[listId(layer, name)]?.items).toEqual([...targetItems, ...originalItems]);
  expect(saved[listId('technology', 'Solar')]?.items).toEqual(solarItems);
});

it('preserves wording changed on another PC while the list is in review (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const items = priorItems(questions, 'offshore wind');
  const name = 'Wind';
  const id = listId('technology', name);
  expect((await app.store.dispatch(BringInList, {
    list: { layer: 'technology', name, items, file: 'Prior requests.csv', fileDate: '' },
  })).ok).toBe(true);
  const session = await technologyReview(questions, name);
  const before = app.store.get().firmList[id];
  const updatedItems = priorItems(questions, 'onshore wind');
  app.repo.peer.change('firmList', id, { ...before, items: updatedItems, rev: before.rev + 1 }, ELSEWHERE);
  await app.store.refreshSync();
  expect(app.store.get().firmList[id].items).toEqual(updatedItems);
  await session.bringIn();
  expect(app.store.get().firmList[id].items[0]).toEqual(updatedItems[0]);
  expect(keptImport(key)).toBeDefined();

  session.backToList();
  await session.next();
  await session.bringIn();
  expect(app.store.get().firmList[id].items).toEqual([
    ...updatedItems, ...questions.slice(120).map((text) => ({ text })),
  ]);
});

it.each([
  { field: 'section', column: 1, section: 'Financing', subsection: 'Reports' },
  { field: 'subsection', column: 3, section: 'Operations', subsection: 'Supporting records' },
] as const)('keeps checked wording while remapping only $field (#56)', async (mapping) => {
  const { field, column, section, subsection } = mapping;
  const questions = portfolioQuestions().slice(0, 2_000);
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  const text = 'Provide the executed EPC contract and appendices.';
  const reword = vi.fn(async () => ok([{ at: 0, text, why: '' }]));
  app.store.services.ai.reword = reword;
  const rows = questions.map((question) => ['Operations', 'Financing', 'Reports', 'Supporting records', question]);
  const headers = ['Section', 'Alternate area', 'Subsection', 'Alternate subsection', 'Item'];
  const encoded = await checklistSpreadsheet.write('Sheet1', [headers, ...rows]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const session = open();
  await session.load(new File([encoded.value.bytes.slice().buffer], 'Portfolio checklist.ods'));
  session.setAskReword(true);
  session.setAskSame(false);
  await session.chooseColumns();
  await session.next();
  session.flipReword(0);
  session.backToList();
  session.pickColumn(field, column);
  await session.next();
  expect(session.view.listReview.useReword.has(0)).toBe(true);
  expect(reword).toHaveBeenCalledTimes(1);
  await session.bringIn();
  const items = app.store.get().firmList[listId('broad', '')]?.items;
  expect(items).toHaveLength(2_000);
  expect(items?.[0]).toEqual({ text, was: questions[0], section, subsection });
});

async function savePriorList(layer: 'broad' | 'technology', name: string, items: { text: string }[]) {
  expect((await app.store.dispatch(BringInList, {
    list: { layer, name, items, file: 'Prior requests.csv', fileDate: '' },
  })).ok).toBe(true);
  return listId(layer, name);
}

function peerChangesList(id: string, items: { text: string }[]) {
  const before = app.store.get().firmList[id];
  app.repo.peer.change('firmList', id, { ...before, items, rev: before.rev + 1 }, ELSEWHERE);
}

it('imports a reopened draft’s checked removals after an unrelated General addition (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const general = questions.slice(0, 120).map((text) => ({ text }));
  await savePriorList('broad', '', general);
  const session = await technologyReview(questions, 'Wind', true);
  expect(session.view.listReview.review?.pairs).toHaveLength(120);
  for (let at = 0; at < 120; at++) session.flipRemove(at);
  session.close();
  await savePriorList('broad', '', [...general, { text: 'Provide the executed water supply agreement.' }]);
  const reopened = open();
  expect(reopened.view.step).toBe('review');
  await reopened.bringIn();
  expect(reopened.view.work.error).toBe('');
  expect(app.store.get().firmList[listId('technology', 'Wind')].items)
    .toEqual(questions.slice(120).map((text) => ({ text })));
});

it('preserves a synced destination addition even without previously approved wording (#56)', async () => {
  const items = [{ text: 'Verify the original grid connection letter.' }];
  const id = await savePriorList('technology', 'Wind', items);
  const session = await technologyReview(portfolioQuestions().slice(0, 2_000), 'Wind');
  const added = [...items, { text: 'Provide the latest grid operator consent.' }];
  peerChangesList(id, added);
  await app.store.refreshSync();

  expect(session.view.canBringIn).toBe(true);
  await session.bringIn();
  expect(app.store.get().firmList[id].items).toHaveLength(2);
  expect(app.store.get().firmList[id].items).toEqual(added);
  expect(keptImport(key)).toBeDefined();
  expect(session.view.work.error).toContain('The list changed');
});

it.each(['before Import', 'at commit', 'before repeat Import'])('keeps draft if General changes %s', async (when) => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const edited = 'Provide the latest independent energy yield report.';
  app.store.services.ai.reword = async () => ok([{ at: 120, text: edited, why: '' }]);
  const general = questions.slice(0, 120).map((text) => ({ text }));
  const id = await savePriorList('broad', '', general);
  const wind = listId('technology', 'Wind');
  const repeat = when === 'before repeat Import';
  if (repeat) {
    const items = [{ text: edited, was: questions[120] }, ...questions.slice(121).map((text) => ({ text }))];
    expect((await app.store.dispatch(BringInList, {
      list: { layer: 'technology', name: 'Wind', items, file: '', fileDate: '' },
    })).ok).toBe(true);
  }
  const session = await technologyReview(questions, 'Wind', true, true);
  if (!repeat) session.flipReword(120);
  expect(session.view.listReview.review?.pairs).toHaveLength(120);
  for (let index = 0; index < 120; index++) session.flipRemove(index);
  const changed = [{ text: 'Confirm all lender notice periods and deliverables.' }, ...general.slice(1)];

  if (when !== 'at commit') {
    peerChangesList(id, changed);
    if (!repeat) await app.store.refreshSync();
    await session.bringIn();
  } else {
    const held = holdRecoveryWrite(app, (tx) => tx.writes.some((write) => write.kind === 'firmList'));
    const importing = session.bringIn();
    await held.entered;
    peerChangesList(id, changed);
    held.release();
    await importing;
  }

  expect(app.store.get().firmList[wind]?.items.length ?? 0).toBe(repeat ? 1_880 : 0);
  expect(session.view.work.error).not.toBe('');
  expect(keptImport(key)).toBeDefined();
  expect(session.view.listReview.review?.generalTexts[0]).toBe(questions[0]);
  await app.store.refreshSync();
  session.backToList();
  await session.next();
  expect(session.view.listReview.review?.pairs).toHaveLength(119);
  expect(session.view.listReview.remove.size).toBe(119);
  expect(session.view.listReview.useReword.has(120)).toBe(true);
  await session.bringIn();
  expect(app.store.get().firmList[wind].items[0]?.text).toBe(questions[0]);
  expect(app.store.get().firmList[wind].items[1]?.text).toBe(edited);
});

it('checks duplicate removals against the General items held in both versions (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const general = questions.slice(0, 120).map((text) => ({ text }));
  const id = await savePriorList('broad', '', general);
  const session = await technologyReview(questions, 'Wind', true);
  for (let index = 0; index < 120; index++) session.flipRemove(index);
  const before = app.store.get().firmList[id];
  const changed = { ...before, items: general.slice(1) };
  expect(app.repo.peer.edit('firmList', id, changed, { ...ELSEWHERE, at: '2026-11-20T10:00:00.000Z' }))
    .toBe('conflict');
  await app.store.refreshSync();
  expect(app.store.get().conflicts[id]?.versions).toHaveLength(2);
  expect(app.store.get().firmList[id].items[0]?.text).toBe(questions[0]);

  const wind = listId('technology', 'Wind');
  await session.bringIn();
  expect(app.store.get().firmList[wind]?.items.length ?? 0).toBe(0);
  expect(keptImport(key)).toBeDefined();
  session.backToList();
  await session.next();
  const review = session.view.listReview.review;
  expect(review?.pairs).toHaveLength(119);
  expect(review?.pairs.some(({ a }) => a === 0)).toBe(false);
  expect(session.view.listReview.remove.size).toBe(119);
  await session.bringIn();
  expect(app.store.get().firmList[wind].items).toHaveLength(1_881);
  expect(app.store.get().firmList[wind].items[0]?.text).toBe(questions[0]);
});

it('rechecks a changed prior approval and keeps another row’s wording choice (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const name = 'Wind';
  const edited = 'Provide the latest independent energy yield report.';
  app.store.services.ai.reword = async () => ok([{ at: 120, text: edited, why: '' }]);
  const items = priorItems(questions, 'offshore wind');
  const id = await savePriorList('technology', name, items);
  const session = await technologyReview(questions, name, false, true);
  session.flipReword(1);
  session.flipReword(120);
  const changed = [...items];
  changed[0] = { ...items[0], text: 'Provide the amended offshore turbine EPC agreement.' };
  peerChangesList(id, changed);
  await app.store.refreshSync();
  await session.bringIn();
  expect(app.store.get().firmList[id].items[0]).toEqual(changed[0]);
  session.backToList();
  await session.next();
  expect(session.view.listReview.review?.rewords[0].text).toBe(changed[0].text);
  expect(session.view.listReview.useReword.has(1)).toBe(false);
  expect(session.view.listReview.useReword.has(120)).toBe(true);
  await session.bringIn();
  expect(app.store.get().firmList[id].items[0]).toEqual(changed[0]);
  expect(app.store.get().firmList[id].items[1]).toEqual({ text: questions[1] });
  expect(app.store.get().firmList[id].items[120]).toEqual({ text: edited, was: questions[120] });
});

it('keeps other choices after a list replacement and a reopened Section remap (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const wording = 'Provide the latest independent energy yield report.';
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  app.store.services.ai.reword = async () => ok([{ at: 120, text: wording, why: '' }]);
  const sections = questions.map((question) => ['Operations', 'Financing', question]);
  const encoded = await checklistSpreadsheet.write('Sheet1', [['Section', 'Alternate area', 'Item'], ...sections]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const prior = priorItems(questions, 'offshore wind');
  const id = await savePriorList('technology', 'Wind', prior);
  const session = open();
  session.setLayer('technology');
  session.setName('Wind');
  await session.load(new File([encoded.value.bytes.slice().buffer], 'Portfolio checklist.ods'));
  session.setAskReword(true);
  session.setAskSame(false);
  await session.chooseColumns();
  await session.next();
  session.flipReword(1);
  session.flipReword(120);
  session.backToList();
  session.close();

  const updated = [...prior];
  updated[0] = { ...prior[0], text: 'Provide the amended offshore turbine EPC agreement.' };
  await savePriorList('technology', 'Wind', updated);
  const reopened = open();
  reopened.pickColumn('section', 1);
  await reopened.next();
  expect(reopened.view.listReview.review?.rewords[0].text).toBe(updated[0].text);
  expect(reopened.view.listReview.review?.items[1].section).toBe('Financing');
  expect(reopened.view.listReview.useReword.has(1)).toBe(false);
  expect(reopened.view.listReview.useReword.has(120)).toBe(true);
  await reopened.bringIn();
  const final = app.store.get().firmList[id].items;
  expect(final).toHaveLength(2_000);
  expect([final[0], final[1], final[120]]).toEqual([
    { ...updated[0], section: 'Financing' },
    { text: questions[1], section: 'Financing' },
    { text: wording, was: questions[120], section: 'Financing' },
  ]);
});

it('restores checks only for identical wording returned after a failed refresh and restart (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const wording = { at: 120, text: 'Provide the latest independent energy yield report.', why: '' };
  const split = {
    at: 121, text: 'Confirm the current grid connection capacity.',
    also: ['Provide the latest grid connection agreement.'], why: '',
  };
  app.store.services.ai.reword = async () => ok([wording, split]);
  const prior = priorItems(questions, 'offshore wind');
  const id = await savePriorList('technology', 'Wind', prior);
  const session = await technologyReview(questions, 'Wind', false, true);
  session.flipReword(120);
  session.flipReword(121);
  session.backToList();
  const updated = prior.map((item, at) => at === 2 ? { text: questions[at] } : item);
  updated[0] = { ...prior[0], text: 'Provide the amended offshore turbine EPC agreement.' };
  await savePriorList('technology', 'Wind', updated);
  app.store.services.ai.reword = async () => fail({ kind: 'unreachable', message: 'Wording service unavailable' });
  await session.next();
  expect(session.view.listReview.review?.asked.reword).toBe('unreachable');
  expect(session.view.listReview.useReword.has(120)).toBe(false);
  await session.retryWording();
  expect(session.view.listReview.review?.asked.reword).toBe('unreachable');
  session.close();

  const saved = copyRecoveryDisk(app.saved);
  app.store.closing();
  await app.repo.close();
  app = recoveryApp(saved);
  await app.store.boot();
  initializeKeptImports(drafts);
  await keptImportsReady;
  const reopened = open();
  expect(reopened.view.step).toBe('review');
  const changedSplit = { ...split, also: ['Provide an executed amendment to the grid connection agreement.'] };
  const revoked = { at: 2, text: prior[2].text, why: '' };
  app.store.services.ai.reword = async () => ok([revoked, wording, changedSplit]);
  await reopened.retryWording();
  expect(reopened.view.listReview.review?.rewords.slice(-2)).toEqual([wording, changedSplit]);
  expect(reopened.view.listReview.useReword.has(120)).toBe(true);
  expect(reopened.view.listReview.useReword.has(revoked.at)).toBe(false);
  expect(reopened.view.listReview.useReword.has(121)).toBe(false);
  await reopened.bringIn();
  const final = app.store.get().firmList[id].items;
  expect(final).toHaveLength(2_000);
  expect(final[0]).toEqual(updated[0]);
  expect(final[2]).toEqual(updated[2]);
  expect(final[120]).toEqual({ text: wording.text, was: questions[120] });
  expect(final[121]).toEqual({ text: questions[121] });
});

it('keeps checks after a failed sheet read and starts over on an accepted new sheet (#56)', async () => {
  const text = 'Confirm the executed interconnection agreement.';
  const revised = 'Provide the executed interconnection agreement and its amendments.';
  app.store.services.sheets = { ...checklistSpreadsheet, read: async (_bytes, _name, options) =>
    options?.sheet === 'Unavailable'
      ? fail({ kind: 'failed', message: 'Could not read sheet' })
      : ok({ sheet: options?.sheet ?? 'Main', sheets: ['Main', 'Supplement'], columns: ['Item'], rows: [[text]] }),
  };
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  app.store.services.ai.reword = async () => ok([{ at: 0, text: revised, why: '' }]);
  const session = open();
  await session.load(new File(['test workbook'], 'Checklist.ods'));
  session.setAskReword(true);
  session.setAskSame(false);
  await session.chooseColumns();
  await session.next();
  session.flipReword(0);
  session.backToList();
  await session.reread({ sheet: 'Unavailable' });
  await session.next();
  expect(session.view.listReview.useReword.has(0)).toBe(true);

  session.backToList();
  await session.reread({ sheet: 'Supplement' });
  await session.next();
  expect(session.view.source.table?.sheet).toBe('Supplement');
  expect(session.view.listReview.review?.rewords[0]?.text).toBe(revised);
  expect(session.view.listReview.useReword.has(0)).toBe(false);
});

it('keeps removals through a failed refresh and accepts new choices during partial Retry (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const pairs = Array.from({ length: 120 }, (_, index) => ({
    a: 120 + index, b: 240 + index, inAgainst: false, why: '',
  }));
  const [first, , alternative, changed] = pairs;
  for (const { a, b } of pairs) questions[b] = `Diligence request: ${questions[a]}`;
  questions[500] = `For the lender review: ${questions[alternative.a]}`;
  questions[501] = `Please respond to this request: ${questions[changed.a]}`;
  app.store.services.ai.reword = async () => ok([]);
  const prior = priorItems(questions, 'offshore wind');
  const id = await savePriorList('technology', 'Wind', prior);
  const session = await technologyReview(questions, 'Wind', false, true);
  session.backToList();
  session.setAskSame(true);
  app.store.services.ai.sameMeaning = async () => ok({ pairs });
  await session.next();
  for (const { a } of pairs) session.flipRemove(a);
  expect(session.view.listReview.remove.size).toBe(120);
  session.backToList();

  const updated = [...prior];
  updated[0] = { ...prior[0], text: 'Provide the amended offshore turbine EPC agreement.' };
  await savePriorList('technology', 'Wind', updated);
  const unavailable = { kind: 'unreachable' as const, message: 'Duplicate service unavailable' };
  app.store.services.ai.sameMeaning = async () => fail(unavailable);
  await session.next();
  expect(session.view.listReview.review?.asked.same).toBe('unreachable');
  expect(session.view.listReview.remove.size).toBe(0);

  app.store.services.ai.sameMeaning = async () => ok({
    pairs: [first, { ...alternative, b: 500 }],
    missed: { kind: 'unreachable', at: pairs.slice(1).map(({ a }) => a) },
  });
  await session.retry();
  expect(session.view.listReview.remove).toEqual(new Set([first.a]));
  session.flipRemove(first.a);
  session.flipRemove(alternative.a);
  session.flipRemove(alternative.a);

  app.store.services.ai.sameMeaning = async () => ok({
    pairs: pairs.slice(1).map((pair) => pair === changed ? { ...pair, b: 501 } : pair),
  });
  await session.retry();
  expect(session.view.listReview.remove.size).toBe(117);
  for (const { a } of [first, alternative, changed]) expect(session.view.listReview.remove.has(a)).toBe(false);
  await session.bringIn();
  const saved = app.store.get().firmList[id].items;
  expect(saved).toHaveLength(1_883);
  expect(saved[0]).toEqual(updated[0]);
  expect(saved.some(({ text }) => text === questions[pairs[1].a])).toBe(false);
});
