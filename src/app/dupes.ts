import type { Deal } from '../domain/model';
import type { RoomMatch } from '../ports';
import type { DealKinds, State } from './state';
import { cleanName, withProject } from './commands/deals';

/**
 * Is a new deal one the team already has? Two deals may share a name, and are told apart by their counterparty and
 * the day each was made, so a name alone never counts. What does count, the data room first:
 *   - the data room: every document of the deal's data room is among the new folders' files (`room`);
 *   - the name and the counterparty both: the same name, and the same counterparty, given on both.
 * A folder another deal also reads does not count by itself: a shared folder (precedents, say) can serve many deals, and
 * when it is that deal's data room, the data room check finds it. The likeliest deal comes back, with what was found,
 * for the person to choose; nothing is ever refused.
 */
/** what was found on a deal, kept on the New deal form by the deal's id while the form asks */
export interface TwinFound { dealId: string; room?: RoomMatch; named: boolean }
export interface Twin { deal: Deal; room?: RoomMatch; named: boolean }

const key = (s: string) => cleanName(s).toLocaleLowerCase('en-US');

export function likelyTwin(s: Pick<State, 'deals'>, want: { name: string; counterparty?: string }, room: RoomMatch[] = []): Twin | null {
  const name = key(withProject(cleanName(want.name))); const cp = key(want.counterparty ?? '');
  const found = Object.values(s.deals).map((deal): Twin & { score: number } => {
    const r = room.find((m) => m.dealId === deal.id);
    const named = !!cp && key(deal.name) === name && key(deal.counterparty) === cp;
    return { deal, ...(r ? { room: r } : {}), named, score: (r ? 2 : 0) + (named ? 1 : 0) };
  }).filter((t) => t.score > 0)
    .sort((a, b) => b.score - a.score || (b.room?.matched ?? 0) - (a.room?.matched ?? 0) || b.deal.createdAt.localeCompare(a.deal.createdAt));
  if (!found.length) return null;
  const { score: _score, ...twin } = found[0]; return twin;
}


const KINDS = ['product', 'sector', 'technology'] as const;

function kindMatches(first?: string, second?: string) {
  const value = first?.trim().toLocaleLowerCase('en-US');
  return !!value && value === second?.trim().toLocaleLowerCase('en-US');
}

export function matchingDealKinds(kinds: DealKinds, deal: DealKinds) {
  return KINDS.filter((kind) => kindMatches(kinds[kind], deal[kind]));
}
