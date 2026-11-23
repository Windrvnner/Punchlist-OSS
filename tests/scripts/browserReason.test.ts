// @vitest-environment node
// How the browser runner reads a suite's output: its summary, and why a suite ended without one (#157, #163).
import { describe, it, expect } from 'vitest';
import { noResultReason, summaryOf } from '../../scripts/browser-reason.mjs';

describe('a browser suite that ends without a summary', () => {
  it('reads the last positive summary, and no summary as invalid', () => {
    expect(summaryOf('PASS a\n3/4 passed\n')).toEqual({ passed: 3, total: 4, valid: true });
    expect(summaryOf('PASS a\n').valid).toBe(false);
    expect(summaryOf('0/0 passed\n').valid).toBe(false);
  });

  it('names an exit with no summary, whether the server served the build, and the last lines', () => {
    const reason = noResultReason(0, null, 'PASS boots\nlast words\n', true);
    expect(reason).toBe('exit 0; server up; last lines: PASS boots | last words');
  });

  it('names a kill by signal and a lost server', () => {
    expect(noResultReason(null, 'SIGKILL', 'step 1\n', false)).toBe('signal SIGKILL; server down; last lines: step 1');
  });

  it('says when the suite printed nothing', () => {
    expect(noResultReason(1, null, '\n  \n', true)).toBe('exit 1; server up; last lines: no output');
  });
});
