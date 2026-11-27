// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { ApplyDraft, RequestDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { RecordQaLogExport, RestoreQaVersion } from '../../src/app/commands/qaLogs';
import { SetResponse } from '../../src/app/commands/questions';
import { registry } from '../../src/app/commands/undo';
import {
  canRequestDraft, eligibleForDraft, editResponseMerge, hasLogVersion, keepResolvedMerges, keepResponseVersion, lastQuestionEditor, requestQuestionDraft,
  responseMergeView, selectResponseMerge, setResponseMergeSide, useQuestionDraft, watchResponseMerges,
} from '../../src/app/drafting';
import { initializeKeptText, saveKeptDrafts } from '../../src/app/keptText';
import { keepImportedLog } from '../../src/app/qaLog';
import { wordingHash } from '../../src/domain/model';
import { dealQuestions } from '../../src/app/state';
import type { Store } from '../../src/app/store';
import type { Question } from '../../src/domain/model';
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
const { handFieldText, typedResponse, unsavedFields } = await import('../../src/app/fieldDrafts');
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

/** `others`: more questions in two versions, by index, beside question 165 */
async function mergeFixture(others: number[] = []) {
  const app = await fixture();
  const { store, repo, dealId, rows, question } = app;
  const q = question(165);
  const more = others.map((index) => [question(index).id, { response: `${LOG_RESPONSE} (${index})` }]);
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
      kept: { ...Object.fromEntries(more), [q.id]: { response: LOG_RESPONSE, priority: 'High' } },
    },
  }, { quiet: true })).toMatchObject({ ok: true });
  expect(hasLogVersion(store.get(), question(165))).toBe(true);
  const model = vi.fn<NonNullable<AiService['merge']>>().mockResolvedValue(ok({ text: MERGED }));
  store.services.ai.merge = model;
  return { store, repo, dealId, model, question, q: question(165) };
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
  const fields = setResponseMergeSide(q.id, {}, 'priority', 'log');
  saveKeptDrafts();
  expect(storage.read(KEPT_TEXT_KEY)).toMatchObject({
    'qa-merge': [[q.id, { text: TYPED, ai: MERGED }]],
    'qa-merge-sides': [[q.id, { priority: 'log' }]],
  });
  delete store.services.ai.merge;
  expect(selectResponseMerge(store, q, LOG_RESPONSE)).toEqual({ text: TYPED, busy: false });
  expect(selectResponseMerge(store, q, LOG_RESPONSE, true)).toBeUndefined();
  const stale = await keepResponseVersion(store, dealId, q.id, 'merged', {
    merged: TYPED, fields, seen: '2026-11-20T10:00:00.000Z',
  });
  expect(stale).toMatchObject({ ok: false, error: { kind: 'rejected' } });
  expect(responseMergeView(q.id)).toMatchObject({ draft: { text: TYPED }, fields: { priority: 'log' } });
  const used = await keepResponseVersion(store, dealId, q.id, 'merged', { merged: TYPED, fields, seen: LOG_DATE });
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

const CONFLICTS = Array.from({ length: 111 }, (_, index) => index * 2);   // with question 165, 112 in two versions
const RESOLVED_AT = '2026-11-21T09:30:00.000Z';

/** Another PC resolves a question by taking the log's version. */
async function resolveElsewhere(repo: RecoveryApp['repo'], question: Question, response: string) {
  const coworker = { ...ELSEWHERE, at: RESOLVED_AT };
  const pick = { of: LOG_DATE, sent: { response, ...(response === LOG_RESPONSE ? { priority: 'High' } : {}) } };
  const priority = response === LOG_RESPONSE ? 'High' : question.priority;
  repo.peer.change('question', question.id, {
    ...question, response, priority, logPick: pick, updatedAt: coworker.at,
  }, coworker);
  await repo.sync();
}

it('keeps a hand-edited merge in the response box when another PC resolves its question (#939)', async () => {
  const { store, repo, q, question } = await mergeFixture(CONFLICTS);
  const stop = keepResolvedMerges(store, handFieldText);
  try {
    selectResponseMerge(store, q, LOG_RESPONSE);
    await vi.waitFor(() => expect(responseMergeView(q.id).draft?.text).toBe(MERGED));
    editResponseMerge(q.id, TYPED);
    for (const index of CONFLICTS.slice(0, 40)) editResponseMerge(question(index).id, `Typed for ${index}`);
    await resolveElsewhere(repo, q, LOG_RESPONSE);
    await vi.waitFor(() => expect(store.get().questions[q.id].response).toBe(LOG_RESPONSE));

    const resolved = store.get().questions[q.id];
    expect(hasLogVersion(store.get(), resolved)).toBe(false);
    expect(unsavedFields.get(`${q.id}:response`)).toEqual({ text: TYPED, base: LOG_RESPONSE, rev: -1 });
    expect(typedResponse(resolved)).toBe(true);
    expect(responseMergeView(q.id)).toMatchObject({ hasDraft: false, fields: {} });
    // the other 111 questions are still in two versions, so their merges stay where they are
    expect(CONFLICTS.filter((index) => responseMergeView(question(index).id).hasDraft)).toHaveLength(40);
    expect(CONFLICTS.some((index) => unsavedFields.has(`${question(index).id}:response`))).toBe(false);
    saveKeptDrafts();
    const saved = storage.read(KEPT_TEXT_KEY) as Record<string, [string, unknown][]>;
    expect(saved['edit-field']).toEqual([[`${q.id}:response`, { text: TYPED, base: LOG_RESPONSE, rev: -1 }]]);
    expect(saved['qa-merge'].some(([id]) => id === q.id)).toBe(false);
  } finally {
    stop();
  }
});

it('keeps unsaved response text first and adds the merge after it when resolved elsewhere', async () => {
  const { store, repo, q } = await mergeFixture();
  const stop = keepResolvedMerges(store, handFieldText);
  try {
    const unsaved = { text: 'Seller counsel confirmed the permit list.', base: APP_RESPONSE, rev: q.rev };
    unsavedFields.set(`${q.id}:response`, unsaved);
    editResponseMerge(q.id, TYPED);
    await resolveElsewhere(repo, q, APP_RESPONSE);
    await vi.waitFor(() => expect(hasLogVersion(store.get(), store.get().questions[q.id])).toBe(false));
    expect(unsavedFields.get(`${q.id}:response`))
      .toEqual({ text: `${unsaved.text}\n\n${TYPED}`, base: APP_RESPONSE, rev: -1 });
    expect(responseMergeView(q.id).hasDraft).toBe(false);
  } finally {
    stop();
  }
});

it('clears an untouched AI merge and a merge matching the response when resolved elsewhere', async () => {
  const { store, repo, q, question } = await mergeFixture([12]);
  const other = question(12);
  const stop = keepResolvedMerges(store, handFieldText);
  try {
    selectResponseMerge(store, q, LOG_RESPONSE);
    await vi.waitFor(() => expect(responseMergeView(q.id).draft?.text).toBe(MERGED));
    editResponseMerge(other.id, LOG_RESPONSE);
    await resolveElsewhere(repo, q, LOG_RESPONSE);
    await resolveElsewhere(repo, other, LOG_RESPONSE);
    await vi.waitFor(() => expect(responseMergeView(other.id).hasDraft).toBe(false));
    expect(responseMergeView(q.id).hasDraft).toBe(false);
    expect(unsavedFields.size).toBe(0);
  } finally {
    stop();
  }
});

it('drops a typed merge when this PC keeps another version, and keeps it when that choice is refused', async () => {
  const { store, repo, dealId, q, question } = await mergeFixture([12]);
  const stop = keepResolvedMerges(store, handFieldText);
  try {
    editResponseMerge(q.id, TYPED);
    const kept = await keepResponseVersion(store, dealId, q.id, 'app', { merged: TYPED, fields: {}, seen: LOG_DATE });
    expect(kept).toMatchObject({ ok: true });
    expect(responseMergeView(q.id).hasDraft).toBe(false);
    expect(unsavedFields.size).toBe(0);

    const other = question(12);
    editResponseMerge(other.id, TYPED);
    await resolveElsewhere(repo, other, `${LOG_RESPONSE} (12)`);
    await vi.waitFor(() => expect(unsavedFields.has(`${other.id}:response`)).toBe(true));
    const refused = await keepResponseVersion(store, dealId, other.id, 'merged', {
      merged: TYPED, fields: {}, seen: LOG_DATE,
    });
    expect(refused.ok).toBe(false);
    expect(unsavedFields.get(`${other.id}:response`)?.text).toBe(TYPED);
  } finally {
    stop();
  }
});

it('leaves a kept merge alone until its question and deal are loaded', () => {
  const store = { get: () => ({ questions: {}, deals: {} }), subscribe: () => () => {} } as unknown as Store;
  editResponseMerge('q_not_loaded', TYPED);
  const stop = keepResolvedMerges(store, handFieldText);
  stop();
  expect(responseMergeView('q_not_loaded').draft).toEqual({ text: TYPED, ai: '' });
});

it('shares single-request rules while Draft all limits replacements on a portfolio', async () => {
  const { store, dealId, question } = await fixture(QUESTIONS.length);
  const q = question(2020);
  const draft = { status: 'found' as const, forWording: wordingHash(q.text), text: DRAFT, sources: [],
    at: q.updatedAt, opId: 'op_example' };
  for (const [record, single, batch] of [
    [q, true, true], [{ ...q, draft }, true, false], [{ ...q, draft: { ...draft, status: 'failed' } }, true, true],
    [{ ...q, text: q.text + '?', draft }, true, true], [{ ...q, response: TYPED }, true, false],
    [{ ...q, text: ' ' }, false, false], [{ ...q, status: 'closed' }, false, false],
  ] as const) {
    expect(canRequestDraft(record)).toBe(single);
    expect(eligibleForDraft(record)).toBe(batch);
  }
  const target = { dealId, questionId: q.id };
  for (const [record, empty, message] of [
    [{ status: 'closed', text: '', response: TYPED }, true, 'This question already has a response'],
    [{ status: 'closed', text: '', response: TYPED }, false, 'Only an open question can be drafted'],
    [{ status: 'open', text: '   ' }, false, 'Write the question first'],
  ] as const) {
    Object.assign(store.get().questions[q.id], record);
    expect(await store.dispatch(RequestDraft, { ...target, empty }, { quiet: true }))
      .toMatchObject({ ok: false, error: { message } });
  }
});
