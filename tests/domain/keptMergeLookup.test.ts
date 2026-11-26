// Lining up an edit kept aside with the log by the one Q&A row lookup (docs/decisions.md): the same number, text and
// sender, else the same text and sender. At deal scale: 2,000 questions.
import { describe, it, expect } from 'vitest';
import { mergeKept } from '../../src/domain/keptMerge';
import { N, table, after } from './keptMergeTables';

describe('rows are lined up with the one Q&A row lookup (#1111)', () => {
  const H = ['No.', 'Question', 'Submitted by', 'Response'];
  const PARTIES = ['Lender A', 'Lender B', 'Buyer counsel'];
  const topics = ['audited financial statements', 'material contracts', 'cap table', 'pending litigation'];
  /** a realistic log: numbered questions from three parties, each worded as a deal team writes them */
  const deal = () => [H, ...Array.from({ length: N }, (_, k) => [String(k + 1),
    `Please provide the ${topics[k % 4]} for entity ${k + 1}, including any amendments since signing.`,
    PARTIES[k % 3], ''])];
  const merge = (base: string[][], kept: string[][], log: string[][]) =>
    mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, 'No.', undefined, 'Submitted by');
  const cellsIn = (m: ReturnType<typeof merge>, upTo: number) =>
    m.steps.filter((s) => s.kind === 'cell' && s.row <= upTo);
  const lines = (m: ReturnType<typeof merge>) => m.ask.map((a) => a.rows.map((r) => r.line));

  it('a row whose question the log spaces otherwise is not merged into it: text is compared as the file has it', () => {
    const base = deal();
    const kept = deal();
    const log = deal();
    kept[5][3] = 'sroe on 5';
    log[5][1] = log[5][1].replace('provide the', 'provide  the');
    const m = merge(base, kept, log);
    expect(cellsIn(m, N)).toEqual([]);
    expect(m).toMatchObject({ cells: 0, left: 1, clashes: [] });
  });
  it('a row with the same number, text and sender takes their changed cells', () => {
    const base = deal();
    const kept = deal();
    const log = deal();
    kept[5][3] = 'sroe on 5';
    log.splice(2, 0, ['', 'A question ldoe put in above', 'Lender A', '']);
    const m = merge(base, kept, log);
    expect(m.steps).toEqual([{ kind: 'cell', row: 6, col: 3, value: 'sroe on 5' }]);
    expect(m).toMatchObject({ cells: 1, left: 0 });
  });
  it('of two rows with the same text, the one with their row\'s sender is theirs', () => {
    const base = deal();
    base[8] = ['', base[7][1], 'Lender B', ''];
    base[7][2] = 'Lender A';
    const kept = base.map((r) => [...r]);
    kept[8][3] = 'sroe for Lender B';
    const log = base.map((r) => [...r]);
    [log[7], log[8]] = [log[8], log[7]];                                               // the log sorted them by party
    const m = merge(base, kept, log);
    expect(m.steps).toEqual([{ kind: 'cell', row: 7, col: 3, value: 'sroe for Lender B' }]);
    expect(m.ask).toEqual([]);
  });
  it('of two rows with the same number, text and sender, the person says which is theirs', () => {
    const base = deal();
    base[9] = [...base[8]];
    const kept = base.map((r) => [...r]);
    kept[9][3] = 'sroe on the copy';
    const m = merge(base, kept, base.map((r) => [...r]));
    expect(m).toMatchObject({ steps: [], left: 0 });
    expect(lines(m)).toEqual([[9, 10]]);
  });
  it('a row they reworded is never lined up by its place: nothing in the log is written unasked', () => {
    const base = deal();
    const kept = deal();
    const log = deal();
    kept[600][1] = 'Please provide the reworded request, sroe.';
    kept[600][3] = 'sroe on 600';
    log.splice(3, 0, ['3a', 'A question ldoe put in', 'Lender A', '']);
    log.splice(1000, 1);
    const m = merge(base, kept, log);
    expect(cellsIn(m, N)).toEqual([]);
    expect(m.cells).toBe(0);
    expect(m.ask.map((a) => a.question)).toEqual(['Please provide the reworded request, sroe.']);
    expect(lines(m)).toEqual([[602]]);                                                 // the person places it
  });
  it('at deal scale, every row with the same number, text and sender merges and the counts add up', () => {
    const base = deal();
    const kept = deal();
    const log = deal();
    for (let i = 20; i <= N; i += 20) kept[i][3] = `sroe on ${i}`;                    // 100 edits
    for (let i = 7; i <= N; i += 50) log[i][3] = `ldoe on ${i}`;
    log.splice(1, 0, ['', 'A question ldoe put in at the top', 'Lender B', '']);
    const t0 = performance.now();
    const m = merge(base, kept, log);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(m).toMatchObject({ cells: 100, added: 0, left: 0, clashes: [], ask: [] });
    const a = after(log, m.steps);
    for (let i = 20; i <= N; i += 20) expect(a[i + 1]).toEqual([String(i), base[i][1], base[i][2], `sroe on ${i}`]);
  });
});
