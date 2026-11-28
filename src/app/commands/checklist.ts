/**
 * The firm's checklist and each deal's items (linking design, sections 4, 5 and 13).
 *
 * A deal's items are only ever added. Undo of adding them turns them off, and a person can turn any item off and on.
 * Adding items for one deal is one operation; bringing in a list of the firm's is one operation for every deal it adds to.
 * Items are added only to a deal whose records are loaded in this window: what it holds already has to be known, so that
 * an item it has is never written over (a turned-off item stays off).
 */
import { z } from 'zod';
import { define, type Plan, type PlanCtx, type Upsert } from '../command';
import { DealId } from '../../domain/model';
import { ok, fail, notFound, rejected, type Result } from '../../domain/result';
import { FirmLayerList, type FirmList, ListId, ListRecord, Item, ItemFrom, ItemId, LIST_NAME_MAX, LAYER_NAMES, firmOf, itemId, itemsFor, key, listId, dealLayers, type Layer } from '../../domain/checklist';
import { type State, conflictLabel, versionsWord } from '../state';
import { sameContent } from '../../domain/versions';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const Wanted = z.object({ text: z.string(), section: z.string().optional(), subsection: z.string().optional(), from: z.array(ItemFrom).min(1) });
type Wanted = z.infer<typeof Wanted>;

/**
 * The writes that add items to one deal: each wanted item the deal does not hold yet, as a new record filed under the deal.
 * An item it holds already is left exactly as it is, turned off or not.
 */
export function addItems(state: Pick<State, 'items'>, dealId: string, wanted: Wanted[], ctx: Pick<PlanCtx, 'at'>): { upserts: Upsert[]; ids: string[] } {
  const upserts: Upsert[] = []; const ids: string[] = []; const seen = new Set<string>();
  for (const w of wanted) {
    const text = w.text; if (!key(text)) continue;
    const id = itemId(dealId, text); if (seen.has(id) || state.items[id]) continue; seen.add(id);
    const rec = Item.parse({ id, dealId, rev: 0, createdAt: ctx.at, updatedAt: ctx.at, text, normV: 1, from: w.from, ...(w.section ? { section: w.section } : {}), ...(w.subsection ? { subsection: w.subsection } : {}), off: false });
    upserts.push({ kind: 'item', record: rec, expectedRev: null }); ids.push(id);
  }
  return { upserts, ids };
}

/** The writes that turn items off or on. An item already as asked is left alone; one this window does not hold is refused. */
export function setOff(state: Pick<State, 'items'>, ids: string[], off: boolean, ctx: Pick<PlanCtx, 'at'>, bySwap: ReadonlySet<string> = new Set()): Result<{ upserts: Upsert[]; changed: string[] }> {
  const upserts: Upsert[] = []; const changed: string[] = [];
  for (const id of ids) {
    const it = state.items[id]; if (!it) return fail(notFound('That checklist item is not here any more', id));
    if (it.off === off) continue;
    // `bySwap` names the items a swap turns off; any other change, off or on, is a person's, so the mark goes
    const { offBySwap: _was, ...rest } = it;
    const record = off && bySwap.has(id) ? { ...rest, off, offBySwap: true, updatedAt: ctx.at } : { ...rest, off, updatedAt: ctx.at };
    upserts.push({ kind: 'item', record, expectedRev: it.rev }); changed.push(id);
  }
  return ok({ upserts, changed });
}

const loaded = (state: State, dealId: string) => state.dealLoad[dealId] === 'loaded';

/** Items added to one deal: "Add them" (the firm's items the deal is missing), or those a new deal starts with. */
export const AddDealItems = define({
  name: 'AddDealItems',
  /** `fresh`: the deal was created on this PC a moment ago, so it holds no items yet and need not be loaded */
  input: z.object({ dealId: DealId, items: z.array(Wanted).min(1), fresh: z.boolean().optional() }),
  targets: (_s, i) => [i.dealId],
  plan(state, input, ctx) {
    if (!state.deals[input.dealId]) return fail(notFound('Deal not found', input.dealId));
    if (!input.fresh && !loaded(state, input.dealId)) return fail(rejected('This deal is still loading. Try again in a moment'));
    const { upserts, ids } = addItems(state, input.dealId, input.items, ctx);
    if (!ids.length) return fail(rejected('This deal has these items already'));
    return ok({
      dealId: input.dealId, upserts,
      index: { dealId: input.dealId, add: ids.map((id) => ({ kind: 'item' as const, id })) },
      audit: ids.map((id) => ({ kind: 'created' as const, recordId: id, dealId: input.dealId, text: (upserts.find((u) => u.record.id === id)!.record as Item).text })),
      // the items a new deal starts with are part of creating it, which has no Undo either
      ...(input.fresh ? {} : { inverse: { command: 'SetItemsOff', input: { dealId: input.dealId, off: ids } }, message: `${plural(ids.length, 'item')} added` }),
    });
  },
});

/** A person turns items off for a deal, or on again. This is also how adding items is undone: they are turned off. */
export const SetItemsOff = define({
  name: 'SetItemsOff',
  /** `offBySwap`: of `off`, the items a swap had turned off before (an Undo of Turn on), which keep that mark so swapping back turns them on */
  input: z.object({ dealId: DealId, off: z.array(ItemId).default([]), on: z.array(ItemId).default([]), offBySwap: z.array(ItemId).optional() }),
  targets: (_s, i) => [...i.off, ...i.on],
  plan(state, input, ctx) {
    const a = setOff(state, input.off, true, ctx, new Set(input.offBySwap ?? [])); if (!a.ok) return a;
    const b = setOff(state, input.on, false, ctx); if (!b.ok) return b;
    const upserts = [...a.value.upserts, ...b.value.upserts];
    if (!upserts.length) return ok({ dealId: input.dealId, upserts: [], audit: [] });
    const n = a.value.changed.length + b.value.changed.length;
    return ok({
      dealId: input.dealId, upserts,
      audit: [...a.value.changed.map((id) => ({ kind: 'edited' as const, recordId: id, dealId: input.dealId, field: 'off', from: false, to: true })), ...b.value.changed.map((id) => ({ kind: 'edited' as const, recordId: id, dealId: input.dealId, field: 'off', from: true, to: false }))],
      inverse: { command: 'SetItemsOff', input: { dealId: input.dealId, off: b.value.changed, on: a.value.changed, offBySwap: b.value.changed.filter((id) => state.items[id]?.offBySwap) } },
      message: !b.value.changed.length ? `${n === 1 ? 'Item' : plural(n, 'item')} turned off` : !a.value.changed.length ? `${n === 1 ? 'Item' : plural(n, 'item')} turned on again` : `${plural(n, 'item')} changed`,
    });
  },
});

/** an item's grouping: the section and subsection it is listed under, if any */
const Group = z.object({ id: ItemId, section: z.string().optional(), subsection: z.string().optional() });
type Group = z.infer<typeof Group>;

/**
 * The firm's lists as items can be added from them (linking design, section 4): a list in two versions gives only
 * the items every version holds, which stay whichever is chosen, and nothing while a version is deleted or unreadable.
 * Every other list is as it is.
 */
export function usableFirm(state: Pick<State, 'firmList' | 'conflicts'>, any = false): FirmList {
  return firmOf(Object.values(state.firmList).map((l) => {
    const c = state.conflicts[l.id]; if (!c) return l;
    const vs = c.versions.map((v) => v.data as ListRecord | null);
    // `any`: the items any version holds, for what a swap leaves behind, so an item only one version holds is not left on
    if (any) { const seen = new Set<string>(); return { ...l, items: vs.flatMap((v) => v?.items ?? []).filter((i) => !seen.has(key(i.text)) && !!seen.add(key(i.text))) }; }
    if (vs.some((v) => !v)) return { ...l, items: [] };
    const held = vs.slice(1).map((v) => new Set(v!.items.map((i) => key(i.text))));
    return { ...l, items: vs[0]!.items.filter((i) => held.every((h) => h.has(key(i.text)))) };
  }));
}

/**
 * The items a deal holds whose section or subsection is not the one the firm's list now gives them, with the grouping the
 * list gives: a deal that took a list before it had sections is grouped as the list
 * now is when the list is brought in again. A list in two versions regroups nothing until a person has chosen.
 */
export function regrouped(state: Pick<State, 'items' | 'firmList' | 'conflicts'>, deal: { id: string; product?: string; sector?: string; technology?: string }): Group[] {
  return itemsFor(firmOf(Object.values(state.firmList).filter((l) => !state.conflicts[l.id])), deal).flatMap((w) => {
    const it = state.items[itemId(deal.id, w.text)]; if (!it || (it.section ?? '') === (w.section ?? '') && (it.subsection ?? '') === (w.subsection ?? '')) return [];
    return [{ id: it.id, ...(w.section ? { section: w.section } : {}), ...(w.subsection ? { subsection: w.subsection } : {}) }];
  });
}

/** Group a deal's items under the sections and subsections given, with Undo putting the old grouping back. Nothing else of an item changes, turned off or not. */
export const RegroupDealItems = define({
  name: 'RegroupDealItems',
  input: z.object({ dealId: DealId, groups: z.array(Group).min(1) }),
  targets: (_s, i) => i.groups.map((g) => g.id),
  plan(state, input, ctx) {
    const upserts: Upsert[] = []; const was: Group[] = [];
    for (const g of input.groups) {
      const it = state.items[g.id]; if (!it) return fail(notFound('That checklist item is not here any more', g.id));
      const { section: _s, subsection: _ss, ...rest } = it;
      upserts.push({ kind: 'item', record: { ...rest, ...(g.section ? { section: g.section } : {}), ...(g.subsection ? { subsection: g.subsection } : {}), updatedAt: ctx.at }, expectedRev: it.rev });
      was.push({ id: it.id, ...(it.section ? { section: it.section } : {}), ...(it.subsection ? { subsection: it.subsection } : {}) });
    }
    return ok({ dealId: input.dealId, upserts, audit: [], inverse: { command: 'RegroupDealItems', input: { dealId: input.dealId, groups: was } }, message: `${plural(upserts.length, 'item')} grouped as the firm’s list` });
  },
});

/** The deals a list brought in is added to: every deal not marked Closed that uses it (linking design, section 4). */
export const dealsForBringIn = (state: Pick<State, 'deals'>, list: { layer: Layer; name: string }) => Object.values(state.deals)
  .filter((d) => d.group !== 'closed' && dealLayers(d).some((x) => x.layer === list.layer && key(x.value) === key(list.name)));

export const LIST_CHANGED_SINCE_REVIEW = 'The list changed. Go back and review it again.';

const generalListId = listId('broad', '');
const ListReviewRevisions = z.object({
  destination: z.number().int().nonnegative().nullable(),
  general: z.number().int().nonnegative().optional(),
});
export type ListReviewRevisions = z.infer<typeof ListReviewRevisions>;

function reviewedListChanged(state: State, current: ListRecord | undefined, reviewed?: ListReviewRevisions) {
  if (!reviewed) return false;
  if (reviewed.destination !== (current?.rev ?? null)) return true;
  return reviewed.general !== undefined && reviewed.general !== (state.firmList[generalListId]?.rev ?? 0);
}

function reviewedGeneral(rev: number | undefined): Plan['expects'] {
  return rev === undefined ? undefined : [{ kind: 'firmList', id: generalListId, rev }];
}

/**
 * Bring in one list of the firm's: the general list, or the list for one structure, sector or technology. It is a record
 * of its own (`listId`), so it replaces only the list of that layer and name. This writes the list only; the deals then
 * gain its items one deal at a time, each its own operation (see bringIn in ../checklistImport.ts), since a deal's records
 * are kept apart. Undo puts that list's previous version back, or removes a list that was new.
 */
export const BringInList = define({
  name: 'BringInList',
  input: z.object({
    list: FirmLayerList.omit({ by: true, at: true }),
    reviewed: ListReviewRevisions.optional(),
  }),
  targets: (_s, i) => [listId(i.list.layer, i.list.name)],
  plan(state, input, ctx) {
    const l = input.list; const name = l.layer === 'broad' ? '' : l.name;
    if (l.layer !== 'broad' && !key(name)) return fail(rejected(`Give the ${LAYER_NAMES[l.layer].one.toLowerCase()} list a name`));
    if (name.length > LIST_NAME_MAX) return fail(rejected(`Keep the name to ${LIST_NAME_MAX} characters`));
    const items = l.items.filter((it) => key(it.text));
    if (!items.length) return fail(rejected('This list has no items'));
    const id = listId(l.layer, name); const cur = state.firmList[id];
    // refused even when nothing would be written, so a list in two versions is never taken as brought in
    const split = state.conflicts[id]; if (split) return fail(rejected(`${conflictLabel(state, split)} has ${versionsWord(split.versions.length).toLowerCase()}. Choose one first`));
    if (reviewedListChanged(state, cur, input.reviewed)) return fail(rejected(LIST_CHANGED_SINCE_REVIEW));
    const record = ListRecord.parse({ ...l, name, items, by: ctx.actor, at: ctx.at, id, rev: cur?.rev ?? 0, createdAt: cur?.createdAt ?? ctx.at, updatedAt: ctx.at });
    // the same items from the same file write nothing: the deals are still given what they lack. Another file or date is kept, as one version still
    if (cur && sameContent(cur, record) && cur.file === record.file && cur.fileDate === record.fileDate && cur.name === record.name) return ok({ upserts: [], audit: [] });
    return ok({
      upserts: [{ kind: 'firmList', record, expectedRev: cur ? cur.rev : null }],
      expects: reviewedGeneral(input.reviewed?.general),
      audit: [],
      inverse: { command: 'RestoreList', input: { id, list: cur ?? null } },
      message: `${l.layer === 'broad' ? 'The general list' : `The ${name} list`} imported`,
    });
  },
});

/** The undo of a bring-in: one list as it was, or gone when it was new. */
export const RestoreList = define({
  name: 'RestoreList',
  input: z.object({ id: ListId, list: ListRecord.nullable() }),
  targets: (_s, i) => [i.id],
  plan(state, input, ctx) {
    const cur = state.firmList[input.id];
    if (!cur && !input.list) return ok({ upserts: [], audit: [] });
    const said = 'The firm’s checklist is as it was';
    if (!input.list) return ok({ upserts: [], removes: [{ kind: 'firmList', id: cur!.id, rev: cur!.rev }], audit: [], inverse: { command: 'RestoreList', input: { id: input.id, list: cur } }, message: said });
    const record = ListRecord.parse({ ...input.list, rev: cur?.rev ?? 0, updatedAt: ctx.at });
    return ok({ upserts: [{ kind: 'firmList', record, expectedRev: cur ? cur.rev : null }], audit: [], inverse: { command: 'RestoreList', input: { id: input.id, list: cur ?? null } }, message: said });
  },
});

/**
 * The firm's items a deal should hold and does not, for "Add them", creating a deal, or a bring-in. From a list in two
 * versions, only the items every version holds (linking design, section 4).
 */
export function missingItems(state: Pick<State, 'items' | 'firmList' | 'conflicts'>, deal: { id: string; product?: string; sector?: string; technology?: string }): Wanted[] {
  return itemsFor(usableFirm(state), deal).filter((w) => !state.items[itemId(deal.id, w.text)]);
}

/**
 * The deal's items whose wording is not in the firm's current lists for its layers, which the Checklist marks with an
 * icon, for information only (linking design, section 5, Other). A list in two versions counts every version's items,
 * so nothing is marked while a person has yet to choose. With no list of the firm's at hand, nothing is marked.
 */
export function unlistedItems(state: Pick<State, 'items' | 'firmList' | 'conflicts'>, deal: { id: string; product?: string; sector?: string; technology?: string }): Set<string> {
  if (!Object.keys(state.firmList).length) return new Set();
  const listed = new Set(itemsFor(usableFirm(state, true), deal).map((w) => key(w.text)));
  return new Set(Object.values(state.items).filter((it) => it.dealId === deal.id && !listed.has(key(it.text))).map((it) => it.id));
}

/**
 * What "Add them" would add on opening a deal's Checklist (section 5, "On opening a deal"): the firm's items the deal is
 * missing. Not offered on a deal marked Closed, one whose items are not loaded in this window, or one in two versions.
 */
export function offeredItems(state: Pick<State, 'deals' | 'items' | 'firmList' | 'conflicts' | 'dealLoad'>, dealId: string): Wanted[] {
  const d = state.deals[dealId];
  if (!d || d.group === 'closed' || state.dealLoad[dealId] !== 'loaded' || state.conflicts[dealId]) return [];
  // only when this PC's copy of each list the deal's items came from is at least as new as the version that added them,
  // so a PC that is behind never offers wordings the firm has dropped. A list this PC does not hold offers nothing anyway.
  for (const it of Object.values(state.items)) {
    if (it.dealId !== dealId) continue;
    for (const f of it.from) {
      if (f.rev === undefined || f.layer === 'deal') continue;
      const here = state.firmList[listId(f.layer, f.value)];
      if (here && here.rev < f.rev) return [];
    }
  }
  return missingItems(state, d);
}
