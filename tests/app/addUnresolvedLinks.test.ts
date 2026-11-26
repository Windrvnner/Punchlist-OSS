// @vitest-environment node
// Add All Unresolved proposes a link from a point to an open question only where the model says the question already
// asks for it (#1120). Code keeps the pool, one question per point, and a person's approved link (#88).
import { expect, it } from 'vitest';
import { prepareUnresolved, retryUnresolvedLinks } from '../../src/app/addUnresolved';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { linkApproval } from '../../src/app/unresolvedLinks';
import { itemId } from '../../src/domain/checklist';
import { fail, ok } from '../../src/domain/result';
import type { AiService } from '../../src/ports';
import { val } from '../backend/reviewKit';
import { deal, make, rowsFrom } from './importKit';

type Same = NonNullable<AiService['sameMeaning']>;
type Asked = Parameters<Same>[0];

/** a deal with `points` checklist gaps and `questions` open questions; `same` stands in for the model */
async function fixture(points: number, questions: number, same: Same) {
  const { store } = make();
  const dealId = await deal(store);
  const numberOf = (t: string) => /\d+/.exec(t)![0];
  const gaps = Array.from({ length: points }, (_, k) => `Permit ${k + 1} is in place`);
  store.services.ai.checklist = async () => ok(gaps.map((t) => ({
    id: itemId(dealId, t), text: t, result: 'gap', docs: [], need: `The signed permit ${numberOf(t)}`,
  })));
  store.services.ai.phrase = async ({ items }) => ok(items.map(({ what }) => `Please provide: ${what}.`));
  store.services.ai.sameMeaning = same;
  const csv = Array.from({ length: questions }, (_, n) => `${n + 1},Please provide the lender file ${n + 1}`);
  const rows = rowsFrom(`Number,Question\n${csv.join('\n')}\n`);
  val(await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows }));
  return { store, dealId };
}
const preview = async (env: Awaited<ReturnType<typeof fixture>>, approved?: Parameters<typeof prepareUnresolved>[3]) =>
  val((await prepareUnresolved(env.store, env.dealId, undefined, approved))!);
const linksOf = (p: Awaited<ReturnType<typeof preview>>) => p.links.map(({ point, q }) => [point.what, q.text]);

it('proposes the links the model pairs with an open question, and nothing else', async () => {
  const asked: Asked[] = [];
  const env = await fixture(3, 2, async (input) => {
    asked.push(input);
    return ok({ pairs: [
      { a: 1, b: 0, inAgainst: true, why: 'same' }, { a: 0, b: 2, inAgainst: false, why: 'two points' },
    ] });
  });
  const ready = await preview(env);
  expect(linksOf(ready)).toEqual([['Permit 2 is in place', 'Please provide the lender file 1']]);
  expect(asked).toEqual([{
    kind: 'questions',
    items: [1, 2, 3].map((n) => `Permit ${n} is in place The signed permit ${n}`),
    against: ['Please provide the lender file 1', 'Please provide the lender file 2'],
  }]);
  expect(ready.points).toHaveLength(3);
  expect(ready.unchecked).toEqual([]);
});

it('keeps an approved link, never proposes its question for another point, and asks the model once', async () => {
  const asked: Asked[] = [];
  const env = await fixture(3, 2, async (input) => {
    asked.push(input);
    return ok({ pairs: input.items.map((_, a) => ({ a, b: 0, inAgainst: true, why: 'same' })) });
  });
  const first = await preview(env);
  expect(linksOf(first)).toEqual([['Permit 1 is in place', 'Please provide the lender file 1']]);
  const third = first.points[2];
  const approved = new Map([[third.key, linkApproval({ point: third, q: first.links[0].q })]]);
  const again = await preview(env, approved);
  // file 1 stays with the point it was approved for, and the model is not asked again: nothing it read has changed
  expect(linksOf(again)).toEqual([['Permit 3 is in place', 'Please provide the lender file 1']]);
  expect(asked).toHaveLength(1);
});

it('at 150 points and 2,000 open questions every point is drafted, linked only where the model answered', async () => {
  const asked: Asked[] = [];
  const env = await fixture(150, 2000, async (input) => {
    asked.push(input);
    expect(input.against).toHaveLength(2000);
    const at = input.only ?? input.items.map((_, n) => n);
    const answered = input.only ? at : at.slice(0, 100);
    const pairs = answered.map((a) => ({ a, b: a, inAgainst: true, why: 'same' }));
    return ok({ pairs, ...(input.only ? {} : { missed: { kind: 'failed' as const, at: at.slice(100) } }) });
  });
  const ready = await preview(env);
  expect(ready.points).toHaveLength(150);
  expect(ready.links).toHaveLength(100);
  expect(new Set(ready.links.map((link) => link.q.id)).size).toBe(100);
  expect(ready.unchecked.map((point) => point.what)).toEqual(ready.points.slice(100).map((point) => point.what));
  // Retry asks about just the points not checked, and adds their links to the preview
  const update = await retryUnresolvedLinks(env.store, env.dealId);
  const after = update(ready)!;
  expect(asked.at(-1)!.only).toEqual(Array.from({ length: 50 }, (_, n) => 100 + n));
  expect(after.links).toHaveLength(150);
  expect(after.unchecked).toEqual([]);
  expect(after.points).toBe(ready.points);
});

it('a failed call leaves every point drafted with no link, unchecked, and opening again asks again', async () => {
  let calls = 0;
  const env = await fixture(3, 2, async () => {
    calls++;
    return fail({ kind: 'unreachable', message: 'down' });
  });
  const ready = await preview(env);
  expect(ready.links).toEqual([]);
  expect(ready.points).toHaveLength(3);
  expect(ready.unchecked).toHaveLength(3);
  await preview(env);
  expect(calls).toBe(2);
});

it('two openings at once share one call, and a new open question asks again', async () => {
  let calls = 0;
  const env = await fixture(3, 2, async () => {
    calls++;
    return ok({ pairs: [] });
  });
  await Promise.all([preview(env), preview(env)]);
  expect(calls).toBe(1);
  const rows = rowsFrom('Number,Question\n3,Please provide the lender file 3\n');
  val(await env.store.dispatch(ImportQuestions, { dealId: env.dealId, mode: 'append', rows }));
  await preview(env);
  expect(calls).toBe(2);
});

it('a call that throws leaves the points unchecked for every opening waiting on it, and fails none', async () => {
  const env = await fixture(3, 2, async () => {
    throw new Error('The bridge dropped the call');
  });
  const [first, second] = await Promise.all([preview(env), preview(env)]);
  expect(first.unchecked).toHaveLength(3);
  expect(second.unchecked).toHaveLength(3);
  expect(second.points).toHaveLength(3);
});

it('where the model cannot be asked, no point is left unchecked and nothing is linked', async () => {
  const env = await fixture(3, 2, async () => ok({ pairs: [] }));
  delete env.store.services.ai.sameMeaning;
  const ready = await preview(env);
  expect(ready.unchecked).toEqual([]);
  expect(ready.links).toEqual([]);
  expect(ready.points).toHaveLength(3);
});
