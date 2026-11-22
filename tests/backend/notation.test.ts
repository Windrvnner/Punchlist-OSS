// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { notation } from '../../src/backend/ai';

describe('LaTeX-style notation in an answer (plain symbols are fine)', () => {
  it('a calculation in words with plain symbols has none', () => {
    for (const t of ['CFADS divided by debt service: 41.2m ÷ 31.2m = 1.32x', 'Revenue of $41.2m against $31.2m of debt service, so 1.32x.', 'The DSCR (CFADS / debt service) is 1.32x, above the 1.20x lock-up.', 'x² is fine, so is 10%.', 'file_name.xlsx, Sheet!B12', '']) expect(notation(t), t).toEqual([]);
  });
  it('a calculation in plain symbols alone, not written out in words, has none', () => {
    for (const t of ['CFADS / debt service = 41.2m / 31.2m = 1.32x', '41.2 * 0.8 = 32.96', '120 + 35 − 15 = 140', '$41.2m ÷ $31.2m = 1.32x', '12% × 40m = 4.8m', '2^3 = 8', 'DSCR_min = 1.20x']) expect(notation(t), t).toEqual([]);
  });
  it('flags commands, formulas between dollars, \\( \\) and \\[ \\], and braced super- and subscripts', () => {
    expect(notation('DSCR = \\frac{41.2}{31.2} = 1.32\\times')).toEqual(['\\frac{41.2}{31.2}', '\\times']);
    expect(notation('So $\\text{DSCR} = 1.32$ and $$a=b$$.')).toEqual(['$$a=b$$', '$\\text{DSCR} = 1.32$', '\\text{DSCR}']);
    expect(notation('Inline \\( x \\) and display \\[ y \\]')).toEqual(['\\(', '\\)', '\\[', '\\]']);
    expect(notation('Growth of x^{2} with DSCR_{min} at 1.2')).toEqual(['x^{2}', 'DSCR_{min}']);
  });
});
