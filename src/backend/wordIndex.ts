/**
 * Each PC's own index of every word in a deal's documents. Nothing of it goes to
 * the shared folder: each PC reads the words of the files in its own copy of the data room.
 *
 * What is kept for a document: how often it uses each word of any length (filler words left out, numbers
 * kept, plurals folded, no word order), how many words it has, and its title: the first 40 words of its first page.
 * Kept in this PC's local folder as one line per document in words2-<deal id>.jsonl, written once when the document is
 * read and never changed; a later line for the same document replaces an earlier one.
 *
 * How a document answers to some words: each word counts by how rare it is in the deal (BM25's idf),
 * times 10 when it is in the document's name or folder path, 4 when it is in the title, and BM25's term weight for
 * how often the body uses it (which grows with use and levels off near 2). So a match in the name outweighs a body
 * that uses the word on every page.
 */
import type { Folder } from './logRepository';
import { indexWords } from './words';

/** BM25's usual constants: how soon repeated use levels off, and how much a long document's length is held against it */
const K1 = 1.2, B = 0.75;
/** the weights agreed for a match in the name or folder path, and in the title, against one body match */
export const WEIGHT = { name: 10, title: 4 } as const;
/** how many words of the first page make the title */
export const TITLE_WORDS = 40;

/** what the index keeps of one document's text */
export interface DocWords { counts: Map<string, number>; length: number; title: string[] }
/** Count the words of a document. `first` is its first page, when the text has pages; otherwise the text's own start is the title. */
export function countWords(text: string, first = text): DocWords {
  const counts = new Map<string, number>(); let length = 0;
  for (const w of indexWords(text)) { counts.set(w, (counts.get(w) ?? 0) + 1); length++; }
  const title: string[] = [];
  for (const w of indexWords(first)) {
    if (title.length >= TITLE_WORDS) break;
    if (!title.includes(w)) title.push(w);
  }
  return { counts, length, title };
}

/**
 * A deal's index in memory. Documents are numbered as they are read in, and each keeps its words as the line wrote them
 * (" word:count word:count "). Which documents use a word is looked up the first time that word is searched for, and
 * remembered: building that for every word at load took seconds on a large deal, and a search asks about only a few.
 * A document read again gets a new number, and its old number is marked dead and skipped.
 */
interface DealIndex { num: Map<string, number>; length: number[]; title: Set<string>[]; alive: boolean[]; words: string[]; uses: Map<string, Map<number, number>>; total: number; live: number }
interface Line { d: string; n: number; t: string; w: string }
export interface WordIndex {
  /** whether this PC has read the words of this document */
  has(dealId: string, docId: string): boolean;
  /** keep a document's words; said again for a document already kept, it replaces them */
  add(dealId: string, docId: string, words: DocWords): void;
  /**
   * How well each document answers to the words `q` (already as a search compares them), for every document given.
   * `named` is each document's name and folder path as words. A document the index has not read is scored on its name alone.
   * With `namedOnly`, every document is scored on `named` alone, each word still weighed by how rare it is in the deal.
   */
  score(dealId: string, q: Set<string>, docs: { docId: string; named: Set<string> }[], namedOnly?: boolean): Map<string, number>;
}

/** one thing scored: the words of its name, of its title, how often its body uses a word, and its length in words */
export interface Scored {
  id: string; named: Set<string>; title: Set<string>; tf: (w: string) => number; length: number;
}
/** what rarity and length are measured against: how many things there are, their mean length, how many use a word */
export interface Corpus { size: number; avgLength: number; docsWith: (w: string) => number }

/**
 * How well each thing answers to the words `q`, by BM25: each word counts by how rare it is in the corpus (its idf),
 * times `WEIGHT.name` in the name, `WEIGHT.title` in the title, and BM25's term weight for how often the body uses it.
 * The one scoring of every keyword search: documents through the index, and the findings and questions a chat searches.
 */
export function bm25(q: Set<string>, entries: Scored[], corpus: Corpus): Map<string, number> {
  const idf = new Map<string, number>();
  for (const w of q) {
    const n = corpus.docsWith(w);
    idf.set(w, Math.log(1 + (corpus.size - n + 0.5) / (n + 0.5)));
  }
  const out = new Map<string, number>();
  for (const e of entries) {
    const terms = [...q].map((w) => weightOf(e, w, corpus.avgLength) * (idf.get(w) ?? 0));
    // added smallest first, so two things with the same evidence score the same whatever order the words were asked
    // in: a tie is decided by the ranking's own tie-break, never by rounding
    out.set(e.id, terms.sort((x, y) => x - y).reduce((sum, t) => sum + t, 0));
  }
  return out;
}

/** what one word is worth in one thing before its rarity: its name, its title, and its body's use of it */
function weightOf(e: Scored, w: string, avgLength: number): number {
  let m = e.named.has(w) ? WEIGHT.name : 0;
  if (e.title.has(w)) m += WEIGHT.title;
  const tf = e.tf(w);
  if (tf) m += (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * e.length) / avgLength));
  return m;
}

export function wordIndex(local: Folder): WordIndex {
  const deals = new Map<string, DealIndex>();
  // the name carries the index's version: an index built under older rules is not read, so each document is read again
  const file = (dealId: string) => `words2-${dealId}.jsonl`;
  const put = (ix: DealIndex, l: Line) => {
    const was = ix.num.get(l.d);
    if (was !== undefined) { ix.alive[was] = false; ix.words[was] = ''; ix.total -= ix.length[was]; ix.live--; }      // a document read again: its old words go
    const k = ix.alive.length; ix.num.set(l.d, k); ix.alive.push(true); ix.length.push(l.n); ix.title.push(new Set(l.t ? l.t.split(' ') : [])); ix.words.push(` ${l.w} `); ix.total += l.n; ix.live++;
    ix.uses.clear();
  };
  /** how often each live document uses a word, by document number */
  const usesOf = (ix: DealIndex, w: string): Map<number, number> => {
    let m = ix.uses.get(w); if (m) return m;
    m = new Map(); const key = ` ${w}:`;
    for (let k = 0; k < ix.words.length; k++) { if (!ix.alive[k]) continue; const s = ix.words[k]; const i = s.indexOf(key); if (i >= 0) m.set(k, Number(s.slice(i + key.length, s.indexOf(' ', i + key.length)))); }
    ix.uses.set(w, m); return m;
  };
  /** a document as BM25 scores it: by its name alone when the index has not read it (`k` undefined) */
  const scoredOf = (ix: DealIndex, d: { docId: string; named: Set<string> }, k: number | undefined): Scored => {
    if (k === undefined) return { id: d.docId, named: d.named, title: new Set(), tf: () => 0, length: 0 };
    const tf = (w: string) => usesOf(ix, w).get(k) ?? 0;
    return { id: d.docId, named: d.named, title: ix.title[k], tf, length: ix.length[k] };
  };
  const of = (dealId: string): DealIndex => {
    let ix = deals.get(dealId); if (ix) return ix;
    ix = { num: new Map(), length: [], title: [], alive: [], words: [], uses: new Map(), total: 0, live: 0 }; deals.set(dealId, ix);
    for (const s of (local.read(file(dealId)) ?? '').split('\n')) { if (!s.trim()) continue; try { put(ix, JSON.parse(s) as Line); } catch { /* a line cut short when the PC stopped: that document is read again */ } }
    return ix;
  };
  return {
    has: (dealId, docId) => of(dealId).num.has(docId),
    add(dealId, docId, words) {
      const l: Line = { d: docId, n: words.length, t: words.title.join(' '), w: [...words.counts].map(([w, n]) => `${w}:${n}`).join(' ') };
      local.append(file(dealId), `${JSON.stringify(l)}\n`); put(of(dealId), l);
    },
    score(dealId, q, docs, namedOnly = false) {
      const ix = of(dealId);
      const corpus = { size: Math.max(ix.live, docs.length, 1), avgLength: ix.total / Math.max(ix.live, 1) || 1,
        docsWith: (w: string) => usesOf(ix, w).size };
      return bm25(q, docs.map((d) => scoredOf(ix, d, namedOnly ? undefined : ix.num.get(d.docId))), corpus);
    },
  };
}
