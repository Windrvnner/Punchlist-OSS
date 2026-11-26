import { describe, it, expect } from 'vitest';
import { askedMatcher, reaches } from '../../src/domain/askedMatch';

const q = (n: number, text: string) => ({ id: 'q' + n, n, text });
const GAP = 'Insurance advisor report (final)';

describe('the open question that most likely asks what an unresolved point lacks (#1218)', () => {
  it('counts the point’s telling words that the question names, and the point’s telling words in all', () => {
    const full = q(1, 'Has the insurance advisor issued its final report yet?');
    expect(askedMatcher([full])(GAP)).toEqual({ q: full, shared: 4, total: 4, confidence: 100 });
    const part = q(2, 'Please send the insurance advisor report.');
    expect(askedMatcher([part])(GAP)).toEqual({ q: part, shared: 3, total: 4, confidence: 75 });
  });
  it('names the best-covering question, the lower number when two cover the point equally', () => {
    const a = q(3, 'Insurance advisor report?');
    const b = q(2, 'Insurance advisor report, please.');
    const best = q(5, 'Insurance advisor final report?');
    expect(askedMatcher([a, b, best])(GAP)?.q.n).toBe(5);
    expect(askedMatcher([a, b])(GAP)?.q.n).toBe(2);
  });
  it('names nothing when no telling word is shared, or the point has none', () => {
    const other = q(7, 'Provide the insurance certificates for the construction period.');
    expect(askedMatcher([other])('Lock-up ratio')).toBeUndefined();
    expect(askedMatcher([other])('and the of')).toBeUndefined();
    expect(askedMatcher([])(GAP)).toBeUndefined();
  });
  it('counts the words the search index keeps: DSCR, EPC, O&M and numbers all count, whatever their length', () => {
    const asks = q(1, 'Is the DSCR lock-up in the EPC contract, with O&M reserves, after 2027?');
    for (const word of ['DSCR', 'EPC', 'O&M', '2027']) {
      expect(askedMatcher([asks])(word)).toMatchObject({ shared: 1, total: 1, confidence: 100 });
    }
    expect(askedMatcher([asks])('DSCR EPC O&M 2027 sculpting')).toMatchObject({ shared: 4, total: 5, confidence: 80 });
  });
  it('leaves out the index filler and folds plurals, as the index does', () => {
    const asks = q(1, 'Please send the executed agreements.');
    expect(askedMatcher([asks])('the agreement of the')).toMatchObject({ shared: 1, total: 1 });
    expect(askedMatcher([asks])('the of and')).toBeUndefined();
  });
  it('a short point whose every word a long question names is 100 percent, and no minimum is set', () => {
    const long = q(1, 'Please describe the insurance programme: the advisor’s report, the broker and more.');
    expect(askedMatcher([long])('Insurance advisor')).toMatchObject({ shared: 2, total: 2, confidence: 100 });
  });
  it('reaches a cutoff by whole numbers: shared x 100 against cutoff x total, with no rounding', () => {
    const third = { shared: 1, total: 3 };
    expect([33, 34].map((cutoff) => reaches(third, cutoff))).toEqual([true, false]);
    const threeQuarters = { shared: 3, total: 4 };
    expect([0, 75, 76, 100].map((cutoff) => reaches(threeQuarters, cutoff))).toEqual([true, true, false, false]);
    expect(reaches({ shared: 4, total: 4 }, 100)).toBe(true);
    expect(reaches({ shared: 99, total: 100 }, 100)).toBe(false);
  });
});
