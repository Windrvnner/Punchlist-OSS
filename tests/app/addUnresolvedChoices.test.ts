// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { prepareUnresolved, selectUnresolved, submitUnresolved } from '../../src/app/addUnresolved';
import { AddUnresolved } from '../../src/app/commands/addUnresolved';
import { CreateFinding } from '../../src/app/commands/findings';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { linkApproval, type ApprovedLinks } from '../../src/app/unresolvedLinks';
import { itemId } from '../../src/domain/checklist';
import { ok } from '../../src/domain/result';
import { ELSEWHERE } from '../adapters/memRepo';
import { val } from '../backend/reviewKit';
import { ITEMS } from '../fixtures/pastedList';
import { deal, make } from './importKit';

const base = 'Certificate renewal lender compliance';
const alphaTitle = `${base} Alpha`;
const betaTitle = `${base} Beta`;

async function previewOf(store: ReturnType<typeof make>['store'], dealId: string, approved?: ApprovedLinks) {
  return val((await prepareUnresolved(store, dealId, undefined, approved))!);
}

async function fixture(partial: boolean) {
  const { store, repo } = make();
  const dealId = await deal(store);
  store.services.ai.checklist = async () => ok(ITEMS.map(({ t }) => ({
    id: itemId(dealId, t), text: t, result: 'gap', docs: [],
  })));
  store.services.ai.phrase = async ({ items }) => ok(items.map(({ what }) =>
    partial && what !== alphaTitle ? null : `Please document this requirement: ${what}.`));
  val(await store.dispatch(CreateFinding, { dealId, title: betaTitle, workstream: 'Legal' }));
  val(await store.dispatch(CreateFinding, { dealId, title: alphaTitle, workstream: 'Legal' }));
  val(await store.dispatch(CreateQuestion, { dealId, text: base }));
  const initial = await previewOf(store, dealId);
  const link = initial.links.find((suggestion) => suggestion.point.what === alphaTitle)!;
  expect(link.q.text).toBe(base);
  const approved = new Map([[link.point.key, linkApproval(link)]]);
  return { store, repo, dealId, link, approved };
}

it.each([false, true])('keeps the approved pair through a new recommendation (partial=%s)', async (partial) => {
  const { store, dealId, link, approved } = await fixture(partial);
  val(await store.dispatch(CreateQuestion, { dealId, text: alphaTitle }));
  const preview = await previewOf(store, dealId, approved);
  expect(preview.links.find(({ q }) => q.id === link.q.id)?.point.what).toBe(alphaTitle);
  const picked = selectUnresolved(preview, new Set(), approved);
  expect(picked.links.map(({ point, q }) => [point.what, q.id])).toEqual([[alphaTitle, link.q.id]]);
  expect(picked.points.some((point) => point.what === alphaTitle)).toBe(false);
  expect(picked.points.some((point) => point.what === betaTitle)).toBe(!partial);
  expect(await submitUnresolved(store, dealId, picked)).toEqual({ kind: 'added' });
  expect(store.get().questions[link.q.id].linkedFinding).toBe(link.point.findingId);
});

it('offers the draft again when the previously approved question gets an answer', async () => {
  const { store, dealId, link, approved } = await fixture(false);
  val(await store.dispatch(SetResponse, { dealId, questionId: link.q.id, response: 'Renewal review is ongoing.' }));
  const preview = await previewOf(store, dealId, approved);
  const picked = selectUnresolved(preview, new Set(), approved);
  expect(picked.links).toEqual([]);
  expect(picked.points.some((point) => point.what === alphaTitle)).toBe(true);
  expect(selectUnresolved(preview, new Set([link.point.key]), approved).points).not.toContainEqual(
    expect.objectContaining({ what: alphaTitle }),
  );
});

it('refuses the approved link at the write boundary when another PC rewrites the finding', async () => {
  const { store, repo, dealId, link } = await fixture(false);
  const findingId = link.point.findingId!;
  const title = 'Escrow account beneficiary and payment directions';
  repo.peer.change('finding', findingId, { ...store.get().findings[findingId], title }, ELSEWHERE);
  val(await repo.sync());
  await vi.waitFor(() => expect(store.get().findings[findingId].title).toBe(title));
  const result = await store.dispatch(AddUnresolved, {
    dealId, add: [],
    link: [{ questionId: link.q.id, linkedFinding: findingId, approval: linkApproval(link).fingerprint }],
  });
  expect(result.ok).toBe(false);
  expect(store.get().questions[link.q.id].linkedFinding).toBeUndefined();
});

const COVENANTS = ['Debt service coverage', 'Leverage', 'Reserve funding', 'Insurance', 'Permits', 'Title', 'Offtake'];

/** A deal at working size: 126 more findings across workstreams and 40 more open questions around the approved pair. */
async function crowd(store: ReturnType<typeof make>['store'], dealId: string) {
  for (let n = 0; n < 126; n++) {
    const title = `${COVENANTS[n % COVENANTS.length]} requirement ${n} lacks supporting schedule`;
    val(await store.dispatch(CreateFinding, { dealId, title, workstream: n % 2 ? 'Legal' : 'Financial' }));
  }
  for (let n = 0; n < 40; n++) {
    const text = `Please confirm the ${COVENANTS[n % 7]} terms, item ${n}`;
    val(await store.dispatch(CreateQuestion, { dealId, text }));
  }
}

it('refuses the approved link when another PC rewrites the finding between plan and commit', async () => {
  const { store, repo, dealId, link } = await fixture(false);
  await crowd(store, dealId);
  const findingId = link.point.findingId!;
  const title = 'Escrow account beneficiary and payment directions';
  const commit = repo.transaction.bind(repo);
  let edited = false;
  vi.spyOn(repo, 'transaction').mockImplementation(async (tx) => {
    // the plan has read the finding and the question; the peer's edit arrives just before the write
    if (!edited && tx.writes.some((write) => write.kind === 'question')) {
      edited = true;
      repo.peer.change('finding', findingId, { ...store.get().findings[findingId], title }, ELSEWHERE);
      val(await repo.sync());
    }
    return commit(tx);
  });
  const result = await store.dispatch(AddUnresolved, {
    dealId, add: [],
    link: [{ questionId: link.q.id, linkedFinding: findingId, approval: linkApproval(link).fingerprint }],
  });
  expect(edited).toBe(true);
  expect(result.ok).toBe(false);
  expect(store.get().questions[link.q.id].linkedFinding).toBeUndefined();
});
