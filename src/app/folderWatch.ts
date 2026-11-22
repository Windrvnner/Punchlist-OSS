/**
 * Documents that arrive in a data room after its deal was indexed. The folders of every deal this PC has indexed
 * are listed again now and then (timings.folderCheck), when a deal is opened, and before a check of everything; a folder
 * whose listing changed since it was read is indexed again (`docs.freshen`). The run decides what is new, changed or gone,
 * and its end starts the first pass, which looks at what the new documents could change (decisions: New documents).
 *
 * Nothing is shown while it runs: the deal stays ready, and when the run ends its counts are written to the deal, as a
 * first indexing's are. A folder that cannot be reached is skipped, and the next look tries again.
 */
import type { Store } from './store';
import { RecordIndexingProgress } from './commands/deals';
import { withProgress } from './indexing';
import { lookAgain } from './relink';
import { control } from '../control';
import type { Folder } from '../domain/model';

/** how often to look; a copy tests may shorten */
export const FOLDER_CHECK = {
  every: control.timings.folderCheck, poll: 600, /** how long a check waits for new documents to be read */ checkWait: control.timings.checkFolderWait,
  /** a run that has read nothing more for this long is no longer followed; the next look follows it again */ stuck: 10 * 60_000,
  /** how long before the check gives up waiting the run must end for the check to cover its documents in place of a first pass */ margin: 10_000,
};

interface Look { listed: Promise<void>; done: Promise<void> }
const looks = new WeakMap<Store, Map<string, Look>>();
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Look at a deal's folders again and, when that starts a run, follow it to its end and write the new counts to the deal.
 * Resolves when there is nothing more to wait for. One look a deal at a time: a second call joins the first.
 * `forCheckBy`: a check will start by then at the latest; a run that ends well before it leaves its documents to that check.
 */
export function freshen(store: Store, dealId: string, opts: { forCheckBy?: number } = {}): Promise<void> { return begin(store, dealId, opts).done; }
/** the same look, resolving once the folders have been listed: the run it starts, if any, is followed on its own */
const listed = (store: Store, dealId: string) => begin(store, dealId, {}).listed;

function begin(store: Store, dealId: string, opts: { forCheckBy?: number }): Look {
  const map = looks.get(store) ?? new Map<string, Look>(); looks.set(store, map);
  const had = map.get(dealId); if (had) return had;
  let onListed = () => {}; const lst = new Promise<void>((r) => { onListed = r; });
  const done = look(store, dealId, opts, onListed).catch(() => undefined).finally(() => { onListed(); map.delete(dealId); });
  const l = { listed: lst, done }; map.set(dealId, l); return l;
}

async function look(store: Store, dealId: string, opts: { forCheckBy?: number }, onListed: () => void) {
  const docs = store.services.docs; const d0 = store.get().deals[dealId];
  // a folder said to have no files on this PC may have its files again, a network drive connected late: what the Overview says is looked at again
  if (d0 && store.get().ui.missingFolders?.empty?.some((f) => f.dealId === dealId)) await lookAgain(store);
  if (!docs.freshen || !d0 || d0.stage !== 'ready') return;          // a deal still being indexed is followed by watchIndexing
  const quiet = opts.forCheckBy !== undefined && opts.forCheckBy - FOLDER_CHECK.margin > Date.now() ? { quietUntil: opts.forCheckBy - FOLDER_CHECK.margin } : undefined;
  const r = await docs.freshen(dealId, quiet); onListed(); if (!r.ok || r.value === 'unknown') return;
  // Followed until it ends. Whatever the look found, the deal's counts are then set to what this PC has indexed, so counts a
  // look before could not write (it gave up, or the write was refused) are put right by the next one.
  let last = -1, since = Date.now(), failures = 0;
  for (;;) {
    const d = store.get().deals[dealId]; if (!d || d.stage !== 'ready') return;
    const p = await docs.poll(dealId);
    if (!p.ok) { if (++failures >= 30) return; await wait(FOLDER_CHECK.poll); continue; }
    failures = 0;
    if (p.value.stopped) return;                                      // the data room stopped answering: the next look reads it again
    if (p.value.done) { await record(store, dealId, p.value); return; }
    const got = p.value.folders.reduce((a, f) => a + f.indexed, 0);
    if (got !== last) { last = got; since = Date.now(); } else if (Date.now() - since > FOLDER_CHECK.stuck) return;
    await wait(FOLDER_CHECK.poll);
  }
}

/** the counts of a finished run, written to the deal only when they differ, so a look that changed nothing adds no change of its own */
async function record(store: Store, dealId: string, p: { folders: Folder[]; log: string[] }) {
  for (let tries = 0; tries < 3; tries++) {
    const d = store.get().deals[dealId]; if (!d || d.stage !== 'ready') return;   // a folder added meanwhile is being indexed: watchIndexing writes the deal
    const folders = withProgress(d.folders, p.folders);
    if (folders.every((f, i) => f.files === d.folders[i].files && f.size === d.folders[i].size && f.indexed === d.folders[i].indexed)) break;
    const w = await store.dispatch(RecordIndexingProgress, { dealId, folders, log: p.log.length ? p.log : d.log, done: true }, { quiet: true });
    if (w.ok) break; await wait(2000);
  }
  store.forgetDrafts(dealId); void store.refreshProgress(dealId);
}

/**
 * Once the store has started: look at every deal's folders each `timings.folderCheck`, listing one deal at a time, and at a deal's
 * folders as soon as it is opened. Closed deals are left off the timer; opening one still looks. Call once, before `store.boot()`; returns the function that stops it.
 */
export function watchFolders(store: Store): () => void {
  let started = false; let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined; let offRoute = () => {};
  const round = async () => {
    // one deal's folders listed at a time; a run a look starts is followed on its own, so a long or stuck run holds up no other deal
    for (const d of Object.values(store.get().deals)) { if (stopped) return; if (d.group !== 'closed') await listed(store, d.id); }
    if (!stopped) timer = setTimeout(() => void round(), FOLDER_CHECK.every);
  };
  const start = () => {
    if (started) return; started = true; off();
    let opened: string | undefined;
    const onRoute = () => {
      const id = (store.get().ui.route as { dealId?: string }).dealId;
      if (id === opened) return; opened = id;
      if (id && store.get().deals[id]) queueMicrotask(() => void freshen(store, id));   // not from inside the notification (see followDeals)
    };
    offRoute = store.subscribe(onRoute); onRoute();
    timer = setTimeout(() => void round(), FOLDER_CHECK.every);
  };
  const off = store.subscribe((s) => { if (s.boot.stage === 'ready' && !started) queueMicrotask(start); });
  if (store.get().boot.stage === 'ready') start();
  return () => { stopped = true; started = true; off(); offRoute(); clearTimeout(timer); };
}
