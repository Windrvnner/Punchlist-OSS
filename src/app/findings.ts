/** Orchestration: reassess one finding, with a visible in-progress mark. All record changes go through commands. */
import type { Store } from './store';
import type { State } from './state';
import type { AuditEntry, Finding } from '../domain/model';
import { Reassess } from './commands/findings';
import { LISTED } from './commands/issuesList';

const HISTORY_KINDS = ['edited', 'status', 'response', 'responseWithdrawn', 'document', 'reassessed', 'note'] as const;
export type FindingHistoryEvent = AuditEntry & { kind: (typeof HISTORY_KINDS)[number] };

function visibleInHistory(entry: AuditEntry): entry is FindingHistoryEvent {
  return HISTORY_KINDS.some((kind) => kind === entry.kind) && entry.text !== LISTED;
}

/** The latest visible event and the last close and previous version that still stand after Undo. */
export function findingHistory(state: Pick<State, 'audit'>, findingId: string) {
  const audit = state.audit[findingId] ?? [];
  const undone = new Set(audit.map((entry) => entry.undoes).filter(Boolean));
  const standing = audit.filter((entry) => !undone.has(entry.opId));
  const newestFirst = [...standing].reverse();
  const closing = newestFirst.find((entry) => entry.kind === 'status' && entry.to === 'closed' && !entry.undoes);
  const newest = newestFirst.find(visibleInHistory);
  // A note from a status change goes with that change. A note on its own is an event.
  const status = newest?.kind === 'note' && standing.find((entry): entry is FindingHistoryEvent =>
    entry.kind === 'status' && entry.opId === newest.opId);
  const previous = previousVersion(standing);
  const review = previous && standing.find((entry) => entry.kind === 'unreviewed' && entry.opId === previous.opId);
  return {
    last: status || newest,
    closedBy: closing?.actor.split(' · ')[0] ?? '',
    previous,
    previousReview: (review?.from as Finding['reviewed'] | undefined) ?? null,
  };
}

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
