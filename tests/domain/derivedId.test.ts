// Ids made from what a record is.
import { describe, it, expect } from 'vitest';
import { derivedId } from '../../src/domain/derivedId';
import { QuestionId, FindingId } from '../../src/domain/model';

describe('derivedId', () => {
  it('is the same for the same parts, passes the id check, and differs when any part does', () => {
    const a = derivedId('q', ['d_1', '4', 'lender a', 'what is the revenue']);
    expect(a).toBe(derivedId('q', ['d_1', '4', 'lender a', 'what is the revenue']));
    expect(QuestionId.safeParse(a).success).toBe(true);
    expect(FindingId.safeParse(derivedId('f', ['x'])).success).toBe(true);
    expect(new Set([a, derivedId('q', ['d_2', '4', 'lender a', 'what is the revenue']), derivedId('q', ['d_1', '5', 'lender a', 'what is the revenue']),
      derivedId('q', ['d_1', '4', 'lender b', 'what is the revenue']), derivedId('q', ['d_1', '4', 'lender a', 'what is the margin'])]).size).toBe(5);
    expect(derivedId('q', ['ab', 'c'])).not.toBe(derivedId('q', ['a', 'bc']));       // the NUL keeps parts apart
  });
  it('spreads over its range: 20,000 ids, no two alike', () => {
    const ids = new Set(Array.from({ length: 20_000 }, (_, i) => derivedId('q', ['d', String(i)])));
    expect(ids.size).toBe(20_000);
  });
});
