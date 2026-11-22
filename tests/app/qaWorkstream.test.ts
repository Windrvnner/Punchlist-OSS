import { describe, it, expect } from 'vitest';
import { initialState, qaListed, qaWorkstreamChoices, workstreamForNew, NO_WORKSTREAM } from '../../src/app/state';
import { questionRowsFor } from '../../src/app/transfer';
import type { Question } from '../../src/domain/model';

// The Q&A workstream filter's "No workstream" choice: the list, its export and a new question
// agree.
const D = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';
const q = (n: number, workstream: string): Question => ({
  id: `q_${n}`, dealId: D, n, text: `Question ${n}`, askedBy: 'Lender A', workstream, status: 'open', response: '',
} as unknown as Question);
const rows = [q(1, 'Legal'), q(2, ''), q(3, '   '), q(4, 'Tax')];
const F = (workstream: string) => ({ status: 'all' as const, workstream, text: '' });

describe('the Q&A "No workstream" filter', () => {
  it('lists the questions with no workstream, blank or only spaces, and no others', () => {
    const s = initialState();
    expect(rows.filter((r) => qaListed(s, r, F(NO_WORKSTREAM))).map((r) => r.n)).toEqual([2, 3]);
    expect(rows.filter((r) => qaListed(s, r, F('Legal'))).map((r) => r.n)).toEqual([1]);
  });
  it('exports the same questions the list shows', () => {
    const questions = Object.fromEntries(rows.map((r) => [r.id, r]));
    const s = { ...initialState(), deals: { [D]: { id: D } }, questions };
    const out = questionRowsFor(s as never, D, { status: 'all', workstream: NO_WORKSTREAM, askedBy: ['Lender A'] });
    expect(out.map((r) => r.n).sort()).toEqual([2, 3]);
  });
  it('offers "No workstream" once, last, and a question added under it has none', () => {
    const names = qaWorkstreamChoices([...rows, q(5, NO_WORKSTREAM)]);
    expect(names.filter((w) => w === NO_WORKSTREAM)).toHaveLength(1);
    expect(names.at(-1)).toBe(NO_WORKSTREAM);
    expect(workstreamForNew(NO_WORKSTREAM)).toBe('');
    expect(workstreamForNew('Legal')).toBe('Legal');
  });
});
