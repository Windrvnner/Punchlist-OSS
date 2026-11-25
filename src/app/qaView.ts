import type { Question, QuestionStatus } from '../domain/model';
import { workstreamChoices } from '../domain/order';
import { eligibleForDraft } from './drafting';
import {
  dealQuestions, qaChanged, qaKept, qaListed, qaVersions, qaWorkstreamChoices,
  type State,
} from './state';

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

export function hasLogVersion(state: State, question: Question | undefined): boolean {
  return !!question && Object.keys(qaKept(state, question)).length > 0;
}
