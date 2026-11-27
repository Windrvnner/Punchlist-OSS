// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { initializeKeptImports, keptImportsReady } from '../../src/app/keptImports';
import { HeadingRowField } from '../../src/ui/headingRowField';

it('counts a row typed while its sheet was read as an edit again when that row is read (#1201)', async () => {
  initializeKeptImports(new MemoryKeptImports());
  await keptImportsReady;
  const main = { sheet: 'Main', headerRow: 1, lastRow: 5 };
  const extra = { sheet: 'Extra', headerRow: 1, lastRow: 9 };
  const onEdit = vi.fn();
  const read = vi.fn(async () => {});
  const screen = document.createElement('div');
  const field = (table: typeof main) => (
    <HeadingRowField id="hr" importKey="qa:heading-edit" table={table} sheet="Extra" read={read} onEdit={onEdit} />
  );
  try {
    await act(() => render(field(main), screen));
    const input = screen.querySelector<HTMLInputElement>('#hr')!;
    await act(() => {
      input.value = '3';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect([onEdit.mock.calls.length, read.mock.calls.length]).toEqual([1, 0]);
    await act(() => render(field(extra), screen));
    expect([onEdit.mock.calls.length, read.mock.calls.length]).toEqual([2, 1]);
  } finally {
    render(null, screen);
  }
});
