import { describe, it, expect } from 'vitest';
import { parseDate, prepareImport, suggestMapping, questionsSheet, findingsSheet } from '../../src/domain/importExport';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { readCsv } from '../../src/domain/sheets';
import { Question } from '../../src/domain/model';

describe('parseDate', () => {
  it('accepts unambiguous dates with a full year', () => {
    expect(parseDate('2026-11-01')).toBe('2026-11-01');
    expect(parseDate('11/02/2026')).toBe('2026-11-02');      // month first
    expect(parseDate('31/12/2026')).toBe('2026-12-31');      // only day-first is possible
    expect(parseDate('Nov 1, 2026')).toBe('2026-11-01');
    expect(parseDate('October 3, 2026')).toBe('2026-10-03');
    expect(parseDate('Sept 5, 2026')).toBe('2026-09-05');
    expect(parseDate('')).toBe('');
  });
  it('reads the other common ways of writing a date', () => {
    for (const [typed, iso] of [['2-Nov-2026', '2026-11-02'], ['02-Nov-26', '2026-11-02'], ['2026/11/02', '2026-11-02'], ['2026.11.2', '2026-11-02'], ['Nov 2nd 2026', '2026-11-02'], ['November 3rd, 2026', '2026-11-03'], ['21st Nov 2026', '2026-11-21'], ['Nov-02-2026', '2026-11-02']]) expect([typed, parseDate(typed)]).toEqual([typed, iso]);
    // a two-digit year is read as Excel reads it, and the day and month in the order four-digit years are
    expect(parseDate('11/02/26')).toBe('2026-11-02'); expect(parseDate('13/02/26')).toBe('2026-02-13'); expect(parseDate('02.11.26')).toBe(parseDate('02.11.2026')); expect(parseDate('1/2/99')).toBe('1999-01-02');
  });
  it('reads a date with a time as its date', () => {
    for (const [typed, iso] of [['11/14/2026 12:00:00', '2026-11-14'], ['11/14/2026 3:30 PM', '2026-11-14'], ['Nov 14, 2026 09:15', '2026-11-14'], ['2026/11/14 23:59:59.5', '2026-11-14']]) expect([typed, parseDate(typed)]).toEqual([typed, iso]);
    for (const bad of ['11/14/2026 25:00', '12:00:00', '11/31/2026 12:00:00']) expect([bad, parseDate(bad)]).toEqual([bad, null]);
  });
  it('rejects impossible or year-less dates instead of changing them', () => {
    for (const bad of ['2026-99-99', '31/02/2026', 'Feb 31, 2026', 'April 31, 2026', 'Nov 1', '1 Nov', 'soon', '44866']) expect(parseDate(bad)).toBeNull();
  });
});

describe('the stand-in\'s CSV reader and writer', () => {
  it('round-trips unicode, markup-like text, line breaks and control characters', async () => {
    const text = 'Café façade — naïve £50 €100 中文 😀 & <b>literal &lt; text</b>\nsecond line';
    const w = await csvCodec.write('Q&A log', [['Question'], [text]]); if (!w.ok) throw new Error('write');
    const r = readCsv(w.value.bytes);
    expect(r.ok && r.value.rows[0][0]).toBe(text);
  });
  it('reads CSV as text: quoted commas and line breaks, no date or number guessing', () => {
    const csv = 'Number,Question,Received\n007,"Line one\nline two, with comma",11/02/2026\n';
    const r = readCsv(new TextEncoder().encode(csv));
    expect(r.ok && r.value.rows[0]).toEqual(['007', 'Line one\nline two, with comma', '11/02/2026']);
  });
  it('reports a file that is not a .csv as unreadable here', async () => {
    expect((await csvCodec.read(new Uint8Array([1, 2, 3, 4]), 'x.xlsx')).ok).toBe(false);
  });
});

describe('suggestMapping', () => {
  it('picks up a column that names who responded, however it is headed, and never takes it for the response itself', () => {
    for (const h of ['Responded by', 'Responder', 'Respondent', 'Answered by', 'Replied by', 'Response by', 'Response from', 'Responding party', 'Respondent firm', 'RESPONDED BY', 'Responded-by']) {
      const m = suggestMapping(['#', 'Question', 'Response', h, 'Date']);
      expect([h, m.response, m.respondedBy]).toEqual([h, 2, 3]);
      const p = prepareImport([['1', 'What is the lock-up?', '1.30x', 'Northwind Sponsor LP', '2026-11-02']], m);
      expect(p.rows[0]).toMatchObject({ response: '1.30x', respondedBy: 'Northwind Sponsor LP', responded: '2026-11-02' });
    }
    expect(suggestMapping(['#', 'Question', 'Response']).respondedBy).toBeNull();          // no such column: nobody is named
  });
});

describe('prepareImport', () => {
  it('maps columns, validates values and counts what it could not read', () => {
    const cols = ['Number', 'Question', 'Priority', 'Status', 'Received', 'Date'];
    const m = suggestMapping(cols);
    const p = prepareImport([['2', 'Datum', 'High', 'Closed', '2026-11-01', ''], ['', 'Coho', 'urgent', 'weird', 'Feb 31, 2026', 'April 31, 2026'], ['', '', '', '', '', '']], m);
    expect(p.rows.length).toBe(2); expect(p.skipped).toBe(1); expect(p.badDates).toBe(2); expect(p.unknownValues).toBe(2);
    // and says which, by row (the heading is row 1) and column
    expect(p.unread).toEqual(['Row 3 Priority: urgent', 'Row 3 Status: weird', 'Row 3 Received: Feb 31, 2026', 'Row 3 Date: April 31, 2026']);
    expect(p.rows[0]).toMatchObject({ n: 2, priority: 'High', status: 'closed', received: '2026-11-01' });
    expect(p.rows[1]).toMatchObject({ n: null, priority: '', status: '', received: '', responded: '' });
  });
  it('settles a date valid both ways by context, and leaves it blank when nothing settles it', () => {
    const m = suggestMapping(['Question', 'Received', 'Date']);
    const p = prepareImport([
      ['Row other date', '13.10.2026', '02.11.2026'],   // received Oct 13, so responded is Nov 2, not Feb 11
      ['Rows around', '20.10.2026', ''], ['Middle', '05.11.2026', ''], ['After', '20.11.2026', ''],   // between Oct 20 and Nov 20: Nov 5, not May 11
    ], m, undefined, { today: '2026-11-15' });
    expect(p.rows.map((r) => [r.received, r.responded])).toEqual([['2026-10-13', '2026-11-02'], ['2026-10-20', ''], ['2026-11-05', ''], ['2026-11-20', '']]);
    // both readings come before the next row's date: the one much nearer it (Nov 2, a day before Nov 3, not Feb 11)
    expect(prepareImport([['Near', '11/02/2026', ''], ['Next', '2026-11-03', '']], m, undefined, { today: '2026-11-15' }).rows[0].received).toBe('2026-11-02');
    // no other date to go by: Dec 1 is after today, so Jan 12
    expect(prepareImport([['Not in the future', '12.01.2026', '']], m, undefined, { today: '2026-11-15' }).rows[0].received).toBe('2026-01-12');
    // nothing to go by and both readings in the past: left blank and listed
    const q = prepareImport([['Alone', '02.03.2026', '']], m, undefined, { today: '2026-11-15' });
    expect(q.rows[0].received).toBe(''); expect(q.badDates).toBe(1); expect(q.unread).toEqual(['Row 2 Received: 02.03.2026']);
  });
  it('reads back a number past Q999999, as the app numbers them', () => {
    const m = suggestMapping(['Number', 'Question']);
    expect(prepareImport([['Q1000000', 'Datum'], ['1234567890', 'Coho']], m).rows.map((r) => r.n)).toEqual([1000000, null]);
  });
  it('export → import keeps numbers, dates with their year, status and multi-line text', async () => {
    const at = '2026-11-09T10:00:00.000Z';
    const q = Question.parse({ id: 'q_01HZZZZZZZZZZZZZZZZZZZZZZZ', dealId: 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ', rev: 1, createdAt: at, updatedAt: at, n: 37, text: 'First\nSecond', askedBy: 'Lender', received: '2026-11-01', workstream: 'Legal', priority: 'High', status: 'answered', response: 'Yes.', respondedBy: 'Sponsor', responded: '2026-11-02' });
    const file = await csvCodec.write('Q&A log', questionsSheet([q])); if (!file.ok) throw new Error('write');
    const t = readCsv(file.value.bytes); expect(t.ok).toBe(true);
    if (!t.ok) return;
    const p = prepareImport(t.value.rows, suggestMapping(t.value.columns));
    expect(p.badDates).toBe(0);
    expect(p.rows[0]).toEqual({ n: 37, text: 'First\nSecond', askedBy: 'Lender', received: '2026-11-01', workstream: 'Legal', priority: 'High', response: 'Yes.', respondedBy: 'Sponsor', responded: '2026-11-02', status: 'answered', line: 2 });
  });
  it('an export, and a new Q&A log, never name the person in the app who accepted a draft; who responded is kept', () => {
    // the person who wrote an answer in the app stays in the app; who responded on the outside is wanted
    const at = '2026-11-09T10:00:00.000Z';
    const q = Question.parse({
      dealId: 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      rev: 1,
      createdAt: at,
      updatedAt: at,
      status: 'answered',
      responded: '2026-11-02',
      id: 'q_01HZZZZZZZZZZZZZZZZZZZZZZB',
      n: 2,
      text: 'Drafted',
      response: 'No.',
      respondedBy: 'Sponsor counsel',
      provenance: { origin: 'ai', sources: [], actor: 'adoe', at },
    });
    const sheet = questionsSheet([q]);
    expect(JSON.stringify(sheet)).not.toContain('adoe');
    expect(sheet[1]).toContain('Sponsor counsel'); expect(sheet[1].at(-1)).toBe('AI draft, accepted on 2026-11-09');
  });
  it('a findings export names no one in the app: not who reviewed a finding', () => {
    const f = {
      title: 'Lock-up differs',
      body: ['b'],
      workstream: '',
      status: 'open',
      raisedAt: '2026-11-09T10:00:00.000Z',
      origin: 'human',
      sources: [],
      note: '',
      next: '',
      reviewed: { by: 'adoe', at: '2026-11-10T10:00:00.000Z' },
    };
    const sheet = findingsSheet([f as never]);
    expect(sheet[0]).not.toContain('Reviewed by');
    expect(JSON.stringify(sheet)).not.toContain('adoe');
    expect(sheet[1][6]).toBe('2026-11-10');
  });
  it('keeps text as written: leading spaces, trailing line breaks and a question of only spaces', () => {
    const m = suggestMapping(['Number', 'Question', 'Response', 'Submitted by', 'Priority', 'Received']);
    const p = prepareImport([[' 3 ', '  Indented question', 'Yes.\n', ' Lender A ', ' High ', ' 2026-11-02 '], ['4', '   ', '', '', '', '']], m);
    expect(p.skipped).toBe(0); expect(p.badDates).toBe(0); expect(p.unknownValues).toBe(0);
    // a name is stored as the cell gives it
    expect(p.rows[0]).toMatchObject({
      n: 3, text: '  Indented question', response: 'Yes.\n', askedBy: ' Lender A ',
      priority: 'High', received: '2026-11-02',
    });
    expect(p.rows[1]).toMatchObject({ n: 4, text: '   ' });
  });
});

describe('a month written as a word', () => {
  it('is read only as its full name or its three-letter abbreviation, as Excel takes it', () => {
    const named = ['Jun 3 2026', 'June 3, 2026', '3 Sept 2026', '3-Sep-2026'];
    for (const text of named) expect(parseDate(text), text).not.toBeNull();
    const notMonths = ['Junk 3 2026', 'Marching 3 2026', '3 Decimal 2026', 'Mayhem 3 2026'];
    for (const text of notMonths) expect(parseDate(text), text).toBeNull();
  });
});

describe('control characters in a cell', () => {
  it('stay in text and are ignored where the cell is read as a number, date, status or priority', () => {
    const columns = ['Number', 'Question', 'Received', 'Status', 'Priority'];
    const rows = [['12\u0000', 'Q\u0007text', '2026-09-30\u0000', 'Open\u0000', 'High\u0007']];
    const [row] = prepareImport(rows, suggestMapping(columns)).rows;
    expect(row).toMatchObject({ n: 12, text: 'Q\u0007text', received: '2026-09-30', status: 'open', priority: 'High' });
  });

  it('names an unreadable date as the cell holds it, spaces included', () => {
    const m = suggestMapping(['Question', 'Received']);
    const p = prepareImport([['Datum', ' Feb 31, 2026 ']], m);
    expect(p.unread).toEqual(['Row 2 Received:  Feb 31, 2026 ']);
  });
});
