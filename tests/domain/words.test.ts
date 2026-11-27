import { describe, it, expect } from 'vitest';
import { indexWords, tokens, fold } from '../../src/domain/words';

describe('the words the search index keeps, shared by the app and the backend (#1218)', () => {
  it('keeps numbers and words of any length, as the index does', () => {
    expect(indexWords('EPC DSCR O&M 2027 Q3 B2')).toEqual(['epc', 'dscr', 'om', '2027', 'q3', 'b2']);
  });
  it('leaves out the index filler (the control file’s list), and folds a plural into its singular', () => {
    expect(indexWords('The agreements and the policies of the sponsor')).toEqual(['agreement', 'policy', 'sponsor']);
  });
  it('splits a name as the index splits it', () => {
    expect(tokens('Power-Purchase-Agreement_executed')).toEqual(['power', 'purchase', 'agreement', 'executed']);
    expect(fold('agreements')).toBe('agreement');
  });
});

describe('tokens split on letters and numbers alone, as the search index does (#1379)', () => {
  it('ends a word at a combining mark, while a composed letter stays in its word', () => {
    expect(tokens('cafe\u0301')).toEqual(['cafe']);
    expect(tokens('caf\u00e9')).toEqual(['caf\u00e9']);
    expect(tokens('दिन')).toEqual(['द', 'न']);
  });
});
