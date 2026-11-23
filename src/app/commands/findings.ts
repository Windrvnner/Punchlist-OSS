import { z } from 'zod';
import { fitParas } from '../../domain/importExport';
import { define } from '../command';
import { Finding, FindingId, DealId, Source, Tombstone, docKey, wordingHash } from '../../domain/model';
import { setFindingStatus, reviewFinding, checkFinding } from '../../domain/transitions';
import { ok, fail, notFound, rejected, invalid } from '../../domain/result';
import { keepAside, otherCopies, type ShownNote } from './keptVersions';

const Target = z.object({ dealId: DealId, findingId: FindingId });
const live = (state: any, i: { dealId: string; findingId: string }): Finding | null => { const f = state.findings[i.findingId]; return f && f.dealId === i.dealId ? f : null; };

/** the longest title a person can give a finding */
export const TITLE_MAX = 300;

export const CreateFinding = define({
  name: 'CreateFinding',
  input: z.object({
    dealId: DealId,
    title: z.string().trim().min(1, 'Give the finding a title')
      .max(TITLE_MAX, `Keep the title under ${TITLE_MAX} characters`),
    workstream: z.string().min(1, 'Choose a workstream'),
    body: z.array(z.string()).default([]),
    sources: z.array(Source).default([]),
    origin: z.enum(['chat', 'human']).default('human'),
  }),
  targets: () => [],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const id = ctx.ids.next('f');
    const f = Finding.parse({
      id, dealId: d.id, rev: 0, createdAt: ctx.at, updatedAt: ctx.at, title: input.title, workstream: input.workstream,
      raisedAt: ctx.at, body: input.body, sources: input.sources, origin: input.origin, raisedBy: ctx.actor,
    });
    const chk = checkFinding(f); if (!chk.ok) return chk;
    return ok({
      dealId: d.id,
      upserts: [{ kind: 'finding', record: f, expectedRev: null }],
      index: { dealId: d.id, add: [{ kind: 'finding', id }] },
      audit: [{ kind: 'created', recordId: id, dealId: d.id, text: f.title }],
      inverse: { command: 'DeleteFinding', input: { dealId: d.id, findingId: id } },
      message: 'Finding created',
    });
  },
});

/**
 * A person corrects a finding's own words: title, workstream, detail. Its status, its review
 * mark and its sources are not touched. Citation markers in the detail are kept as typed.
 */
export const EditFinding = define({
  name: 'EditFinding',
  input: Target.extend({
    title: z.string().trim().min(1, 'Give the finding a title'),
    workstream: z.string().min(1, 'Choose a workstream'),
    body: z.array(z.string()),
    /** the finding as the edit began: only fields the person changed from it are written, so a change made elsewhere
     *  meanwhile stays */
    base: z.object({ title: z.string(), workstream: z.string(), body: z.array(z.string()) }).optional(),
  }),
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return fail(notFound('Finding not found', input.findingId));
    // a title may not grow past the limit, but one already longer (written before the limit, or by the model) can still be edited
    if (input.title.length > TITLE_MAX && input.title.length > f.title.length) return fail(invalid(`Keep the title under ${TITLE_MAX} characters`, { title: `Keep the title under ${TITLE_MAX} characters` }));
    let body = input.body.map((b) => b.trim()).filter(Boolean);
    let title = input.title;
    let workstream = input.workstream;
    if (input.base) {
      // Field by field: left as it was when the edit began → keep what the finding holds now (a change made elsewhere stays);
      // changed here only → write it; changed here and differently elsewhere → refuse and say which, rather than one silently winning.
      const b = input.base; const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y); const clashes: string[] = [];
      const merge = <T,>(name: string, mine: T, was: T, now: T): T => { if (same(mine, was)) return now; if (!same(now, was) && !same(now, mine)) clashes.push(name); return mine; };
      title = merge('title', title, b.title, f.title); workstream = merge('workstream', workstream, b.workstream, f.workstream);
      body = merge('detail', body, b.body.map((x) => x.trim()).filter(Boolean), f.body);
      if (clashes.length) return fail(rejected(`The ${clashes.join(' and ')} changed elsewhere while you were editing. Cancel to see the latest, then make your change again`));
    }
    const changed = [
      title !== f.title && 'title',
      workstream !== f.workstream && 'workstream',
      JSON.stringify(body) !== JSON.stringify(f.body) && 'detail',
    ].filter(Boolean) as string[];
    if (!changed.length) return ok({ upserts: [], audit: [] });
    const record: Finding = {
      ...f, title, workstream, body, updatedAt: ctx.at,
      ...(changed.includes('detail') ? { ownWords: true } : {}),
      ...(changed.includes('title') ? { aiTitle: undefined } : {}),
      ...(changed.includes('workstream') ? { aiWorkstream: undefined } : {}),
    };
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'finding', record, expectedRev: f.rev }],
      audit: [{ kind: 'edited', recordId: f.id, dealId: f.dealId, text: `Edited ${changed.join(', ')}` }],
      inverse: { command: 'RestoreFindingSnapshot', input: { dealId: f.dealId, findingId: f.id, snapshot: f } },
      message: 'Finding edited',
    });
  },
});

/**
 * Two findings hold the same code (each was raised on a different PC before either saw the other). A person picks one
 * of them and it takes the next free code. Only a finding whose code is held twice can be given a new one.
 */

export const SetFindingStatus = define({
  name: 'SetFindingStatus',
  input: Target.extend({ status: z.enum(['open', 'closed']), note: z.string().optional() }),
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return fail(notFound('Finding not found', input.findingId));
    const r = setFindingStatus(f, input.status, input.note, { at: ctx.at, actor: ctx.actor });
    if (!r.ok) return r;
    if (!r.value.audit.length) return ok({ upserts: [], audit: [] });
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'finding', record: r.value.record, expectedRev: f.rev }],
      audit: r.value.audit.map((a) => ({ ...a, kind: a.kind as any, recordId: f.id, dealId: f.dealId })),
      inverse: { command: 'RestoreFindingSnapshot', input: { dealId: f.dealId, findingId: f.id, snapshot: f } },
      message: f.status !== input.status ? `Finding ${input.status === 'closed' ? 'closed' : 'reopened'}` : 'Note added',
    });
  },
});

export const ReviewFinding = define({
  name: 'ReviewFinding',
  input: Target.extend({ reviewed: z.boolean() }),
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return fail(notFound('Finding not found', input.findingId));
    const r = reviewFinding(f, input.reviewed, { at: ctx.at, actor: ctx.actor });
    if (!r.ok) return r;
    if (!r.value.audit.length) return ok({ upserts: [], audit: [] });
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'finding', record: r.value.record, expectedRev: f.rev }],
      audit: r.value.audit.map((a) => ({ ...a, kind: a.kind as any, recordId: f.id, dealId: f.dealId })),
      inverse: { command: 'ReviewFinding', input: { ...input, reviewed: !input.reviewed } },
      message: input.reviewed ? 'Finding marked reviewed' : 'Review cleared',
    });
  },
});

export const DeleteFinding = define({
  name: 'DeleteFinding',
  input: Target,
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return fail(notFound('Finding not found', input.findingId));
    const tomb = Tombstone.parse({ kind: 'finding', dealId: f.dealId, id: f.id, title: f.title, at: ctx.at, actor: ctx.actor, snapshot: f });
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'tombstone', record: tomb, expectedRev: null }],
      removes: [{ kind: 'finding', id: f.id, rev: f.rev }],
      index: { dealId: f.dealId, remove: [{ kind: 'finding', id: f.id }], add: [{ kind: 'tombstone', id: f.id }] },
      audit: [{ kind: 'deleted', recordId: f.id, dealId: f.dealId, text: f.title }],
      inverse: { command: 'RestoreFinding', input: { dealId: f.dealId, findingId: f.id } },
      message: 'Finding deleted',
    });
  },
});

export const RestoreFinding = define({
  name: 'RestoreFinding',
  // `copy`: as on RestoreQuestion
  input: Target.extend({ copy: z.string().optional() }),
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const t = state.tombstones[input.findingId] as ShownNote | undefined;
    if (!t || t.kind !== 'finding' || t.dealId !== input.dealId) return fail(notFound('Nothing to restore', input.findingId));
    const snap = input.copy ? t.copies?.find((c) => c.ver === input.copy)?.snapshot : t.snapshot;
    if (!snap) return fail(notFound('That copy is no longer here', input.findingId));
    const f = Finding.parse({ ...(snap as object), id: t.id, updatedAt: ctx.at });
    const others = keepAside('finding', f.dealId, f.id, otherCopies(t, f), [f], state.tombstones);
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'finding', record: f, expectedRev: null }, ...others.upserts],
      removes: [{ kind: 'tombstone', id: f.id, rev: null }],
      index: { dealId: f.dealId, add: [{ kind: 'finding', id: f.id }, ...others.ids.map((id) => ({ kind: 'tombstone' as const, id }))], remove: [{ kind: 'tombstone', id: f.id }] },
      audit: [{ kind: 'restored', recordId: f.id, dealId: f.dealId }],
      inverse: { command: 'DeleteFinding', input: { dealId: input.dealId, findingId: input.findingId } },
      message: 'Finding restored',
    });
  },
});

export const RestoreFindingSnapshot = define({
  name: 'RestoreFindingSnapshot',
  input: Target.extend({ snapshot: Finding }),
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return fail(notFound('Finding not found', input.findingId));
    if (input.snapshot.id !== f.id || input.snapshot.dealId !== f.dealId) return fail(rejected('Snapshot does not match this finding'));
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'finding', record: { ...input.snapshot, rev: f.rev, updatedAt: ctx.at }, expectedRev: f.rev }],
      audit: [{ kind: 'edited', recordId: f.id, dealId: f.dealId, text: 'Restored' }],
      inverse: { command: 'RestoreFindingSnapshot', input: { dealId: f.dealId, findingId: f.id, snapshot: f } },
    });
  },
});

/**
 * What an update starts from. The model reads the finding as it is when the update is asked for, so whatever a person or
 * another PC does to it while the update runs is news the update has not read: it is compared against this when the reply lands.
 */
const From = z.object({
  body: z.array(z.string()), reviewed: z.any(),
  /** the sources then: one that is there when the reply lands and was not here was added meanwhile */
  sources: z.array(Source),
  /** the "May be out of date" mark then, and the responses on the finding's questions then, each as one string to compare */
  mark: z.string(), responses: z.string(),
});
const markOf = (f: Finding) => JSON.stringify([f.updated, f.updatedWhy, f.updatedOn ?? null]);
/** The responses on the questions linked to a finding (a question asked, with no response yet, is nothing to read). A reworded response leaves a mark that already names its question as it is, so the mark alone would not show it. */
const responsesOn = (state: { questions: Record<string, { id: string; dealId: string; linkedFinding?: string; response: string }> }, f: Finding) =>
  Object.values(state.questions).filter((q) => q.dealId === f.dealId && q.linkedFinding === f.id && q.response.trim()).map((q) => `${q.id}:${wordingHash(q.response)}`).sort().join(' ');
const startOf = (state: Parameters<typeof responsesOn>[0], f: Finding): z.infer<typeof From> => ({ body: f.body, reviewed: f.reviewed ?? null, sources: f.sources, mark: markOf(f), responses: responsesOn(state, f) });

/** Reassess: the model re-reads the finding against the documents and responses now in the deal. Two phases like drafts. */
export const Reassess = define({
  name: 'Reassess',
  input: Target,
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return fail(notFound('Finding not found', input.findingId));
    const { dealId, findingId } = input; const requestOpId = ctx.opId;
    const from = startOf(state, f);
    return ok({
      dealId: f.dealId, upserts: [], audit: [],
      effect: async (services) => {
        const r = await services.ai.reassess({ dealId, findingId });
        return { command: 'ApplyReassessment', input: { dealId, findingId, requestOpId, from, result: r.ok ? r.value : { error: 'Couldn’t update the finding. Nothing was changed.' } } };
      },
    });
  },
});

/**
 * The reply lands. It replaces the finding's words and the sources they cite, and nothing a person did while it ran:
 * words or a review changed meanwhile, or a finding closed meanwhile, and nothing is replaced; a source added meanwhile stays;
 * and the "May be out of date" mark stays when anything arrived that the update did not read, so the next update reads it.
 */
export const ApplyReassessment = define({
  name: 'ApplyReassessment',
  input: Target.extend({ requestOpId: z.string(), from: From.optional(), result: z.union([z.object({ body: z.array(z.string()), sources: z.array(Source) }), z.object({ error: z.string() })]) }),
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return ok({ upserts: [], audit: [] });
    if ('error' in input.result) return fail({ kind: 'failed', message: input.result.error });
    // Only an open finding is updated from the documents. One a person closed while the update ran stays as they closed it
    // (and the Undo on "Finding closed" still works); its mark stays, so the closed finding offers Reopen as any marked one does.
    // Both refusals are said as 'failed': this runs as the update's follow-up, which says only a failure, and the person
    // pressed the button and waited, so the update ending with no word would read as one that did nothing.
    if (f.status !== 'open') return fail({ kind: 'failed', message: 'Not updated: the finding was closed meanwhile' });
    // someone changed the words or the review while the update ran: their work is not replaced; the update can be run again
    if (input.from && (JSON.stringify(f.body) !== JSON.stringify(input.from.body) || JSON.stringify(f.reviewed ?? null) !== JSON.stringify(input.from.reviewed ?? null)))
      return fail({ kind: 'failed', message: 'Not updated: the finding was changed meanwhile' });
    // A review is of the words that were read. When the update replaces them, the review no longer applies and is
    // cleared with it (the person pressed the button; Undo puts both back). An update that leaves the words as they
    // were leaves the review standing.
    const reworded = JSON.stringify(f.body) !== JSON.stringify(input.result.body); const cleared = reworded && f.reviewed ? f.reviewed : null;
    // Sources a person added while the update ran. They go after the reply's own, so the [n] markers in the new words still
    // point at the sources they cite; one the reply cites too is listed once.
    const was = input.from?.sources.map((x) => JSON.stringify(x)); const cited = new Set(input.result.sources.map(docKey));
    const added = was ? f.sources.filter((x) => !was.includes(JSON.stringify(x))) : []; const unread = added.filter((x) => !cited.has(docKey(x)));
    const sources = input.result.sources.length ? [...input.result.sources, ...unread] : f.sources;
    // The mark is cleared only when nothing arrived while the update ran that it has not read: a mark set or changed meanwhile,
    // a source added that the reply does not cite, or a response on one of the finding's questions given, reworded or removed
    // (this only keeps a mark: one cleared meanwhile, as an emptied response clears its own, stays cleared; #328).
    // A document the reply cites it has read, so the mark that attaching it set (its last change) does not count.
    const fromCited = added.some((x) => cited.has(docKey(x)) && markOf(f) === JSON.stringify([true, `${x.doc} attached`, null]));
    const news = !!input.from && ((markOf(f) !== input.from.mark && !fromCited) || unread.length > 0 || responsesOn(state, f) !== input.from.responses);
    const mark = f.updated && news ? {} : { updated: false, updatedWhy: '', updatedOn: undefined };
    const next: Finding = { ...f, body: fitParas(input.result.body), sources, ownWords: reworded ? undefined : f.ownWords, ...mark, updatedAt: ctx.at, ...(cleared ? { reviewed: null } : {}) };
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'finding', record: next, expectedRev: f.rev }],
      audit: [{ kind: 'reassessed', recordId: f.id, dealId: f.dealId, from: f.body, to: input.result.body }, ...(cleared ? [{ kind: 'unreviewed' as const, recordId: f.id, dealId: f.dealId, from: cleared }] : [])],
      inverse: { command: 'RestoreFindingSnapshot', input: { dealId: f.dealId, findingId: f.id, snapshot: f } },
      message: cleared ? 'Finding updated · review cleared' : 'Finding updated',
    });
  },
});

/**
 * The "May be out of date" mark after a document is attached. A mark set for another reason (a check, a cited document
 * gone from the data room) is left as it is, as a response leaves one (transitions.ts): the next update must still read
 * it, and an update running now must not take the document's mark for the only news (#327). A mark from responses, an
 * earlier attach's, or none gives way to the document's: responses and added sources are compared on their own when an
 * update lands.
 */
function attachMark(finding: Finding, doc: string): Pick<Finding, 'updated' | 'updatedWhy' | 'updatedOn'> {
  const ownReason = finding.updated && !finding.updatedOn && !attachedReason(finding);
  if (ownReason) return { updated: true, updatedWhy: finding.updatedWhy, updatedOn: undefined };
  return { updated: true, updatedWhy: `${doc} attached`, updatedOn: undefined };
}

/** whether the finding's mark is the one attaching one of its sources set */
const attachedReason = (finding: Finding) =>
  finding.sources.some((source) => finding.updatedWhy === `${source.doc} attached`);

/** A document a person attached to a finding: it joins the finding's sources and offers a reassessment. */
export const AttachDocumentToFinding = define({
  name: 'AttachDocumentToFinding',
  input: Target.extend({ doc: z.string().min(1), docId: z.string().min(1) }),
  targets: (_s, i) => [i.findingId],
  plan(state, input, ctx) {
    const f = live(state, input);
    if (!f) return fail(notFound('Finding not found', input.findingId));
    if (f.sources.some((x) => docKey(x) === docKey(input))) return ok({ upserts: [], audit: [] });   // the same document, not merely the same name
    const sources = [...f.sources, { doc: input.doc, loc: '', docId: input.docId }];
    const next: Finding = { ...f, sources, ...attachMark(f, input.doc), updatedAt: ctx.at };
    return ok({
      dealId: f.dealId,
      upserts: [{ kind: 'finding', record: next, expectedRev: f.rev }],
      audit: [{ kind: 'document', recordId: f.id, dealId: f.dealId, text: `${input.doc} attached`, ref: { doc: input.doc } }],
      inverse: { command: 'RestoreFindingSnapshot', input: { dealId: f.dealId, findingId: f.id, snapshot: f } },
      message: `${input.doc} added to the finding’s sources`,
    });
  },
});
