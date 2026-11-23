// Merge never joins two questions that name different identifiers (#125, #127, #128): the import, its preview and the
// Q&A log's row matching each keep the saved question and its response, and make the row a question of its own.
// Misread letters and rewordings that name the same identifiers still match.
import { describe, it, expect } from 'vitest';
import { SetResponse } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { dealQuestions } from '../../src/app/state';
import { previewImport } from '../../src/app/transfer';
import { matchRows, identifiers, sameIdentifiers } from '../../src/domain/logWrite';
import { make, deal, sheet, mapping, fileRow } from './importKit';

/** [saved wording, incoming wording]: different questions that a misreading or a reworded number could join */
const DISTINCT: [string, string][] = [
  ['Please confirm Tranche II outstanding debt for review', 'Please confirm Tranche IV outstanding debt for review'],
  ['Please confirm Tranche V outstanding debt for review', 'Please confirm Tranche X outstanding debt for review'],
  ['I shares require lender consent?', 'L shares require lender consent?'],
  ['I class holders vote separately on the refinancing?', 'L class holders vote separately on the refinancing?'],
  ['Please confirm the consent requirements for Facility I1.',
    'Please confirm the consent requirements for Facility 11.'],
  ['Please confirm the consent requirements for Class I.1.', 'Please confirm the consent requirements for Class 1.1.'],
  ['Please confirm the consent requirements for Facility O1.',
    'Please confirm the consent requirements for Facility 01.'],
  ['Please confirm the distribution rights for Class A shares.',
    'Please confirm the distribution rights for Class B shares.'],
  ['Please provide the signed SPA and disclosure letter.', 'Please provide the signed SHA and disclosure letter.'],
  ['Please confirm the consent requirements for Facility 2.',
    'Please confirm the consent requirements for Facility 4.'],
  ['Please confirm the distribution rights for Class IA shares.',
    'Please confirm the distribution rights for Class LA shares.'],
];

/** [saved wording, incoming wording]: one question, misread or reworded, naming the same identifiers */
const SAME: [string, string][] = [
  ['I understand the lender requires the DSCR model; please confirm.',
    'l understand the lender requires the DSCR model; please confirm.'],
  ['I shares require lender consent?', 'l shares require lender consent?'],
  ['Is the O&M contract signed?', 'ls the O&M contract signed?'],
  ['IS the O&M contract signed?', 'Is the O&M contract signed?'],
  ['Is the arrangement fee 100 bps for Tranche II?', 'Is the arrangement fee l00 bps for Tranche II?'],
  ['Please confirm the 2024 audited accounts for Facility A.',
    'Please confirm the 2O24 audited accounts for Facility A.'],
];

/** Tranche II outstanding debt reworded, the identifier kept: matched by its number only */
const REWORDED: [string, string] = ['Please confirm Tranche II outstanding debt for review',
  'Please confirm the Tranche II outstanding debt balance for review'];

/** a deal holding `text` as question 1, with a typed response: the deal and the question as saved */
async function saved(text: string) {
  const { store } = make(); const dealId = await deal(store);
  const rows = fileRow(1, text, 'Imported answer');
  expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows })).ok).toBe(true);
  const original = dealQuestions(store.get(), dealId)[0];
  const typed = { dealId, questionId: original.id, response: 'Typed answer' };
  expect((await store.dispatch(SetResponse, typed)).ok).toBe(true);
  return { store, dealId, original: structuredClone(store.get().questions[original.id]) };
}
/** the log's row for `text` under number `n`, as the log's row matching reads it */
const logRow = (n: number, text: string) => [String(n), text, 'New answer', 'Lender', 'Finance'];

describe('a row naming another identifier is a question of its own', () => {
  for (const [before, incoming] of DISTINCT) for (const n of [1, 2]) {
    it(`${before} / ${incoming}, number ${n}`, async () => {
      const { store, dealId, original } = await saved(before);
      expect(matchRows({ rows: [logRow(n, incoming)] }, mapping, [original])).toEqual(new Map());
      const rows = fileRow(n, incoming, 'New answer');
      expect(previewImport(store, dealId, 'merge', rows))
        .toEqual({ ok: true, value: { created: 1, updated: 0, restored: 0, changes: [] } });
      const result = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows });
      if (!result.ok) throw new Error(result.error.message);
      expect(store.get().questions[original.id]).toEqual(original);
      const added = dealQuestions(store.get(), dealId).filter((q) => q.id !== original.id);
      expect(added).toMatchObject([{ text: incoming, response: 'New answer' }]);
      expect((await store.undo(result.value.opId)).ok).toBe(true);
      expect(dealQuestions(store.get(), dealId)).toEqual([original]);
    });
  }
});

describe('a misread or reworded row naming the same identifiers is still the question', () => {
  const matches = async (before: string, incoming: string, n: number) => {
    const { store, dealId, original } = await saved(before);
    expect(matchRows({ rows: [logRow(n, incoming)] }, mapping, [original])).toEqual(new Map([[original.id, 0]]));
    const rows = fileRow(n, incoming, 'New answer');
    expect(previewImport(store, dealId, 'merge', rows)).toMatchObject({ ok: true, value: { created: 0, updated: 1 } });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
    expect(dealQuestions(store.get(), dealId))
      .toMatchObject([{ id: original.id, n: 1, text: incoming, response: 'New answer' }]);
  };
  for (const [before, incoming] of SAME) for (const n of [1, 7]) {
    it(`${before} / ${incoming}, number ${n}`, () => matches(before, incoming, n));
  }
  it('a question reworded under its own number, its identifier kept', () => matches(...REWORDED, 1));
  it('but not under another number, as before', async () => {
    const { store, dealId, original } = await saved(REWORDED[0]);
    const rows = fileRow(2, REWORDED[1], 'New answer');
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
    expect(store.get().questions[original.id]).toEqual(original);
  });
});

describe('the identifiers a question names', () => {
  it('are numbers, Roman numerals, single capitals and short capital codes, compared as they read', () => {
    expect(identifiers('Is the O&M fee for Facility I1 under the SPA 2O24 or l00?'))
      .toEqual(['100', '2024', 'i1', 'm', 'o', 'spa']);
    expect(identifiers('I understand the phase I report is final.')).toEqual(['i', 'i']);
    expect(identifiers('l understand the Class ii terms.')).toEqual(['i', 'ii']);
    expect(identifiers('Please provide the signed agreement.')).toEqual([]);
  });
  it('differ only when each wording names one the other does not', () => {
    expect(sameIdentifiers(['ii'], ['iv'])).toBe(false);
    expect(sameIdentifiers(['a', 'ii'], ['ii'])).toBe(true);
    expect(sameIdentifiers([], ['b'])).toBe(true);
    expect(sameIdentifiers(['i', 'spa'], ['i', 'spa'])).toBe(true);
  });
});
