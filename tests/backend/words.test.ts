// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { indexWords, topWords, tokens } from '../../src/backend/words';

describe('the words a document uses most', () => {
  it('leaves out only the words every sentence has, and splits text as the word index does (#1147)', () => {
    const loan = 'The Borrower shall, on or before June 30, 2027, pay to the Lender USD 4,500,000 (the "Fee").';
    const loanWords = ['borrower', 'june', '30', '2027', 'pay', 'lender', 'usd', '4', '500', '000', 'fee'];
    expect(indexWords(loan)).toEqual(loanWords);
    const clause = 'Pursuant to Clause 12.3 hereof, the O&M Contractor’s duties and the Owner\'s rights';
    expect(indexWords(clause)).toEqual(['clause', '12', '3', 'om', 'contractor', 's', 'duty', 'owner', 's', 'right']);
    const terms = ['take', 'pay', 'non', 'recourse', 'dscr', 'p50', 'co', 'operation'];
    expect(indexWords('take-or-pay; non-recourse; DSCR; P50; co-operation')).toEqual(terms);
    expect(indexWords('')).toEqual([]);
    expect(indexWords('12 345 6.7 % — §')).toEqual(['12', '345', '6', '7']);
  });
  it('keeps numbers and words of one or two letters among the most used (#1147)', () => {
    const page = (n: number) => `Annual report 2024 page ${n} of Schedule B, EU and UK sites`;
    const pages = Array.from({ length: 12 }, (_, i) => page(i + 1)).join('\n');
    expect(topWords(pages)).toEqual(expect.arrayContaining(['2024', 'b', 'eu', 'uk']));
  });
  it('counts a plural and its singular as one word, as the word index does (#1147)', () => {
    expect(topWords('Report reports report; monthly reports; audit')).toEqual(['report', 'audit', 'monthly']);
  });
  it('keeps the most used, most used first, and words used equally often in the order of the alphabet', () => {
    const permits = 'permit permit permit emissions emissions air zoning air stack';
    expect(topWords(permits, 3)).toEqual(['permit', 'air', 'emission']);
    expect(topWords('zeta alpha mid')).toEqual(['alpha', 'mid', 'zeta']);
    const many = Array.from({ length: 50 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x `.repeat(50 - i)).join(' ');
    expect(topWords(many).length).toBe(30); expect(topWords(many)[0]).toBe('wordaax'); expect(topWords(many, 5).length).toBe(5);
    expect(topWords('the and of to')).toEqual([]);
  });
});

describe('tokens keep combining marks inside words (#1154)', () => {
  it('keeps a word with vowel signs whole', () => {
    expect(tokens('दिन')).toEqual(['दिन']);
  });
  it('keeps a combining accent in its word', () => {
    expect(tokens('cafe\u0301')).toEqual(['cafe\u0301']);
  });
  it('splits camelCase after a mark', () => {
    expect(tokens('cafe\u0301Bar')).toEqual(['cafe\u0301', 'bar']);
    expect(tokens('caféBar')).toEqual(['café', 'bar']);
  });
  it('does not normalize: a composed and a decomposed accent are different words', () => {
    expect(tokens('caf\u00e9')).not.toEqual(tokens('cafe\u0301'));
  });
});
