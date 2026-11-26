/**
 * The words a document uses most, for finding it by a search of words. No model is involved: the text is counted on
 * this PC, and the same file always gives the same list. Words every sentence has are left out, and so are numbers.
 */
import { control } from '../control';

const COMMON = new Set(control.lists.indexFiller.map((w) => w.toLowerCase()));   // the control file's list, matched against words in lower case

/** every word of some text that could be searched for: lower case, three letters or more in any alphabet, not a common word (the list is English), not a number */
export function wordsIn(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}[\p{L}'’-]*\p{L}/gu) ?? []).map((w) => w.replace(/[’']s$/, '').replace(/[’']/g, '')).filter((w) => w.length >= 3 && !COMMON.has(w));
}
/** the `n` most used of them, most used first; words used equally often in the order of the alphabet, so the list never depends on chance */
export function topWords(text: string, n = 30): string[] {
  const count = new Map<string, number>(); for (const w of wordsIn(text)) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([w]) => w);
}

// `tokens` and `fold` are the app's own words too (#1218), so they live in the domain
export { tokens, fold } from '../domain/words';
