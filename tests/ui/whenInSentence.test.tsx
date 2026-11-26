// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { whenInSentence } from '../../src/ui/hooks';

describe('a "when" in the middle of a sentence', () => {
  afterEach(() => vi.useRealTimers());
  it('is lower case for "just now" and "days ago", and keeps a date as a date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    expect(whenInSentence('2026-11-26T11:59:50Z')).toBe('just now');
    expect(whenInSentence('2026-11-23T12:00:00Z')).toBe('3 days ago');
    expect(whenInSentence('2026-11-16T12:00:00Z')).toBe('Nov 16');
  });
});
