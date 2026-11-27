// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { ChecklistImportSession } from '../../src/app/checklistImportSession';
import { importKey, initializeKeptImports, keepImport, keptImport, keptImportsReady } from '../../src/app/keptImports';
import { keepChecklistImport } from '../../src/app/checklistKept';
import { registry } from '../../src/app/commands/undo';
import { RestoreList } from '../../src/app/commands/checklist';
import { listId } from '../../src/domain/checklist';
import { fail, ok } from '../../src/domain/result';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
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
function open(fresh = false) {
  app.store.ui({ firmChecklist: { step: 'import' } });
  const session = new ChecklistImportSession(app.store, { fresh });
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
  keepChecklistImport(key, { paste: 'Reentrant keep' }, false);
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

it('a finished write leaves a later dialog and its retained draft in place', async () => {
  const session = await reviewPortfolio();
  const held = holdRecoveryWrite(app, (tx) => tx.writes.some((write) => write.kind === 'firmList'));
  const pending = session.bringIn();
  await held.entered;
  session.dispose();
  const later = { step: 'import', layer: 'sector', name: 'Solar' } as const;
  app.store.ui({ firmChecklist: later });
  keepImport(key, { paste: 'Supply the signed security agreements.' });
  held.release();
  await pending;
  expect(app.store.get().ui.firmChecklist).toEqual(later);
  expect(app.store.get().ui.toasts.some((toast) => toast.action?.label === 'Undo All')).toBe(true);
  expect(keptImport(key)?.paste).toBe('Supply the signed security agreements.');
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

it('leaves a set-aside draft intact until the person types or accepts a new source', async () => {
  keepImport(key, { paste: 'Earlier paste', review: { damaged: true } });
  const session = open(true);
  expect(session.view.source.paste).toBe('');
  session.close();
  expect(keptImport(key)).toEqual({ paste: 'Earlier paste', review: { damaged: true } });
  const reopened = open();
  reopened.setPaste('  Provide tax returns.  ');
  expect(keptImport(key)).toMatchObject({ paste: '  Provide tax returns.  ', review: null, choices: undefined });
});
