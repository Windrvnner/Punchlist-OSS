// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { whenInSentence } from '../../src/ui/hooks';

// Dates are built from local time so the test holds in every time zone
const local = (month: number, day: number, hour = 12, min = 0, sec = 0) =>
  new Date(2026, month, day, hour, min, sec);

describe('a "when" in the middle of a sentence', () => {
  afterEach(() => vi.useRealTimers());
  it('is lower case for "just now" and "days ago", and keeps a date as a date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(local(10, 26));
    expect(whenInSentence(local(10, 26, 11, 59, 50).toISOString())).toBe('just now');
    expect(whenInSentence(local(10, 23).toISOString())).toBe('3 days ago');
    expect(whenInSentence(local(10, 16).toISOString())).toBe('Nov 16');
  });
});
