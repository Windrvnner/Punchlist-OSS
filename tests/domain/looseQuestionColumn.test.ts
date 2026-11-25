import { describe, expect, it } from 'vitest';
import { findHeaderRow, suggestMapping } from '../../src/domain/importExport';

describe('the question column read from plain words, with no model (#1002)', () => {
  it('takes a heading that names the question with other words around it', () => {
    expect(suggestMapping(['Ref', 'Diligence Question', 'Response']).text).toBe(1);
    expect(suggestMapping(['No.', 'Information Request', 'Submitted by']).text).toBe(1);
    expect(suggestMapping(['Number', 'Question / Request', 'Answer']).text).toBe(1);
  });

  it('does not take a title spread over cells above the table, which has no other usual heading', () => {
    expect(suggestMapping(['', 'Queries', 'for', 'the sponsor']).text).toBeNull();
    expect(suggestMapping(['Diligence Question', 'Notes']).text).toBeNull();
  });

  it('does not take a heading that is about something else', () => {
    const mapping = suggestMapping(['Ref', 'Question No.', 'Request date', 'Response to question', 'Item status']);
    expect(mapping.text).toBeNull();
  });

  it('does not take a number column or a bare item heading for the question', () => {
    expect(suggestMapping(['Item #', 'Description', 'Status']).text).toBeNull();
    expect(suggestMapping(['Request #', 'Details', 'Response']).text).toBeNull();
    expect(suggestMapping(['Req. Item', 'Description', 'Status']).text).toBeNull();
  });

  it('leaves a heading with any other word to the model', () => {
    for (const heading of ['Question Type', 'Question Comments', 'Request Due', 'Request Sent', 'Query Resolution',
      'Question Follow-up', 'Question Source', 'Request Reason', 'Question Contact', 'Question Log']) {
      expect(suggestMapping(['No.', heading, 'Description', 'Status']).text).toBeNull();
    }
  });

  it('keeps a real header row ahead of a title row that has a question word and a usual name', () => {
    const header = ['No.', 'Question', 'Response'];
    expect(findHeaderRow([['Q&A Request List', 'Status'], header])).toBe(1);
    expect(findHeaderRow([['Question Log', 'Date'], header])).toBe(1);
    expect(findHeaderRow([['No.', 'Lender Questions', 'Status'], ['1', 'Is it fixed price?', 'Open']])).toBe(0);
  });

  it('keeps an exact heading ahead of a loose one', () => {
    expect(suggestMapping(['Diligence Question', 'Question']).text).toBe(1);
  });

  it('is not fooled by a title row above a log of 2,000 questions', () => {
    const rows: string[][] = [
      ['Request list for the solar portfolio'],
      [''],
      ['No.', 'Diligence Question', 'Submitted by', 'Response'],
      ...Array.from({ length: 2000 }, (_, k) => [String(k + 1), `Please provide the permit ${k + 1} status`, 'Lender', '']),
    ];
    expect(findHeaderRow(rows)).toBe(2);
    expect(suggestMapping(rows[2]).text).toBe(1);
  });
});
