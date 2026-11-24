// @vitest-environment node
import { expect, it } from 'vitest';
import { askedAbout, askedAtGap, checklistAsk, findingAskTarget } from '../../src/app/asking';
import { CloseSettledQuestions, closeSettledQuestions } from '../../src/app/commands/closeSettled';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, SetFindingStatus } from '../../src/app/commands/findings';
import { CreateQuestion, EditQuestionField, SetQuestionsStatus } from '../../src/app/commands/questions';
import { registry } from '../../src/app/commands/undo';
import { logQuestionDraft, questionDraftAt } from '../../src/app/logQuestionDraft';
import { settledPreview, settledQuestionIds } from '../../src/app/settledView';
import { findingItem, initialState, itemStanding, unresolvedPoints } from '../../src/app/state';
import { Store } from '../../src/app/store';
import type { Item } from '../../src/domain/checklist';
import { derivedId } from '../../src/domain/derivedId';
import { Question } from '../../src/domain/model';
import { fail, ok } from '../../src/domain/result';
import type { ChecklistRow } from '../../src/ports';
import { quota, refuse, toAQuestion } from '../adapters/memRepo';
import { scaleMemoInput } from '../fixtures/memoScale';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { make } from './importKit';

const { deal, findings: [sampleFinding] } = scaleMemoInput;
const agreement: ChecklistRow = { id: 'direct', text: 'Executed direct agreement with lender consents',
  result: 'satisfied', docs: [], sources: [{ docId: 'd1', doc: 'Direct Agreement.pdf', loc: 'p. 12' }] };
const insurance: ChecklistRow = { id: 'insurance', text: 'Evidence of insurance for operating assets',
  result: 'satisfied', docs: [], sources: [{ docId: 'd2', doc: 'Insurance Report.pdf', loc: 'p. 8' }] };
const asGap = (row: ChecklistRow): ChecklistRow => ({ ...row, result: 'gap' });

function questionsFor(dealId: string) {
  return portfolioQuestions().map((text, index) => Question.parse({
    id: derivedId('q', [dealId, text]), dealId, n: index + 1, text,
    rev: 1, createdAt: deal.createdAt, updatedAt: deal.updatedAt,
  }));
}

it('shares the existing finding, gap and off-item rules across the detail views and unresolved list', () => {
  const state = initialState();
  const finding = { ...sampleFinding, dealId: deal.id, status: 'open' as const, itemId: agreement.id };
  const row: ChecklistRow = { ...agreement, result: 'finding', findingId: finding.id };
  const gap = asGap(insurance);
  const link = { id: row.id };
  const item: Item = { ...link, dealId: deal.id, text: row.text, rev: 1, normV: 1, off: false,
    createdAt: deal.createdAt, updatedAt: deal.updatedAt, section: '', subsection: '', from: [] };
  state.dealLoad[deal.id] = 'loaded';
  state.checklists[deal.id] = [row, gap];
  state.findings[finding.id] = finding;
  state.items[item.id] = item;
  const questions = questionsFor(deal.id);
  expect(questions.length).toBeGreaterThan(2000);
  state.questions = Object.fromEntries(questions.map((question) => [question.id, question]));

  const target = () => findingAskTarget(state.findings[finding.id], findingItem(state, finding));
  const checklist = (off: boolean) => checklistAsk(itemStanding(state, deal.id, row), off, 0, false);
  const points = () => unresolvedPoints(state, deal.id).points.map(({ key }) => key);
  expect(target()).toMatchObject({ why: null, links: { linkedFinding: finding.id, linkedItem: row.id } });
  expect(checklist(false)).toEqual({ canAsk: true, offerAsk: true });
  expect(points()).toEqual([`f:${finding.id}`, `i:${gap.id}`]);

  state.findings[finding.id] = { ...finding, status: 'closed' };
  expect(target().why).toBe('This finding is closed');
  expect(checklist(false)).toEqual({ canAsk: false, offerAsk: false });
  expect(points()).toEqual([`i:${gap.id}`]);

  state.findings[finding.id] = finding;
  state.items[item.id] = { ...item, off: true };
  expect(target()).toMatchObject({
    why: 'Its checklist item is turned off', links: { linkedFinding: finding.id, linkedItem: undefined },
  });
  expect(checklist(true)).toEqual({ canAsk: false, offerAsk: false });
  expect(points()).toEqual([`i:${gap.id}`]);

  const standing = itemStanding(state, deal.id, gap);
  expect(checklistAsk(standing, false, 2, false)).toEqual({ canAsk: true, offerAsk: false });
  expect(checklistAsk(standing, false, 2, true)).toEqual({ canAsk: true, offerAsk: true });
});

it('lists questions about an item and its finding once, by number and on the same deal', () => {
  const state = initialState();
  const questions = questionsFor(deal.id).reverse();
  const [both, aboutFinding, aboutGap, fromAnotherDeal] = questions;
  const linkedItem = { id: agreement.id };
  const linkedFinding = sampleFinding.id;
  state.questions = Object.fromEntries(questions.map((question) => [question.id, question]));
  state.questions[both.id] = { ...both, linkedFinding, linkedItem };
  state.questions[aboutFinding.id] = { ...aboutFinding, linkedFinding };
  state.questions[aboutGap.id] = { ...aboutGap, linkedItem };
  state.questions[fromAnotherDeal.id] = { ...fromAnotherDeal, dealId: 'other-deal', linkedItem };
  expect(askedAbout(state, deal.id, agreement.id, sampleFinding).map(({ id }) => id))
    .toEqual([aboutGap.id, aboutFinding.id, both.id]);
  expect(askedAtGap(state, deal.id, agreement.id).map(({ id }) => id)).toEqual([aboutGap.id]);
});

async function closeFixture() {
  const { store: base, repo } = make();
  const store = new Store({ ...base.services }, [CreateDeal, CloseSettledQuestions, SetQuestionsStatus]);
  registry.set(SetQuestionsStatus.name, SetQuestionsStatus);
  await store.boot();
  expect((await store.dispatch(CreateDeal, { name: 'Wind and Solar Portfolio', folders: [] })).ok).toBe(true);
  const dealId = Object.keys(store.get().deals)[0];
  const questions = questionsFor(dealId);
  questions[0] = { ...questions[0], linkedItem: { id: agreement.id } };
  questions[1] = { ...questions[1], linkedItem: { id: insurance.id } };
  expect((await repo.transaction({
    writes: questions.map((q) => ({ kind: 'question', id: q.id, data: q, expectedRev: null })),
    index: { dealId, add: questions.map((q) => ({ kind: 'question', id: q.id })) },
  })).ok).toBe(true);
  await store.loadDeal(dealId, { gaps: false });
  expect(Object.keys(store.get().questions)).toHaveLength(questions.length);
  const ids = questions.slice(0, 2).map(({ id }) => id);
  const rows = (value: ChecklistRow[]) => { store.services.ai.checklist = async () => ok(value); };
  rows([agreement, insurance]);
  await store.refreshChecklist(dealId);
  const statuses = () => ids.map((id) => store.get().questions[id].status);
  return { store, repo, dealId, ids, statuses, rows };
}

it('refuses stale single and bulk closes, and closes and undoes a fresh selection', async () => {
  const { store, dealId, ids, statuses, rows } = await closeFixture();
  const run = (questionIds: string[]) =>
    closeSettledQuestions(store, dealId, questionIds, `close-settled-${dealId}`);
  const offered = settledQuestionIds(store.get(), dealId);
  expect([...offered]).toEqual(ids);
  rows([agreement, asGap(insurance)]);
  const direct = await store.dispatch(CloseSettledQuestions, { dealId, questionIds: ids }, { quiet: true });
  expect(direct).toMatchObject({ ok: false, error: { message: '1 question changed since, so nothing was closed' } });
  expect(await run(ids)).toEqual({ kind: 'changed', count: 1 });
  expect(await run([ids[1]])).toEqual({ kind: 'changed', count: 1 });
  const preview = settledPreview(store.get(), dealId, offered, new Set());
  expect(preview.pickedIds).toEqual([ids[0]]);
  expect(preview.out.map(({ q, why }) => [q.id, why])).toEqual([[ids[1], 'Its item is no longer settled']]);
  expect(statuses()).toEqual(['open', 'open']);

  store.services.ai.checklist = async () => fail({ kind: 'failed', message: 'The checklist could not be read' });
  expect(await run(ids)).toEqual({ kind: 'checklist-unavailable' });
  expect(statuses()).toEqual(['open', 'open']);

  rows([agreement, insurance]);
  expect(await run(ids)).toEqual({ kind: 'closed' });
  expect(statuses()).toEqual(['closed', 'closed']);
  const close = Object.values(store.get().ops).find((op) => op.command === CloseSettledQuestions.name)!;
  rows([asGap(agreement), asGap(insurance)]);
  await store.refreshChecklist(dealId);
  expect((await store.undo(close.id)).ok).toBe(true);
  expect(statuses()).toEqual(['open', 'open']);
});

it.each(['current', 'legacy'])('refreshes a %s retry with unchanged question revisions', async (version) => {
  const { store, repo, dealId, ids, statuses, rows } = await closeFixture();
  const writable = refuse(repo.shared, toAQuestion, quota, 1);
  const idempotencyKey = `close-settled-${dealId}`;
  const set = ids.map((questionId) => ({ questionId, status: 'closed' as const }));
  const first = version === 'legacy'
    ? await store.dispatch(SetQuestionsStatus, { dealId, set }, { idempotencyKey })
    : await store.dispatch(CloseSettledQuestions, { dealId, questionIds: ids }, { idempotencyKey });
  writable();
  expect(first.ok).toBe(false);
  expect(statuses()).toEqual(['open', 'open']);
  const close = Object.values(store.get().ops).find((op) => op.idempotencyKey === idempotencyKey)!;
  rows([asGap(agreement), insurance]);
  store.closing();
  const restarted = new Store({ ...store.services }, [SetQuestionsStatus, CloseSettledQuestions]);
  await restarted.boot();
  expect(await restarted.retryOp(close.id)).toMatchObject({
    ok: false, error: { message: '1 question changed since, so nothing was closed' },
  });
  expect(ids.map((id) => restarted.get().questions[id].status)).toEqual(['open', 'open']);
});

function holdNextQuestionWrite(repo: ReturnType<typeof make>['repo']) {
  const transaction = repo.transaction.bind(repo);
  let markHeld!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  repo.transaction = async (change) => {
    if (change.writes.some(({ kind }) => kind === 'question')) {
      repo.transaction = transaction;
      markHeld();
      await wait;
    }
    return transaction(change);
  };
  return { held, release };
}

it('reads the checklist after queued work finishes and refuses a selection that became stale meanwhile', async () => {
  const { store, repo, dealId, ids, statuses, rows } = await closeFixture();
  const pending = holdNextQuestionWrite(repo);
  const edit = store.dispatch(EditQuestionField, {
    dealId, questionId: ids[0], field: 'text', value: 'Provide the signed direct agreement and lender consent letters.',
  });
  await pending.held;
  const close = closeSettledQuestions(store, dealId, ids, `close-settled-${dealId}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  rows([agreement, asGap(insurance)]);
  pending.release();
  expect((await edit).ok).toBe(true);
  expect(await close).toEqual({ kind: 'changed', count: 1 });
  expect(statuses()).toEqual(['open', 'open']);
});

it('refuses a queued ask after its finding closes and keeps the question text held by the card', async () => {
  const { store, repo, dealId } = await closeFixture();
  expect((await store.dispatch(CreateFinding, { dealId, title: sampleFinding.title, workstream: 'Legal' })).ok)
    .toBe(true);
  const findingId = Object.keys(store.get().findings)[0];
  const text = 'Which version of the lock-up ratio governs the first distribution?';
  const key = 'kept counterparty question';
  const drafts = new Map([[key, text]]);
  const draft = questionDraftAt(key, (id) => id, drafts, (id) => drafts.delete(id));
  const pending = holdNextQuestionWrite(repo);
  const created = store.dispatch(CreateQuestion, { dealId, text: 'Provide the exposure summary for the new asset.' });
  await pending.held;
  const ask = logQuestionDraft(text, draft, async () => {
    const result = await store.dispatch(CreateQuestion, { dealId, text, askOrigin: { kind: 'finding', findingId } });
    expect(result).toMatchObject({ ok: false, error: { message: 'This finding is closed' } });
    return result;
  }, () => false);
  expect((await store.dispatch(SetFindingStatus, { dealId, findingId, status: 'closed' })).ok).toBe(true);
  pending.release();
  expect((await created).ok).toBe(true);
  await ask;
  expect(drafts.get(key)).toBe(text);
  expect(Object.values(store.get().questions).some((question) => question.text === text)).toBe(false);
});
