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

describe('tokens keep combining marks inside words (#1154)', () => {
  it('keeps a word with vowel signs whole', () => {
    expect(tokens('दिन')).toEqual(['दिन']);
  });
  it('keeps a combining accent in its word', () => {
    expect(tokens('cafe\u0301')).toEqual(['cafe\u0301']);
  });
  it('splits an acronym from the word after it when the acronym ends in a mark', () => {
    expect(tokens('EBar')).toEqual(['e', 'bar']);
    expect(tokens('E\u0301Bar')).toEqual(['e\u0301', 'bar']);
  });
  it('splits camelCase after a mark', () => {
    expect(tokens('cafe\u0301Bar')).toEqual(['cafe\u0301', 'bar']);
    expect(tokens('caféBar')).toEqual(['café', 'bar']);
  });
  it('does not normalize: a composed and a decomposed accent are different words', () => {
    expect(tokens('caf\u00e9')).not.toEqual(tokens('cafe\u0301'));
  });
});
