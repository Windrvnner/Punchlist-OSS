/** Orchestration: reassess one finding, with a visible in-progress mark. All record changes go through commands. */
import type { Store } from './store';
import { Reassess } from './commands/findings';

/**
 * The update whose earlier words show under "Previous version": the latest one that replaced the words. An update that left
 * them as they were is still in the history, but has no earlier version to show (decisions: "An update that replaces the words
 * … keeps the earlier text under 'Previous version'").
 */
export function previousVersion<A extends { kind: string; from?: unknown; to?: unknown }>(standing: readonly A[]): A | undefined {
  return [...standing].reverse().find((a) => a.kind === 'reassessed' && Array.isArray(a.from) && JSON.stringify(a.from) !== JSON.stringify(a.to));
}

export async function reassess(store: Store, dealId: string, findingId: string) {
  if (store.get().ui.reassessing.includes(findingId)) return;
  store.ui((ui) => ({ reassessing: [...ui.reassessing, findingId] }));
  try {
    const r = await store.dispatch(Reassess, { dealId, findingId }, { idempotencyKey: 'reassess-' + findingId });
    if (r.ok) await store.settled(r.value.opId);
  } finally { store.ui((ui) => ({ reassessing: ui.reassessing.filter((x) => x !== findingId) })); }
}
