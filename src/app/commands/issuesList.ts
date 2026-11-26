/**
 * Import an issues list into a deal's Findings as one transaction. Each point becomes a finding, in the list's
 * words, unless the person let it join a finding already raised (`join`) or the finding of an earlier point (`after`).
 * Every finding a point is on, new or joined, is marked with the point (`onLists`), shown as "#N on issues list".
 * Undo removes the findings the import made and takes off the marks it added, and nothing else.
 */
import { z } from 'zod';
import { define, type Upsert, type AuditDraft } from '../command';
import type { State } from '../state';
import { Finding, DealId, FindingId, ListPoint, Tombstone } from '../../domain/model';
import { checkFinding } from '../../domain/transitions';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { derivedId } from '../../domain/derivedId';
import { key as wording, sha256Hex } from '../../domain/checklist';
import { issuesListDestinations } from '../issuesListJoins';

/** what a finding's history says when an import marks it: its page leaves it out of the last change, as the mark itself says it */
export const LISTED = 'Issues list imported';
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
/** text kept as given, its edge spaces included; one that is all white space says nothing and is refused (#1059) */
const Given = z.string().refine((value) => value.trim() !== '', 'Nothing written');
const Point = z.object({
  n: z.string().min(1),
  text: Given,
  title: Given,
  workstream: z.string(),
  join: FindingId.optional(),
  after: z.number().int().nonnegative().optional(),
  /** the person checked it: its own finding, whatever it repeats */
  own: z.boolean().optional(),
});
/**
 * a mark is the same mark when it names the same point of the same list in the same words: a list may number two points
 * alike. The list is its file's id, not its name: a revised list saved under the same name is another list.
 */
const sameMark = (a: { doc: string; n: string; text?: string }, b: { doc: string; n: string; text?: string }) => a.doc === b.doc && a.n === b.n && (a.text === undefined || b.text === undefined || wording(a.text) === wording(b.text));

/**
 * A new finding's id, made from the point it comes from: the deal, the list's file id, the point's number and its
 * words (as checklist wording is compared), and how many findings this point already made. Two PCs that import the same
 * list before either has the other's make the same records, so the deal holds each point once, not twice. The count
 * goes up past any id the deal already holds, live or deleted, or that this import has just made: a point a person
 * keeps as its own finding twice over, or brings in again after deleting its finding, is a new finding.
 */
function pointId(state: { findings: Record<string, unknown>; tombstones: Record<string, unknown> }, dealId: string, m: ListPoint, made: Map<string, unknown>): string {
  for (let k = 0; ; k++) { const id = derivedId('f', [dealId, m.doc, m.n, wording(m.text), String(k)]); if (!state.findings[id] && !state.tombstones[id] && !made.has(id)) return id; }
}

export const ImportIssuesList = define({
  name: 'ImportIssuesList',
  // the list: `doc`, its file's id (as the documents service gives it, from the file's bytes), and `list`, its file's name
  input: z.object({ dealId: DealId, doc: z.string().min(1), list: Given, points: z.array(Point).min(1, 'Nothing to import') }),
  targets: (_s, i) => [...new Set(i.points.flatMap((p) => (p.join ? [p.join] : [])))],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const work = new Map<string, Finding>(); const created: string[] = []; const of: string[] = []; const audit: AuditDraft[] = [];
    let joined = 0;
    const findings = Object.values(state.findings).filter((finding) => finding.dealId === d.id);
    const destinations = issuesListDestinations(findings, { docId: input.doc, doc: input.list }, input.points);
    for (const [k, p] of input.points.entries()) {
      if (p.after !== undefined && p.after >= k) return fail(rejected(`Point ${p.n} joins a point after it`));
      const { text, goes } = destinations[k];
      const mark: ListPoint = { doc: input.doc, list: input.list, n: p.n, text, at: ctx.at };
      const id = typeof goes === 'number' ? of[goes] : goes?.id;
      if (id) {
        const f = work.get(id) ?? state.findings[id];
        if (!(f.onLists ?? []).some((m) => sameMark(m, mark))) work.set(id, { ...f, onLists: [...(f.onLists ?? []), mark], updatedAt: ctx.at });
        of.push(id); joined++; continue;
      }
      // a new finding. All are raised at the same moment, a millisecond apart, so that the list, newest first, keeps the list's order
      const at = new Date(Date.parse(ctx.at) - k).toISOString(); const fid = pointId(state, d.id, mark, work);
      const f = Finding.parse({ id: fid, dealId: d.id, rev: 0, createdAt: ctx.at, updatedAt: ctx.at, title: p.title, workstream: p.workstream, raisedAt: at, body: [mark.text], origin: 'human', raisedBy: ctx.actor, onLists: [mark], aiTitle: true, aiWorkstream: true });
      const chk = checkFinding(f); if (!chk.ok) return chk;
      work.set(fid, f); created.push(fid); of.push(fid);
      audit.push({ kind: 'created', recordId: fid, dealId: d.id, text: f.title });
    }
    const upserts: Upsert[] = []; const marked: { findingId: string; marks: { doc: string; list: string; n: string }[] }[] = [];
    for (const f of work.values()) {
      if (created.includes(f.id)) { upserts.push({ kind: 'finding', record: f, expectedRev: null }); continue; }
      const was = state.findings[f.id]; const added = (f.onLists ?? []).filter((m) => !(was.onLists ?? []).some((x) => sameMark(x, m)));
      upserts.push({ kind: 'finding', record: f, expectedRev: was.rev }); marked.push({ findingId: f.id, marks: added.map((m) => ({ doc: m.doc, list: m.list, n: m.n, text: m.text, at: m.at })) });
      audit.push({ kind: 'edited', recordId: f.id, dealId: d.id, text: LISTED });
    }
    if (!upserts.length) return ok({ upserts: [], audit: [], message: 'Every point is already on its finding' });
    return ok({
      dealId: d.id, upserts, audit,
      index: created.length ? { dealId: d.id, add: created.map((id) => ({ kind: 'finding' as const, id })) } : undefined,
      inverse: { command: 'RevertIssuesList', input: { dealId: d.id, created, marked } },
      message: `Imported ${plural(created.length, 'finding')} · ${joined.toLocaleString('en-US')} already raised`,
    });
  },
});

/** Undo of an import: its findings go (not to Recently deleted: they were never anyone's work but the import's), and its marks come off. */
export const RevertIssuesList = define({
  name: 'RevertIssuesList',
  input: z.object({ dealId: DealId, created: z.array(FindingId), marked: z.array(z.object({ findingId: FindingId, marks: z.array(z.object({ doc: z.string(), list: z.string(), n: z.string(), text: z.string().optional(), at: z.string().optional() })) })) }),
  targets: (_s, i) => [...i.created, ...i.marked.map((m) => m.findingId)],
  plan(state, input, ctx) {
    const upserts: Upsert[] = []; const removes = [];
    // a question raised on an imported finding since would be left linked to nothing: the import stays, and says why
    const gone = new Set(input.created); const linked = Object.values(state.questions).find((q) => q.linkedFinding && gone.has(q.linkedFinding));
    if (linked) return fail(rejected(`Q${linked.n} is linked to an imported finding`));
    for (const id of input.created) { const f = state.findings[id]; if (f) removes.push({ kind: 'finding' as const, id, rev: f.rev, undoesImport: true as const }); }   // undoesImport: another PC's import of it stands
    for (const m of input.marked) {
      const f = state.findings[m.findingId]; if (!f) continue;
      const left = (f.onLists ?? []).filter((x) => !m.marks.some((y) => sameMark(x, y)));
      if (left.length !== (f.onLists ?? []).length) upserts.push({ kind: 'finding', record: { ...f, onLists: left.length ? left : undefined, updatedAt: ctx.at }, expectedRev: f.rev });
    }
    return ok({
      dealId: input.dealId, upserts, removes,
      index: removes.length ? { dealId: input.dealId, remove: removes.map((r) => ({ kind: 'finding' as const, id: r.id })) } : undefined,
      audit: [...removes.map((r) => ({ kind: 'deleted' as const, recordId: r.id, dealId: input.dealId, text: 'Import reverted' })), ...upserts.map((u) => ({ kind: 'edited' as const, recordId: u.record.id, dealId: input.dealId, text: 'Import reverted' }))],
      message: 'Import reverted',
    });
  },
});

/**
 * Remove an issues list from a deal, long after its notice has gone. Each finding the list made that
 * nobody has touched since (still at its first version, open, with no question linked) goes to Deleted, from where it can
 * be restored; its marks go with it. The list's marks come off the findings its points joined. A finding the list made
 * that someone has changed since stays as it is, mark and all, and the notice counts it: nothing a person did is lost.
 * The list is named by its file's id (`doc`), so another list saved under the same name is left as it is.
 */
export const RemoveIssuesList = define({
  name: 'RemoveIssuesList',
  // Older journal entries still parse, but a retry needs the original approval.
  input: z.object({ dealId: DealId, doc: z.string().min(1), approvedImpact: z.string().optional() }),
  targets: (s, i) => Object.values(s.findings).filter((f) => f.dealId === i.dealId && (f.onLists ?? []).some((m) => m.doc === i.doc)).map((f) => f.id),
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const parts = removable(state, d.id, input.doc);
    if (staleApproval(state, ctx.opId, input, parts)) {
      return fail(rejected('This issues list changed. Review it again before removing it.'));
    }
    if (!parts.made.length && !parts.joined.length) return fail(rejected('Nothing of this list is left to remove'));
    const upserts: Upsert[] = []; const removes = []; const audit: AuditDraft[] = [];
    for (const f of parts.made) {
      upserts.push({ kind: 'tombstone', record: Tombstone.parse({ kind: 'finding', dealId: d.id, id: f.id, title: f.title, at: ctx.at, actor: ctx.actor, snapshot: f, removedWith: input.doc }), expectedRev: null });
      removes.push({ kind: 'finding' as const, id: f.id, rev: f.rev });
      audit.push({ kind: 'deleted', recordId: f.id, dealId: d.id, text: f.title });
    }
    const marked = parts.joined.map((f) => ({ findingId: f.id, marks: listMarks(f, input.doc) }));
    for (const f of parts.joined) {
      const left = (f.onLists ?? []).filter((m) => m.doc !== input.doc);
      upserts.push({ kind: 'finding', record: { ...f, onLists: left.length ? left : undefined, updatedAt: ctx.at }, expectedRev: f.rev });
      audit.push({ kind: 'edited', recordId: f.id, dealId: d.id, text: 'Issues list removed' });
    }
    const made = parts.made.map((f) => f.id);
    return ok({
      dealId: d.id, upserts, removes, audit, ...approvedSet(state, d.id, upserts),
      index: made.length ? { dealId: d.id, remove: made.map((id) => ({ kind: 'finding' as const, id })), add: made.map((id) => ({ kind: 'tombstone' as const, id })) } : undefined,
      inverse: { command: 'RestoreIssuesList', input: { dealId: d.id, made, marked, doc: input.doc } }, undoesSafely: true,
      message: `Removed ${plural(made.length, 'finding')}${parts.kept ? ` · ${plural(parts.kept, 'finding')} kept, changed since` : ''}`,
    });
  },
});

/** Whether the approval no longer matches the list, or a retry has none to match (#410). */
function staleApproval(state: State, opId: string, input: { dealId: string; doc: string; approvedImpact?: string },
  parts: ReturnType<typeof removable>) {
  if (input.approvedImpact === undefined) return state.ops[opId]?.command === 'RemoveIssuesList';
  return input.approvedImpact !== removalImpact(input.dealId, input.doc, parts);
}

/**
 * The approval covers every finding of the deal, not only those the removal writes: a peer's mark added to another
 * finding, or a new finding that carries the list, changes what was approved. Findings not written are held at their
 * rev, and the set of findings must be the same at commit, so the store plans again on the newer state (#410).
 */
function approvedSet(state: State, dealId: string, upserts: Upsert[]) {
  const written = new Set(upserts.map(({ record }) => record.id));
  const all = Object.values(state.findings).filter((finding) => finding.dealId === dealId);
  return {
    expects: all.filter(({ id }) => !written.has(id)).map(({ id, rev }) => ({ kind: 'finding' as const, id, rev })),
    expectsMembers: { dealId, kind: 'finding' as const, ids: all.map(({ id }) => id) },
  };
}

const listMarks = (finding: Finding, doc: string) => (finding.onLists ?? []).filter((mark) => mark.doc === doc);

function impactRows(findings: Finding[], doc: string) {
  return findings.map((finding) => {
    const marks = listMarks(finding, doc).map((mark) => JSON.stringify([mark.list, mark.n, mark.text, mark.at]));
    return [finding.id, marks.sort()] as const;
  }).sort(([left], [right]) => left.localeCompare(right));
}

/** Binds confirmation to the file, deal, exact findings, and list marks, regardless of row order (#410). */
export function removalImpact(
  dealId: string, doc: string, parts: Pick<ReturnType<typeof removable>, 'made' | 'joined'>,
) {
  return sha256Hex(JSON.stringify([dealId, doc, impactRows(parts.made, doc), impactRows(parts.joined, doc)]));
}

/**
 * Undo of a removal: the findings come back from Deleted, and the marks go back on the findings they were taken off. It
 * goes record by record, so a change since to one of them (on another PC, say) does not stop the rest: a finding
 * put back meanwhile, or deleted again since by a person, is left as it is, and a mark goes back on the
 * finding as it now is.
 */
export const RestoreIssuesList = define({
  name: 'RestoreIssuesList',
  input: z.object({ dealId: DealId, made: z.array(FindingId), marked: z.array(z.object({ findingId: FindingId, marks: z.array(ListPoint) })), /** the list removed, by its file's id: a finding deleted any other way since is a person's own delete */ doc: z.string().optional() }),
  targets: (_s, i) => [...i.made, ...i.marked.map((m) => m.findingId)],
  plan(state, input, ctx) {
    const upserts: Upsert[] = []; const removes = []; const back: string[] = []; const remarked: string[] = [];
    const torn = [...input.made, ...input.marked.map((m) => m.findingId)].filter((id) => state.conflicts[id]).length;
    for (const id of input.made) {
      // put back meanwhile, deleted again since by a person, or in two versions (changed on another PC before the removal reached it): left for a person
      const t = state.tombstones[id]; if (!t || t.kind !== 'finding' || t.dealId !== input.dealId || (input.doc && t.removedWith !== input.doc) || state.conflicts[id]) continue;
      upserts.push({ kind: 'finding', record: Finding.parse(t.snapshot), expectedRev: null });   // as it was: putting it back is not a change to it
      removes.push({ kind: 'tombstone' as const, id, rev: null }); back.push(id);
    }
    for (const m of input.marked) {
      const f = state.findings[m.findingId]; if (!f || state.conflicts[f.id]) continue;
      const add = m.marks.filter((x) => !(f.onLists ?? []).some((y) => sameMark(x, y))); if (!add.length) continue;
      upserts.push({ kind: 'finding', record: { ...f, onLists: [...(f.onLists ?? []), ...add], updatedAt: ctx.at }, expectedRev: f.rev }); remarked.push(f.id);
    }
    // nothing it could put back (another PC's removal, say, already undone, or every finding put back by hand): said so, not "restored"
    if (!back.length && !remarked.length) return fail(rejected(torn ? `Its findings have two versions. Choose one first` : 'Nothing of this list is left to put back'));
    return ok({
      dealId: input.dealId, upserts, removes,
      index: back.length ? { dealId: input.dealId, add: back.map((id) => ({ kind: 'finding' as const, id })), remove: back.map((id) => ({ kind: 'tombstone' as const, id })) } : undefined,
      audit: [...back.map((id) => ({ kind: 'restored' as const, recordId: id, dealId: input.dealId })), ...remarked.map((id) => ({ kind: 'edited' as const, recordId: id, dealId: input.dealId, text: LISTED }))],
      message: `Restored ${plural(back.length, 'finding')}${torn ? ` · ${plural(torn, 'finding')} in two versions, to choose first` : ''}`,
    });
  },
});

/**
 * What removing a list (by its file's id) would do: the findings it made that nobody has touched since (made), the findings its points
 * joined (joined), how many it made that someone has changed since (kept), and how many of its points joined a finding
 * already raised (raised: its marks less the findings it made, as the import's notice counts them), and when it was brought
 * in (at: the earliest time on its marks). A finding is the list's own when its id
 * is the one the list's first point on it gives (pointId); untouched, when it is still as the import made it (the model's
 * title and workstream, the point's words, open, nothing added, on no other list, and never changed since: closed and
 * reopened is a change) and no question is linked to it nor conversation held on it. Its version is not looked at,
 * so a finding the removal's Undo put back can be removed again.
 */
/** whether the finding's id is the one its first point gives: the list made it. Kept per record, as the ids are hashes */
const madeOf = new WeakMap<Finding, boolean>();
const madeBy = (f: Finding) => {
  let own = madeOf.get(f); if (own !== undefined) return own;
  const m = f.onLists![0]; own = false; for (let k = 0; !own && k < 10; k++) own = derivedId('f', [f.dealId, m.doc, m.n, wording(m.text), String(k)]) === f.id;
  madeOf.set(f, own); return own;
};
const asMade = (f: Finding) => f.updatedAt === f.createdAt && f.aiTitle === true && f.aiWorkstream === true
  && f.status === 'open' && !f.reviewed && !f.updated && !f.ownWords && !f.note && !f.sources.length
  && f.body.length === 1 && f.body[0] === f.onLists![0].text && f.onLists!.every((m) => m.doc === f.onLists![0].doc);
export function removable(state: { findings: Record<string, Finding>; questions: Record<string, { linkedFinding?: string }>; threads?: Record<string, unknown[]> }, dealId: string, doc: string) {
  const linked = new Set(Object.values(state.questions).flatMap((q) => (q.linkedFinding ? [q.linkedFinding] : [])));
  const made: Finding[] = [], joined: Finding[] = []; let kept = 0, marks = 0, at = '';
  for (const f of Object.values(state.findings)) {
    if (f.dealId !== dealId || !(f.onLists ?? []).some((m) => m.doc === doc)) continue;
    marks += f.onLists!.filter((x) => x.doc === doc).length; const m = f.onLists![0];
    const own = m.doc === doc && madeBy(f);
    for (const x of f.onLists!) if (x.doc === doc && x.at && (!at || x.at < at)) at = x.at;
    if (!own) joined.push(f);
    else if (asMade(f) && !linked.has(f.id) && !state.threads?.[`f:${dealId}:${f.id}`]?.length) made.push(f);
    else kept++;
  }
  return { made, joined, kept, raised: marks - made.length - kept, at };
}
