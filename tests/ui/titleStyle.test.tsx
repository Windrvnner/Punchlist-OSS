import { describe, it, expect } from 'vitest';
import { titleStyle } from '../../src/ui/titleStyle';

// Apple's title-style capitals
describe('titleStyle', () => {
  it('capitalizes the main words and keeps short ones small', () => {
    expect(titleStyle('Submitted by')).toBe('Submitted By');
    expect(titleStyle('Gaps in the documents')).toBe('Gaps in the Documents');
    expect(titleStyle('after import')).toBe('After Import');
  });
  it('leaves words that already have capitals alone', () => {
    expect(titleStyle('Q&A log')).toBe('Q&A Log');
    expect(titleStyle('PDF')).toBe('PDF');
  });
});
