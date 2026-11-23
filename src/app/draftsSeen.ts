/**
 * When this PC first saw each pending draft that another PC asked for, by this PC's own clock (#24). A draft from
 * another PC is given up once this PC has seen it pending for DRAFT_GIVE_UP_MS. Its own `at` was stamped by the other
 * PC's clock, and the two clocks can differ by more than that. The times are kept in this PC's local store, so a
 * restart does not start the wait again; a draft not seen before counts as seen now, never as old.
 */
import type { LocalStore } from '../ports';

const keyOf = (dealId: string) => `draftsSeen:${dealId}`;

/** the stored times for one deal, by request; anything unreadable counts as never seen */
function storedSeen(local: LocalStore, dealId: string): Record<string, unknown> {
  try {
    const v = local.read(keyOf(dealId));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * When this PC first saw each of these requests, in milliseconds. Only these are kept, so the stored list holds the
 * deal's drafts still pending from other PCs and no more. A time after `now` (this PC's clock was put back) counts as
 * now. A failing write is ignored: the drafts are still waited on, from now.
 */
export function seenSince(local: LocalStore, dealId: string, opIds: string[], now: number): Map<string, number> {
  const stored = storedSeen(local, dealId);
  const seen = new Map<string, number>();
  for (const id of opIds) {
    const at = stored[id];
    seen.set(id, typeof at === 'number' && Number.isFinite(at) && at <= now ? at : now);
  }
  const same = Object.keys(stored).length === seen.size && [...seen].every(([id, at]) => stored[id] === at);
  if (!same) {
    try {
      local.write(keyOf(dealId), Object.fromEntries(seen));
    } catch {
      // kept in memory only: the next start waits from then
    }
  }
  return seen;
}
