/**
 * Stepping through the records on a deal changed on two PCs (the stepper on the two-PC versions panel).
 * It stays on the page a person is on: the Q&A panel steps through questions, a finding's page through findings.
 */
import type { Store } from '../app/store';
import type { Conflict } from '../app/state';
import { navigate } from './nav';

/** opens a record in two versions where it is settled: a question in the Q&A panel, a finding on its page */
export function openConflict(store: Store, c: Conflict) {
  if (c.kind === 'question') navigate(store, `qa-${c.dealId}`, { selectedQuestion: c.id });
  else navigate(store, `finding-${c.dealId}-${c.id}`);
}
