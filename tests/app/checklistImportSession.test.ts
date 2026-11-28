// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { ChecklistImportSession } from '../../src/app/checklistImportSession';
import { importKey, initializeKeptImports, keptImport, keptImportsReady } from '../../src/app/keptImports';
import { registry } from '../../src/app/commands/undo';
import { BringInList, RestoreList } from '../../src/app/commands/checklist';
import { listId } from '../../src/domain/checklist';
import { fail, ok } from '../../src/domain/result';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { ELSEWHERE } from '../adapters/memRepo';
import { holdRecoveryWrite, recoveryApp } from './recoveryKit';

const key = importKey.checklist();
let app: ReturnType<typeof recoveryApp>;
const sessions: ChecklistImportSession[] = [];
beforeEach(async () => {
  initializeKeptImports(new MemoryKeptImports());
  await keptImportsReady;
  registry.set(RestoreList.name, RestoreList);
  app = recoveryApp();
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

async function reviewPortfolio() {
  const { ai } = app.store.services;
  const requests = portfolioQuestions();
  ai.readList = async ({ lines }) => ok({
    lines: lines.slice(0, -1).map((_, index) => ({ n: index + 1, k: index ? 'item' : 'section' })),
  });
  ai.reword = async () => ok([{ at: 0, text: 'Provide the executed EPC contract and all amendments.', why: '' }]);
  ai.sameMeaning = async () => ok({ pairs: [{ a: 0, b: requests.length - 1, inAgainst: false, why: '' }] });
  const session = open();
  const paste = ['Portfolio due diligence', ...requests].join('\n');
  session.setPaste(paste);
  expect(keptImport(key)?.paste).toBe(paste);
  await session.pasted();
  expect(session.view.source.tied?.count.left).toBe(1);
  session.flipBringIn(requests.length + 1);
  expect(session.view.source.prepared?.count).toBe(2376);
  await session.next();
  session.flipRemove(requests.length - 1);
  session.flipReword(0);
  session.backToList();
  expect(session.view.step).toBe('read');
  await session.next();
  expect(session.view.listReview.counts).toMatchObject({ items: 2375, removed: 1, reworded: 1 });
  session.close();
  const reopened = open();
  expect(reopened.view.step).toBe('review');
  expect(reopened.view.listReview.remove.has(2375)).toBe(true);
  return reopened;
}

it('brings in the restored review, holds the draft until the write, and offers Undo All', async () => {
  const session = await reviewPortfolio();
  const held = holdRecoveryWrite(app, (tx) => tx.writes.some((write) => write.kind === 'firmList'));
  const before = keptImport(key);
  const pending = session.bringIn();
  await held.entered;
  session.close();
  expect(app.store.get().ui.firmChecklist?.step).toBe('import');
  expect(keptImport(key)).toEqual(before);
  held.release();
  await pending;
  const state = app.store.get();
  expect(state.ui.firmChecklist?.step).toBe('lists');
  expect(keptImport(key)).toBeUndefined();
  const list = state.firmList[listId('broad', '')];
  expect(list.items).toHaveLength(2375);
  expect(list.items[0]).toMatchObject({ text: 'Provide the executed EPC contract and all amendments.' });
  const undo = state.ui.toasts.find((toast) => toast.action?.label === 'Undo All')?.action;
  expect(undo?.run).toBeTypeOf('function');
  undo?.run?.();
  await vi.waitFor(() => expect(app.store.get().firmList[listId('broad', '')]).toBeUndefined());
});

it('signed out, Bring In is refused quietly and the dialog says why', async () => {
  const session = await reviewPortfolio();
  const signedOut = { ...app.store.get(), signin: { out: true } };
  (app.store as unknown as { set: (state: unknown) => void }).set(signedOut);
  await session.bringIn();
  expect(session.view.work).toEqual({ busy: '', error: `Couldn’t import: ${app.store.readOnly()}` });
  expect(app.store.get().ui.toasts).toEqual([]);
  expect(app.store.get().firmList[listId('broad', '')]).toBeUndefined();
});

it('a Bring In that throws clears busy, says why and keeps the draft', async () => {
  const session = await reviewPortfolio();
  const before = keptImport(key);
  vi.spyOn(app.store, 'dispatch').mockRejectedValue(new Error('The disk is full'));
  await session.bringIn();
  expect(session.view.work).toEqual({ busy: '', error: 'Couldn’t import: The disk is full' });
  expect(keptImport(key)).toEqual(before);
});

it('keeps new typing from a reopened import while its previous instance finishes writing', async () => {
  const first = await reviewPortfolio();
  const held = holdRecoveryWrite(app, (tx) => tx.writes.some((write) => write.kind === 'firmList'));
  const write = first.bringIn();
  await held.entered;
  first.dispose();
  const second = open();
  second.change();
  second.setPaste('  Obtain the signed lender consent.  ');
  try {
    expect(keptImport(key)?.paste).toBe('  Obtain the signed lender consent.  ');
  } finally {
    held.release();
    await write;
  }
  expect(app.store.get().ui.firmChecklist?.step).toBe('lists');
  expect(app.store.get().ui.toasts.some((toast) => toast.action?.label === 'Undo All')).toBe(true);
  second.close();
  const reopened = open();
  reopened.change();
  expect(reopened.view.source.paste).toBe('  Obtain the signed lender consent.  ');
});

it('ignores a retry that ends after change and detects headings before manual column selection', async () => {
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  const session = open();
  const file = new File(['Item,Section\nLegal opinion,Financing\nTitle report,Property'], 'Lender list.csv');
  await session.loadDropped(file);
  expect(session.view.source.readFailed).toBe('failed');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  app.store.services.ai.readList = async () => {
    await gate;
    return ok({ lines: [{ n: 1, k: 'item' }] });
  };
  const retry = session.readNow();
  session.change();
  session.setPaste('Tax returns');
  release();
  await retry;
  expect(session.view.step).toBe('pick');
  expect(session.view.source.reads).toBeNull();
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  await session.load(file);
  await session.chooseColumns();
  expect(session.view.step).toBe('columns');
  session.pickColumn('item', null);
  expect(session.view.canNext).toBe(false);
  await session.next();
  expect(session.view.step).toBe('columns');
  session.pickColumn('item', 0);
  expect(session.view.canNext).toBe(true);
  await session.loadDropped(new File(['other'], 'Other.txt'));
  expect(session.view.source.table?.name).toBe('Lender list.csv');
  session.startOver();
  expect(session.view.step).toBe('pick');
  expect(keptImport(key)).toBeUndefined();
});

it('imports the section and subsection remapped after Back (#56)', async () => {
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  const questions = portfolioQuestions().slice(0, 2_000);
  const headers = ['Area', 'Other area', 'Subsection', 'Other subarea', 'Item'];
  const rows = questions.map((text) => ['Operations', 'Financing', 'Reports', 'Supporting records', text]);
  const encoded = await csvCodec.write('Sheet1', [headers, ...rows]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const file = new File([encoded.value.bytes.slice().buffer], 'Portfolio requests.csv');
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

async function technologyReview(questions: string[], name: string) {
  app.store.services.ai.readList = async ({ lines }) => ok({
    lines: lines.map((_, index) => ({ n: index + 1, k: 'item' })),
  });
  const session = open();
  session.setLayer('technology');
  session.setName(name);
  session.setAskReword(false);
  session.setAskSame(false);
  session.setPaste(questions.join('\n'));
  await session.pasted();
  await session.next();
  return session;
}

it('imports only the wording accepted for the destination chosen after Back (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const solarItems = priorItems(questions, 'photovoltaic');
  const windItems = priorItems(questions, 'wind turbine');
  const lists = [{ name: 'Solar', items: solarItems }, { name: 'Wind', items: windItems }];
  for (const { name, items } of lists) {
    const result = await app.store.dispatch(BringInList, {
      list: { layer: 'technology', name, items, file: 'Prior requests.csv', fileDate: '' },
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
  session.setName('Wind');
  session.close();
  const reopened = open();
  await reopened.next();
  const shown = reopened.view.listReview.review?.rewords.map(({ text }) => text);
  await reopened.bringIn();
  const saved = app.store.get().firmList;
  const wind = saved[listId('technology', 'Wind')]?.items;
  expect(wind?.[1]).toEqual(windItems[1]);
  expect(wind).toEqual([...windItems, ...questions.slice(120).map((text) => ({ text }))]);
  expect(shown).toEqual(windItems.map(({ text }) => text));
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

it('refuses a queued Import when an earlier write changes the reviewed list (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const name = 'Wind';
  const id = listId('technology', name);
  const items = priorItems(questions, 'offshore wind');
  const list = { layer: 'technology' as const, name, items, file: 'Prior requests.csv', fileDate: '' };
  expect((await app.store.dispatch(BringInList, { list })).ok).toBe(true);
  const session = await technologyReview(questions, name);
  const updatedItems = priorItems(questions, 'onshore wind');
  const held = holdRecoveryWrite(app, (tx) => tx.writes.some((write) => write.kind === 'firmList'));
  const first = app.store.dispatch(BringInList, { list: { ...list, items: updatedItems } });
  await held.entered;
  const queued = session.bringIn();
  held.release();
  expect((await first).ok).toBe(true);
  await queued;
  expect(app.store.get().firmList[id].items[0]).toEqual(updatedItems[0]);
  expect(session.view.work.error).toContain('The list changed');
  expect(keptImport(key)).toBeDefined();
});
