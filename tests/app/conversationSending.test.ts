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
import { runSlashCommand, slashCommands } from '../../src/app/slashCommands';
import { setLogQuestion, showsLogQuestion } from '../../src/app/refusedCommands';
import { initialState, type Attachment, type Message } from '../../src/app/state';
import { Store } from '../../src/app/store';
import { Deal, Question } from '../../src/domain/model';
import { fail, ok } from '../../src/domain/result';
import { KEPT_TEXT_KEY, type DocumentService } from '../../src/ports';
import { disk, memRepo } from '../adapters/memRepo';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { copyRecoveryDisk, holdRecoveryWrite, operationWrite, recoveryApp, recoveryDeal } from './recoveryKit';

const local = new MemoryLocal();
initializeKeptText(local);
registry.set(RestoreQuestionSnapshot.name, RestoreQuestionSnapshot);
const { answerCardDraft, saveAnswerFinding } = await import('../../src/app/answerDrafts');
afterEach(saveKeptDrafts);
/** The composer drafts as saved to disk, which is what a restart brings back. */
const keptComposer = () =>
  new Map((local.read(KEPT_TEXT_KEY) as { composer?: [string, string][] } | null)?.composer);

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

/** Send `command` from the box, type `typedSince` while its save is out, and have the save refused (#955). */
async function refusedWhileTyping(store: Store, scope: Scope, command: string, typedSince: string) {
  const key = convKey(scope);
  const original = store.dispatch.bind(store);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const refusing = vi.spyOn(store, 'dispatch').mockImplementation(async (sent, input, options) => {
    if (sent !== CreateQuestion) return original(sent, input, options);
    await hold;
    return fail({ kind: 'storageFull', message: 'The disk is full' });
  });
  setLogQuestion(key, true);
  setComposerText(key, command);
  const sending = sendTyped(store, scope, { navigate: vi.fn() });
  await vi.waitFor(() => expect(composerText(key)).toBe(''));
  setComposerText(key, typedSince);
  release();
  await sending;
  refusing.mockRestore();
}

it('runs slash commands only when picked, and asks the model everything typed (#1054)', async () => {
  const { store, scope, dealId, navigate, asked } = await start();
  const launch = composerScope(scope, true);
  const key = convKey(launch.scope);
  const names = (text: string, where: Scope = launch.scope) => slashCommands(where, text)?.map((c) => c.command);
  expect(names('/')).toEqual(['/add-unresolved', '/log-question', '/new-deal']);
  expect(names('/DEAL')).toEqual(['/new-deal']);
  expect(names('/', { kind: 'all' })).toEqual(['/new-deal']);
  expect(names('/new\nmore')).toBeUndefined();
  expect(names('New deal')).toBeUndefined();
  setComposerText(key, '/new');
  runSlashCommand(store, launch.scope, 'newDeal');
  expect(store.get().ui.newDeal).toMatchObject({ name: '', folders: [] });
  expect(composerText(key)).toBe('');
  runSlashCommand(store, launch.scope, 'unresolved');
  expect(store.get().ui.dialog).toEqual({ kind: 'addUnresolved', dealId });
  runSlashCommand(store, launch.scope, 'logQuestion');
  setComposerText(key, instructions[4]);
  await sendTyped(store, launch.scope, { launchSlot: launch.launchSlot, navigate });
  expect(Object.values(store.get().questions).map((q) => q.text)).toEqual([instructions[4]]);
  expect(showsLogQuestion(key, composerText(key))).toBe(false);
  expect(asked).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();

  // The words the old typed commands matched are questions like any other.
  const typed = ['New deal terms in the amendment: what changed?', 'Open Southridge’s Q&A',
    'Please add all the unresolved gaps to Q&A.', `Log a question: ${instructions[5]}`,
    'Does this answer any of our open questions?'];
  for (const text of typed) {
    const next = composerScope(scope, true);
    setComposerText(convKey(next.scope), text);
    await sendTyped(store, next.scope, { launchSlot: next.launchSlot, navigate });
    expect(store.get().threads[convKey(next.scope)][0].text).toBe(text);
  }
  await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(typed.length));
  expect(Object.values(store.get().questions)).toHaveLength(1);
});

it('asks the model "Add question marks to the summary" and logs nothing (#1112)', async () => {
  const { store, scope, navigate, asked } = await start();
  const key = convKey(scope);
  setComposerText(key, 'Add question marks to the summary');
  await sendTyped(store, scope, { navigate });
  expect(asked).toHaveBeenCalledOnce();
  expect(store.get().threads[key][0].text).toBe('Add question marks to the summary');
  expect(Object.values(store.get().questions)).toHaveLength(0);
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

it('clears a typed question before its save and brings it back when refused', async () => {
  const { store, scope, dealId, navigate, asked } = await start();
  const key = convKey(scope);
  const submitted = `  ${instructions[30]}  `;
  const original = store.dispatch.bind(store);
  const refuse = vi.spyOn(store, 'dispatch').mockResolvedValueOnce({
    ok: false, error: { kind: 'storageFull', message: 'The disk is full' },
  });
  setLogQuestion(key, true);
  setComposerText(key, submitted);
  const refused = vi.fn();
  await sendTyped(store, scope, { navigate, refused });
  expect(refused).toHaveBeenCalledOnce();
  expect(composerText(key)).toBe(submitted.trim());
  // It comes back as a question to log, and a restart keeps it so (#1054).
  expect(showsLogQuestion(key, composerText(key))).toBe(true);
  saveKeptDrafts();
  const keptChips = (local.read(KEPT_TEXT_KEY) as { 'log-question'?: [string, unknown][] } | null)?.['log-question'];
  expect(new Map(keptChips).get(key)).toBe(true);
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
  // A restart while the save is out finds no command to send again.
  saveKeptDrafts();
  expect(keptComposer().has(key)).toBe(false);
  setComposerText(key, instructions[34]);
  release();
  await sending;
  expect(composerText(key)).toBe(instructions[34]);
  expect(showsLogQuestion(key, composerText(key))).toBe(false);
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
  const submitted = '  Did the lender consent to the revised assignment provisions?  ';
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
  setLogQuestion(key, true);
  setComposerText(key, submitted);
  const sending = sendTyped(store, scope, { navigate, refused });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  expect(composerText(key)).toBe('');
  setComposerText(key, next);
  if (newer === 'erased') setComposerText(key, '');
  expect(composerText(key)).toBe(newer === 'kept' ? next : '');
  saveKeptDrafts();
  const pending = keptComposer();
  release();
  await sending;

  // A refused command comes back ahead of anything typed since, so neither text is lost (#955).
  const settled = outcome === 'saved' ? (newer === 'kept' ? next : '')
    : newer === 'kept' ? `${submitted.trim()}\n\n${next}` : submitted.trim();
  expect(composerText(key)).toBe(settled);
  expect(refused).toHaveBeenCalledTimes(outcome === 'refused' ? 1 : 0);
  expect(Object.values(store.get().questions)).toHaveLength(outcome === 'saved' ? 1 : 0);
  expect(pending.get(key)).toBe(newer === 'kept' ? next : undefined);
  saveKeptDrafts();
  expect(keptComposer().get(key)).toBe(settled || undefined);
});

it('keeps every refused command and all typing on a deal with thousands of questions (#955)', async () => {
  const { store, scope, dealId, navigate } = await start();
  const key = convKey(scope);
  const logged = instructions.slice(0, 2000);
  for (const text of logged) expect((await store.dispatch(CreateQuestion, { dealId, text })).ok).toBe(true);
  // The disk refuses the question's write, held until the newer typing is in, so the store's own checks run.
  const { repo } = store.services;
  const write = repo.transaction.bind(repo);
  const holds: (() => void)[] = [];
  repo.transaction = async (transaction) => {
    if (!transaction.writes.some((change) => change.kind === 'question')) return write(transaction);
    await new Promise<void>((resolve) => holds.push(resolve));
    return fail({ kind: 'storageFull', message: 'The disk is full' });
  };
  const first = instructions[2001];
  const second = `${instructions[2002]}\n\n${instructions[2003]}`;
  const third = instructions[2004];
  setLogQuestion(key, true);
  setComposerText(key, first);
  const sending = sendTyped(store, scope, { navigate });
  await vi.waitFor(() => expect(holds).toHaveLength(1));
  // A second command sent while the first is out is turned away at once and goes back in the box.
  setLogQuestion(key, true);
  setComposerText(key, second);
  await sendTyped(store, scope, { navigate });
  expect(composerText(key)).toBe(second);
  setComposerText(key, `${second}\n\n${third}`);
  holds[0]();
  await sending;
  expect(composerText(key)).toBe(`${first}\n\n${second}\n\n${third}`);
  saveKeptDrafts();
  expect(keptComposer().get(key)).toBe(`${first}\n\n${second}\n\n${third}`);
  expect(Object.values(store.get().questions)).toHaveLength(logged.length);

  // Sent again, the refused command is logged alone, and what follows it stays in the box as it was.
  repo.transaction = write;
  await sendTyped(store, scope, { navigate });
  const texts = Object.values(store.get().questions).map((question) => question.text);
  expect(texts).toHaveLength(logged.length + 1);
  expect(texts.at(-1)).toBe(instructions[2001]);
  expect(composerText(key)).toBe(`${second}\n\n${third}`);
}, 30_000);

it('logs a refused command alone and asks the AI what was typed during its save', async () => {
  const { store, scope, navigate, asked } = await start();
  const key = convKey(scope);
  const command = instructions[50];
  const followUp = `${instructions[51]}\n\n${instructions[52]}`;
  await refusedWhileTyping(store, scope, command, followUp);
  // A restart keeps which part of the box is the refused command.
  saveKeptDrafts();
  const kept = local.read(KEPT_TEXT_KEY) as { 'refused-questions'?: [string, unknown][] } | null;
  expect(new Map(kept?.['refused-questions']).get(key)).toEqual([command]);
  await sendTyped(store, scope, { navigate });
  expect(Object.values(store.get().questions).map((question) => question.text)).toEqual([instructions[50]]);
  expect(composerText(key)).toBe(followUp);
  await sendTyped(store, scope, { navigate });
  expect(asked).toHaveBeenCalledOnce();
  expect(store.get().threads[key][0].text).toBe(followUp);
  expect(Object.values(store.get().questions)).toHaveLength(1);
});

it('logs a refused command alone after the text typed during its save was edited', async () => {
  const { store, scope, navigate } = await start();
  const key = convKey(scope);
  const command = instructions[70];
  await refusedWhileTyping(store, scope, command, 'Waht is the revenue?');
  setComposerText(key, `${command}\n\nWhat is the revenue?`);
  await sendTyped(store, scope, { navigate });
  expect(Object.values(store.get().questions).map((question) => question.text)).toEqual([instructions[70]]);
  expect(composerText(key)).toBe('What is the revenue?');
});

it('logs a refused question that is left alone in its box once the text after it is deleted (#955)', async () => {
  const { store, scope, navigate, asked } = await start();
  const key = convKey(scope);
  const command = instructions[90];
  await refusedWhileTyping(store, scope, command, 'What is the revenue?');
  setComposerText(key, `${command}\n`);
  expect(showsLogQuestion(key, composerText(key))).toBe(true);
  await sendTyped(store, scope, { navigate });
  expect(Object.values(store.get().questions).map((question) => question.text)).toEqual([command]);
  expect(asked).not.toHaveBeenCalled();
  expect(composerText(key)).toBe('');
});

it('asks the model, and drops the chip, once the refused question no longer heads the box (#1054)', async () => {
  const { store, scope, navigate, asked } = await start();
  const key = convKey(scope);
  const command = instructions[80];
  await refusedWhileTyping(store, scope, command, 'What is the revenue?');
  expect(showsLogQuestion(key, composerText(key))).toBe(true);
  setComposerText(key, 'What is the revenue?');
  expect(showsLogQuestion(key, composerText(key))).toBe(false);
  await sendTyped(store, scope, { navigate });
  expect(Object.values(store.get().questions)).toHaveLength(0);
  expect(asked).toHaveBeenCalledOnce();
  expect(store.get().threads[key][0].text).toBe('What is the revenue?');
});

it('leaves a refused command to Retry, not the box, when the store keeps it as interrupted work', async () => {
  const { store, scope, dealId, navigate } = await start();
  const key = convKey(scope);
  const followUp = instructions[61];
  const { repo } = store.services;
  const write = repo.transaction.bind(repo);
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  // The question's write is refused, and so is the journal note that it failed, so the store keeps it to retry.
  repo.transaction = async (transaction) => {
    const failedNote = transaction.writes.some((change) => change.kind === 'op'
      && (change.data as { state?: string }).state === 'failed');
    if (failedNote) return fail({ kind: 'storageFull', message: 'The disk is full' });
    if (!transaction.writes.some((change) => change.kind === 'question')) return write(transaction);
    await hold;
    return fail({ kind: 'storageFull', message: 'The disk is full' });
  };
  setLogQuestion(key, true);
  setComposerText(key, instructions[60]);
  const sending = sendTyped(store, scope, { navigate });
  await vi.waitFor(() => expect(composerText(key)).toBe(''));
  setComposerText(key, followUp);
  release();
  await sending;
  repo.transaction = write;
  expect(composerText(key)).toBe(followUp);
  const [offered] = store.interruptedOps().filter((operation) => operation.state === 'interrupted');
  expect(offered).toMatchObject({ command: 'CreateQuestion', input: { dealId, text: instructions[60] } });
  expect((await store.retryOp(offered.id))?.ok).toBe(true);
  expect(Object.values(store.get().questions).map((question) => question.text)).toEqual([instructions[60]]);
});

it('does not repeat a refused command that was typed again during its save', async () => {
  const { store, scope, navigate } = await start();
  const key = convKey(scope);
  const command = instructions[40];
  await refusedWhileTyping(store, scope, command, `${command}  `);
  expect(composerText(key)).toBe(command);
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

it('offers a typed question again after the app closes mid-save, and logs it once', async () => {
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  for (const text of instructions.slice(0, 2000)) {
    expect((await app.store.dispatch(CreateQuestion, { dealId, text })).ok).toBe(true);
  }
  const scope: Scope = { kind: 'deal', dealId };
  const key = convKey(scope);
  const typed = instructions[2010];
  const hold = holdRecoveryWrite(app, (transaction) => operationWrite(transaction, 'CreateQuestion', 'succeeded'));
  setLogQuestion(key, true);
  setComposerText(key, typed);
  const sending = sendTyped(app.store, scope, { navigate: vi.fn() });
  await hold.entered;
  // The app closes here: the box held nothing kept, and the journal holds the question as pending.
  saveKeptDrafts();
  expect(keptComposer().has(key)).toBe(false);
  const closed = copyRecoveryDisk(app.saved);
  hold.release();
  await sending;
  app.store.closing();
  await app.repo.close();

  const next = recoveryApp(closed);
  await next.store.boot();
  await next.store.loadDeal(dealId, { gaps: false });
  expect(Object.values(next.store.get().questions)).toHaveLength(2000);
  const [offered] = next.store.interruptedOps();
  expect(offered).toMatchObject({ command: 'CreateQuestion', input: { dealId, text: instructions[2010] } });
  expect((await next.store.retryOp(offered.id))?.ok).toBe(true);
  const texts = Object.values(next.store.get().questions).map((question) => question.text);
  expect(texts.filter((text) => text === instructions[2010])).toHaveLength(1);
  expect(texts).toHaveLength(2001);
  await next.repo.close();
}, 30_000);
