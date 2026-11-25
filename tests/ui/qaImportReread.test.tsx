// @vitest-environment jsdom
// Import waits for a pending sheet or heading choice to be read. A failed read marks the choice unused and keeps
// the accepted table available (#63, #380).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import './keptTextSession';
import { StoreContext } from '../../src/ui/hooks';
import { ImportDialog } from '../../src/ui/qaImport';
import { keepImport, importKey, keptImportsReady } from '../../src/app/keptImports';
import { readImportBytes } from '../../src/app/transfer';
import { dealQuestions } from '../../src/app/state';
import { recoveryApp, recoveryDeal, type RecoveryApp } from '../app/recoveryKit';

/** three heading lines, then 30 questions */
const rows = Array.from({ length: 30 }, (_, i) => `Confirm item ${i + 1} of the list,Yes ${i + 1}`);
const CSV = ['Question,Response', 'Question,Response', 'Question,Response', ...rows].join('\n');
const COLUMN_CHANGES = [
  'Question,Previous Review,Notes,Response',
  'Question,,Notes,Response',
  'Question,,Final Notes,Response',
  'Provide the permit transfer schedule,,Transfer timing is being reviewed,Transfer expected before closing',
].join('\n');

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

/** the import dialog on a kept import of the file, heading row 1; each reread for row 2 or 3 is held until let go */
async function dialog(csv = CSV) {
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  await keptImportsReady;
  const read = await readImportBytes(app.store, 'Lender Q&A.csv', Uint8Array.from(new TextEncoder().encode(csv)));
  if (!read.ok) throw new Error(read.error.message);
  const choices = {
    mapping: read.value.mapping, path: null, mode: 'append', answered: false, makeLog: false, touched: true,
  };
  keepImport(importKey.qa(dealId), { table: read.value, choices });
  const sheets = app.store.services.sheets;
  const original = sheets.read;
  const held = new Map<number, () => void>();
  const failing = new Set<number>();                                     // rows whose read fails once let go
  sheets.read = async (bytes, name, opts) => {
    const row = opts?.headerRow;
    if (row === 2 || row === 3) await new Promise<void>((go) => held.set(row, go));
    const locked = { ok: false as const, error: { kind: 'failed' as const, message: 'The file is locked' } };
    if (row && failing.has(row)) return locked;
    return original.call(sheets, bytes, name, opts);
  };
  const screen = document.createElement('div');
  document.body.append(screen);
  screens.push(screen);
  await act(() => render(
    <StoreContext.Provider value={app.store}><ImportDialog dealId={dealId} /></StoreContext.Provider>, screen,
  ));
  await vi.waitFor(() => expect(screen.querySelector('#im-go')).not.toBeNull());
  const get = <T extends Element>(id: string) => screen.querySelector<T>(id)!;
  const heading = async (row: number) => {
    const field = get<HTMLInputElement>('#im-header');
    field.value = String(row);
    await act(() => {
      field.dispatchEvent(new Event('input'));
    });
  };
  const letGo = async (row: number) => {
    await vi.waitFor(() => expect(held.has(row)).toBe(true));
    await act(async () => held.get(row)!());
  };
  const pickResponse = async (column: string) => {
    const response = get<HTMLSelectElement>('[data-immap="response"]');
    await act(() => {
      response.value = column;
      response.dispatchEvent(new Event('change'));
    });
  };
  const done = async () => {
    sheets.read = original;
    await app.repo.close();
  };
  return { app, dealId, get, heading, letGo, pickResponse, done, failing };
}

describe('a heading row read again in the Q&A import (#63)', () => {
  it('keeps a response column explicitly left out during the read (#741)', async () => {
    const { get, heading, letGo, pickResponse, done } = await dialog();
    try {
      await heading(3);
      await pickResponse('');
      expect(get<HTMLSelectElement>('[data-immap="response"]').value).toBe('');
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 30 questions · 30 new'));
      expect(get<HTMLSelectElement>('[data-immap="response"]').value).toBe('');
    } finally {
      await done();
    }
  });

  it('keeps the selected sheet column even when its preview position changes (#741)', async () => {
    const { app, dealId, get, heading, letGo, pickResponse, done } = await dialog(COLUMN_CHANGES);
    try {
      await heading(3);
      await pickResponse('2');
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 1 question · 1 new'));
      expect(get<HTMLSelectElement>('[data-immap="response"]').selectedOptions[0].text).toBe('Final Notes');
      await act(() => get<HTMLButtonElement>('#im-go').click());
      await vi.waitFor(() => expect(dealQuestions(app.store.get(), dealId)[0]?.response)
        .toBe('Transfer timing is being reviewed'));
    } finally {
      await done();
    }
  });

  it('names a picked column that did not carry over to the reread (#741)', async () => {
    const { get, heading, letGo, pickResponse, done } = await dialog(COLUMN_CHANGES);
    try {
      await heading(3);
      await pickResponse('1');
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Column choice not applied for Response.'));
      expect(get('#im-line').getAttribute('role')).toBe('alert');
      expect(get<HTMLSelectElement>('[data-immap="response"]').value).toBe('');
    } finally {
      await done();
    }
  });

  it('Import waits for the reread and imports the rows of the heading shown', async () => {
    const { app, dealId, get, heading, letGo, done } = await dialog();
    try {
      await heading(3);
      const go = get<HTMLButtonElement>('#im-go');
      expect([get<HTMLInputElement>('#im-header').value, go.disabled, get('#im-line').textContent])
        .toEqual(['3', true, 'Reading the file']);
      await act(() => get<HTMLButtonElement>('#im-go').click());
      expect(dealQuestions(app.store.get(), dealId)).toHaveLength(0);
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 30 questions · 30 new'));
      await act(() => get<HTMLButtonElement>('#im-go').click());
      await vi.waitFor(() => expect(dealQuestions(app.store.get(), dealId)).toHaveLength(30));
      expect(dealQuestions(app.store.get(), dealId).filter((q) => q.text === 'Question')).toEqual([]);
    } finally {
      await done();
    }
  });

  it('a later heading choice wins over a slower earlier one', async () => {
    const { get, heading, letGo, done } = await dialog();
    try {
      await heading(2);
      await heading(3);
      expect(get<HTMLButtonElement>('#im-go').disabled).toBe(true);
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 30 questions · 30 new'));
      const go = get<HTMLButtonElement>('#im-go');
      expect([get<HTMLInputElement>('#im-header').value, go.disabled]).toEqual(['3', false]);
      await letGo(2);
      await new Promise((settled) => setTimeout(settled, 50));
      expect([get<HTMLInputElement>('#im-header').value, get('#im-line').textContent])
        .toEqual(['3', 'Import 30 questions · 30 new']);
    } finally {
      await done();
    }
  });

  it('going back to the row already read while another is read takes that row', async () => {
    const { get, heading, letGo, done } = await dialog();
    try {
      await heading(3);
      await heading(1);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 32 questions · 32 new'));
      await letGo(3);
      await new Promise((settled) => setTimeout(settled, 50));
      expect([get<HTMLInputElement>('#im-header').value, get('#im-line').textContent])
        .toEqual(['1', 'Import 32 questions · 32 new']);
    } finally {
      await done();
    }
  });

  it('a reread that fails marks the typed row unused and lets the person go on with the row already read', async () => {
    const { app, dealId, get, heading, letGo, done, failing } = await dialog();
    try {
      failing.add(2);
      await heading(2);
      await letGo(2);
      const said = 'Could not read Lender Q&A.csv: The file is locked';
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe(said));
      const field = get<HTMLInputElement>('#im-header');
      expect([field.value, get<HTMLButtonElement>('#im-go').disabled]).toEqual(['2', false]);
      expect(get('#im-header-unused').textContent).toBe('Not used');
      expect(get('#im-header-unused').getAttribute('title')).toBe('The preview uses row 1');
      await heading(3);
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 30 questions · 30 new'));
      expect(dealQuestions(app.store.get(), dealId)).toHaveLength(0);
    } finally {
      await done();
    }
  });

  it('choosing another file while a reread is pending leaves nothing reading and nothing imported', async () => {
    const { app, dealId, get, heading, letGo, done } = await dialog();
    try {
      await heading(3);
      await act(() => get<HTMLButtonElement>('#im-back').click());
      expect(get('#im-browse')).not.toBeNull();
      await letGo(3);
      await new Promise((settled) => setTimeout(settled, 50));
      expect([get('#im-go'), get('.xfoot'), dealQuestions(app.store.get(), dealId).length]).toEqual([null, null, 0]);
    } finally {
      await done();
    }
  });
});
