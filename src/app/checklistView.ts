import type { ChecklistRow } from '../ports';
import type { State } from './state';

/** Turning an item off keeps its findings and the target of a question already being written. */
export function checklistFindings(
  state: State, dealId: string, row: ChecklistRow, off: boolean, draftFindingId?: string,
) {
  if (!off) return { raised: [], finding: row.findingId ? state.findings[row.findingId] : undefined };

  const raised = Object.values(state.findings)
    .filter((finding) => finding.dealId === dealId && finding.itemId === row.id)
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open')
      || a.createdAt.localeCompare(b.createdAt));
  const draftTarget = raised.find((finding) => finding.id === draftFindingId && finding.status === 'open');
  return { raised, finding: draftTarget ?? raised[0] };
}
