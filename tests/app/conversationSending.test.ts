// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, DeleteFinding } from '../../src/app/commands/findings';
import { CreateQuestion, DeleteQuestion, SetResponse, UseAsResponse } from '../../src/app/commands/questions';
import { RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import {
  answerQuestionChoices, answerText, answerWasUsed, composerScope, composerText, convKey, findingFromAnswer,
  pastConversationList, questionFromAnswer, responseToReplace, scopeHash, scopeValid,
  sendTyped, setComposerText, useAnswer, type Scope,
} from '../../src/app/conversations';
import { initializeKeptText, saveKeptDrafts } from '../../src/app/keptText';
import { initialState, type Attachment, type Message } from '../../src/app/state';
import { Store } from '../../src/app/store';
import { Deal, Question } from '../../src/domain/model';
import { fail, ok } from '../../src/domain/result';
import { KEPT_TEXT_KEY, type DocumentService } from '../../src/ports';
import { disk, memRepo } from '../adapters/memRepo';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const local = new MemoryLocal();
initializeKeptText(local);
registry.set(RestoreQuestionSnapshot.name, RestoreQuestionSnapshot);
const { answerCardDraft, saveAnswerFinding } = await import('../../src/app/answerDrafts');
afterEach(saveKeptDrafts);

const at = new Date(2026, 10, 25, 0, 10).toISOString();
const clock = { now: () => at };
const id = (kind: string, n: number) => `${kind}_${String(n).padStart(26, '0')}`;
let seq = 0;
const ids = { next: (kind: string) => id(kind, ++seq) };
const instructions = portfolioQuestions();
const sources = [{ doc: 'Executed power purchase agreement.pdf', docId: 'doc_ppa', loc: 'p. 18' }];
const answer: Message = {
  at, id: 'reply', role: 'ai', state: 'done', sources,
  text: `The agreement covers the contracted capacity. [1]\n\nReview {the offtake finding|${id('f', 1)}}.`,
};

async function start(docs: Partial<DocumentService> = {}) {
  const opts = { latency: [0, 0] as [number, number] };
  const repo = memRepo(clock.now, disk());
  const asked = vi.fn(async () => ok({ text: answer.text, sources }));
  const store = new Store({
    repo, ai: { ...mockAi(opts, repo), answer: asked }, docs: { ...mockDocuments(opts), ...docs },
    fs: { pickFolders: null, pathFor: null, save: async () => ok('saved' as const) },
    sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids,
  }, [
    CreateDeal, CreateFinding, DeleteFinding, CreateQuestion, DeleteQuestion, SetResponse,
    UseAsResponse, RestoreQuestionSnapshot,
  ]);
  await store.boot();
  expect((await store.dispatch(CreateDeal, { name: 'Southridge', folders: [] })).ok).toBe(true);
  const dealId = Object.keys(store.get().deals)[0];
  await store.loadDeal(dealId, { gaps: false });
  const scope: Scope = { kind: 'deal', dealId };
  const navigate = vi.fn();
  return { store, scope, dealId, navigate, asked };
}

it('runs navigation, unresolved, and logging before falling through to a model answer', async () => {
  const { store, scope, dealId, navigate, asked } = await start();
  const launch = composerScope(scope, true);
  const key = convKey(launch.scope);
  const send = (text: string) => {
    setComposerText(key, text);
    return sendTyped(store, launch.scope, { launchSlot: launch.launchSlot, navigate });
  };
  await send('Open Southridge’s Q&A');
  expect(navigate).toHaveBeenCalledWith(`qa-${dealId}`);
  await send('Create a new deal');
  expect(store.get().ui.newDeal).toMatchObject({ name: '', folders: [] });
  await send('Please add all the unresolved gaps and open findings to Q&A.');
  expect(store.get().ui.dialog).toEqual({ kind: 'addUnresolved', dealId });
  await send(`Log a question: ${instructions[4]}`);
  expect(Object.values(store.get().questions).map((q) => q.text)).toEqual([instructions[4]]);
  expect(asked).not.toHaveBeenCalled();
  expect(composerText(key)).toBe('');

  await send(instructions[18]);
  expect(navigate.mock.calls).toEqual([[`qa-${dealId}`], [scopeHash(launch.scope)]]);
  expect(store.get().threads[key][0].text).toBe(instructions[18]);
  expect(asked).toHaveBeenCalledTimes(1);
  expect(convKey(composerScope(scope, true).scope)).not.toBe(key);
});

it('waits for pending attachments, checks new files, and sends the latest text only once', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const checked = vi.fn(async (_dealId: string, files: string[]) => {
    if (files.includes('doc_ppa')) await hold;
    return ok([]);
  });
  const { store, scope, dealId, navigate, asked } = await start({ unsendable: checked });
  const key = convKey(scope);
  const first: Attachment = {
    id: 'ppa', name: sources[0].doc, dealId, conv: key, state: 'pending',
  };
  const ready = { ...first, ...sources[0], state: 'done' as const };
  setComposerText(key, instructions[22]);
  store.ui({ attachments: [first] });
  await sendTyped(store, scope, { navigate });
  expect(store.get().ui.toasts.at(-1)?.text).toBe('Still attaching — send when it finishes');
  expect(composerText(key)).toBe(instructions[22]);
  expect(asked).not.toHaveBeenCalled();

  store.ui({ attachments: [ready] });
  const sending = sendTyped(store, scope, { navigate });
  await vi.waitFor(() => expect(checked).toHaveBeenCalledTimes(1));
  await sendTyped(store, scope, { navigate });
  const other = { ...ready, id: 'yield', doc: 'Energy yield report.pdf', docId: 'doc_yield' };
  store.ui({ attachments: [ready, other] });
  setComposerText(key, instructions[23]);
  release();
  await sending;
  expect(checked.mock.calls.map(([, files]) => files)).toEqual([['doc_ppa'], ['doc_yield']]);
  const [sent] = store.get().threads[key];
  expect(sent).toMatchObject({ text: instructions[23], attached: [
    { doc: ready.doc, docId: ready.docId }, { doc: other.doc, docId: other.docId },
  ] });
  expect(composerText(key)).toBe('');
  expect(store.get().ui.attachments).toEqual([]);
  expect(asked).toHaveBeenCalledTimes(1);
});

it('keeps the exact typed question while its save is pending or refused', async () => {
  const { store, scope, dealId, navigate, asked } = await start();
  const key = convKey(scope);
  const submitted = `  Add a question: ${instructions[30]}  `;
  const original = store.dispatch.bind(store);
  const refuse = vi.spyOn(store, 'dispatch').mockResolvedValueOnce({
    ok: false, error: { kind: 'storageFull', message: 'The disk is full' },
  });
  setComposerText(key, submitted);
  const refused = vi.fn();
  await sendTyped(store, scope, { navigate, refused });
  expect(refused).toHaveBeenCalledOnce();
  expect(composerText(key)).toBe(submitted);
  refuse.mockRestore();

  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const dispatch = vi.spyOn(store, 'dispatch').mockImplementation(async (command, input, options) => {
    await hold;
    return original(command, input, options);
  });
  const sending = sendTyped(store, scope, { navigate });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
  expect(composerText(key)).toBe('');
  await sendTyped(store, scope, { navigate });
  saveKeptDrafts();
  expect(local.read(KEPT_TEXT_KEY)).toMatchObject({ composer: expect.arrayContaining([[key, submitted]]) });
  setComposerText(key, instructions[34]);
  release();
  await sending;
  expect(composerText(key)).toBe(instructions[34]);
  expect(Object.values(store.get().questions)).toMatchObject([{ dealId, text: instructions[30] }]);
  expect(asked).not.toHaveBeenCalled();
});

it.each([
  { outcome: 'refused', newer: 'erased' },
  { outcome: 'refused', newer: 'kept' },
  { outcome: 'saved', newer: 'erased' },
])('settles a $outcome question save after newer input is $newer', async ({ outcome, newer }) => {
  const { store, scope, navigate } = await start();
  const key = convKey(scope);
  const submitted = '  Log a question: Did the lender consent to the revised assignment provisions?  ';
  const next = 'Do the assignment provisions affect the timetable for financial close?';
  const original = store.dispatch.bind(store);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const dispatch = vi.spyOn(store, 'dispatch').mockImplementation(async (command, input, options) => {
    await hold;
    return outcome === 'saved' ? original(command, input, options)
      : fail({ kind: 'storageFull', message: 'The disk is full' });
  });
  const refused = vi.fn();
  setComposerText(key, submitted);
  const sending = sendTyped(store, scope, { navigate, refused });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect(composerText(key)).toBe('');
  setComposerText(key, next);
  if (newer === 'erased') setComposerText(key, '');
  expect(composerText(key)).toBe(newer === 'kept' ? next : '');
  saveKeptDrafts();
  const pending = local.read(KEPT_TEXT_KEY);
  release();
  await sending;

  const restores = outcome === 'refused' && newer === 'erased';
  expect(composerText(key)).toBe(restores ? submitted : newer === 'kept' ? next : '');
  expect(refused).toHaveBeenCalledTimes(restores ? 1 : 0);
  expect(Object.values(store.get().questions)).toHaveLength(outcome === 'saved' ? 1 : 0);
  expect(pending).toMatchObject({ composer: expect.arrayContaining([[key, newer === 'kept' ? next : submitted]]) });
  saveKeptDrafts();
  const settled = local.read(KEPT_TEXT_KEY) as { composer?: [string, string][] } | null;
  expect(new Map(settled?.composer).get(key)).toBe(restores ? submitted : newer === 'kept' ? next : undefined);
});

it('keeps text in finding and question scopes deleted since they were opened', async () => {
  const { store, dealId, navigate, asked } = await start();
  await store.dispatch(CreateFinding, {
    dealId, title: 'Unallocated network upgrade costs', body: [instructions[13]], workstream: 'Interconnection',
  });
  await store.dispatch(CreateQuestion, { dealId, text: instructions[14] });
  const findingId = Object.keys(store.get().findings)[0];
  const questionId = Object.keys(store.get().questions)[0];
  const finding: Scope = { kind: 'finding', dealId, findingId };
  const question: Scope = { kind: 'question', dealId, questionId };
  expect(scopeValid(store.get(), finding)).toBe(true);
  expect(scopeValid(store.get(), question)).toBe(true);
  await store.dispatch(DeleteFinding, { dealId, findingId });
  await store.dispatch(DeleteQuestion, { dealId, questionId });
  for (const scope of [finding, question]) {
    const key = convKey(scope);
    setComposerText(key, instructions[15]);
    await sendTyped(store, scope, { navigate });
    expect(scopeValid(store.get(), scope)).toBe(false);
    expect(composerText(key)).toBe(instructions[15]);
  }
  expect(asked).not.toHaveBeenCalled();
});

it('builds answer actions with the original citation and replacement semantics, including undo', async () => {
  const { store, scope, dealId } = await start();
  await store.dispatch(CreateQuestion, { dealId, text: instructions[21] });
  const question = () => Object.values(store.get().questions)[0];
  const questionId = question().id;
  const response = 'The agreement covers the contracted capacity.\n\nReview the offtake finding.';
  expect(answerText(answer)).toBe(response);
  expect(questionFromAnswer(scope, answer, instructions[21])).toBe(instructions[21]);
  expect(questionFromAnswer({ kind: 'finding', dealId, findingId: id('f', 1) }, answer, '')).toBe(response);
  const finding = findingFromAnswer(answer);
  expect(finding).toMatchObject({ preview: response, title: 'The agreement covers the contracted capacity' });
  const sent = { text: finding.title, ws: 'Commercial' };
  const saved = await saveAnswerFinding(store, {
    dealId, text: finding.text, sources, draft: answerCardDraft(new Map(), answer.id, sent), sent,
    cancelled: () => false,
  });
  expect(saved).toMatchObject({ kind: 'saved', made: {
    body: ['The agreement covers the contracted capacity. [1]', 'Review the offtake finding.'], sources,
  } });

  const used = await useAnswer(store, dealId, questionId, answer);
  expect(answerWasUsed(question(), answer)).toBe(true);
  expect(question()).toMatchObject({ response, status: 'open', provenance: { origin: 'chat', sources } });
  if (!used.ok) throw new Error('Response was refused');
  expect((await store.undo(used.value.opId)).ok).toBe(true);
  expect(responseToReplace(question())).toBeNull();
  expect(answerWasUsed(question(), answer)).toBe(false);
});

it('requires replacement of the specific response the person confirmed', async () => {
  const { store, dealId } = await start();
  await store.dispatch(CreateQuestion, { dealId, text: instructions[28] });
  const question = () => Object.values(store.get().questions)[0];
  const questionId = question().id;
  const update = (response: string) => store.dispatch(SetResponse, { dealId, questionId, response });
  await update('Counsel is checking the executed agreement.');
  const approved = responseToReplace(question());
  expect(approved).toBe('Counsel is checking the executed agreement.');
  expect((await useAnswer(store, dealId, questionId, answer)).ok).toBe(false);
  await update('Counsel filed the signed variation in the legal folder.');
  expect((await useAnswer(store, dealId, questionId, answer, approved)).ok).toBe(false);
  expect(question().response).toBe('Counsel filed the signed variation in the legal folder.');
  expect((await useAnswer(store, dealId, questionId, answer, responseToReplace(question()))).ok).toBe(true);
});

it('filters hundreds of past conversations by deal and words, with headings across local midnight', () => {
  const state = initialState();
  const dealId = id('d', 1);
  const other = id('d', 2);
  const older = new Date(2026, 10, 16, 13).toISOString();
  const yesterday = new Date(2026, 10, 24, 23, 59).toISOString();
  const record = { rev: 1, createdAt: older, updatedAt: at };
  state.deals[dealId] = Deal.parse({ ...record, id: dealId, name: 'Project Southridge' });
  state.deals[other] = Deal.parse({ ...record, id: other, name: 'Project Longview' });
  const dates = [at, yesterday, older];
  for (const [index, text] of instructions.slice(0, 504).entries()) {
    const owner = index % 2 ? other : dealId;
    const scope: Scope = { kind: 'deal', dealId: owner, conv: `c${index.toString(36).padStart(4, '0')}` };
    const when = dates[index % dates.length];
    const reply = index < 6 ? answer.text : 'The diligence team has requested further evidence.';
    state.threads[convKey(scope)] = [
      { id: `ask${index}`, text, role: 'me', state: 'done', at: when },
      { ...answer, id: `reply${index}`, text: reply, at: when },
    ];
  }
  const store = { get: () => state, services: { clock } } as Store;
  const every = pastConversationList(store, { dealId, allDeals: true, search: '' });
  expect(every.rows).toHaveLength(504);
  const mine = pastConversationList(store, { dealId, allDeals: false, search: ' CONTRACTED  offtake ' });
  expect(mine.rows.map(({ conversation, group, startsGroup }) => [
    conversation.dealId, group, startsGroup, conversation.at,
  ])).toEqual([[dealId, 'today', true, at], [dealId, 'week', true, yesterday], [dealId, 'older', true, older]]);
  expect(mine.hasConversations).toBe(true);
});

it('counts open questions before applying the picker search', () => {
  const state = initialState();
  const dealId = id('d', 1);
  for (const [index, text] of instructions.entries()) {
    const questionId = id('q', index + 1);
    state.questions[questionId] = Question.parse({
      id: questionId, dealId, rev: 1, createdAt: at, updatedAt: at, n: index + 1, text,
      status: index % 2 === 0 ? 'open' : 'answered',
    });
  }
  const open = answerQuestionChoices(state, dealId, 'q120', false);
  const all = answerQuestionChoices(state, dealId, 'q120', true);
  expect(all.rows[0].n).toBe(120);
  expect(open.rows.map((q) => q.n)).not.toContain(120);
  expect(open.openCount).toBe(Math.ceil(instructions.length / 2));
  expect(all.openCount).toBe(open.openCount);
  expect(open.hasQuestions).toBe(true);
});
