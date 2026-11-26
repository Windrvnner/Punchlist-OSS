/**
 * A question of the Q&A log as a model is shown it: the full row, every field the app keeps for a log row, with the
 * response credited to who gave it, or marked as drafted by AI (#1102).
 */
import { cellValue, FIELDS } from '../domain/logWrite';
import type { Question } from '../domain/model';

/** a question as it is read from the store: any of its fields may be missing */
export type QaRecord = Partial<Pick<Question, (typeof FIELDS)[number]>> & { provenance?: { origin?: string } };

/** the fields shown on a row's first line after its number and status, each with the words it is shown with */
const DETAILS = [['askedBy', 'asked by'], ['received', 'received'], ['workstream', 'workstream'],
  ['priority', 'priority']] as const;

/** a field as the log writes it, as one line */
const cell = (q: QaRecord, k: (typeof FIELDS)[number]) => cellValue(q as Question, k).replace(/\s+/g, ' ').trim();

/** what a response drafted by AI is marked with, so that it is never taken for one received */
const AI_DRAFTED = ' (drafted by AI from the data room, not received from anyone)';

/**
 * The neutral handle a model is shown for the `k`th question (from 0) of a prompt, never its number, which the model's
 * prose could confuse with a quarter (Q3 2026): R1, R2, …, as for earlier responses in a draft (#286, #1105)
 */
export const handleOf = (k: number): string => `R${k + 1}`;

/** "R1", "response R1", "the response to R1" in a model's text, with whatever "the" or "response" came before it */
const HANDLE = /\b(?:([Tt]he) )?(?:([Rr]esponse) (?:to )?)?R(\d+)\b/g;

/**
 * A model's text with each handle it was shown put back as its question's number (#1105): "response R1" reads "the
 * response to Q12" and a bare "R1" reads "Q12". `handles` are the questions' numbers, in the order `handleOf` numbers
 * them; a handle the model was not shown is left as it is.
 */
export function questionsForHandles(text: string, handles: readonly (number | undefined)[]): string {
  return text.replace(HANDLE, (whole, the: string | undefined, response: string | undefined, k: string) => {
    const n = handles[Number(k) - 1];
    if (n === undefined) return whole;
    if (!response) return `${the ? `${the} ` : ''}Q${n}`;
    const article = the ?? (response === 'Response' ? 'The' : 'the');
    return `${article} response to Q${n}`;
  });
}

/**
 * "Response to R1 from X, 2026-11-02", or, for an AI draft, that it was drafted by AI and not received; `handle` is
 * the question's label in the prompt
 */
export function responseHeader(q: QaRecord, handle: string): string {
  const from = q.provenance?.origin === 'ai' ? AI_DRAFTED : q.respondedBy ? ` from ${q.respondedBy}` : '';
  return `Response to ${handle}${from}${q.responded ? `, ${q.responded}` : ''}`;
}

/**
 * The full row in three lines: its handle, status and details (blank cells left out), the question, the response.
 * `handle` labels it in the prompt in place of its number.
 */
export function qaRow(q: QaRecord, handle: string, deal = ''): string {
  const details = DETAILS.map(([k, label]) => (cell(q, k) ? `${label} ${cell(q, k)}` : ''));
  const head = [handle, cell(q, 'status'), ...details, deal];
  const said = cell(q, 'response');
  const response = `${responseHeader(q, handle)}: ${said || 'none yet'}`;
  return `${head.filter(Boolean).join(' · ')}\nQuestion: ${cell(q, 'text')}\n${response}`;
}

/** every field of the row, as a search ranks it */
export const qaText = (q: QaRecord): string => FIELDS.map((k) => cell(q, k)).join(' ');
