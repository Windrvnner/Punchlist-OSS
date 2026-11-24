import type { ChecklistRow } from '../ports';
import { conflictLabel, versionsWord, type State } from './state';

/** #840: the card names, validates and logs the finding the draft started on, even after the item is rechecked. */
export function checklistQuestionTarget(state: State, row: ChecklistRow, off: boolean, findingId?: string) {
  const finding = findingId ? state.findings[findingId] : undefined;
  const gone = findingId ? state.tombstones[findingId] : undefined;
  const conflict = findingId ? state.conflicts[findingId] : undefined;
  const conflictWhy = conflict
    ? `${conflictLabel(state, conflict)} has ${versionsWord(conflict.versions.length).toLowerCase()}. Choose one first`
    : null;
  let why = conflictWhy;
  if (!why && findingId) {
    if (!finding) why = 'Its finding is no longer here';
    else if (finding.status !== 'open') why = 'Its finding is closed';
  } else if (!findingId) {
    if (off) why = 'This item is turned off';
    else if (row.result !== 'gap') why = 'This item no longer needs a question';
  }
  return {
    title: finding?.title ?? gone?.title ?? row.text, why, conflictWhy,
    links: { linkedItem: row.id, linkedFinding: findingId, workstream: finding?.workstream ?? '' },
  };
}
