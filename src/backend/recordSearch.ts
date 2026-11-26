/**
 * The chat's search of the records the app holds (findings and the Q&A log): ranked by the same BM25 keyword scoring
 * as documents (wordIndex.ts `bm25`), with each record's words counted as the index counts a document's, and any
 * ranking cut into pages of one size (#1102).
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
 * Page `page` (from 1) of a ranking of groups, `size` items a page, with no group split between pages: a group that
 * does not fit on the page under way starts the next one, and one larger than a page has a page of its own. A
 * blackline and its clean draft are one group, read together (#1102).
 */
export function pageOfGroups<T>(groups: T[][], page: number, size: number): Page<T> {
  const pages: T[][] = [];
  for (const group of groups) {
    const last = pages.at(-1);
    if (last && last.length + group.length <= size) last.push(...group);
    else pages.push([...group]);
  }
  const total = groups.reduce((sum, g) => sum + g.length, 0);
  return { items: pages[page - 1] ?? [], page, pages: pages.length, total };
}

/** page `page` (from 1) of a ranking, `size` a page; a page past the last has no items */
export function pageOf<T>(ranked: T[], page: number, size: number): Page<T> {
  const items = ranked.slice((page - 1) * size, page * size);
  return { items, page, pages: Math.ceil(ranked.length / size), total: ranked.length };
}
