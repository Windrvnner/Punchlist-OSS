/**
 * The words a document uses most, for finding it by a search of words. No model is involved: the text is counted on
 * this PC, and the same file always gives the same list. Words every sentence has are left out; numbers and words of
 * any length are kept, split as the word index splits them (#1147).
 */
import { control } from '../control';

/** the control file's filler words, in lower case: the words every sentence has */
const INDEX_FILLER = new Set(control.lists.indexFiller.map((w) => w.toLowerCase()));

/**
 * A text's words as the word index reads them, in order: split by `tokens`, filler words left out, plurals unfolded.
 * No word, letter or number is left out for its length (#1025, #1147).
 */
export function wordsIn(text: string, filler = INDEX_FILLER): string[] {
  return tokens(text).filter((w) => !filler.has(w));
}
/** the same words as the index keeps and compares them: a plural and its singular are one word */
export function indexWords(text: string, filler = INDEX_FILLER): string[] {
  return wordsIn(text, filler).map(fold);
}
/**
 * The `n` most used of them, plurals unfolded, most used first; words used equally often in the order of the
 * alphabet, so the list never depends on chance.
 */
export function topWords(text: string, n = 30): string[] {
  const count = new Map<string, number>(); for (const w of wordsIn(text)) count.set(w, (count.get(w) ?? 0) + 1);
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
