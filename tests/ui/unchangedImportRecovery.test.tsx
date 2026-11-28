// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { StoreContext } from '../../src/ui/hooks';
import { ImportDialog } from '../../src/ui/qaImport';
import { keptImport, keepImport, importKey, keptImportsReady } from '../../src/app/keptImports';
import { readImportBytes } from '../../src/app/transfer';
import { ImportQuestions, lastImport, RevertImport } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { SetResponse } from '../../src/app/commands/questions';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { copyRecoveryDisk, recoveryApp, recoveryDeal, operationWrite } from '../app/recoveryKit';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { csvCodec } from '../../src/adapters/spreadsheet';

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

async function openPortfolioImport(app: ReturnType<typeof recoveryApp>, dealId: string, screen: HTMLDivElement) {
  await keptImportsReady;
  const questions = portfolioQuestions().slice(0, 2_000);
  const rows = questions.map((text) => [text, 'See the signed agreement', 'For internal review']);
  const headers = ['Question', 'Reviewed answer', 'Response'];
  const encoded = await csvCodec.write('Sheet1', [headers, ...rows]);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const read = await readImportBytes(app.store, 'Portfolio.csv', Uint8Array.from(encoded.value.bytes));
  if (!read.ok) throw new Error(read.error.message);
  keepImport(importKey.qa(dealId), {
    table: read.value,
    choices: {
      mapping: { ...read.value.mapping, response: 1 }, path: '/synthetic/Portfolio.csv', mode: 'append',
      answered: true, makeLog: true, touched: true,
    },
  });
  await act(() => render(
    <StoreContext.Provider value={app.store}><ImportDialog dealId={dealId} /></StoreContext.Provider>, screen,
  ));
  await vi.waitFor(() => expect(screen.querySelector('#im-go')).not.toBeNull());
}

async function undoImportedRows(app: ReturnType<typeof recoveryApp>) {
  const undo = app.store.get().ui.toasts.find(({ action }) => action?.label === 'Undo')?.action?.opId;
  expect(undo).toBeDefined();
  const previous = registry.get(RevertImport.name);
  registry.set(RevertImport.name, RevertImport);
  try {
    expect((await app.store.undo(undo!)).ok).toBe(true);
    expect(Object.values(app.store.get().questions)).toHaveLength(0);
  } finally {
    if (previous) registry.set(RevertImport.name, previous);
    else registry.delete(RevertImport.name);
  }
}

it.each([
  { command: 'ImportQuestions', state: 'pending', kind: 'unreachable', savedRows: 0 },
  { command: 'ImportQuestions', state: 'succeeded', kind: 'storageFull', savedRows: 0 },
  { command: 'KeepQaLog', state: 'succeeded', kind: 'storageFull', savedRows: 2_000 },
  { command: 'RecordQaLogExport', state: 'succeeded', kind: 'storageFull', savedRows: 2_000 },
] as const)('retries a kept import in its form after $command $state fails (#270)', async (phase) => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  const app = recoveryApp();
  const screen = document.createElement('div');
  document.body.append(screen);
  try {
    const dealId = await recoveryDeal(app);
    await openPortfolioImport(app, dealId, screen);
    const transact = app.repo.transaction.bind(app.repo);
    const message = 'The Punchlist folder cannot be written to';
    app.repo.transaction = async (transaction) => operationWrite(transaction, phase.command, phase.state)
      ? { ok: false, error: { kind: phase.kind, message } } : transact(transaction);
    const clickImport = () => act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await clickImport();
    await vi.waitFor(() => expect(screen.textContent).toContain(message));
    expect(Object.values(app.store.get().questions)).toHaveLength(phase.savedRows);
    const key = importKey.qa(dealId);
    const initial = keptImport(key)?.submission;
    expect(initial).toBeDefined();
    if (phase.savedRows === 0) {
      await clickImport();
      await vi.waitFor(() => expect(screen.textContent).toContain(message));
      expect(keptImport(key)?.submission).toEqual(initial);
    }
    const notices = app.store.get().ui.toasts;
    expect(notices.some(({ action }) => action?.label === 'Retry')).toBe(false);
    expect(notices.some(({ text }) => /storage is full|Couldn’t save/.test(text))).toBe(false);

    app.repo.transaction = transact;
    await clickImport();
    await vi.waitFor(() => expect(keptImport(key)).toBeUndefined());
    const result = Object.values(app.store.get().questions);
    expect(result).toHaveLength(2_000);
    expect(result.every(({ response, status }) => response === 'See the signed agreement' && status === 'answered'))
      .toBe(true);
    expect(screen.textContent).not.toContain(message);
    const log = app.store.get().deals[dealId].qaLogs[0];
    expect([log.file, log.mapping.response, Object.keys(log.last!.sent).length]).toEqual(['Portfolio.csv', 1, 2_000]);
    await undoImportedRows(app);
  } finally {
    render(null, screen);
    screen.remove();
    vi.unstubAllGlobals();
    app.store.closing();
    await app.repo.close();
  }
});
