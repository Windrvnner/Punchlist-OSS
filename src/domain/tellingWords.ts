/**
 * The telling words of a text: the words the app compares texts by (an unresolved point against an open question, an
 * answer against a question). Four letters or more, a plain plural taken as its singular, and words that any diligence
 * text uses not counting.
 */
const COMMON = new Set([
  'about', 'also', 'been', 'being', 'between', 'both', 'cannot', 'come', 'comes', 'confirm', 'could', 'detail',
  'does', 'done', 'each', 'either', 'from', 'have', 'here', 'into', 'just', 'like', 'made', 'make', 'many', 'more',
  'most', 'much', 'must', 'only', 'other', 'over', 'please', 'provide', 'same', 'should', 'show', 'some', 'such',
  'than', 'that', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'throughout',
  'under', 'upon', 'used', 'uses', 'using', 'very', 'want', 'were', 'what', 'when', 'where', 'whether', 'which',
  'while', 'will', 'with', 'within', 'would', 'your', 'document', 'documents', 'project', 'question', 'answer',
  'response', 'closest', 'support', 'data', 'room', 'matter', 'finding', 'findings',
]);

/** the telling words of a text: four letters or more, a plain plural taken as its singular */
export function tellingWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    const one = w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
    if (!COMMON.has(w) && !COMMON.has(one)) out.add(one);
  }
  return out;
}

/** a question's telling words, worked out once per question record (a record is replaced, never changed) */
const wordCache = new WeakMap<object, { text: string; words: Set<string> }>();
export function wordsOf(q: { text: string }): Set<string> {
  let cached = wordCache.get(q);
  if (!cached || cached.text !== q.text) {
    cached = { text: q.text, words: tellingWords(q.text) };
    wordCache.set(q, cached);
  }
  return cached.words;
}
