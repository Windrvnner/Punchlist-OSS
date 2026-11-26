// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtDate, shownDate } from '../../src/ui/hooks';

/** The previous formatter is the output oracle, including its permissive Date parsing (#324). */
function previousDate(ymd: string): string {
  if (!ymd) return '';
  const date = new Date(ymd + 'T12:00:00');
  return isNaN(+date) ? '' : date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('calendar date formatting (#324)', () => {
  it.each<[string, number]>([
    ['UTC', 0], ['America/New_York', 240], ['Pacific/Kiritimati', -840], ['Etc/GMT+12', 720],
  ])('keeps the previous strings in %s', (zone, offset) => {
    vi.stubEnv('TZ', zone);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
    expect(new Date().getTimezoneOffset()).toBe(offset);
    for (const value of [
      '', 'not-a-date', '2026-13-01', '2026-06-15', '2025-12-31', '2024-02-29',
      '2026-02-30', '0000-01-01', '0001-01-01', '0099-12-31', '0100-01-01',
    ]) {
      expect(fmtDate(value), value).toBe(previousDate(value));
    }
  });

  it('chooses the year again after local New Year', () => {
    vi.stubEnv('TZ', 'America/New_York');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T04:59:59Z'));
    expect(fmtDate('2026-12-31')).toBe('Dec 31');
    expect(fmtDate('2027-01-01')).toBe('Jan 1, 2027');
    vi.setSystemTime(new Date('2027-01-01T05:00:00Z'));
    expect(fmtDate('2026-12-31')).toBe('Dec 31, 2026');
    expect(fmtDate('2027-01-01')).toBe('Jan 1');
  });

  it('follows a changed local zone without changing a calendar day', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T00:30:00Z'));
    for (const zone of ['America/New_York', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      vi.stubEnv('TZ', zone);
      expect(fmtDate('2026-12-31')).toBe(previousDate('2026-12-31'));
      expect(fmtDate('2027-01-01')).toBe(previousDate('2027-01-01'));
    }
  });

  it('keeps normalization when a whole local calendar day was skipped', () => {
    vi.stubEnv('TZ', 'Pacific/Apia');
    expect(new Date('2011-12-30T12:00:00').getDate()).toBe(31);
    expect(fmtDate('2011-12-30')).toBe(previousDate('2011-12-30'));
  });

  it('keeps a valid local day at the edge of Date even when UTC midnight is outside its range', () => {
    vi.stubEnv('TZ', 'Etc/GMT+12');
    const value = '-271821-04-19';
    expect(+new Date(value + 'T12:00:00')).toBe(-8_640_000_000_000_000);
    expect(fmtDate(value)).toBe(previousDate(value));
  });
});

describe('shownDate (#1022)', () => {
  it('formats a real date and shows typed text exactly as written', () => {
    expect(shownDate('2026-11-12')).toBe(fmtDate('2026-11-12'));
    expect(shownDate('11/02/2026')).toBe('11/02/2026');
    expect(shownDate('Nov-ish')).toBe('Nov-ish');
    expect(shownDate('')).toBe('');
  });
});
