/**
 * A question of the Q&A log as a model is shown it: the full row, every field the app keeps for a log row, with the
 * response credited to who gave it, or marked as drafted by AI (#1102).
 */
import { cellValue, FIELDS } from '../domain/logWrite';
import { ULID, type Question } from '../domain/model';

/** a question as it is read from the store, with its permanent record id: any of its other fields may be missing */
export type QaRecord = Partial<Pick<Question, (typeof FIELDS)[number]>>
  & { id: string; provenance?: { origin?: string } };

/** the fields shown on a row's first line after its id and status, each with the words it is shown with */
const DETAILS = [['askedBy', 'asked by'], ['received', 'received'], ['workstream', 'workstream'],
  ['priority', 'priority']] as const;

/** a field as the log writes it, as one line */
const cell = (q: QaRecord, k: (typeof FIELDS)[number]) => cellValue(q as Question, k).replace(/\s+/g, ' ').trim();

/** what a response drafted by AI is marked with, so that it is never taken for one received */
export const AI_DRAFTED = ' (drafted by AI from the data room, not received from anyone)';

/** a question's permanent id as a model may write it back: `q_` and a ULID (model.ts) */
const QUESTION_ID = new RegExp(`\\bq_${ULID}\\b`, 'g');

/**
 * A question's id in a model's text, with the words that name it as a response before it: "response q_…", "the
 * response q_…" or "response to q_…" (#1105)
 */
const NAMED = new RegExp(`\\b(?:([Tt]he) )?(?:([Rr]esponse) (?:to )?)?(q_${ULID})\\b`, 'g');

/** the question ids a model's text names, each once */
export const questionIdsIn = (text: string): string[] => [...new Set(text.match(QUESTION_ID) ?? [])];

/**
 * A model's text with each question id put back as its number now: "response q_…" (or "the response q_…", "response
 * to q_…") as "the response to Q12", and a bare id as "Q12". `numbers` gives each id its number; an id with none, and
 * any other text, is left as it is (#1105).
 */
export function questionsForIds(text: string, numbers: ReadonlyMap<string, number>): string {
  return text.replace(NAMED, (whole, the: string | undefined, response: string | undefined, id: string) => {
    const n = numbers.get(id);
    if (n === undefined) return whole;
    if (!response) return `${the ? `${the} ` : ''}Q${n}`;
    const article = the ?? (response === 'Response' ? 'The' : 'the');
    return `${article} response to Q${n}`;
  });
}

/**
 * "Response to q_… from X, 2026-11-02", or, for an AI draft, that it was drafted by AI and not received; the question
 * is named by its id, never its number (#1105)
 */
export function responseHeader(q: QaRecord): string {
  const from = q.provenance?.origin === 'ai' ? AI_DRAFTED : q.respondedBy ? ` from ${q.respondedBy}` : '';
  return `Response to ${q.id}${from}${q.responded ? `, ${q.responded}` : ''}`;
}

/** The full row in three lines: its id, status and details (blank cells left out), the question, the response. */
export function qaRow(q: QaRecord, deal = ''): string {
  const details = DETAILS.map(([k, label]) => (cell(q, k) ? `${label} ${cell(q, k)}` : ''));
  const head = [q.id, cell(q, 'status'), ...details, deal];
  const said = cell(q, 'response');
  const response = `${responseHeader(q)}: ${said || 'none yet'}`;
  return `${head.filter(Boolean).join(' · ')}\nQuestion: ${cell(q, 'text')}\n${response}`;
}

/** every field of the row, as a search ranks it */
export const qaText = (q: QaRecord): string => FIELDS.map((k) => cell(q, k)).join(' ');
