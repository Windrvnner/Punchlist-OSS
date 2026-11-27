import { memberId } from '../domain/model';
import { byName } from '../domain/order';
import type { State, UiState } from './state';

export const DEAL_UI_DEFAULTS = {
  findingFilter: { status: 'open', workstream: '', reviewed: '' },
  qaFilter: { status: 'open', workstream: '', text: '' },
  checklistFilter: 'all', selectedQuestion: null, selectedChecklist: null,
} as const;

// Each deal starts with its own mutable filters.
export const freshDealUi = () => structuredClone(DEAL_UI_DEFAULTS);
const routeDeal = (route: UiState['route']) => 'dealId' in route ? route.dealId ?? null : null;

export function dealUiOnRouteChange(was: UiState['route'], route: UiState['route'], explicit: Partial<UiState> = {}) {
  return routeDeal(was) === routeDeal(route) ? explicit : { ...freshDealUi(), ...explicit };
}

/** Is this deal in the list of the person using the app? */
export function isMine(state: Pick<State, 'members' | 'user'>, dealId: string) {
  return !!state.user && state.members[memberId(dealId, state.user.name)]?.on === true;
}

export function myDeals(state: Pick<State, 'deals' | 'members' | 'user'>) {
  return Object.values(state.deals).filter((deal) => isMine(state, deal.id));
}

export function pickNames<T extends { name: string }>(names: T[], query: string) {
  const match = query.trim().toLowerCase();
  return names.filter((entry) => entry.name.toLowerCase().includes(match)).sort((a, b) => byName(a.name, b.name));
}
