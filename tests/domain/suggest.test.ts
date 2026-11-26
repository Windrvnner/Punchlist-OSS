import { describe, it, expect } from 'vitest';
import { findQuestions } from '../../src/domain/suggest';

const q = (n: number, text: string) => ({ id: 'q' + n, n, text });
const OPERATING = q(4, 'Confirm the operating assumption used in the base case, and where it comes from. If the technical advisor and the information memorandum differ, say which one the model follows and why.');
const INSURANCE = q(7, 'Provide the insurance certificates for the construction period.');
const LOCKUP = q(2, 'Which lock-up ratio was agreed: the one in the credit agreement draft or the term sheet?');

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
