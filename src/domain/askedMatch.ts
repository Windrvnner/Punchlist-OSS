/**
 * Which open question most likely asks for what an unresolved point lacks (#1218). Only code: the point is matched to a
 * question by the telling words they share (tellingWords.ts), and the share is the confidence that the app's
 * `limits.askedCutoff` is compared with before a model is asked to check the pair.
 */
import { tellingWords, wordsOf } from './tellingWords';

type Matchable = { id: string; n: number; text: string };

/**
 * For many texts against the same questions: the questions are indexed by word once, so each text looks only at the
 * questions sharing a word with it (2,000+ open questions against hundreds of checklist points). Gives each question
 * that shares a telling word with the text, with how many it shares.
 */
export function sharedWith<Q extends Matchable>(
  questions: Q[],
): (text: string) => Map<Q, number> {
  const byWord = new Map<string, Q[]>();
  for (const q of questions) {
    for (const w of wordsOf(q)) {
      const list = byWord.get(w);
      if (list) list.push(q);
      else byWord.set(w, [q]);
    }
  }
  return (text) => {
    const shared = new Map<Q, number>();
    for (const w of tellingWords(text)) for (const q of byWord.get(w) ?? []) shared.set(q, (shared.get(q) ?? 0) + 1);
    return shared;
  };
}

/** How many of a point's telling words a question names, and how many the point has. */
export type Share = { shared: number; total: number };
export type Asked<Q> = Share & { q: Q; confidence: number };

/**
 * Whether a share reaches a cutoff percent, in whole numbers: shared x 100 is at least cutoff x total. No rounding
 * decides it: 3 of 4 words reaches 75 and not 76.
 */
export const reaches = ({ shared, total }: Share, cutoff: number) => shared * 100 >= cutoff * total;

/**
 * The open question that names the largest share of the point's telling words, with that share as a whole percent
 * (rounded down, for display), or nothing when none is shared. Of equal shares the lower question number wins. The
 * point's telling words are those of its wording and what it needs; a point with none has no match.
 */
export function askedMatcher<Q extends Matchable>(questions: Q[]): (text: string) => Asked<Q> | undefined {
  const sharing = sharedWith(questions);
  return (text) => {
    let best: { q: Q; shared: number } | undefined;
    for (const [q, shared] of sharing(text)) {
      if (!best || shared > best.shared || (shared === best.shared && q.n < best.q.n)) best = { q, shared };
    }
    if (!best) return undefined;
    const total = tellingWords(text).size;
    return { ...best, total, confidence: Math.floor((100 * best.shared) / total) };
  };
}
