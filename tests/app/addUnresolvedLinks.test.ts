// @vitest-environment node
// Add All Unresolved proposes a link from a point to an open question only where the model says the question already
// asks for it (#1120). Code keeps the pool, one question per point, and a person's approved link (#88).
import { expect, it } from 'vitest';
import { prepareUnresolved } from '../../src/app/addUnresolved';
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
});

it('keeps a link a person approved and does not propose its question for another point', async () => {
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
  // file 1 stays with the point it was approved for; the model is shown only the other question, for the other points
  expect(linksOf(again)).toEqual([
    ['Permit 1 is in place', 'Please provide the lender file 2'], ['Permit 3 is in place', 'Please provide the lender file 1'],
  ]);
  expect(asked.at(-1)!.items).toEqual([1, 2].map((n) => `Permit ${n} is in place The signed permit ${n}`));
  expect(asked.at(-1)!.against).toEqual(['Please provide the lender file 2']);
});

it('at 150 points and 2,000 open questions every point is drafted, linked only where the model answered', async () => {
  const env = await fixture(150, 2000, async (input) => {
    expect(input.against).toHaveLength(2000);
    const pairs = input.items.slice(0, 100).map((_, a) => ({ a, b: a, inAgainst: true, why: 'same' }));
    return ok({ pairs, missed: { kind: 'failed' as const, at: Array.from({ length: 50 }, (_, n) => 100 + n) } });
  });
  const ready = await preview(env);
  expect(ready.points).toHaveLength(150);
  expect(ready.links).toHaveLength(100);
  expect(new Set(ready.links.map((link) => link.q.id)).size).toBe(100);
});

it('a failed call leaves every point drafted with no link', async () => {
  const env = await fixture(3, 2, async () => fail({ kind: 'unreachable', message: 'down' }));
  const ready = await preview(env);
  expect(ready.links).toEqual([]);
  expect(ready.points).toHaveLength(3);
});
