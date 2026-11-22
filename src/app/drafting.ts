/**
 * Draft all: request a draft for every eligible open question, four in flight,
 * stoppable. Progress lives in UI state; every change to a question still goes
 * through RequestDraft/ApplyDraft, so a stop or a reload leaves nothing half-done.
 */
import type { Store } from './store';
import { RequestDraft } from './commands/drafts';
import { isDraftStale } from '../domain/transitions';
import { dealQuestions } from './state';
import type { Question } from '../domain/model';

export const eligibleForDraft = (q: Question) => q.status === 'open' && !q.response.trim() && !!q.text.trim() && (!q.draft || q.draft.status === 'failed' || isDraftStale(q));

const stops = new Map<string, boolean>();
/** questions whose response a person is typing right now (the panel's response field has focus): Draft all leaves them alone */
export const typingIn = new Set<string>();

/** `held`: a question whose response box holds text that is not saved, which a draft would hide: it is left alone too */
export async function draftAll(store: Store, dealId: string, held: (q: Question) => boolean = () => false) {
  const todo = dealQuestions(store.get(), dealId).filter((q) => eligibleForDraft(q) && !held(q));
  if (!todo.length) { store.toast('Nothing left to draft'); return; }
  stops.set(dealId, false);
  store.ui({ batch: { dealId, total: todo.length, done: 0, stopping: false } });
  const queue = todo.slice(); const asked = new Set<string>(); let refused = 0, skipped = 0;
  // while nobody is signed in (read-only), the batch waits for the sign-in and then carries on, as calls under way do;
  // Stop still ends it (decisions: "Intelligence sign-in")
  const signedIn = async () => { let waited = false; while (store.readOnly() && !stops.get(dealId)) { waited = true; await new Promise((r) => setTimeout(r, 500)); } return waited; };
  const worker = async () => {
    while (queue.length) {
      if (stops.get(dealId)) { skipped += queue.length; queue.length = 0; break; }
      const q = queue.shift()!;
      // looked at again when its turn comes: a response typed or saved since the batch began is never replaced by a draft
      const now = dealQuestions(store.get(), dealId).find((x) => x.id === q.id);
      if (!now || !eligibleForDraft(now) || typingIn.has(q.id) || held(now)) { skipped++; store.ui((ui) => ({ batch: ui.batch && ui.batch.dealId === dealId ? { ...ui.batch, done: ui.batch.done + 1 } : ui.batch })); continue; }
      // after a wait (hours, it may be), the question is looked at again: another PC may have answered or drafted it meanwhile
      if ((await signedIn()) || stops.get(dealId)) { queue.unshift(q); continue; }
      // a draft whose text came back but could not be saved is written from that text, not asked of the model again
      if (now.draft?.opId && store.hasKeptReply(now.draft.opId)) { store.retryKeptReply(now.draft.opId); asked.add(q.id); store.ui((ui) => ({ batch: ui.batch && ui.batch.dealId === dealId ? { ...ui.batch, done: ui.batch.done + 1 } : ui.batch })); continue; }
      const r = await store.dispatch(RequestDraft, { dealId, questionId: q.id, empty: true }, { quiet: true });
      if (!r.ok && store.readOnly()) { queue.unshift(q); continue; }   // signed out just now: its turn comes again after sign-in
      if (r.ok) { asked.add(q.id); await store.settled(r.value.opId); } else refused++;   // refused (a paused deal, say): counted as failed, not lost
      store.ui((ui) => ({ batch: ui.batch && ui.batch.dealId === dealId ? { ...ui.batch, done: ui.batch.done + 1 } : ui.batch }));
    }
  };
  await Promise.all([0, 1, 2, 3].map(worker));
  store.ui({ batch: null });
  // each question asked about is counted by how its draft ended: an error is "failed", never "without an answer"
  const ended = dealQuestions(store.get(), dealId).filter((q) => asked.has(q.id)).map((q) => q.draft?.status);
  const n = (st: string) => ended.filter((x) => x === st).length;
  const found = n('found'), none = n('none'), failed = n('failed') + refused, pending = n('pending');
  const counts = [`${found} drafted`, none && `${none} without an answer`, failed && `${failed} failed`,
    pending && `${pending} still drafting`, skipped && `${skipped} skipped`].filter(Boolean).join(' · ');
  store.toast(counts + (found ? '; review and accept' : ''), undefined, { glyph: failed ? 'warn' : 'done' });
}

export function stopDraftAll(store: Store, dealId: string) {
  stops.set(dealId, true);
  store.ui((ui) => ({ batch: ui.batch && ui.batch.dealId === dealId ? { ...ui.batch, stopping: true } : ui.batch }));
}
