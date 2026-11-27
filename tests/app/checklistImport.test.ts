// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { csvCodec } from '../../src/adapters/spreadsheet';
import {
  checklistReviewCounts, checklistReviewSession, checklistSelection, checklistShelf, checklistWordingChoices,
  listTarget, submitChecklist, type ChecklistReviewChange,
} from '../../src/app/checklistImport';
import { importKey, initializeKeptImports, keptImport, keptImportsReady, saveImport } from '../../src/app/keptImports';
import {
  checklistItemsAsRead, checklistPaste, checklistReadCounts, checklistReading, checklistRequests, checklistSourceLines,
  loadChecklistSource, readChecklistColumns, rereadChecklistTable, tieChecklistLines,
} from '../../src/app/listRead';
import { firmOf, listId, norm } from '../../src/domain/checklist';
import type { LineRead, ListReply } from '../../src/domain/listRead';
import { fail, ok, type Result } from '../../src/domain/result';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp } from './recoveryKit';

const HEADING = 'Portfolio project diligence';
const NOTE = 'Cover note for counsel';
const OPTIONS = { askReword: true, askSame: true };
const READ_EVENTS = { started: () => {}, finished: () => {} };
const REVIEW_EVENTS = { started: () => {}, settled: () => {} };

function shownReview<Kind extends ChecklistReviewChange['kind']>(
  change: ChecklistReviewChange | undefined, kind: Kind,
) {
  if (change?.kind !== kind) throw new Error(`Expected a ${kind} review`);
  return change as Extract<ChecklistReviewChange, { kind: Kind }>;
}

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
  if (index === 0) return [{ n, k: 'section' }];
  if (index === last) return [{ n, k: 'left' }];
  return line ? [{ n, k: 'item' }] : [];
}

const modelReading = (lines: string[]) => ({ lines: lines.flatMap((l, k) => modelRead(l, k, lines.length)) });

async function preparePaste(app: Awaited<ReturnType<typeof readyApp>>, questions: string[]) {
  const paste = [HEADING, '', ...questions, questions[0], NOTE].join('\n');
  const source = checklistPaste(paste)!;
  const lines = checklistSourceLines(source, null)!;
  const answers = lines.flatMap((line, at) => modelRead(line, at, lines.length - 1));
  const readList = vi.fn<NonNullable<typeof app.store.services.ai.readList>>(async ({ thorough }) =>
    ok({ lines: thorough ? answers : answers.filter(({ n }) => n !== 4) }));
  app.store.services.ai.readList = readList;
  const reading = checklistReading(app.store, checklistRequests());
  const reads = value((await reading.sourceChanged(lines, false, READ_EVENTS))!);
  const tied = tieChecklistLines(lines, reads)!;
  const prepared = checklistItemsAsRead(false, null, { item: null, section: null }, tied)!;
  expect(readList.mock.calls.map(([request]) => request.thorough)).toEqual([undefined, true]);
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
    const session = checklistReviewSession(store, checklistRequests(), REVIEW_EVENTS);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const plan = session.plan(prepared.items, target, OPTIONS, null, '')!;
    expect(plan.needsCall).toBe(true);
    await session.next(plan, show);
    const { review } = shownReview(show.mock.lastCall?.[0], 'fresh');
    expect(checklistReviewCounts(review)).toEqual({ suggestions: 2, duplicates: 1, missed: 1 });
    expect(review.pairs).toEqual([{ a: 0, b: 2_376, inAgainst: false, why: 'Worded the same' }]);
    expect(reword).toHaveBeenCalledWith({ items: plan.texts });
    expect(session.plan(prepared.items, target, OPTIONS, review, plan.signature)?.cached).toBe(review);
    await session.duplicates(review, target.generalTexts, show);
    const retried = shownReview(show.mock.lastCall?.[0], 'retry');
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
    await session.wording(retried.review, show);
    const wording = shownReview(show.mock.lastCall?.[0], 'retry');
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
    const reading = checklistReading(store, checklistRequests());
    expect(await reading.sourceChanged(lines, false, READ_EVENTS)).toEqual(unavailable);
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
    const session = checklistReviewSession(store, checklistRequests(), REVIEW_EVENTS);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const plan = session.plan(prepared.items, target, options, null, '')!;
    await session.next(plan, show);
    const { review } = shownReview(show.mock.lastCall?.[0], 'fresh');
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

it('resumes unfinished reading and skips the initial read for a kept result or failure', async () => {
  const app = await readyApp();
  try {
    const primary = portfolioQuestions();
    const revised = [HEADING, ...primary.slice(1)];
    const { store } = app;
    const model = vi.fn<NonNullable<typeof store.services.ai.readList>>(async ({ lines }) => ok(modelReading(lines)));
    store.services.ai.readList = model;
    const events = { started: vi.fn(), finished: vi.fn() };
    const unfinished = checklistReading(store, checklistRequests(), { reads: null, readFailed: '' });
    const restored = value((await unfinished.sourceChanged(primary, false, events))!);
    expect(restored.reads.size).toBe(primary.length);
    expect(await unfinished.sourceChanged(primary, false, events)).toBeUndefined();

    const complete = checklistReading(store, checklistRequests(), { reads: restored });
    expect(await complete.sourceChanged(primary, false, events)).toBeUndefined();
    const failed = checklistReading(store, checklistRequests(), { readFailed: 'unreachable' });
    expect(await failed.sourceChanged(primary, false, events)).toBeUndefined();
    expect(events.started).toHaveBeenCalledTimes(1);
    expect((await complete.sourceChanged(revised, false, events))?.ok).toBe(true);
    expect((await failed.retry(primary, false, events))?.ok).toBe(true);
    expect(model.mock.calls.map(([input]) => input.lines)).toEqual([primary, revised, primary]);
    expect(events.started).toHaveBeenCalledTimes(3);
    expect(events.finished).toHaveBeenCalledTimes(3);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('keeps review input reserved for the latest worksheet read, including a read failure (#821)', async () => {
  const app = await readyApp();
  const originalRead = app.store.services.sheets.read;
  try {
    const { store } = app;
    const questions = portfolioQuestions();
    const source = value(await loadChecklistSource(store, await portfolioFile(questions)));
    if (!('table' in source)) throw new Error('Expected a checklist table');
    const requests = checklistRequests();
    const events = { started: vi.fn(), finished: vi.fn() };
    const read = vi.fn<typeof store.services.sheets.read>();
    const releases: (() => void)[] = [];
    read.mockImplementation(async (_bytes, _name, options) => {
      await new Promise<void>((resolve) => { releases.push(resolve); });
      if (options?.sheet === 'Unreadable') throw new Error('The worksheet could not be opened');
      return ok({ columns: ['Item'], sheet: options?.sheet, rows: questions.map((text) => [text]) });
    });
    store.services.sheets.read = read;
    const model = vi.fn<NonNullable<typeof store.services.ai.readList>>();
    store.services.ai.readList = model;
    const reading = checklistReading(store, requests);

    const earlier = rereadChecklistTable(store, requests, source.table, { sheet: 'Supplement' }, false, events);
    const latest = rereadChecklistTable(store, requests, source.table, { sheet: 'Unreadable' }, false, events);
    releases[0]();
    await earlier;
    expect(requests.tableReadPending()).toBe(true);
    expect(events.finished).not.toHaveBeenCalled();
    expect(await reading.retry(questions, false, READ_EVENTS)).toBeUndefined();
    expect(model).not.toHaveBeenCalled();

    releases[1]();
    await latest;
    expect(requests.tableReadPending()).toBe(false);
    expect(events.finished).toHaveBeenCalledExactlyOnceWith(fail({
      kind: 'failed', message: 'The worksheet could not be opened',
    }));
  } finally {
    app.store.services.sheets.read = originalRead;
    app.store.closing();
    await app.repo.close();
  }
});

/** A held worksheet read of `questions`, answered under the sheet's own name (#821). */
async function heldSheetRead(app: Awaited<ReturnType<typeof readyApp>>, questions: string[]) {
  const source = value(await loadChecklistSource(app.store, await portfolioFile(questions)));
  if (!('table' in source)) throw new Error('Expected a checklist table');
  const releases: (() => void)[] = [];
  const { sheets } = app.store.services;
  sheets.read = async (_bytes, _name, options) => {
    await new Promise<void>((resolve) => { releases.push(resolve); });
    return ok({ columns: ['Item'], sheet: options?.sheet, rows: questions.map((text) => [text]) });
  };
  return { table: source.table, releases };
}

it('holds Next, duplicates and wording while a worksheet read runs, whatever else takes a token (#821)', async () => {
  const app = await readyApp();
  // the services are shared with later tests' apps, so the real read goes back after
  const originalRead = app.store.services.sheets.read;
  try {
    const { store } = app;
    const questions = portfolioQuestions();
    const { table, releases } = await heldSheetRead(app, questions);
    const { reword, sameMeaning } = modelReview(app);
    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'broad', '');
    const requests = checklistRequests();
    const session = checklistReviewSession(store, requests, REVIEW_EVENTS);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const items = questions.map((text) => ({ text }));
    const plan = session.plan(items, target, OPTIONS, null, '')!;
    const events = { started: vi.fn(), finished: vi.fn() };

    const read = rereadChecklistTable(store, requests, table, { sheet: 'Supplement' }, false, events);
    requests.newToken();
    expect(requests.tableReadPending()).toBe(true);
    await session.next(plan, show);
    await session.duplicates({ items, rewords: [], pairs: [], asked: { reword: 'off', same: 'failed' } }, [], show);
    await session.wording({ items, rewords: [], pairs: [], asked: { reword: 'failed', same: 'off' } }, show);
    expect(show).not.toHaveBeenCalled();
    expect(reword).not.toHaveBeenCalled();
    expect(sameMeaning).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]();
    await read;
    expect(requests.tableReadPending()).toBe(false);
    await session.next(plan, show);
    expect(shownReview(show.mock.lastCall?.[0], 'fresh').review.items).toHaveLength(questions.length);
  } finally {
    app.store.services.sheets.read = originalRead;
    app.store.closing();
    await app.repo.close();
  }
});

it('makes a new review for the same wording in other sections, and not for the same items (#821)', async () => {
  const app = await readyApp();
  try {
    const { store } = app;
    const questions = portfolioQuestions();
    expect(questions.length).toBeGreaterThanOrEqual(2000);
    const { reword } = modelReview(app);
    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'broad', '');
    const session = checklistReviewSession(store, checklistRequests(), REVIEW_EVENTS);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const inSection = (section: string) => questions.map((text) => ({ text, section }));
    await session.next(session.plan(inSection('Old'), target, OPTIONS, null, '')!, show);
    const { review, signature } = shownReview(show.mock.lastCall?.[0], 'fresh');
    expect(session.plan(inSection('Old'), target, OPTIONS, review, signature)?.cached).toBe(review);

    const again = session.plan(inSection('New'), target, OPTIONS, review, signature)!;
    expect(again.cached).toBeNull();
    await session.next(again, show);
    expect(reword).toHaveBeenCalledTimes(2);
    const made = shownReview(show.mock.lastCall?.[0], 'fresh');
    expect(made.review.items.every((item) => item.section === 'New')).toBe(true);
    expect(session.plan(inSection('New'), target, OPTIONS, made.review, made.signature)?.cached).toBe(made.review);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('drops a worksheet read that never settles when the person changes the file (#821)', async () => {
  const app = await readyApp();
  const originalRead = app.store.services.sheets.read;
  try {
    const { table } = await heldSheetRead(app, portfolioQuestions());
    const requests = checklistRequests();
    void rereadChecklistTable(app.store, requests, table, { sheet: 'Supplement' }, false, READ_EVENTS);
    expect(requests.tableReadPending()).toBe(true);
    requests.dropTableReads();
    expect(requests.tableReadPending()).toBe(false);
  } finally {
    app.store.services.sheets.read = originalRead;
    app.store.closing();
    await app.repo.close();
  }
});

it('discards late model replies when the source changes or the dialog leaves', async () => {
  const app = await readyApp();
  try {
    const { store } = app;
    const lines = portfolioQuestions();
    const revised = [HEADING, ...lines.slice(1)];
    let release!: (result: Result<ListReply>) => void;
    const held = new Promise<Result<ListReply>>((resolve) => { release = resolve; });
    const model = vi.fn<NonNullable<typeof store.services.ai.readList>>(async (i) => ok(modelReading(i.lines)));
    model.mockReturnValueOnce(held);
    store.services.ai.readList = model;
    const requests = checklistRequests();
    const reading = checklistReading(store, requests);
    const events = { started: vi.fn(), finished: vi.fn() };
    const earlier = reading.sourceChanged(lines, false, events);
    const newer = await reading.sourceChanged(revised, false, events);
    expect(model.mock.calls[1][0].lines).toBe(revised);
    expect(value(newer!).reads.get(1)?.k).toBe('section');
    release(ok(modelReading(lines)));
    expect(await earlier).toBeUndefined();

    const retry = reading.retry(revised, false, events);
    requests.newToken();
    expect(await retry).toBeUndefined();
    expect(events.started).toHaveBeenCalledTimes(3);
    expect(events.finished).toHaveBeenCalledExactlyOnceWith(newer);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('preserves the stored checklist and choices after a refused headless submission', async () => {
  const app = await readyApp();
  try {
    const { port, store, repo } = app;
    const questions = portfolioQuestions();
    const paste = questions.join('\n');
    const key = importKey.checklist('technology', 'Renewables');
    const choices = { useReword: new Set([1, 20]), remove: new Set([8]) };
    const snapshot = { paste, text: checklistPaste(paste), choices };
    expect(await saveImport(key, snapshot)).toBe(true);
    const original = repo.transaction.bind(repo);
    repo.transaction = async (transaction) => transaction.writes.some((write) => write.kind === 'firmList')
      ? fail({ kind: 'storageFull', message: 'The disk is full' }) : original(transaction);

    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'technology', 'Renewables');
    const items = questions.map((text) => ({ text }));
    const result = await submitChecklist(store, key, target, items, '');
    expect(result).toMatchObject({ ok: false, error: { kind: 'storageFull' } });
    expect(store.get().firmList[listId('technology', 'Renewables')]).toBeUndefined();
    initializeKeptImports(port);
    await keptImportsReady;
    expect(keptImport(key)).toEqual(snapshot);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('serializes model reviews across a changed portfolio source and opens local review immediately (#378)', async () => {
  const app = await readyApp();
  try {
    const { store } = app;
    const items = portfolioQuestions().map((text) => ({ text }));
    const revised = [{ text: 'Provide the signed disbursement approvals for the refinancing.' }, ...items.slice(1)];
    const failed = { kind: 'unreachable' as const, at: [3, 8, 34] };
    type Compare = NonNullable<typeof store.services.ai.sameMeaning>;
    let finish!: (reply: Awaited<ReturnType<Compare>>) => void;
    const holding = new Promise<Awaited<ReturnType<Compare>>>((resolve) => { finish = resolve; });
    const compare = vi.fn<Compare>(async () => ok({ pairs: [] }))
      .mockResolvedValueOnce(ok({ pairs: [], missed: failed }))
      .mockReturnValueOnce(holding);
    store.services.ai.sameMeaning = compare;
    const wording = vi.fn<NonNullable<typeof store.services.ai.reword>>(async () => ok([]));
    store.services.ai.reword = wording;
    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'broad', '');
    const requests = checklistRequests();
    const events = { started: vi.fn(), settled: vi.fn() };
    const session = checklistReviewSession(store, requests, events);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const plan = session.plan(items, target, OPTIONS, null, '')!;
    await session.next(plan, show);
    const { review } = shownReview(show.mock.lastCall?.[0], 'fresh');

    const retry = session.duplicates(review, target.generalTexts, show);
    expect(compare.mock.lastCall?.[0].only).toEqual(failed.at);
    const pending = session.plan(revised, target, OPTIONS, review, plan.signature)!;
    expect(pending.waiting).toBe(true);
    await session.next(pending, show);
    await session.wording(review, show);
    expect(compare).toHaveBeenCalledTimes(2);
    expect(wording).toHaveBeenCalledTimes(1);

    const local = session.plan(revised, target, { askReword: false, askSame: false }, review, plan.signature)!;
    expect(local.waiting).toBe(false);
    session.next(local, show);
    const { review: localReview } = shownReview(show.mock.lastCall?.[0], 'fresh');
    expect(localReview).toMatchObject({ items: revised, asked: { reword: 'off', same: 'off' } });
    finish(fail({ kind: 'failed', message: 'The held review failed' }));
    await retry;
    expect(show).toHaveBeenCalledTimes(2);

    const next = session.plan(revised, target, OPTIONS, review, plan.signature)!;
    expect(next.waiting).toBe(false);
    await session.next(next, show);
    expect(compare.mock.lastCall?.[0]).toEqual({ items: revised.map(({ text }) => text), against: [] });
    expect(show).toHaveBeenCalledTimes(3);
    expect(events.started).toHaveBeenCalledTimes(3);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('keeps duplicate retry failures and cancels an older wording reply after Back (#378)', async () => {
  const app = await readyApp();
  try {
    const { store } = app;
    const items = portfolioQuestions().map((text) => ({ text }));
    const partial = { kind: 'unreachable' as const, at: [3, 8, 34] };
    const pair = { a: 0, b: 1, inAgainst: false, why: 'Both request contract records' };
    store.services.ai.sameMeaning = vi.fn<NonNullable<typeof store.services.ai.sameMeaning>>()
      .mockResolvedValueOnce(ok({ pairs: [pair], missed: partial }))
      .mockResolvedValueOnce(fail({ kind: 'failed', message: 'The retry failed' }));
    store.services.ai.reword = vi.fn<NonNullable<typeof store.services.ai.reword>>()
      .mockResolvedValueOnce(fail({ kind: 'unreachable', message: 'The model is unavailable' }))
      .mockResolvedValueOnce(ok([{ at: 6, text: 'Obtain the site title report', why: 'Use a direct request' }]));
    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'broad', '');
    const requests = checklistRequests();
    const events = { started: vi.fn(), settled: vi.fn() };
    const session = checklistReviewSession(store, requests, events);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const plan = session.plan(items, target, OPTIONS, null, '')!;
    await session.next(plan, show);
    const { review } = shownReview(show.mock.lastCall?.[0], 'fresh');
    expect(review.asked.reword).toBe('unreachable');
    const cached = session.plan(items, target, OPTIONS, review, plan.signature)!;
    await session.next(cached, show);
    const { review: retried, failure, open } = shownReview(show.mock.lastCall?.[0], 'retry');
    expect(retried).toMatchObject({ pairs: [pair], sameMissed: { at: partial.at, kind: 'failed' } });
    expect({ failure, open }).toEqual({ failure: 'failed', open: true });

    const wording = session.wording(retried, show);
    requests.newToken();
    await wording;
    expect(show).toHaveBeenCalledTimes(2);
    expect(events.settled).toHaveBeenLastCalledWith(false);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('holds the app review until both model requests settle when one throws', async () => {
  const app = await readyApp();
  try {
    const { store } = app;
    const items = portfolioQuestions().map((text) => ({ text }));
    const failure = new Error('The model connection closed unexpectedly');
    type Compare = NonNullable<typeof store.services.ai.sameMeaning>;
    let finish!: (reply: Awaited<ReturnType<Compare>>) => void;
    const holding = new Promise<Awaited<ReturnType<Compare>>>((resolve) => { finish = resolve; });
    const compare = vi.fn<Compare>().mockReturnValue(holding);
    store.services.ai.sameMeaning = compare;
    store.services.ai.reword = vi.fn<NonNullable<typeof store.services.ai.reword>>().mockRejectedValue(failure);
    const state = store.get();
    const target = listTarget(state, firmOf(state.firmList), 'broad', '');
    const events = { started: vi.fn(), settled: vi.fn() };
    const session = checklistReviewSession(store, checklistRequests(), events);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const plan = session.plan(items, target, OPTIONS, null, '')!;
    const rejected = expect(session.next(plan, show)).rejects.toBe(failure);
    await new Promise<void>((tick) => { setImmediate(tick); });

    const waiting = session.plan(items, target, OPTIONS, null, '')!;
    expect(waiting.waiting).toBe(true);
    await session.next(waiting, show);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(events.settled).not.toHaveBeenCalled();

    finish(ok({ pairs: [] }));
    await rejected;
    expect(session.plan(items, target, OPTIONS, null, '')?.waiting).toBe(false);
    expect(events.settled).toHaveBeenCalledExactlyOnceWith(true);
    expect(show).not.toHaveBeenCalled();
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('keeps a wording retry through a General update and discards it for changed imported text', async () => {
  const app = await readyApp();
  try {
    const { store } = app;
    const items = portfolioQuestions().map((text) => ({ text }));
    const suggestion = { at: 0, text: 'Obtain the signed EPC contract and changes', why: 'Use a direct request' };
    type Wording = NonNullable<typeof store.services.ai.reword>;
    let finish!: (reply: Awaited<ReturnType<Wording>>) => void;
    const wording = vi.fn<Wording>()
      .mockResolvedValueOnce(fail({ kind: 'failed', message: 'The wording reply failed' }))
      .mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    store.services.ai.reword = wording;
    const compare = vi.fn<NonNullable<typeof store.services.ai.sameMeaning>>();
    store.services.ai.sameMeaning = compare;
    const state = store.get();
    const target = {
      ...listTarget(state, firmOf(state.firmList), 'technology', 'Solar'),
      generalTexts: ['Confirm insurance for project development.'],
    };
    const options = { askReword: true, askSame: false };
    const session = checklistReviewSession(store, checklistRequests(), REVIEW_EVENTS);
    const show = vi.fn<(change: ChecklistReviewChange) => void>();
    const plan = session.plan(items, target, options, null, '')!;
    await session.next(plan, show);
    const { review } = shownReview(show.mock.lastCall?.[0], 'fresh');
    const retry = session.wording(review, show);
    const updated = { ...target, generalTexts: [...target.generalTexts, 'Obtain current operating permits.'] };
    expect(session.plan(items, updated, options, review, plan.signature)?.signature).not.toBe(plan.signature);
    finish(ok([suggestion]));
    await retry;
    const { review: retried } = shownReview(show.mock.lastCall?.[0], 'retry');
    expect(retried).toMatchObject({ rewords: [suggestion], asked: { reword: 'done', same: 'off' } });

    const stale = session.wording(review, show);
    const revised = [{ text: 'Provide approvals for the new lender draws.' }, ...items.slice(1)];
    session.plan(revised, updated, options, review, plan.signature);
    finish(ok([suggestion]));
    await stale;
    expect(show).toHaveBeenCalledTimes(2);
    expect(compare).not.toHaveBeenCalled();
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});
