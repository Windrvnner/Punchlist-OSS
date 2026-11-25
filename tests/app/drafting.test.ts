// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { ApplyDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { RecordQaLogExport, RestoreQaVersion } from '../../src/app/commands/qaLogs';
import { SetResponse } from '../../src/app/commands/questions';
import { registry } from '../../src/app/commands/undo';
import {
  editResponseMerge, hasLogVersion, keepResponseVersion, lastQuestionEditor, requestQuestionDraft,
  responseMergeView, selectResponseMerge, setResponseMergeSide, useQuestionDraft, watchResponseMerges,
} from '../../src/app/drafting';
import { initializeKeptText, saveKeptDrafts } from '../../src/app/keptText';
import { keepImportedLog } from '../../src/app/qaLog';
import { dealQuestions } from '../../src/app/state';
import { nodeAi } from '../../src/backend/ai';
import { StandInService } from '../../src/backend/service';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { fail, ok, type Result } from '../../src/domain/result';
import { KEPT_TEXT_KEY, type AiService } from '../../src/ports';
import { disk, ELSEWHERE, refuse, toAQuestion } from '../adapters/memRepo';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp, recoveryDeal, type RecoveryApp } from './recoveryKit';

const storage = new MemoryLocal();
initializeKeptText(storage);
const { unsavedFields } = await import('../../src/app/fieldDrafts');
const apps: RecoveryApp[] = [];
const QUESTIONS = portfolioQuestions();
const COLUMNS = ['Number', 'Question', 'Response', 'Submitted by'];
const MAPPING = suggestMapping(COLUMNS);
const DRAFT = 'The project company maintains the authorizations listed in Schedule 6.';
const TYPED = 'The project team will confirm the outstanding authorization numbers.';

registry.set(RestoreQuestionSnapshot.name, RestoreQuestionSnapshot);
registry.set(RestoreQaVersion.name, RestoreQaVersion);

async function fixture(size = 312) {
  const app = recoveryApp(disk(), [ApplyDraft]);
  apps.push(app);
  const { store } = app;
  const dealId = await recoveryDeal(app);
  const draft = vi.fn<AiService['draft']>().mockResolvedValue(ok({ status: 'found', text: DRAFT, sources: [] }));
  store.services.ai.draft = draft;
  const rows = QUESTIONS.slice(0, size).map((text, index) => [String(index + 1), text, '', 'Lender A']);
  const { rows: imported } = prepareImport(rows, MAPPING);
  const result = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: imported }, { quiet: true });
  expect(result).toMatchObject({ ok: true });
  const questions = dealQuestions(store.get(), dealId);
  expect(questions).toHaveLength(size);
  const question = (index = 0) => store.get().questions[questions[index].id];
  return { ...app, dealId, draft, rows, question };
}

afterEach(async () => {
  unsavedFields.clear();
  saveKeptDrafts();
  for (const { store, repo } of apps.splice(0)) {
    store.closing();
    await repo.close();
  }
});

it('requests a draft on a full portfolio, saves confirmed typing, and restores that typing on Undo', async () => {
  const { store, dealId, draft, question } = await fixture(QUESTIONS.length);
  const q = question(1034);
  const requested = await requestQuestionDraft(store, q);
  if (!requested?.ok) throw new Error('Expected a draft request');
  await store.settled(requested.value.opId);
  expect(draft).toHaveBeenCalledExactlyOnceWith({ dealId, questionId: q.id, questionText: q.text });
  expect(question(1034).draft).toMatchObject({ status: 'found', text: DRAFT });
  const accepted = await useQuestionDraft(store, q, { typed: TYPED, over: '', elsewhere: false });
  if (accepted.kind !== 'accepted') throw new Error('Expected the draft to become the response');
  expect(question(1034)).toMatchObject({ response: DRAFT, status: 'answered', provenance: { origin: 'ai' } });
  expect(await store.undo(accepted.opId)).toMatchObject({ ok: true });
  expect(question(1034)).toMatchObject({ response: TYPED, status: 'open', draft: { status: 'found' } });
});

it('retries a kept reply after its write attempts fail without asking the model again', async () => {
  const { store, repo, draft, question } = await fixture();
  const q = question(212);
  Object.assign(store.replyWait, { first: 10, max: 30 });
  const back = refuse(repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'),
    () => Object.assign(new Error('Write unavailable'), { code: 'EIO' }));
  const requested = await requestQuestionDraft(store, q);
  if (!requested?.ok) throw new Error('Expected a draft request');
  const { opId } = requested.value;
  await store.settled(opId);
  await vi.waitFor(() => expect(store.hasKeptReply(opId)).toBe(true));
  expect(question(212).draft?.status).toBe('failed');
  back();
  expect(requestQuestionDraft(store, question(212))).toBeUndefined();
  await vi.waitFor(() => expect(question(212).draft).toMatchObject({ status: 'found', text: DRAFT, opId }));
  expect(draft).toHaveBeenCalledTimes(1);
  await expect(useQuestionDraft(store, q)).resolves.toMatchObject({ kind: 'accepted' });
});

it('preserves typed text and the draft when a colleague’s response prevents replacement', async () => {
  const { store, repo, question } = await fixture();
  const q = question(81);
  const requested = await requestQuestionDraft(store, q);
  if (!requested?.ok) throw new Error('Expected a draft request');
  await store.settled(requested.value.opId);
  const entry = { text: TYPED, base: '', rev: question(81).rev };
  unsavedFields.set(`${q.id}:response`, entry);
  const theirs = 'The remaining authorizations arrived with the supplemental disclosure.';
  const coworker = { ...ELSEWHERE, at: '2026-11-19T10:05:00.000Z' };
  repo.peer.change('question', q.id, { ...question(81), response: theirs, updatedAt: coworker.at }, coworker);
  await repo.sync();
  await vi.waitFor(() => expect(question(81).response).toBe(theirs));
  const accepted = await useQuestionDraft(store, q, { typed: TYPED, over: '', elsewhere: false });
  expect(accepted).toEqual({ kind: 'responseChanged' });
  expect(question(81)).toMatchObject({ response: theirs, draft: { status: 'found', text: DRAFT } });
  expect(unsavedFields.get(`${q.id}:response`)).toEqual(entry);
});

const LOG_NAME = 'Portfolio Q&A.csv';
const LOG_DATE = '2026-11-20T11:00:00.000Z';
const APP_RESPONSE = 'The operating permits are indexed in the Compliance folder.';
const LOG_RESPONSE = 'The transmission permit was renewed in November.';
const MERGED = `${APP_RESPONSE} ${LOG_RESPONSE}`;

async function mergeFixture() {
  const app = await fixture();
  const { store, repo, dealId, rows, question } = app;
  const q = question(165);
  expect(await store.dispatch(SetResponse, {
    dealId, questionId: q.id, response: APP_RESPONSE,
  }, { quiet: true })).toMatchObject({ ok: true });
  expect(await keepImportedLog(store, dealId, {
    path: `X:\\Deals\\Portfolio\\${LOG_NAME}`, sheet: 'Log', headerRow: 1, mapping: MAPPING, make: true, rows,
  })).toMatchObject({ ok: true });
  expect(await store.dispatch(RecordQaLogExport, {
    dealId, name: LOG_NAME.replace(/\.csv$/, ''),
    last: {
      archive: 'Previous lender Q&A.csv', at: LOG_DATE, by: 'Deal team', sent: {},
      kept: { [q.id]: { response: LOG_RESPONSE, priority: 'High' } },
    },
  }, { quiet: true })).toMatchObject({ ok: true });
  expect(hasLogVersion(store.get(), question(165))).toBe(true);
  const model = vi.fn<NonNullable<AiService['merge']>>().mockResolvedValue(ok({ text: MERGED }));
  store.services.ai.merge = model;
  return { store, repo, dealId, model, q: question(165) };
}

it('drafts the displayed versions once, keeps edits and field choices, and preserves the choice’s Undo', async () => {
  const { store, dealId, model, q } = await mergeFixture();
  expect(await lastQuestionEditor(store, q.id)).toBe(store.get().user?.name);
  expect(selectResponseMerge(store, q, LOG_RESPONSE)).toMatchObject({ busy: true });
  expect(selectResponseMerge(store, q, LOG_RESPONSE)).toMatchObject({ busy: true });
  await vi.waitFor(() => expect(responseMergeView(q.id).draft).toEqual({ text: MERGED, ai: MERGED }));
  expect(model).toHaveBeenCalledExactlyOnceWith({
    dealId, question: q.text, app: APP_RESPONSE, log: LOG_RESPONSE,
  });
  editResponseMerge(q.id, TYPED);
  setResponseMergeSide(q.id, 'priority', 'log');
  saveKeptDrafts();
  expect(storage.read(KEPT_TEXT_KEY)).toMatchObject({
    'qa-merge': [[q.id, { text: TYPED, ai: MERGED }]],
    'qa-merge-sides': [[q.id, { priority: 'log' }]],
  });
  delete store.services.ai.merge;
  expect(selectResponseMerge(store, q, LOG_RESPONSE)).toEqual({ text: TYPED, busy: false });
  expect(selectResponseMerge(store, q, LOG_RESPONSE, true)).toBeUndefined();
  const stale = await keepResponseVersion(store, dealId, q.id, 'merged', TYPED, '2026-11-20T10:00:00.000Z');
  expect(stale).toMatchObject({ ok: false, error: { kind: 'rejected' } });
  expect(responseMergeView(q.id)).toMatchObject({ draft: { text: TYPED }, fields: { priority: 'log' } });
  const used = await keepResponseVersion(store, dealId, q.id, 'merged', TYPED, LOG_DATE);
  if (!used.ok) throw new Error(used.error.message);
  expect(store.get().questions[q.id])
    .toMatchObject({ response: TYPED, priority: 'High', provenance: { origin: 'human' } });
  expect(responseMergeView(q.id)).toMatchObject({ hasDraft: false, fields: {} });
  expect(await store.undo(used.value.opId)).toMatchObject({ ok: true });
  expect(store.get().questions[q.id]).toMatchObject({ response: APP_RESPONSE, priority: q.priority });
  expect(hasLogVersion(store.get(), store.get().questions[q.id])).toBe(true);
});

it('reports a failed merge quietly and leaves later typing intact when the retry lands', async () => {
  const { store, model, q } = await mergeFixture();
  const landed = vi.fn();
  const stop = watchResponseMerges(landed);
  const previousToasts = store.get().ui.toasts;
  model.mockResolvedValueOnce(fail({ kind: 'failed', message: 'The draft could not be completed' }));
  try {
    selectResponseMerge(store, q, LOG_RESPONSE);
    await vi.waitFor(() => expect(landed).toHaveBeenCalledWith(q.id, 'The draft could not be completed'));
    expect(responseMergeView(q.id)).toMatchObject({ busy: false, hasDraft: false });
    expect(store.get().ui.toasts).toEqual(previousToasts);

    expect(selectResponseMerge(store, q, LOG_RESPONSE, true)).toMatchObject({ busy: true });
    await vi.waitFor(() => expect(responseMergeView(q.id).draft?.text).toBe(MERGED));
    expect(store.get().ui.toasts).toEqual(previousToasts);

    let resolveReply!: (result: Result<{ text: string }>) => void;
    const reply = new Promise<Result<{ text: string }>>((resolve) => { resolveReply = resolve; });
    model.mockReturnValueOnce(reply);
    expect(selectResponseMerge(store, q, LOG_RESPONSE, true)).toMatchObject({ busy: true });
    editResponseMerge(q.id, TYPED);
    resolveReply(ok({ text: MERGED }));
    await vi.waitFor(() => expect(landed).toHaveBeenCalledTimes(3));
    expect(landed).toHaveBeenLastCalledWith(q.id, undefined);
    expect(responseMergeView(q.id)).toMatchObject({ busy: false, draft: { text: TYPED, ai: MERGED } });
    expect(model).toHaveBeenCalledTimes(3);
  } finally {
    stop();
  }
});

it('quietly retries a transient transport failure from one merge selection', async () => {
  const { store, repo, q } = await mergeFixture();
  const reply = vi.fn(() => JSON.stringify({ text: MERGED })).mockImplementationOnce(() => {
    throw Object.assign(new Error('Model service temporarily unavailable'), { status: 503 });
  });
  const service = new StandInService(reply);
  let continueRetry!: () => void;
  const waiting = new Promise<void>((resolve) => { continueRetry = resolve; });
  const sleep = vi.fn(() => waiting);
  const backend = nodeAi({
    service, repo, docs: { records: () => [], wanted: async () => [] },
    keeper: new StoreKeeper(service, repo.local), retry: { sleep },
  });
  store.services.ai.merge = backend.merge;
  const landed = vi.fn();
  const stop = watchResponseMerges(landed);
  const previousToasts = store.get().ui.toasts;
  try {
    expect(selectResponseMerge(store, q, LOG_RESPONSE)).toMatchObject({ busy: true });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
    expect(service.calls).toHaveLength(1);
    expect(responseMergeView(q.id)).toMatchObject({ busy: true, hasDraft: false });
    expect(landed).not.toHaveBeenCalled();
    expect(store.get().ui.toasts).toEqual(previousToasts);

    continueRetry();
    await vi.waitFor(() => expect(landed).toHaveBeenCalledExactlyOnceWith(q.id, undefined));
    expect(service.calls).toHaveLength(2);
    expect(service.calls[1]).toEqual(service.calls[0]);
    expect(responseMergeView(q.id)).toMatchObject({ busy: false, draft: { text: MERGED, ai: MERGED } });
    expect(store.get().ui.toasts).toEqual(previousToasts);
  } finally {
    continueRetry();
    stop();
  }
});
