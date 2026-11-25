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
  expect(await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: imported }, { quiet: true })).toMatchObject({
    ok: true,
  });
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

it('refuses replacement after a colleague changes the response and leaves the typed text and draft intact', async () => {
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

