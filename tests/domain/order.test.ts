import { describe, expect, it } from 'vitest';
import { alphabetical, byName, workstreamChoices } from '../../src/domain/order';
import { WORKSTREAMS } from '../../src/domain/model';

describe('the order of a list a person picks from', () => {
  it('is A to Z as a person reads it: case and accents aside, numbers by value', () => {
    expect(alphabetical(['Wind', 'battery storage', 'Éolien', 'Phase 10', 'Phase 2', 'LNG', 'data centers']))
      .toEqual(['battery storage', 'data centers', 'Éolien', 'LNG', 'Phase 2', 'Phase 10', 'Wind']);
  });

  it('lists each name once and leaves blanks to the caller, who puts its "No …" option last', () => {
    expect(alphabetical(['Legal', '', '  ', 'Legal', 'Tax'])).toEqual(['Legal', 'Tax']);
  });

  it('keeps names that differ only in case in one fixed order, whatever order they came in', () => {
    expect(alphabetical(['legal', 'Legal'])).toEqual(alphabetical(['Legal', 'legal']));
    expect(byName('Legal', 'legal')).not.toBe(0);
  });

  it('puts the app’s workstreams and any a record brought in one A to Z list', () => {
    const ws = workstreamChoices(['Permitting', 'accounting', '', 'Legal']);
    expect(ws).toEqual(['accounting', 'Antitrust & FDI', 'Commercial', 'Compliance', 'Environmental & social', 'Financial', 'HR & benefits', 'Insurance', 'IT & cyber', 'Legal', 'Permitting', 'Real estate', 'Regulatory & permits', 'Structure', 'Tax', 'Technical']);
    expect(workstreamChoices()).toHaveLength(WORKSTREAMS.length);
  });

  it('sorts 2,000 names from 30 parties at once', () => {
    const names = Array.from({ length: 2000 }, (_, i) => `Lender ${(i * 7919) % 30}`);
    const out = alphabetical(names);
    expect(out).toHaveLength(30);
    expect(out.slice(0, 4)).toEqual(['Lender 0', 'Lender 1', 'Lender 2', 'Lender 3']);
    expect(out.at(-1)).toBe('Lender 29');
  });
});
