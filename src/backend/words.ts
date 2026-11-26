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
  const count = new Map<string, number>();
  countInto(count, text);
  return mostUsed(count, n);
}
/** add the words of some text to a running count: a text counted a piece at a time gives the list of the whole */
export function countInto(count: Map<string, number>, text: string): void {
  for (const w of indexWords(text)) count.set(w, (count.get(w) ?? 0) + 1);
}
/** the `n` most used words of a count, most used first, equally used ones in the order of the alphabet */
export function mostUsed(count: Map<string, number>, n = 30): string[] {
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([w]) => w);
}

// the words the index keeps are the app's own words too (#1218), so they are defined in the domain
export { tokens, fold, indexWords } from '../domain/words';
