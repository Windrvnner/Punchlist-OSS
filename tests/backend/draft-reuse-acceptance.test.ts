// @vitest-environment node
import { expect, it } from 'vitest';
import { setup, doc, val } from './reviewKit';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { Store } from '../../src/app/store';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockDocuments, mockSession, ulidIds } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse, SetQuestionStatus } from '../../src/app/commands/questions';
import { AcceptDraft, ApplyDraft, RequestDraft } from '../../src/app/commands/drafts';
import type { AiService, Repository } from '../../src/ports';

const wording = 'Which lock-up ratio applies from financial close under the credit agreement?';
const savedResponse = [
  'The ratio is set in Schedule [1] of the facility agreement.',
  'See also Annex [1] of the report.',
].join('\n\n');
const documentText = 'The credit agreement prescribes a 1.35x ratio.';
const agreement = doc(1, 'Credit Agreement.pdf', { summary: 'Senior credit agreement.', keywords: ['lock-up'] });
const dealId = 'd_00000000000000000000000001';
const commands = [CreateDeal, CreateQuestion, SetResponse, SetQuestionStatus, RequestDraft, ApplyDraft, AcceptDraft];

function draftStore(repo: Repository, ai: AiService) {
  const latency: [number, number] = [0, 0];
  return new Store({
    repo,
    ai,
    docs: mockDocuments({ latency }),
    session: mockSession({ latency }),
    fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true, value: 'saved' }) },
    sheets: csvCodec,
    local: new MemoryLocal(),
    clock: { now: () => new Date().toISOString() },
    ids: { next: (prefix) => prefix === 'd' ? dealId : ulidIds.next(prefix) },
  }, commands);
}

it('keeps brackets from a reused response when an accepted draft cites the same number (#287)', async () => {
  const backend = setup((call) => {
    if (!call.prompt.includes('Draft a response to this question')) return {};
    const reusedDraft = /^R(\d+): Q2[,:]/m.exec(call.prompt);
    if (reusedDraft) return { status: 'found', text: '', sources: [], reused: [`R${reusedDraft[1]}`] };
    return {
      status: 'found',
      text: `${documentText} [1]`,
      sources: [{ doc: 'D1', page: 14 }],
      reused: ['R1'],
    };
  }, { [dealId]: [agreement] });
  const store = draftStore(backend.repo, backend.ai);
  await store.boot();
  val(await store.dispatch(CreateDeal, { name: 'Renewable portfolio', folders: [] }));
  const create = async (number: number) => {
    val(await store.dispatch(CreateQuestion, { dealId, text: wording }));
    const question = Object.values(store.get().questions).find((row) => row.n === number);
    if (!question) throw new Error(`Question ${number} is missing`);
    return { dealId, questionId: question.id };
  };
  const first = await create(1);
  const second = await create(2);
  const third = await create(3);
  val(await store.dispatch(SetResponse, { ...first, response: savedResponse }));
  val(await store.dispatch(SetQuestionStatus, { ...first, status: 'answered' }));

  const writes = portfolioQuestions().map((text, index) => {
    const id = `portfolio_${index}`;
    return {
      kind: 'question' as const,
      id,
      expectedRev: null,
      data: { id, dealId, n: index + 100, text, status: 'open', response: '' },
    };
  });
  expect(writes.length).toBeGreaterThan(2000);
  const index = { dealId, add: writes.map(({ kind, id }) => ({ kind, id })) };
  val(await backend.repo.transaction({ writes, index }));

  const draft = async (target: { dealId: string; questionId: string }) => {
    const operation = val(await store.dispatch(RequestDraft, target));
    await store.settled(operation.opId);
    return store.get().questions[target.questionId].draft;
  };
  const firstDraft = await draft(second);
  expect(firstDraft?.text).toContain(`${savedResponse}\n\n${documentText} [1]`);
  expect(firstDraft?.sources.map((source) => source.loc)).toEqual(['p. 14']);
  val(await store.dispatch(AcceptDraft, second));
  expect(store.get().questions[second.questionId].provenance?.sources).toEqual(firstDraft?.sources);

  const repeatedDraft = await draft(third);
  expect(repeatedDraft?.text).toContain(`${savedResponse}\n\n${documentText}`);
  expect(repeatedDraft?.text.match(/\[1\]/g)).toHaveLength(2);
  expect(repeatedDraft?.sources).toEqual([]);
  const lastPrompt = backend.calls.filter((call) => call.prompt.includes('Draft a response to this question')).at(-1);
  const reuseLine = lastPrompt?.prompt.split('\n').find((line) => line.startsWith('Response to Q2'));
  expect(reuseLine).toContain(`${savedResponse.replace(/\n\n/g, ' ')} ${documentText}”`);
});
