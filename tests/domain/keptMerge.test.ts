// Bringing an edit kept aside back into the Q&A log: a three-way merge, cell by cell, of their version against the
// version they edited, into the log as it is now. At deal scale: 2,000 questions.
import { describe, it, expect } from 'vitest';
import { mergeKept } from '../../src/domain/keptMerge';
import { N, table, after } from './keptMergeTables';

const HEAD = ['No.', 'Question', 'Response', 'Notes'];
const q = (i: number) => `Question ${i}: please confirm item ${i}.`;
const grid = () => [HEAD, ...Array.from({ length: N }, (_, k) => [String(k + 1), q(k + 1), '', ''])];
const set = (g: string[][], row: number, col: number, v: string) => { g[row][col] = v; return g; };

describe('an edit kept aside, merged into the log', () => {
  it('takes their cells the log has as they were, keeps the log\'s where both changed, and reports those rows', () => {
    const base = grid(); const kept = grid(); const log = grid();
    set(kept, 7, 2, 'sroe on 7'); set(kept, 9, 2, 'sroe on 9'); set(kept, 1999, 3, 'sroe: chase');
    set(log, 9, 2, 'ldoe on 9'); set(log, 11, 2, 'ldoe on 11');
    const m = mergeKept(table(base), table(kept), table(log), 'Question');
    expect(m).toMatchObject({ cells: 2, added: 0, clashes: [8] });                     // row 9 of the sheet is the 9th row of the table
    const g = after(log, m.steps);
    expect([g[7][2], g[9][2], g[11][2], g[1999][3]]).toEqual(['sroe on 7', 'ldoe on 9', 'ldoe on 11', 'sroe: chase']);
  });

  it('lines rows up by the lookup when the log has rows put in or taken out above', () => {
    const base = grid(); const kept = grid(); const log = grid();
    set(kept, 500, 2, 'sroe on 500');
    // ldoe put a row in near the top, and took one out
    log.splice(3, 0, ['3a', 'A question ldoe put in', '', '']);
    log.splice(1000, 1);
    const m = mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, 'No.');
    const g = after(log, m.steps);
    expect(g[501]).toEqual(['500', q(500), 'sroe on 500', '']);
    expect(m.clashes).toEqual([]); expect(g).toHaveLength(N + 1);                       // nothing taken out or added
  });

  it('never takes a row put in just above a reworded one for it: the answer stays with its question', () => {
    const H = ['No.', 'Question', 'Category', 'Response']; const g = () => [H, ...Array.from({ length: N }, (_, k) => [String(k + 1), q(k + 1), k % 2 ? 'Legal' : 'Finance', ''])];
    const base = g(); const kept = g(); const log = g();
    kept[500] = ['500', 'Question 500 reworded by sroe', 'Legal', '']; kept.splice(500, 0, ['', 'A brand new question sroe put in', 'Legal', '']);
    log[500][3] = 'ldoe answer to 500';
    const m = mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, 'No.');
    const a = after(log, m.steps);
    // question 500 keeps its number, words and ldoe's answer
    expect(a[500]).toEqual(['500', q(500), 'Legal', 'ldoe answer to 500']);
    expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= N)).toEqual([]); expect(m.left).toBe(0);
    expect(m.ask.map((x) => [x.question, x.rows.map((r) => r.line)])).toEqual([['A brand new question sroe put in', [501]], ['Question 500 reworded by sroe', [501]]]);   // which is question 500 is asked, never guessed
  });

  /** seven rows of a 2,000-row log, each reworded in their kept copy with a response put in */
  const reworded = [100, 400, 700, 1000, 1300, 1600, 1900];
  /** the kept copy with those rows reworded, and `more` rows after them */
  const rewordedKept = (...more: string[][]) => {
    const kept = grid();
    for (const i of reworded) kept[i] = [String(i), `${q(i)} (typo fixed)`, `sroe on ${i}`, ''];
    kept.push(...more);
    return kept;
  };
  /** the kept copy merged into an unchanged log */
  const mergeReworded = (kept: string[][]) =>
    mergeKept(table(grid()), table(kept), table(grid()), 'Question', undefined, undefined, 'No.');

  it('asks about every row they reworded, however many, and appends none of them as new questions', () => {
    const m = mergeReworded(rewordedKept());
    expect(m.added).toBe(0);
    expect(m.steps.filter((s) => s.kind === 'rows')).toEqual([]);
    expect(m.ask.map((x) => x.question)).toEqual(reworded.map((i) => `${q(i)} (typo fixed)`));
    // each is asked among the rows not lined up, its own among them
    for (const [k, x] of m.ask.entries()) expect(x.rows.map((r) => r.line)).toContain(reworded[k] + 1);
  });

  it('asks about every reworded row and a new question beside them, and appends nothing', () => {
    const m = mergeReworded(rewordedKept(['', 'A brand new question sroe put in', 'sroe on the new one', '']));
    expect(m.added).toBe(0);
    expect(m.steps.filter((s) => s.kind === 'rows')).toEqual([]);
    const asked = [...reworded.map((i) => `${q(i)} (typo fixed)`), 'A brand new question sroe put in'];
    expect(m.ask.map((x) => x.question)).toEqual(asked);
    const unplaced = reworded.map((i) => i + 1);
    // each reworded row is asked among the rows not lined up, its own among them; the new one among the same rows
    for (const [k, x] of m.ask.entries()) {
      expect(x.rows.map((r) => r.line).sort((a, b) => a - b)).toEqual(unplaced);
      if (k < reworded.length) expect(x.rows.map((r) => r.line)).toContain(reworded[k] + 1);
    }
  });

  describe('a reworded row is never lined up with another by place: the answer stays with its question', () => {
    const H = ['No.', 'Question', 'Submitted by', 'Category', 'Status', 'Response'];
    const g = () => [H, ...Array.from({ length: N }, (_, k) => [String(k + 1), q(k + 1), 'Lender A', k % 3 ? 'Legal' : 'Finance', 'Open', ''])];
    const merge = (base: string[][], kept: string[][], log: string[][]) => { const m = mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, 'No.'); return { m, a: after(log, m.steps) }; };
    /** the log's rows that were there, after the merge: none has lost its number, its words or its answer */
    const kept500 = (a: string[][], row: number, answer: string) => expect(a[row]).toEqual(['500', q(500), 'Lender A', a[row][3], 'Open', answer]);
    it('A: they took out a row, reworded the next and put a new one in below it', () => {
      const base = g(); const kept = g(); const log = g();
      kept[500] = ['500', 'Question 500 reworded by sroe', 'Lender A', kept[500][3], 'Open', 'sroe on 500']; kept.splice(501, 0, ['', 'A brand new question sroe put in', 'Lender A', kept[500][3], 'Open', '']); kept.splice(499, 1);
      log[500][5] = 'ldoe answer to 500';
      const { m, a } = merge(base, kept, log); kept500(a, 500, 'ldoe answer to 500');
      expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= N)).toEqual([]); expect(m.ask.map((x) => x.rows.map((r) => r.line))).toEqual([[500, 501], [500, 501]]);   // both of sroe's rows asked about
    });
    it('B: the log took out a row, reworded the next and put a new one in below it', () => {
      const base = g(); const kept = g(); const log = g();
      log[500] = ['500', 'Question 500 reworded by ldoe', 'Lender A', log[500][3], 'Open', ''];
      log.splice(501, 0, ['', 'A brand new question ldoe put in', 'Lender A', log[500][3], 'Open', '']);
      log.splice(499, 1);
      kept[500][5] = 'sroe answer to 500';
      const { m } = merge(base, kept, log);
      expect(m.steps.filter((s) => s.kind === 'cell' && s.value === 'sroe answer to 500')).toEqual([]); expect(m.left).toBe(1);   // not written into ldoe's new row: counted
    });
    it('C: they typed a new question over a row, its number cleared', () => {
      const base = g(); const kept = g(); const log = g();
      kept[500] = ['', 'A brand new question sroe typed over 500', 'Lender A', kept[500][3], 'Open', '']; log[500][5] = 'ldoe answer to 500';
      const { m, a } = merge(base, kept, log); kept500(a, 500, 'ldoe answer to 500');
      expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= N)).toEqual([]); expect(m.ask.map((x) => [x.question, x.add.length > 0])).toEqual([['A brand new question sroe typed over 500', true]]);
    });
    it('D: they swapped two rows and reworded both', () => {
      const base = g(); const kept = g(); const log = g();
      const r500 = ['500', 'Question 500, sroe\'s words', 'Lender A', kept[500][3], 'Open', '']; const r501 = ['501', 'Question 501, sroe\'s words', 'Lender A', kept[501][3], 'Open', ''];
      kept[500] = r501; kept[501] = r500; log[500][5] = 'ldoe on 500'; log[501][5] = 'ldoe on 501';
      const { m, a } = merge(base, kept, log);
      kept500(a, 500, 'ldoe on 500');
      expect(a[501].slice(0, 2).concat(a[501][5])).toEqual(['501', q(501), 'ldoe on 501']);
      expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= N)).toEqual([]);
    });
  });

  describe('an answer never goes to another row the log has', () => {
    const H = ['No.', 'Question', 'Submitted by', 'Status', 'Response'];
    const g = () => [H, ...Array.from({ length: N }, (_, k) => [String(k + 1), q(k + 1), 'Lender A', 'Open', ''])];
    for (const number of ['No.', '']) it(`a duplicate question the log took out is not taken for another party's${number ? '' : ', with no number column'}`, () => {
      const base = g(); base[701] = ['701', 'Provide the audited accounts.', 'Lender A', 'Open', '']; base[1500] = ['1500', 'Provide the audited accounts.', 'Buyer counsel', 'Open', ''];
      const kept = base.map((r) => [...r]); kept[701][4] = 'sroe: for Lender A only';
      // ldoe took 701 out as a duplicate
      const log = base.map((r) => [...r]);
      log.splice(701, 1);
      const m = mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, number);
      expect(m).toMatchObject({ steps: [], clashes: [], left: 0 }); expect(m.ask.map((x) => x.rows.map((r) => r.line))).toEqual([[1500]]);   // the other row, a row of its own, or left out: the person says
    });
    it('a question the log replaced in the same place under the same number does not get the old one\'s answer', () => {
      const base = g(); const kept = g(); const log = g(); kept[900][4] = 'sroe on 900';
      log[900] = ['900', 'An unrelated question ldoe put in its place', 'Lender A', 'Open', ''];
      const m = mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, 'No.');
      expect(m.steps).toEqual([]); expect(m.clashes).toEqual([]); expect(m.left).toBe(1);
    });
  });

  describe('an answer never goes to another row the log has', () => {
    const H = ['No.', 'Question', 'Submitted by', 'Category', 'Status', 'Response'];
    const g = () => [H, ...Array.from({ length: N }, (_, k) => [String(k + 1), q(k + 1), 'Lender A', k % 3 ? 'Legal' : 'Finance', 'Open', ''])];
    for (const number of ['No.', '']) it(`a question asked once, taken out of the log, is not taken for another party's asked since${number ? '' : ', with no number column'}`, () => {
      const base = g(); base[701] = ['701', 'Provide the audited accounts.', 'Lender A', 'Finance', 'Open', ''];
      const kept = base.map((r) => [...r]); kept[701][5] = 'sroe: for Lender A only';
      const log = base.map((r) => [...r]); log.push(['2001', 'Provide the audited accounts.', 'Buyer counsel', 'Legal', 'Open', '']); log.splice(701, 1);
      const m = mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, number, undefined,
        'Submitted by');
      expect(m.steps).toEqual([]); expect(m.clashes).toEqual([]); expect(m.left).toBe(1);
    });
    it('a question asked once still lines up when the log closed it (one cell changed)', () => {
      const base = g(); const kept = g(); const log = g(); kept[701][5] = 'sroe on 701'; log[701][4] = 'Closed';
      expect(mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, 'No.')).toMatchObject({ steps: [{ kind: 'cell', row: 701, col: 5, value: 'sroe on 701' }], left: 0 });
    });
    it('a row they added with no number is never merged into a row of the version they edited', () => {
      const base = g(); base[1500] = ['1500', 'Provide the audited accounts.', 'Buyer counsel', 'Legal', 'Open', ''];
      const kept = [...base.map((r) => [...r]), ['', 'Provide the audited accounts.', '', '', '', 'sroe: new request answered']];
      const m = mergeKept(table(base), table(kept), table(base.map((r) => [...r])), 'Question', undefined, undefined, 'No.');
      expect(m).toMatchObject({ added: 1, clashes: [], left: 0 }); expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= N)).toEqual([]);
    });
  });

  describe('another party\'s row is never taken for theirs, whatever the cells all parties share say', () => {
    // the app's own columns but the number: what tells two parties apart is Submitted by
    const H = ['Workstream', 'Priority', 'Submitted by', 'Question', 'Received', 'Status', 'Response'];
    const g = () => [H, ...Array.from({ length: N }, (_, k) => ['Finance', 'High', 'Lender A', q(k + 1), '2026-11-01', 'Open', ''])];
    const merge = (base: string[][], kept: string[][], log: string[][]) => mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, '', undefined, 'Submitted by');
    it('1: a question asked once, taken out, with another party\'s asked since', () => {
      const base = g(); const kept = g(); kept[300][6] = 'sroe: for Lender A only';
      const log = g(); log.push([...log[300]]); log[N + 1][2] = 'Lender B'; log.splice(300, 1);
      expect(merge(base, kept, log)).toMatchObject({ steps: [], clashes: [], left: 1 });
    });
    it('2: the app reworded a question, and another party asks the old words', () => {
      const base = g(); const kept = g(); kept[300][6] = 'sroe: for Lender A only';
      const log = g(); log[300][3] = 'Question 300, as the app now words it'; log.push(['Finance', 'High', 'Lender B', q(300), '2026-11-01', 'Open', '']);
      expect(merge(base, kept, log)).toMatchObject({ steps: [], clashes: [], left: 1 });
    });
    it('3: two parties ask it, and one\'s row was taken out', () => {
      const base = g(); base[N][3] = q(300); base[N][2] = 'Lender B'; const kept = base.map((r) => [...r]); kept[300][6] = 'sroe: for Lender A only';
      const log = base.map((r) => [...r]); log.splice(300, 1);
      const m = merge(base, kept, log); expect(m).toMatchObject({ steps: [], clashes: [], left: 0 }); expect(m.ask.map((x) => x.rows)).toEqual([[]]);   // never Lender B's: a row of its own, or left out
    });
    it('a row they added for another party is never merged into a row the log added', () => {
      const base = g(); const kept = [...g(), ['Finance', 'High', 'Lender A', 'Any liens?', '', 'Open', 'sroe: none']];
      const log = [...g(), ['Finance', 'High', 'Lender B', 'Any liens?', '', 'Open', '']];
      const m = merge(base, kept, log); expect(m).toMatchObject({ added: 1, clashes: [] }); expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= N + 1)).toEqual([]);
    });
    it('the same party\'s row still lines up when the log closed it', () => {
      const base = g(); const kept = g(); kept[300][6] = 'sroe on 300'; const log = g(); log[300][5] = 'Closed';
      expect(merge(base, kept, log)).toMatchObject({ steps: [{ kind: 'cell', row: 300, col: 6, value: 'sroe on 300' }], left: 0 });
    });
  });

  describe('a row naming no sender matches any sender, the same sender first (docs/decisions.md)', () => {
    // as above, with a number column too
    const H = ['No.', 'Workstream', 'Priority', 'Submitted by', 'Question', 'Status', 'Response'];
    const g = () => [H, ...Array.from({ length: N }, (_, k) => [String(k + 1), 'Finance', 'High', 'Lender A', q(k + 1), 'Open', ''])];
    for (const number of ['No.', '']) {
      const merge = (base: string[][], kept: string[][], log: string[][]) => mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, number, undefined, 'Submitted by');
      const blank = (r: string[]) => { r[0] = ''; r[3] = ''; return r; };   // no number, no submitter
      const tail = number ? '' : ', with no number column';
      it(`two rows ask it, one with no submitter, and the log took out the one they answered${tail}`, () => {
        const base = g(); base[1500] = blank([...base[700]]); const kept = base.map((r) => [...r]); kept[700][6] = 'sroe: for Lender A only';
        const log = base.map((r) => [...r]); log.splice(700, 1);
        const m = merge(base, kept, log); expect(m).toMatchObject({ steps: [], clashes: [], left: 0 }); expect(m.ask.map((x) => x.rows)).toEqual([[]]);
      });
      /** the merge's steps: each cell's row, column and value */
      const answers = (m: ReturnType<typeof merge>) =>
        m.steps.map((s) => (s.kind === 'cell' ? [s.row, s.col, s.value] : s.kind));
      it(`A3b: the app reworded a question, and a row with no submitter asks the old words: it is that row${tail}`,
        () => {
          const base = g();
          const kept = g();
          kept[300][6] = 'sroe: for Lender A only';
          const log = g();
          log[300][4] = 'Question 300, as the app now words it';
          log.push(blank([...base[300]]));
          const m = merge(base, kept, log);
          expect(answers(m)).toEqual([[N + 1, 6, 'sroe: for Lender A only']]);
          expect(m).toMatchObject({ clashes: [], left: 0 });
        });
      it(`a question asked once, taken out, and asked since with no submitter: that row is it${tail}`, () => {
        const base = g(); const kept = g(); kept[300][6] = 'sroe: for Lender A only';
        const log = g(); log.push(blank([...log[300]])); log.splice(300, 1);
        const m = merge(base, kept, log);
        expect(answers(m)).toEqual([[N, 6, 'sroe: for Lender A only']]);
        expect(m).toMatchObject({ clashes: [], left: 0 });
      });
      it(`the row they answered had no submitter, and a Lender B row asks it since: that row is it${tail}`, () => {
        const base = g(); blank(base[300]); const kept = base.map((r) => [...r]); kept[300][6] = 'sroe: for nobody named';
        const log = base.map((r) => [...r]); log.push(['', 'Finance', 'High', 'Lender B', q(300), 'Open', '']); log.splice(300, 1);
        const m = merge(base, kept, log);
        expect(answers(m)).toEqual([[N, 6, 'sroe: for nobody named']]);
        expect(m).toMatchObject({ clashes: [], left: 0 });
      });
      it(`K: a row they added with no submitter is the Lender B row the log added with its text${tail}`, () => {
        const base = g(); const kept = [...g(), ['', 'Finance', 'High', '', 'Any liens?', 'Open', 'sroe: none']];
        const log = [...g(), ['', 'Finance', 'High', 'Lender B', 'Any liens?', 'Open', '']];
        const m = merge(base, kept, log);
        expect(answers(m)).toEqual([[N + 1, 6, 'sroe: none']]);
        expect(m).toMatchObject({ added: 0, clashes: [] });
      });
      it(`the same row, both with no submitter, still lines up${tail}`, () => {
        const base = g(); blank(base[300]); const kept = base.map((r) => [...r]); kept[300][6] = 'sroe on 300'; const log = base.map((r) => [...r]); log[300][5] = 'Closed';
        expect(merge(base, kept, log)).toMatchObject({ steps: [{ kind: 'cell', row: 300, col: 6, value: 'sroe on 300' }], left: 0 });
      });
    }
  });
  describe('rows that read alike with nothing to tell them apart: the person says where an edit goes', () => {
    const H = ['Question', 'Submitted by', 'Workstream', 'Status', 'Response'];
    const g = () => [H, ...Array.from({ length: N }, (_, k) => [q(k + 1), k % 2 ? 'Lender A' : 'Lender B', 'Legal', 'Open', ''])];
    const CAP = 'Provide the cap table.';
    const twice = (x: string[][]) => { x[100] = [CAP, '', 'Legal', 'Open', '']; x[900] = [CAP, '', 'Legal', 'Open', 'Draft from the data room']; return x; };
    const merge = (base: string[][], kept: string[][], log: string[][], number = '') => mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, number, undefined, 'Submitted by');
    /** what the log holds in rows 100 and 900 with the ask's choice `k` made (its row, or added: -1) */
    const pick = (log: string[][], m: ReturnType<typeof merge>, k: number, col: number) => { const a = after(log, [...m.steps, ...(k >= 0 ? m.ask[0].rows[k].steps : [])]); return [a[100][col], a[900][col]]; };
    it('A: their change to one of two is asked about, never written unasked, and goes where the person says', () => {
      const base = twice(g()), kept = twice(g()), log = twice(g()); kept[900][4] = 'Final answer, sroe';
      const m = merge(base, kept, log);
      expect(m).toMatchObject({ steps: [], clashes: [], left: 0 }); expect(m.ask).toHaveLength(1);
      expect(m.ask[0]).toMatchObject({ question: CAP, rows: [{ row: 99, line: 101 }, { row: 899, line: 901 }], cells: [{ heading: 'Response', theirs: 'Final answer, sroe', rows: ['', 'Draft from the data room'], changed: true }] });
      expect(pick(log, m, 1, 4)).toEqual(['', 'Final answer, sroe']); expect(pick(log, m, 0, 4)).toEqual(['', 'Draft from the data room']);   // row 100 had no answer: it is a clash there, the log's stays
      expect(m.ask[0].rows.map((r) => r.clash)).toEqual([true, false]);
    });
    it('the same with a number column, the two rows unnumbered', () => {
      const g2 = () => twice(g()).map((r, i) => [i === 0 ? 'No.' : i === 100 || i === 900 ? '' : String(i), ...r]);
      const base = g2(), kept = g2(), log = g2(); kept[900][5] = 'Final answer, sroe';
      const m = merge(base, kept, log, 'No.');
      expect(m).toMatchObject({ steps: [], left: 0 }); expect(m.ask.map((a) => a.rows.map((r) => r.line))).toEqual([[101, 901]]); expect(pick(log, m, 1, 5)).toEqual(['', 'Final answer, sroe']);
    });
    it('their other edits to one of two are asked about too: an answer cleared, one copied from the other, a question closed', () => {
      for (const [col, v, other] of [[4, '', ''], [4, 'From 100', 'From 100'], [3, 'Closed', 'Closed']] as const) {
        const base = twice(g()); base[100][col] = other; const kept = base.map((r) => [...r]); const log = base.map((r) => [...r]); kept[900][col] = v;
        const m = merge(base, kept, log); expect(m).toMatchObject({ steps: [], left: 0 }); expect(m.ask).toHaveLength(1);
        expect(pick(log, m, 1, col)[1]).toBe(v);
      }
    });
    for (const number of ['No.', '']) it(`a party asks it twice, and the log took out the row they answered: never written into the other${number ? '' : ', with no number column'}`, () => {
      const H2 = ['No.', 'Question', 'Submitted by', 'Workstream', 'Status', 'Response'];
      const b = [H2, ...Array.from({ length: N }, (_, k) => [String(k + 1), q(k + 1), 'Lender A', 'Legal', 'Open', ''])];
      b[700] = ['', 'List material contracts.', 'Lender B', 'Legal', 'Open', '']; b[1500] = ['1500', 'List material contracts.', 'Lender B', 'Finance', 'Open', ''];
      const kept = b.map((r) => [...r]); kept[700][5] = 'sroe on 700'; const log = b.map((r) => [...r]); log.splice(700, 1);
      const m = mergeKept(table(b), table(kept), table(log), 'Question', undefined, undefined, number, undefined, 'Submitted by');
      expect(m).toMatchObject({ steps: [], clashes: [], left: 0 }); expect(m.ask.map((x) => x.rows.map((r) => r.line))).toEqual([[1500]]);   // offered, never written unasked
      expect(after(log, [...m.steps, ...m.ask[0].rows[0].steps])[1499][5]).toBe('sroe on 700');   // if the person says so
    });
    it('the log row of another of their rows, or another party\'s, is never offered', () => {
      const base = twice(g()); base[1500] = [CAP, 'Lender B', 'Legal', 'Open', '']; const kept = base.map((r) => [...r]); kept[900][4] = 'Final answer, sroe';
      const log = base.map((r) => [...r]); log[1500][4] = 'ldoe for B';
      expect(merge(base, kept, log).ask.map((a) => a.rows.map((r) => r.line))).toEqual([[101, 901]]);
    });
    it('B and B2: one of two or three they reworded is added at the end and counted', () => {
      const three = (x: string[][]) => { x[100] = [CAP, '', 'Finance', 'Open', '']; x[500] = [CAP, '', 'Tax', 'Open', 'R500']; x[900] = [CAP, '', 'Finance', 'Closed', 'R900']; return x; };
      for (const make of [twice, three]) {
        const base = make(g()), kept = make(g()), log = make(g()); kept[100] = ['Provide the fully diluted cap table.', '', kept[100][2], 'Open', 'sroe: attached'];
        const m = merge(base, kept, log); expect(m).toMatchObject({ added: 1, clashes: [] }); expect(m.left).toBeGreaterThan(0);
      }
    });
    it('C: a row they added that reads like them is asked about, with a row of its own to choose', () => {
      const base = twice(g()), kept = twice(g()), log = twice(g()); kept.push([CAP, '', 'Legal', 'Open', 'sroe: new ask, answered']);
      const m = merge(base, kept, log);
      expect(m).toMatchObject({ steps: [], added: 0, left: 0 }); expect(m.ask).toHaveLength(1);
      expect(m.ask[0].add).toEqual([{ col: 0, value: CAP }, { col: 2, value: 'Legal' }, { col: 3, value: 'Open' }, { col: 4, value: 'sroe: new ask, answered' }]);
    });
    it('a row they added with no number is the row the log added with its text', () => {
      const base = grid(); const kept = [...grid(), ['', 'Any liens?', 'sroe: none', '']]; const log = [...grid(), ['2001', 'Any liens?', '', '']];
      const m = mergeKept(table(base), table(kept), table(log), 'Question', undefined, undefined, 'No.');
      expect(m.added).toBe(0);
      expect(m.steps).toEqual([{ kind: 'cell', row: N + 1, col: 2, value: 'sroe: none' }]);
    });
  });
  it('E: a question they reworded, with no number column, is asked about; one of their own is added', () => {
    const base = grid().map((r) => r.slice(1)); const kept = base.map((r) => [...r]); kept[300][0] = 'Question 300, reworded by sroe'; kept[300][1] = 'sroe on 300';
    const m = mergeKept(table(base), table(kept), table(base.map((r) => [...r])), 'Question');
    expect(m).toMatchObject({ steps: [], added: 0, clashes: [], left: 0 }); expect(m.ask.map((x) => x.rows.map((r) => r.line))).toEqual([[301]]);
    expect(after(base, m.ask[0].rows[0].steps)[300]).toEqual(['Question 300, reworded by sroe', 'sroe on 300', '']);
    expect(mergeKept(table(base), table([...base, ['sroe\'s own question', '', '']]), table(base.map((r) => [...r])), 'Question')).toMatchObject({ added: 1, left: 0, ask: [] });
  });

  it('adds the rows they added below the last row, once, and never one the log already has', () => {
    const base = grid(); const kept = grid(); const log = grid();
    kept.push(['2001', 'sroe\'s own question', '', 'new']); kept.splice(10, 0, ['9b', 'sroe put this in mid-way', '', '']);
    log.push(['2001', 'sroe\'s own question', '', 'new']);                             // the log has one of them already
    const m = mergeKept(table(base), table(kept), table(log), 'Question');
    expect(m.added).toBe(1); const g = after(log, m.steps);
    expect(g.slice(-2)).toEqual([['2001', 'sroe\'s own question', '', 'new'], ['9b', 'sroe put this in mid-way']]);
  });

  it('takes nothing out of the log: a row they removed stays, and so does a change to a row the log removed', () => {
    const base = grid(); const kept = grid(); const log = grid();
    kept.splice(20, 1); set(kept, 30, 2, 'sroe on 31'); log.splice(31, 1);
    const m = mergeKept(table(base), table(kept), table(log), 'Question');
    expect(m.steps).toEqual([]); expect(m.clashes).toEqual([]); expect(m.left).toBe(1);   // sroe on 31 is only in their version
  });

  it('counts what it could not bring in: a cell in a column the log lacks, and nothing when all came in', () => {
    const base = grid(); const kept = grid(); set(kept, 4, 2, 'sroe on 4'); set(kept, 5, 3, 'sroe note');
    const log = grid().map((r) => r.slice(0, 3));                                      // the log has no Notes column
    expect(mergeKept(table(base), table(kept), table(log), 'Question')).toMatchObject({ cells: 1, left: 1 });
    expect(mergeKept(table(base), table(kept), table(grid()), 'Question')).toMatchObject({ cells: 2, left: 0 });
  });
  it('merges a column the log and they added since the version they edited, as empty there', () => {
    const base = grid().map((r) => r.slice(0, 3)); const kept = grid(); set(kept, 4, 3, 'sroe note'); set(kept, 6, 3, 'same'); const log = grid(); set(log, 6, 3, 'same');
    expect(mergeKept(table(base), table(kept), table(log), 'Question')).toMatchObject({ steps: [{ kind: 'cell', row: 4, col: 3, value: 'sroe note' }], clashes: [], left: 0 });
  });

  it('a second column of a heading put in is not taken for the first: it is counted as not brought in', () => {
    const H = ['No.', 'Question', 'Note']; const t = (rows: string[][]) => table(rows);
    const base = [H, ['1', q(1), 'old']]; const kept = [['No.', 'Question', 'Note', 'Note'], ['1', q(1), 'sroe new', 'old']];
    expect(mergeKept(t(base), t(kept), t(base.map((r) => [...r])), 'Question')).toMatchObject({ steps: [], cells: 0, left: 2 });
  });

  it('a row they added with a cell in a column added since is never dropped for a look-alike', () => {
    const t = (rows: string[][]) => table(rows);
    const base = [['No.', 'Question', 'By'], ['', 'Same Q', ''], ['', 'Same Q', '']];
    const kept = [['No.', 'Question', 'By', 'Answer'], ['', 'Same Q', '', ''], ['', 'Same Q', '', ''], ['', 'Same Q', '', 'sroe answer']];
    const m = mergeKept(t(base), t(kept), t(kept.slice(0, 3).map((r) => [...r])), 'Question');
    expect(m).toMatchObject({ steps: [], left: 0 }); expect(m.ask[0].add).toContainEqual({ col: 3, value: 'sroe answer' });   // asked: it can't be told from one of the two changed
  });

  it('lines columns up by their headings, and writes a plain number as a number', () => {
    const base = grid(); const kept = grid(); const log = grid().map((r) => [r[0], r[1], r[3], r[2]]);   // the log's Response and Notes swapped
    set(kept, 4, 2, 'sroe on 4'); set(kept, 4, 3, '1500');
    const m = mergeKept(table(base), table(kept), table(log), 'Question');
    expect(m.steps).toEqual([{ kind: 'cell', row: 4, col: 3, value: 'sroe on 4' }, { kind: 'cell', row: 4, col: 2, value: 1500 }]);
  });

  it('a cell it may not write (a formula) is reported, not written', () => {
    const base = grid(); const kept = grid(); set(kept, 4, 3, 'sroe on 4');
    const m = mergeKept(table(base), table(kept), table(grid()), 'Question', (r, c) => r === 4 && c === 3);
    expect(m.steps).toEqual([]); expect(m.clashes).toEqual([3]);
  });

  it('brings nothing in when the question column is not in all three', () => {
    const base = grid(); const kept = grid().map((r, i) => (i ? r : ['No.', 'Query', 'Response', 'Notes'])); set(kept, 4, 2, 'sroe');
    expect(mergeKept(table(base), table(kept), table(grid()), 'Question')).toMatchObject({ steps: [], left: 1 });
  });

  it('merges 2,000 rows each changed on both sides in a moment', () => {
    const base = grid(); const kept = grid(); const log = grid();
    for (let i = 1; i <= N; i++) { set(kept, i, 2, `sroe ${i}`); set(log, i, 3, `ldoe ${i}`); }
    const t0 = performance.now(); const m = mergeKept(table(base), table(kept), table(log), 'Question');
    expect(performance.now() - t0).toBeLessThan(1000); expect(m.cells).toBe(N); expect(m.clashes).toEqual([]);
  });
  // a consolidated log asks one question for several parties
  describe('rows that read alike', () => {
    const H = ['No.', 'Question', 'Submitted by', 'Response'];
    const t = (rows: string[][]) => table([H, ...rows]);
    /** merged as Update Q&A Log merges them: by the number and Submitted by columns too */
    const merge = (base: string[][], kept: string[][], log: string[][]) =>
      mergeKept(t(base), t(kept), t(log), 'Question', undefined, undefined, 'No.', undefined, 'Submitted by');
    it('are lined up by their number and sender, so an answer goes to its party wherever the log puts that row', () => {
      const base = [['1', 'Provide accounts.', 'Lender A', ''], ['2', 'Other', 'Lender A', ''], ['3', 'Provide accounts.', 'Lender B', '']];
      const kept = base.map((r) => [...r]); kept[0][3] = 'Answer for A only';
      const log = [base[2], base[1], base[0]].map((r) => [...r]);                     // sorted by party
      const m = merge(base, kept, log);
      expect(m.steps).toEqual([{ kind: 'cell', row: 3, col: 3, value: 'Answer for A only' }]); expect(m.clashes).toEqual([]);
    });
    it('a row the log took out is not mistaken for another that reads alike, nor for the next row reworded', () => {
      const base = [['1', 'Provide accounts.', 'Lender A', ''], ['2', 'Q two', 'Lender A', ''], ['3', 'Q three', 'Lender A', ''], ['4', 'Provide accounts.', 'Lender B', '']];
      const kept = base.map((r) => [...r]); kept[0][3] = 'For A'; kept[1][3] = 'sroe answer to two';
      // ldoe took out rows 1 and 2, and reworded 3
      const log = [base[2], base[3]].map((r) => [...r]);
      log[0][1] = 'Q three, reworded';
      expect(merge(base, kept, log).steps).toEqual([]);
    });
    it('a row they added for another party is added, though the log asks the same question already', () => {
      const base = [['1', 'Provide accounts.', 'Lender A', '']];
      const kept = [...base, ['2', 'Provide accounts.', 'Lender C', 'typed by sroe']];
      const m = merge(base, kept, base.map((r) => [...r]));
      expect(m.added).toBe(1); expect(m.steps.filter((s) => s.kind === 'cell').map((s) => s.kind === 'cell' && s.value)).toEqual([2, 'Provide accounts.', 'Lender C', 'typed by sroe']);
    });
  });

  it('counts a formula they put in, never writes it, and lets a formula that was there move on', () => {
    const base = grid(); const kept = grid(); set(kept, 4, 3, '17'); set(kept, 6, 3, '42'); kept.push(['2001', 'sroe: new', '', '9']);
    const f = (r: number, c: number) => (c === 3 && (r === 4 || r === 6 || r === 2001) ? `=X${r}` : false);
    const bf = (r: number, c: number) => (c === 3 && r === 6 ? '=X6' : false);          // row 6's formula was there; row 4's and the new row's are sroe's
    const m = mergeKept(table(base), table(kept), table(grid()), 'Question', undefined, f, '', bf);
    expect(m).toMatchObject({ left: 2, added: 1 }); expect(m.steps.filter((s) => s.kind === 'cell' && s.col === 3)).toEqual([]);
  });

  it('writes a date they gave as a date', () => {
    const base = grid(); const kept = grid(); set(kept, 4, 3, '2026-11-12');
    expect(mergeKept(table(base), table(kept), table(grid()), 'Question').steps).toEqual([{ kind: 'cell', row: 4, col: 3, value: '2026-11-12', date: true }]);
  });
  // a row they added that the log has already, from theirs saved again
  describe('a row they added that the log has', () => {
    const H = ['No.', 'Question', 'Response', 'Status'];
    const t = (rows: string[][]) => table([H, ...rows]); const base = Array.from({ length: 10 }, (_, k) => [String(k + 1), q(k + 1), '', 'Open']);
    it('gets what they filled in that the log\'s row lacks', () => {
      const m = mergeKept(t(base), t([...base, ['11', 'sroe: any liens?', 'sroe answered: none', 'Open']]), t([...base, ['11', 'sroe: any liens?', '', 'Open']]), 'Question', undefined, undefined, 'No.');
      expect(m).toMatchObject({ steps: [{ kind: 'cell', row: 11, col: 2, value: 'sroe answered: none' }], added: 0, clashes: [] });
    });
    it('keeps the log\'s where both filled a cell in, and reports it', () => {
      const m = mergeKept(t(base), t([...base, ['11', 'sroe: any liens?', '', 'Open']]), t([...base, ['11', 'sroe: any liens?', '', 'Chased']]), 'Question', undefined, undefined, 'No.');
      expect(m).toMatchObject({ steps: [], added: 0, clashes: [10] });
    });
    it('with no sender column, one with its text under another number is that row: a cell both filled keeps the log\'s',
      () => {
        const kept = [...base, ['12', 'Any liens?', '', 'Party B']];
        const log = [...base, ['11', 'Any liens?', '', 'Party A']];
        const m = mergeKept(t(base), t(kept), t(log), 'Question', undefined, undefined, 'No.');
        expect(m).toMatchObject({ steps: [], added: 0, clashes: [10] });
      });
  });
  it('a row they added with no question is never written into another row with none (a heading)', () => {
    const H = ['No.', 'Question', 'Response', 'Status']; const t = (rows: string[][]) => table([H, ...rows]);
    const base = [['1', q(1), '', ''], ['Section B', '', '', ''], ['2', q(2), '', '']];
    const m = mergeKept(t(base), t([...base, ['', '', 'sroe: see data room 4.2', '']]), t(base.map((r) => [...r])), 'Question', undefined, undefined, 'No.');
    expect(m.added).toBe(1); expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= 3)).toEqual([]);
  });
  it('a row and its copy that differ: which is the row can\'t be told, so both are asked about, and neither written over it', () => {
    const H = ['No.', 'Question', 'Response', 'Status']; const t = (rows: string[][]) => table([H, ...rows]);
    const base = [['1', q(1), '', 'Open'], ['2', q(2), '', 'Open'], ['3', q(3), '', 'Open']];
    const kept = [base[0], base[1], ['3', q(3), 'sroe A', 'Open'], ['3', q(3), 'sroe B', 'Open']];
    const m = mergeKept(t(base), t(kept), t(base.map((r) => [...r])), 'Question', undefined, undefined, 'No.');
    expect(m.steps.filter((s) => s.kind === 'cell' && s.row <= 3)).toEqual([]); expect(m).toMatchObject({ added: 0, clashes: [], left: 0 }); expect(m.ask.map((x) => x.rows.map((r) => r.line))).toEqual([[4], [4]]);
  });
  it('a row they added that reads like two of the log\'s, with nothing else to tell them apart, is asked about', () => {
    const H = ['No.', 'Question', 'Response']; const t = (rows: string[][]) => table([H, ...rows]);
    const base = [['', 'Same Q', ''], ['', 'Same Q', '']]; const kept = [...base.map((r) => [...r]), ['', 'Same Q', 'sroe answer']];
    const m = mergeKept(t(base), t(kept), t(base.map((r) => [...r])), 'Question');
    expect(m).toMatchObject({ steps: [], added: 0 }); expect(m.ask.map((a) => a.rows.map((r) => r.line))).toEqual([[2, 3]]);   // neither row is taken for it unasked
    const log = [['', 'Same Q', ''], ['', 'Same Q', 'ldoe']];
    // the log has it already
    expect(mergeKept(t(base), t([...base, ['', 'Same Q', 'ldoe']]), t(log), 'Question')).toMatchObject({
      steps: [],
      added: 0,
      ask: [],
    });
  });
  it('a cell they cleared is not filled again from a copy of the row: the copy is added at the end', () => {
    const H = ['No.', 'Question', 'Response', 'Status']; const t = (rows: string[][]) => table([H, ...rows]);
    const base = [['1', q(1), '', 'Open'], ['2', q(2), '', 'Open'], ['3', q(3), 'old answer', 'Open']];
    const kept = [base[0], base[1], ['3', q(3), '', 'Open'], ['', q(3), 'old answer', '']];
    const m = mergeKept(t(base), t(kept), t(base.map((r) => [...r])), 'Question', undefined, undefined, 'No.');
    expect(m.steps.filter((s) => s.kind === 'cell' && s.row === 3)).toEqual([{ kind: 'cell', row: 3, col: 2, value: '' }]); expect(m).toMatchObject({ added: 1, clashes: [] });
  });

  describe('a row they added, which the log holds already under the same number', () => {
    const rows = () => [
      ['No.', 'Question', 'Response', 'Notes'], ['1', 'Question one', '', ''], ['2', 'Question two', '', ''],
    ];
    const merged = (theirs: string, logs: string) => mergeKept(
      table(rows()), table([...rows(), ['9', 'Brand new question', theirs, '']]),
      table([...rows(), ['9', 'Brand new question', logs, '']]), 'Question', undefined, undefined, 'No.',
    );
    it('needs nothing when a cell is the same character for character', () => {
      expect(merged('a', 'a')).toMatchObject({ steps: [], cells: 0, added: 0, clashes: [] });
    });
    it('is a clash when a cell differs by a space at an end, whichever way', () => {
      expect(merged('a ', 'a')).toMatchObject({ steps: [], cells: 0, clashes: [2] });
      expect(merged('a', 'a ')).toMatchObject({ steps: [], cells: 0, clashes: [2] });
    });
    it('brings their cell in, as they wrote it, where the log has none', () => {
      const step = { kind: 'cell', row: 3, col: 2, value: ' a\t' };
      expect(merged(' a\t', '')).toMatchObject({ steps: [step], cells: 1, clashes: [] });
    });
  });
});
