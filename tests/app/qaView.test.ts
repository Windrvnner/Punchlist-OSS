// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { initializeKeptText, saveKeptDrafts } from '../../src/app/keptText';
import {
  inTwoVersions, logVersionQueue, nextLogVersion, qaEditorWorkstreams, qaPageView, queueView, twoVersionsQueue,
} from '../../src/app/qaView';
import { initialState, type Conflict, type State } from '../../src/app/state';
import { Deal, Finding, Question, wordingHash, type Draft } from '../../src/domain/model';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

initializeKeptText(new MemoryLocal());
const { typedResponse, unsavedFields } = await import('../../src/app/fieldDrafts');
afterEach(() => {
  unsavedFields.clear();
  saveKeptDrafts();
});

const AT = '2026-11-20T14:00:00.000Z';
const BEFORE = '2026-11-18T14:00:00.000Z';
const RECORD = { rev: 3, createdAt: BEFORE, updatedAt: AT };
const id = (prefix: string, number: number) => `${prefix}_${String(number).padStart(26, '0')}`;
const DEAL = id('d', 1);
const OTHER = id('d', 2);
const qid = (number: number) => id('q', number);
const LOG_RESPONSE = 'The executed agreement was uploaded to the legal folder.';
const DRAFT_STATUS: Partial<Record<number, Draft['status']>> = {
  2: 'pending', 3: 'found', 4: 'failed', 5: 'found', 7: 'none',
};

function makeQuestion(text: string, n: number): Question {
  const question = Question.parse({
    ...RECORD, id: qid(n), dealId: DEAL, n, text, askedBy: 'Lamna Capital',
    status: n <= 1000 ? 'open' : n <= 1800 ? 'answered' : 'closed', workstream: 'Legal',
  });
  if (n >= 2 && n <= 5) question.workstream = ['Commercial', '', '  ', 'No workstream'][n - 2];
  if (n === 6) question.workstream = 'Project finance';
  if ([6, 11, 13].includes(n)) question.response = LOG_RESPONSE;
  if (n === 8) question.text = ' ';
  const draftStatus = DRAFT_STATUS[n];
  if (draftStatus) question.draft = {
    status: draftStatus, text: LOG_RESPONSE, sources: [], forWording: wordingHash(n === 5 ? 'Old text' : text),
  };
  if (n === 14 || n === 15) question.logPick = { of: n === 14 ? AT : BEFORE, sent: { response: '' } };
  return question;
}

function conflict(record: Question | Finding, kind: Conflict['kind'], alternate: Question | Finding = record) {
  const versions = [record, alternate].map((data, index) => ({
    id: String(index), by: 'Deal team', from: 'Deal team', at: AT, data, raw: data,
  }));
  return { id: record.id, dealId: record.dealId, kind, versions };
}

function fixture(): State {
  const state = initialState();
  const questions = portfolioQuestions().map((text, index) => makeQuestion(text, index + 1)).reverse();
  const foreign = { ...questions[0], id: qid(3000), n: 1, dealId: OTHER };
  state.questions = Object.fromEntries([...questions, foreign].map((question) => [question.id, question]));
  for (const [n, status] of [[23, 'answered'], [40, 'closed'], [1200, 'open']] as const) {
    const question = state.questions[qid(n)];
    state.conflicts[question.id] = conflict(question, 'question', { ...question, status });
  }
  state.conflicts[foreign.id] = conflict(foreign, 'question');
  state.dealLoad[DEAL] = 'loaded';
  state.deals[DEAL] = Deal.parse({ ...RECORD, id: DEAL, name: 'Renewable portfolio', qaLogs: [{
    name: 'Q&A', file: 'Consolidated Q&A.csv', folder: 'Portfolio', sheet: 'Log', headerRow: 1,
    headers: [], mapping: {},
    last: {
      archive: 'Previous Q&A.csv', at: AT, by: 'Deal team', sent: {},
      changed: { [qid(18)]: { priority: 'Low' }, [qid(19)]: { priority: 'Medium' }, [qid(20)]: { priority: '' } },
      kept: {
        [qid(1)]: { status: 'Answered' }, [qid(12)]: { response: LOG_RESPONSE }, [qid(13)]: { response: LOG_RESPONSE },
        [qid(14)]: { response: LOG_RESPONSE }, [qid(15)]: { response: LOG_RESPONSE },
      },
    },
  }] });
  state.prefs = { ...state.prefs, qaSeen: { [qid(19)]: AT, [qid(20)]: BEFORE } };
  return state;
}

const view = (state: State) => qaPageView(state, DEAL, typedResponse);
const numbers = (questions: Question[]) => questions.map((question) => question.n);
function filter(state: State, status: State['ui']['qaFilter']['status'], workstream = '', text = '') {
  state.ui.qaFilter = { status, workstream, text };
}

it('counts saved statuses, unseen changes, both kinds of versions and eligible drafts across the whole deal', () => {
  const state = fixture();
  unsavedFields.set(`${qid(9)}:response`, { text: 'Waiting on revised covenants.', base: '', rev: 3 });
  unsavedFields.set(`${qid(10)}:response`, { text: '   ', base: '', rev: 3 });
  unsavedFields.set(`${qid(11)}:response`, { text: LOG_RESPONSE, base: '', rev: 3 });
  filter(state, 'open', 'Commercial', 'no matching words');
  const page = view(state);
  expect(page.list).toEqual([]);
  expect(page.hasQuestions).toBe(true);
  expect(page.statuses).toEqual([
    { status: 'open', count: 1000 }, { status: 'answered', count: 800 }, { status: 'closed', count: 576 },
    { status: 'all', count: null }, { status: 'changed', count: 2 }, { status: 'versions', count: 6 },
  ]);
  // Pending, current/empty-result drafts, saved responses, blank wording, and differing kept text cost eight drafts.
  expect(page.draftable).toBe(992);
  expect(page.workstreams).toEqual([
    'Antitrust & FDI', 'Commercial', 'Compliance', 'Environmental & social', 'Financial', 'HR & benefits',
    'Insurance', 'IT & cyber', 'Legal', 'Project finance', 'Real estate', 'Regulatory & permits', 'Structure',
    'Tax', 'Technical', 'No workstream',
  ]);
  expect(qaEditorWorkstreams(state, DEAL).slice(8, 12)).toEqual([
    'Legal', 'No workstream', 'Project finance', 'Real estate',
  ]);
});

it('keeps the selection in number order and applies status, workstream and text filters independently', () => {
  const state = fixture();
  state.ui.selectedQuestion = qid(250);
  filter(state, 'answered', 'Legal', 'EXECUTED EPC CONTRACT FOR CONTOSO SOLAR');
  expect(view(state)).toMatchObject({ selected: { id: qid(250) }, outsideFilter: qid(250), oneStatus: false });
  expect(numbers(view(state).list)).toEqual([1, 250, 1081, 1297, 1513, 1729]);
  state.dealLoad[DEAL] = 'loading';
  expect(view(state)).toMatchObject({ selected: null, outsideFilter: qid(250) });
  state.ui.selectedQuestion = null;
  filter(state, 'answered');
  expect(numbers(view(state).list).slice(0, 4)).toEqual([1, 23, 1001, 1002]);
  filter(state, 'closed');
  expect(view(state).list[0].n).toBe(40);
  filter(state, 'all', 'No workstream');
  expect(numbers(view(state).list)).toEqual([3, 4, 5]);
  expect(view(state).oneStatus).toBe(true);
  filter(state, 'changed');
  expect(numbers(view(state).list)).toEqual([18, 20]);
  state.prefs.qaSeen[qid(18)] = AT;
  state.prefs.qaSeen[qid(20)] = AT;
  expect(view(state).statuses.at(-2)).toEqual({ status: 'changed', count: 0 });
  filter(state, 'all');
  expect(view(state).statuses.map(({ status }) => status)).toEqual(['open', 'answered', 'closed', 'all', 'versions']);
  filter(state, 'versions');
  expect(numbers(view(state).list)).toEqual([1, 12, 15, 23, 40, 1200]);
  expect(view(state).showResolve).toBe(true);
  state.deals[DEAL].qaLogs = [];
  expect(view(state).showResolve).toBe(false);
  expect(numbers(view(state).list)).toEqual([23, 40, 1200]);
  state.conflicts = {};
  expect(view(state).statuses.at(-1)).toEqual({ status: 'versions', count: 0 });
  expect(view(state).list).toEqual([]);
});

it.each(['log', 'two-PC'])('keeps Status visible for %s versions with identical saved statuses', (source) => {
  const state = fixture();
  for (const question of Object.values(state.questions)) question.status = 'answered';
  if (source === 'log') state.conflicts = {};
  else state.deals[DEAL].qaLogs = [];

  filter(state, 'versions');
  const page = view(state);
  expect(numbers(page.list)).toEqual(source === 'log' ? [12, 15] : [23, 40, 1200]);
  expect(new Set(page.list.map((question) => question.status))).toEqual(new Set(['answered']));
  expect(page.oneStatus).toBe(false);

  state.conflicts = {};
  state.deals[DEAL].qaLogs = [];
  filter(state, 'answered');
  const settled = view(state);
  expect(settled.list).toHaveLength(2376);
  expect(settled.oneStatus).toBe(true);
});

it('searches the strip separately, wraps and keeps its place when search hides the current row', () => {
  const state = fixture();
  const scope = { kind: 'question' as const, dealId: DEAL, questionId: qid(2) };
  filter(state, 'versions', 'Legal', 'no matching table rows');
  const all = queueView(state, scope);
  expect(all.shown.map(({ id }) => id)).toEqual([1, 2, 12, 15, 23, 40, 1200].map(qid));
  expect(all.shown.map(({ done }) => done)).toEqual([false, false, false, false, false, false, true]);
  expect(all).toMatchObject({ total: 7, position: 1, searchPosition: 1, previousId: qid(1), nextId: qid(12) });
  state.ui.queueSearch = 'q12 PROVIDE THE DECOMMISSIONING';
  const searched = queueView(state, scope);
  expect(searched.shown.map(({ id }) => id)).toEqual([qid(12)]);
  expect(searched).toMatchObject({ total: 7, position: 1, searchPosition: -1, previousId: qid(12), nextId: qid(12) });
  state.ui.queueSearch = 'outside the log';
  expect(queueView(state, scope)).toMatchObject({ shown: [], searchPosition: -1, previousId: qid(1), nextId: qid(12) });
  state.ui.queueSearch = '';
  expect(queueView(state, { ...scope, questionId: qid(1200) }).nextId).toBe(qid(1));
});

it('keeps PC conflicts separate from the log queue and skips records resolved after Resolve opened', () => {
  const state = fixture();
  expect(numbers(inTwoVersions(state, DEAL))).toEqual([1, 12, 15]);
  const pc = state.conflicts[qid(40)];
  expect(twoVersionsQueue(state, pc).map(({ id }) => id)).toEqual([23, 40, 1200].map(qid));
  expect(twoVersionsQueue(state, { ...pc, kind: 'deal' })).toEqual([]);
  expect(logVersionQueue(state, DEAL, qid(23))).toEqual([23, 1, 12, 15].map(qid));
  const snapshot = logVersionQueue(state, DEAL, qid(1));
  expect(snapshot).toEqual([1, 12, 15].map(qid));
  state.questions[qid(12)].response = LOG_RESPONSE;
  expect(nextLogVersion(state, snapshot, 0)).toBe(qid(15));
  expect(nextLogVersion(state, snapshot, 2)).toBe(qid(1));
  delete state.questions[qid(1)];
  expect(nextLogVersion(state, snapshot, 2)).toBeUndefined();
});

it('uses Findings order and filters in the shared strip and keeps the selected finding available', () => {
  const state = fixture();
  const lease = Finding.parse({
    ...RECORD, id: id('f', 1), dealId: DEAL, title: 'Leases require consent', workstream: 'Legal',
    raisedAt: BEFORE, origin: 'human', updated: true,
  });
  const covenant = {
    ...lease, id: id('f', 2), title: 'Covenant cure period missing', raisedAt: AT, updated: false,
  };
  const tax: Finding = {
    ...lease, id: id('f', 3), title: 'Tax equity notice delivered', workstream: 'Tax', status: 'closed',
  };
  state.findings = Object.fromEntries([covenant, tax, lease].map((finding) => [finding.id, finding]));
  const scope = { kind: 'finding' as const, dealId: DEAL, findingId: tax.id };
  state.ui.findingFilter = { status: 'open', workstream: 'Legal', reviewed: '' };
  const queue = queueView(state, scope);
  expect(queue.shown.map(({ id, num, done }) => [id, num, done])).toEqual([
    [lease.id, '', false], [covenant.id, '', false], [tax.id, '', true],
  ]);
  state.ui.queueSearch = 'TAX EQUITY';
  expect(queueView(state, scope).shown.map(({ id }) => id)).toEqual([tax.id]);
  state.conflicts = Object.fromEntries([covenant, tax, lease].map((finding) => [
    finding.id, conflict(finding, 'finding'),
  ]));
  expect(twoVersionsQueue(state, state.conflicts[tax.id]).map(({ id }) => id)).toEqual([lease.id, covenant.id, tax.id]);
});
