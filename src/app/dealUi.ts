import { byName } from '../domain/order';
import { isMine } from './commands/members';
import type { State, UiState } from './state';

const DEAL_UI_DEFAULTS = {
  findingFilter: { status: 'open', workstream: '', reviewed: '' },
  qaFilter: { status: 'open', workstream: '', text: '' },
  checklistFilter: 'all', selectedQuestion: null, selectedChecklist: null,
} as const;

// Each deal starts with its own mutable filters.
export const freshDealUi = () => structuredClone(DEAL_UI_DEFAULTS);
const routeDeal = (route: UiState['route']) => 'dealId' in route ? route.dealId ?? null : null;

// list filters and the selected question belong to one deal: moving to another deal starts clean
export function dealUiOnRouteChange(was: UiState['route'], route: UiState['route'], explicit: Partial<UiState> = {}) {
  return routeDeal(was) === routeDeal(route) ? explicit : { ...freshDealUi(), ...explicit };
}

export function myDeals(state: Pick<State, 'deals' | 'members' | 'user'>) {
  return Object.values(state.deals).filter((deal) => isMine(state, deal.id));
}

export function pickNames<T extends { name: string }>(names: T[], query: string) {
  const match = query.trim().toLowerCase();
  return names.filter((entry) => entry.name.toLowerCase().includes(match)).sort((a, b) => byName(a.name, b.name));
}
