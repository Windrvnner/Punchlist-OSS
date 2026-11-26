/**
 * Which open questions an answer may address (the suggested open question). Only a suggestion: a person
 * reads it and decides; nothing here changes a question. It asks no model: an answer is matched to a question by the
 * telling words they share, words that any diligence text uses not counting. A question must share at least MIN_SHARED
 * of them, and at least a third of its own, so a passing mention of one subject is not taken for an answer.
 */
import { sharedWith } from './askedMatch';
import { tellingWords, wordsOf } from './tellingWords';

export { tellingWords };
export const MIN_SHARED = 3;

/** mayAddress for many texts against the same questions */
export function addresser<Q extends { id: string; n: number; text: string }>(questions: Q[]): (text: string) => Q[] {
  const sharing = sharedWith(questions);
  return (text) => [...sharing(text)]
    .filter(([q, n]) => n >= MIN_SHARED && n / wordsOf(q).size >= 1 / 3)
    .sort(([a, x], [b, y]) => y - x || a.n - b.n)
    .map(([q]) => q);
}

/** The questions the text may address, the likeliest first; ties go to the lower number. */
export function mayAddress<Q extends { id: string; n: number; text: string }>(text: string, questions: Q[]): Q[] {
  return addresser(questions)(text);
}

/**
 * The questions a person is choosing from, narrowed as they type (picked from a list, never a number
 * typed from memory). "12", "Q12" or "q 12" puts Q12 first, then the questions whose number starts with it, then
 * those whose text has it. Words keep the questions that have every one of them, in number or text. Otherwise in
 * order of number; nothing typed keeps them all.
 */
export function findQuestions<Q extends { n: number; text: string }>(typed: string, questions: Q[]): Q[] {
  const all = [...questions].sort((a, b) => a.n - b.n);
  const t = typed.trim().toLowerCase(); if (!t) return all;
  const num = /^q?\s*(\d+)$/.exec(t)?.[1];
  if (num) {
    const rank = (q: Q) => (String(q.n) === num ? 0 : String(q.n).startsWith(num) ? 1 : q.text.includes(num) ? 2 : 3);
    return all.filter((q) => rank(q) < 3).sort((a, b) => rank(a) - rank(b) || a.n - b.n);
  }
  const words = t.split(/\s+/);
  return all.filter((q) => { const hay = `q${q.n} ${q.text.toLowerCase()}`; return words.every((w) => hay.includes(w)); });
}
