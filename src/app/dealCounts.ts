import { checklistRows } from './checklistView';
import { offFindingCount, type State } from './state';

/** Overview keeps the progress report while the Checklist's filter counts are unavailable. */
export function checklistStandingCounts(state: State, dealId: string) {
  const progress = state.progress[dealId]?.checklist;
  if (!progress) return null;
  const { counts } = checklistRows(state, dealId);
  if (!progress.items && !counts.off) return null;
  const standing = Array.isArray(state.checklists[dealId]) ? counts : {
    ...counts, all: progress.items, finding: progress.findings, gap: progress.gaps,
    open: progress.unsettled, satisfied: progress.satisfied,
  };
  return {
    ...standing,
    offOpen: offFindingCount(state, dealId),
    toResolve: standing.finding + standing.gap + standing.gone,
    settled: standing.satisfied + standing.person,
  };
}
