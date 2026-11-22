// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { wordsIn, topWords } from '../../src/backend/words';

describe('the words a document uses most', () => {
  it('leaves out the words every sentence has, numbers, and anything shorter than three letters', () => {
    expect(wordsIn('The Borrower shall, on or before June 30, 2027, pay to the Lender an amount of USD 4,500,000 (the "Fee").')).toEqual(['borrower', 'june', 'pay', 'lender', 'amount', 'usd', 'fee']);
    expect(wordsIn('Pursuant to Clause 12.3 hereof, the O&M Contractor’s obligations and the Owner\'s rights are set out in Schedule 4')).toEqual(['clause', 'contractor', 'obligations', 'owner', 'rights', 'set', 'schedule']);
    expect(wordsIn('take-or-pay; non-recourse; DSCR; P50; kWh; 132kV; co-operation')).toEqual(['take-or-pay', 'non-recourse', 'dscr', 'kwh', 'co-operation']);
    expect(wordsIn('')).toEqual([]); expect(wordsIn('12 345 6.7 % — §')).toEqual([]);
  });
  it('keeps the most used, most used first, and words used equally often in the order of the alphabet', () => {
    expect(topWords('permit permit permit emissions emissions air zoning air stack', 3)).toEqual(['permit', 'air', 'emissions']);
    expect(topWords('zeta alpha mid')).toEqual(['alpha', 'mid', 'zeta']);
    const many = Array.from({ length: 50 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x `.repeat(50 - i)).join(' ');
    expect(topWords(many).length).toBe(30); expect(topWords(many)[0]).toBe('wordaax'); expect(topWords(many, 5).length).toBe(5);
    expect(topWords('the and of to')).toEqual([]);
  });
});
