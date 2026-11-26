/**
 * The words the search index keeps, shared by the backend's index and by the app's keyword matches (#1218): a text is
 * split wherever a name is split, the control file's filler words are left out, and a plural and its singular are one
 * word. Nothing is left out for being short, a letter, or a number.
 */
import { control } from '../control';

/** the control file's filler words, in lower case: the words every sentence has */
const INDEX_FILLER = new Set(control.lists.indexFiller.map((w) => w.toLowerCase()));

/**
 * A text as the words a search compares: split wherever a name is split, so that a file is found however it was
 * named. "Power-Purchase-Agreement_executed", "PowerPurchaseAgreement" and "power purchase agreement" give the same
 * words; "O&M" is one word, "om"; letters of any alphabet, their marks (vowel signs, accents) and digits are kept.
 * Nothing is left out here for being short or common: that is for whoever compares.
 */
export function tokens(text: string): string[] {
  const camelCase = /([\p{Ll}\p{N}]\p{M}*)(\p{Lu})/gu;
  const acronymThenWord = /(\p{Lu})(\p{Lu}\p{Ll})/gu;
  const letterAmpersandLetter = /(^|[^\p{L}\p{M}\p{N}])(\p{L})\s*&\s*(\p{L})(?![\p{L}\p{M}\p{N}])/gu;
  return text.replace(camelCase, '$1 $2').replace(acronymThenWord, '$1 $2').toLowerCase()
    .replace(letterAmpersandLetter, '$1$2$3').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

/** a word as a search compares it: a plural and its singular are one word */
export function fold(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** A text's words as the word index keeps them, in order: split by `tokens`, filler left out, plurals folded. */
export function indexWords(text: string, filler = INDEX_FILLER): string[] {
  return tokens(text).filter((w) => !filler.has(w)).map(fold);
}
