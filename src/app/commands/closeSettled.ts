import { z } from 'zod';
import { DealId, QuestionId } from '../../domain/model';
import { fail, rejected } from '../../domain/result';
import { define } from '../command';
import { settledChecklistAvailable, settledQuestionIds } from '../settledView';
import type { State } from '../state';
import type { Store } from '../store';
import { SetQuestionsStatus } from './questions';

type CloseBlocked = { kind: 'checklist-unavailable' } | { kind: 'changed'; count: number };
type CloseOutcome = CloseBlocked | { kind: 'closed' } | { kind: 'failed'; message: string };

function closeBlocked(state: State, dealId: string, questionIds: readonly string[]): CloseBlocked | null {
  if (!settledChecklistAvailable(state, dealId)) return { kind: 'checklist-unavailable' };
  const settled = settledQuestionIds(state, dealId);
  const count = questionIds.filter((id) => !settled.has(id)).length;
  return count ? { kind: 'changed', count } : null;
}

/** Closing from the checklist is guarded even if its caller bypasses the preview. */
export const CloseSettledQuestions = define({
  name: 'CloseSettledQuestions',
  input: z.object({ dealId: DealId, questionIds: z.array(QuestionId).min(1) }),
  targets: (_state, input) => input.questionIds,
  plan(state, { dealId, questionIds }, ctx) {
    const blocked = closeBlocked(state, dealId, questionIds);
    if (blocked?.kind === 'checklist-unavailable') return fail(rejected('Couldn’t load the checklist'));
    if (blocked) {
      const count = blocked.count.toLocaleString('en-US');
      const label = blocked.count === 1 ? 'question' : 'questions';
      return fail(rejected(`${count} ${label} changed since, so nothing was closed`));
    }
    const set = questionIds.map((questionId) => ({ questionId, status: 'closed' as const }));
    return SetQuestionsStatus.plan(state, { dealId, set }, ctx);
  },
});

/** Read again before applying either close. The command checks again when it reaches the head of the queue. */
export async function closeSettledQuestions(
  store: Store, dealId: string, questionIds: string[], idempotencyKey: string,
): Promise<CloseOutcome> {
  await store.refreshChecklist(dealId);
  const blocked = closeBlocked(store.get(), dealId, questionIds);
  if (blocked) return blocked;
  const result = await store.dispatch(CloseSettledQuestions, { dealId, questionIds }, { idempotencyKey });
  return result.ok ? { kind: 'closed' } : { kind: 'failed', message: result.error.message };
}
