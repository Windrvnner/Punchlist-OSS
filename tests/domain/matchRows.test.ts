// Which row of the deal's log stands for each question: the row with the same sender and exact text; of two such rows,
// the one with the question's number, whatever order the questions come in.
import { describe, it, expect } from 'vitest';
import { matchRows } from '../../src/domain/logWrite';
import type { Question } from '../../src/domain/model';
import type { Mapping } from '../../src/domain/importExport';

const mapping = { n: 0, text: 1, askedBy: null, received: null, workstream: null, priority: null, response: null, respondedBy: null, responded: null, status: null } as Mapping;
const q = (id: string, n: number, text: string, askedBy = '') => ({ id, n, text, askedBy }) as Question;

describe('matchRows', () => {
  it('gives a question the row of the same words with its own number, even when another question of those words comes first', () => {
    const rows = [['7', 'Same words'], ['3', 'Same words']];
    expect(matchRows({ rows }, mapping, [q('a', 3, 'Same words'), q('b', 7, 'Same words')])).toEqual(new Map([['a', 1], ['b', 0]]));
  });
  it('a question with no row of its own number takes what is left of its words', () => {
    const rows = [['7', 'Same words'], ['3', 'Same words']];
    expect(matchRows({ rows }, mapping, [q('a', 1, 'Same words'), q('b', 7, 'Same words')])).toEqual(new Map([['b', 0], ['a', 1]]));
  });
  it('never by number alone, nor by similar words: another wording is no row of the question', () => {
    const rows = [['4', 'What is the DSCR in the base case?'], ['5', 'who is the EPC contractor?']];
    expect(matchRows({ rows }, mapping, [q('a', 4, 'What is the DSCR for the base case?'), q('b', 5, 'Who is the EPC contractor?')])).toEqual(new Map());
  });
  it('of two rows that read the same, a question takes its own party\'s, so a log sorted by party never gets one party\'s response in another\'s row', () => {
    const rows = [['1', 'Provide the model.', 'Lender B'], ['2', 'Provide the model.', ' Lender A ']];
    const withParty = { ...mapping, askedBy: 2 } as Mapping;
    expect(matchRows({ rows }, withParty, [q('a', 4, 'Provide the model.', 'Lender A'), q('b', 9, 'Provide the model.', 'Lender B')])).toEqual(new Map([['a', 1], ['b', 0]]));
  });
  it('takes a row of the question\'s own party before a row naming no one, and never another party\'s row', () => {
    const rows = [['10', 'Provide the model.', ''], ['11', 'Provide the model.', 'Lender A']];
    const withParty = { ...mapping, askedBy: 2 } as Mapping;
    expect(matchRows({ rows }, withParty, [q('a', 1, 'Provide the model.', 'Lender A'), q('b', 2, 'Provide the model.', 'Lender B')])).toEqual(new Map([['a', 1], ['b', 0]]));
    expect(matchRows({ rows: [rows[1]] }, withParty, [q('b', 2, 'Provide the model.', 'Lender B')])).toEqual(new Map());
  });
  it('matches 3,000 rows to 3,000 questions in the same words, under parties the log spells its own way, in a moment', () => {
    const withParty = { ...mapping, askedBy: 2 } as Mapping;
    const rows = Array.from({ length: 3000 }, (_, k) => [String(k + 5001), 'Provide the model.', k % 2 ? 'Lender A, LLC' : '']);
    const qs = Array.from({ length: 3000 }, (_, k) => q(`q${k}`, k + 1, 'Provide the model.', 'Lender A'));
    const at = Date.now(); const m = matchRows({ rows }, withParty, qs); const ms = Date.now() - at;
    expect(ms).toBeLessThan(2_000); expect(m.size).toBe(1500);   // the 1,500 rows naming no one; "Lender A, LLC" is another name
  });
});

describe('a party corrected in the app', () => {
  it('keeps the question\'s row, which still names what the app last wrote there, so the log gets no second row', () => {
    const withParty = { ...mapping, askedBy: 2 } as Mapping;
    const rows = [['1', 'Provide the model.', 'Lendr A']];
    const fixed = q('a', 1, 'Provide the model.', 'Lender A');
    expect(matchRows({ rows }, withParty, [fixed], new Map([['a', { askedBy: 'Lendr A' }]]))).toEqual(new Map([['a', 0]]));
    // and a row naming another party that the app never wrote for it is still not its row
    expect(matchRows({ rows: [['1', 'Provide the model.', 'Lender B']] }, withParty, [fixed], new Map([['a', { askedBy: 'Lendr A' }]]))).toEqual(new Map());
  });
});

describe('a party corrected in the app, beside a question still under the old name', () => {
  it('leaves the other question its own row, so no two responses are swapped', () => {
    const withParty = { ...mapping, askedBy: 2 } as Mapping;
    const rows = [['10', 'Provide the model.', 'Lendr A'], ['11', 'Provide the model.', 'Lendr A']];
    const sent = new Map([['a', { askedBy: 'Lendr A' }], ['b', { askedBy: 'Lendr A' }]]);
    expect(matchRows({ rows }, withParty, [q('a', 1, 'Provide the model.', 'Lender A'), q('b', 2, 'Provide the model.', 'Lendr A')], sent)).toEqual(new Map([['b', 0], ['a', 1]]));
  });
});
