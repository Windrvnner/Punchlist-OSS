// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { ChecklistImportSession } from '../../src/app/checklistImportSession';
import { importKey, initializeKeptImports, keptImport, keptImportsReady, saveImport } from '../../src/app/keptImports';
import { readImportBytes } from '../../src/app/transfer';
import { registry } from '../../src/app/commands/undo';
import { BringInList, RestoreList } from '../../src/app/commands/checklist';
import { listId } from '../../src/domain/checklist';
import { fail, ok } from '../../src/domain/result';
import { checklistSpreadsheet, keepChecklistTable } from '../fixtures/checklistSpreadsheet';
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
function open(initial: ConstructorParameters<typeof ChecklistImportSession>[1] = {}) {
  app.store.ui({ firmChecklist: { step: 'import' } });
  const session = new ChecklistImportSession(app.store, initial);
  sessions.push(session);
  void session.start();
  return session;
}

it('keeps draft wording choices when identical offers become saved approvals (#56)', async () => {
  const questions = portfolioQuestions().slice(0, 2_000);
  const offers = questions.slice(0, 120).map((text, at) => ({
    at, text: `${text} Include supporting records.`, why: '',
  }));
  const split = { ...offers[0], also: ['Provide the latest independent energy yield report.'] };
  const destination = { layer: 'technology' as const, name: 'Wind' };
  const id = listId(destination.layer, destination.name);
  expect((await app.store.dispatch(BringInList, {
    list: { ...destination, items: questions.map((text) => ({ text })), file: 'Prior requests.csv', fileDate: '' },
  })).ok).toBe(true);
  app.store.services.ai.readList = async ({ lines }) => ok({
    lines: lines.map((_, index) => ({ n: index + 1, k: 'item' })),
  });
  app.store.services.ai.reword = async () => ok([split, ...offers.slice(1)]);

  const draft = open();
  draft.setLayer(destination.layer);
  draft.setName(destination.name);
  draft.setAskReword(true);
  draft.setAskSame(false);
  draft.setPaste(questions.join('\n'));
  await draft.pasted();
  await draft.next();
  expect(draft.view.listReview.review?.rewords).toHaveLength(120);
  draft.flipReword(0);
  draft.flipReword(0);
  draft.flipReword(1);
  draft.backToList();
  draft.close();

  const replacement = open({ ...destination, fresh: true });
  replacement.setAskReword(true);
  replacement.setAskSame(false);
  replacement.setPaste(questions.join('\n'));
  await replacement.pasted();
  await replacement.next();
  replacement.setAllWording(true);
  await replacement.bringIn();
  expect(app.store.get().firmList[id].items).toHaveLength(2_001);

  const reopened = open();
  await reopened.next();
  expect(reopened.view.listReview.review?.rewords[0]).toMatchObject({ text: split.text, also: split.also });
  expect(reopened.view.listReview.useReword.has(0)).toBe(false);
  expect(reopened.view.listReview.useReword).toEqual(new Set([1]));
  await reopened.bringIn();
  const saved = app.store.get().firmList[id].items;
  expect(saved).toHaveLength(2_000);
  expect(saved[0]).toEqual({ text: questions[0] });
  expect(saved[1]).toEqual({ text: offers[1].text, was: questions[1] });
});

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

it('ignores a retry that ends after the document is replaced with a paste', async () => {
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  app.store.services.sheets = checklistSpreadsheet;
  const session = open();
  const file = new File(['Legal opinion\nTitle report'], 'Lender list.txt');
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
});

it('detects headings when manually choosing columns in a kept worksheet', async () => {
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  app.store.services.sheets = checklistSpreadsheet;
  const file = new File(['Item,Section\nLegal opinion,Financing\nTitle report,Property'], 'Lender list.ods');
  await keepChecklistTable(app.store, file);
  const session = open();
  await vi.waitFor(() => expect(session.view.source.readFailed).toBe('failed'));
  await session.chooseColumns();
  expect(session.view.step).toBe('columns');
  session.pickColumn('item', null);
  expect(session.view.canNext).toBe(false);
  await session.next();
  expect(session.view.step).toBe('columns');
  session.pickColumn('item', 0);
  expect(session.view.canNext).toBe(true);
  await session.loadDropped(new File(['other'], 'Other.txt'));
  expect(session.view.source.table?.name).toBe('Lender list.ods');
  session.startOver();
  expect(session.view.step).toBe('pick');
  expect(keptImport(key)).toBeUndefined();
});

it.each(['xlsx', 'csv'])('reopens a kept .%s worksheet and rereads its columns', async (extension) => {
  app.store.services.sheets = checklistSpreadsheet;
  app.store.services.ai.readList = async () => fail({ kind: 'failed', message: 'Unavailable' });
  const name = `Portfolio checklist.${extension}`;
  const rows = portfolioQuestions().slice(0, 2_000).map((item) => [item, 'Project agreements']);
  const encoded = await checklistSpreadsheet.write('Sheet1', [['Item', 'Section'], ...rows]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const loaded = await readImportBytes(app.store, name, encoded.value.bytes);
  if (!loaded.ok) throw new Error(loaded.error.message);
  expect(await saveImport(key, { table: loaded.value })).toBe(true);

  const session = open();
  expect(session.view.source.table?.name).toBe(name);
  await vi.waitFor(() => expect(session.view.source.readFailed).toBe('failed'));
  await session.chooseColumns();
  expect(session.view.step).toBe('columns');
  expect(session.view.source.table?.rows).toEqual(rows);
});
