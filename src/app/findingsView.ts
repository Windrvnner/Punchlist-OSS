import type { Finding } from '../domain/model';
import { conflictVersionCount, findingCounts } from './dealCounts';
import { removableIssuesLists, visibleDeletedNotes } from './deletedView';
import { findingListed, findingWorkstreams, listedFindings, workstreamHead, type State } from './state';

type FindingStatus = State['ui']['findingFilter']['status'];

function statusShown(status: FindingStatus, counts: ReturnType<typeof findingCounts>, many: boolean) {
  // An unavailable choice falls back to Open on a short list, so it cannot leave the list empty.
  if (status === 'reassess' && !counts.reassess) return 'open';
  if (status === 'closed' && !many && !counts.closed) return 'open';
  return status;
}

function visibleRows(findings: Finding[], state: Pick<State, 'conflicts'>) {
  const groups = new Map<string, number>();
  for (const finding of findings) {
    const name = workstreamHead(finding);
    groups.set(name, (groups.get(name) ?? 0) + 1);
  }
  return findings.map((finding, index) => {
    const name = workstreamHead(finding);
    const startsGroup = index === 0 || workstreamHead(findings[index - 1]) !== name;
    return {
      finding,
      heading: startsGroup ? { name, count: groups.get(name)! } : undefined,
      conflictVersions: conflictVersionCount(state, finding.id),
    };
  });
}

export function findingsView(state: State, dealId: string) {
  const all = listedFindings(state, dealId);
  const counts = findingCounts(state, dealId);
  const many = counts.total > 8;
  const status = statusShown(state.ui.findingFilter.status, counts, many);
  const filter = { ...state.ui.findingFilter, status };
  const statusOptions: FindingStatus[] = ['open'];
  if (counts.reassess) statusOptions.push('reassess');
  if (counts.closed || many) statusOptions.push('closed');
  statusOptions.push('all');
  return {
    counts,
    many,
    filter,
    statusOptions,
    showStatus: many || counts.closed > 0 || counts.reassess > 0 || status !== 'open',
    workstreams: findingWorkstreams(all),
    rows: visibleRows(all.filter((finding) => findingListed(state, finding, filter)), state),
    restorable: visibleDeletedNotes(state, dealId, 'finding').length > 0
      || removableIssuesLists(state, dealId).length > 0,
  };
}
