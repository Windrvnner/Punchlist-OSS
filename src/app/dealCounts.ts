import { checklistRows } from './checklistView';
import { offFindingCount, type State } from './state';

/** Overview keeps the progress report while the Checklist's filter counts are unavailable. */
export function checklistStandingCounts(state: State, dealId: string) {
  const progress = state.progress[dealId]?.checklist;
  if (!progress) return null;
  const { counts } = checklistRows(state, dealId);
  if (!progress.items && !counts.off) return null;
  const read = Array.isArray(state.checklists[dealId]);
  const standing = read ? counts : {
    ...counts, finding: progress.findings, gap: progress.gaps,
    open: progress.unsettled, satisfied: progress.satisfied,
  };
  const toResolve = standing.finding + standing.gap + standing.gone;
  const settled = standing.satisfied + standing.person;
  return {
    ...standing, toResolve, settled,
    all: read ? counts.all : toResolve + standing.open + settled,
    offOpen: offFindingCount(state, dealId),
  };
}
