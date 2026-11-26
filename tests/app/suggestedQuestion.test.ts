// @vitest-environment node
// The suggested open question under a chat answer is the one the model proposed when the answer finished (#1120);
// code picks the candidates and keeps one question per answer, the newest answer winning.
import { expect, it } from 'vitest';
import {
  CreateQuestion, DeleteQuestion, EditQuestionField, SetQuestionStatus, SetResponse,
} from '../../src/app/commands/questions';
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
    return ok([1]);
  });
  await ask(env.store, env.scope, 'What does the base case assume?');
  const [answer] = env.answers();
  expect([...suggestions(env.store.get(), env.scope)]).toEqual([[answer.id, [env.byText(OPERATING).id]]]);
  expect(asked).toEqual([{ dealId: env.dealId, answer: ANSWER, questions: [INSURANCE, OPERATING] }]);
});

it('no proposal, a place out of range, or a failed call gives no card, however many words they share', async () => {
  for (const reply of [ok([]), ok([5]), fail({ kind: 'failed' as const, message: 'no' })]) {
    const env = await fixture(async () => reply);
    await ask(env.store, env.scope, 'What does the base case assume?');
    expect(suggestions(env.store.get(), env.scope).size).toBe(0);
    // a failed call is not saved as a verdict of its own
    expect(env.store.get().ui.proposed).toEqual({});
  }
});

it('offers each question under the newest answer that proposed it, and never one already answered here', async () => {
  const env = await fixture(async ({ questions }) => ok([questions.indexOf(OPERATING)]));
  await ask(env.store, env.scope, 'What does the base case assume?');
  await ask(env.store, env.scope, 'And who sets it?');
  const [first, second] = env.answers();
  const operating = env.byText(OPERATING);
  expect([...suggestions(env.store.get(), env.scope)]).toEqual([[second.id, [operating.id]]]);
  env.store.ui({ notThese: [`${second.id}|${operating.id}`] });
  expect(suggestions(env.store.get(), env.scope).size).toBe(0);
  env.store.ui({ notThese: [] });
  val(await env.store.dispatch(SetResponse, { dealId: env.dealId, questionId: operating.id, response: ANSWER }));
  expect(suggestions(env.store.get(), env.scope).size).toBe(0);
  expect(env.store.get().ui.proposed[first.id]).toEqual([{ id: operating.id, text: OPERATING }]);
});

it('a question answered by this conversation is not offered to the model again', async () => {
  const asked: string[][] = [];
  const env = await fixture(async ({ questions }) => {
    asked.push(questions);
    return ok([]);
  });
  // the response is word for word the answer the conversation is about to give
  const operating = env.byText(OPERATING);
  val(await env.store.dispatch(SetResponse, { dealId: env.dealId, questionId: operating.id, response: ANSWER }));
  await ask(env.store, env.scope, 'What does the base case assume?');
  expect(asked).toEqual([[INSURANCE]]);
});

it('a question edited to another meaning while the call is pending, or after it, is not suggested', async () => {
  const LOCKUP = 'Which lock-up ratio was agreed in the credit agreement draft?';
  for (const when of ['pending', 'after'] as const) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const env = await fixture(async (input) => {
      if (when === 'pending') await gate;
      return ok([input.questions.indexOf(OPERATING)]);
    });
    const q = env.byText(OPERATING);
    const edit = () => env.store.dispatch(EditQuestionField, {
      dealId: env.dealId, questionId: q.id, field: 'text', value: LOCKUP,
    });
    const asking = ask(env.store, env.scope, 'What does the base case assume?');
    if (when === 'pending') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      val(await edit());
      release();
    }
    await asking;
    if (when === 'after') {
      expect(suggestions(env.store.get(), env.scope).size).toBe(1);
      val(await edit());
    }
    expect(env.store.get().questions[q.id].text).toBe(LOCKUP);
    expect(suggestions(env.store.get(), env.scope).size).toBe(0);
    // a stale proposal is dropped when the reply arrives, never kept to be hidden later
    if (when === 'pending') expect(env.store.get().ui.proposed).toEqual({});
  }
});

it('a question closed or deleted while the call is pending, or after it, is not suggested', async () => {
  for (const change of ['closed', 'deleted'] as const) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const env = await fixture(async (input) => {
      await gate;
      return ok([input.questions.indexOf(OPERATING)]);
    });
    const q = env.byText(OPERATING);
    const asking = ask(env.store, env.scope, 'What does the base case assume?');
    await new Promise((resolve) => setTimeout(resolve, 20));
    val(change === 'closed'
      ? await env.store.dispatch(SetQuestionStatus, { dealId: env.dealId, questionId: q.id, status: 'closed' })
      : await env.store.dispatch(DeleteQuestion, { dealId: env.dealId, questionId: q.id }));
    release();
    await asking;
    expect(suggestions(env.store.get(), env.scope).size).toBe(0);
    expect(env.store.get().ui.proposed).toEqual({});
  }
});

it('edited back to the same text, the proposal holds again; a dismissal stays by answer and question', async () => {
  const env = await fixture(async (input) => ok([input.questions.indexOf(OPERATING)]));
  await ask(env.store, env.scope, 'What does the base case assume?');
  const [answer] = env.answers();
  const q = env.byText(OPERATING);
  const edit = (value: string) => env.store.dispatch(EditQuestionField, {
    dealId: env.dealId, questionId: q.id, field: 'text', value,
  });
  val(await edit('Which lock-up ratio was agreed?'));
  expect(suggestions(env.store.get(), env.scope).size).toBe(0);
  val(await edit(OPERATING));
  expect(suggestions(env.store.get(), env.scope).get(answer.id)).toEqual([q.id]);
  // put away, then reworded and put back: it was put away for this answer and question, so it stays away
  env.store.putAway(answer.id, q.id);
  val(await edit('Which lock-up ratio was agreed?'));
  val(await edit(OPERATING));
  expect(suggestions(env.store.get(), env.scope).size).toBe(0);
});

it('every question the model named is suggested under the answer, each with its own freshness', async () => {
  const env = await fixture(async () => ok([0, 1]));
  await ask(env.store, env.scope, 'What does the base case assume?');
  const [answer] = env.answers();
  const both = [env.byText(INSURANCE).id, env.byText(OPERATING).id];
  expect(suggestions(env.store.get(), env.scope).get(answer.id)).toEqual(both);
  // one is edited to another meaning: only the other is still offered
  val(await env.store.dispatch(EditQuestionField, {
    dealId: env.dealId, questionId: both[0], field: 'text', value: 'When does the EPC guarantee expire?',
  }));
  expect(suggestions(env.store.get(), env.scope).get(answer.id)).toEqual([both[1]]);
});
