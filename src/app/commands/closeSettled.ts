import { z } from 'zod';
import { DealId, QuestionId } from '../../domain/model';
import { fail, type Failure } from '../../domain/result';
import { define, type Command } from '../command';
import { settledChecklistAvailable, settledQuestionIds } from '../settledView';
import type { State } from '../state';
import type { Store } from '../store';
import { SetQuestionsStatus } from './questions';

type CloseBlocked = { kind: 'checklist-unavailable' } | { kind: 'changed'; count: number };
type CloseOutcome = CloseBlocked | { kind: 'closed' } | { kind: 'failed'; message: string };
type CloseRefusal = Extract<Failure, { kind: 'rejected' }> & { closeBlocked: CloseBlocked };

function closeBlocked(state: State, dealId: string, questionIds: readonly string[]): CloseBlocked | null {
  if (!settledChecklistAvailable(state, dealId)) return { kind: 'checklist-unavailable' };
  const settled = settledQuestionIds(state, dealId);
  const count = questionIds.filter((id) => !settled.has(id)).length;
  return count ? { kind: 'changed', count } : null;
}

function refusal(closeBlocked: CloseBlocked) {
  const count = closeBlocked.kind === 'changed' ? closeBlocked.count : 0;
  const label = count === 1 ? 'question' : 'questions';
  const message = count ? `${count.toLocaleString('en-US')} ${label} changed since, so nothing was closed`
    : 'Couldn’t load the checklist';
  const error: CloseRefusal = { kind: 'rejected', message, closeBlocked };
  return fail(error);
}

const isCloseRefusal = (error: Failure): error is CloseRefusal =>
  error.kind === 'rejected' && 'closeBlocked' in error;

const refresh = (store: Pick<Store, 'refreshChecklist'>, { dealId }: { dealId: string }) =>
  store.refreshChecklist(dealId);

/** Closing from the checklist is guarded even if its caller bypasses the preview. */
export const CloseSettledQuestions = define({
  name: 'CloseSettledQuestions',
  input: z.object({ dealId: DealId, questionIds: z.array(QuestionId).min(1) }),
  targets: (_state, input) => input.questionIds,
  prepare: (store, input) => refresh(store, input),
  plan(state, { dealId, questionIds }, ctx) {
    const blocked = closeBlocked(state, dealId, questionIds);
    if (blocked) return refusal(blocked);
    const set = questionIds.map((questionId) => ({ questionId, status: 'closed' as const }));
    return SetQuestionsStatus.plan(state, { dealId, set }, ctx);
  },
});

const legacyClose = define({
  ...SetQuestionsStatus,
  prepare: (store, input) => refresh(store, input),
  plan(state, input, ctx) {
    const ids = input.set.filter(({ status }) => status === 'closed').map(({ questionId }) => questionId);
    const blocked = ids.length ? closeBlocked(state, input.dealId, ids) : null;
    return blocked ? refusal(blocked) : SetQuestionsStatus.plan(state, input, ctx);
  },
});

/** Journal entries from before the dedicated close command retain their name and input shape. */
export function guardLegacySettledClose<I, In>(command: Command<I, In>, key?: string): Command<I, In> {
  if (command.name === SetQuestionsStatus.name && key?.startsWith('close-settled-')) {
    return legacyClose as unknown as Command<I, In>;
  }
  return command;
}

/** Let each control show its own wording for a checklist refusal. */
export async function closeSettledQuestions(
  store: Store, dealId: string, questionIds: string[], idempotencyKey: string,
): Promise<CloseOutcome> {
  const result = await store.dispatch(CloseSettledQuestions, { dealId, questionIds }, {
    idempotencyKey, quietRefusal: isCloseRefusal,
  });
  if (result.ok) return { kind: 'closed' };
  if (isCloseRefusal(result.error)) return result.error.closeBlocked;
  return { kind: 'failed', message: result.error.message };
}
