/**
 * Who has which deal in their list. A deal shows for the people who created it or added it (decisions: Storage); this
 * organizes what each person sees and restricts nothing. Each person writes only their own record on a deal (`Member`).
 */
import { z } from 'zod';
import { define } from '../command';
import { DealId, Member, firstMember, memberId } from '../../domain/model';
import { ok, fail, notFound, rejected } from '../../domain/result';
import { dealLabel, type State } from '../state';

/** Is this deal in the list of the person using the app? */
export const isMine = (s: Pick<State, 'members' | 'user'>, dealId: string): boolean => !!s.user && s.members[memberId(dealId, s.user.name)]?.on === true;

export { firstMember };

/**
 * The notice for adding or removing a deal: as before for a name of its own. A twin's longer label is the title with
 * the verb, "your deals" is its detail, which gives way first, and then the label gives way, never the verb (#27).
 */
function memberNotice(label: string, name: string, on: boolean) {
  if (label === name) return { message: on ? `${name} added to your deals` : `${name} removed from your deals` };
  return { message: on ? `${label} added · To your deals` : `${label} removed · From your deals`, messageCut: label };
}

/** Add a deal to the person's list ("Add to my deals"), or take it off again; each is the other's Undo. */
export const SetDealMember = define({
  name: 'SetDealMember',
  input: z.object({ dealId: DealId, on: z.boolean() }),
  targets: (s, i) => [memberId(i.dealId, s.user?.name ?? '')],
  plan(state, input, ctx) {
    const d = state.deals[input.dealId];
    if (!d) return fail(notFound('Deal not found', input.dealId));
    const id = memberId(d.id, ctx.actor); const cur = state.members[id];
    const label = dealLabel(state, d);      // says which of two same-named deals it is (#27)
    if ((cur?.on ?? false) === input.on) {
      return fail(rejected(input.on ? `${label} is already in your deals` : `${label} is not in your deals`));
    }
    const record: Member = cur ? { ...cur, on: input.on, updatedAt: ctx.at } : { ...firstMember(d.id, ctx.actor, ctx.at), on: input.on };
    return ok({
      upserts: [{ kind: 'member', record, expectedRev: cur ? cur.rev : null }],
      index: { dealId: '_', add: [{ kind: 'member', id }] },          // kept with the list of deals, so start-up reads them together
      audit: [],                                                       // a person's own list: nothing about the deal itself changed
      inverse: { command: 'SetDealMember', input: { dealId: d.id, on: !input.on } },
      ...memberNotice(label, d.name, input.on),
    });
  },
});
