/**
 * Which open questions an answer may address (the suggested open question). Only a suggestion: a person
 * reads it and decides; nothing here changes a question. It asks no model: an answer is matched to a question by the
 * telling words they share, words that any diligence text uses not counting. A question must share at least MIN_SHARED
 * of them, and at least a third of its own, so a passing mention of one subject is not taken for an answer.
 */
const COMMON = new Set(['about', 'also', 'been', 'being', 'between', 'both', 'cannot', 'come', 'comes', 'confirm', 'could', 'detail', 'does', 'done', 'each', 'either', 'from', 'have', 'here', 'into', 'just', 'like', 'made', 'make', 'many', 'more', 'most', 'much', 'must', 'only', 'other', 'over', 'please', 'provide', 'same', 'should', 'show', 'some', 'such', 'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'throughout', 'under', 'upon', 'used', 'uses', 'using', 'very', 'want', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'will', 'with', 'within', 'would', 'your', 'document', 'documents', 'project', 'question', 'answer', 'response', 'closest', 'support', 'data', 'room', 'matter', 'finding', 'findings']);
export const MIN_SHARED = 3;

/** the telling words of a text: four letters or more, a plain plural taken as its singular */
export function tellingWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    const one = w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
    if (!COMMON.has(w) && !COMMON.has(one)) out.add(one);
  }
  return out;
}

/** a question's telling words, worked out once per question record (a record is replaced, never changed, so its text is fixed) */
const wordCache = new WeakMap<object, { text: string; words: Set<string> }>();
const wordsOf = (q: { text: string }) => { let c = wordCache.get(q); if (!c || c.text !== q.text) { c = { text: q.text, words: tellingWords(q.text) }; wordCache.set(q, c); } return c.words; };

/**
 * For many texts against the same questions: the questions are indexed by word once, so each text looks only at the
 * questions sharing a word with it (2,000+ open questions against hundreds of checklist points). Gives each question
 * that shares a telling word with the text, with how many it shares.
 */
function sharedWith<Q extends { id: string; n: number; text: string }>(
  questions: Q[],
): (text: string) => Map<Q, number> {
  const byWord = new Map<string, Q[]>();
  for (const q of questions) for (const w of wordsOf(q)) { const l = byWord.get(w); if (l) l.push(q); else byWord.set(w, [q]); }
  return (text) => {
    const shared = new Map<Q, number>();
    for (const w of tellingWords(text)) for (const q of byWord.get(w) ?? []) shared.set(q, (shared.get(q) ?? 0) + 1);
    return shared;
  };
}

/** mayAddress for many texts against the same questions */
export function addresser<Q extends { id: string; n: number; text: string }>(questions: Q[]): (text: string) => Q[] {
  const sharing = sharedWith(questions);
  return (text) => [...sharing(text)]
    .filter(([q, n]) => n >= MIN_SHARED && n / wordsOf(q).size >= 1 / 3)
    .sort(([a, x], [b, y]) => y - x || a.n - b.n)
    .map(([q]) => q);
}

/**
 * The open question that names the largest share of an unresolved point's telling words, with that share as a whole
 * percent (rounded down), or nothing when none is shared (#1218). Of equal shares the lower number wins. The percent is
 * the confidence that the app's `limits.askedCutoff` is compared with before a model is asked to check the pair.
 */
type Asked<Q> = { q: Q; confidence: number };
export function askedMatcher<Q extends { id: string; n: number; text: string }>(
  questions: Q[],
): (text: string) => Asked<Q> | undefined {
  const sharing = sharedWith(questions);
  return (text) => {
    let best: { q: Q; shared: number } | undefined;
    for (const [q, shared] of sharing(text)) {
      if (!best || shared > best.shared || (shared === best.shared && q.n < best.q.n)) best = { q, shared };
    }
    return best && { q: best.q, confidence: Math.floor((100 * best.shared) / tellingWords(text).size) };
  };
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
