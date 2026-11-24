import { z } from 'zod';
import { define } from '../command';
import { Question, QuestionId, DealId, FindingId, QuestionStatus, Priority, Tombstone, Source, isRealDate } from '../../domain/model';
import { editQuestionField, setQuestionStatus, setResponse, checkQuestion, type QuestionField } from '../../domain/transitions';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { nextQuestionNumber, sharedNumbers, type State } from '../state';
import { sameWords } from '../../domain/importExport';
import { keepAside, otherCopies, type ShownNote } from './keptVersions';
import { AskOrigin, linksForAsk } from '../askSubmission';

const Field = z.enum(['text', 'askedBy', 'received', 'workstream', 'priority', 'respondedBy', 'responded']);
const YMDorBlank = z.string().refine((v) => v === '' || isRealDate(v), 'Enter a real date as YYYY-MM-DD');

/**
 * Waited on by every change that gives a question a number in a deal, so two started together (an import while a question is
 * being added, say) never both take the same next number. Not a record: only the order changes wait in.
 */
export const numbering = (dealId: string) => `numbers:${dealId}`;

/** an item the deal's checklist holds: one of its item records, or a row the check listed (a deal checked before it had items of its own) */
const onChecklist = (state: State, dealId: string, id: string): boolean => {
  if (state.items[id]) return state.items[id].dealId === dealId;
  const rows = state.checklists[dealId]; return Array.isArray(rows) && rows.some((r) => r.id === id);
};

export const CreateQuestion = define({
  name: 'CreateQuestion',
  input: z.object({
    dealId: DealId, text: z.string().default(''), workstream: z.string().default(''), askedBy: z.string().default(''),
    received: YMDorBlank.default(''), linkedFinding: FindingId.optional(), linkedItem: z.string().min(1).optional(),
    askOrigin: AskOrigin.optional(),
  }),
  targets: (_s, i) => [numbering(i.dealId)],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const links = input.askOrigin ? linksForAsk(state, d.id, input.askOrigin) : ok(input);
    if (!links.ok) return links;
    const { linkedFinding, linkedItem, workstream } = links.value;
    if (linkedFinding && state.findings[linkedFinding]?.dealId !== d.id) {
      return fail(notFound('That finding is not on this deal', linkedFinding));
    }
    if (linkedItem && !onChecklist(state, d.id, linkedItem)) {
      return fail(notFound('That item is not on this deal’s checklist', linkedItem));
    }
    const id = ctx.ids.next('q');
    const q = Question.parse({
      linkedFinding,
      ...(linkedItem ? { linkedItem: { id: linkedItem } } : {}),
      id, dealId: d.id, rev: 0, createdAt: ctx.at, updatedAt: ctx.at,
      n: nextQuestionNumber(state, d.id), text: input.text, workstream,
      askedBy: input.askedBy || ctx.firm,   // a question made here is submitted by the firm, not by the person at the keyboard; who typed it is in the history
      received: input.received,
      priority: 'High',   // a question with no priority is High; a person can lower it
    });
    return ok({
      dealId: d.id,
      upserts: [{ kind: 'question', record: q, expectedRev: null }],
      index: { dealId: d.id, add: [{ kind: 'question', id }] },
      audit: [{ kind: 'created', recordId: id, dealId: d.id }],
      inverse: { command: 'DeleteQuestion', input: { dealId: d.id, questionId: id } },
      message: 'Question added',
    });
  },
});

export const EditQuestionField = define({
  name: 'EditQuestionField',
  input: z.object({ dealId: DealId, questionId: QuestionId, field: Field, value: z.string() }),
  targets: (_s, i) => [i.questionId],
  plan(state, input, ctx) {
    const q = state.questions[input.questionId];
    if (!q || q.dealId !== input.dealId) return fail(notFound('Question not found', input.questionId));
    if ((input.field === 'received' || input.field === 'responded') && !YMDorBlank.safeParse(input.value).success) return fail(rejected('Enter a real date'));
    if (input.field === 'priority' && !Priority.safeParse(input.value).success) return fail(rejected('Priority is High, Medium or Low'));
    const r = editQuestionField(q, input.field as QuestionField, input.value, { at: ctx.at, actor: ctx.actor });
    if (!r.ok) return r;
    if (!r.value.audit.length) return ok({ upserts: [], audit: [] });
    const chk = checkQuestion(r.value.record); if (!chk.ok) return chk;
    return ok({
      dealId: q.dealId,
      upserts: [{ kind: 'question', record: r.value.record, expectedRev: q.rev }],
      audit: r.value.audit.map((a) => ({ ...a, kind: a.kind as any, recordId: q.id, dealId: q.dealId })),
      inverse: { command: 'EditQuestionField', input: { ...input, value: (q as any)[input.field] } },
    });
  },
});

/**
 * Two questions hold the same number (each was added on a different PC before either saw the other). A person picks
 * one of them and it takes the next free number. Only a question whose number is held twice can be renumbered.
 */
export const RenumberQuestion = define({
  name: 'RenumberQuestion',
  input: z.object({ dealId: DealId, questionId: QuestionId }),
  targets: (_s, i) => [i.questionId, numbering(i.dealId)],
  plan(state, input, ctx) {
    const q = state.questions[input.questionId];
    if (!q || q.dealId !== input.dealId) return fail(notFound('Question not found', input.questionId));
    if (!sharedNumbers(state, q.dealId).has(q.n)) return fail(rejected(`Q${q.n} is the only question with that number`));
    const n = nextQuestionNumber(state, q.dealId);
    return ok({
      dealId: q.dealId,
      upserts: [{ kind: 'question', record: { ...q, n, updatedAt: ctx.at }, expectedRev: q.rev }],
      audit: [{ kind: 'edited', recordId: q.id, dealId: q.dealId, field: 'n', from: q.n, to: n, text: `Renumbered from Q${q.n} to Q${n}` }],
      inverse: { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q } },
      message: `Q${q.n} is now Q${n}`,
    });
  },
});

export const SetQuestionStatus = define({
  name: 'SetQuestionStatus',
  input: z.object({ dealId: DealId, questionId: QuestionId, status: QuestionStatus }),
  targets: (_s, i) => [i.questionId],
  plan(state, input, ctx) {
    const q = state.questions[input.questionId];
    if (!q || q.dealId !== input.dealId) return fail(notFound('Question not found', input.questionId));
    const r = setQuestionStatus(q, input.status, { at: ctx.at, actor: ctx.actor });
    if (!r.ok) return r;
    if (!r.value.audit.length) return ok({ upserts: [], audit: [] });
    return ok({
      dealId: q.dealId,
      upserts: [{ kind: 'question', record: r.value.record, expectedRev: q.rev }],
      audit: r.value.audit.map((a) => ({ ...a, kind: a.kind as any, recordId: q.id, dealId: q.dealId })),
      inverse: { command: 'SetQuestionStatus', input: { ...input, status: q.status } },
      message: `Q${q.n} marked ${input.status}`,
    });
  },
});

/**
 * Several questions' statuses set as one change with one Undo. Each question is checked as SetQuestionStatus checks
 * one. A refused move changes nothing. CloseSettledQuestions adds the checklist rule and uses this same status update
 * and inverse, so Undo can reopen questions even if the checklist has changed.
 */
export const SetQuestionsStatus = define({
  name: 'SetQuestionsStatus',
  input: z.object({ dealId: DealId, set: z.array(z.object({ questionId: QuestionId, status: QuestionStatus })).min(1) }),
  targets: (_s, i) => i.set.map((x) => x.questionId),
  plan(state, input, ctx) {
    const upserts = []; const audit = []; const back = [];
    for (const { questionId, status } of input.set) {
      const q = state.questions[questionId];
      if (!q || q.dealId !== input.dealId) return fail(notFound('A question is no longer here', questionId));
      const r = setQuestionStatus(q, status, { at: ctx.at, actor: ctx.actor });
      if (!r.ok) return fail(rejected(`Q${q.n}: ${r.error.message}`));
      if (!r.value.audit.length) continue;
      upserts.push({ kind: 'question' as const, record: r.value.record, expectedRev: q.rev });
      audit.push(...r.value.audit.map((a) => ({ ...a, kind: a.kind as any, recordId: q.id, dealId: q.dealId })));
      back.push({ questionId, status: q.status });
    }
    if (!upserts.length) return ok({ upserts: [], audit: [] });
    const closing = input.set.every((x) => x.status === 'closed');
    return ok({
      dealId: input.dealId, upserts, audit,
      inverse: { command: 'SetQuestionsStatus', input: { dealId: input.dealId, set: back } },
      message: `${upserts.length.toLocaleString('en-US')} question${upserts.length === 1 ? '' : 's'} ${closing ? 'closed' : 'changed'}`,
    });
  },
});

/** A person types or clears a response. Linked finding is marked/unmarked in the same transaction. */
export const SetResponse = define({
  name: 'SetResponse',
  input: z.object({ dealId: DealId, questionId: QuestionId, response: z.string() }),
  targets: (s, i) => { const q = s.questions[i.questionId]; return q?.linkedFinding ? [i.questionId, q.linkedFinding] : [i.questionId]; },
  plan(state, input, ctx) {
    const q = state.questions[input.questionId];
    if (!q || q.dealId !== input.dealId) return fail(notFound('Question not found', input.questionId));
    const text = input.response.trim() ? input.response : '';       // only spaces is no response, not a response that wipes the old one's origin
    if (q.response === text) return ok({ upserts: [], audit: [] });
    const linked = q.linkedFinding ? state.findings[q.linkedFinding] : undefined;
    // a drafted or quoted response stays so only while its words do: once a person changes them it is theirs, and the
    // draft's label and sources go, as an import already does with a changed response
    const kept = q.provenance && q.provenance.origin !== 'human' && sameWords(text, q.response);
    const prov = text ? (kept ? q.provenance : { origin: 'human' as const, sources: [], actor: ctx.actor, at: ctx.at }) : undefined;
    const r = setResponse(q, text, prov, linked, { at: ctx.at, actor: ctx.actor });
    if (!r.ok) return r;
    if (!checkQuestion(r.value.question.record).ok) return fail(rejected('This question is marked Answered. Change its status before clearing the response'));
    const upserts: any[] = [{ kind: 'question', record: r.value.question.record, expectedRev: q.rev }];
    const audit: any[] = r.value.question.audit.map((a) => ({ ...a, recordId: q.id, dealId: q.dealId }));
    if (r.value.finding && linked) {
      upserts.push({ kind: 'finding', record: r.value.finding.record, expectedRev: linked.rev });
      audit.push(...r.value.finding.audit.map((a) => ({ ...a, recordId: linked.id, dealId: q.dealId, ref: { questionId: q.id } })));
    }
    // A response taken away is said, with Undo, however the field asked for the save; Undo puts the whole question back
    // (the response, who it came from and when) and the finding's mark with it.
    // The finding goes back exactly as it was if the withdrawal changed it, and is left alone if it did not: a mark is never worked out again on Undo.
    if (!text) return ok({ dealId: q.dealId, upserts, audit, inverse: { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q, finding: r.value.finding && linked ? linked : null } }, message: `Response removed from Q${q.n}`, alwaysSay: true });
    // a reworded response that marked the finding is undone whole, the finding put back as it was: a mark is never worked out again on Undo
    if (r.value.finding && linked) return ok({ dealId: q.dealId, upserts, audit, inverse: { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q, finding: linked } } });
    // Undo of the first edit to a drafted response puts the whole question back, the draft's origin and sources with it
    const dropped = q.provenance && q.provenance.origin !== 'human' && !kept;
    return ok({ dealId: q.dealId, upserts, audit, inverse: dropped ? { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q, finding: r.value.finding && linked ? linked : null } } : { command: 'SetResponse', input: { ...input, response: q.response } } });
  },
});

export const DeleteQuestion = define({
  name: 'DeleteQuestion',
  input: z.object({ dealId: DealId, questionId: QuestionId }),
  targets: (_s, i) => [i.questionId],
  plan(state, input, ctx) {
    const q = state.questions[input.questionId];
    if (!q || q.dealId !== input.dealId) return fail(notFound('Question not found', input.questionId));
    const tomb = Tombstone.parse({ kind: 'question', dealId: q.dealId, id: q.id, title: q.text.slice(0, 120), at: ctx.at, actor: ctx.actor, snapshot: q });
    return ok({
      dealId: q.dealId,
      upserts: [{ kind: 'tombstone', record: tomb, expectedRev: null }],
      removes: [{ kind: 'question', id: q.id, rev: q.rev }],
      index: { dealId: q.dealId, remove: [{ kind: 'question', id: q.id }], add: [{ kind: 'tombstone', id: q.id }] },
      audit: [{ kind: 'deleted', recordId: q.id, dealId: q.dealId }],
      inverse: { command: 'RestoreQuestion', input: { dealId: q.dealId, questionId: q.id } },
      message: `Q${q.n} deleted`,
    });
  },
});

export const RestoreQuestion = define({
  name: 'RestoreQuestion',
  // `copy`: which deletion note's copy to bring back, when two PCs deleted different words; the others become entries under Deleted
  input: z.object({ dealId: DealId, questionId: QuestionId, copy: z.string().optional() }),
  targets: (_s, i) => [i.questionId],
  plan(state, input, ctx) {
    const t = state.tombstones[input.questionId] as ShownNote | undefined;
    if (!t || t.kind !== 'question' || t.dealId !== input.dealId) return fail(notFound('Nothing to restore', input.questionId));
    const snap = input.copy ? t.copies?.find((c) => c.ver === input.copy)?.snapshot : t.snapshot;
    if (!snap) return fail(notFound('That copy is no longer here', input.questionId));
    const q = Question.parse({ ...(snap as object), id: t.id, updatedAt: ctx.at });
    // a number another question holds now is shared again, as it was before the delete; both are marked (#13)
    const others = keepAside('question', q.dealId, q.id, otherCopies(t, q), [q], state.tombstones);
    return ok({
      dealId: q.dealId,
      upserts: [{ kind: 'question', record: q, expectedRev: null }, ...others.upserts],
      removes: [{ kind: 'tombstone', id: q.id, rev: null }],
      index: { dealId: q.dealId, add: [{ kind: 'question', id: q.id }, ...others.ids.map((id) => ({ kind: 'tombstone' as const, id }))], remove: [{ kind: 'tombstone', id: q.id }] },
      audit: [{ kind: 'restored', recordId: q.id, dealId: q.dealId }],
      inverse: { command: 'DeleteQuestion', input: { dealId: input.dealId, questionId: input.questionId } },
      message: `Q${q.n} restored`,
    });
  },
});

/** An answer from a conversation becomes the question's response. Status stays as it is: a person sets that. */
export const UseAsResponse = define({
  name: 'UseAsResponse',
  input: z.object({ dealId: DealId, questionId: QuestionId, text: z.string().trim().min(1), sources: z.array(Source).default([]) }),
  targets: (s, i) => { const q = s.questions[i.questionId]; return q?.linkedFinding ? [i.questionId, q.linkedFinding] : [i.questionId]; },
  plan(state, input, ctx) {
    const q = state.questions[input.questionId];
    if (!q || q.dealId !== input.dealId) return fail(notFound('Question not found', input.questionId));
    const linked = q.linkedFinding ? state.findings[q.linkedFinding] : undefined;
    const r = setResponse(q, input.text, { origin: 'chat', sources: input.sources, actor: ctx.actor, at: ctx.at }, linked, { at: ctx.at, actor: ctx.actor });
    if (!r.ok) return r;
    const { draft: _d, ...rec } = r.value.question.record;
    const upserts: any[] = [{ kind: 'question', record: rec, expectedRev: q.rev }];
    const audit: any[] = r.value.question.audit.map((a) => ({ ...a, recordId: q.id, dealId: q.dealId }));
    if (r.value.finding && linked) { upserts.push({ kind: 'finding', record: r.value.finding.record, expectedRev: linked.rev }); audit.push(...r.value.finding.audit.map((a) => ({ ...a, recordId: linked.id, dealId: q.dealId, ref: { questionId: q.id } }))); }
    return ok({ dealId: q.dealId, upserts, audit, inverse: { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q, finding: r.value.finding && linked ? linked : null } }, message: q.response.trim() ? `Response to Q${q.n} replaced` : `Response recorded on Q${q.n}` });
  },
});
