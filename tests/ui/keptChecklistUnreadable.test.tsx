// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { useKeepImport, useKeeper, type KeptNow } from '../../src/ui/firmChecklistKept';
import { dropImport, importKey, keepImport, keptImport, keptImportsReady } from '../../src/ui/keptImports';
import type { ImportTable } from '../../src/app/transfer';

const key = importKey.checklist();
/** A kept import this build cannot show: its layer is not a layer (#381) */
const unreadable = {
  paste: 'Corporate records\nMaterial contracts\nLitigation',
  table: null, text: null, reads: null, review: null,
  choices: {
    mapping: { item: 0, section: null }, layer: 'not-a-layer', name: '', askReword: false, askSame: false,
    shown: false, askedFor: '', useReword: new Set(), remove: new Set(), readFailed: '', byColumns: false,
    bringIn: new Set(),
  },
};
const choices: KeptNow['choices'] = {
  mapping: { item: 0, section: null }, layer: 'broad', name: '', askReword: false, askSame: false, shown: false,
  useReword: new Set(), remove: new Set(), readFailed: '', byColumns: false, bringIn: new Set(),
};
const table: ImportTable = { name: 'list.csv', columns: ['Item'], rows: [['Corporate records']], bytes: new Uint8Array(1) } as
  unknown as ImportTable;

/** The import dialog's keeping, as the dialog wires it, with the paste box and list it is given */
function Keeping(props: { paste: string; table?: ImportTable | null; fresh?: boolean; seen?: (left: unknown) => void }) {
  const keeper = useKeeper(undefined, undefined, props.fresh ?? false);
  props.seen?.(keeper.left);
  const now: KeptNow = {
    paste: props.paste, table: props.table ?? null, text: null, reads: null, review: null,
    askedFor: { current: '' }, choices,
  };
  useKeepImport(keeper, now);
  return null;
}

describe('a kept checklist import that cannot be shown (#381)', () => {
  const screen = document.createElement('div');
  afterEach(() => {
    render(null, screen);
    dropImport(key);
  });

  it('is left as it is when the import opens, closes and opens again with nothing typed', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    let left: unknown = 'not read';
    await act(() => render(<Keeping paste="" seen={(value) => { left = value; }} />, screen));
    expect(left).toBeNull();
    await act(() => render(null, screen));
    await act(() => render(<Keeping paste="" />, screen));
    expect(keptImport(key)).toEqual(unreadable);
  });

  it('is replaced whole by a new paste, which then opens as a paste alone', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    await act(() => render(<Keeping paste="" />, screen));
    await act(() => render(<Keeping paste="Tax returns" />, screen));
    expect(keptImport(key)).toEqual({
      paste: 'Tax returns', table: null, text: null, reads: null, review: null, choices: undefined,
    });
    await act(() => render(null, screen));
    let left: unknown;
    await act(() => render(<Keeping paste="Tax returns" seen={(value) => { left = value; }} />, screen));
    expect(left).toMatchObject({ paste: 'Tax returns' });
  });

  it('keeps a new paste cleared after it was typed, as typed', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    await act(() => render(<Keeping paste="" />, screen));
    await act(() => render(<Keeping paste="Tax returns" />, screen));
    await act(() => render(<Keeping paste="" />, screen));
    expect(keptImport(key)?.paste).toBe('');
    expect(keptImport(key)?.choices).toBeUndefined();
  });

  it('is replaced whole by a list read in its place', async () => {
    await keptImportsReady;
    keepImport(key, unreadable);
    await act(() => render(<Keeping paste="" />, screen));
    await act(() => render(<Keeping paste="" table={table} />, screen));
    expect(keptImport(key)).toMatchObject({ paste: '', table, choices: { layer: 'broad' } });
  });

  it('leaves a readable kept import to be shown and kept as it changes', async () => {
    await keptImportsReady;
    keepImport(key, { paste: 'Corporate records' });
    let left: unknown;
    await act(() => render(<Keeping paste="Corporate records" seen={(value) => { left = value; }} />, screen));
    expect(left).toMatchObject({ paste: 'Corporate records' });
    await act(() => render(<Keeping paste="" />, screen));
    expect(keptImport(key)?.paste).toBe('');
  });
});
