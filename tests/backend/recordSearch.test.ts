// @vitest-environment node
/**
 * The chat's search of the records the app holds, ranked by the document search's own BM25 keyword scoring and cut into
 * pages of one size (#1102), at deal scale.
 */
import { describe, it, expect } from 'vitest';
import { rankRecords, pageOf } from '../../src/backend/recordSearch';
import { tokens, fold } from '../../src/backend/words';

/** a query's words as a search compares them */
const q = (t: string) => new Set(tokens(t).map(fold));
type Row = { n: number; text: string };
/** 2,500 questions: 40 on the lock-up ratio, 400 on another ratio, one on 2027, the rest on permits */
const log: Row[] = Array.from({ length: 2_500 }, (_v, i) => {
  if (i < 40) return { n: i + 1, text: `Confirm the lock-up ratio for period ${i}` };
  if (i < 440) return { n: i + 1, text: `Provide the coverage ratio workings ${i}` };
  if (i === 440) return { n: i + 1, text: 'Confirm the commercial operation date of 2027' };
  return { n: i + 1, text: `Provide permit ${i}` };
});
const text = (r: Row) => r.text;

describe('rankRecords', () => {
  it('ranks 2,500 questions by BM25: rarer words first, nothing that shares no word', () => {
    const got = rankRecords(log, q('lock-up ratio'), text);
    expect(got.slice(0, 40).every((r) => r.text.includes('lock-up'))).toBe(true);
    expect(got).toHaveLength(440);
    expect(got.some((r) => r.text.startsWith('Provide permit'))).toBe(false);
  });
  it('keeps the order given among equal scores', () => {
    const got = rankRecords(log, q('lock-up'), text);
    expect(got.map((r) => r.n)).toEqual(Array.from({ length: 40 }, (_v, i) => i + 1));
  });
  it('finds a record by a number it holds', () => {
    // Q441 says 2027, and so does permit 2027 (Q2028)
    expect(rankRecords(log, q('2027'), text).map((r) => r.n).sort((a, b) => a - b)).toEqual([441, 2028]);
  });
  it('finds nothing for a query with no word to look for', () => {
    expect(rankRecords(log, new Set(), text)).toEqual([]);
  });
  it('ranks 2,500 questions in well under a second', () => {
    const t0 = performance.now();
    rankRecords(log, q('lock-up ratio permit'), text);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('pageOf', () => {
  const forty = Array.from({ length: 40 }, (_v, i) => i);
  const short = (x: number) => `row ${x}`;
  it('gives 25, then the last 15, then none', () => {
    expect(pageOf(forty, 1, 25, 24_000, short)).toEqual({ items: forty.slice(0, 25), page: 1, pages: 2, total: 40 });
    expect(pageOf(forty, 2, 25, 24_000, short)).toEqual({ items: forty.slice(25), page: 2, pages: 2, total: 40 });
    expect(pageOf(forty, 3, 25, 24_000, short)).toEqual({ items: [], page: 3, pages: 2, total: 40 });
  });
  it('counts no pages when nothing matched', () => {
    expect(pageOf([], 1, 25, 24_000, short)).toEqual({ items: [], page: 1, pages: 0, total: 0 });
  });
  it('lists only the rows that fit in the text bound, and the rest on the next pages, each row whole', () => {
    const long = (x: number) => `row ${x} ${'response '.repeat(1_000)}`;                   // about 9,000 characters
    const first = pageOf(forty, 1, 25, 24_000, long);
    expect(first.items).toEqual([0, 1]);
    expect(first.pages).toBe(20);
    expect(pageOf(forty, 20, 25, 24_000, long).items).toEqual([38, 39]);
  });
  it('gives a row longer than the bound a page of its own, whole', () => {
    const rows = [0, 1, 2];
    const line = (x: number) => (x === 1 ? 'x'.repeat(30_000) : `row ${x}`);
    expect([1, 2, 3].map((n) => pageOf(rows, n, 25, 24_000, line).items)).toEqual([[0], [1], [2]]);
  });
});
