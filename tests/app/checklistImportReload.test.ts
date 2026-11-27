// @vitest-environment node
// A master checklist draft stays kept until its list is written, so a reload mid-write loses nothing (#931).
import { afterEach, expect, it } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { listTarget, submitChecklist } from '../../src/app/checklistImport';
import {
  importKey, initializeKeptImports, keepImport, keptImport, keptImportsReady, saveImport,
} from '../../src/app/keptImports';
import { checklistPaste } from '../../src/app/listRead';
import { firmOf, listId } from '../../src/domain/checklist';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { holdRecoveryWrite, recoveryApp, type RecoveryApp } from './recoveryKit';

const KEY = importKey.checklist('technology', 'Renewables');
let app: RecoveryApp | undefined;

afterEach(async () => {
  app?.store.closing();
  await app?.repo.close();
  app = undefined;
});

/** A booted app whose kept imports live in `port`, with the 2,000-question paste and its choices kept there. */
async function pastedApp() {
  const port = new MemoryKeptImports();
  initializeKeptImports(port);
  await keptImportsReady;
  app = recoveryApp();
  await app.store.boot();
  const questions = portfolioQuestions();
  const paste = questions.join('\n');
  const draft = {
    paste, text: checklistPaste(paste), choices: { useReword: new Set([1, 20]), remove: new Set([8]) },
  };
  expect(await saveImport(KEY, draft)).toBe(true);
  const state = app.store.get();
  const target = listTarget(state, firmOf(state.firmList), 'technology', 'Renewables');
  const items = questions.map((text) => ({ text }));
  const submit = () => submitChecklist(app!.store, KEY, target, items, '');
  return { port, draft, items, submit, store: app.store };
}

/** What a reload reads back: the kept imports as they are on this PC now. */
async function reloadKept(port: MemoryKeptImports) {
  await new Promise((resolve) => setTimeout(resolve, 0));   // every queued write has reached the port
  initializeKeptImports(port);
  await keptImportsReady;
  return keptImport(KEY);
}

function holdListWrite() {
  return holdRecoveryWrite(app!, (transaction) => transaction.writes.some((write) => write.kind === 'firmList'));
}

it('keeps the pasted draft through a reload while the list write is pending', async () => {
  const { port, draft, items, submit, store } = await pastedApp();
  const held = holdListWrite();
  const pending = submit();
  await held.entered;
  expect(await reloadKept(port)).toEqual(draft);
  held.release();
  expect((await pending).ok).toBe(true);
  expect(store.get().firmList[listId('technology', 'Renewables')]?.items).toHaveLength(items.length);
});

it('lets the draft go once the list is written, and offers nothing again after a reload', async () => {
  const { port, submit } = await pastedApp();
  expect((await submit()).ok).toBe(true);
  expect(keptImport(KEY)).toBeUndefined();
  expect(await reloadKept(port)).toBeUndefined();
});

it('keeps a draft changed while the list was written, after the write succeeds', async () => {
  const { port, draft, submit } = await pastedApp();
  const held = holdListWrite();
  const pending = submit();
  await held.entered;
  const newer = { ...draft, paste: `${draft.paste}\nProvide the executed side letters.` };
  keepImport(KEY, { paste: newer.paste });
  held.release();
  expect((await pending).ok).toBe(true);
  expect(keptImport(KEY)).toEqual(newer);
  expect(await reloadKept(port)).toEqual(newer);
});

it('keeps the draft when the list write fails, through a reload', async () => {
  const { port, draft, submit, store } = await pastedApp();
  const original = app!.repo.transaction.bind(app!.repo);
  app!.repo.transaction = async (transaction) => transaction.writes.some((write) => write.kind === 'firmList')
    ? { ok: false, error: { kind: 'storageFull', message: 'The disk is full' } } : original(transaction);
  expect(await submit()).toMatchObject({ ok: false, error: { kind: 'storageFull' } });
  expect(store.get().firmList[listId('technology', 'Renewables')]).toBeUndefined();
  expect(keptImport(KEY)).toEqual(draft);
  expect(await reloadKept(port)).toEqual(draft);
});

it('retains the original draft after a thrown write', async () => {
  const { draft, submit, store } = await pastedApp();
  store.dispatch = async () => { throw new Error('Write interrupted'); };
  await expect(submit()).rejects.toThrow('Write interrupted');
  expect(keptImport(KEY)).toEqual(draft);
});
