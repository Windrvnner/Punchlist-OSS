/**
 * Draft all: request a draft for every eligible open question, four in flight,
 * stoppable. Progress lives in UI state; every change to a question still goes
 * through RequestDraft/ApplyDraft, so a stop or a reload leaves nothing half-done.
 */
import type { Store } from './store';
import { AcceptDraft, RequestDraft } from './commands/drafts';
import { SetResponse } from './commands/questions';
import { isChangedElsewhere } from './changedElsewhere';
import { isDraftStale } from '../domain/transitions';
import { dealQuestions, qaKept, type State } from './state';
import { chooseVersion, type VersionPick } from './qaLog';
import { hasTexts, keptDrafts } from './keptText';
import type { Question } from '../domain/model';
import { fail, rejected } from '../domain/result';
import type { Services } from '../ports';

export const eligibleForDraft = (q: Question) => q.status === 'open' && !q.response.trim() && !!q.text.trim()
  && (!q.draft || q.draft.status === 'failed' || isDraftStale(q));

function retryKeptDraft(store: Store, opId: string | undefined): boolean {
  if (!opId || !store.hasKeptReply(opId)) return false;
  store.retryKeptReply(opId);
  return true;
}

/** Retry a kept reply before making another request to the model. */
export function requestQuestionDraft(store: Store, question: Pick<Question, 'dealId' | 'id' | 'draft'>) {
  if (retryKeptDraft(store, question.draft?.opId)) return;
  return store.dispatch(RequestDraft, { dealId: question.dealId, questionId: question.id }, {
    idempotencyKey: 'draft-' + question.id,
  });
}

export function draftReplacesResponse(question: Pick<Question, 'response'>, typed: string): boolean {
  return !!typed.trim() || !!question.response.trim();
}

type DraftReplacement = { typed: string; over: string; elsewhere: boolean };
type DraftAcceptance =
  | { kind: 'accepted'; opId: string }
  | { kind: 'reported' }
  | { kind: 'responseChanged' }
  | { kind: 'textNotSaved' }
  | { kind: 'refused'; message: string };

/** Save confirmed text before replacing it so Undo restores it. Each write checks the response it was based on. */
export async function useQuestionDraft(
  store: Store, question: Pick<Question, 'dealId' | 'id'>, replacement?: DraftReplacement,
): Promise<DraftAcceptance> {
  const target = { dealId: question.dealId, questionId: question.id };
  const options = { idempotencyKey: 'take-' + question.id };
  if (!replacement) {
    const result = await store.dispatch(AcceptDraft, target, options);
    return result.ok ? { kind: 'accepted', opId: result.value.opId } : { kind: 'reported' };
  }
  if (replacement.elsewhere) return { kind: 'responseChanged' };

  const current = store.get().questions[question.id];
  if (current && replacement.typed !== current.response) {
    const saved = await store.dispatch(SetResponse, { ...target, response: replacement.typed }, {
      quiet: true, over: replacement.over,
    });
    if (!saved.ok) return { kind: isChangedElsewhere(saved.error) ? 'responseChanged' : 'textNotSaved' };
  }
  const result = await store.dispatch(AcceptDraft, { ...target, replace: true, over: replacement.typed }, {
    ...options, quiet: true,
  });
  if (result.ok) return { kind: 'accepted', opId: result.value.opId };
  if (isChangedElsewhere(result.error)) return { kind: 'responseChanged' };
  return { kind: 'refused', message: result.error.message };
}

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
      if (retryKeptDraft(store, now.draft?.opId)) {
        asked.add(q.id);
        store.ui((ui) => ({
          batch: ui.batch?.dealId === dealId ? { ...ui.batch, done: ui.batch.done + 1 } : ui.batch,
        }));
        continue;
      }
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

type MergeDraft = { text: string; ai: string };
type MergeSide = 'app' | 'log';
type MergeFields = Record<string, MergeSide>;
type MergeModel = NonNullable<Services['ai']['merge']>;

let keptMerges: Map<string, MergeDraft> | undefined;
let keptSides: Map<string, MergeFields> | undefined;
// Keep the existing keys and load them after kept text is initialized.
const mergeDrafts = () => keptMerges ??= keptDrafts('qa-merge', hasTexts('text', 'ai'));
const mergeSides = () => keptSides ??= keptDrafts('qa-merge-sides', isMergeFields);
const merging = new Set<string>();
const mergeListeners = new Set<(questionId: string, error?: string) => void>();

function isMergeFields(value: unknown): value is MergeFields {
  return !!value && typeof value === 'object'
    && Object.values(value).every((side) => side === 'app' || side === 'log');
}

/** Load both maps before recovery can move saved drafts to the copied questions' IDs. */
export function initializeResponseMergeDrafts() {
  mergeDrafts();
  mergeSides();
}

export function responseMergeView(questionId: string) {
  const draft = mergeDrafts().get(questionId);
  return {
    draft, hasDraft: !!draft?.text.trim(),
    busy: merging.has(questionId), fields: mergeSides().get(questionId) ?? {},
  };
}

export function editResponseMerge(questionId: string, text: string) {
  const drafts = mergeDrafts();
  drafts.set(questionId, { text, ai: drafts.get(questionId)?.ai ?? '' });
}

export function setResponseMergeSide(questionId: string, field: string, side: MergeSide) {
  const sides = mergeSides();
  sides.set(questionId, { ...sides.get(questionId), [field]: side });
  return sides.get(questionId)!;
}

export function watchResponseMerges(listener: (questionId: string, error?: string) => void) {
  mergeListeners.add(listener);
  return () => { mergeListeners.delete(listener); };
}

/** Select a kept draft, wait for an in-flight one, or draft from the versions shown. */
export function selectResponseMerge(
  store: Store, question: Question, logText: string, again = false,
): { text: string; busy: boolean } | undefined {
  const { draft, hasDraft, busy } = responseMergeView(question.id);
  const text = draft?.text ?? '';
  if (!again && hasDraft && !busy) return { text, busy: false };
  const ai = store.services.ai;
  if (!ai.merge) return;
  if (!busy) {
    merging.add(question.id);
    const input = { dealId: question.dealId, question: question.text, app: question.response, log: logText };
    void finishResponseMerge(store, question.id, ai.merge.bind(ai), input, text);
  }
  return { text, busy: true };
}

async function finishResponseMerge(
  store: Store, questionId: string, model: MergeModel, input: Parameters<MergeModel>[0], before: string,
) {
  const result = await model(input);
  merging.delete(questionId);
  const drafts = mergeDrafts();
  const state = store.get();
  // Keep a reply for its question after stepping away, unless it was resolved or its draft was edited meanwhile.
  if (result.ok && hasLogVersion(state, state.questions[questionId])
      && (drafts.get(questionId)?.text ?? '') === before) {
    drafts.set(questionId, { text: result.value.text, ai: result.value.text });
  }
  for (const listener of mergeListeners) listener(questionId, result.ok ? undefined : result.error.message);
}

export function hasLogVersion(state: State, question: Question | undefined): boolean {
  return !!question && Object.keys(qaKept(state, question)).length > 0;
}

function forgetResponseMerge(questionId: string) {
  mergeDrafts().delete(questionId);
  mergeSides().delete(questionId);
}

/** Clear the kept merge when there are no versions left to choose. */
export function forgetResolvedResponseMerge(state: State, questionId: string) {
  const question = state.questions[questionId];
  if (question && !hasLogVersion(state, question)) forgetResponseMerge(questionId);
}

export async function keepResponseVersion(
  store: Store, dealId: string, questionId: string, pick: VersionPick, merged: string, seen?: string,
) {
  const merge = pick === 'merged';
  if (merge && (merging.has(questionId) || !merged.trim())) return fail(rejected('There is no merged draft to keep'));
  const result = await chooseVersion(store, dealId, questionId, pick, {
    merged, seen, drafted: mergeDrafts().get(questionId)?.ai, fields: merge ? mergeSides().get(questionId) : {},
  });
  if (result.ok) forgetResponseMerge(questionId);
  return result;
}

export async function lastQuestionEditor(store: Store, questionId: string): Promise<string> {
  const history = await store.services.repo.audit(questionId);
  return history.ok ? history.value.at(-1)?.actor ?? '' : '';
}
