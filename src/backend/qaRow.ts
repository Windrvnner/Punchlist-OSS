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

/** "Response to Q12 from X, 2026-11-02", or, for an AI draft, that it was drafted by AI and not received */
export function responseHeader(q: QaRecord): string {
  const from = q.provenance?.origin === 'ai' ? AI_DRAFTED : q.respondedBy ? ` from ${q.respondedBy}` : '';
  return `Response to Q${q.n}${from}${q.responded ? `, ${q.responded}` : ''}`;
}

/** the full row in three lines: its number, status and details (blank cells left out), the question, the response */
export function qaRow(q: QaRecord, deal = ''): string {
  const details = DETAILS.map(([k, label]) => (cell(q, k) ? `${label} ${cell(q, k)}` : ''));
  const head = [`Q${q.n}`, cell(q, 'status'), ...details, deal];
  const said = cell(q, 'response');
  const response = said ? `${responseHeader(q)}: ${said}` : `Response to Q${q.n}: none yet`;
  return `${head.filter(Boolean).join(' · ')}\nQuestion: ${cell(q, 'text')}\n${response}`;
}

/** every field of the row, as a search ranks it */
export const qaText = (q: QaRecord): string => FIELDS.map((k) => cell(q, k)).join(' ');
