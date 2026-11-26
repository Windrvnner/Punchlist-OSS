/**
 * The chat's search of the records the app holds (findings and the Q&A log): ranked by the same BM25 keyword scoring
 * as documents (wordIndex.ts `bm25`), with each record's words counted as the index counts a document's, and any
 * ranking cut into pages of at most one size (#1102) that fit a folder read's text bound (#1091).
 */
import { bm25, countWords } from './wordIndex';

/** one page of a ranking: its items, its number (from 1), how many pages there are, and how many items in all */
export interface Page<T> { items: T[]; page: number; pages: number; total: number }

/**
 * The records that share a word with `q`, best first; equal scores keep the order given. A record's whole text is its
 * body: records have no name or title of their own to weigh. Rarity is counted over the records given.
 */
export function rankRecords<T>(records: T[], q: Set<string>, text: (x: T) => string): T[] {
  if (!q.size || !records.length) return [];
  const counted = records.map((x) => countWords(text(x)));
  const docsWith = new Map<string, number>();
  for (const w of q) docsWith.set(w, counted.filter((c) => c.counts.has(w)).length);
  const avgLength = counted.reduce((sum, c) => sum + c.length, 0) / records.length || 1;
  const corpus = { size: records.length, avgLength, docsWith: (w: string) => docsWith.get(w) ?? 0 };
  const none = new Set<string>();
  const entries = counted.map((c, i) => ({
    id: String(i), named: none, title: none, tf: (w: string) => c.counts.get(w) ?? 0, length: c.length,
  }));
  const scores = bm25(q, entries, corpus);
  const scored = records.map((x, i) => ({ x, score: scores.get(String(i)) ?? 0 })).filter((r) => r.score > 0);
  return scored.sort((a, b) => b.score - a.score).map((r) => r.x);
}

/**
 * page `page` (from 1) of a ranking: at most `size` records, and only as many of them as fit in `chars` characters of
 * their `line`s, as a folder read lists what fits (agentFolder.ts `FOLDER_TEXT`, #1091); the rest go on the next pages.
 * A record longer than that has a page of its own, whole. A page past the last has no items.
 */
export function pageOf<T>(ranked: T[], page: number, size: number, chars: number, line: (x: T) => string): Page<T> {
  const pages = cutPages(ranked, size, chars, line);
  return { items: pages[page - 1] ?? [], page, pages: pages.length, total: ranked.length };
}

/** a ranking cut into pages in its order: a page ends at `size` records or before the record that would pass `chars` */
function cutPages<T>(ranked: T[], size: number, chars: number, line: (x: T) => string): T[][] {
  const pages: T[][] = [];
  let used = 0;
  for (const x of ranked) {
    const length = line(x).length + 1;
    const current = pages.at(-1);
    if (current && current.length < size && used + length <= chars) {
      current.push(x);
      used += length;
    } else {
      pages.push([x]);
      used = length;
    }
  }
  return pages;
}
