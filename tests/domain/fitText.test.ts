import { describe, it, expect } from 'vitest';
import { fitText, fitParas, TEXT_MAX } from '../../src/domain/importExport';
import { Source } from '../../src/domain/model';

describe('text cut to fit one Excel cell', () => {
  it('is returned whole while it fits', () => {
    expect(fitText('short')).toBe('short');
    expect(fitParas(['a', 'b'])).toEqual(['a', 'b']);
  });
  it('ends with a visible note, and never runs over the cell', () => {
    const cut = fitText('word. '.repeat(10_000));
    expect(cut.length).toBeLessThanOrEqual(TEXT_MAX);
    expect(cut).toMatch(/\[cut: longer than Excel allows in one cell\]$/);
    expect(fitText('x'.repeat(500), 10).length).toBeLessThanOrEqual(10);
  });
  it('keeps a nearly full paragraph, cut with the note, when no room is left for the next', () => {
    const out = fitParas(['a'.repeat(TEXT_MAX - 20), 'b'.repeat(500)]);
    expect(out).toHaveLength(1);
    expect(out[0].startsWith('aaaa')).toBe(true);
    expect(out.join('\n\n').length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out[0]).toMatch(/\[cut: longer/);
  });
  it('cuts the paragraph that does not fit and ends it with the note', () => {
    const out = fitParas(['first', 'x. '.repeat(20_000)]);
    expect(out[0]).toBe('first');
    expect(out.join('\n\n').length).toBeLessThanOrEqual(TEXT_MAX);
    expect(out[1]).toMatch(/\[cut: longer/);
  });
});

describe('a source quote', () => {
  it('is kept whole up to one Excel cell', () => {
    const source = { doc: 'Lease', loc: 'p. 3', docId: 'd1', quote: 'q'.repeat(5_000) };
    expect(Source.safeParse(source).success).toBe(true);
  });
});
