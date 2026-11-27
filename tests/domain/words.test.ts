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

