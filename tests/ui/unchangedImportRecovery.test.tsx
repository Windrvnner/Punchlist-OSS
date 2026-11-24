// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { StoreContext } from '../../src/ui/hooks';
import { ImportDialog } from '../../src/ui/qaImport';
import { keptImport, keepImport, importKey, keptImportsReady } from '../../src/ui/keptImports';
import { readImportBytes } from '../../src/app/transfer';
import { ImportQuestions, lastImport } from '../../src/app/commands/importQuestions';
import { SetResponse } from '../../src/app/commands/questions';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { copyRecoveryDisk, recoveryApp, recoveryDeal, operationWrite } from '../app/recoveryKit';

it('finishes an unchanged import without replaying rows over a later edit or hiding the previous Undo', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const app = recoveryApp();
  const screen = document.createElement('div');
  document.body.append(screen);
  try {
    const dealId = await recoveryDeal(app);
    const bytes = Uint8Array.from(new TextEncoder().encode(
      'Number,Question,Response\n1,Confirm waiver,Imported response',
    ));
    const read = await readImportBytes(app.store, 'Original.csv', bytes);
    if (!read.ok) throw new Error(read.error.message);
    const mapping = read.value.mapping;
    const rows = prepareImport(read.value.rows, mapping).rows;
    expect((await app.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows })).ok).toBe(true);
    const question = Object.values(app.store.get().questions)[0];
    const audit = await app.repo.audit(question.id);
    const undo = lastImport(app.store.get(), dealId)!.id;
    await keptImportsReady;
    keepImport(importKey.qa(dealId), {
      table: read.value,
      choices: {
        mapping, path: '/outside/Original.csv', mode: 'merge',
        answered: false, makeLog: true, touched: true,
      },
    });
    await act(() => render(
      <StoreContext.Provider value={app.store}><ImportDialog dealId={dealId} /></StoreContext.Provider>, screen,
    ));
    await vi.waitFor(() => expect(screen.querySelector('#im-go')).not.toBeNull());
    const transact = app.repo.transaction.bind(app.repo);
    app.repo.transaction = async (transaction) => operationWrite(transaction, 'KeepQaLog', 'succeeded')
      ? { ok: false, error: { kind: 'unreachable', message: 'Log metadata unavailable' } } : transact(transaction);
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(screen.textContent).toContain('Log metadata unavailable'));
    expect(app.store.get().questions[question.id]).toEqual(question);
    expect(await app.repo.audit(question.id)).toEqual(audit);
    expect(lastImport(app.store.get(), dealId)?.id).toBe(undo);
    app.repo.transaction = transact;
    expect((await app.store.dispatch(SetResponse, {
      dealId, questionId: question.id, response: 'Newer person response after the unchanged import',
    })).ok).toBe(true);
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(keptImport(importKey.qa(dealId))).toBeUndefined());
    expect(app.store.get().questions[question.id].response)
      .toBe('Newer person response after the unchanged import');
  } finally {
    render(null, screen);
    screen.remove();
    vi.unstubAllGlobals();
    app.store.closing();
    await app.repo.close();
  }
});

it('keeps earlier Undo hidden when a real committed import restarts without its completion metadata', async () => {
  const app = recoveryApp();
  let next: ReturnType<typeof recoveryApp> | undefined;
  try {
    const dealId = await recoveryDeal(app);
    const rows = (text: string) => prepareImport([[text]], suggestMapping(['Question'])).rows;
    expect((await app.store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: rows('First real import'),
    })).ok).toBe(true);
    expect(lastImport(app.store.get(), dealId)).toBeDefined();
    const write = app.saved.local.write.bind(app.saved.local);
    let refusals = 0;
    app.saved.local.write = (name, text) => {
      const entries = name === 'ops.json' ? Object.values(JSON.parse(text)) as {
        data: { state: string; idempotencyKey?: string };
      }[] : [];
      if (entries.some(({ data }) => data.state === 'succeeded' && data.idempotencyKey === 'qa-import:lost-metadata')) {
        refusals++;
        throw Object.assign(new Error('Journal full'), { code: 'ENOSPC' });
      }
      write(name, text);
    };
    expect((await app.store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: rows('Later real import'),
    }, { idempotencyKey: 'qa-import:lost-metadata' })).ok).toBe(true);
    expect(refusals).toBe(2);
    next = recoveryApp(copyRecoveryDisk(app.saved));
    await next.store.boot();
    await next.store.loadDeal(dealId, { gaps: false });
    const committed = Object.values(next.store.get().ops)
      .find((operation) => operation.idempotencyKey === 'qa-import:lost-metadata')!;
    expect(committed.state).toBe('succeeded');
    expect(committed.targets.length).toBeGreaterThan(0);
    expect(committed.inverse).toBeUndefined();
    expect(committed.results).toBeUndefined();
    expect(lastImport(next.store.get(), dealId)).toBeUndefined();
    expect(Object.values(next.store.get().questions)).toHaveLength(2);
  } finally {
    app.store.closing();
    await app.repo.close();
    next?.store.closing();
    await next?.repo.close();
  }
});

it('keeps a refused import correlated when its notice Retry succeeds', async () => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const app = recoveryApp();
  const screen = document.createElement('div');
  document.body.append(screen);
  try {
    const dealId = await recoveryDeal(app);
    await keptImportsReady;
    const bytes = Uint8Array.from(new TextEncoder().encode('Question\nOriginal submitted question'));
    const read = await readImportBytes(app.store, 'Original.csv', bytes);
    if (!read.ok) throw new Error(read.error.message);
    keepImport(importKey.qa(dealId), {
      table: read.value,
      choices: {
        mapping: read.value.mapping, path: null, mode: 'append',
        answered: false, makeLog: false, touched: true,
      },
    });
    await act(() => render(
      <StoreContext.Provider value={app.store}><ImportDialog dealId={dealId} /></StoreContext.Provider>, screen,
    ));
    await vi.waitFor(() => expect(screen.querySelector('#im-go')).not.toBeNull());
    const transact = app.repo.transaction.bind(app.repo);
    app.repo.transaction = async (transaction) => operationWrite(transaction, 'ImportQuestions', 'pending')
      ? { ok: false, error: { kind: 'unreachable', message: 'Journal unavailable' } } : transact(transaction);
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(screen.textContent).toContain('Journal unavailable'));
    expect(Object.values(app.store.get().questions)).toHaveLength(0);
    const submission = keptImport(importKey.qa(dealId))!.submission as { key: string };
    const notice = app.store.get().ui.toasts.find((toast) => toast.text === 'Couldn’t save ·')!;
    expect(notice.action?.label).toBe('Retry');
    app.repo.transaction = transact;
    notice.action!.run!();
    await vi.waitFor(() => expect(Object.values(app.store.get().questions)).toHaveLength(1));
    const success = Object.values(app.store.get().ops).find((operation) =>
      operation.command === 'ImportQuestions' && operation.state === 'succeeded')!;
    expect(success.idempotencyKey).toBe(submission.key);
    expect(keptImport(importKey.qa(dealId))).toBeDefined();
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(keptImport(importKey.qa(dealId))).toBeUndefined());
    expect(Object.values(app.store.get().questions)).toHaveLength(1);
  } finally {
    render(null, screen);
    screen.remove();
    vi.unstubAllGlobals();
    app.store.closing();
    await app.repo.close();
  }
});
