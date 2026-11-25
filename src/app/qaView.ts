import type { Question, QuestionStatus } from '../domain/model';
import { workstreamChoices } from '../domain/order';
import type { Scope } from './conversations';
import { eligibleForDraft, hasLogVersion } from './drafting';
import {
  dealQuestions, findingListed, listedFindings, qaChanged, qaListed, qaVersions, qaWorkstreamChoices,
  type Conflict, type State,
} from './state';
export { hasLogVersion } from './drafting';

type QaFilter = State['ui']['qaFilter'];
type StatusChoice = { status: QaFilter['status']; count: number | null };
const STATUS_ORDER: QuestionStatus[] = ['open', 'answered', 'closed'];

function statusChoices(state: State, rows: Question[], active: QaFilter['status']): StatusChoice[] {
  const counts = { open: 0, answered: 0, closed: 0, changed: 0, versions: 0 };
  for (const question of rows) {
    counts[question.status]++;
    if (qaChanged(state, question).length) counts.changed++;
    if (qaVersions(state, question)) counts.versions++;
  }
  const choices: StatusChoice[] = STATUS_ORDER.map((status) => ({ status, count: counts[status] }));
  choices.push({ status: 'all', count: null });
  for (const status of ['changed', 'versions'] as const) {
    if (counts[status] || active === status) choices.push({ status, count: counts[status] });
  }
  return choices;
}

/** The open question keeps its place when a table filter would otherwise hide it. */
export function qaPageView(state: State, dealId: string, hasHeldResponse: (question: Question) => boolean) {
  const rows = dealQuestions(state, dealId);
  const { qaFilter, selectedQuestion } = state.ui;
  const selected = rows.find((question) => question.id === selectedQuestion);
  const outsideFilter = selected && !qaListed(state, selected, qaFilter) ? selected.id : undefined;
  const list = rows.filter((question) => question.id === outsideFilter || qaListed(state, question, qaFilter));
  return {
    list,
    outsideFilter,
    selected: state.dealLoad[dealId] === 'loaded' ? selected ?? null : null,
    hasQuestions: rows.length > 0,
    // Status is shown for a row in two versions even if every row has the same saved status.
    oneStatus: list.length > 0
      && list.every((question) => question.status === list[0].status && !qaVersions(state, question)),
    statuses: statusChoices(state, rows, qaFilter.status),
    workstreams: qaWorkstreamChoices(rows),
    draftable: rows.filter((question) => eligibleForDraft(question) && !hasHeldResponse(question)).length,
    showResolve: qaFilter.status === 'versions' && rows.some((question) => hasLogVersion(state, question)),
  };
}

/** Editing a question can keep a workstream named in the imported log. */
export function qaEditorWorkstreams(state: State, dealId: string): string[] {
  return workstreamChoices(dealQuestions(state, dealId).map((question) => question.workstream));
}

/** Only unresolved differences with the log belong to Resolve, in question number order. */
export function inTwoVersions(state: State, dealId: string): Question[] {
  return dealQuestions(state, dealId).filter((question) => hasLogVersion(state, question));
}

/** Fix Resolve's stepper positions when it opens, including an explicitly opened question. */
export function logVersionQueue(state: State, dealId: string, questionId: string): string[] {
  const ids = inTwoVersions(state, dealId).map((question) => question.id);
  return ids.includes(questionId) ? ids : [questionId, ...ids];
}

/** Advance in the original queue, skipping any question whose log differences have since been settled. */
export function nextLogVersion(state: State, queue: string[], at: number): string | undefined {
  const stillOpen = (id: string) => hasLogVersion(state, state.questions[id]);
  return queue.slice(at + 1).find(stillOpen) ?? queue.slice(0, at).find(stillOpen);
}

/** Each record kind keeps its page order in the two-PC versions stepper. */
export function twoVersionsQueue(state: State, conflict: Conflict): Conflict[] {
  if (conflict.kind === 'question') {
    return dealQuestions(state, conflict.dealId)
      .filter((question) => state.conflicts[question.id]).map((question) => state.conflicts[question.id]);
  }
  if (conflict.kind === 'finding') {
    return listedFindings(state, conflict.dealId)
      .filter((finding) => state.conflicts[finding.id]).map((finding) => state.conflicts[finding.id]);
  }
  return [];
}

export type QueueScope = Extract<Scope, { kind: 'finding' | 'question' }>;
/** One item in the queue: `num` is the question's number (empty for a finding); `done` is no longer open. */
export type QueueItem = { id: string; num: string; title: string; done: boolean };

/** The strip uses the page filters except for the Q&A text filter and keeps the open item in the unsearched queue. */
function queueItems(state: State, scope: QueueScope): QueueItem[] {
  if (scope.kind === 'question') {
    const filter = { ...state.ui.qaFilter, text: '' };
    return dealQuestions(state, scope.dealId)
      .filter((question) => question.id === scope.questionId || qaListed(state, question, filter))
      .map((question) => ({
        id: question.id, num: `Q${question.n}`, title: question.text, done: question.status !== 'open',
      }));
  }
  return listedFindings(state, scope.dealId)
    .filter((finding) => finding.id === scope.findingId || findingListed(state, finding, state.ui.findingFilter))
    .map((finding) => ({ id: finding.id, num: '', title: finding.title, done: finding.status === 'closed' }));
}

export function queueView(state: State, scope: QueueScope) {
  const items = queueItems(state, scope);
  const currentId = scope.kind === 'question' ? scope.questionId : scope.findingId;
  const search = state.ui.queueSearch.toLowerCase();
  const shown = items.filter((item) => !search || `${item.num} ${item.title}`.toLowerCase().includes(search));
  const position = items.findIndex((item) => item.id === currentId);
  const searchPosition = shown.findIndex((item) => item.id === currentId);
  // When the search finds nothing, the arrows still step through the whole queue.
  const candidates = shown.length ? shown : items;
  const at = shown.length ? searchPosition : position;
  const step = (by: number) => candidates[at < 0 ? 0 : (at + by + candidates.length) % candidates.length]?.id;
  return { shown, total: items.length, position, searchPosition, previousId: step(-1), nextId: step(1) };
}
