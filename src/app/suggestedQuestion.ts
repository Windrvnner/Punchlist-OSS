/**
 * The suggested open question under a chat answer (#1120): once an answer finishes, the model proposes the open question
 * it may address, and the card under the answer shows it until a person uses it or puts it away.
 */
import { answerText, convKey, type Scope } from './conversations';
import { dealQuestions, type Message, type State } from './state';
import type { Store } from './store';

/**
 * Once an answer on a deal's or a finding's conversation finishes, the model proposes the open question it may address,
 * if any, kept for this session for the card under it (`suggestions`, #1120). A failed call proposes none.
 */
export async function proposeQuestion(store: Store, scope: Scope, messageId: string) {
  const ai = store.services.ai;
  if (!ai.suggestQuestion || (scope.kind !== 'deal' && scope.kind !== 'finding')) return;
  const list = store.get().threads[convKey(scope)] ?? [];
  const answered = list.find((m) => m.id === messageId);
  const open = openToSuggest(store.get(), scope.dealId, list);
  if (!answered || !open.length) return;
  const questions = open.map((q) => q.text);
  const r = await ai.suggestQuestion({ dealId: scope.dealId, answer: answerText(answered), questions });
  const q = r.ok && r.value !== null ? open[r.value] : undefined;
  if (q) store.ui((ui) => ({ proposed: { ...ui.proposed, [messageId]: q.id } }));
}

/** The open questions a card may suggest: those whose response is not already an answer of this conversation. */
function openToSuggest(s: State, dealId: string, list: Message[]) {
  const used = new Set(list.map((m) => answerText(m).trim()));
  return dealQuestions(s, dealId).filter((q) => q.status === 'open' && !used.has(q.response.trim()));
}

/**
 * The open question each answer may address, for the card under it: answer message id to question id.
 * One question per answer, and each question under one answer only, the newest that may address it. On a deal's or a
 * finding's conversation; on a question's, the answer is already about that question. A question whose response is
 * already an answer of this conversation is not suggested again. One a person said "not this one" to is not shown, nor
 * offered under an earlier answer instead.
 */
export function suggestions(s: State, scope: Scope): Map<string, string> {
  const out = new Map<string, string>();
  if (scope.kind !== 'deal' && scope.kind !== 'finding') return out;
  const list = s.threads[convKey(scope)] ?? [];
  const open = new Set(openToSuggest(s, scope.dealId, list).map((q) => q.id));
  const offered = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'ai' || m.state !== 'done') continue;
    // the question the model proposed when this answer finished (#1120)
    const id = s.ui.proposed[m.id];
    if (!id || !open.has(id) || offered.has(id)) continue;
    offered.add(id);
    if (!s.ui.notThese.includes(`${m.id}|${id}`)) out.set(m.id, id);
  }
  return out;
}
