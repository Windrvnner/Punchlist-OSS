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
