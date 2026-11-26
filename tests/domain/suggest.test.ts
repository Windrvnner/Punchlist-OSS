import { describe, it, expect } from 'vitest';
import { mayAddress, tellingWords, findQuestions } from '../../src/domain/suggest';

const q = (n: number, text: string) => ({ id: 'q' + n, n, text });
const OPERATING = q(4, 'Confirm the operating assumption used in the base case, and where it comes from. If the technical advisor and the information memorandum differ, say which one the model follows and why.');
const INSURANCE = q(7, 'Provide the insurance certificates for the construction period.');
const LOCKUP = q(2, 'Which lock-up ratio was agreed: the one in the credit agreement draft or the term sheet?');
const ANSWER = 'The closest support in the data room: The technical advisor supports a lower figure than the one the information memorandum relies on. The base case uses the higher figure throughout.';

describe('which open questions an answer may address', () => {
  it('finds the question that shares enough telling words with the answer', () => {
    expect(mayAddress(ANSWER, [INSURANCE, OPERATING, LOCKUP]).map((x) => x.n)).toEqual([4]);
  });
  it('words any diligence text uses, and plain plurals, do not make a match', () => {
    expect([...tellingWords('Please confirm the documents and provide the agreements')]).toEqual(['agreement']);
    expect(mayAddress('Please provide the documents and confirm the response to this question.', [q(1, 'Please provide the documents and confirm the response.')])).toEqual([]);
  });
  it('numbers, single letters and short tokens are telling words, split as the index splits them (#1220)', () => {
    const words = [...tellingWords('DSCR of 1.25x, EPC and O&M for unit 2')].sort();
    expect(words).toEqual(['1', '2', '25x', 'dscr', 'epc', 'om', 'unit']);
    const named = [...tellingWords('PowerPurchase-Agreement_executed')];
    expect(named).toEqual(['power', 'purchase', 'agreement', 'executed']);
  });
  it('a passing mention is not an answer: at least three shared words, and a third of the question’s', () => {
    expect(mayAddress('The term sheet was signed in March.', [LOCKUP])).toEqual([]);
    const long = q(9, 'Describe the operating assumption, availability, degradation, curtailment, outages, warranties, spares, staffing, budget and reporting of the operator.');
    expect(mayAddress('The operating assumption is 98% availability.', [long])).toEqual([]);
  });
  it('the likeliest first, and the lower number when two are as likely', () => {
    const a = q(3, 'Lock-up ratio agreed in the credit agreement?'); const b = q(1, 'Lock-up ratio agreed in the credit agreement draft?');
    expect(mayAddress('The credit agreement draft sets the lock-up ratio at 1.25x, lower than agreed.', [a, b, LOCKUP]).map((x) => x.n)).toEqual([1, 2, 3]);
  });
  it('nothing to match against, nothing suggested', () => {
    expect(mayAddress('', [OPERATING])).toEqual([]);
    expect(mayAddress(ANSWER, [])).toEqual([]);
  });
});

describe('the open questions a person picks from, narrowed as they type', () => {
  const list = [LOCKUP, INSURANCE, OPERATING, q(12, 'List the permits still outstanding for the substation.'), q(21, 'Confirm the interconnection date; 12 months of delay damages are capped.')];
  const ns = (typed: string) => findQuestions(typed, list).map((x) => x.n);
  it('nothing typed: every question, in order of number', () => expect(ns('')).toEqual([2, 4, 7, 12, 21]));
  it('a number, with or without Q: that question first, then numbers starting with it, then texts that have it', () => {
    expect(ns('12')).toEqual([12, 21]); expect(ns('Q12')).toEqual([12, 21]); expect(ns(' q 2 ')).toEqual([2, 21]); expect(ns('99')).toEqual([]);
  });
  it('words: the questions that have every one of them, whatever the case', () => {
    expect(ns('Lock-up')).toEqual([2]); expect(ns('the base')).toEqual([4]); expect(ns('confirm')).toEqual([4, 21]); expect(ns('permit sub')).toEqual([12]); expect(ns('permit lock')).toEqual([]);
  });
  it('leaves the list it was given as it was', () => { findQuestions('', list); expect(list.map((x) => x.n)).toEqual([2, 7, 4, 12, 21]); });
});
