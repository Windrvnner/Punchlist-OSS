// @vitest-environment node
// Already Asked? (#1218): the model is asked whether an open question already covers an unresolved point only when
// code scores the best question at or above `limits.askedCutoff`; the person still ticks every offer.
import { expect, it, vi } from 'vitest';
import { prepareUnresolved } from '../../src/app/addUnresolved';
import { CreateFinding } from '../../src/app/commands/findings';
import { CreateQuestion } from '../../src/app/commands/questions';
import { askedCandidates, linkApproval } from '../../src/app/unresolvedLinks';
import { itemId } from '../../src/domain/checklist';
import { fail, ok } from '../../src/domain/result';
import type { Unresolved } from '../../src/app/state';
import { val } from '../backend/reviewKit';
import { deal, make } from './importKit';

const INSURANCE = 'Insurance advisor report (final)';
const DIRECT = 'Direct agreement signed';
const ASKS_INSURANCE = 'Has the insurance advisor issued its final report yet?';
const ASKS_DIRECT = 'Please send the direct agreement draft.';

type Covers = NonNullable<ReturnType<typeof make>['store']['services']['ai']['covers']>;

async function fixture(covers: Covers | undefined, questions: string[], gaps = [INSURANCE, DIRECT]) {
  const { store } = make();
  const dealId = await deal(store);
  const rows = gaps.map((text) => ({ id: itemId(dealId, text), text, result: 'gap' as const, docs: [] }));
  store.services.ai.checklist = async () => ok(rows);
  store.services.ai.phrase = async ({ items }) => ok(items.map(({ what }) => `Please provide: ${what}`));
  if (covers) store.services.ai.covers = covers;
  else delete store.services.ai.covers;
  for (const text of questions) val(await store.dispatch(CreateQuestion, { dealId, text }));
  return { store, dealId, rows };
}
const linksOf = async ({ store, dealId }: Awaited<ReturnType<typeof fixture>>) => {
  const preview = val((await prepareUnresolved(store, dealId))!);
  return { preview, links: preview.links.map(({ point, q }) => [point.what, q.text]) };
};
const yes: Covers = async ({ checks }) => ok(checks.map(() => true));

it('asks only about the question that clears the cutoff and offers it when the model says yes', async () => {
  const covers = vi.fn(yes);
  const env = await fixture(covers, [ASKS_INSURANCE, ASKS_DIRECT]);
  const { links, preview } = await linksOf(env);
  expect(covers).toHaveBeenCalledTimes(1);
  expect(covers.mock.calls[0][0].checks).toEqual([{ point: INSURANCE, question: ASKS_INSURANCE }]);
  expect(links).toEqual([[INSURANCE, ASKS_INSURANCE]]);
  expect(preview.points.map((p) => p.what).sort()).toEqual([DIRECT, INSURANCE]);
});

it('makes no model call when no question clears the cutoff', async () => {
  const covers = vi.fn(yes);
  const env = await fixture(covers, [ASKS_DIRECT, 'Who audited the model?']);
  expect((await linksOf(env)).links).toEqual([]);
  expect(covers).not.toHaveBeenCalled();
});

const unanswered: [string, Covers][] = [
  ['says no', async ({ checks }) => ok(checks.map(() => false))],
  ['gives no answer', async ({ checks }) => ok(checks.map(() => null))],
  ['fails', async () => fail({ kind: 'failed', message: 'down' })],
  ['rejects the call', async () => { throw new Error('the bridge dropped'); }],
];
for (const [what, covers] of unanswered) {
  it(`offers nothing, and still drafts both points, when the model ${what}`, async () => {
    const asked = vi.fn(covers);
    const { links, preview } = await linksOf(await fixture(asked, [ASKS_INSURANCE]));
    expect(asked).toHaveBeenCalledTimes(1);
    expect(links).toEqual([]);
    expect(preview.points).toHaveLength(2);
  });
}

it('offers nothing, and makes no call, when the service cannot check', async () => {
  const { links, preview } = await linksOf(await fixture(undefined, [ASKS_INSURANCE]));
  expect(links).toEqual([]);
  expect(preview.points).toHaveLength(2);
});

it('makes no check when phrasing the questions fails, and none after the dialog is closed', async () => {
  const covers = vi.fn(yes);
  const env = await fixture(covers, [ASKS_INSURANCE]);
  env.store.services.ai.phrase = async () => fail({ kind: 'failed', message: 'down' });
  expect((await prepareUnresolved(env.store, env.dealId))?.ok).toBe(false);
  expect(covers).not.toHaveBeenCalled();
  env.store.services.ai.phrase = async ({ items }) => ok(items.map(() => 'Please provide it.'));
  const wait = new AbortController();
  const closing = prepareUnresolved(env.store, env.dealId, { count: () => wait.abort(), signal: wait.signal });
  expect(await closing).toBeUndefined();
});

it('returns nothing when the dialog is closed while the links are being checked', async () => {
  const wait = new AbortController();
  const closing: Covers = async ({ checks }) => {
    wait.abort();
    return ok(checks.map(() => true));
  };
  const env = await fixture(closing, [ASKS_INSURANCE]);
  expect(await prepareUnresolved(env.store, env.dealId, { count: () => {}, signal: wait.signal })).toBeUndefined();
});

it('works out the confidence the same way for a finding and a gap', async () => {
  const env = await fixture(vi.fn(yes), [ASKS_INSURANCE], []);
  val(await env.store.dispatch(CreateFinding, { dealId: env.dealId, title: INSURANCE, workstream: 'Legal' }));
  const { preview } = await linksOf(env);
  expect(preview.links.map(({ point }) => [point.kind, point.what])).toEqual([['finding', INSURANCE]]);
  const asGap = point(INSURANCE);
  const asFinding: Unresolved = { ...asGap, kind: 'finding', findingId: 'f_a', itemId: undefined };
  const pool = [question(1, ASKS_INSURANCE)];
  const confidence = (p: Unresolved) => askedCandidates([p], pool, undefined, 0).candidates[0].confidence;
  expect(confidence({ ...asGap, need: 'The final report from the insurance advisor' })).toBe(100);
  expect(confidence(asFinding)).toBe(100);
});

it('checks a short point whose every word a long question names: no minimum word count is set', () => {
  const long = question(1, 'Please describe the insurance programme: the advisor’s report, the broker and more.');
  const got = askedCandidates([point('Insurance advisor')], [long], undefined, 80).candidates;
  expect(got.map((c) => c.confidence)).toEqual([100]);
});

const point = (what: string): Unresolved => (
  { key: 'i:' + what, kind: 'gap', itemId: 'i_a', what, need: '', workstream: '' });
const question = (n: number, text: string) => ({ id: 'q' + n, n, text }) as never;

it('checks a question exactly at the cutoff and not one a percent below it', () => {
  const pool = [question(1, 'Please send the insurance advisor report.')];   // names 3 of the 4 words: 75 percent
  const at = (cutoff: number) => askedCandidates([point(INSURANCE)], pool, undefined, cutoff).candidates;
  expect(at(75).map((c) => [c.confidence, c.q.id])).toEqual([[75, 'q1']]);
  expect(at(76)).toEqual([]);
});

it('checks a question once, for the point that names most of its words', () => {
  const pool = [question(1, ASKS_INSURANCE)];
  const points = [point('Insurance advisor report schedule'), point(INSURANCE)];
  const got = askedCandidates(points, pool, undefined, 50).candidates;
  expect(got.map((c) => [c.point.what, c.confidence])).toEqual([[INSURANCE, 100]]);
  const reversed = askedCandidates([...points].reverse(), pool, undefined, 50).candidates;
  expect(reversed.map((c) => [c.point.what, c.confidence])).toEqual([[INSURANCE, 100]]);
});

it('compares exact shares, not whole percents: 7 of 9 words beats 27 of 35 though both read 77', () => {
  const named = Array.from({ length: 35 }, (_, k) => `k${k}`);
  const pool = [question(1, named.join(' '))];
  const smaller = point([...named.slice(0, 27), ...Array.from({ length: 8 }, (_, k) => `y${k}`)].join(' '));
  const larger = point([...named.slice(0, 7), 'z0', 'z1'].join(' '));
  const got = askedCandidates([smaller, larger], pool, undefined, 50).candidates;
  expect(got.map((c) => [c.point.key, c.confidence])).toEqual([[larger.key, 77]]);
  const reversed = askedCandidates([larger, smaller], pool, undefined, 50).candidates;
  expect(reversed.map((c) => [c.point.key, c.confidence])).toEqual([[larger.key, 77]]);
});

it('keeps a link the person approved and does not offer its question for another point', () => {
  const pool = [question(1, ASKS_INSURANCE)];
  const approved = new Map([['i:' + INSURANCE, linkApproval({ point: point(INSURANCE), q: pool[0] })]]);
  const points = [point('Insurance advisor final report'), point(INSURANCE)];
  const got = askedCandidates(points, pool, approved, 50);
  expect(got.kept.map((l) => [l.point, l.q.id])).toEqual([['i:' + INSURANCE, 'q1']]);
  expect(got.candidates).toEqual([]);
});

it('at 0 checks the best question for every point that shares a word, at 100 only one naming every word', () => {
  const pool = [question(1, 'Please send the insurance advisor report.')];   // names 3 of the 4 words: 75 percent
  const unrelated = point('Lock-up ratio');
  const at = (cutoff: number) => askedCandidates([point(INSURANCE), unrelated], pool, undefined, cutoff).candidates;
  expect(at(0).map((c) => c.point.what)).toEqual([INSURANCE]);   // a point sharing no word has no best question
  expect(at(100)).toEqual([]);
  const full = [question(2, ASKS_INSURANCE)];
  expect(askedCandidates([point(INSURANCE)], full, undefined, 100).candidates).toHaveLength(1);
  const letter = (k: number) => String.fromCharCode(97 + k);
  const words = Array.from({ length: 100 }, (_, k) => `term${letter(k % 26)}${letter(Math.floor(k / 26))}`);
  const nearly = [question(3, words.slice(1).join(' '))];   // names 99 of the point's 100 words: 99 percent
  expect(askedCandidates([point(words.join(' '))], nearly, undefined, 99).candidates[0].confidence).toBe(99);
  expect(askedCandidates([point(words.join(' '))], nearly, undefined, 100).candidates).toEqual([]);
});
