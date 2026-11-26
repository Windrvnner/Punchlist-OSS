/**
 * The suggested open question under a chat answer (#1120): once an answer finishes, the model proposes the open
 * question it may address, and the card under the answer shows it until a person uses it or puts it away.
 * `answered` is the texts of the conversation's answers, as they leave it (conversations.ts `answerText`).
 */
import { dealQuestions, type Message, type State } from './state';
import type { Store } from './store';

/**
 * Once an answer on a deal's or a finding's conversation finishes, the model proposes the open questions it may
 * address, if any, kept for this session for the cards under it (`suggestedFor`). A failed call proposes none.
 */
export async function proposeQuestion(
  store: Store, dealId: string, messageId: string, answer: string, answered: ReadonlySet<string>,
) {
  const ai = store.services.ai;
  const open = openToSuggest(store.get(), dealId, answered);
  if (!ai.suggestQuestion || !open.length) return;
  const r = await ai.suggestQuestion({ dealId, answer, questions: open.map(({ id, text }) => ({ id, text })) });
  if (!r.ok) return;
  // a question may have been edited or closed while the model read it: a proposal is for its text as asked
  const proposals = [...new Set(r.value)].flatMap((id) => {
    const asked = open.find((q) => q.id === id);
    const proposal = asked && { id: asked.id, text: asked.text };
    return proposal && stillAsks(store.get(), proposal) ? [proposal] : [];
  });
  if (proposals.length) store.ui((ui) => ({ proposed: { ...ui.proposed, [messageId]: proposals } }));
}

/**
 * The one freshness check for a proposal, at the reply and at display: the question is still there, still open, and
 * has exactly the text (compared as kept, never trimmed or folded) it was proposed for.
 */
export function stillAsks(s: State, proposal: { id: string; text: string }) {
  const q = s.questions[proposal.id];
  return !!q && q.status === 'open' && q.text === proposal.text;
}

/** The open questions a card may suggest: those whose response is not already an answer of this conversation. */
function openToSuggest(s: State, dealId: string, answered: ReadonlySet<string>) {
  return dealQuestions(s, dealId).filter((q) => q.status === 'open' && !answered.has(q.response));
}

/**
 * The open questions each answer may address, for the cards under it: answer message id to question ids, in the order
 * the model named them. Each question is under one answer only, the newest that may address it. A question whose
 * response is already an answer of this conversation is not suggested again. One a person said "not this one" to is
 * not shown, nor offered under an earlier answer instead.
 */
export function suggestedFor(s: State, dealId: string, list: Message[], answered: ReadonlySet<string>) {
  const out = new Map<string, string[]>();
  const open = new Set(openToSuggest(s, dealId, answered).map((q) => q.id));
  const offered = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.role !== 'ai' || m.state !== 'done') continue;
    // the questions the model proposed when this answer finished (#1120)
    const shown = (s.ui.proposed[m.id] ?? []).filter((proposal) => {
      const fresh = open.has(proposal.id) && !offered.has(proposal.id) && stillAsks(s, proposal);
      if (fresh) offered.add(proposal.id);
      return fresh && !s.ui.notThese.includes(`${m.id}|${proposal.id}`);
    });
    if (shown.length) out.set(m.id, shown.map((proposal) => proposal.id));
  }
  return out;
}
