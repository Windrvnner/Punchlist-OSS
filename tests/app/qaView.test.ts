// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { initializeKeptText, saveKeptDrafts } from '../../src/app/keptText';
import { qaEditorWorkstreams, qaPageView } from '../../src/app/qaView';
import { initialState, type Conflict, type State } from '../../src/app/state';
import { Deal, Question, wordingHash, type Draft, type Finding } from '../../src/domain/model';
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
    name: 'Q&A', file: 'Consolidated Q&A.csv', folder: 'Portfolio', sheet: 'Log', headerRow: 1, mapping: {},
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
