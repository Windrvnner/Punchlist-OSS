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
  const count = new Map<string, number>();
  countInto(count, text);
  return mostUsed(count, n);
}
/** add the words of some text to a running count: a text counted a piece at a time gives the list of the whole */
export function countInto(count: Map<string, number>, text: string): void {
  for (const w of wordsIn(text)) count.set(w, (count.get(w) ?? 0) + 1);
}
/** the `n` most used words of a count, most used first, equally used ones in the order of the alphabet */
export function mostUsed(count: Map<string, number>, n = 30): string[] {
  return [...count].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n).map(([w]) => w);
}

/**
 * A text as the words a search compares: split wherever a name is split, so that a file is found however it was
 * named. "Power-Purchase-Agreement_executed", "PowerPurchaseAgreement" and "power purchase agreement" give the same
 * words; "O&M" is one word, "om"; letters of any alphabet and digits are kept. Nothing is left out here for being
 * short or common: that is for whoever compares.
 */
export function tokens(text: string): string[] {
  return text.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2').toLowerCase()
    .replace(/(^|[^\p{L}\p{N}])(\p{L})\s*&\s*(\p{L})(?![\p{L}\p{N}])/gu, '$1$2$3').match(/[\p{L}\p{N}]+/gu) ?? [];
}
/** a word as a search compares it: a plural and its singular are one word */
export const fold = (w: string) => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
