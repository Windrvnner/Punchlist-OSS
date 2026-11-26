import { SERVICE } from '../control';
import { fail, ok, type Result } from '../domain/result';
import type { AiService } from '../ports';
import { AddUnresolved, UNRESOLVED_LINK_CHANGED } from './commands/addUnresolved';
import { unresolvedPoints, unresolvedTargets, type State, type Unresolved } from './state';
import type { Store } from './store';
import {
  canLinkUnresolved, confirmedLinks, isApprovedLink, linkApproval, unresolvedPointFingerprint,
  type ApprovedLinks, type UnresolvedLink,
} from './unresolvedLinks';

type DraftedPoint = Unresolved & { text: string };
type SelectedUnresolved = { points: DraftedPoint[]; links: UnresolvedLink[] };
export type UnresolvedPreview = SelectedUnresolved & { out: Unresolved[] };
type Changed = { kind: 'changed'; count: number; keys: ReadonlySet<string>; invalidLinks: ReadonlySet<string> };
export const UNREAD_CHECKLIST = 'Couldn’t load the checklist';

/** The preview, for a deal: from the Checklist menu, the slash command, or the model's offer (#2, #1054). */
export function openAddUnresolved(store: Store, dealId: string) {
  store.ui({ dialog: { kind: 'addUnresolved', dealId } });
}

type Phrase = NonNullable<AiService['phrase']>;
type PointInput = Parameters<Phrase>[0]['items'][number];
type Phrasing = { text: Map<string, string>; run?: ReturnType<Phrase> };
const byStore = new WeakMap<Store, Map<string, Phrasing>>();

function phrasingFor(store: Store, dealId: string): Phrasing {
  const deals = byStore.get(store) ?? new Map<string, Phrasing>();
  byStore.set(store, deals);
  const phrasing = deals.get(dealId) ?? { text: new Map<string, string>() };
  deals.set(dealId, phrasing);
  return phrasing;
}

const phraseKey = ({ kind, what, need }: PointInput) => JSON.stringify([kind, what, need]);

/** A reopened preview waits for the current run and only asks for points without a kept question. */
async function phrasePoints(store: Store, dealId: string, points: Unresolved[]): Promise<Result<(string | null)[]>> {
  const ai = store.services.ai;
  if (!ai.phrase) return fail({ kind: 'failed', message: 'Questions can’t be phrased here' });
  const phrasing = phrasingFor(store, dealId);
  while (phrasing.run) await phrasing.run.catch(() => {});
  const missing = points.filter((p) => !phrasing.text.has(phraseKey(p)));
  if (missing.length) {
    const items = missing.map(({ kind, what, need }) => ({ kind, what, need }));
    // The port retries model calls quietly and reports exhausted points as null.
    const run = ai.phrase({ dealId, items });
    phrasing.run = run;
    try {
      const result = await run;
      if (!result.ok) return result;
      if (result.value.length !== missing.length) {
        return fail({ kind: 'failed', message: `${SERVICE}’s reply was cut off, so nothing was added` });
      }
      for (const [index, point] of missing.entries()) {
        const text = result.value[index];
        if (text !== null) phrasing.text.set(phraseKey(point), text);
      }
    } finally {
      delete phrasing.run;
    }
  }
  return ok(points.map((p) => phrasing.text.get(phraseKey(p)) ?? null));
}

function drafts(points: Unresolved[], text: (string | null)[]) {
  const drafted: DraftedPoint[] = [];
  const out: Unresolved[] = [];
  for (const [index, point] of points.entries()) {
    const question = text[index];
    if (question) drafted.push({ ...point, text: question });
    else out.push(point);
  }
  return { points: drafted, out };
}

export async function prepareUnresolved(
  store: Store,
  dealId: string,
  progress?: { count: (count: number) => void; signal: AbortSignal },
  approved?: ApprovedLinks,
): Promise<Result<UnresolvedPreview> | undefined> {
  await store.refreshChecklist(dealId);
  if (progress?.signal.aborted) return;
  const state = store.get();
  if (!Array.isArray(state.checklists[dealId])) return fail({ kind: 'failed', message: UNREAD_CHECKLIST });
  const { points, links: kept, candidates } = unresolvedPoints(state, dealId, approved);
  progress?.count(points.length);
  if (!points.length) return ok({ points: [], links: [], out: [] });
  const result = await phrasePoints(store, dealId, points);
  if (progress?.signal.aborted) return;
  if (!result.ok) return result;
  // Asked only once the points are phrased: a failed phrasing makes no model call for links.
  const confirmed = await confirmedLinks(store.services.ai, dealId, candidates);
  if (progress?.signal.aborted) return;
  const byKey = new Map(points.map((p) => [p.key, p]));
  const order = new Map(points.map((p, index) => [p.key, index]));
  const links = [...kept, ...confirmed].sort((a, b) => order.get(a.point)! - order.get(b.point)!);
  const suggested = links.map((link) => ({ point: byKey.get(link.point)!, q: link.q }));
  return ok({ ...drafts(points, result.value), links: suggested });
}

/** Retry only the failed points, applying the replies to the preview as it stands when they return. */
export async function retryUnresolved(store: Store, dealId: string, out: Unresolved[]) {
  const result = await phrasePoints(store, dealId, out);
  if (!result.ok) return;
  const text = new Map(out.map((point, index) => [point.key, result.value[index]]));
  const order = new Map(unresolvedTargets(store.get(), dealId).map((point, index) => [point.key, index]));
  return (preview: UnresolvedPreview | null): UnresolvedPreview | null => {
    if (!preview) return preview;
    const retried = drafts(preview.out, preview.out.map((point) => text.get(point.key) ?? null));
    const points = [...preview.points, ...retried.points];
    points.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    return { ...preview, points, out: retried.out };
  };
}

export function selectUnresolved(
  preview: UnresolvedPreview | null,
  off: ReadonlySet<string>,
  linked: ApprovedLinks,
): SelectedUnresolved & { linkedPoints: Set<string>; draftPoints: Set<string> } {
  const links = preview?.links.filter((link) => isApprovedLink(link, linked.get(link.point.key))) ?? [];
  const linkedPoints = new Set(links.map((link) => link.point.key));
  const points = preview?.points.filter((point) => !off.has(point.key) && !linkedPoints.has(point.key)) ?? [];
  return { points, links, linkedPoints, draftPoints: new Set(points.map((point) => point.key)) };
}

export function narrowUnresolved(
  preview: UnresolvedPreview | null,
  { keys, invalidLinks }: Changed,
): UnresolvedPreview | null {
  return preview && {
    points: preview.points.filter((point) => keys.has(point.key)),
    links: preview.links.filter((link) => keys.has(link.point.key) && !invalidLinks.has(link.point.key)),
    out: preview.out.filter((point) => keys.has(point.key)),
  };
}

const target = (p: Unresolved) => (p.kind === 'finding' ? { linkedFinding: p.findingId } : { linkedItem: p.itemId });

type Submitted = { kind: 'added' } | { kind: 'failed'; message: string } | Changed;

function changedUnresolved(state: State, dealId: string, selected: SelectedUnresolved): Changed {
  const targets = new Map(unresolvedTargets(state, dealId).map((point) => [point.key, point]));
  const keys = new Set(targets.keys());
  const invalidLinks = new Set<string>();
  for (const link of selected.links) {
    const point = targets.get(link.point.key);
    const q = state.questions[link.q.id];
    // If the target changed, its draft also belongs to the older wording. Offer it afresh on reopen.
    if (point && unresolvedPointFingerprint(point) !== unresolvedPointFingerprint(link.point)) keys.delete(point.key);
    const eligible = q?.dealId === dealId && canLinkUnresolved(q, !!state.conflicts[q.id]);
    if (!point || !eligible || !isApprovedLink({ point, q }, linkApproval(link))) invalidLinks.add(link.point.key);
  }
  const count = invalidLinks.size + selected.points.filter((point) => !targets.has(point.key)).length;
  return { kind: 'changed', count, keys, invalidLinks };
}

export async function submitUnresolved(store: Store, dealId: string, selected: SelectedUnresolved): Promise<Submitted> {
  await store.refreshChecklist(dealId);
  const state = store.get();
  if (!Array.isArray(state.checklists[dealId])) {
    return { kind: 'failed', message: `${UNREAD_CHECKLIST}, so nothing was added` };
  }
  const changed = changedUnresolved(state, dealId, selected);
  if (changed.count) return changed;
  const result = await store.dispatch(AddUnresolved, {
    dealId,
    add: selected.points.map((point) => ({ text: point.text, workstream: point.workstream, ...target(point) })),
    link: selected.links.map((link) => ({
      questionId: link.q.id, ...target(link.point), approval: linkApproval(link).fingerprint,
    })),
  }, {
    idempotencyKey: 'add-unresolved-' + dealId,
    quietRefusal: (error) => error.message === UNRESOLVED_LINK_CHANGED,
  });
  if (result.ok) return { kind: 'added' };
  if (result.error.message === UNRESOLVED_LINK_CHANGED) {
    const latest = changedUnresolved(store.get(), dealId, selected);
    if (latest.count) return latest;
  }
  return { kind: 'failed', message: result.error.message };
}
