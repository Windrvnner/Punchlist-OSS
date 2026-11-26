// One lookup finds each row's question for the import, its preview and Update Q&A Log (#1080): sender plus the text
// as the file holds it, the row's number first; a row that matches nothing is unmatched.
import { describe, it, expect } from 'vitest';
import { matchQuestions } from '../../src/domain/qaMatch';
import { sameText } from '../../src/domain/importExport';
import type { Question } from '../../src/domain/model';

const q = (id: string, n: number, text: string, askedBy = '') => ({ id, n, text, askedBy }) as Question;
const row = (n: number | null, text: string, askedBy = '') => ({ n, text, askedBy });

describe('the text as the file holds it', () => {
  it('matches a line break stored as "\\n" either way round', () => {
    const asked = [[q('a', 1, 'Provide the model.\r\nAnd the lock-up?')]];
    expect(matchQuestions([row(null, 'Provide the model.\nAnd the lock-up?')], asked)).toEqual(new Map([[0, 'a']]));
    expect(matchQuestions([row(null, 'A\r\nB')], [[q('a', 1, 'A\nB')]])).toEqual(new Map([[0, 'a']]));
  });
  it('matches a control character stored as a space or left out', () => {
    const asked = [[q('a', 1, 'Provide Q3\u0000forecast')]];
    expect(matchQuestions([row(null, 'Provide Q3 forecast')], asked)).toEqual(new Map([[0, 'a']]));
    expect(matchQuestions([row(null, 'Provide Q3forecast')], asked)).toEqual(new Map([[0, 'a']]));
  });
  it('never matches other spacing, case or a changed letter', () => {
    const asked = [[q('a', 1, 'Is the O&M contract signed?')]];
    for (const text of ['Is the O&M  contract signed?', 'is the O&M contract signed?', 'ls the O&M contract signed?']) {
      expect(matchQuestions([row(1, text)], asked)).toEqual(new Map());
    }
  });
  it('is the one text comparison the import uses for a change', () => {
    expect(sameText('A\r\nB', 'A\nB')).toBe(true);
    expect(sameText('A\u0001B', 'A B')).toBe(true);
    expect(sameText('A\u0001B', 'AB')).toBe(true);
    expect(sameText('A  B', 'A B')).toBe(false);
  });
  it('matches only what that comparison calls the same, form by form', () => {
    expect(sameText('a\u0001b', 'a\u0002 b')).toBe(false);
    expect(matchQuestions([row(null, 'a\u0001b')], [[q('a', 1, 'a\u0002 b')]])).toEqual(new Map());
  });
});

describe('number and sender', () => {
  it('takes the question with the row\'s number before any other with the text', () => {
    const asked = [[q('a', 3, 'Same words'), q('b', 7, 'Same words')]];
    expect(matchQuestions([row(7, 'Same words'), row(3, 'Same words')], asked)).toEqual(new Map([[0, 'b'], [1, 'a']]));
  });
  it('takes its sender\'s row before a row naming no one, even one under the question\'s number', () => {
    const asked = [[q('q5', 5, 'X', 'Lender A')]];
    expect(matchQuestions([row(9, 'X', 'Lender A'), row(5, 'X')], asked)).toEqual(new Map([[0, 'q5']]));
  });
  it('takes the same sender before a side naming no one, and never another party', () => {
    const asked = [[q('a', 1, 'Provide the model.', 'Lender A'), q('b', 2, 'Provide the model.', 'Lender B')]];
    const rows = [row(10, 'Provide the model.'), row(11, 'Provide the model.', 'Lender A')];
    expect(matchQuestions(rows, asked)).toEqual(new Map([[1, 'a'], [0, 'b']]));
    expect(matchQuestions([row(1, 'Provide the model.', 'Lender C')], asked)).toEqual(new Map());
  });
  it('tries each sender tier in order: a later tier only for what the earlier left', () => {
    const asked = [[q('a', 1, 'Provide the model.', 'Lender A'), q('b', 2, 'Provide the model.', 'Lendr A')]];
    const lastWritten = new Map([['a', 'Lendr A'], ['b', 'Lendr A']]);
    const tiers = [(x: Question) => x.askedBy, (x: Question) => lastWritten.get(x.id) ?? ''];
    const rows = [row(10, 'Provide the model.', 'Lendr A'), row(11, 'Provide the model.', 'Lendr A')];
    expect(matchQuestions(rows, asked, tiers)).toEqual(new Map([[0, 'b'], [1, 'a']]));
    expect(matchQuestions(rows, asked)).toEqual(new Map([[0, 'b']]));
  });
  it('takes a live question before a deleted one', () => {
    const pools = [[q('live', 1, 'X')], [q('gone', 2, 'X')]];
    expect(matchQuestions([row(null, 'X')], pools)).toEqual(new Map([[0, 'live']]));
  });
});

describe('at deal scale', () => {
  it('matches 3,000 rows to 3,000 questions in the same words in a moment', () => {
    const rows = Array.from({ length: 3000 },
      (_, k) => row(k + 5001, 'Provide the model.', k % 2 ? 'Lender A, LLC' : ''));
    const asked = [Array.from({ length: 3000 }, (_, k) => q(`q${k}`, k + 1, 'Provide the model.', 'Lender A'))];
    const at = Date.now(); const m = matchQuestions(rows, asked); const ms = Date.now() - at;
    expect(ms).toBeLessThan(2_000);
    expect(m.size).toBe(1500);   // the 1,500 rows naming no one; "Lender A, LLC" is another name
  });
});
