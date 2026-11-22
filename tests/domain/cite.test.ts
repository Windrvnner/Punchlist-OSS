import { describe, it, expect } from 'vitest';
import { splitCited } from '../../src/domain/cite';

const flat = (t: string, n = 3) => splitCited(t, n).map((p) => [p.text, p.refs]);
describe('citation markers', () => {
  it('a marker supports the sentence before it, never the one after', () => {
    expect(flat('The draft sets the lock-up at 1.25x. [1] The signed term sheet has 1.30x. [2]')).toEqual([
      ['The draft sets the lock-up at 1.25x.', [1]], [' ', []], ['The signed term sheet has 1.30x.', [2]],
    ]);
  });
  it('no part is ever empty, and the text reads the same with the markers removed', () => {
    for (const t of ['One. [1] Two. [2]', 'One [1]. Two [2].', 'No markers at all. None.', '[1] Starts with a marker.', 'Ends with two. [1][2]', 'A; b. [3] c', 'Trailing space. [1]  ', '']) {
      const parts = splitCited(t, 3);
      expect(parts.every((p) => p.text.length > 0)).toBe(true);
      expect(parts.map((p) => p.text).join('').replace(/\s+/g, ' ').trim()).toBe(t.replace(/\s*\[\d+\]/g, '').replace(/\s+/g, ' ').trim());
    }
  });
  it('uncited sentences before a cited one stay uncited', () => {
    expect(flat('Background first. More background. The point that matters. [2] Afterthought.')).toEqual([
      ['Background first. More background. ', []], ['The point that matters.', [2]], [' Afterthought.', []],
    ]);
  });
  it('several markers in a row all support that sentence; a marker before the period means the same', () => {
    expect(flat('Both documents agree. [1][2]')).toEqual([['Both documents agree.', [1, 2]]]);
    expect(flat('Both documents agree. [1] [2] Next.')).toEqual([['Both documents agree.', [1, 2]], [' Next.', []]]);
    expect(flat('The draft sets 1.25x [1]. The term sheet has 1.30x [2].')).toEqual([['The draft sets 1.25x', [1]], ['. ', []], ['The term sheet has 1.30x', [2]], ['.', []]]);
  });
  it('a marker with nothing before it cites nothing rather than the next sentence', () => {
    expect(flat('[1] Starts with a marker.')).toEqual([[' Starts with a marker.', []]]);
  });

  describe('numbers in brackets that are not citations', () => {
    it('text with no sources is never touched', () => {
      const t = 'See clause [4] of the SFA and Schedule [12]; the amount is [100] m.';
      expect(flat(t, 0)).toEqual([[t, []]]);
    });
    it('only a number that names a source is a marker; everything else stays as written', () => {
      const t = 'The [2019] base case sets the test for the lock-up. [1]';
      expect(flat(t, 2)).toEqual([['The [2019] base case sets the test for the lock-up.', [1]]]);
      expect(flat('The ratio is 1.25x. [3]', 2)).toEqual([['The ratio is 1.25x. [3]', []]]);       // names no source: shown, not hidden
      expect(flat('Clause [0] applies. [1]', 2)).toEqual([['Clause [0] applies.', [1]]]);
      expect(splitCited('Amount [100] m. [1] Then [2] more.', 1).map((p) => p.text).join('')).toBe('Amount [100] m. Then [2] more.');
    });
    it('nothing typed is ever lost, whatever the brackets', () => {
      for (const t of ['[1, 2] and [ 1 ] and [1-2] and [a] and [] and [[1]]', 'x [9999999999999999999] y', '[1][1][1] repeated', 'A [1] B [2] C [3] D']) {
        for (const n of [0, 1, 2, 3]) {
          const kept = splitCited(t, n).map((p) => p.text).join('');
          const expected = t.replace(/\s*\[(\d+)\]/g, (m, d) => (+d >= 1 && +d <= n ? '' : m));
          expect(kept.replace(/\s+/g, ' ').trim()).toBe(expected.replace(/\s+/g, ' ').trim());
        }
      }
    });
  });

  describe('where a sentence starts', () => {
    it('an abbreviation or a decimal does not end a sentence', () => {
      expect(flat('Background. The ratio is approx. 1.25x under cl. 4.2 of the draft. [1]', 1)).toEqual([['Background. ', []], ['The ratio is approx. 1.25x under cl. 4.2 of the draft.', [1]]]);
      expect(flat('First. The term sheet (see para. 6) has 1.30x. [2]', 2)).toEqual([['First. ', []], ['The term sheet (see para. 6) has 1.30x.', [2]]]);
      expect(flat('Intro. It is set out there (see p. 6.) [1]', 1)).toEqual([['Intro. ', []], ['It is set out there (see p. 6.)', [1]]]);
      expect(flat('Proseware Inc. signed on Nov. 3, 2026 and e.g. the sponsor agreed. [1]', 1)).toEqual([['Proseware Inc. signed on Nov. 3, 2026 and e.g. the sponsor agreed.', [1]]]);
    });
    it('a sentence that starts with a number is still its own sentence', () => {
      expect(flat('The ratio is high. 2026 accounts show the same. [1]', 1)).toEqual([['The ratio is high. ', []], ['2026 accounts show the same.', [1]]]);
    });
    it('a marker in mid-sentence supports the words since the previous marker', () => {
      expect(flat('The draft [1] sets 1.25x and the term sheet [2] has 1.30x.', 2)).toEqual([['The draft', [1]], [' ', []], ['sets 1.25x and the term sheet', [2]], [' has 1.30x.', []]]);
    });
  });
});
