import type { Finding } from '../domain/model';
import type { ChecklistRow } from '../ports';
import { conflictLabel, versionsWord, type State } from './state';

/** Turning an item off blocks a gap question. An open finding can still receive the question started on it. */
function targetUnavailable(row: ChecklistRow, off: boolean, findingId: string | undefined, finding?: Finding) {
  if (findingId || row.result === 'finding') {
    if (!finding) return 'Its finding is no longer here';
    return finding.status === 'open' ? null : 'Its finding is closed';
  }
  if (off) return 'This item is turned off';
  return row.result === 'gap' ? null : 'This item no longer needs a question';
}

/** #840: the card names, validates and logs the finding the draft started on, even after the item is rechecked. */
export function checklistQuestionTarget(
  state: State, row: ChecklistRow, off: boolean, original?: string, firstRaised?: Finding,
) {
  const current = row.result === 'finding' ? row.findingId : undefined;
  const findingId = original ?? (off ? firstRaised?.id : current);
  const finding = findingId ? state.findings[findingId] : undefined;
  const gone = findingId ? state.tombstones[findingId] : undefined;
  const conflict = findingId ? state.conflicts[findingId] : undefined;
  const conflictWhy = conflict
    ? `${conflictLabel(state, conflict)} has ${versionsWord(conflict.versions.length).toLowerCase()}. Choose one first`
    : null;
  const why = conflictWhy ?? targetUnavailable(row, off, findingId, finding);
  const currentFinding = current ? state.findings[current] : undefined;
  // Opening a kept draft lets the person see or copy it even while its finding has two versions.
  const askWhy = original ? null : conflictWhy;
  return {
    askedFinding: off ? finding : currentFinding, title: finding?.title ?? gone?.title ?? row.text, why, askWhy,
    links: { linkedItem: row.id, linkedFinding: findingId, workstream: finding?.workstream ?? '' },
  };
}
