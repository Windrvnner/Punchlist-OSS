import { firmOf, type Layer } from '../domain/checklist';
import type { Deal } from '../domain/model';
import { checkingSays } from './checking';
import { checklistRows } from './checklistView';
import { folderIndexCounts, liveFolders } from './indexing';
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

/** Standings reflect the saved finding status, regardless of which rows the Findings filters show. */
export function findingCounts(state: Pick<State, 'findings'>, dealId: string) {
  const counts = { total: 0, open: 0, reassess: 0, closed: 0 };
  for (const finding of Object.values(state.findings)) {
    if (finding.dealId !== dealId) continue;
    counts.total++;
    counts[finding.status]++;
    if (finding.status === 'open' && finding.updated) counts.reassess++;
  }
  return counts;
}

/** The Overview and tab count each question once, by its saved status. */
export function questionCounts(state: Pick<State, 'questions'>, dealId: string) {
  const counts = { total: 0, open: 0, answered: 0, closed: 0 };
  for (const question of Object.values(state.questions)) {
    if (question.dealId !== dealId) continue;
    counts.total++;
    counts[question.status]++;
  }
  return counts;
}

export function conflictVersionCount(state: Pick<State, 'conflicts'>, recordId: string) {
  return state.conflicts[recordId]?.versions.length;
}

export function indexingTotals(state: Pick<State, 'indexing'>, deal: Pick<Deal, 'id' | 'folders'>) {
  const folders = liveFolders(state, deal);
  return { folders: folders.length, ...folderIndexCounts(folders) };
}

export function checklistListCounts(state: Pick<State, 'firmList'>, layer: Layer) {
  return firmOf(state.firmList).lists
    .filter((list) => list.layer === layer)
    .map((list) => ({ name: list.name, n: list.items.length }));
}

/** The check line counts unchecked rows in the last check, once the first pass is no longer indexing. */
export function uncheckedChecklistCount(
  state: Pick<State, 'checklists'>, deal: Pick<Deal, 'id' | 'stage'>,
) {
  const rows = state.checklists[deal.id];
  if (deal.stage === 'indexing' || !Array.isArray(rows)) return 0;
  return rows.filter((row) => row.result === 'unchecked').length;
}

export function checkLeftCount(check: State['checks'][string] | undefined, deep: boolean) {
  if (deep || check?.failedAt || !check?.left || check.left.changed) return 0;
  return check.left.items + check.left.findings;
}

/** Which check is due on Overview's Check again line, whether it warns, and which check its button runs. */
export function checkLine(state: State, dealId: string) {
  const check = state.checks[dealId];
  const deal = state.deals[dealId];
  if (!deal) return null;
  const deep = !!check?.offerDeep && !check.left && !check.failedAt;
  // what the latest check left out can be checked on its own while the documents are the ones it checked
  const rest = checkLeftCount(check, deep);
  const shared = checkingSays(check?.checking, check?.busy === 'deep');
  // checklist items no check has reached yet, such as items brought in since the last one; not while the first pass
  // is still reading
  const unchecked = uncheckedChecklistCount(state, deal);
  const warn = !check?.busy && (!!check?.failedAt || !!check?.left || deep || unchecked > 0);
  const kind = shared || check?.busy ? 'running' as const : check?.failedAt ? 'failed' as const
    : check?.left ? 'left' as const : deep ? 'deep' as const : unchecked ? 'unchecked' as const : null;
  return kind && { kind, warn, deep, rest, shared, unchecked };
}

type StandingSub = 'finding' | 'gap' | 'gone' | 'satisfied' | 'person';

/** Each part of the Overview standing, with the checklist filters that open the rows counted in it. */
export function checklistStandingParts(counts: NonNullable<ReturnType<typeof checklistStandingCounts>>) {
  const sub = (...filters: StandingSub[]) => filters.map((filter) => ({ filter, n: counts[filter] }));
  return [
    { k: 'open' as const, n: counts.toResolve, filter: 'all' as const, sub: sub('finding', 'gap', 'gone') },
    { k: 'prog' as const, n: counts.open, filter: 'open' as const },
    counts.person ? { k: 'done' as const, n: counts.settled, sub: sub('satisfied', 'person') }
      : { k: 'done' as const, n: counts.satisfied, filter: 'satisfied' as const },
  ];
}
