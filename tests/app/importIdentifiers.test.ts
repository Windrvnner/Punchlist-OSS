// Merge never joins two questions that name different identifiers (#125, #127, #128): the import, its preview and the
// Q&A log's row matching each keep the saved question and its response, and make the row a question of its own.
// Misread letters and rewordings that name the same identifiers still match; a row matched by number alone that adds or
// drops an identifier, or names it in other capitals, does not.
import { describe, it, expect } from 'vitest';
import { SetResponse } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { dealQuestions } from '../../src/app/state';
import { previewImport } from '../../src/app/transfer';
import { matchRows, identifiers, identifierSig, sameIdentifiers, exactIdentifiers } from '../../src/domain/logWrite';
import type { Question } from '../../src/domain/model';
import { dealList } from '../backend/dealList';
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
  ['Please confirm the consents required under clause 4(a) of the facility agreement.',
    'Please confirm the consents required under clause 4(b) of the facility agreement.'],
  ['Please confirm the distribution rights for class a shares.',
    'Please confirm the distribution rights for class b shares.'],
  ['Please provide the list in Schedule 3 part e of the SPA.',
    'Please provide the list in Schedule 3 part f of the SPA.'],
  ['Please confirm the tranche a margin and fees.', 'Please confirm the tranche b margin and fees.'],
  ['Please confirm the consents required under clause 4 a of the facility agreement.',
    'Please confirm the consents required under clause 4 b of the facility agreement.'],
  ['Please confirm the consents required under clause 4( a ) of the facility agreement.',
    'Please confirm the consents required under clause 4( b ) of the facility agreement.'],
  ['Please confirm the indemnity cap under Section 1.10 of the SPA.',
    'Please confirm the indemnity cap under Section 11.0 of the SPA.'],
  ['Please confirm the distribution rights for class-a shares.',
    'Please confirm the distribution rights for class-b shares.'],
  ['Please confirm the distribution rights for class: a shares.',
    'Please confirm the distribution rights for class: b shares.'],
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
  ['Please confirm the FY 2024 audited accounts are final.', 'Please confirm the FY2024 audited accounts are final.'],
  ['Is the revolving facility commitment 25 m or more?', 'Is the revolving facility commitment 25m or more?'],
  ['Please confirm the interest rate on the Class A.1 notes.',
    'Please confirm the interest rate on the Class A1 notes.'],
  ['Has the SPA been signed by the cfo yet?', 'Has the spa been signed by the CFO yet?'],
  ['Is the arrangement fee I00 bps?', 'Is the arrangement fee 100 bps?'],
  ['Is the commitment fee O.5% per annum?', 'Is the commitment fee 0.5% per annum?'],
  ['Please confirm the consent requirements for Facility I1.',
    'Please confirm the consent requirements for Facility l1.'],
];

/** Tranche II outstanding debt reworded, the identifier kept: matched by its number only */
const REWORDED: [string, string] = ['Please confirm Tranche II outstanding debt for review',
  'Please confirm the Tranche II outstanding debt balance for review'];
/** the Tranche II question reworded without its identifier, close enough to match by number alone */
const DROPPED = 'Please confirm the outstanding debt for review';

/** [saved wording, incoming wording]: one question reworded under its own number, an article or the word I in one */
const PRONOUN: [string, string][] = [
  ['I understand the SPA is signed; please send the final version and the disclosure letter.',
    'We understand the SPA is signed; please send the final version and the disclosure letter.'],
  ['Can I get a copy of the signed facility agreement and the fee letter?',
    'Can we get a copy of the signed facility agreement and the fee letter now?'],
  ['Please confirm whether I should send the board minutes and the shareholder register.',
    'Please confirm whether we should send the board minutes and the shareholder register now.'],
  ['Please provide a schedule of all material leases and their expiry dates.',
    'Please provide the schedule of all material leases and their expiry dates.'],
  ['Is there a facility agreement in place for the acquisition financing?',
    'Is there the facility agreement in place for the acquisition financing?'],
  ['Please send the list for each item. I understand it is in the data room.',
    'Please send the list for each item. We understand it is in the data room folder.'],
];

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

/** the import, its preview and the log's row matching each keep the saved question and add `incoming` as its own */
async function apart(before: string, incoming: string, n: number) {
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
}

describe('a row naming another identifier is a question of its own', () => {
  for (const [before, incoming] of DISTINCT) for (const n of [1, 2]) {
    it(`${before} / ${incoming}, number ${n}`, () => apart(before, incoming, n));
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
  for (const [before, incoming] of PRONOUN) {
    it(`the word I is no identifier: ${incoming}`, () => matches(before, incoming, 1));
  }
  it('a prose word that reads as a numeral is no identifier', () => matches(
    'Please confirm revenue mix by segment and region for the group',
    'Please confirm revenue by segment and region for the group', 1));
  it('a reworded row that drops an identifier is a question of its own', () => apart(REWORDED[0], DROPPED, 1));
  it('a reworded row that adds an identifier is a question of its own', () => apart(DROPPED, REWORDED[0], 1));
  it('a reworded row that adds a letter the question uses as the article a is a question of its own', () => apart(
    'Please provide a breakdown of shares by holder for review',
    'Please provide a breakdown of Class A shares by holder for review', 1));
  it('a reworded row that names a code in other capitals is a question of its own', () => apart(
    'Please send us the cap table for review', 'Please send us the US cap table for review', 1));
  it('but not under another number, as before', async () => {
    const { store, dealId, original } = await saved(REWORDED[0]);
    const rows = fileRow(2, REWORDED[1], 'New answer');
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
    expect(store.get().questions[original.id]).toEqual(original);
  });
});

describe('the identifiers a question names', () => {
  it('are numbers, capital numerals, letters and codes, and letters a clause or class names, as they read', () => {
    expect(identifiers('Is the O&M fee for Facility I1 under the SPA 2O24 or l00?'))
      .toEqual(['100', '2024', 'i1', 'm', 'o', 'spa']);
    expect(identifiers('I understand the phase I report is final.')).toEqual(['i']);
    expect(identifiers('l understand the Class ii terms under clause 4(b).')).toEqual(['4', 'b', 'ii']);
    expect(identifiers('Please confirm revenue mix by segment, 25 m or more.')).toEqual(['25']);
    expect(identifiers('Is it I00, O.5, I.1 or O1?')).toEqual(['0.5', '100', 'i.1', 'o1']);
    expect(identifiers('Facility l1 and o1, or can I send the agreement?')).toEqual(['i1', 'o1']);
    expect(identifiers('Please provide the signed agreement.')).toEqual([]);
  });
  it('differ only when each wording names one the other does not, however it is spaced or capitalized', () => {
    const same = (a: string, b: string) => sameIdentifiers(identifierSig(a), identifierSig(b));
    expect(same('Tranche II', 'Tranche IV')).toBe(false);
    expect(same('Class A and Tranche II', 'Tranche II')).toBe(true);
    const exact = (a: string, b: string) => exactIdentifiers(identifierSig(a), identifierSig(b));
    expect(exact('Class A and Tranche II', 'Tranche II')).toBe(false);
    expect(exact('Tranche II', 'Class A and Tranche II')).toBe(false);
    expect(exact('send the SPA now', 'send the spa')).toBe(false);
    expect(same('the facility', 'Facility B')).toBe(true);
    expect(same('the FY 2024 accounts', 'the FY2024 accounts')).toBe(true);
  });
});

/** [saved suffix, incoming suffix]: what each of a deal's questions names, and another identifier that reads alike */
const LOOKALIKES: [string, string][] = [['for Facility I1', 'for Facility 11'], ['for Facility O1', 'for Facility 01'],
  ['for Class I.1', 'for Class 1.1'], ['for Tranche II', 'for Tranche IV'], ['for Tranche V', 'for Tranche X'],
  ['for Class A', 'for Class B'], ['under the SPA', 'under the SHA'], ['for Facility 2', 'for Facility 4'],
  ['for Class I shares', 'for Class L shares']];
/** a lowercase l read as a capital I inside words, as a scan reads it */
const scanned = (text: string) => text.replace(/(?<=\p{L})l|l(?=\p{L})/gu, 'I');

describe('a lender\'s list of 2,400 questions merged into a full log', () => {
  it('updates the questions it asks again, keeps every other saved response, and matches log rows alike', async () => {
    const { store } = make(); const dealId = await deal(store);
    const asks = dealList().items.map((item, i) => `${item} ${LOOKALIKES[i % LOOKALIKES.length][0]}`);
    const header = 'Number,Question,Response,Submitted by,Workstream';
    const log = asks.map((text, i) => [String(i + 1), text, `Saved response ${i + 1}`, 'Lender', 'Finance']);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: sheet(header, log) })).ok).toBe(true);
    const before = new Map(dealQuestions(store.get(), dealId).map((q) => [q.n, structuredClone(q)]));
    // even questions come back scanned and renumbered; odd ones name a lookalike identifier, half under their number
    const incoming = asks.map((text, i) => i % 2 === 0
      ? [String(asks.length - i), scanned(text), `Updated ${i + 1}`]
      : [String(i % 4 === 1 ? i + 1 : i + 5001), text.replace(LOOKALIKES[i % LOOKALIKES.length][0],
        LOOKALIKES[i % LOOKALIKES.length][1]), `New ${i + 1}`]);
    const rows = sheet(header, incoming.map(([n, text, response]) => [n, text, response, 'Lender', 'Finance']));
    const preview = previewImport(store, dealId, 'merge', rows);
    expect(preview.ok && preview.value).toMatchObject({ created: 1200, updated: 1200, restored: 0 });
    const at = Date.now();
    const result = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows });
    const ms = Date.now() - at; console.log('2,400-row merge with lookalike identifiers, ms:', ms);
    if (!result.ok) throw new Error(result.error.message);
    expect(ms).toBeLessThan(10_000);
    expect(dealQuestions(store.get(), dealId)).toHaveLength(3600);
    for (const [n, q] of before) {
      const now = store.get().questions[q.id];
      if (n % 2 === 0) expect(now).toEqual(q);
      else expect(now).toMatchObject({ n, text: scanned(q.text), response: `Updated ${n}` });
    }
    expect(matchedRows(incoming, [...before.values()])).toEqual(new Map([...before.values()]
      .filter((q) => q.n % 2 === 1).map((q) => [q.id, q.n - 1])));
    expect((await store.undo(result.value.opId)).ok).toBe(true);
    // Undo writes each question back as a new revision
    const content = (q: Question) => ({ ...q, rev: 0, updatedAt: '' });
    expect(dealQuestions(store.get(), dealId).map(content)).toEqual([...before.values()].map(content));
  }, 120_000);
});

/** the log's row matching of `incoming` to `questions`, timed */
function matchedRows(incoming: string[][], questions: Question[]) {
  const at = Date.now();
  const rows = matchRows({ rows: incoming.map(([n, text, response]) => [n, text, response, 'Lender', 'Finance']) },
    mapping, questions);
  const ms = Date.now() - at; console.log('2,400-row log match with lookalike identifiers, ms:', ms);
  expect(ms).toBeLessThan(5_000);
  return rows;
}
