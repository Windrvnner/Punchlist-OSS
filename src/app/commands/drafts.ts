/**
 * Drafts: the AI answers one question from the deal's documents. Two phases:
 *   RequestDraft  — commits a pending draft stamped with this operation's id, then runs the AI call as an effect
 *   ApplyDraft    — commits the result, but only if the question still carries that request id
 * so a late or superseded response can never land on a question that moved on. A draft remembers
 * the wording it answered; once the wording changes it is stale and can only be redrafted or discarded.
 */
import { fitText } from '../../domain/importExport';
import { z } from 'zod';
import { define } from '../command';
import { Question, QuestionId, DealId, Source, wordingHash , localYmd, Finding } from '../../domain/model';
import { setResponse, setQuestionStatus, isDraftStale } from '../../domain/transitions';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { CHANGED_ELSEWHERE } from '../changedElsewhere';

const Target = z.object({ dealId: DealId, questionId: QuestionId });

function liveQuestion(state: any, input: { dealId: string; questionId: string }) {
  const q: Question | undefined = state.questions[input.questionId];
  if (!q || q.dealId !== input.dealId) return null;
  return q;
}

/** Draft from Documents is offered, and RequestDraft accepts, only an open question with text. */
export const canRequestDraft = (q: Question) => q.status === 'open' && !!q.text.trim();

export const RequestDraft = define({
  name: 'RequestDraft',
  // the model is not the person's choice: drafts are routed (see ai.ts). A question with a response can be drafted: the draft
  // waits beside it and replaces it only when the person says so. `empty`: Draft all's request, for a
  // question with no response only; one saved while it waited is left alone
  input: Target.extend({ empty: z.boolean().optional() }),
  targets: (_s, i) => [i.questionId],
  plan(state, input, ctx) {
    const q = liveQuestion(state, input);
    if (!q) return fail(notFound('Question not found', input.questionId));
    if (input.empty && q.response.trim()) return fail(rejected('This question already has a response'));
    if (!canRequestDraft(q)) return fail(rejected(q.status !== 'open' ? 'Only an open question can be drafted'
      : 'Write the question first'));
    const next: Question = { ...q, draft: { status: 'pending', text: '', sources: [], forWording: wordingHash(q.text), opId: ctx.opId, at: ctx.at }, updatedAt: ctx.at };
    const { dealId, questionId } = input; const text = q.text; const requestOpId = ctx.opId;
    return ok({
      dealId: q.dealId,
      upserts: [{ kind: 'question', record: next, expectedRev: q.rev }],
      audit: [],
      effect: async (services) => {
        const r = await services.ai.draft({ dealId, questionId, questionText: text });
        return { command: 'ApplyDraft', input: { dealId, questionId, requestOpId, result: r.ok ? r.value : { status: 'failed', error: r.error.message } } };
      },
    });
  },
});

export const ApplyDraft = define({
  name: 'ApplyDraft',
  input: Target.extend({
    requestOpId: z.string(),
    result: z.union([
      z.object({ status: z.enum(['found', 'none']), text: z.string(), sources: z.array(Source) }),
      z.object({ status: z.literal('failed'), error: z.string().optional() }),
    ]),
  }),
  targets: (_s, i) => [i.questionId],
  plan(state, input, ctx) {
    const q = liveQuestion(state, input);
    if (!q) return ok({ upserts: [], audit: [] });                       // question gone: nothing to apply
    if (!q.draft || q.draft.opId !== input.requestOpId) return ok({ upserts: [], audit: [] }); // superseded request
    if (q.draft.status !== 'pending' && q.draft.status !== 'failed' && input.result.status !== 'failed') return ok({ upserts: [], audit: [] });   // already written (by another window of this PC, say): not written twice
    const r = input.result;
    const draft = r.status === 'failed'
      ? { ...q.draft, status: 'failed' as const }
      : { status: r.status, text: fitText(r.text), sources: r.sources, forWording: q.draft.forWording, opId: q.draft.opId };   // a draft longer than a response may be is cut at a sentence
    return ok({ dealId: q.dealId, upserts: [{ kind: 'question', record: { ...q, draft, updatedAt: ctx.at }, expectedRev: q.rev }], audit: [] });
  },
});

/**
 * Drafts left pending by a session that ended before the answer came back are retryable, not stuck. The store passes
 * every request it cannot be sure has ended (its own, another live window's, another PC's recent one) as live.
 */
export const RecoverDrafts = define({
  name: 'RecoverDrafts',
  input: z.object({ dealId: DealId, liveRequestIds: z.array(z.string()) }),
  targets: (s, i) => Object.values(s.questions as Record<string, Question>).filter((q) => q.dealId === i.dealId && q.draft?.status === 'pending' && !i.liveRequestIds.includes(q.draft.opId ?? '')).map((q) => q.id),
  plan(state, input, ctx) {
    const qs = Object.values(state.questions).filter((q) => q.dealId === input.dealId && q.draft?.status === 'pending' && !input.liveRequestIds.includes(q.draft.opId ?? ''));
    return ok({ dealId: input.dealId, upserts: qs.map((q) => ({ kind: 'question' as const, record: { ...q, draft: { ...q.draft!, status: 'failed' as const }, updatedAt: ctx.at }, expectedRev: q.rev })), audit: [] });
  },
});

export const DiscardDraft = define({
  name: 'DiscardDraft',
  input: Target,
  targets: (_s, i) => [i.questionId],
  plan(state, input, ctx) {
    const q = liveQuestion(state, input);
    if (!q) return fail(notFound('Question not found', input.questionId));
    if (!q.draft) return ok({ upserts: [], audit: [] });
    const { draft: _d, ...rest } = q;
    return ok({
      dealId: q.dealId,
      upserts: [{ kind: 'question', record: { ...rest, updatedAt: ctx.at }, expectedRev: q.rev }],
      audit: [],
      inverse: { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q } },
      message: 'Draft discarded',
    });
  },
});

/**
 * A person uses the draft as the response (in place of the one there, once they confirm): the question is answered from what we have. Response, provenance,
 * responder, date, status (answered, unless a person closed it meanwhile) and the linked finding's mark change in one transaction, and Undo puts the
 * whole question back. A question the documents do not answer stays open, to go to whoever can answer it.
 */
export const AcceptDraft = define({
    name: 'AcceptDraft',
    // `replace`: the person confirmed the draft goes in place of the response already there; Undo brings it back
    // `over`: the response the person confirmed replacing. One that changed since (a coworker's, synced in) is not replaced
    input: Target.extend({ replace: z.boolean().optional(), over: z.string().optional() }),
    targets: (s, i) => { const q = (s.questions as Record<string, Question>)[i.questionId]; return q?.linkedFinding ? [i.questionId, q.linkedFinding] : [i.questionId]; },
    plan(state, input, ctx) {
      const q = liveQuestion(state, input);
      if (!q) return fail(notFound('Question not found', input.questionId));
      if (!q.draft || q.draft.status !== 'found') return fail(rejected('There is no draft to take'));
      if (isDraftStale(q)) return fail(rejected('The question changed since this was drafted; draft it again'));
      if (q.response.trim() && !input.replace) return fail(rejected('This question already has a response'));
      if (input.over !== undefined && q.response !== input.over) return fail({ kind: 'conflict', message: CHANGED_ELSEWHERE });
      const linked = q.linkedFinding ? state.findings[q.linkedFinding] : undefined;
      const prov = { origin: 'ai' as const, sources: q.draft.sources, actor: ctx.actor, at: ctx.at };
      const r1 = setResponse(q, q.draft.text, prov, linked, { at: ctx.at, actor: ctx.actor });
      if (!r1.ok) return r1;
      const withResp: Question = { ...r1.value.question.record, respondedBy: ctx.firm, responded: localYmd(ctx.at) };
      // Only an open question is marked Answered. One a person closed while it was being drafted keeps the status they
      // set, and the draft is still theirs to take: a coworker's close never throws the work away.
      const r2 = q.status === 'open' ? setQuestionStatus(withResp, 'answered', { at: ctx.at, actor: ctx.actor }) : ok({ record: withResp, audit: [] });
      if (!r2.ok) return r2;
      const { draft: _d, ...final } = r2.value.record;
      const upserts: any[] = [{ kind: 'question', record: final, expectedRev: q.rev }];
      const audit: any[] = [...r1.value.question.audit, ...r2.value.audit].map((a) => ({ ...a, recordId: q.id, dealId: q.dealId }));
      if (r1.value.finding && linked) {
        upserts.push({ kind: 'finding', record: r1.value.finding.record, expectedRev: linked.rev });
        audit.push(...r1.value.finding.audit.map((a) => ({ ...a, recordId: linked.id, dealId: q.dealId, ref: { questionId: q.id } })));
      }
      return ok({
        dealId: q.dealId, upserts, audit,
        // the linked finding as it was, so Undo of a draft used in place of a response puts its mark back too
        inverse: { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q, finding: r1.value.finding && linked ? linked : null } },
        message: q.response.trim() ? `Response to Q${q.n} replaced` : `Response recorded on Q${q.n}`,
        alwaysSay: !!input.replace,   // the panel asks for a replace quietly, to say a refusal in its own words; the Undo is still offered   // as the side pane says it (sidePane.tsx)
      });
    },
});

/** Generic inverse: put a question back exactly as it was, reversing the linked finding's mark if the response changed. */
export const RestoreQuestionSnapshot = define({
  name: 'RestoreQuestionSnapshot',
  /** `finding`: the linked finding exactly as it was before the action being undone, or null when that action left it alone. Absent: the mark is worked out from the response, as before. */
  input: Target.extend({ snapshot: Question, finding: Finding.nullable().optional() }),
  targets: (s, i) => { const q = (s.questions as Record<string, Question>)[i.questionId]; return q?.linkedFinding ? [i.questionId, q.linkedFinding] : [i.questionId]; },
  plan(state, input, ctx) {
    const q = liveQuestion(state, input);
    if (!q) return fail(notFound('Question not found', input.questionId));
    const snap = input.snapshot;
    if (snap.id !== q.id || snap.dealId !== q.dealId) return fail(rejected('Snapshot does not match this question'));
    const upserts: any[] = [{ kind: 'question', record: { ...snap, rev: q.rev, updatedAt: ctx.at }, expectedRev: q.rev }];
    const audit: any[] = [{ kind: 'edited', recordId: q.id, dealId: q.dealId, text: 'Restored' }];
    const linked = q.linkedFinding ? state.findings[q.linkedFinding] : undefined;
    if (input.finding !== undefined) {
      if (input.finding && linked) { upserts.push({ kind: 'finding', record: { ...input.finding, rev: linked.rev, updatedAt: ctx.at }, expectedRev: linked.rev }); audit.push({ kind: 'edited', recordId: linked.id, dealId: q.dealId, text: 'Restored', ref: { questionId: q.id } }); }
    } else if (linked && !!q.response.trim() !== !!snap.response.trim()) {
      const r = setResponse(q, snap.response, snap.provenance, linked, { at: ctx.at, actor: ctx.actor });
      if (r.ok && r.value.finding) { upserts.push({ kind: 'finding', record: r.value.finding.record, expectedRev: linked.rev }); audit.push(...r.value.finding.audit.map((a) => ({ ...a, recordId: linked.id, dealId: q.dealId, ref: { questionId: q.id } }))); }
    }
    return ok({ dealId: q.dealId, upserts, audit, inverse: { command: 'RestoreQuestionSnapshot', input: { dealId: q.dealId, questionId: q.id, snapshot: q } } });
  },
});
