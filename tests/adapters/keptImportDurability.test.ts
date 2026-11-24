// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

type PendingTransaction = {
  mode: IDBTransactionMode;
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
      const transaction = {
        mode, objectStore: () => ({ put: () => ({}), delete: () => {}, openCursor: () => cursor }),
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
});
