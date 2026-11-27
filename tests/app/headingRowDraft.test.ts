// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { HeadingRowDraft, clearChecklistHeading, headingRow, keptHeadingDraft } from '../../src/app/listRead';
import { dropImport, keptImport } from '../../src/app/keptImports';

it.each([
  ['1', 1], ['1e1', 10], ['2.0', 2], ['2.000000000000001', null], ['2.9999999999999999', null],
  ['11', null], ['', null], ['0', null],
])('reads %s only when it names a whole row on this sheet', (text, row) => {
  expect(headingRow(String(text), 10)).toBe(row);
});

it('keeps the latest heading text with the accepted sheet through superseding reads and a reopen', async () => {
  const key = 'checklist:headings';
  dropImport(key);
  const main = { sheet: 'Main', headerRow: 1, lastRow: 5, bytes: new Uint8Array([1]) };
  const extra = { ...main, sheet: 'Supplement', headerRow: 4, lastRow: 14 };
  const draft = new HeadingRowDraft(key, main, () => {});
  type Accept = (table: typeof main) => void;
  const read = vi.fn<(row: number, accept: Accept) => Promise<void>>();
  let stale!: Accept;
  let finish!: () => void;
  read.mockImplementationOnce((_row, accept) => new Promise((resolve) => { stale = accept; finish = resolve; }));
  const old = draft.pick('3', read);
  await draft.pick('3.0', read);
  expect(read).toHaveBeenCalledTimes(1);
  draft.update(main, 'Another sheet', read);
  await draft.pick('8', read);
  expect(draft.view.max).toBeUndefined();
  draft.update(main, extra.sheet, read);
  draft.update(extra, extra.sheet, read);
  expect(draft.view.text).toBe('4');
  stale({ ...main, headerRow: 3 });
  finish();
  await old;
  expect(keptHeadingDraft(key, extra)).toBe('4');
  draft.update(extra, main.sheet, read);
  await draft.pick('11', read);
  draft.update(main, main.sheet, read);
  expect(read).toHaveBeenCalledTimes(1);
  expect(draft.view).toMatchObject({ text: '11', max: 5, reason: 'range' });
  expect(keptImport(key)?.headingDraft).toEqual({ sheet: 'Main', headerRow: 1, text: '11' });
  draft.dispose();
  const reopened = new HeadingRowDraft(key, main, () => {});
  expect(reopened.view.text).toBe('11');
  clearChecklistHeading(key);
  reopened.update({ ...main, bytes: new Uint8Array([2]) }, main.sheet, read);
  expect(reopened.view.text).toBe('1');
  expect(keptImport(key)?.headingDraft).toBeNull();
});
