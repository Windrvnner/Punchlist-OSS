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
