// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { StoreContext } from '../../src/ui/hooks';
import { ImportDialog } from '../../src/ui/qaImport';
import { App } from '../../src/ui/app';
import { keptImport, keepImport, importKey, keptImportsReady } from '../../src/app/keptImports';
import { readImportBytes } from '../../src/app/transfer';
import {
  copyRecoveryDisk, holdRecoveryWrite, operationWrite, recoveryApp, recoveryDeal, type RecoveryApp,
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

async function retryInterruptedImport(app: RecoveryApp) {
  const screen = document.createElement('div');
  document.body.append(screen);
  screens.push(screen);
  await act(() => render(<App store={app.store} />, screen));
  const retry = screen.querySelector<HTMLButtonElement>('.intop .tundo');
  expect(retry?.textContent).toBe('Retry');
  await act(() => retry!.click());
  await vi.waitFor(() => expect(screen.querySelector('#im-go')).not.toBeNull());
  expect(Object.values(app.store.get().questions)).toHaveLength(0);
  expect(screen.querySelector('.intop')).toBeNull();
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
