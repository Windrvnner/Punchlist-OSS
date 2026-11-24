// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding } from '../../src/app/commands/findings';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { RestoreQuestionSnapshots, TakeFromQaLog } from '../../src/app/commands/qaLogs';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { registry, Undo } from '../../src/app/commands/undo';
import { dealFindings, dealQuestions } from '../../src/app/state';
import { dealList } from '../backend/dealList';
import { pc, row } from './pcs';

registry.set(RestoreQuestionSnapshots.name, RestoreQuestionSnapshots);
afterEach(() => vi.restoreAllMocks());

const reserve = { title: 'Reserve has no confirmed funding source', body: ['The reserve terms leave funding open.'] };
const insurance = { title: 'Insurance certificates are missing', body: ['Coverage terms have yet to be verified.'] };
const funding = 'The reserve will be funded from operating cash flow.';
const balance = 'The opening balance will cover six months of debt service.';
const coverage = 'The certificates show construction and operating coverage.';

async function setup() {
  const { store, repo } = pc('This PC', 'Reviewer');
  await store.boot();
  expect((await store.dispatch(CreateDeal, { name: 'Sample deal', folders: [] })).ok).toBe(true);
  const [dealId] = Object.keys(store.get().deals);
  await store.loadDeal(dealId, { gaps: false });

  for (const finding of [reserve, insurance]) {
    expect((await store.dispatch(CreateFinding, { dealId, workstream: 'Financial', ...finding })).ok).toBe(true);
  }
  const [reserveFinding, insuranceFinding] = [reserve, insurance].map(({ title }) =>
    dealFindings(store.get(), dealId).find((finding) => finding.title === title)!);
  for (const [text, linkedFinding] of [
    ['How will the reserve be funded?', reserveFinding.id],
    ['What is the opening reserve balance?', reserveFinding.id],
    ['What do the insurance certificates cover?', insuranceFinding.id],
  ]) {
    expect((await store.dispatch(CreateQuestion, { dealId, text, linkedFinding })).ok).toBe(true);
  }
  const [fundingQuestion, balanceQuestion, coverageQuestion] = dealQuestions(store.get(), dealId);
  return { store, repo, dealId, reserveFinding, insuranceFinding, fundingQuestion, balanceQuestion, coverageQuestion };
}

describe('marks from one Q&A log update', () => {
  it('keeps both responses on one finding, with one write per finding and one Undo at deal scale', async () => {
    const {
      store, repo, dealId, reserveFinding, insuranceFinding, fundingQuestion, balanceQuestion, coverageQuestion,
    } = await setup();
    const rows = dealList().items.map((text, index) => row(index + 4, text));
    expect((await store.dispatch(ImportQuestions, { dealId, rows, mode: 'append' })).ok).toBe(true);
    expect(dealQuestions(store.get(), dealId)).toHaveLength(2_403);
    const writes = vi.spyOn(repo, 'transaction');
    const taken = await store.dispatch(TakeFromQaLog, { dealId, set: {
      [fundingQuestion.id]: { response: funding },
      [balanceQuestion.id]: { response: balance },
      [coverageQuestion.id]: { response: coverage },
    } });
    if (!taken.ok) throw new Error(taken.error.message);

    const saved = await repo.get('finding', reserveFinding.id);
    expect(saved.ok && saved.value?.conflict).toBeUndefined();
    expect(saved.ok && saved.value?.rev).toBe(reserveFinding.rev + 1);
    expect(store.get().findings[reserveFinding.id].updatedOn?.questions).toEqual([
      fundingQuestion.id, balanceQuestion.id,
    ]);
    expect(store.get().findings[insuranceFinding.id].updatedOn?.questions).toEqual([coverageQuestion.id]);
    const findingWrites = () => writes.mock.calls.flatMap(([transaction]) =>
      transaction.writes.filter(({ kind }) => kind === 'finding').map(({ id }) => id));
    expect(findingWrites().sort()).toEqual([reserveFinding.id, insuranceFinding.id].sort());
    expect(store.get().questions[fundingQuestion.id].response).toBe(funding);
    expect(store.get().questions[balanceQuestion.id].response).toBe(balance);
    expect(store.get().questions[coverageQuestion.id].response).toBe(coverage);

    writes.mockClear();
    expect((await store.dispatch(Undo, { opId: taken.value.opId })).ok).toBe(true);
    expect(findingWrites().sort()).toEqual([reserveFinding.id, insuranceFinding.id].sort());
    for (const finding of [reserveFinding, insuranceFinding]) {
      expect(store.get().findings[finding.id]).toMatchObject({ updated: false, updatedWhy: '' });
      expect(store.get().findings[finding.id].updatedOn).toBeUndefined();
    }
    for (const question of [fundingQuestion, balanceQuestion, coverageQuestion]) {
      expect(store.get().questions[question.id].response).toBe(question.response);
    }
  }, 20_000);

  it.each([false, true])('keeps the new mark when a response is withdrawn (withdrawal first: %s)', async (first) => {
    const { store, repo, dealId, reserveFinding, fundingQuestion, balanceQuestion } = await setup();
    const findingId = reserveFinding.id;
    expect((await store.dispatch(SetResponse, { dealId, questionId: fundingQuestion.id, response: funding })).ok)
      .toBe(true);
    const withdrawal = [fundingQuestion.id, { response: '' }] as const;
    const arrival = [balanceQuestion.id, { response: balance }] as const;
    const set = Object.fromEntries(first ? [withdrawal, arrival] : [arrival, withdrawal]);
    expect((await store.dispatch(TakeFromQaLog, { dealId, set })).ok).toBe(true);

    const saved = await repo.get('finding', findingId);
    expect(saved.ok && saved.value?.conflict).toBeUndefined();
    expect(store.get().findings[findingId].updatedOn?.questions).toEqual([balanceQuestion.id]);
    expect(store.get().questions[fundingQuestion.id].response).toBe('');
    expect(store.get().questions[balanceQuestion.id].response).toBe(balance);

    const revisedFunding = 'The reserve will be funded by a letter of credit.';
    expect((await store.dispatch(SetResponse, {
      dealId, questionId: fundingQuestion.id, response: revisedFunding,
    })).ok).toBe(true);
    expect(store.get().findings[findingId].updatedOn?.questions).toEqual([balanceQuestion.id, fundingQuestion.id]);
  });
});
