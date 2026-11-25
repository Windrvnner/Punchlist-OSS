import type { Question } from '../domain/model';
import { settledQuestions, type State } from './state';

export const settledChecklistAvailable = (state: Pick<State, 'checklists'>, dealId: string) =>
  Array.isArray(state.checklists[dealId]);

export const settledQuestionIds = (state: State, dealId: string) =>
  new Set(settledQuestions(state, dealId).close.map(({ q }) => q.id));

export const settledQuestion = (state: State, question: Question) =>
  settledQuestions(state, question.dealId).close.find(({ q }) => q.id === question.id);

export const settledQuestionCount = (state: State, dealId: string) => settledQuestions(state, dealId).close.length;

function leftOutSince(question: Question): string {
  if (question.status === 'open') return 'Its item is no longer settled';
  return `${question.status.charAt(0).toUpperCase()}${question.status.slice(1)} since`;
}

/** Keep the live preview and questions that lost their place after the dialog opened together. */
export function settledPreview(
  state: State, dealId: string, offered: ReadonlySet<string>, unchecked: ReadonlySet<string>,
) {
  const { close, left } = settledQuestions(state, dealId);
  const current = new Set([...close, ...left].map(({ q }) => q.id));
  const out = [...left];
  for (const id of offered) {
    const question = state.questions[id];
    if (question && !current.has(id)) out.push({ q: question, why: leftOutSince(question) });
  }
  out.sort((first, second) => first.q.n - second.q.n);
  const pickedIds = close.map(({ q }) => q.id).filter((id) => !unchecked.has(id));
  return { close, out, pickedIds };
}
