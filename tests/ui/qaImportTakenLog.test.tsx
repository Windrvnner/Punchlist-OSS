// @vitest-environment jsdom
// One file is one deal's Q&A log (#38): the import into a second deal refuses another deal's log, before it is read and
// when a kept import of it is sent later, so the two deals' questions never mix in one file.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { StoreContext } from '../../src/ui/hooks';
import { ImportDialog } from '../../src/ui/qaImport';
import { keepImport, importKey, keptImportsReady } from '../../src/ui/keptImports';
import { readImportBytes } from '../../src/app/transfer';
import { CreateDeal } from '../../src/app/commands/deals';
import { KeepQaLog } from '../../src/app/commands/qaLogs';
import { dealQuestions } from '../../src/app/state';
import { recoveryApp, recoveryDeal, type RecoveryApp } from '../app/recoveryKit';

const PATH = 'X:\\Deals\\Proseware\\Q&A\\Lender Q&A.csv';
const SAID = 'Project Recovery fixture already uses “Lender Q&A.csv” in this folder as its Q&A log. '
  + 'Choose another file';
/** a 2,000-question log, each question its own words */
const questions = Array.from({ length: 2000 }, (_, i) => `Please confirm item ${i + 1} of the schedule,`);
const CSV = ['Question,Response', ...questions].join('\n');

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

/** deal A with its log at PATH, and deal B with no log; every file picked is at PATH */
async function twoDeals() {
  const app = recoveryApp();
  const first = await recoveryDeal(app);
  const log = {
    name: 'Lender Q&A', file: 'Lender Q&A.csv', folder: 'X:\\Deals\\Proseware\\Q&A', sheet: 'Sheet1', headerRow: 1,
    mapping: { text: 0, response: 1 },
  };
  expect((await app.store.dispatch(KeepQaLog, { dealId: first, log })).ok).toBe(true);
  await app.store.dispatch(CreateDeal, { name: 'Contoso', folders: [] });
  const second = Object.keys(app.store.get().deals).find((id) => id !== first)!;
  await app.store.loadDeal(second, { gaps: false });
  app.store.services.fs.pathFor = () => PATH;
  return { app, first, second, had: app.store.get().deals[first].qaLogs };
}

async function openImport(app: RecoveryApp, dealId: string) {
  const screen = document.createElement('div');
  document.body.append(screen);
  screens.push(screen);
  await act(() => render(
    <StoreContext.Provider value={app.store}><ImportDialog dealId={dealId} /></StoreContext.Provider>, screen,
  ));
  return screen;
}

describe('another deal\'s Q&A log (#38)', () => {
  it('picking it is refused before it is read', async () => {
    const { app, first, second, had } = await twoDeals();
    const screen = await openImport(app, second);
    const input = screen.querySelector<HTMLInputElement>('#im-file')!;
    Object.defineProperty(input, 'files', { value: [new File([CSV], 'Lender Q&A.csv', { type: 'text/csv' })] });
    await act(() => {
      input.dispatchEvent(new Event('change'));
    });
    await vi.waitFor(() => expect(screen.querySelector('#im-error')?.textContent).toBe(SAID));
    expect(screen.querySelector('#im-go')).toBeNull();                                    // no mapping is shown
    expect([dealQuestions(app.store.get(), second).length, app.store.get().deals[first].qaLogs]).toEqual([0, had]);
    await app.repo.close();
  });

  it('a kept import of it, not sent yet, imports nothing', async () => {
    const { app, first, second, had } = await twoDeals();
    await keptImportsReady;
    const read = await readImportBytes(app.store, 'Lender Q&A.csv', Uint8Array.from(new TextEncoder().encode(CSV)));
    if (!read.ok) throw new Error(read.error.message);
    const choices = {
      mapping: { text: 0, response: 1 }, path: PATH, mode: 'append', answered: true, makeLog: true, touched: true,
    };
    keepImport(importKey.qa(second), { table: read.value, choices });
    const screen = await openImport(app, second);
    await vi.waitFor(() => expect(screen.querySelector<HTMLButtonElement>('#im-go')?.disabled).toBe(false));
    await act(() => screen.querySelector<HTMLButtonElement>('#im-go')!.click());
    await vi.waitFor(() => expect(screen.textContent).toContain(SAID));
    expect([dealQuestions(app.store.get(), second).length, app.store.get().deals[first].qaLogs]).toEqual([0, had]);
    await app.repo.close();
  });
});
