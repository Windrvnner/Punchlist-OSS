// @vitest-environment node
// The checklist import as kept on this PC: what can be shown again, and what a paste or a list writes over
// (#381, #951).
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import {
  keepChecklistImport, readKeptChecklist, type ChecklistChoices, type ChecklistKept,
} from '../../src/app/checklistKept';
import { importKey, initializeKeptImports, keepImport, keptImport, keptImportsReady } from '../../src/app/keptImports';
import type { ImportTable } from '../../src/app/transfer';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const key = importKey.checklist();
const items = portfolioQuestions().slice(0, 2_000);
const choices: ChecklistChoices = {
  mapping: { item: 0, section: null }, layer: 'broad', name: 'Portfolio diligence', askReword: false, askSame: false,
  shown: false, askedFor: '', useReword: new Set([3]), remove: new Set(), readFailed: '', byColumns: true,
  bringIn: new Set(),
};
const table = {
  name: 'list.csv', columns: ['Item'], rows: items.map((item) => [item]), bytes: new Uint8Array(4),
} as unknown as ImportTable;
const whole: ChecklistKept & { paste: string } = {
  paste: '', table, text: null, reads: null, review: null, choices,
};

beforeEach(async () => {
  initializeKeptImports(new MemoryKeptImports());
  await keptImportsReady;
});

describe('reading a kept checklist import', () => {
  it('shows a whole one, opens fresh past nothing kept, and ignores what is kept when asked to start fresh', () => {
    expect(readKeptChecklist(key, false)).toEqual({ left: null, unreadable: false });
    keepImport(key, { ...whole });
    expect(readKeptChecklist(key, false)).toEqual({ left: whole, unreadable: false });
    expect(readKeptChecklist(key, true)).toEqual({ left: null, unreadable: false });
  });

  it.each([
    ['a layer that is not a layer', { ...whole, choices: { ...choices, layer: 'not-a-layer' } }],
    ['marks that are not sets', { ...whole, choices: { ...choices, useReword: [3] } }],
    ['bytes that are not bytes', { ...whole, table: { ...table, bytes: [1, 2] } }],
    ['a review without its lists', { ...whole, review: { items: [], rewords: [], asked: {} } }],
    ['a paste that is not text', { ...whole, paste: 42 }],
    ['lines that are not a list', { ...whole, text: { name: 'list.docx', lines: 'Item' } }],
    ['reads that are not a map', { ...whole, reads: [] }],
  ])('opens fresh past %s, saying it could not be shown', (_, damaged) => {
    keepImport(key, damaged);
    expect(readKeptChecklist(key, false)).toEqual({ left: null, unreadable: true });
  });
});

describe('a checklist import kept with a bare Map of readings (#1073)', () => {
  const rows = ['Item | Section', 'Audited accounts | Financial', 'Lease | Property'];
  const oldReads = new Map([[2, { k: 'item', words: 'Audited accounts' }], [3, { k: 'item', words: 'Lease' }]]);

  it('reads again text pasted from a spreadsheet, so no row is left out', () => {
    const text = { name: 'list.txt', lines: rows };
    keepImport(key, { ...whole, table: null, text, reads: oldReads });
    const { left } = readKeptChecklist(key, false);
    // before the app marked its cell rows, a line holding " | " was one
    const cellRows = rows.flatMap((line, i) => (line.includes(' | ') ? [i + 1] : []));
    expect(cellRows.length).toBeGreaterThan(0);
    expect(left).toEqual({ ...whole, table: null, text: { ...text, cellRows }, reads: null });
  });

  it('keeps the cell rows of a text that has them, and marks none in plain text', () => {
    const marked = { name: 'list.txt', lines: ['a | b', 'c | d'], cellRows: [2] };
    keepImport(key, { ...whole, table: null, text: marked, reads: null });
    expect(readKeptChecklist(key, false).left?.text).toEqual(marked);
    const plain = { name: 'list.txt', lines: ['Audited accounts', 'Lease'] };
    keepImport(key, { ...whole, table: null, text: plain, reads: oldReads });
    expect(readKeptChecklist(key, false).left?.text?.cellRows).toEqual([]);
  });

  it('shows plain text with the Map as its reading', () => {
    const text = { name: 'list.txt', lines: ['Audited accounts', 'Lease'] };
    keepImport(key, { ...whole, table: null, text, reads: oldReads });
    expect(readKeptChecklist(key, false).left?.reads).toEqual({ reads: oldReads });
  });
});

describe('keeping the checklist import as it changes', () => {
  it('writes a list over whole and stops setting aside', () => {
    keepImport(key, { paste: 'An earlier paste', headingDraft: '3' });
    expect(keepChecklistImport(key, whole, true)).toBe(false);
    expect(keptImport(key)).toMatchObject({ table, choices, paste: '' });
  });

  it('leaves a set-aside import as it is until something is typed, then replaces all of it', () => {
    const unreadable = { ...whole, choices: { ...choices, layer: 'not-a-layer' }, headingDraft: '2' };
    keepImport(key, unreadable);
    const blank = { ...whole, table: null, paste: '  ' };
    expect(keepChecklistImport(key, blank, true)).toBe(true);
    expect(keptImport(key)).toEqual(unreadable);
    const typed = { ...blank, paste: items.slice(0, 50).join('\n') };
    expect(keepChecklistImport(key, typed, true)).toBe(false);
    expect(keptImport(key)).toEqual({
      paste: typed.paste, table: null, text: null, reads: null, review: null, choices: undefined, headingDraft: null,
    });
  });

  it('keeps a paste alone only once something is typed or a paste was kept', () => {
    const blank = { ...whole, table: null, paste: '' };
    expect(keepChecklistImport(key, blank, false)).toBe(false);
    expect(keptImport(key)).toBeUndefined();
    expect(keepChecklistImport(key, { ...blank, paste: 'Corporate records' }, false)).toBe(false);
    expect(keptImport(key)).toEqual({ paste: 'Corporate records' });
    expect(keepChecklistImport(key, blank, false)).toBe(false);
    expect(keptImport(key)).toEqual({ paste: '' });
  });
});
