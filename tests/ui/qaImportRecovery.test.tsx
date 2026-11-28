// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { StoreContext } from '../../src/ui/hooks';
import { ImportDialog } from '../../src/ui/qaImport';
import { App } from '../../src/ui/app';
import { importKey, initializeKeptImports, keptImport, keepImport, keptImportsReady } from '../../src/app/keptImports';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { readImportBytes, type ImportTable } from '../../src/app/transfer';
import {
  copyRecoveryDisk, failRecoveryWrite, holdRecoveryWrite, operationWrite, recoveryApp, recoveryDeal, type RecoveryApp,
} from '../app/recoveryKit';

const screens: HTMLDivElement[] = [];
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
});
afterEach(() => {
  for (const screen of screens.splice(0)) {
    render(null, screen);
    screen.remove();
  }
});

async function preparedImport(app: RecoveryApp, dealId: string) {
  await keptImportsReady;
  const bytes = Uint8Array.from(new TextEncoder().encode(
    'Question,Submitted by,Custom answer\nConfirm waiver,Contoso,Executed\nConfirm consent,Fabrikam,Granted',
  ));
  const read = await readImportBytes(app.store, 'Lender Q&A.csv', bytes);
  if (!read.ok) throw new Error(read.error.message);
  const choices = {
    mapping: { text: 0, askedBy: 1, response: 2 }, path: '/synthetic/Lender Q&A.csv',
    mode: 'append', answered: true, makeLog: true, touched: true,
  };
  keepImport(importKey.qa(dealId), { table: read.value, choices });
  return { table: read.value, choices };
}

async function openImport(app: RecoveryApp, dealId: string) {
  const screen = document.createElement('div');
  document.body.append(screen);
  screens.push(screen);
  await act(() => render(
    <StoreContext.Provider value={app.store}><ImportDialog dealId={dealId} /></StoreContext.Provider>, screen,
  ));
  await vi.waitFor(() => expect(screen.innerHTML).toContain('id="im-go"'));
  expect(screen.querySelector<HTMLButtonElement>('#im-go')?.disabled).toBe(false);
  return screen;
}

async function openRecoveryApp(app: RecoveryApp) {
  const screen = document.createElement('div');
  document.body.append(screen);
  screens.push(screen);
  await act(() => render(<App store={app.store} />, screen));
  return screen;
}

async function retryInterruptedImport(app: RecoveryApp) {
  const screen = await openRecoveryApp(app);
  const retry = screen.querySelector<HTMLButtonElement>('.intop .tundo');
  expect(retry?.textContent).toBe('Retry');
  await act(() => retry!.click());
  await vi.waitFor(() => expect(screen.querySelector('#im-go')).not.toBeNull());
  expect(Object.values(app.store.get().questions)).toHaveLength(0);
  expect(screen.querySelector('.intop-covered')).not.toBeNull();
  return screen;
}

describe('Q&A import recovery handoff', () => {
  it('keeps the file and all choices until its recoverable operation reaches the journal', async () => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    const prepared = await preparedImport(app, dealId);
    const screen = await openImport(app, dealId);
    const hold = holdRecoveryWrite(app, (transaction) => operationWrite(transaction, 'ImportQuestions', 'pending'));
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await hold.entered;
    try {
      expect(Object.values(app.store.get().questions)).toEqual([]);
      expect(app.store.interruptedOps()).toEqual([]);
      expect(keptImport(importKey.qa(dealId))).toMatchObject(prepared);
    } finally {
      hold.release();
      await vi.waitFor(() => expect(Object.values(app.store.get().questions)).toHaveLength(2));
      await app.repo.close();
    }
  });

  it('imports the prepared rows normally and retires their retained file', async () => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    await preparedImport(app, dealId);
    const screen = await openImport(app, dealId);
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(Object.values(app.store.get().questions)).toHaveLength(2));
    expect(Object.values(app.store.get().questions).map((question) => [question.response, question.status]))
      .toEqual([['Executed', 'answered'], ['Granted', 'answered']]);
    expect(keptImport(importKey.qa(dealId))).toBeUndefined();
    expect(app.store.get().deals[dealId].qaLogs[0].file).toBe('Lender Q&A.csv');
    await app.repo.close();
  });

  it('a refused pre-journal attempt uses the corrected mapping on the next Import', async () => {
    const app = recoveryApp();
    const dealId = await recoveryDeal(app);
    await preparedImport(app, dealId);
    const screen = await openImport(app, dealId);
    const original = app.repo.transaction.bind(app.repo);
    app.repo.transaction = async (transaction) => {
      if (operationWrite(transaction, 'ImportQuestions', 'pending')) {
        return { ok: false, error: { kind: 'failed', message: 'Journal busy' } };
      }
      return original(transaction);
    };
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(screen.textContent).toContain('Journal busy'));
    app.repo.transaction = original;
    const mapping = screen.querySelector<HTMLSelectElement>('[data-immap="response"]')!;
    await act(() => {
      mapping.value = '1';
      mapping.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(Object.values(app.store.get().questions)).toHaveLength(2));
    expect(Object.values(app.store.get().questions).map((question) => question.response)).toEqual(['Contoso', 'Fabrikam']);
    await app.repo.close();
  });

  it.each(['pending', 'committed', 'log-kept'] as const)(
    'resumes after %s without appending twice or losing Make this the deal’s Q&A log', async (phase) => {
      const app = recoveryApp();
      const dealId = await recoveryDeal(app);
      await preparedImport(app, dealId);
      const screen = await openImport(app, dealId);
      const command = phase === 'log-kept' ? 'KeepQaLog' : 'ImportQuestions';
      const hold = holdRecoveryWrite(app, (transaction) =>
        transaction.writes.some((write) => write.kind !== 'op')
          && operationWrite(transaction, command, 'succeeded'), phase !== 'pending');
      await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
      await hold.entered;
      const crashed = copyRecoveryDisk(app.saved);
      const retained = keptImport(importKey.qa(dealId))!;
      hold.release();
      await vi.waitFor(() => expect(keptImport(importKey.qa(dealId))).toBeUndefined());
      app.store.closing();
      await app.repo.close();
      const next = recoveryApp(crashed);
      await next.store.boot();
      await next.store.loadDeal(dealId, { gaps: false });
      keepImport(importKey.qa(dealId), retained);
      const restored = phase === 'pending' ? await retryInterruptedImport(next) : await openImport(next, dealId);
      await act(() => restored.querySelector<HTMLButtonElement>('#im-go')!.click());
      await vi.waitFor(() => expect(keptImport(importKey.qa(dealId))).toBeUndefined());
      expect(Object.values(next.store.get().questions)).toHaveLength(2);
      const log = next.store.get().deals[dealId].qaLogs[0];
      expect([log.file, log.mapping.response, Object.keys(log.last!.sent).length])
        .toEqual(['Lender Q&A.csv', 2, 2]);
      expect(next.store.interruptedOps()).toEqual([]);
      await next.repo.close();
    },
  );
});

async function interruptedImport() {
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  await preparedImport(app, dealId);
  const screen = await openImport(app, dealId);
  const hold = holdRecoveryWrite(app, (transaction) =>
    transaction.writes.some((write) => write.kind === 'question')
      && operationWrite(transaction, 'ImportQuestions', 'succeeded'));
  await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
  await hold.entered;
  const disk = copyRecoveryDisk(app.saved);
  const key = importKey.qa(dealId);
  const retained = keptImport(key)!;
  hold.release();
  await vi.waitFor(() => expect(keptImport(key)).toBeUndefined());
  app.store.closing();
  await app.repo.close();
  keepImport(key, retained);
  return { app: recoveryApp(disk), dealId, key, retained };
}

async function confirmStartOver(screen: HTMLElement) {
  await act(() => screen.querySelector<HTMLButtonElement>('#im-restart')!.click());
  await act(() => screen.querySelector<HTMLButtonElement>('#im-restart-ask-go')!.click());
}

it('keeps the recovery notice and choices when the deal is missing after restart', async () => {
  const { app, dealId, key, retained } = await interruptedImport();
  app.repo.peer.deleteDeal(dealId, { by: 'Peer', from: 'Other PC', at: '2026-11-20T10:00:00.000Z' });
  await app.store.boot();
  const screen = await openRecoveryApp(app);
  await act(() => screen.querySelector<HTMLButtonElement>('.intop .tundo')!.click());

  await vi.waitFor(() => expect(app.store.get().dealLoad[dealId]).toBe('loaded'));
  expect(app.store.get().ui.dialog).toBeNull();
  expect(screen.querySelector('.intop')?.textContent).toContain('Discard');
  expect(app.store.interruptedOps()).toHaveLength(1);
  expect(keptImport(key)).toEqual(retained);
  await app.repo.close();
});

it('keeps the file if Start Over fails to discard its action, then starts over on retry', async () => {
  const { app, key, retained } = await interruptedImport();
  await app.store.boot();
  const screen = await retryInterruptedImport(app);
  const op = app.store.interruptedOps()[0];
  const transaction = app.repo.transaction.bind(app.repo);
  app.repo.transaction = async (write) => {
    if (operationWrite(write, 'ImportQuestions', 'discarded')) {
      return { ok: false, error: { kind: 'failed', message: 'Journal busy' } };
    }
    return transaction(write);
  };
  await confirmStartOver(screen);
  await vi.waitFor(() => expect(screen.textContent).toContain('Couldn’t clear'));
  expect(screen.querySelector('#im-go')).not.toBeNull();
  expect(keptImport(key)).toEqual(retained);
  expect(app.store.get().ops[op.id].state).toBe('interrupted');

  app.repo.transaction = transaction;
  await confirmStartOver(screen);
  await vi.waitFor(() => expect(keptImport(key)).toBeUndefined());
  expect(app.store.get().ops[op.id].state).toBe('discarded');
  await act(() => screen.querySelector<HTMLButtonElement>('.imdlg .x')!.click());
  expect(screen.querySelector('.intop')).toBeNull();
  expect(Object.keys(app.store.get().questions)).toHaveLength(0);
  await app.repo.close();
});

async function replaceImportFile(screen: HTMLElement) {
  await act(() => screen.querySelector<HTMLButtonElement>('#im-back')!.click());
  const input = screen.querySelector<HTMLInputElement>('#im-file')!;
  const replacement = new File(['Question\nConfirm the insurance renewal'], 'Renewal.csv', { type: 'text/csv' });
  Object.defineProperty(input, 'files', { value: [replacement] });
  await act(() => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

it('retires the interrupted action only after a replacement file is read', async () => {
  const { app, key } = await interruptedImport();
  await app.store.boot();
  const screen = await retryInterruptedImport(app);
  expect(app.store.interruptedOps()).toHaveLength(1);
  await replaceImportFile(screen);
  await vi.waitFor(() => expect(screen.textContent).toContain('Renewal.csv'));
  expect(keptImport(key)?.submission).toBeNull();
  expect(app.store.interruptedOps()).toHaveLength(0);
  expect(Object.keys(app.store.get().questions)).toHaveLength(0);
  await app.repo.close();
});

it.each(['start over', 'replace'] as const)('keeps Append recovery when local storage refuses %s', async (action) => {
  const port = new MemoryKeptImports();
  initializeKeptImports(port);
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  const key = importKey.qa(dealId);
  await preparedImport(app, dealId);
  const screen = await openImport(app, dealId);
  failRecoveryWrite(app, (transaction) => operationWrite(transaction, 'KeepQaLog', 'pending'), 'Log write refused');
  await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
  await vi.waitFor(() => expect(screen.textContent).toContain('Log write refused'));
  expect(Object.keys(app.store.get().questions)).toHaveLength(2);
  const retained = keptImport(key);

  const write = port.write.bind(port);
  const persist = vi.spyOn(port, 'write').mockImplementation((changes, replace) =>
    changes.some((change) => 'drop' in change) ? Promise.resolve(false) : write(changes, replace));
  if (action === 'start over') {
    await confirmStartOver(screen);
  } else {
    await replaceImportFile(screen);
  }
  await vi.waitFor(() => expect(screen.textContent).toContain('Couldn’t clear'));
  expect(keptImport(key)).toEqual(retained);
  const disk = copyRecoveryDisk(app.saved);
  app.store.closing();
  await app.repo.close();

  persist.mockRestore();
  const read = port.read.bind(port);
  const hydrate = vi.spyOn(port, 'read').mockImplementation(async () => (await read()).map((part) => {
    if (part.part !== 'table') return part;
    // The local port returns bytes in the new window's realm as IndexedDB does.
    const table = part.value as ImportTable;
    return { ...part, value: { ...table, bytes: Uint8Array.from(table.bytes) } };
  }));
  initializeKeptImports(port);
  await keptImportsReady;
  hydrate.mockRestore();
  const next = recoveryApp(disk);
  await next.store.boot();
  await next.store.loadDeal(dealId, { gaps: false });
  const restored = await openImport(next, dealId);
  await act(() => restored.querySelector<HTMLButtonElement>('#im-go')!.click());
  await vi.waitFor(() => expect(keptImport(key)).toBeUndefined());
  expect(Object.keys(next.store.get().questions)).toHaveLength(2);
  expect(next.store.get().deals[dealId].qaLogs[0].file).toBe('Lender Q&A.csv');
  await next.repo.close();
});
