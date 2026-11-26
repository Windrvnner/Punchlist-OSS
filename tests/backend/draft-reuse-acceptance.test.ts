// @vitest-environment node
import { expect, it } from 'vitest';
import { setup, doc, val } from './reviewKit';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { Store } from '../../src/app/store';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockDocuments, mockSession, ulidIds } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, DeleteQuestion, RestoreQuestion, SetResponse, SetQuestionStatus }
  from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
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
const commands = [
  CreateDeal, CreateQuestion, SetResponse, SetQuestionStatus, RequestDraft, ApplyDraft, AcceptDraft,
  ImportQuestions, DeleteQuestion, RestoreQuestion,
];

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

async function mixedDraft(earlierResponse = savedResponse) {
  const backend = setup((call) => {
    if (!call.prompt.includes('Draft a response to this question')) return {};
    // the earlier response that was drafted by AI (question 2's accepted draft); the model sees only R numbers (#286)
    const reusedDraft = /^Response to R(\d+) \(drafted by AI/m.exec(call.prompt);
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
  val(await store.dispatch(SetResponse, { ...first, response: earlierResponse }));
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
  expect(firstDraft?.text).toContain(`${earlierResponse}\n\n${documentText} [1]`);
  expect(firstDraft?.sources.map((source) => source.loc)).toEqual(['p. 14']);
  const accept = async () => {
    const action = val(await store.dispatch(AcceptDraft, second));
    expect(store.get().questions[second.questionId].provenance?.sources).toEqual(firstDraft?.sources);
    return action.opId;
  };
  return { backend, store, first, second, third, draft, accept };
}

async function checkReuse(world: Awaited<ReturnType<typeof mixedDraft>>, expected = savedResponse) {
  const { backend, third, draft } = world;
  const repeatedDraft = await draft(third);
  expect(repeatedDraft?.text).toContain(`${expected}\n\n${documentText}`);
  expect(repeatedDraft?.text.match(/\[1\]/g)).toHaveLength(2);
  expect(repeatedDraft?.sources).toEqual([]);
  const lastPrompt = backend.calls.filter((call) => call.prompt.includes('Draft a response to this question')).at(-1);
  const reuseLine = lastPrompt?.prompt.split('\n').find((line) => line.startsWith('Response to R') && line.includes('drafted by AI'));
  expect(reuseLine).toContain(`${expected.replace(/\s+/g, ' ')} ${documentText}”`);
}

it('keeps brackets from a reused response when an accepted draft cites the same number (#287)', async () => {
  const world = await mixedDraft();
  await world.accept();
  await checkReuse(world);
});

it.each(['response edit', 'merge import'])('keeps quoted brackets after a whitespace-only %s (#287)', async (path) => {
  const world = await mixedDraft();
  const { store, second, accept } = world;
  await accept();
  const previous = store.get().questions[second.questionId];
  const extraLines = `Annex${'\n'.repeat(40)}[1]`;
  const response = previous.response.replace('Annex [1]', extraLines).replace('ratio. [1]', 'ratio.\t[1]');
  if (path === 'response edit') {
    val(await store.dispatch(SetResponse, { ...second, response }));
  } else {
    const row = {
      n: 2, text: wording, askedBy: '', received: '', workstream: '', priority: '' as const,
      response, respondedBy: '', responded: '', status: '' as const,
    };
    val(await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: [row] }));
  }
  const saved = store.get().questions[second.questionId];
  expect(saved.response).toBe(response);
  // typed in the app, the same words keep their origin; a file's response is the file's own
  if (path !== 'response edit') {
    expect(saved.provenance).toMatchObject({ origin: 'human' });
    return;
  }
  expect(saved.provenance).toEqual(previous.provenance);
  await checkReuse(world, savedResponse.replace('Annex [1]', extraLines));
});

it('protects mixed drafts and their saved and deleted versions from writes by schema 1 (#287)', async () => {
  const world = await mixedDraft();
  const { backend, store, first, second, accept } = world;
  const recordSchema = async (kind: 'question' | 'tombstone', id: string) =>
    val(await backend.repo.get(kind, id))?.envelope.schema;
  expect(await recordSchema('question', first.questionId)).toBe(1);
  expect(await recordSchema('question', second.questionId)).toBe(2);
  const acceptOp = await accept();
  expect(await recordSchema('question', second.questionId)).toBe(2);
  expect(val(await backend.repo.get('op', acceptOp))?.envelope.schema).toBe(2);
  val(await store.dispatch(SetQuestionStatus, { ...second, status: 'closed' }));
  expect(await recordSchema('question', second.questionId)).toBe(2);
  val(await store.dispatch(DeleteQuestion, second));
  expect(await recordSchema('tombstone', second.questionId)).toBe(2);
  val(await store.dispatch(RestoreQuestion, second));
  expect(await recordSchema('question', second.questionId)).toBe(2);
  await checkReuse(world);
});

it('keeps schema 1 when none of the quoted brackets shares a citation number', async () => {
  const { backend, second, accept } = await mixedDraft(savedResponse.replaceAll('[1]', '[14]'));
  expect(val(await backend.repo.get('question', second.questionId))?.envelope.schema).toBe(1);
  await accept();
  expect(val(await backend.repo.get('question', second.questionId))?.envelope.schema).toBe(1);
});
