/**
 * Orchestration for indexing: start the document service on a deal's folders and follow its progress.
 * While indexing is under way the progress is only shown (state.indexing); nothing is written. The deal
 * record is written once, through a command, when indexing finishes. Stops when the deal disappears.
 */
import type { Store } from './store';
import { RecordIndexingProgress } from './commands/deals';
import type { Folder } from '../domain/model';
import { control } from '../control';

const active = new Set<string>();

/**
 * The deal's own folders with the backend's counts laid over them. The deal owns which folders it has and what
 * they are called; the backend owns how far each has got. A folder the deal does not have is ignored.
 */
export function withProgress(own: Folder[], polled: Folder[]): Folder[] {
  const by = new Map(polled.map((f) => [f.path, f]));
  return own.map((f) => { const p = by.get(f.path); return p ? { ...f, files: p.files, size: p.size, indexed: p.indexed, reviewed: p.reviewed } : f; });
}
/** A deal's folders as they stand now: with live progress while indexing is under way. */
export const liveFolders = (s: { indexing: Record<string, { folders: Folder[] }> }, d: { id: string; folders: Folder[] }): Folder[] =>
  s.indexing[d.id] ? withProgress(d.folders, s.indexing[d.id].folders) : d.folders;

type Why = 'away' | 'retry';
const waiting = (store: Store, dealId: string, why: Why | null) => {
  if ((store.get().ui.indexWaiting[dealId] ?? null) === why) return;
  store.ui((ui) => { const next = { ...ui.indexWaiting }; if (why) next[dealId] = why; else delete next[dealId]; return { indexWaiting: next }; });
};
const said = (store: Store, dealId: string, why: string | null) => {
  if ((store.get().ui.indexWhy[dealId] ?? null) === why) return;
  store.ui((ui) => { const next = { ...ui.indexWhy }; if (why) next[dealId] = why; else delete next[dealId]; return { indexWhy: next }; });
};
/** How long to wait before trying again: indexRetryFirst in the control file, then twice as long each time, up to indexRetryMax. */
export const RETRY = { first: control.timings.indexRetryFirst, max: control.timings.indexRetryMax };   // a copy tests may shorten
export const retryWait = (n: number) => Math.min(RETRY.max, RETRY.first * 2 ** Math.min(n, 20));
/** a wait between tries ends early when a person starts indexing themselves */
const wakers = new Map<string, () => void>();
const sleep = (dealId: string, ms: number) => new Promise<void>((res) => { const t = setTimeout(() => { wakers.delete(dealId); res(); }, ms); wakers.set(dealId, () => { clearTimeout(t); wakers.delete(dealId); res(); }); });
// only a folder that cannot be opened is the data room; an unreachable service is not, so it is not worded as one
const away = (kind: string) => kind === 'notFound';
/** the "Couldn't start indexing" notice showing for each deal, so a second failure replaces it rather than adding another */
const noticesOf = new WeakMap<Store, Map<string, number>>();
const stalled = (store: Store, dealId: string, on: boolean) => store.ui((ui) => ({ indexStalled: on ? [...new Set([...ui.indexStalled, dealId])] : ui.indexStalled.filter((x) => x !== dealId) }));

export async function startIndexing(store: Store, dealId: string, folders: Folder[]) {
  if (!store.get().deals[dealId]) return;                  // the deal has gone (a Retry pressed on a notice that outlived it): nothing is started for it
  stalled(store, dealId, false);
  const r = await store.services.docs.index(dealId, folders);
  if (!store.get().deals[dealId]) return;
  if (!r.ok) {                                               // not started: say so on the deal, where Resume stays after the toast has gone
    const why: Why = away(r.error.kind) ? 'away' : 'retry';
    stalled(store, dealId, true); waiting(store, dealId, why);   // the page says at once that it will be tried again
    // one notice a deal, however often it is pressed; "Retry now", since the app is already retrying by itself
    const notices = noticesOf.get(store) ?? new Map<string, number>(); noticesOf.set(store, notices);
    const was = notices.get(dealId); if (was !== undefined) store.dismissToast(was);
    notices.set(dealId, store.toast('Couldn’t start indexing',
      { label: 'Retry Now', run: () => void startIndexing(store, dealId, folders) }));
    void watchIndexing(store, dealId, { wanted: folders, why });         // and it is tried again without being asked, further apart each time
    return;
  }
  wakers.get(dealId)?.();                                    // a wait between tries is over: it is running
  void watchIndexing(store, dealId);
}

/** A person restarts indexing on the folders that have not finished. */
export const resumeIndexing = (store: Store, dealId: string) => {
  const d = store.get().deals[dealId]; if (!d) return Promise.resolve();
  const left = liveFolders(store.get(), d).filter((f) => f.indexed < f.files);
  return startIndexing(store, dealId, left.length ? left : d.folders);
};

/**
 * Follow a deal's indexing until it finishes.
 *
 * Indexing is something a person asked for, so when it is found not running and not finished (the app was closed part-way,
 * the run broke, or the start was refused) the app starts it again without being asked, and keeps trying: at once the
 * first time, then after 5 seconds, then twice as long each time up to 15 minutes. The waits start short again whenever a
 * run got further than the one before. Nothing is announced; the deal's pages say where indexing stopped, that it will be
 * tried again, and offer to try now.
 *
 * A start that is refused because a folder cannot be opened is "not yet" (the PC may still be
 * connecting): the backend refuses it before doing anything, and the pages say indexing will resume when the data room can
 * be reached.
 *
 * Two cases are left to a person. A deal the backend on this PC knows nothing about (it was being indexed on another PC, or
 * never started here) is not started from here: the page offers to start it. `wanted` lifts that for the session in which a
 * person asked for these folders and the start was refused.
 */
export async function watchIndexing(store: Store, dealId: string, opts: { wanted?: Folder[]; why?: Why } = {}) {
  if (active.has(dealId)) return; active.add(dealId);
  let tries = 0; let lastGot = -1; let waitFirst = !!opts.wanted; let why: Why = opts.why ?? 'retry';
  try {
    while (store.get().deals[dealId]) {
      const p = await store.services.docs.poll(dealId);
      if (!store.get().deals[dealId]) return;
      if (!p.ok) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      const d = store.get().deals[dealId];
      const unknown = !p.value.folders.length;               // the backend here has no run for this deal and remembers none
      if (unknown && !opts.wanted) { if (d.stage === 'indexing') stalled(store, dealId, true); return; }
      if (unknown || p.value.stopped) {
        if (d.stage !== 'indexing') return;                   // finished meanwhile, here or on another PC: this PC's stop point is not put back over it
        if (!unknown) store.setIndexing(dealId, { folders: p.value.folders, log: d.log });      // how far it had got is shown
        said(store, dealId, p.value.why ?? null);                                               // and what stopped it, when the backend says
        const got = p.value.folders.reduce((a, f) => a + f.indexed, 0);
        if (lastGot >= 0 && got > lastGot) tries = 0;         // the last run got further: the waits start short again
        lastGot = got;
        if (waitFirst) { waitFirst = false; stalled(store, dealId, true); waiting(store, dealId, why); await sleep(dealId, retryWait(tries++)); continue; }
        const left = liveFolders(store.get(), d).filter((f) => f.indexed < f.files);
        const r = await store.services.docs.index(dealId, unknown ? opts.wanted! : left.length ? left : d.folders);
        waitFirst = true; why = !r.ok && away(r.error.kind) ? 'away' : 'retry';
        if (r.ok) { waiting(store, dealId, null); stalled(store, dealId, false); }
        continue;
      }
      waiting(store, dealId, null); said(store, dealId, null);   // it is running
      const log = p.value.log.length ? p.value.log : d.log;
      store.setIndexing(dealId, { folders: p.value.folders, log });
      if (p.value.done) {
        // finished: this is the one write. If it cannot be made now (the deal has two versions, or changed elsewhere), try again shortly.
        const r = await store.dispatch(RecordIndexingProgress, { dealId, folders: withProgress(d.folders, p.value.folders), log, done: true }, { quiet: true });
        if (r.ok) { store.setIndexing(dealId, undefined); store.forgetDrafts(dealId); void store.refreshProgress(dealId); return; }
        await new Promise((r2) => setTimeout(r2, 2000)); continue;
      }
      await new Promise((r) => setTimeout(r, 600));
    }
  } finally { active.delete(dealId); wakers.delete(dealId); waiting(store, dealId, null); said(store, dealId, null); }
}

/**
 * A deal that goes (deleted here or on another PC), or whose indexing finishes (here or on another PC), is let go of at once:
 * nothing about its indexing is kept for the pages.
 * A wait between tries that is in hand runs out by itself and the loop then ends, having started nothing.
 * Call once, after start-up; returns the function that stops it.
 */
export function followDeals(store: Store): () => void {
  let had = store.get().deals;
  const letGo = (id: string) => {
    if (store.get().deals[id]?.stage === 'indexing') return;          // it came back, or is being indexed again
    waiting(store, id, null); said(store, id, null); stalled(store, id, false);
    if (store.get().indexing[id]) store.setIndexing(id, undefined);
  };
  return store.subscribe((s) => {
    if (s.deals === had) return;
    const before = had; had = s.deals;
    // nothing is changed from inside the notification itself: that would reach the other listeners out of order
    for (const id of Object.keys(before)) if (!s.deals[id]) queueMicrotask(() => letGo(id));
    // a deal whose indexing finished, here or on another PC (whose record arrives as a change), is let go of the same way:
    // what this PC had shown of its own run is not shown over the finished deal
    for (const [id, d] of Object.entries(s.deals)) if (before[id]?.stage === 'indexing' && d.stage !== 'indexing') queueMicrotask(() => letGo(id));
    // a folder taken off a deal waiting to try its indexing again may have been what held it back: it looks at once
    for (const [id, d] of Object.entries(s.deals)) if (before[id] && d.folders.length < before[id].folders.length && wakers.has(id)) queueMicrotask(() => wakers.get(id)?.());
  });
}

/**
 * What the app does about indexing as it opens: once the store has started, follow the deals (followDeals) and watch every
 * deal whose indexing had not finished, so it picks up where it stopped and the first pass follows. The first start can
 * fail (the backend cannot be reached, or another fault) and a later one succeed, through Retry or the store's own retries;
 * whichever start succeeds runs this, once. Call once, before `store.boot()`; returns the function that stops it.
 */
export function pickUpIndexing(store: Store): () => void {
  let started = false; let stopDeals = () => {};
  const start = () => {
    if (started) return; started = true; off();
    stopDeals = followDeals(store);
    for (const d of Object.values(store.get().deals)) if (d.stage === 'indexing') void watchIndexing(store, d.id);
  };
  // started after the notification that the store is ready, not from inside it (see followDeals)
  const off = store.subscribe((s) => { if (s.boot.stage === 'ready' && !started) queueMicrotask(start); });
  if (store.get().boot.stage === 'ready') start();
  return () => { started = true; off(); stopDeals(); };
}
