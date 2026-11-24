// @vitest-environment node
import { expect, it } from 'vitest';
import { askedAbout, askedAtGap, checklistAsk, findingAskTarget } from '../../src/app/asking';
import { CloseSettledQuestions, closeSettledQuestions } from '../../src/app/commands/closeSettled';
import { CreateDeal } from '../../src/app/commands/deals';
import { SetQuestionsStatus } from '../../src/app/commands/questions';
import { registry } from '../../src/app/commands/undo';
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
  expect(target()).toMatchObject({ block: null, links: { linkedFinding: finding.id, linkedItem: row.id } });
  expect(checklist(false)).toEqual({ canAsk: true, offerAsk: true });
  expect(points()).toEqual([`f:${finding.id}`, `i:${gap.id}`]);

  state.findings[finding.id] = { ...finding, status: 'closed' };
  expect(target().block).toBe('closed-finding');
  expect(checklist(false)).toEqual({ canAsk: false, offerAsk: false });
  expect(points()).toEqual([`i:${gap.id}`]);

  state.findings[finding.id] = finding;
  state.items[item.id] = { ...item, off: true };
  expect(target()).toMatchObject({ block: 'off-item', links: { linkedFinding: finding.id, linkedItem: undefined } });
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
  expect(await run(ids)).toEqual({ kind: 'changed', count: 1 });
  expect(await run([ids[1]])).toEqual({ kind: 'changed', count: 1 });
  const preview = settledPreview(store.get(), dealId, offered, new Set());
  expect(preview.pickedIds).toEqual([ids[0]]);
  expect(preview.out.map(({ q, why }) => [q.id, why])).toEqual([[ids[1], 'Its item is no longer settled']]);
  const direct = await store.dispatch(CloseSettledQuestions, { dealId, questionIds: ids }, { quiet: true });
  expect(direct).toMatchObject({ ok: false, error: { message: '1 question changed since, so nothing was closed' } });
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

it('refreshes a journal retry so the original selection cannot close after an item changes', async () => {
  const { store, repo, dealId, ids, statuses, rows } = await closeFixture();
  const writable = refuse(repo.shared, toAQuestion, quota, 1);
  const first = await closeSettledQuestions(store, dealId, ids, `close-settled-${dealId}`);
  writable();
  expect(first.kind).toBe('failed');
  expect(statuses()).toEqual(['open', 'open']);
  const close = Object.values(store.get().ops).find((op) => op.command === CloseSettledQuestions.name)!;
  rows([asGap(agreement), insurance]);
  expect(await store.retryOp(close.id)).toMatchObject({
    ok: false, error: { message: '1 question changed since, so nothing was closed' },
  });
  expect(statuses()).toEqual(['open', 'open']);
});
