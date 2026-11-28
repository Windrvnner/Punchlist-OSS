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
/**
 * What the lookup reads of a question: its id, number, text and sender. A row of another table can stand in for one
 * (a kept edit's rows, keptMerge.ts), with no number where its row has none.
 */
export type MatchQuestion = Pick<Question, 'id' | 'text' | 'askedBy'> & { n: number | null };
/** a name a question is known by in one sender tier */
export type SenderOf<Q extends MatchQuestion = Question> = (q: Q) => string;
const OWN_SENDER: SenderOf<MatchQuestion>[] = [(q) => q.askedBy];

/** a text's forms as the file holds it (`fileForms`), keyed by which form each is: the same text shares a key */
export const formKeys = (text: string) => fileForms(text).map((form, which) => `${which}:${form}`);
/** one pass of the lookup: a sender tier (-1: a row or question naming no one) and whether the number must match */
type Pass = { tier: number; sameNumber: boolean };
/** a place in an index: a text form, a sender, and the number when the pass needs it */
const placeKey = (form: string, name: string, n: number | null) => `${form}\u0000${name}\u0000${n ?? ''}`;

/**
 * The senders a question is filed under in a pass: its name in the tier (a later tier's blank name says nothing, so
 * none), or in the last tier "any", and "blank" too for a question naming no one.
 */
function questionNames<Q extends MatchQuestion>(q: Q, senders: SenderOf<Q>[], tier: number): string[] {
  if (tier < 0) return sender(q.askedBy) ? ['any'] : ['any', 'blank'];
  const name = sender(senders[tier](q));
  return tier > 0 && !name ? [] : [`=${name}`];
}
/** the sender a row looks under in a pass: its own name; in the last tier, a blank question, or any for a blank row */
const rowName = (row: MatchRow, tier: number) => {
  const name = sender(row.askedBy);
  if (tier < 0) return name ? 'blank' : 'any';
  return `=${name}`;
};

/**
 * Each question's place in the pools for one pass, by text form (keyed by which form it is, as `sameText` compares
 * them), sender and number, so that the first question not yet taken is the row's: thousands of rows match quickly.
 */
function indexForPass<Q extends MatchQuestion>(
  questions: Q[], senders: SenderOf<Q>[], pass: Pass,
): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (const [at, q] of questions.entries()) {
    for (const form of formKeys(q.text)) {
      for (const name of questionNames(q, senders, pass.tier)) {
        const key = placeKey(form, name, pass.sameNumber ? q.n : null);
        const list = index.get(key);
        if (list) list.push(at);
        else index.set(key, [at]);
      }
    }
  }
  return index;
}

/** the questions a row may be in a pass, in pool order, and how many at the front are already taken */
type Candidates = { places: number[]; next: number };
/** a row's candidates in a pass: worked out once for all rows that look the same up */
function candidatesFor(index: Map<string, number[]>, cache: Map<string, Candidates>, row: MatchRow, pass: Pass) {
  const name = rowName(row, pass.tier);
  const keys = formKeys(row.text).map((form) => placeKey(form, name, pass.sameNumber ? row.n : null));
  const cacheKey = keys.join('\u0001');
  let found = cache.get(cacheKey);
  if (!found) {
    const places = [...new Set(keys.flatMap((key) => index.get(key) ?? []))].sort((x, y) => x - y);
    found = { places, next: 0 };
    cache.set(cacheKey, found);
  }
  return found;
}

/**
 * The order the lookup tries: every sender tier with the row's number, then every sender tier without it, and only then
 * a row or question naming no one, with the number and then without. A known sender comes first, so a row naming no
 * one never takes a question from its own sender's row; within that, the number comes first, so a renumbered question
 * keeps its row (docs/decisions.md).
 */
const passesFor = <Q extends MatchQuestion>(senders: SenderOf<Q>[]) => [[...senders.keys()], [-1]]
  .flatMap((tiers) => [true, false].flatMap((sameNumber) => tiers.map((tier) => ({ tier, sameNumber }))));

/**
 * Which question each row is, by row index: the XLOOKUP of the merge (docs/decisions.md). Rows look up questions in
 * file order, in the order of `passesFor`; a question is taken by one row only. The sender tiers are `senders` (the
 * question's own sender by default). The text is the same when it is the same as the file holds it (`sameText`). The
 * pools are searched in order (live, then deleted). Used by the import, its preview and Update Q&A Log alike (#1080),
 * and to line up a kept edit's rows (#1111).
 */
export function matchQuestions<Q extends MatchQuestion>(
  rows: MatchRow[], pools: Q[][], senders: SenderOf<Q>[] = OWN_SENDER,
): Map<number, string> {
  const questions = pools.flat();
  const matched = new Map<number, string>();
  const taken = new Set<string>();
  for (const pass of passesFor(senders)) {
    const index = indexForPass(questions, senders, pass);
    const cache = new Map<string, Candidates>();
    for (const [idx, row] of rows.entries()) {
      if (matched.has(idx) || (pass.sameNumber && row.n == null)) continue;
      const found = candidatesFor(index, cache, row, pass);
      while (found.next < found.places.length && taken.has(questions[found.places[found.next]].id)) found.next++;
      if (found.next === found.places.length) continue;
      const hit = questions[found.places[found.next]];
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
    // a choice made for other wording (the mapping changed since) no longer applies
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
