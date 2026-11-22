// A workstream the model proposes for a finding comes only from the firm's list, or is left blank.
import { describe, it, expect } from 'vitest';
import { workstreamOf } from '../../src/backend/ai';

describe('the workstream a model proposes', () => {
  it('is taken from the firm\'s list in its spelling, and left blank when it is anything else', () => {
    expect(workstreamOf('Legal')).toBe('Legal');
    expect(workstreamOf('  environmental & SOCIAL ')).toBe('Environmental & social');
    expect(workstreamOf('Regulatory')).toBe(''); expect(workstreamOf('')).toBe(''); expect(workstreamOf(undefined)).toBe(''); expect(workstreamOf(3)).toBe('');
  });
});
