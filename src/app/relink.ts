/**
 * Deal folders that are not where their deal records them, on this PC (decisions.md, data rooms).
 *
 * As the app opens, the backend looks for every deal's folders: where the deal records them, and else where folders located
 * on this PC before, or this person's profile, say they are; one found there with every document the same is used without
 * asking. A network drive can be slow to answer, so this is tried again quietly for the time the control file gives
 * (timings.folderWait), and only what is still missing then is said, once, in a notice with Locate. Locate opens the
 * dialog that lists the top folders to point at: pointing at one places every folder under it, and what it teaches places
 * others too. Nothing is used until the person confirms with "Use these folders".
 */
import type { Store } from './store';
import type { FolderSearch } from '../ports';
import { control } from '../control';
import { topsOf } from '../domain/relink';
import { startIndexing } from './indexing';

/** how long to keep looking as the app opens, and how often; a copy tests may shorten */
export const FOLDER_TIMING = { wait: control.timings.folderWait, every: control.timings.folderRetryEvery };

const dealIds = (store: Store) => Object.keys(store.get().deals);
/** whether any folder is to be located: one missing, or one that reads as empty, which the Overview shows but no notice says */
const toLocate = (f: FolderSearch) => f.missing > 0 || (f.empty?.length ?? 0) > 0;
const said = (n: number) => `${n.toLocaleString('en-US')} deal folder${n === 1 ? ' isn’t' : 's aren’t'} on this PC`;
/** the notice showing about missing folders, so it is replaced rather than added to */
const notices = new WeakMap<Store, number>();

/** Ask the backend where the folders are now; keep what is missing for the Overview and the dialog. Null when it could not be asked. */
export async function lookAgain(store: Store): Promise<FolderSearch | null> {
  const r = await store.services.docs.findFolders(dealIds(store));
  if (!r.ok) return null;
  store.ui({ missingFolders: toLocate(r.value) ? r.value : null });
  if (!r.value.missing) notice(store, 0);
  return r.value;
}

/** The notice that stays while folders are missing, with Locate: shown again with the count now, or taken away at none. */
function notice(store: Store, missing: number) {
  const n = notices.get(store); if (n !== undefined) { store.dismissToast(n); notices.delete(store); }
  if (missing) notices.set(store, store.toast(said(missing), { label: 'Locate', run: () => openLocate(store) }, true));
}

/**
 * What the app does as it opens: once the store is ready, look for the deals' folders until none is missing or the wait is
 * over, then say what is still missing. Nothing is shown during the wait. Call once, before `store.boot()`; returns the function that stops it.
 */
export function lookForFolders(store: Store): () => void {
  let started = false; let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const until = Date.now() + FOLDER_TIMING.wait;
    for (;;) {
      if (stopped) return;
      const r = await store.services.docs.findFolders(dealIds(store));
      if (stopped) return;
      if (r.ok && !toLocate(r.value)) { store.ui({ missingFolders: null }); return; }
      if (Date.now() >= until) {
        if (!r.ok) return;                                    // the backend could not be asked: nothing is said about the folders
        store.ui({ missingFolders: r.value });
        notice(store, r.value.missing);
        return;
      }
      await new Promise<void>((res) => { timer = setTimeout(res, FOLDER_TIMING.every); });
    }
  };
  const start = () => { if (started) return; started = true; off(); void run(); };
  const off = store.subscribe((s) => { if (s.boot.stage === 'ready' && !started) queueMicrotask(start); });
  if (store.get().boot.stage === 'ready') start();
  return () => { stopped = true; started = true; off(); clearTimeout(timer); };
}

export function openLocate(store: Store) {
  store.ui({ locate: { located: [], busy: false, error: '' } });
  void lookAgain(store);
}

/** The dialog closes: what is still missing is said again, since pressing Locate took the notice away. */
export function closeLocate(store: Store) {
  store.ui({ locate: null });
  notice(store, store.get().ui.missingFolders?.missing ?? 0);
}

/** the top folders still to point at: what is missing, less what the folders pointed at so far have found */
export function stillMissing(store: Store) {
  const s = store.get(); const found = new Set((s.ui.locate?.located ?? []).flatMap((l) => l.places.map((p) => `${p.dealId}\u0000${p.folder}`)));
  const left = (s.ui.missingFolders?.tops ?? []).flatMap((t) => t.folders).filter((f) => !found.has(`${f.dealId}\u0000${f.folder}`));
  return topsOf(left);
}

/** A person points `top` at a folder they pick on this PC; what it finds is listed, not yet used. */
export async function locate(store: Store, top: string) {
  const pick = store.services.fs.pickFolders; if (!pick) return;
  const chosen = await pick(); if (!chosen.ok || !chosen.value.length) return;
  const picked = chosen.value[0];
  const set = (x: Partial<NonNullable<ReturnType<Store['get']>['ui']['locate']>>) => { const l = store.get().ui.locate; if (l) store.ui({ locate: { ...l, ...x } }); };
  set({ busy: true, error: '' });
  const r = await store.services.docs.locateTop(dealIds(store), top, picked);
  const l = store.get().ui.locate; if (!l) return;           // closed meanwhile
  if (!r.ok) { set({ busy: false, error: r.error.message }); return; }
  if (!r.value.length) { set({ busy: false, error: `None of the deal folders are in ${picked}` }); return; }
  set({ busy: false, located: [...l.located.filter((x) => x.top !== top), { top, picked, places: r.value }] });
}

/** "Use these folders": the places found are used from now on, on this PC. */
export async function useLocated(store: Store) {
  const l = store.get().ui.locate; if (!l) return;
  const places = l.located.flatMap((x) => x.places);
  store.ui({ locate: { ...l, busy: true, error: '' } });
  const r = await store.services.docs.placeFolders(places);
  if (!r.ok) { const now = store.get().ui.locate; if (now) store.ui({ locate: { ...now, busy: false, error: r.error.message } }); return; }
  store.ui({ locate: null });
  // the data room may have changed since it was read elsewhere: each deal's folders placed now are read again on this PC
  const deals = store.get().deals;
  for (const dealId of new Set(places.map((p) => p.dealId))) {
    const at = new Set(places.filter((p) => p.dealId === dealId).map((p) => p.folder));
    const again = deals[dealId]?.folders.filter((f) => at.has(f.path)) ?? []; if (again.length) void startIndexing(store, dealId, again);
  }
  const now = await lookAgain(store);
  notice(store, now?.missing ?? store.get().ui.missingFolders?.missing ?? 0);
}
