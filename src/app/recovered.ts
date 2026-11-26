/**
 * A deal deleted on another PC while this PC had changes to it that the deleting PC had not seen.
 * The delete stands everywhere, and this PC keeps everything it had of the deal as a new deal, "<name> (recovered)", in the
 * person's list, with a notice that stays until it is closed, saying who deleted the original. Whether to keep the copy
 * or delete it is the person's to decide; nothing here asks.
 *
 * The backend finds such deals (SyncState.unseen) and makes the copy (Repository.recover). This file names the copy, says
 * so, moves a page left open on the deleted deal to the copy, carries the deal's conversations over, and starts indexing
 * the copy's folders, as a new deal with folders does.
 */
import type { Store } from './store';
import type { SyncState } from '../ports';
import { cleanName, DEAL_NAME_MAX } from './commands/deals';
import { startIndexing } from './indexing';

const SUFFIX = ' (recovered)';
/** the copy's name: the deal's own, cut so that the suffix fits in a deal's longest name */
export const recoveredName = (name: string) => `${cleanName(name || 'Deal').slice(0, DEAL_NAME_MAX - SUFFIX.length).trim()}${SUFFIX}`;
/** a copy's name as [the deal's own, " (recovered)"], so a heading short of room shortens the first and always shows the second; else [name, ''] */
export const recoveredParts = (name: string): [string, string] => (name.endsWith(SUFFIX) && name.length > SUFFIX.length ? [name.slice(0, -SUFFIX.length), SUFFIX] : [name, '']);

/** deals being kept now, so two looks at the shared folder close together make one copy */
const busy = new WeakMap<Store, Set<string>>();
/** a copy that could not be made just now is tried again after this long, by itself */
const AGAIN_MS = 30_000;
const tried = new WeakMap<Store, Map<string, number>>();
/** the notice showing for a copy that could not be made, by deal, so a second failure replaces it */
const failedNotices = new WeakMap<Store, Map<string, number>>();

/**
 * What the notice says: who deleted the deal, and that a copy is kept here (the copy, "<name> (recovered)", is in the list
 * beside it). Short, since a notice is one line of 400px; a longer one is shortened, whole on hover.
 */
export function recoveredNotice(u: { name: string; by: string; from: string }, me: string | undefined): string {
  return `${u.by && u.by !== me ? `${u.by} deleted ${u.name}` : `${u.name} was deleted on ${u.from}`} · a copy is kept here`;
}

/** Keep each deal the backend lists as deleted elsewhere with changes here it had not seen. Called whenever the sync state is read. */
export async function keepUnseen(store: Store, unseen: NonNullable<SyncState['unseen']>): Promise<void> {
  const s = store.get(); const recover = store.services.repo.recover?.bind(store.services.repo);
  if (!recover || s.boot.stage !== 'ready' || !s.user) return;
  const mine = busy.get(store) ?? new Set<string>(); busy.set(store, mine);
  const when = tried.get(store) ?? new Map<string, number>(); tried.set(store, when);
  for (const u of unseen) {
    if (mine.has(u.dealId) || Date.now() - (when.get(u.dealId) ?? -Infinity) < AGAIN_MS) continue;
    mine.add(u.dealId); when.set(u.dealId, Date.now());
    try {
      const name = recoveredName(u.name);
      const r = await recover(u.dealId, { name, person: s.user.name });
      const notices = failedNotices.get(store) ?? new Map<string, number>(); failedNotices.set(store, notices);
      const was = notices.get(u.dealId); if (r.ok && was !== undefined) { store.dismissToast(was); notices.delete(u.dealId); }
      if (!r.ok) {
        // nothing is lost meanwhile: the deleted deal's records stay in the shared folder, and the copy is tried again
        // once, while it keeps trying by itself (the sync state may not change again to ask): no button, since nothing waits on the person
        if (was === undefined) {
          const text = `Couldn’t keep your changes to ${u.name || 'a deleted deal'} yet · trying again`;
          notices.set(u.dealId, store.toast(text, 'warn', undefined, 'stays'));
        }
        const again = setTimeout(() => void store.refreshSync(), AGAIN_MS); (again as { unref?: () => void }).unref?.();
        continue;
      }
      await store.tookCopy(u.dealId, r.value.dealId, r.value.ids);
      const copy = store.get().deals[r.value.dealId];
      // back after a restart too, until it is closed
      store.toast(recoveredNotice(u, store.get().user?.name), 'warn', undefined, 'kept');
      if (copy?.folders.length) void startIndexing(store, copy.id, copy.folders);
    } finally { mine.delete(u.dealId); }
  }
}

/** A page's address on the deleted deal, moved to the same page of its copy: every id in it that the copy renamed. */
export const movedHash = (hash: string, ids: Record<string, string>) => hash.split('-').map((part) => ids[part] ?? part).join('-');
