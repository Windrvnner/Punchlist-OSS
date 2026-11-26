/**
 * How a merge finds each row's question: exactly (the same text and sender, the same number first), or because the person
 * accepted the app's suggestion for a row that matched nothing. A suggestion is only ever shown, never applied alone.
 */
import { z } from 'zod';
import { QuestionId, type Question } from '../../domain/model';
import type { ImportRow } from '../../domain/importExport';

/** a row of the file, by its line in the file, the person chose to be that question */
export const AcceptedMatch = z.object({ line: z.number().int().positive(), text: z.string(), questionId: QuestionId });
export type AcceptedMatch = z.infer<typeof AcceptedMatch>;

/** a row that matched no question, and the question it could be */
export interface Suggestion { line: number; text: string; questionId: string; n: number; questionText: string }

/** words only: capitals, spacing and punctuation set aside, for suggesting where a row could slot in, never for matching */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** the line a row stands for in the person's file, blank rows counted */
export const lineOf = (row: ImportRow, idx: number) => row.line ?? idx + 2;

/**
 * Which question each row is, by row index: first the question with the row's number and exact text, then the one with
 * the exact text alone, each with the same sender (or one naming none). `pools` are searched in order (live, then deleted); a question is taken by one row only.
 */
export function matchExactly(rows: ImportRow[], pools: Question[][]): Map<number, string> {
  const matched = new Map<number, string>(); const taken = new Set<string>();
  // who sent the question is part of the match, as written (spaces around a name are not part of it). A row or a
  // question that names no sender does not conflict with one that does, but the same sender is always tried first.
  const sender = (name: string) => name.trim();
  const find = (row: ImportRow, sameNumber: boolean, sameSender: boolean) => {
    for (const pool of pools) {
      const hit = pool.find((q) => !taken.has(q.id) && q.text === row.text && (!sameNumber || q.n === row.n)
        && (sameSender ? sender(q.askedBy) === sender(row.askedBy)
          : !sender(q.askedBy) || !sender(row.askedBy)));
      if (hit) return hit;
    }
    return undefined;
  };
  for (const sameNumber of [true, false]) {
    for (const sameSender of [true, false]) {
      for (const [idx, row] of rows.entries()) {
        if (matched.has(idx) || (sameNumber && row.n == null)) continue;
        const hit = find(row, sameNumber, sameSender);
        if (hit) { matched.set(idx, hit.id); taken.add(hit.id); }
      }
    }
  }
  return matched;
}


/** `matched` with the person's accepted choices added, for rows that matched nothing and questions nothing else took */
export function withAccepted(
  matched: Map<number, string>, rows: ImportRow[], accepted: AcceptedMatch[], known: ReadonlySet<string>,
): Map<number, string> {
  const result = new Map(matched);
  const taken = new Set(matched.values());
  for (const [idx, row] of rows.entries()) {
    const choice = accepted.find((a) => a.line === lineOf(row, idx));
    // a choice made for other wording (the mapping or sheet changed since) no longer applies
    if (!choice || choice.text !== row.text || result.has(idx) || taken.has(choice.questionId) || !known.has(choice.questionId)) continue;
    result.set(idx, choice.questionId); taken.add(choice.questionId);
  }
  return result;
}

/**
 * For each row that matched nothing, a live question with the same words but for capitals, spacing and punctuation,
 * from the same sender or none, that no row took: where the row could slot in. At most one row per question.
 */
export function suggestMatches(rows: ImportRow[], live: Question[], matched: ReadonlyMap<number, string>): Suggestion[] {
  const taken = new Set(matched.values()); const out: Suggestion[] = [];
  const wordsOf = new Map(live.map((q) => [q.id, plain(q.text)]));
  for (const [idx, row] of rows.entries()) {
    if (matched.has(idx)) continue;
    const wording = plain(row.text); const sender = row.askedBy.trim();
    const hit = live.find((q) => !taken.has(q.id) && wordsOf.get(q.id) === wording
      && (!sender || !q.askedBy.trim() || q.askedBy.trim() === sender));
    if (!hit) continue;
    taken.add(hit.id);
    out.push({ line: lineOf(row, idx), text: row.text, questionId: hit.id, n: hit.n, questionText: hit.text });
  }
  return out;
}
