import type { Deal, Operation } from '../domain/model';
import { GROUP_HEADING } from './commands/deals';
import { isMine } from './commands/members';
import type { State } from './state';

type DealState = Pick<State, 'deals' | 'members' | 'user'>;

function newestFirst(a: Deal, b: Deal) {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

/** Home's example rotation uses the original deal order. Both lists show their newest entries first. */
export function dealRows(state: DealState, view: 'add' | 'rail' | 'home', query = '') {
  const search = query.trim().toLowerCase();
  const rows = Object.values(state.deals).map((deal) => ({ deal, mine: isMine(state, deal.id) }));
  if (view === 'add') {
    return rows.filter(({ deal }) => deal.name.toLowerCase().includes(search)
      || deal.counterparty.toLowerCase().includes(search))
      .sort((a, b) => Number(a.mine) - Number(b.mine) || newestFirst(a.deal, b.deal));
  }
  const mine = rows.filter((row) => row.mine);
  return view === 'rail' ? mine.sort((a, b) => newestFirst(a.deal, b.deal)) : mine;
}

const GROUPS = ['live', 'monitor', 'pitch', 'closed'] as const;

export function railDealGroups(state: DealState) {
  const deals = dealRows(state, 'rail').map(({ deal }) => deal);
  return GROUPS.map((group) => ({
    group, label: GROUP_HEADING[group], deals: deals.filter((deal) => deal.group === group),
  }));
}

export function isInterrupted(op: Operation | undefined) {
  return op?.state === 'interrupted';
}

export function interruptedOperations(state: Pick<State, 'ops'>) {
  return Object.values(state.ops).filter(isInterrupted);
}
