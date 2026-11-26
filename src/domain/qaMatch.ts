/**
 * Which question each spreadsheet row is, for the import, its preview and Update Q&A Log alike: by its text as the file
 * holds it and its sender, or because the person accepted the app's suggestion for a row that matched nothing. A
 * suggestion is only ever shown, never applied alone.
 */
import { z } from 'zod';
import { QuestionId, type Question } from './model';
import { fileForms, type ImportRow } from './importExport';

/** a row of the file, by its line in the file, the person chose to be that question */
export const AcceptedMatch = z.object({ line: z.number().int().positive(), text: z.string(), questionId: QuestionId });
export type AcceptedMatch = z.infer<typeof AcceptedMatch>;

/** a row that matched no question, and the question it could be */
export interface Suggestion { line: number; text: string; questionId: string; n: number; questionText: string }

/** words only, with capitals, spacing and punctuation set aside: for suggesting where a row could slot in */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** the line a row stands for in the person's file, blank rows counted */
export const lineOf = (row: ImportRow, idx: number) => row.line ?? idx + 2;

/** a name as written, spaces around it aside */
const sender = (name: string) => name.trim();

/** what the lookup reads of a row: its number (as its reader reads it), its question and who submitted it */
export type MatchRow = Pick<ImportRow, 'n' | 'text' | 'askedBy'>;
/** a name a question is known by in one sender tier */
export type SenderOf = (q: Question) => string;
const OWN_SENDER: SenderOf[] = [(q) => q.askedBy];

/**
 * each question's place in the pools, by each form its text takes in a file (`fileForms`, keyed by which form it is, as
 * `sameText` compares them), so thousands of rows match quickly
 */
function indexByText(questions: Question[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const [at, q] of questions.entries()) {
    for (const key of new Set(formKeys(q.text))) {
      const list = index.get(key);
      if (list) list.push(at);
      else index.set(key, [at]);
    }
  }
  return index;
}
const formKeys = (text: string) => fileForms(text).map((form, which) => `${which}:${form}`);

/** the places of the questions whose text is the row's as the file holds it, in pool order; worked out once per text */
function candidatesOf(index: Map<string, number[]>, cache: Map<string, number[]>, text: string): number[] {
  const known = cache.get(text);
  if (known) return known;
  const places = [...new Set(formKeys(text).flatMap((key) => index.get(key) ?? []))].sort((x, y) => x - y);
  cache.set(text, places);
  return places;
}

/**
 * Whether a question fits a row in a sender tier: the same name in tier `tier` (the first tier's blank name is a name
 * too; a later tier's blank name says nothing), or, in the last tier (`tier` = -1), a side naming no one.
 */
function fitsSender(q: Question, row: MatchRow, senders: SenderOf[], tier: number): boolean {
  const rowName = sender(row.askedBy);
  if (tier < 0) return !sender(q.askedBy) || !rowName;
  const name = sender(senders[tier](q));
  return (tier === 0 || name !== '') && name === rowName;
}

/**
 * The order the lookup tries: each sender tier, with the row's number and then without, and only then a row or question
 * naming no one, with the number and then without. The same sender comes first, so a row naming no one never takes a
 * question from its own sender's row (docs/decisions.md).
 */
const passesFor = (senders: SenderOf[]) => [...senders.keys(), -1]
  .flatMap((tier) => [true, false].map((sameNumber) => ({ tier, sameNumber })));

/**
 * Which question each row is, by row index: the XLOOKUP of the merge (docs/decisions.md). Rows look up questions in
 * file order, in the order of `passesFor`; a question is taken by one row only. The sender tiers are `senders` (the
 * question's own sender by default). The text is the same when it is the same as the file holds it (`sameText`). The
 * pools are searched in order (live, then deleted). Used by the import, its preview and Update Q&A Log alike (#1080).
 */
export function matchQuestions(
  rows: MatchRow[], pools: Question[][], senders: SenderOf[] = OWN_SENDER,
): Map<number, string> {
  const questions = pools.flat();
  const index = indexByText(questions);
  const cache = new Map<string, number[]>();
  const matched = new Map<number, string>();
  const taken = new Set<string>();
  for (const { tier, sameNumber } of passesFor(senders)) {
    for (const [idx, row] of rows.entries()) {
      if (matched.has(idx) || (sameNumber && row.n == null)) continue;
      const fits = (q: Question) => !taken.has(q.id) && (!sameNumber || q.n === row.n)
        && fitsSender(q, row, senders, tier);
      const hit = candidatesOf(index, cache, row.text).map((at) => questions[at]).find(fits);
      if (!hit) continue;
      matched.set(idx, hit.id);
      taken.add(hit.id);
    }
  }
  return matched;
}

/** `matched` with the person's accepted choices for rows that matched nothing, to questions nothing else took */
export function withAccepted(
  matched: Map<number, string>, rows: ImportRow[], accepted: AcceptedMatch[], known: ReadonlySet<string>,
): Map<number, string> {
  const result = new Map(matched);
  const taken = new Set(matched.values());
  for (const [idx, row] of rows.entries()) {
    const choice = accepted.find((a) => a.line === lineOf(row, idx));
    // a choice made for other wording (the mapping or sheet changed since) no longer applies
    if (!choice || choice.text !== row.text) continue;
    if (result.has(idx) || taken.has(choice.questionId) || !known.has(choice.questionId)) continue;
    result.set(idx, choice.questionId);
    taken.add(choice.questionId);
  }
  return result;
}

/**
 * For each row that matched nothing, a live question with the same words but for capitals, spacing and punctuation,
 * from the same sender or none, that no row took: where the row could slot in. At most one row per question.
 */
export function suggestMatches(
  rows: ImportRow[], live: Question[], matched: ReadonlyMap<number, string>,
): Suggestion[] {
  const taken = new Set(matched.values());
  const out: Suggestion[] = [];
  const wordsOf = new Map(live.map((q) => [q.id, plain(q.text)]));
  for (const [idx, row] of rows.entries()) {
    if (matched.has(idx)) continue;
    const wording = plain(row.text);
    const name = sender(row.askedBy);
    const hit = live.find((q) => !taken.has(q.id) && wordsOf.get(q.id) === wording
      && (!name || !sender(q.askedBy) || sender(q.askedBy) === name));
    if (!hit) continue;
    taken.add(hit.id);
    out.push({ line: lineOf(row, idx), text: row.text, questionId: hit.id, n: hit.n, questionText: hit.text });
  }
  return out;
}
