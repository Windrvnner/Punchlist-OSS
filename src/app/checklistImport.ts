/**
 * Bringing in one of the firm's checklists, and undoing it (linking design, section 13: a batch).
 *
 * The list itself is one operation; each deal it adds items to is one more, since each deal's records are kept apart.
 * "Undo all" undoes each of them that has not changed since, and names the deals where something had.
 */
import type { Store } from './store';
import { BringInList, AddDealItems, RegroupDealItems, SetItemsOff, dealsForBringIn, missingItems, regrouped, usableFirm } from './commands/checklist';
import { itemId, itemsFor, listId, type FirmLayerList, type Layer } from '../domain/checklist';
import { ok, fail, type Result } from '../domain/result';
import { Undo } from './commands/undo';
import { EditDeal } from './commands/deals';
import { FIRM } from './state';

export interface BringInResult { opIds: string[]; items: number; deals: number; /** deals the items could not be added to, by name, and why */ missed: { deal: string; why: string }[] }

export async function bringIn(store: Store, list: Omit<FirmLayerList, 'by' | 'at'> & { layer: Layer; name: string }): Promise<Result<BringInResult>> {
  const id = listId(list.layer, list.name);
  const r = await store.dispatch(BringInList, { list }, { quiet: true, idempotencyKey: 'bring-in-list' });
  if (!r.ok) return r;
  // a list brought in again unchanged writes nothing, so there is nothing of it to undo: only an operation in the journal is
  const opIds = store.get().ops[r.value.opId] ? [r.value.opId] : []; let items = 0; let deals = 0; const missed: BringInResult['missed'] = [];
  for (const d of dealsForBringIn(store.get(), list)) {
    await store.loadDeal(d.id, { gaps: false });
    const s = store.get(); const deal = s.deals[d.id]; if (!deal) continue;
    if (s.dealLoad[d.id] !== 'loaded') { missed.push({ deal: deal.name, why: 'it could not be read' }); continue; }
    // the items it already holds are grouped as the list now is first, then those it is missing are added
    const groups = regrouped(s, deal);
    if (groups.length) { const g = await store.dispatch(RegroupDealItems, { dealId: d.id, groups }, { quiet: true }); if (g.ok) opIds.push(g.value.opId); else missed.push({ deal: deal.name, why: g.error.message }); }
    const wanted = missingItems(store.get(), deal); if (!wanted.length) continue;
    const a = await store.dispatch(AddDealItems, { dealId: d.id, items: wanted }, { quiet: true });
    if (!a.ok) { missed.push({ deal: deal.name, why: a.error.message }); continue; }
    opIds.push(a.value.opId); items += wanted.length; deals++;
  }
  return ok({ opIds, items, deals, missed });
}

/**
 * Undo a bring-in (linking design, section 4): the list first, and nothing else if that is refused because the list has
 * changed since. Then each deal's operations, last first: a grouping is put back, and of the items the bring-in added,
 * only those no list the deal uses still holds are turned off. Those changed since are left, and named.
 */
export async function undoBringIn(store: Store, opIds: string[]): Promise<Result<void>> {
  const ops = opIds.map((id) => ({ id, op: store.get().ops[id] }));
  const listOp = ops.find((o) => o.op && o.op.command === 'BringInList');
  if (listOp) {
    // the same list brought in on another PC at the same time is one version with this one: undoing it would undo theirs
    const got = await store.services.repo.get('firmList', (listOp.op.targets ?? [])[0] ?? '');
    const other = got.ok ? got.value?.alike?.find((a) => !a.here) : undefined;
    if (other) {
      const message = `${other.by} imported this list too, from ${other.from}, so nothing was undone`;
      return fail({ kind: 'rejected', message });
    }
    const r = await store.dispatch(Undo, { opId: listOp.id }, { quiet: true });
    if (!r.ok) return fail({ kind: 'rejected', message: 'The list has changed since, so nothing was undone' });
  }
  const left: string[] = [];
  for (const { id, op } of ops.filter((o) => o !== listOp).reverse()) {
    const deal = op?.dealId ? store.get().deals[op.dealId] : undefined;
    const inv = op?.inverse as { command?: string; input?: { dealId: string; off?: string[] } } | undefined;
    // an item another of the deal's lists still holds stays on (the rule of a swap); read before the Undo turns it off
    const held = new Set(deal ? heldNow(store, deal) : []);
    const keep = deal && inv?.command === 'SetItemsOff' ? (inv.input?.off ?? []).filter((i) => held.has(i)) : [];
    // the Undo itself, so an operation changed since is refused and one undone is not undone twice; the items still held go back on after
    const r = await store.dispatch(Undo, { opId: id }, { quiet: true });
    if (!r.ok) { left.push(deal?.name ?? 'the firm’s checklist'); continue; }
    if (deal && keep.length && !(await store.dispatch(SetItemsOff, { dealId: deal.id, on: keep }, { quiet: true })).ok) left.push(deal.name);
  }
  return left.length ? fail({ kind: 'rejected', message: `Changed since, so not undone: ${left.join(', ')}` }) : ok(undefined);
}

/** the ids of the items the deal's lists hold now */
function heldNow(store: Store, deal: { id: string; product?: string; sector?: string; technology?: string }): string[] {
  return itemsFor(usableFirm(store.get()), deal).map((w) => itemId(deal.id, w.text));
}

/**
 * What picking another list for a deal's structure, sector or technology would do: how many of its checklist items would
 * go off and how many would come on, worked out by the change itself, so the ask says what the notice will
 * (a swap that turns items off asks first). Null when the change would be refused or does nothing; it then says so
 * itself.
 */
export function previewSwap(store: Store, dealId: string, field: 'product' | 'sector' | 'technology', to: string): { off: number; on: number } | null {
  const s = store.get();
  const input = EditDeal.input.safeParse({ dealId, [field]: to, swap: true }); if (!input.success) return null;
  const planned = EditDeal.plan(s, input.data, { at: store.services.clock.now(), actor: s.user?.name ?? 'Unknown', firm: FIRM, opId: 'preview', ids: store.services.ids });
  if (!planned.ok || !planned.value.inverse) return null;
  // the inverse turns back on what this turns off, and off what it adds or turns on
  const back = planned.value.inverse.input as { itemsOff?: string[]; itemsOn?: string[] };
  return { off: back.itemsOn?.length ?? 0, on: back.itemsOff?.length ?? 0 };
}
