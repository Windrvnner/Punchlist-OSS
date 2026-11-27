/**
 * The only functions that change a record's state. Commands call these; the
 * UI never does. Each returns the changed record(s) plus the audit kinds the
 * change implies. Pure: no I/O, no clock — `at` and `actor` are passed in.
 */
import type { Question, QuestionStatus, Finding, FindingStatus, Provenance } from './model';
import { wordingHash } from './model';
import { sameWords } from './importExport';
import { ok, fail, rejected, type Result } from './result';

export interface Ctx { at: string; actor: string }

export interface Changed<T> { record: T; audit: { kind: string; field?: string; from?: unknown; to?: unknown; text?: string }[] }

const QUESTION_MOVES: Record<QuestionStatus, QuestionStatus[]> = {
  open: ['answered', 'closed'],
  answered: ['open', 'closed'],
  closed: ['open', 'answered'],
};

function statusRefusal(q: Question, to: QuestionStatus) {
  if (q.status !== to && !QUESTION_MOVES[q.status].includes(to)) {
    return `A question cannot go from ${q.status} to ${to}`;
  }
  if (to === 'answered' && !q.response.trim()) return 'A question is answered only when it has a response';
}

export const canSetQuestionStatus = (q: Question, to: QuestionStatus) => !statusRefusal(q, to);

export function setQuestionStatus(q: Question, to: QuestionStatus, ctx: Ctx): Result<Changed<Question>> {
  if (q.status === to) return ok({ record: q, audit: [] });
  const refusal = statusRefusal(q, to);
  if (refusal) return fail(rejected(refusal));
  return ok({ record: { ...q, status: to, updatedAt: ctx.at }, audit: [{ kind: 'status', field: 'status', from: q.status, to }] });
}

/** Editable fields a person may set directly. Status has its own transition. */
export type QuestionField = 'text' | 'askedBy' | 'received' | 'workstream' | 'priority' | 'respondedBy' | 'responded';

export function editQuestionField(q: Question, field: QuestionField, value: string, ctx: Ctx): Result<Changed<Question>> {
  if ((q as any)[field] === value) return ok({ record: q, audit: [] });
  const next: Question = { ...q, [field]: value, updatedAt: ctx.at } as Question;
  return ok({ record: next, audit: [{ kind: 'edited', field, from: (q as any)[field], to: value }] });
}

export function isDraftStale(q: Question): boolean {
  return !!q.draft && q.draft.status === 'found' && q.draft.forWording !== wordingHash(q.text);
}

/**
 * Setting or clearing a response. Returns the changed question and, when the
 * question is linked to a finding, the changed finding — both or neither.
 */
export function setResponse(
  q: Question,
  response: string,
  prov: Provenance | undefined,
  linked: Finding | undefined,
  ctx: Ctx,
): Result<{ question: Changed<Question>; finding?: Changed<Finding> }> {
  const had = !!q.response.trim();
  const has = !!response.trim();
  const question: Changed<Question> = {
    record: { ...q, response, provenance: has ? prov : undefined, updatedAt: ctx.at },
    audit: has ? [{ kind: 'response', field: 'response', to: response }] : [{ kind: 'responseWithdrawn', field: 'response', from: q.response }],
  };
  // A response reworded (other words, not only other spacing) is a new response for the finding
  const reworded = had && has && !sameWords(q.response, response);
  if (!linked || (had === has && !reworded)) return ok({ question });
  // A response arriving on a linked question marks the finding, naming the question; withdrawing it takes away only
  // what that response put there. A mark set for another reason (a check, a document) is never added to or cleared here:
  // it stands until a person reassesses, and the response is in the question's history.
  const by = linked.updatedOn?.questions ?? [];
  if (has) {
    if (linked.updated && !linked.updatedOn) return ok({ question });
    if (reworded && linked.updated && by.includes(q.id)) return ok({ question });    // already marked by this question: typing on adds nothing
    const questions = by.includes(q.id) ? by : [...by, q.id];
    return ok({ question, finding: { record: { ...linked, updated: true, updatedWhy: `Response received on Q${q.n}`, updatedOn: { questions }, updatedAt: ctx.at }, audit: [{ kind: 'response', text: `Response received on Q${q.n}` }] } });
  }
  if (!linked.updated || !by.includes(q.id)) return ok({ question });
  const left = by.filter((id) => id !== q.id);
  const record: Finding = left.length ? { ...linked, updatedOn: { questions: left }, updatedAt: ctx.at } : { ...linked, updated: false, updatedWhy: '', updatedOn: undefined, updatedAt: ctx.at };
  return ok({ question, finding: { record, audit: [{ kind: 'responseWithdrawn', text: `Response removed from Q${q.n}` }] } });
}

const FINDING_MOVES: Record<FindingStatus, FindingStatus[]> = { open: ['closed'], closed: ['open'] };

export function setFindingStatus(f: Finding, to: FindingStatus, note: string | undefined, ctx: Ctx): Result<Changed<Finding>> {
  const audit: Changed<Finding>['audit'] = [];
  let next = f;
  if (f.status !== to) {
    if (!FINDING_MOVES[f.status].includes(to)) return fail(rejected(`A finding cannot go from ${f.status} to ${to}`));
    next = { ...next, status: to, closedAt: to === 'closed' ? ctx.at : undefined, updatedAt: ctx.at };
    audit.push({ kind: 'status', field: 'status', from: f.status, to });
  }
  if (note !== undefined && note.trim() && note !== f.note) {
    next = { ...next, note: f.note ? `${f.note}\n${note}` : note, updatedAt: ctx.at };
    audit.push({ kind: 'note', text: note });
  }
  return ok({ record: next, audit });
}

export function reviewFinding(f: Finding, reviewed: boolean, ctx: Ctx): Result<Changed<Finding>> {
  if (!!f.reviewed === reviewed) return ok({ record: f, audit: [] });
  return ok({
    record: { ...f, reviewed: reviewed ? { by: ctx.actor, at: ctx.at } : null, updatedAt: ctx.at },
    audit: [{ kind: reviewed ? 'reviewed' : 'unreviewed' }],
  });
}

/** Invariants that must hold for any question about to be written. */
export function checkQuestion(q: Question): Result<Question> {
  if (q.status === 'answered' && !q.response.trim()) return fail(rejected('An answered question must have a response'));
  if (q.n < 1) return fail(rejected('Question numbers start at 1'));
  return ok(q);
}

export function checkFinding(f: Finding): Result<Finding> {
  if (f.origin === 'ai' && f.sources.length < 1) return fail(rejected('A first-pass finding needs at least one source'));
  return ok(f);
}
