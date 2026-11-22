/**
 * Stepping through the records on a deal changed on two PCs (the stepper on the two-PC versions panel).
 * It stays on the page a person is on: the Q&A panel steps through questions, a finding's page through findings.
 */
import type { Store } from '../app/store';
import { dealQuestions, listedFindings, type Conflict, type State } from '../app/state';
import { navigate } from './nav';

/**
 * The deal's records of this one's kind in two versions, as a person meets them: questions by number, findings as
 * listed. Empty for a kind with no page of its own to step through (items, the deal, the firm's lists).
 */
export function twoVersionsQueue(s: State, c: Conflict): Conflict[] {
  if (c.kind === 'question') {
    const questions = dealQuestions(s, c.dealId).filter((q) => s.conflicts[q.id]).sort((a, b) => a.n - b.n);
    return questions.map((q) => s.conflicts[q.id]);
  }
  if (c.kind === 'finding') {
    return listedFindings(s, c.dealId).filter((f) => s.conflicts[f.id]).map((f) => s.conflicts[f.id]);
  }
  return [];
}

/** opens a record in two versions where it is settled: a question in the Q&A panel, a finding on its page */
export function openConflict(store: Store, c: Conflict) {
  if (c.kind === 'question') navigate(store, `qa-${c.dealId}`, { selectedQuestion: c.id });
  else navigate(store, `finding-${c.dealId}-${c.id}`);
}
