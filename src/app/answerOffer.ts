/**
 * An action the model offers under its answer (#1054): opening the New Deal form, a deal's page, or the Add All
 * Unresolved preview, or logging a question it drafted. The model only proposes; code checks the proposal against the
 * deals and the conversation, and nothing runs until a person presses the button.
 */
import { bareDealName, sameName } from './commands/deals';
import { isMine } from './commands/members';
import type { Scope } from './conversations';
import { DEAL_PAGES, pageHash, type Landing, type State } from './state';
import type { Store } from './store';
import { openNewDeal } from './dealFolders';
import { openAddUnresolved } from './addUnresolved';
import type { AnswerOffer } from '../ports';

export type Offer = AnswerOffer;

/** The answer tool's `offer`, as the model gave it: nothing in it is trusted until `checkedOffer`. */
export interface RawOffer { action?: unknown; deal?: unknown; page?: unknown; question?: unknown }

/** a deal name as navigation compares it: without "Project", in any case */
const navigationName = (name: string) => sameName(bareDealName(name.trim(), 'navigation')).toLowerCase();
/**
 * The deal a name names: that exact name, in any case, without "Project", spaces between words aside (#500, #1018).
 * Two deals of that name leave none, as the name alone can't say which (#1054).
 */
function dealByName<T extends { name: string }>(deals: T[], named: string): T | undefined {
  const exact = navigationName(named);
  if (!exact) return;
  const matches = deals.filter((deal) => navigationName(deal.name) === exact);
  return matches.length === 1 ? matches[0] : undefined;
}

const isPage = (page: unknown): page is Landing => DEAL_PAGES.some(([id]) => id === page);
const nonBlank = (text: unknown): text is string => typeof text === 'string' && !!text.trim();

/** The page the model offers: the one of the person's own deals it names, or else the conversation's own deal. */
function pageOffer(state: State, scope: Scope, raw: RawOffer): Offer | undefined {
  if (!isPage(raw.page)) return undefined;
  const own = Object.values(state.deals).filter((deal) => isMine(state, deal.id));
  const named = typeof raw.deal === 'string' ? dealByName(own, raw.deal) : undefined;
  const dealId = named?.id ?? (raw.deal === undefined && scope.kind !== 'all' ? scope.dealId : undefined);
  return dealId && state.deals[dealId] ? { kind: 'page', dealId, page: raw.page } : undefined;
}

/**
 * The offer as the conversation can act on it, or none. **Add All Unresolved** and **Log Question** are offered only in
 * a conversation about a deal, as the slash commands are.
 */
export function checkedOffer(state: State, scope: Scope, raw: unknown): Offer | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const offer = raw as RawOffer;
  if (offer.action === 'new deal') return { kind: 'newDeal' };
  if (offer.action === 'open page') return pageOffer(state, scope, offer);
  if (scope.kind !== 'deal' || !state.deals[scope.dealId]) return undefined;
  if (offer.action === 'add unresolved') return { kind: 'unresolved', dealId: scope.dealId };
  if (offer.action === 'log question' && nonBlank(offer.question)) return { kind: 'question', text: offer.question };
  return undefined;
}

/** An offer that runs when pressed; **Log Question** opens its card on screen instead. */
export type RunOffer = Exclude<Offer, { kind: 'question' }>;

/** A person pressed the offer's button. Checked again now, as the deal may have gone since the answer came. */
export function runOffer(store: Store, offer: RunOffer, navigate: (hash: string) => void) {
  const readOnly = store.readOnly();
  if (readOnly) {
    store.toast(readOnly);
    return;
  }
  if (offer.kind === 'newDeal') {
    openNewDeal(store);
    return;
  }
  if (!store.get().deals[offer.dealId]) {
    store.toast('That deal has been deleted');
    return;
  }
  if (offer.kind === 'page') navigate(pageHash(offer.page, offer.dealId));
  else openAddUnresolved(store, offer.dealId);
}
