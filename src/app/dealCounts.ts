import { checklistRows } from './checklistView';
import { offFindingCount, type State } from './state';

/** Overview keeps the progress report while the Checklist's filter counts are unavailable. */
export function checklistStandingCounts(state: State, dealId: string) {
  const { counts } = checklistRows(state, dealId);
  let standing = counts;
  if (Array.isArray(state.checklists[dealId])) {
    if (!counts.all) return null;
  } else {
    const progress = state.progress[dealId]?.checklist;
    if (!progress || (!progress.items && !counts.off)) return null;
    const { findings, gaps, satisfied, unsettled } = progress;
    standing = {
      ...counts, all: findings + gaps + satisfied + unsettled,
      finding: findings, gap: gaps, open: unsettled, satisfied,
    };
  }
  return {
    ...standing,
    toResolve: standing.finding + standing.gap + standing.gone,
    settled: standing.satisfied + standing.person,
    offOpen: offFindingCount(state, dealId),
  };
}
