// What the app writes back into a counterparty's own Q&A log: the questions it adds and the answers it adds, and nothing else.
import { describe, it, expect } from 'vitest';
import { logWrite } from '../../src/domain/logWrite';
import { suggestMapping } from '../../src/domain/importExport';
import type { Question } from '../../src/domain/model';
import { writtenAsMeant } from '../../src/domain/sheets';

const q = (n: number, text: string, more: Partial<Question> = {}) => ({ id: `q${n}`, n, text, askedBy: 'Lender A', received: '', workstream: '', priority: '', response: '', respondedBy: '', ...more }) as Question;
// a log with a title in row 1, headings in row 3 and an empty column B; columns A, C, D, E of the sheet are read
const columns = ['No.', 'Question', 'Sponsor response', 'Responded by'];
const table = { columns, cols: [0, 2, 3, 4], lines: [4, 5, 6], lastRow: 6, rows: [['Q1', 'What is the minimum DSCR covenant?', '1.20x', 'Sponsor'], ['Q2', 'Who is the EPC  contractor?', '', ''], ['Q3', 'What insurances are in place?', 'See the advisor report', 'Sponsor']] };
const map = suggestMapping(columns);

describe('writing back into a Q&A log', () => {
  it('adds an answer the log does not have, in its own row and columns, and leaves filled answers alone', () => {
    const w = logWrite(table, map, [q(1, 'What is the minimum DSCR covenant?', { response: '1.25x' }), q(2, 'Who is the EPC  contractor?', { response: 'Fabrikam', respondedBy: 'Sponsor' }), q(3, 'What insurances are in place?', { response: 'See the advisor report' })]);
    expect(w.steps).toEqual([
      { kind: 'cell', row: 4, col: 3, value: 'Fabrikam' },
      { kind: 'cell', row: 4, col: 4, value: 'Sponsor' },
    ]);
    expect(w).toMatchObject({ answered: 1, added: 0, kept: [1] });                  // Q1's answer differs, and the app never sent those words: the log's own stands
  });
  it('adds a question the log does not have as a row below its last one, numbered in its own style', () => {
    const w = logWrite(table, map, [q(1, 'What is the minimum DSCR covenant?'), q(5, 'Is there a tax equity investor?', { response: 'No' }), q(4, 'Who is the O&M contractor?')]);
    expect(w.steps).toEqual([
      { kind: 'rows', after: 5, count: 2 },
      { kind: 'cell', row: 6, col: 0, value: 'Q4' }, { kind: 'cell', row: 6, col: 2, value: 'Who is the O&M contractor?' },
      { kind: 'cell', row: 7, col: 0, value: 'Q5' }, { kind: 'cell', row: 7, col: 2, value: 'Is there a tax equity investor?' }, { kind: 'cell', row: 7, col: 3, value: 'No' },
    ]);
    expect(w.added).toBe(2);
  });
  it('finds a question by its words before its number, so a renumbered log still lines up; then by number', () => {
    const w = logWrite(table, map, [
      q(7, 'Who is the EPC contractor?', { response: 'Fabrikam' }),
      q(3, 'What insurances are in place now?'),
    ]);
    expect(w.steps).toEqual([{ kind: 'cell', row: 4, col: 3, value: 'Fabrikam' }]); expect(w.added).toBe(0);
  });
  it('writes nothing when the app has nothing the log lacks', () => {
    expect(logWrite(table, map, [q(1, 'What is the minimum DSCR covenant?', { response: '1.20x' })])).toMatchObject({ steps: [], added: 0, answered: 0, updated: 0, kept: [], keptFields: {} });
  });
  it('replaces an answer that still reads as the app last sent it, once the app\'s answer has changed', () => {
    const qs = [q(1, 'What is the minimum DSCR covenant?', { response: '1.25x, stepping up to 1.30x' }), q(3, 'What insurances are in place?', { response: 'See the advisor report' })];
    const w = logWrite(table, map, qs, new Map([['q1', { response: '1.20x' }], ['q3', { response: 'See the advisor report' }]]));
    expect(w.steps).toEqual([{ kind: 'cell', row: 3, col: 3, value: '1.25x, stepping up to 1.30x' }]);
    expect(w).toMatchObject({ updated: 1, answered: 0, kept: [] });
  });
  it('leaves an answer the counterparty changed after the app sent it', () => {
    const w = logWrite(table, map, [q(1, 'What is the minimum DSCR covenant?', { response: '1.25x' })], new Map([['q1', { response: '1.15x' }]]));
    expect(w).toMatchObject({ steps: [], kept: [1] });
  });
});

describe('a log edit is taken exactly as written', () => {
  it('keeps a "?" or damaged characters as the log shows them, and never counts them as the app\'s text', () => {
    for (const edited of ['Caf?', 'Caf\uFFFD', 'CafÃ©', 'Café ', 'Done 👍']) {
      const response = edited.startsWith('Done') ? 'Done' : 'Café';
      const w = logWrite(
        { ...table, rows: [['Q1', 'What is the minimum DSCR covenant?', edited, 'Sponsor']], lines: [4], lastRow: 4 },
        map,
        [q(1, 'What is the minimum DSCR covenant?', { response })],
        new Map([['q1', { response }]]),
      );
      expect(w, edited).toMatchObject({ steps: [], taken: { q1: { response: edited } } });
    }
  });
});

describe('a log cell as the file holds it', () => {
  it('is still what the app sent when the file stored its line breaks or control characters its own way', () => {
    for (const [sent, held] of [['Line1\r\nLine2', 'Line1\nLine2'], ['a\u0001b', 'a b'], ['a\u0001b', 'ab'], ['a\rb', 'a\nb']]) {
      const w = logWrite(
        { ...table, rows: [['Q1', 'What is the minimum DSCR covenant?', held, 'Sponsor']], lines: [4], lastRow: 4 },
        map,
        [q(1, 'What is the minimum DSCR covenant?', { response: `${sent} more` })],
        new Map([['q1', { response: sent }]]),
      );
      expect(w.steps, sent).toEqual([{ kind: 'cell', row: 3, col: 3, value: `${sent} more` }]);
      expect(w.kept, sent).toEqual([]);
    }
  });
});

describe('the read-back check of a written log', () => {
  const before = [{ name: 'Log', grid: [['No.', 'Question', 'Response'], ['1', 'DSCR?', '']] }, { name: 'Notes', grid: [['x']] }];
  const steps = [{ kind: 'cell' as const, row: 1, col: 2, value: '1.20x' }, { kind: 'rows' as const, after: 1, count: 1 }, { kind: 'cell' as const, row: 2, col: 0, value: 2 }];
  it('passes a file that is the old one with the steps made, blank edges aside', () => {
    expect(writtenAsMeant(before, [{ name: 'Log', grid: [['No.', 'Question', 'Response', ''], ['1', 'DSCR?', '1.20x'], ['2'], []] }, { name: 'Notes', grid: [['x']] }], 'Log', steps)).toBeNull();
  });
  it('names the first cell that changed when it should not have, and a sheet that went', () => {
    expect(writtenAsMeant(before, [{ name: 'Log', grid: [['No.', 'Question?', 'Response'], ['1', 'DSCR?', '1.20x'], ['2']] }, { name: 'Notes', grid: [['x']] }], 'Log', steps)).toBe('Log!B1 reads "Question?", not "Question"');
    expect(writtenAsMeant(before, [{ name: 'Log', grid: [['No.', 'Question', 'Response'], ['1', 'DSCR?', '1.20x'], ['2']] }], 'Log', steps)).toBe('the sheets are not the same');
  });
});

// Edge cases: what a log can hold that must not be overwritten or matched to the wrong row
describe('matching and keeping, in awkward logs', () => {
  const cols3 = ['No.', 'Question', 'Response']; const m3 = suggestMapping(cols3);
  const T = (rows: string[][]) => ({ columns: cols3, cols: [0, 1, 2], rows, lines: rows.map((_, i) => i + 2), lastRow: rows.length + 1 });
  it('keeps the counterparty\'s change of sign to an answer the app sent', () => {
    const w = logWrite(T([['1', 'EBITDA margin?', 'EBITDA margin: -5%']]), m3, [q(1, 'EBITDA margin?', { response: 'EBITDA margin: 5% (unaudited)' })], new Map([['q1', { response: 'EBITDA margin: 5%' }]]));
    expect(w.kept).toEqual([1]); expect(w.steps).toEqual([]);
  });
  it('does not take the counterparty\'s own question 4 for the app\'s question 4', () => {
    const w = logWrite(
      T([
        ['1', 'DSCR?', ''],
        ['4', 'Sponsor note: what about tax?', ''],
      ]),
      m3,
      [q(4, 'Who is the O&M contractor?', { response: 'Fabrikam' })],
    );
    expect(w.added).toBe(1); expect(w.steps.some((s) => s.kind === 'cell' && s.row === 2)).toBe(false);
  });
  it('in doubt, gives a question of the same number a row of its own', () => {
    expect(logWrite(T([['4', 'What is the tenor?', '']]), m3, [q(4, 'What is the loan tenor?', { response: '18 years' })]).added).toBe(1);
  });
  it('does not take a row of the same number that shares only filler words with the question', () => {
    const w = logWrite(T([['4', 'What is the headcount plan?', '']]), m3, [q(4, 'What is the churn?', { response: '3% a year' })]);
    expect(w.added).toBe(1); expect(w.steps.some((s) => s.kind === 'cell' && s.row === 1)).toBe(false);
  });
  it('of two rows that read the same, answers the one with the question\'s number', () => {
    const w = logWrite(T([['2', 'Any litigation?', ''], ['1', 'Any litigation?', '']]), m3, [q(1, 'Any litigation?'), q(2, 'Any litigation?', { response: 'None' })]);
    expect(w.steps).toEqual([{ kind: 'cell', row: 1, col: 2, value: 'None' }]);
  });
  it('finds a question reworded only in case in a renumbered log', () => {
    expect(
      logWrite(T([['7', 'Who is the EPC contractor?', '']]), m3, [
        q(2, 'Who is the EPC Contractor?', { response: 'Fabrikam' }),
      ]).added,
    ).toBe(0);
  });
  for (const n of ['4.', 'Q 4', 'Q-4', '#4', '004']) it(`reads "${n}" as question 4`, () => {
    expect(logWrite(T([[n, 'What is the tenor of the loan?', '']]), m3, [q(4, 'What is the loan tenor?', { response: '18 years' })]).added).toBe(0);
  });
  for (const [style, want] of [['1.', '2.'], ['A-1', 'A-2'], ['#1', '#2'], ['Q 1', 'Q 2']]) it(`numbers a new row "${want}" in a log that numbers "${style}"`, () => {
    expect(logWrite(T([[style, 'DSCR?', '']]), m3, [q(1, 'DSCR?'), q(2, 'EPC?')]).steps).toContainEqual({ kind: 'cell', row: 2, col: 0, value: want });
  });
});

// The log kept up to date as an IB Q&A log is: every column it has, nothing made up, someone's edits kept

describe('a log that writes its cells its own way', () => {
  const cols = ['No.', 'Question', 'Priority', 'Date received', 'Status', 'Response'];
  const m = suggestMapping(cols);
  const log = { columns: cols, cols: cols.map((_, i) => i), rows: [['1', 'What is the minimum DSCR covenant?', '', '11/12/2026', 'Outstanding', '']], lines: [2], lastRow: 2 };
  it('leaves a blank Priority blank: the High a question with none came in with is the app\'s default, not a value anyone gave', () => {
    const w = logWrite(log, m, [q(1, 'What is the minimum DSCR covenant?', { priority: 'High', received: '2026-11-12', status: 'open' })]);
    expect(w.steps).toEqual([]); expect(w).toMatchObject({ updated: 0, kept: [] }); expect(w.sent.q1.priority).toBeUndefined();
    const lowered = logWrite(log, m, [q(1, 'What is the minimum DSCR covenant?', { priority: 'Medium', received: '2026-11-12', status: 'open' })]);
    expect(lowered.steps).toEqual([{ kind: 'cell', row: 1, col: 2, value: 'Medium' }]);           // one a person set is written
  });
  it('keeps a date or status the log already says its own way as ours, so a later change in the app still reaches it', () => {
    const first = logWrite(log, m, [q(1, 'What is the minimum DSCR covenant?', { received: '2026-11-12', status: 'open' })]);
    expect(first.steps).toEqual([]); expect(first.sent.q1).toMatchObject({ received: '11/12/2026', status: 'Outstanding' });
    const next = logWrite(log, m, [q(1, 'What is the minimum DSCR covenant?', { received: '2026-11-13', status: 'answered', response: 'Yes' })], new Map(Object.entries(first.sent)));
    expect(next.steps).toEqual([{ kind: 'cell', row: 1, col: 3, value: '2026-11-13', date: true }, { kind: 'cell', row: 1, col: 4, value: 'Answered' }, { kind: 'cell', row: 1, col: 5, value: 'Yes' }]);
    expect(next.kept).toEqual([]);
  });
  it('knows a date it wrote, read back in the column\'s own date format, as its own', () => {
    const w = logWrite(log, m, [q(1, 'What is the minimum DSCR covenant?', { received: '2026-11-14', status: 'open' })], new Map([['q1', { received: '2026-11-12', status: 'Open' }]]));
    expect(w.steps).toEqual([{ kind: 'cell', row: 1, col: 3, value: '2026-11-14', date: true }]); expect(w.kept).toEqual([]);
  });
});

describe('every column of the log', () => {
  const cols = ['#', 'Submitted by', 'Question', 'Received', 'Status', 'Response', 'Date'];
  const m = suggestMapping(cols);
  const T = (rows: string[][]) => ({ columns: cols, cols: cols.map((_, i) => i), rows, lines: rows.map((_, i) => i + 2), lastRow: rows.length + 1 });
  it('fills each column of a new row the app has a value for, and leaves the others empty', () => {
    const w = logWrite(T([['1', 'Lender A', 'DSCR?', '2026-11-02', 'Open', '', '']]), m, [
      q(1, 'DSCR?', { status: 'open', received: '2026-11-02' }),
      q(2, 'Who is the EPC contractor?', {
        status: 'answered',
        askedBy: 'Bidder C',
        response: 'Fabrikam',
        responded: '2026-11-14',
      }),
    ]);
    expect(w.steps[0]).toEqual({ kind: 'rows', after: 1, count: 1 }); expect(w.steps).toContainEqual({ kind: 'cell', row: 2, col: 4, value: 'Answered' });
    expect(w.steps.filter((s) => s.kind === 'cell' && s.row === 2).map((s) => s.kind === 'cell' && s.col).sort()).toEqual([0, 1, 2, 4, 5, 6]);   // no Received: the app has none
  });
  it('fills an empty cell of an existing row, and updates one the app wrote and has since changed', () => {
    const w = logWrite(T([['1', 'Lender A', 'DSCR?', '', 'Open', '1.20x', '']]), m, [q(1, 'DSCR?', { status: 'answered', received: '2026-11-02', response: '1.20x', responded: '2026-11-14' })], new Map([['q1', { status: 'Open', response: '1.20x' }]]));
    expect(w.steps).toEqual([{ kind: 'cell', row: 1, col: 3, value: '2026-11-02', date: true }, { kind: 'cell', row: 1, col: 4, value: 'Answered' }, { kind: 'cell', row: 1, col: 6, value: '2026-11-14', date: true }]);
    expect(w).toMatchObject({ updated: 1, kept: [] });
  });
  it('takes a cell that says what the app holds in other words ("Outstanding", 10/30/2026) for no change', () => {
    const w = logWrite(T([['1', 'Lender A', 'DSCR?', '10/30/2026', 'Outstanding', '', '']]), m, [q(1, 'DSCR?', { status: 'open', received: '2026-10-30' })]);
    expect(w).toMatchObject({ steps: [], kept: [] });
  });
  // an edit made in the log is the latest; two versions only where the app changed the cell too
  it('takes a status only the log changed since the app wrote it', () => {
    const w = logWrite(T([['1', 'Lender A', 'DSCR?', '', 'Closed', '', '']]), m, [q(1, 'DSCR?', { status: 'open' })], new Map([['q1', { status: 'Open' }]]));
    expect(w).toMatchObject({ steps: [], kept: [], taken: { q1: { status: 'Closed' } }, sent: { q1: { status: 'Closed' } } });
  });
  it('leaves a status changed in both the log and the app in two versions', () => {
    const w = logWrite(T([['1', 'Lender A', 'DSCR?', '', 'Closed', '', '']]), m, [q(1, 'DSCR?', { status: 'answered', response: '1.3x' })], new Map([['q1', { status: 'Open' }]]));
    expect(w).toMatchObject({ kept: [1], keptFields: { q1: ['status'] }, taken: {} });
  });
});

// The worry is two people's responses to one question, one clobbering the other. The update never writes
// over a response someone else put in the log; it fills a blank one, and replaces only what the app itself wrote there.
describe('a response someone else wrote in the log', () => {
  const t = { columns: ['No.', 'Question', 'Response'], cols: [0, 1, 2], lines: [2, 3, 4, 5], lastRow: 5, rows: [
    ['1', 'What is the DSCR?', 'Colleague: 1.20x, per the model'],          // written in Excel, never by the app
    // the app wrote "Fabrikam"; a colleague rewrote it
    ['2', 'Who is the EPC contractor?', 'Colleague: Fabrikam, signed Oct 3'],
    ['3', 'What is the O&M term?', '10 years'],                                // as the app wrote it
    ['4', 'Is there a tax equity investor?', ''],                              // blank
  ] };
  const m = suggestMapping(t.columns);
  const qs = [
    q(1, 'What is the DSCR?', { response: 'Mine: 1.25x' }),
    q(2, 'Who is the EPC contractor?', { response: 'Mine: Fabrikam E&S' }),
    q(3, 'What is the O&M term?', { response: '10 years, plus two 5-year extensions' }),
    q(4, 'Is there a tax equity investor?', { response: 'No' }),
  ];
  const sent = new Map([['q2', { response: 'Fabrikam' }], ['q3', { response: '10 years' }]]);
  it('is never written over, whether the app never wrote that cell or a colleague changed what it wrote', () => {
    const w = logWrite(t, m, qs, sent); const at = (line: number) => w.steps.find((s) => s.kind === 'cell' && s.row === line - 1 && s.col === 2);   // a step's row counts from 0
    expect([at(2), at(3)]).toEqual([undefined, undefined]); expect(w.keptFields).toMatchObject({ q1: ['response'], q2: ['response'] });
    expect(at(4)).toEqual({ kind: 'cell', row: 3, col: 2, value: '10 years, plus two 5-year extensions' });   // still what the app wrote: updated
    expect(at(5)).toEqual({ kind: 'cell', row: 4, col: 2, value: 'No' });                                       // blank: filled
  });
});


describe('a response cleared in the app (#39)', () => {
  const columns3 = ['No.', 'Question', 'Response'];
  const map3 = suggestMapping(columns3);
  const asks = [
    'Please confirm the minimum DSCR covenant and any lock-up test',
    'Who is the EPC contractor, and what are the liquidated damages caps',
    'Provide the O&M budget against the base case',
    'Describe the insurance program, including business interruption cover',
    'Explain how the PPA tariff is indexed',
    'List the land lease terms and extension options',
    'Confirm the grid connection agreement is signed',
  ];
  const sites = ['Fabrikam North', 'Contoso Ridge', 'Proseware Flats', 'Coho Valley', 'Litware Bay'];
  const textOf = (i: number) => `${asks[i % asks.length]} at ${sites[i % sites.length]} (${i + 1})`;
  const texts = Array.from({ length: 2000 }, (_, i) => textOf(i));
  const answers = texts.map((_, i) => `See data room folder 0${(i % 9) + 1}, section ${(i % 40) + 1}`);
  const edit = (answer: string) => `${answer}; updated by the sponsor`;
  /** the log as the app last wrote it, with the first `edited` responses since changed by a colleague in the file */
  const logOf = (edited: number) => ({
    columns: columns3,
    cols: [0, 1, 2],
    lines: texts.map((_, i) => i + 2),
    lastRow: texts.length + 1,
    rows: texts.map((text, i) => [String(i + 1), text, i < edited ? edit(answers[i]) : answers[i]]),
  });
  const sent = new Map(texts.map((text, i) => [`q${i + 1}`, { text, response: answers[i] }]));
  // the first 100 questions had their response erased in the app
  const questions = texts.map((text, i) => q(i + 1, text, { response: i < 100 ? '' : answers[i] }));
  const clears = (from: number) => Array.from({ length: 100 - from }, (_, i) => ({
    kind: 'cell', row: from + i + 1, col: 2, value: '',
  }));

  it('clears the log cell that still holds what the app wrote, across a 2,000-question log', () => {
    const written = logWrite(logOf(0), map3, questions, sent);
    expect(written.steps).toEqual(clears(0));
    expect(written).toMatchObject({ updated: 100, kept: [] });
    expect(written.sent.q1.response).toBe('');
  });
  it('keeps a colleague\'s later edit in the file rather than clearing it', () => {
    const written = logWrite(logOf(20), map3, questions, sent);
    expect(written.steps).toEqual(clears(20));
    expect(written.kept).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(written.keptText.q1.response).toBe(edit(answers[0]));
  });
  it('leaves a filled cell alone when the app never wrote a response there', () => {
    expect(logWrite(logOf(0), map3, questions, new Map()).steps).toEqual([]);
  });
});
