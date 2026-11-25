import { toParagraphs } from '../domain/cite';
import type { Finding, Source } from '../domain/model';
import { CreateFinding } from './commands/findings';
import { CreateQuestion } from './commands/questions';
import { createdRecord } from './createdRecord';
import { keepAsEdit } from './findingDrafts';
import { hasTexts, keptDrafts } from './keptText';
import type { Store } from './store';

export type CardDraft = { text: string; ws: string };
export const answerQuestionDrafts = keptDrafts('answer-question', hasTexts('text', 'ws'));
export const answerFindingDrafts = keptDrafts('answer-finding', hasTexts('text', 'ws'));

const sameDraft = (left: CardDraft, right: CardDraft) => left.text === right.text && left.ws === right.ws;

/** Read the current draft even if the card that originally sent the save was closed and reopened (#771). */
export function answerCardDraft(drafts: Map<string, CardDraft>, answerId: string, start: CardDraft) {
  const latest = () => drafts.get(answerId) ?? start;
  const forget = () => drafts.delete(answerId);
  const remember = (draft: CardDraft) => {
    if (sameDraft(draft, start)) forget();
    else drafts.set(answerId, draft);
  };
  const landed = (sent: CardDraft) => {
    if (!sameDraft(latest(), sent)) return false;
    forget();
    return true;
  };
  return { latest, forget, remember, landed };
}

/** Log the version sent, while leaving any newer typing on the card. */
export async function saveAnswerQuestion(store: Store, input: {
  dealId: string;
  linkedFinding?: string;
  draft: ReturnType<typeof answerCardDraft>;
  sent: CardDraft;
  cancelled(): boolean;
}) {
  const { dealId, linkedFinding, draft, sent, cancelled } = input;
  const result = await store.dispatch(CreateQuestion, {
    dealId, linkedFinding, text: sent.text.trim(), workstream: sent.ws,
  }, { idempotencyKey: 'card-q-' + dealId });
  return result.ok && !cancelled() && draft.landed(sent);
}

type AnswerFindingSave = {
  dealId: string;
  text: string;
  sources: Source[];
  draft: ReturnType<typeof answerCardDraft>;
  sent: CardDraft;
  cancelled(): boolean;
};
type AnswerFindingOutcome =
  | { kind: 'refused'; reason: string }
  | { kind: 'saved'; made: Finding | undefined; closes: boolean; editing: boolean };

/** More typed while Create was out becomes an open edit of the finding it made (#115). */
export async function saveAnswerFinding(
  store: Store, { dealId, text, sources, draft, sent, cancelled }: AnswerFindingSave,
): Promise<AnswerFindingOutcome> {
  const finding = { title: sent.text, workstream: sent.ws, body: toParagraphs(text) };
  const input = { dealId, ...finding, sources, origin: 'chat' as const };
  const result = await store.dispatch(CreateFinding, input, { idempotencyKey: 'card-f-' + dealId, quiet: true });
  if (!result.ok) return { kind: 'refused', reason: result.error.message };
  const made = createdRecord(store.get(), result.value.opId, 'findings');
  if (cancelled()) return { kind: 'saved', made, closes: false, editing: false };
  if (draft.landed(sent)) return { kind: 'saved', made, closes: true, editing: false };
  if (!made) return { kind: 'saved', made, closes: false, editing: false };
  const next = draft.latest();
  keepAsEdit(made, { title: next.text, ws: next.ws, body: made.body.join('\n\n') }, finding);
  draft.forget();
  return { kind: 'saved', made, closes: true, editing: true };
}
