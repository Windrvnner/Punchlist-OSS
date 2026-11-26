// @vitest-environment node
// The suggested open question under a chat answer is the one the model proposed when the answer finished (#1120);
// code picks the candidates and keeps one question per answer, the newest answer winning.
import { expect, it } from 'vitest';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { ask, convKey, suggestions, type Scope } from '../../src/app/conversations';
import { fail, ok } from '../../src/domain/result';
import type { AiService } from '../../src/ports';
import { val } from '../backend/reviewKit';
import { deal, make } from './importKit';

type Suggest = NonNullable<AiService['suggestQuestion']>;
const OPERATING = 'Confirm the operating assumption in the base case and where the technical advisor sets it.';
const INSURANCE = 'Provide the insurance certificates for the construction period.';
/** the operating answer shares many words with the operating question */
const ANSWER = 'The base case operating assumption follows the technical advisor, who sets it at 98% availability.';

async function fixture(suggest: Suggest) {
  const { store } = make();
  const dealId = await deal(store);
  store.services.ai.answer = async () => ok({ text: ANSWER, sources: [] });
  store.services.ai.suggestQuestion = suggest;
  val(await store.dispatch(CreateQuestion, { dealId, text: INSURANCE }));
  val(await store.dispatch(CreateQuestion, { dealId, text: OPERATING }));
  const byText = (text: string) => Object.values(store.get().questions).find((q) => q.text === text)!;
  const scope: Scope = { kind: 'deal', dealId };
  const answers = () => (store.get().threads[convKey(scope)] ?? []).filter((m) => m.role === 'ai');
  return { store, dealId, scope, byText, answers };
}

it('suggests the question the model named, given the open questions by their text alone', async () => {
  const asked: Parameters<Suggest>[0][] = [];
  const env = await fixture(async (input) => {
    asked.push(input);
    return ok(1);
  });
  await ask(env.store, env.scope, 'What does the base case assume?');
  const [answer] = env.answers();
  expect([...suggestions(env.store.get(), env.scope)]).toEqual([[answer.id, env.byText(OPERATING).id]]);
  expect(asked).toEqual([{ dealId: env.dealId, answer: ANSWER, questions: [INSURANCE, OPERATING] }]);
});

it('no proposal, a place out of range, or a failed call gives no card, however many words they share', async () => {
  for (const reply of [ok(null), ok(5), fail({ kind: 'failed' as const, message: 'no' })]) {
    const env = await fixture(async () => reply);
    await ask(env.store, env.scope, 'What does the base case assume?');
    expect(suggestions(env.store.get(), env.scope).size).toBe(0);
  }
});

it('offers each question under the newest answer that proposed it, and never one already answered here', async () => {
  const env = await fixture(async ({ questions }) => ok(questions.indexOf(OPERATING)));
  await ask(env.store, env.scope, 'What does the base case assume?');
  await ask(env.store, env.scope, 'And who sets it?');
  const [first, second] = env.answers();
  const operating = env.byText(OPERATING);
  expect([...suggestions(env.store.get(), env.scope)]).toEqual([[second.id, operating.id]]);
  env.store.ui({ notThese: [`${second.id}|${operating.id}`] });
  expect(suggestions(env.store.get(), env.scope).size).toBe(0);
  env.store.ui({ notThese: [] });
  val(await env.store.dispatch(SetResponse, { dealId: env.dealId, questionId: operating.id, response: ANSWER }));
  expect(suggestions(env.store.get(), env.scope).size).toBe(0);
  expect(env.store.get().ui.proposed[first.id]).toBe(operating.id);
});

it('a question answered by this conversation is not offered to the model again', async () => {
  const asked: string[][] = [];
  const env = await fixture(async ({ questions }) => {
    asked.push(questions);
    return ok(null);
  });
  // the response is word for word the answer the conversation is about to give
  const operating = env.byText(OPERATING);
  val(await env.store.dispatch(SetResponse, { dealId: env.dealId, questionId: operating.id, response: ANSWER }));
  await ask(env.store, env.scope, 'What does the base case assume?');
  expect(asked).toEqual([[INSURANCE]]);
});
