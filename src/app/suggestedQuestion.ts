/**
 * The suggested open question under a chat answer (#1120): once an answer finishes, the model proposes the open
 * question it may address, and the card under the answer shows it until a person uses it or puts it away.
 * `answered` is the texts of the conversation's answers, as they leave it (conversations.ts `answerText`).
 */
import { dealQuestions, type Message, type State } from './state';
import type { Store } from './store';

/**
 * Once an answer on a deal's or a finding's conversation finishes, the model proposes the open question it may address,
 * if any, kept for this session for the card under it (`suggestedFor`). A failed call proposes none.
 */
export async function proposeQuestion(
  store: Store, dealId: string, messageId: string, answer: string, answered: ReadonlySet<string>,
) {
  const ai = store.services.ai;
  const open = openToSuggest(store.get(), dealId, answered);
  if (!ai.suggestQuestion || !open.length) return;
  const r = await ai.suggestQuestion({ dealId, answer, questions: open.map((q) => q.text) });
  const asked = r.ok && r.value !== null ? open[r.value] : undefined;
  // the question may have been edited or closed while the model read it: the proposal is for its text as asked
  const now = asked && store.get().questions[asked.id];
  if (asked && now && stillAsks(now, asked.text)) {
    store.ui((ui) => ({ proposed: { ...ui.proposed, [messageId]: { id: asked.id, text: asked.text } } }));
  }
}

/** A proposal holds only while its question is open and still has the text it was proposed for. */
const stillAsks = (q: { status: string; text: string }, text: string) => q.status === 'open' && q.text === text;

/** The open questions a card may suggest: those whose response is not already an answer of this conversation. */
function openToSuggest(s: State, dealId: string, answered: ReadonlySet<string>) {
  return dealQuestions(s, dealId).filter((q) => q.status === 'open' && !answered.has(q.response.trim()));
}

/**
 * The open question each answer may address, for the card under it: answer message id to question id.
 * One question per answer, and each question under one answer only, the newest that may address it. A question whose
 * response is already an answer of this conversation is not suggested again. One a person said "not this one" to is
 * not shown, nor offered under an earlier answer instead.
 */
export function suggestedFor(s: State, dealId: string, list: Message[], answered: ReadonlySet<string>) {
  const out = new Map<string, string>();
  const open = new Set(openToSuggest(s, dealId, answered).map((q) => q.id));
  const offered = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'ai' || m.state !== 'done') continue;
    // the question the model proposed when this answer finished (#1120)
    const proposal = s.ui.proposed[m.id];
    const id = proposal?.id;
    if (!proposal || !open.has(id) || offered.has(id) || !stillAsks(s.questions[id], proposal.text)) continue;
    offered.add(id);
    if (!s.ui.notThese.includes(`${m.id}|${id}`)) out.set(m.id, id);
  }
  return out;
}
