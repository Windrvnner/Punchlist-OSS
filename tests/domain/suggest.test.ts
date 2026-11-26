import { describe, it, expect } from 'vitest';
import { askedMatcher, mayAddress, tellingWords, findQuestions } from '../../src/domain/suggest';

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

describe('the open question that most likely asks what an unresolved point lacks (#1218)', () => {
  const GAP = 'Insurance advisor report (final)';
  it('scores the share of the point’s telling words that the question names, as a whole percent', () => {
    const full = q(1, 'Has the insurance advisor issued its final report yet?');
    expect(askedMatcher([full])(GAP)).toEqual({ q: full, confidence: 100 });
    const part = q(2, 'Please send the insurance advisor report.');
    expect(askedMatcher([part])(GAP)).toEqual({ q: part, confidence: 75 });
  });
  it('names the best-covering question, the lower number when two cover the point equally', () => {
    const a = q(3, 'Insurance advisor report?');
    const b = q(2, 'Insurance advisor report, please.');
    const best = q(5, 'Insurance advisor final report?');
    expect(askedMatcher([a, b, best])(GAP)?.q.n).toBe(5);
    expect(askedMatcher([a, b])(GAP)?.q.n).toBe(2);
  });
  it('names nothing when no telling word is shared, or the point has none', () => {
    expect(askedMatcher([INSURANCE])('Lock-up ratio')).toBeUndefined();
    expect(askedMatcher([INSURANCE])('and the of')).toBeUndefined();
    expect(askedMatcher([])(GAP)).toBeUndefined();
  });
});
