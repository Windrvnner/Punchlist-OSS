// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { csvCodec } from '../../src/adapters/spreadsheet';
import {
  checklistReviewCounts, checklistReviewPlan, checklistSelection, checklistShelf, checklistWordingChoices, listTarget,
  requestChecklistReview, retryChecklistDuplicates, retryChecklistWording, reviewChecklist, submitChecklist,
} from '../../src/app/checklistImport';
import { importKey, initializeKeptImports, keptImport, keptImportsReady, saveImport } from '../../src/app/keptImports';
import {
  checklistItemsAsRead, checklistPaste, checklistReadCounts, checklistSourceLines, loadChecklistSource,
  readChecklist, readChecklistColumns, tieChecklistLines,
} from '../../src/app/listRead';
import { firmOf, listId, norm } from '../../src/domain/checklist';
import type { LineRead } from '../../src/domain/listRead';
import { fail, ok } from '../../src/domain/result';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp } from './recoveryKit';

const HEADING = 'Portfolio project diligence';
const NOTE = 'Cover note for counsel';
const OPTIONS = { askReword: true, askSame: true };

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function readyApp() {
  const port = new MemoryKeptImports();
  initializeKeptImports(port);
  await keptImportsReady;
  const app = recoveryApp();
  await app.store.boot();
  return { ...app, port };
}

function modelRead(line: string, index: number, last: number): LineRead[] {
  const n = index + 1;
  if (index === 0) return [{ n, k: 'section', text: line }];
  if (index === last) return [{ n, k: 'left' }];
  return line ? [{ n, k: 'item', text: line }] : [];
}

async function preparePaste(app: Awaited<ReturnType<typeof readyApp>>, questions: string[]) {
  const paste = [HEADING, '', ...questions, questions[0], NOTE].join('\n');
  const source = checklistPaste(paste)!;
  const lines = checklistSourceLines(source, null)!;
  const answers = lines.flatMap((line, at) => modelRead(line, at, lines.length - 1));
  const readList = vi.fn<NonNullable<typeof app.store.services.ai.readList>>(async ({ only }) =>
    ok(only ? answers.filter(({ n }) => only.includes(n)) : answers.filter(({ n }) => n !== 4)));
  app.store.services.ai.readList = readList;
  const reads = value(await readChecklist(app.store, lines));
  const tied = tieChecklistLines(lines, reads)!;
  const prepared = checklistItemsAsRead(false, null, { item: null, section: null }, tied)!;
  expect(readList.mock.calls.map(([request]) => request.only)).toEqual([undefined, [4]]);
  expect(checklistReadCounts(null, lines, source)).toEqual({ lines: 2_380, pasted: 2_380, rows: 0 });
  expect(tied.count).toEqual({ lines: 2_380, items: 2_377, headings: 1, blank: 1, more: 0, left: 1 });
  expect(tied.left).toEqual([2_380]);
  expect(tied.items[0]).toEqual({ text: norm(questions[0]), section: HEADING, lines: [3] });
  expect(tieChecklistLines(lines, reads, new Set(tied.left))?.items.at(-1)?.text).toBe(NOTE);
  return { paste, source, reads, prepared };
}

function modelReview(app: Awaited<ReturnType<typeof readyApp>>) {
  const reword = vi.fn<NonNullable<typeof app.store.services.ai.reword>>(async () => ok([
    { at: 1, text: 'Confirm the agreement assignment to the project company', why: 'Use a direct request' },
    { at: 2, text: 'Provide the current net yield estimate', why: 'Separate the requests',
      also: ['Identify the preparer of the energy yield report'] },
    { at: 2_376, text: 'Provide alternative wording for the repeated request', why: 'Use a direct request' },
  ]));
  const pair = { a: 3, b: 4, inAgainst: false, why: 'Requests the same agreement' };
  const sameMeaning = vi.fn<NonNullable<typeof app.store.services.ai.sameMeaning>>(async ({ only }) =>
    ok(only ? { pairs: [pair] } : { pairs: [], missed: { kind: 'unreachable', at: [3] } }));
  app.store.services.ai.reword = reword;
  app.store.services.ai.sameMeaning = sameMeaning;
  return { reword, sameMeaning, pair };
}

it('ties out, reviews, and brings in a pasted portfolio checklist without a component', async () => {
  const app = await readyApp();
  try {
    const questions = portfolioQuestions();
    const { paste, source, reads, prepared } = await preparePaste(app, questions);
    const { store, port } = app;
    const { reword, sameMeaning, pair } = modelReview(app);
    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'broad', '');
    const plan = checklistReviewPlan(state.can, prepared.items, target, OPTIONS, null, '');
    expect(plan.needsCall).toBe(true);
    const replies = await requestChecklistReview(store, plan.texts, OPTIONS, target.generalTexts);
    const { review } = reviewChecklist(state.can, prepared.items, target, OPTIONS, replies);
    expect(checklistReviewCounts(review)).toEqual({ suggestions: 2, duplicates: 1, missed: 1 });
    expect(review.pairs).toEqual([{ a: 0, b: 2_376, inAgainst: false, why: 'Worded the same' }]);
    expect(reword).toHaveBeenCalledWith({ items: plan.texts });
    expect(checklistReviewPlan(state.can, prepared.items, target, OPTIONS, review, plan.signature).cached).toBe(review);
    const retried = await retryChecklistDuplicates(store, review, target.generalTexts);
    expect(retried.review.pairs).toEqual([...review.pairs, pair]);
    expect(sameMeaning).toHaveBeenLastCalledWith({ items: plan.texts, against: [], only: [3] });
    const remove = new Set([2_376]);
    const useReword = new Set([1, 2]);
    expect(checklistWordingChoices(retried.review, remove, useReword, false))
      .toEqual({ eligible: [1, 2], allChecked: true });
    const selected = checklistSelection(retried.review, remove, useReword);
    expect(selected.counts).toEqual({ items: 2_377, reworded: 1, split: 1, removed: 1 });
    expect(selected.items.slice(1, 4).map(({ was }) => was)).toEqual([questions[1], questions[2], questions[2]]);

    const refreshed = { at: 3, text: 'List current permits and appeals', why: 'Use a direct request' };
    reword.mockResolvedValueOnce(ok([refreshed]));
    const wording = await retryChecklistWording(store, retried.review);
    expect(wording.review.rewords).toEqual([...retried.review.rewords, refreshed]);
    expect(wording.review.pairs).toEqual(retried.review.pairs);
    const key = importKey.checklist();
    const snapshot = { paste, text: source, reads, review: wording.review, choices: { remove, useReword } };
    expect(await saveImport(key, snapshot)).toBe(true);
    initializeKeptImports(port);
    await keptImportsReady;
    expect(keptImport(key)?.choices).toEqual({ remove, useReword });
    value(await submitChecklist(store, key, target, selected.items, ''));
    expect(store.get().firmList[listId('broad', '')].items).toEqual(selected.items);
    expect(checklistShelf(store.get()).totals).toEqual({ lists: 1, items: 2_377, general: true, others: 0 });
    expect(keptImport(key)).toBeUndefined();
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

async function portfolioFile(questions: string[]) {
  const workstream = 'Project agreements';
  const rows = questions.map((text) => [workstream, text, 'Financing']);
  const csv = value(await csvCodec.write('Sheet1', [
    ['Portfolio', 'Financing', 'Checklist'],
    ['Section', 'Requirement', 'Subsection'],
    ...rows,
    [workstream, '', 'Outstanding'],
    rows[0],
  ]));
  return new File([csv.bytes.slice().buffer], 'Portfolio checklist.csv');
}

it('re-reads a portfolio spreadsheet by hand after the model fails, preserving its rows and counts', async () => {
  const app = await readyApp();
  try {
    const questions = portfolioQuestions();
    const { store } = app;
    const source = value(await loadChecklistSource(store, await portfolioFile(questions)));
    if (!('table' in source)) throw new Error('Expected a checklist table');
    expect(source.table.headerRow).toBe(1);
    const lines = checklistSourceLines(null, source.table)!;
    expect(lines[0]).toBe('Portfolio | Financing | Checklist');
    expect(lines[1]).toBe('Section | Requirement | Subsection');
    const unavailable = fail({ kind: 'unreachable', message: 'Could not reach the model' });
    store.services.ai.readList = async () => unavailable;
    expect(await readChecklist(store, lines)).toEqual(unavailable);
    const { table, mapping } = value(await readChecklistColumns(store, source.table, { headerRow: 2 }, true));
    expect(table.headerRow).toBe(2);
    expect(mapping).toEqual({ item: 1, section: 0, subsection: 2 });
    expect(checklistReadCounts(table, checklistSourceLines(null, table), null)).toEqual({
      rows: 2_378, lines: 2_379, pasted: 0,
    });
    const prepared = checklistItemsAsRead(true, table, mapping, null)!;
    expect(prepared.count).toBe(2_377);
    expect(prepared.skipped).toBe(1);
    expect(prepared.items.map(({ text }) => text)).toEqual([...questions, questions[0]].map(norm));
    expect(prepared.items.at(-1)).toMatchObject({ section: 'Project agreements', subsection: 'Financing' });
    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'technology', 'Renewables');
    const options = { ...OPTIONS, askReword: false };
    store.services.ai.sameMeaning = async () => ok({ pairs: [] });
    const plan = checklistReviewPlan(state.can, prepared.items, target, options, null, '');
    const replies = await requestChecklistReview(store, plan.texts, options, target.generalTexts);
    const { review } = reviewChecklist(state.can, prepared.items, target, options, replies);
    expect(review.pairs).toEqual([{ a: 0, b: 2_376, inAgainst: false, why: 'Worded the same' }]);
    const selected = checklistSelection(review, new Set([2_376]), new Set());
    expect(selected.counts).toEqual({ items: 2_376, reworded: 0, split: 0, removed: 1 });
    value(await submitChecklist(store, importKey.checklist(), target, selected.items, table.name));
    const saved = store.get().firmList[listId('technology', 'Renewables')];
    expect(saved).toMatchObject({ file: table.name, items: selected.items });
    expect(checklistShelf(store.get()).totals).toEqual({ lists: 1, items: 2_376, general: false, others: 1 });
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});
