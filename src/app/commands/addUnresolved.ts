/**
 * "Add all unresolved to Q&A" (linking design, section 13): the questions a person kept from the preview, each linked to
 * its checklist item or finding, and the open questions they chose to link instead, written as one change with one Undo.
 * Everything is read again here, just before writing: a point someone has asked about since, an item no longer a gap, a
 * question answered or linked since, an item or finding no longer on the deal, or one point asked twice in the change
 * stops the whole change, and the refusal names it.
 */
import { z } from 'zod';
import { define, type Upsert, type AuditDraft } from '../command';
import { Question, DealId, QuestionId, FindingId } from '../../domain/model';
import { numbering } from './questions';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { dealQuestions, nextQuestionNumber, itemStanding, unresolvedTargets, type State } from '../state';
import { canLinkUnresolved, isApprovedLink } from '../unresolvedLinks';
import type { ChecklistRow } from '../../ports';

const Link = z.object({ linkedItem: z.string().min(1).optional(), linkedFinding: FindingId.optional() }).refine((x) => !!x.linkedItem || !!x.linkedFinding, 'A question here is for an item or a finding');
const onChecklist = (state: State, dealId: string, id: string) => (state.items[id] ? state.items[id].dealId === dealId : (Array.isArray(state.checklists[dealId]) && (state.checklists[dealId] as { id: string }[]).some((r) => r.id === id)));

type ChosenLink = { questionId: string; linkedItem?: string; linkedFinding?: string; approval?: string };
export const UNRESOLVED_LINK_CHANGED = 'A chosen link changed since, so nothing was added. Review the link again.';

function approvedLinksStillMatch(state: State, dealId: string, questions: Question[], links: ChosenLink[]) {
  if (!links.length) return true;
  const points = new Map(unresolvedTargets(state, dealId, questions).map((point) => [point.key, point]));
  return links.every((link) => {
    if (!link.approval || (!!link.linkedItem === !!link.linkedFinding)) return false;
    const point = points.get(link.linkedFinding ? 'f:' + link.linkedFinding : 'i:' + link.linkedItem);
    const q = state.questions[link.questionId];
    return !!point && q?.dealId === dealId && canLinkUnresolved(q, !!state.conflicts[q.id])
      && isApprovedLink({ point, q }, { questionId: link.questionId, fingerprint: link.approval });
  });
}

export const AddUnresolved = define({
  name: 'AddUnresolved',
  input: z.object({
    dealId: DealId,
    add: z.array(z.object({ text: z.string().min(1), workstream: z.string().default('') }).and(Link)),
    link: z.array(z.object({ questionId: QuestionId, approval: z.string().optional() }).and(Link)),
  }).refine((x) => x.add.length + x.link.length > 0, 'Nothing to add'),
  targets: (_state, input) => [numbering(input.dealId), ...input.link.flatMap((link) => [
    link.questionId, ...(link.linkedFinding ? [link.linkedFinding] : []), ...(link.linkedItem ? [link.linkedItem] : []),
  ])],
  async prepare(store, input, { retained }) {
    if (retained && input.link.length) await store.refreshChecklist(input.dealId);
  },
  plan(state, input, ctx) {
    const d = state.deals[input.dealId]; if (!d) return fail(notFound('Deal not found', input.dealId));
    const qs = dealQuestions(state, d.id);
    if (!approvedLinksStillMatch(state, d.id, qs, input.link)) return fail(rejected(UNRESOLVED_LINK_CHANGED));
    const linking = new Set(input.link.map((l) => l.questionId));
    // asked about already, by a question that is not one this change links
    const asked = (l: { linkedItem?: string; linkedFinding?: string }) => qs.find((q) => !linking.has(q.id) && ((!!l.linkedItem && q.linkedItem?.id === l.linkedItem) || (!!l.linkedFinding && q.linkedFinding === l.linkedFinding)));
    const name = (l: { linkedItem?: string; linkedFinding?: string }) => (l.linkedFinding ? `“${state.findings[l.linkedFinding]?.title ?? 'a finding'}”` : `“${(Array.isArray(state.checklists[d.id]) ? (state.checklists[d.id] as { id: string; text: string }[]).find((r) => r.id === l.linkedItem)?.text : state.items[l.linkedItem!]?.text) ?? 'an item'}”`);
    for (const l of [...input.add, ...input.link]) {
      if (l.linkedFinding && (state.findings[l.linkedFinding]?.dealId !== d.id || state.findings[l.linkedFinding].status !== 'open')) return fail(rejected(`${name(l)} is no longer an open finding on this deal`));
      if (l.linkedItem && !onChecklist(state, d.id, l.linkedItem)) return fail(notFound('An item is no longer on this deal’s checklist', l.linkedItem));
    }
    // one question per point: a new question and a link, or two of either, for the same item or finding would ask it twice
    const seen = new Set<string>();
    for (const l of [...input.add, ...input.link]) for (const k of [l.linkedItem && 'i:' + l.linkedItem, l.linkedFinding && 'f:' + l.linkedFinding]) {
      if (!k) continue; if (seen.has(k)) return fail(rejected(`${name(l)} is asked about twice in this change`)); seen.add(k);
    }
    if (new Set(input.link.map((l) => l.questionId)).size !== input.link.length) return fail(rejected('A question is linked twice in this change'));
    // an item must still be a gap as the checklist was last read (the dialog reads it again just before this): one a document settled since is not asked about
    const rows = Array.isArray(state.checklists[d.id]) ? state.checklists[d.id] as ChecklistRow[] : [];
    for (const l of [...input.add, ...input.link]) {
      if (!l.linkedItem || l.linkedFinding) continue; const r = rows.find((x) => x.id === l.linkedItem);
      if (!r || itemStanding(state, d.id, r).kind !== 'gap') return fail(rejected(`${name(l)} is no longer a gap`));
    }
    for (const l of input.add) { const q = asked(l); if (q) return fail(rejected(`Q${q.n} was asked about ${name(l)} since`)); }
    const upserts: Upsert[] = []; const audit: AuditDraft[] = []; const created: string[] = []; const before: Question[] = [];
    let n = nextQuestionNumber(state, d.id);
    for (const a of input.add) {
      const id = ctx.ids.next('q'); created.push(id);
      upserts.push({ kind: 'question', expectedRev: null, record: Question.parse({
        id, dealId: d.id, rev: 0, createdAt: ctx.at, updatedAt: ctx.at, n: n++, text: a.text, workstream: a.workstream, askedBy: ctx.firm, priority: 'High',
        ...(a.linkedFinding ? { linkedFinding: a.linkedFinding } : {}), ...(a.linkedItem ? { linkedItem: { id: a.linkedItem } } : {}),
      }) });
      audit.push({ kind: 'created', recordId: id, dealId: d.id });
    }
    for (const l of input.link) {
      const q = state.questions[l.questionId];
      if (!q || q.dealId !== d.id) return fail(notFound('A question is no longer here', l.questionId));
      if (q.status !== 'open' || q.response.trim() || q.linkedItem || q.linkedFinding) return fail(rejected(`Q${q.n} was answered or linked since`));
      before.push(q);
      upserts.push({ kind: 'question', expectedRev: q.rev, record: { ...q, ...(l.linkedFinding ? { linkedFinding: l.linkedFinding } : {}), ...(l.linkedItem ? { linkedItem: { id: l.linkedItem } } : {}), updatedAt: ctx.at } });
      audit.push({ kind: 'edited', recordId: q.id, dealId: d.id, field: l.linkedItem ? 'linkedItem' : 'linkedFinding', to: l.linkedItem ?? l.linkedFinding });
    }
    const said = [input.add.length && `${input.add.length.toLocaleString('en-US')} question${input.add.length === 1 ? '' : 's'} added`, input.link.length && `${input.link.length.toLocaleString('en-US')} linked`].filter(Boolean).join(' · ');
    return ok({
      dealId: d.id, upserts, audit,
      index: created.length ? { dealId: d.id, add: created.map((id) => ({ kind: 'question' as const, id })) } : undefined,
      inverse: { command: 'RevertImport', input: { dealId: d.id, created, restore: before, findings: [], said: 'Questions taken back' } },
      message: said,
    });
  },
});
