import { SERVICE } from '../control';
import type { Question } from '../domain/model';
import { fail, ok, type Result } from '../domain/result';
import type { AiService } from '../ports';
import { AddUnresolved, UNRESOLVED_LINK_CHANGED } from './commands/addUnresolved';
import { unresolvedPoints, unresolvedTargets, type State, type Unresolved } from './state';
import type { Store } from './store';
import {
  canLinkUnresolved, isApprovedLink, keptLinks, linkApproval, suggestUnresolvedLinks, unresolvedPointFingerprint,
  type ApprovedLinks, type UnresolvedLink,
} from './unresolvedLinks';

type DraftedPoint = Unresolved & { text: string };
type SelectedUnresolved = { points: DraftedPoint[]; links: UnresolvedLink[] };
export type UnresolvedPreview = SelectedUnresolved & { out: Unresolved[] };
type Changed = { kind: 'changed'; count: number; keys: ReadonlySet<string>; invalidLinks: ReadonlySet<string> };
export const UNREAD_CHECKLIST = 'Couldn’t load the checklist';

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

/**
 * The model's proposals (#1120): for each point without a kept link, the open questions it says already ask for it, by
 * point key. A failed call, or a point the call missed, has none, and nothing is linked unless a person checks it.
 */
async function proposedLinks(
  store: Store, points: Unresolved[], pool: Question[], kept: ReadonlyMap<string, Question>,
) {
  const proposed = new Map<string, string[]>();
  const ai = store.services.ai;
  const keptIds = new Set([...kept.values()].map((q) => q.id));
  const asked = points.filter((point) => !kept.has(point.key));
  const open = pool.filter((q) => !keptIds.has(q.id));
  if (!ai.sameMeaning || !asked.length || !open.length) return proposed;
  const items = asked.map((point) => `${point.what} ${point.need}`);
  const result = await ai.sameMeaning({ items, against: open.map((q) => q.text), kind: 'questions' });
  if (!result.ok) return proposed;
  for (const pair of result.value.pairs) {
    const point = asked[pair.a];
    const q = open[pair.b];
    if (!pair.inAgainst || !point || !q) continue;
    proposed.set(point.key, [...(proposed.get(point.key) ?? []), q.id]);
  }
  return proposed;
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
  const { points, pool } = unresolvedPoints(state, dealId);
  progress?.count(points.length);
  if (!points.length) return ok({ points: [], links: [], out: [] });
  const kept = keptLinks(points, pool, approved);
  const [result, proposed] = await Promise.all([
    phrasePoints(store, dealId, points), proposedLinks(store, points, pool, kept),
  ]);
  if (progress?.signal.aborted) return;
  if (!result.ok) return result;
  const links = suggestUnresolvedLinks(points, pool, kept, proposed);
  const byKey = new Map(points.map((p) => [p.key, p]));
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
