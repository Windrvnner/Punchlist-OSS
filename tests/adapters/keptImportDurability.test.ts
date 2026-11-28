// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

type PendingTransaction = {
  mode: IDBTransactionMode;
  writes: [unknown, IDBValidKey][];
  oncomplete?: () => void;
  onabort?: () => void;
  onerror?: () => void;
};

async function indexedImportStore() {
  vi.resetModules();
  const transactions: PendingTransaction[] = [];
  const cursor: { result: null; onsuccess?: () => void } = { result: null };
  const database = {
    transaction: (_store: string, mode: IDBTransactionMode) => {
      const writes: PendingTransaction['writes'] = [];
      const put = (value: unknown, key: IDBValidKey) => { writes.push([value, key]); };
      const transaction = {
        mode, writes, objectStore: () => ({ put, delete: () => {}, openCursor: () => cursor }),
        commit() {},
      };
      transactions.push(transaction);
      return transaction;
    },
  };
  const request: { result: typeof database; onsuccess?: () => void } = { result: database };
  vi.stubGlobal('indexedDB', { open: () => request });
  vi.stubGlobal('IDBKeyRange', { bound: () => ({}) });
  const imports = await import('../../src/app/keptImports');
  const { IndexedKeptImports } = await import('../../src/adapters/keptImports');
  imports.initializeKeptImports(new IndexedKeptImports());
  request.onsuccess!();
  cursor.onsuccess!();
  await imports.keptImportsReady;
  return { imports, transactions };
}

afterEach(() => vi.unstubAllGlobals());

describe('durable retained import submission', () => {
  it('waits for the IndexedDB transaction to complete before permitting journal work', async () => {
    const { imports, transactions } = await indexedImportStore();
    let completed = false;
    const saving = imports.saveImport('qa:d_1', { submission: { key: 'qa-import:one' } });
    void saving.then(() => { completed = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);
    transactions.at(-1)!.oncomplete!();
    expect(await saving).toBe(true);
    expect(completed).toBe(true);
  });

  it('refuses submission when IndexedDB aborts and keeps the file and choices for retry', async () => {
    const { imports, transactions } = await indexedImportStore();
    const parts = { file: 'Original CSV', choices: { mode: 'append' }, submission: { key: 'qa-import:one' } };
    const saving = imports.saveImport('qa:d_1', parts);
    await Promise.resolve();
    transactions.at(-1)!.onabort!();
    expect(await saving).toBe(false);
    expect(imports.keptImport('qa:d_1')).toEqual(parts);
    const retrying = imports.saveImport('qa:d_1', parts);
    await Promise.resolve();
    transactions.at(-1)!.oncomplete!();
    expect(await retrying).toBe(true);
  });

  it('keeps the draft available until the IndexedDB removal commits', async () => {
    const { imports, transactions } = await indexedImportStore();
    const key = imports.importKey.qa('renewables');
    const parts = { file: 'Lender Q&A.csv', submission: { key: 'qa-import:one' } };
    const saving = imports.saveImport(key, parts);
    await Promise.resolve();
    transactions.at(-1)!.oncomplete!();
    expect(await saving).toBe(true);

    const refused = imports.dropSavedImport(key);
    await Promise.resolve();
    expect(imports.keptImport(key)).toEqual(parts);
    transactions.at(-1)!.onabort!();
    expect(await refused).toBe(false);
    expect(imports.keptImport(key)).toEqual(parts);

    const removing = imports.dropSavedImport(key);
    await Promise.resolve();
    expect(imports.keptImport(key)).toEqual(parts);
    transactions.at(-1)!.oncomplete!();
    expect(await removing).toBe(true);
    expect(imports.keptImport(key)).toBeUndefined();
  });

  it('resends the replacement file when choices change between a request error and its abort', async () => {
    const { imports, transactions } = await indexedImportStore();
    const key = imports.importKey.qa('renewables');
    const original = new TextEncoder().encode('Question,Workstream\nConfirm permit status,Legal');
    const revised = new TextEncoder().encode('Workstream,Question\nLegal,Confirm permit status');
    const originalChoices = { questionColumn: 0, mode: 'merge' };
    const revisionChoices = { questionColumn: 1, mode: 'merge' };
    const latestChoices = { questionColumn: 1, mode: 'append' };
    const saving = imports.saveImport(key, { file: original, choices: originalChoices });
    await Promise.resolve();
    transactions.at(-1)!.oncomplete!();
    expect(await saving).toBe(true);

    imports.keepImport(key, { file: revised, choices: revisionChoices });
    await Promise.resolve();
    const replacement = transactions.at(-1)!;
    replacement.onerror?.();
    imports.keepImport(key, { choices: latestChoices });
    await Promise.resolve();
    const retry = transactions.at(-1)!;
    expect(retry).not.toBe(replacement);
    replacement.onabort!();
    retry.oncomplete!();

    expect(retry.writes).toContainEqual([revised, [key, 'file']]);
    expect(retry.writes).toContainEqual([latestChoices, [key, 'choices']]);
  });
});
