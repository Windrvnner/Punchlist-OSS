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
import { fail, ok } from '../../src/domain/result';
import { tableFrom } from '../../src/domain/sheets';
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

/** Hold a requested sheet or heading row until the test releases it, optionally failing the read. */
function holdSheetReads(app: RecoveryApp, csv: string, otherSheet: boolean) {
  const sheets = app.store.services.sheets;
  const original = sheets.read;
  const held = new Map<number | string, () => void>();
  const failing = new Set<number>();
  const grid = csv.split('\n').map((line) => line.split(','));
  const alternate = [
    ['Question', 'Notes', 'Response'],
    ['Question', 'Notes', 'Response'],
    ['Question', 'Final Notes', 'Response'],
    ['Confirm the refinancing dates', 'Scheduled for the second quarter', 'Still under review'],
  ];
  sheets.read = async (bytes, name, opts) => {
    const row = opts?.headerRow;
    const delayed = row === 2 || row === 3 ? row : opts?.sheet === 'Updated review' && !row ? opts.sheet : null;
    if (delayed) await new Promise<void>((go) => held.set(delayed, go));
    if (row && failing.has(row)) return fail({ kind: 'failed', message: 'The file is locked' });
    if (!otherSheet) return original.call(sheets, bytes, name, opts);
    return ok(tableFrom([{ name: 'Initial review', grid }, { name: 'Updated review', grid: alternate }], opts)!);
  };
  const letGo = async (read: number | string) => {
    await vi.waitFor(() => expect(held.has(read)).toBe(true));
    const go = held.get(read)!;
    held.delete(read);
    await act(async () => go());
  };
  const restore = () => { sheets.read = original; };
  return { letGo, failing, restore };
}

/** The import dialog on a kept import of the file at heading row 1. */
async function dialog(csv = CSV, { legacy = false, otherSheet = false } = {}) {
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  await keptImportsReady;
  const { letGo, failing, restore } = holdSheetReads(app, csv, otherSheet);
  const read = await readImportBytes(app.store, 'Lender Q&A.csv', Uint8Array.from(new TextEncoder().encode(csv)));
  if (!read.ok) throw new Error(read.error.message);
  const choices = {
    mapping: read.value.mapping, path: null, mode: 'append', answered: false, makeLog: false, touched: true,
  };
  const { cols: _cols, ...withoutPositions } = read.value;
  keepImport(importKey.qa(dealId), { table: legacy ? withoutPositions : read.value, choices });
  const screen = document.createElement('div');
  document.body.append(screen);
  screens.push(screen);
  const show = () => act(() => render(
    <StoreContext.Provider value={app.store}><ImportDialog dealId={dealId} /></StoreContext.Provider>, screen,
  ));
  await show();
  await vi.waitFor(() => expect(screen.querySelector('#im-go')).not.toBeNull());
  const get = <T extends Element>(id: string) => screen.querySelector<T>(id)!;
  const heading = async (row: number) => {
    const field = get<HTMLInputElement>('#im-header');
    field.value = String(row);
    await act(() => {
      field.dispatchEvent(new Event('input'));
    });
  };
  const choose = async (selector: string, value: string) => {
    const select = get<HTMLSelectElement>(selector);
    await act(() => {
      select.value = value;
      select.dispatchEvent(new Event('change'));
    });
  };
  const pickResponse = (column: string) => choose('[data-immap="response"]', column);
  const reopen = async () => {
    await act(() => render(null, screen));
    await show();
  };
  const done = async () => {
    restore();
    await app.repo.close();
  };
  return { app, dealId, get, heading, letGo, pickResponse, choose, reopen, done, failing };
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

  it('names an unapplied choice until that field is corrected, including after reopening (#741)', async () => {
    const { get, heading, letGo, pickResponse, choose, reopen, done } = await dialog(COLUMN_CHANGES);
    try {
      await heading(3);
      await pickResponse('1');
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Column choice not applied for Response.'));
      expect(get('#im-line').getAttribute('role')).toBe('alert');
      await choose('[data-immap="priority"]', '1');
      expect(get('#im-line').textContent).toBe('Column choice not applied for Response.');
      await reopen();
      expect(get('#im-line').textContent).toBe('Column choice not applied for Response.');
      expect(get<HTMLSelectElement>('[data-immap="response"]').selectedOptions[0].text).toBe('Choose a Column');
      expect(get<HTMLButtonElement>('#im-go').disabled).toBe(true);
      await pickResponse('');
      expect(get('#im-line').textContent).not.toContain('choice not applied');
      expect(get<HTMLButtonElement>('#im-go').disabled).toBe(false);
    } finally {
      await done();
    }
  });

  it('carries a choice through sheet selection and its queued heading read (#741)', async () => {
    const { app, dealId, get, heading, letGo, pickResponse, choose, done } =
      await dialog(COLUMN_CHANGES, { otherSheet: true });
    try {
      await choose('#im-sheet', 'Updated review');
      await heading(3);
      await pickResponse('2');
      await letGo('Updated review');
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 1 question · 1 new'));
      expect(get<HTMLSelectElement>('[data-immap="response"]').selectedOptions[0].text).toBe('Final Notes');
      await act(() => get<HTMLButtonElement>('#im-go').click());
      await vi.waitFor(() => expect(dealQuestions(app.store.get(), dealId)[0]?.response)
        .toBe('Scheduled for the second quarter'));
    } finally {
      await done();
    }
  });

  it('recovers the selected source column from a kept import saved before column positions (#741)', async () => {
    const { get, heading, letGo, pickResponse, done } = await dialog(COLUMN_CHANGES, { legacy: true });
    try {
      await heading(3);
      await pickResponse('2');
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 1 question · 1 new'));
      expect(get<HTMLSelectElement>('[data-immap="response"]').selectedOptions[0].text).toBe('Final Notes');
    } finally {
      await done();
    }
  });

  it('carries an exclusion through a failed reread and retry (#741)', async () => {
    const { get, heading, letGo, pickResponse, failing, done } = await dialog();
    try {
      failing.add(3);
      await heading(3);
      await pickResponse('');
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toContain('file is locked'));
      failing.delete(3);
      await heading(1);
      await heading(3);
      await letGo(3);
      await vi.waitFor(() => expect(get('#im-line').textContent).toBe('Import 30 questions · 30 new'));
      expect(get<HTMLSelectElement>('[data-immap="response"]').value).toBe('');
    } finally {
      await done();
    }
  });

  it('keeps a column chosen while the model proposes a layout, at 2,000 questions (#741)', async () => {
    const lender = Array.from({ length: 2_000 }, (_, i) =>
      `Provide lender report ${i + 1},Reviewed ${i + 1},Reply ${i + 1}`);
    const csv = ['Question,Reviewed reply,Response', ...lender].join('\n');
    const { app, get, choose, reopen, done } = await dialog(csv);
    try {
      let propose = () => {};
      app.store.services.ai.layout = () => new Promise((resolve) => {
        const fields = { text: 'Question', response: 'Response' };
        propose = () => resolve(ok({ sheet: 'Sheet1', headerRow: 1, fields }));
      });
      await reopen();
      await act(() => {
        get('#im-ask').dispatchEvent(new Event('click'));
      });
      await vi.waitFor(() => expect(get<HTMLButtonElement>('#im-ask').textContent).toContain('Asking'));
      await choose('[data-immap="response"]', '1');
      await act(async () => propose());
      await vi.waitFor(() => expect(get<HTMLButtonElement>('#im-ask').textContent).not.toContain('Asking'));
      expect(get<HTMLSelectElement>('[data-immap="response"]').value).toBe('1');
      expect(get('#im-line').textContent).toBe('Import 2,000 questions · 2,000 new');
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
