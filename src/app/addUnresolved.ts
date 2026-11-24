import { SERVICE } from '../control';
import type { Question } from '../domain/model';
import { fail, ok, type Result } from '../domain/result';
import type { AiService } from '../ports';
import { AddUnresolved } from './commands/addUnresolved';
import { unresolvedPoints, type Unresolved } from './state';
import type { Store } from './store';

type DraftedPoint = Unresolved & { text: string };
type SuggestedLink = { point: Unresolved; q: Question };
type SelectedUnresolved = { points: DraftedPoint[]; links: SuggestedLink[] };
export type UnresolvedPreview = SelectedUnresolved & { out: Unresolved[] };
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
): Promise<Result<UnresolvedPreview> | undefined> {
  await store.refreshChecklist(dealId);
  if (progress?.signal.aborted) return;
  const state = store.get();
  if (!Array.isArray(state.checklists[dealId])) return fail({ kind: 'failed', message: UNREAD_CHECKLIST });
  const { points, links } = unresolvedPoints(state, dealId);
  progress?.count(points.length);
  if (!points.length) return ok({ points: [], links: [], out: [] });
  const result = await phrasePoints(store, dealId, points);
  if (progress?.signal.aborted) return;
  if (!result.ok) return result;
  const byKey = new Map(points.map((p) => [p.key, p]));
  const suggested = links.map((link) => ({ point: byKey.get(link.point)!, q: link.q }));
  return ok({ ...drafts(points, result.value), links: suggested });
}

/** Retry only the failed points, applying the replies to the preview as it stands when they return. */
export async function retryUnresolved(store: Store, dealId: string, out: Unresolved[]) {
  const result = await phrasePoints(store, dealId, out);
  if (!result.ok) return;
  const text = new Map(out.map((point, index) => [point.key, result.value[index]]));
  const order = new Map(unresolvedPoints(store.get(), dealId).points.map((point, index) => [point.key, index]));
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
  linked: ReadonlySet<string>,
): SelectedUnresolved {
  return {
    points: preview?.points.filter((p) => !off.has(p.key)) ?? [],
    links: preview?.links.filter((l) => linked.has(l.q.id)) ?? [],
  };
}

export function narrowUnresolved(
  preview: UnresolvedPreview | null,
  keys: ReadonlySet<string>,
): UnresolvedPreview | null {
  return preview && {
    points: preview.points.filter((p) => keys.has(p.key)),
    links: preview.links.filter((l) => keys.has(l.point.key)),
    out: preview.out.filter((p) => keys.has(p.key)),
  };
}

const target = (p: Unresolved) => (p.kind === 'finding' ? { linkedFinding: p.findingId } : { linkedItem: p.itemId });

type Submitted =
  | { kind: 'added' }
  | { kind: 'failed'; message: string }
  | { kind: 'changed'; count: number; keys: ReadonlySet<string> };

export async function submitUnresolved(store: Store, dealId: string, selected: SelectedUnresolved): Promise<Submitted> {
  await store.refreshChecklist(dealId);
  const state = store.get();
  if (!Array.isArray(state.checklists[dealId])) {
    return { kind: 'failed', message: `${UNREAD_CHECKLIST}, so nothing was added` };
  }
  const keys = new Set(unresolvedPoints(state, dealId).points.map((p) => p.key));
  const picked = [...selected.points, ...selected.links.map((l) => l.point)];
  const changed = picked.filter((p) => !keys.has(p.key)).length;
  if (changed) return { kind: 'changed', count: changed, keys };
  const result = await store.dispatch(AddUnresolved, {
    dealId,
    add: selected.points.map((p) => ({ text: p.text, workstream: p.workstream, ...target(p) })),
    link: selected.links.map((l) => ({ questionId: l.q.id, ...target(l.point) })),
  }, { idempotencyKey: 'add-unresolved-' + dealId, quiet: false });
  return result.ok ? { kind: 'added' } : { kind: 'failed', message: result.error.message };
}
