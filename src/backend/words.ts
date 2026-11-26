/**
 * The words a document uses most, for finding it by a search of words. No model is involved: the text is counted on
 * this PC, and the same file always gives the same list. Words every sentence has are left out; numbers and words of
 * any length are kept, split as the word index splits them (#1147).
 */
import { indexWords } from '../domain/words';

/**
 * The `n` most used of them, plurals folded, most used first; words used equally often in the order of the
 * alphabet, so the list never depends on chance.
 */
export function topWords(text: string, n = 30): string[] {
  const count = new Map<string, number>(); for (const w of indexWords(text)) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([w]) => w);
}

// `tokens`, `fold` and `indexWords` are the app's own words too (#1218, #1220), so they live in the domain
export { tokens, fold, indexWords } from '../domain/words';
