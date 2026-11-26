/**
 * Which open questions already ask for a deal's unresolved points, as the model reads them (#1120). The model's pairs
 * are kept per deal for the points and questions they were asked about, so opening Add All Unresolved again, or Retry,
 * asks only about the points not checked yet; a run in progress is waited for, never started twice.
 */
import type { Question } from '../domain/model';
import type { Unresolved } from './state';
import type { Store } from './store';

/** The questions proposed for each point, by point key, and the points the model has not checked yet. */
export type LinkCheck = { proposed: ReadonlyMap<string, readonly string[]>; unchecked: ReadonlySet<string> };
type Match = { key: string; proposed: Map<string, string[]>; unchecked: Set<string>; run?: Promise<void> };
const byStore = new WeakMap<Store, Map<string, Match>>();

const pointText = (point: Unresolved) => `${point.what} ${point.need}`;

/** The deal's kept match, started afresh when the points or the open questions are not the ones it was asked about. */
function matchFor(store: Store, dealId: string, points: Unresolved[], pool: Question[]): Match {
  const deals = byStore.get(store) ?? new Map<string, Match>();
  byStore.set(store, deals);
  const key = JSON.stringify([points.map((p) => [p.key, pointText(p)]), pool.map((q) => [q.id, q.text])]);
  const kept = deals.get(dealId);
  if (kept?.key === key) return kept;
  const match: Match = { key, proposed: new Map(), unchecked: new Set(points.map((p) => p.key)) };
  deals.set(dealId, match);
  return match;
}

/**
 * Ask the model about the points not checked yet, against every open question in `pool`. A failed call leaves them
 * unchecked, as does a point the call missed; nothing is linked unless a person checks it.
 */
export async function checkLinks(store: Store, dealId: string, points: Unresolved[], pool: Question[]) {
  const match = matchFor(store, dealId, points, pool);
  while (match.run) await match.run;
  const ai = store.services.ai;
  if (!pool.length) match.unchecked.clear();
  if (match.unchecked.size && ai.sameMeaning) {
    match.run = askAbout(store, match, points, pool);
    try {
      await match.run;
    } finally {
      delete match.run;
    }
  }
  return { proposed: match.proposed, unchecked: match.unchecked } as LinkCheck;
}

/** One call about the unchecked points (`only`, when not all of them), its pairs kept by point key. */
async function askAbout(store: Store, match: Match, points: Unresolved[], pool: Question[]) {
  const asked = points.flatMap((p, at) => (match.unchecked.has(p.key) ? [at] : []));
  const only = asked.length < points.length ? { only: asked } : {};
  const items = points.map(pointText);
  const result = await store.services.ai.sameMeaning!({
    items, against: pool.map((q) => q.text), kind: 'questions', ...only,
  });
  if (!result.ok) return;
  const missed = new Set(result.value.missed?.at ?? []);
  for (const at of asked) if (!missed.has(at)) match.unchecked.delete(points[at].key);
  const askedNow = new Set(asked);
  for (const pair of result.value.pairs) {
    const point = points[pair.a];
    const q = pool[pair.b];
    if (!pair.inAgainst || !point || !q || !askedNow.has(pair.a)) continue;
    const before = match.proposed.get(point.key) ?? [];
    if (!before.includes(q.id)) match.proposed.set(point.key, [...before, q.id]);
  }
}
