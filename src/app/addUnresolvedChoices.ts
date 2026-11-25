import type { UnresolvedPreview } from './addUnresolved';
import type { Store } from './store';
import { isApprovedLink, linkApproval, type ApprovedLinks, type UnresolvedLink } from './unresolvedLinks';

type Choices = { off: ReadonlySet<string>; linked: ApprovedLinks };
const choices = new WeakMap<Store, Map<string, Choices>>();

export const unresolvedChoices = (store: Store, dealId: string): Choices =>
  choices.get(store)?.get(dealId) ?? { off: new Set(), linked: new Map() };

export function keepUnresolvedChoices(store: Store, dealId: string, selected: Choices): Choices {
  const deals = choices.get(store) ?? new Map<string, Choices>();
  deals.set(dealId, selected);
  choices.set(store, deals);
  return selected;
}

export const clearUnresolvedChoices = (store: Store, dealId: string) => choices.get(store)?.delete(dealId);

export function pruneUnresolvedChoices(preview: UnresolvedPreview, selected: Choices): Choices {
  const linked = new Map(preview.links.filter((link) => isApprovedLink(link, selected.linked.get(link.point.key)))
    .map((link) => [link.point.key, linkApproval(link)]));
  return { off: selected.off, linked };
}

export function chooseUnresolvedLink(selected: Choices, link: UnresolvedLink, on: boolean): Choices {
  const linked = new Map(selected.linked);
  const off = new Set(selected.off);
  const key = link.point.key;
  if (on) linked.set(key, linkApproval(link));
  else {
    linked.delete(key);
    // Unticking a link leaves the new question unticked until the person checks it.
    off.add(key);
  }
  return { off, linked };
}

export function chooseUnresolvedDraft(selected: Choices, key: string, on: boolean): Choices {
  const linked = new Map(selected.linked);
  const off = new Set(selected.off);
  if (on) {
    off.delete(key);
    linked.delete(key);
  } else off.add(key);
  return { off, linked };
}
