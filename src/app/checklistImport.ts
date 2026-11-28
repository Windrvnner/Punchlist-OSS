/**
 * Bringing in one of the firm's checklists, and undoing it (linking design, section 13: a batch).
 *
 * The list itself is one operation; each deal it adds items to is one more, since each deal's records are kept apart.
 * "Undo all" undoes each of them that has not changed since, and names the deals where something had.
 */
import type { Store } from './store';
import {
  BringInList, AddDealItems, RegroupDealItems, SetItemsOff, dealsForBringIn, missingItems, regrouped, usableFirm,
  type ListReviewRevisions,
} from './commands/checklist';
import {
  firmOf, itemId, itemsFor, key, LAYERS, listId, type FirmLayerList, type Layer, type ListItem,
} from '../domain/checklist';
import { sameWording, earlierRewordings } from '../domain/checklistImport';
import type { AiService } from '../ports';
import type { Capabilities } from './capabilities';
import { dropImport, keptImport } from './keptImports';
import type { checklistRequests } from './listRead';
import { ok, fail, type Result } from '../domain/result';
import { Undo } from './commands/undo';
import { EditDeal } from './commands/deals';
import type { ListTarget } from './checklistReview';
import { FIRM, type State } from './state';

export { listTarget, theList, type ListTarget } from './checklistReview';

export interface BringInResult { opIds: string[]; items: number; deals: number; /** deals the items could not be added to, by name, and why */ missed: { deal: string; why: string }[] }

type ListForImport = Pick<FirmLayerList, 'layer' | 'name' | 'items' | 'file' | 'fileDate'>;
export async function bringIn(store: Store, list: ListForImport, reviewed?: ListReviewRevisions) {
  const id = listId(list.layer, list.name);
  const input = { list, reviewed };
  const r = await store.dispatch(BringInList, input, { quiet: true, idempotencyKey: 'bring-in-list' });
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

/**
 * what became of asking the model: not asked, done, or failed because it could not be reached or its reply could not
 * be used
 */
export type Asked = 'off' | 'done' | 'unreachable' | 'failed';
export const failedAs = (reply: { ok: boolean; error?: { kind: string } } | null): 'unreachable' | 'failed' =>
  reply && !reply.ok && reply.error?.kind === 'unreachable' ? 'unreachable' : 'failed';
type RewordReply = Awaited<ReturnType<NonNullable<AiService['reword']>>>;
type SameMeaningReply = Awaited<ReturnType<NonNullable<AiService['sameMeaning']>>>;
type SameMeaning = Extract<SameMeaningReply, { ok: true }>['value'];

/** two items that ask for the same thing; `inAgainst` means `b` is an item of the general list, not of this one */
export interface Pair { a: number; b: number; inAgainst: boolean; why: string }
/** `earlier` marks a rewording a person took when this list was last brought in: it starts checked */
export interface Rewording {
  at: number;
  text: string;
  why: string;
  earlier?: boolean;
  /** the further items an item split into */
  also?: string[];
}
export type WordingChoice = Pick<Rewording, 'at' | 'text' | 'also'> & { checked: boolean };

export interface Review {
  choicesKey: string;
  destination: string;
  destinationItems: ListItem[] | null;
  generalTexts: string[];
  items: ListItem[];
  rewords: Rewording[];
  /** Choices for suggestions absent after a failed wording request, until the service returns them again. */
  pendingWording?: WordingChoice[];
  pairs: Pair[];
  asked: { reword: Asked; same: Asked };
  sameMissed?: { kind: 'unreachable' | 'failed'; at: number[] };
  /** rows offered no rewording: a later copy of the same wording, or one worded as in the general list */
  noReword?: number[];
}

export const pairKey = (pair: { a: number; b: number; inAgainst: boolean }) => `${pair.a}:${pair.b}:${pair.inAgainst}`;
const byRow = (one: { at: number }, other: { at: number }) => one.at - other.at;

/** What a new review is made from: the items, the person's choices, and the model's replies (null when not asked). */
interface ReviewInput {
  items: ListItem[];
  target: ListTarget;
  choicesKey: string;
  earlier: ReturnType<typeof earlierRewordings>;
  askReword: boolean;
  askSame: boolean;
  can: Pick<Capabilities, 'reword' | 'sameMeaning'>;
  rewordReply: RewordReply | null;
  sameReply: SameMeaningReply | null;
}

// Each look-up below goes through a Set or Map, so a list of 2,000 items and thousands of pairs takes no time
function pairsWordedTheSame(items: ListItem[], generalTexts: string[]) {
  const groups = sameWording(items);
  // a later copy of the same wording is offered for removal, so it is not offered a rewording as well
  const later = new Set(groups.flatMap((group) => group.slice(1)));
  const same: Pair[] = groups.flatMap((group) =>
    group.slice(1).map((b) => ({ a: group[0], b, inAgainst: false, why: 'Worded the same' })));
  const generalAt = new Map<string, number>();
  generalTexts.forEach((text, b) => {
    if (!generalAt.has(key(text))) generalAt.set(key(text), b);
  });
  const inGeneral: Pair[] = items.flatMap((item, a) => {
    const b = generalAt.get(key(item.text));
    return b === undefined ? [] : [{ a, b, inAgainst: true, why: 'Worded the same as in the general list' }];
  });
  return { later, same, inGeneral };
}

function rewordAsked({ askReword, can, rewordReply }: ReviewInput): Asked {
  if (!askReword || !can.reword) return 'off';
  return rewordReply?.ok ? 'done' : failedAs(rewordReply);
}

function sameAsked({ askSame, can, sameReply }: ReviewInput): Asked {
  if (!askSame) return 'off';
  return !can.sameMeaning || sameReply?.ok ? 'done' : failedAs(sameReply);
}

/**
 * Step 2's review: what the model proposes, and the items worded the same, which need no model. A model that could not
 * be asked leaves its part out and says so. `checked` holds the rewordings taken last time, which start checked.
 */
function makeReview(input: ReviewInput): { review: Review; checked: Set<number> } {
  const { items, rewordReply, sameReply, target } = input;
  const worded = input.askSame
    ? pairsWordedTheSame(items, target.generalTexts)
    : { later: new Set<number>(), same: [], inGeneral: [] };
  const found = new Set([...worded.same, ...worded.inGeneral].map(pairKey));
  const inGeneralAt = new Set(worded.inGeneral.map((pair) => pair.a));
  const model = sameReply?.ok ? sameReply.value.pairs.filter((pair) => !found.has(pairKey(pair))) : [];
  const offered = (at: number) => !worded.later.has(at) && !inGeneralAt.has(at);
  // a rewording taken last time comes back checked, in place of anything the model suggests for that row
  const earlier = input.earlier
    .filter((rewording) => offered(rewording.at))
    .map((rewording) => ({ ...rewording, why: '', earlier: true }));
  const checked = new Set(earlier.map((rewording) => rewording.at));
  const suggested = rewordReply?.ok
    ? rewordReply.value.filter((rewording) => offered(rewording.at) && !checked.has(rewording.at))
    : [];
  const review: Review = {
    choicesKey: input.choicesKey, destination: target.id,
    destinationItems: target.replaces?.items ?? null, generalTexts: target.generalTexts,
    items,
    rewords: [...earlier, ...suggested].sort(byRow),
    pairs: [...worded.same, ...worded.inGeneral, ...model],
    noReword: items.flatMap((_, at) => (offered(at) ? [] : [at])),
    asked: { reword: rewordAsked(input), same: sameAsked(input) },
    ...(sameReply?.ok && sameReply.value.missed ? { sameMissed: sameReply.value.missed } : {}),
  };
  return { review, checked };
}

/** The review with what the duplicate check found when asked again about the items it missed. */
function withMissedPairs(was: Review, again: SameMeaning): Review {
  const have = new Set(was.pairs.map(pairKey));
  const { sameMissed: _, ...rest } = was;
  return {
    ...rest,
    asked: { ...was.asked, same: 'done' },
    pairs: [...was.pairs, ...again.pairs.filter((pair) => !have.has(pairKey(pair)))],
    ...(again.missed ? { sameMissed: again.missed } : {}),
  };
}

/** The review with the wording suggestions asked for again, added beside any taken last time. */
function withRewordings(was: Review, suggested: Rewording[]): Review {
  const skip = new Set([...(was.noReword ?? []), ...was.rewords.map((rewording) => rewording.at)]);
  const added = suggested.filter((rewording) => !skip.has(rewording.at));
  return { ...was, asked: { ...was.asked, reword: 'done' }, rewords: [...was.rewords, ...added].sort(byRow) };
}

/**
 * The items as they will be brought in. A reworded item keeps the file's own wording as `was`, so that bringing the
 * same file in again offers the rewording checked; an item split in two becomes its items in order, each keeping
 * the file's wording as `was`.
 */
function itemsToBringIn(
  review: Review, remove: Set<number>, useReword: Set<number>, rewordAt: Map<number, string[]>,
): ListItem[] {
  return review.items.flatMap((item, at) => {
    if (remove.has(at)) return [];
    if (!useReword.has(at)) return [item];
    return rewordAt.get(at)!.map((text) => ({ ...item, text, was: item.text }));
  });
}

type ReviewOptions = Pick<ReviewInput, 'askReword' | 'askSame'>;

function checklistReviewPlan(
  can: Pick<Capabilities, 'reword' | 'sameMeaning'>, items: ListItem[], target: ListTarget, choices: ReviewOptions,
  review: Review | null, askedFor: string,
) {
  const texts = items.map((item) => item.text);
  const earlier = earlierRewordings(items, target.replaces?.items);
  // Reuse a review only for the same items and sections (#821) and the same list and applicable wording (#56).
  const { askReword, askSame } = choices;
  const choicesKey = JSON.stringify([askReword, askSame, target.id]);
  const signature = JSON.stringify([items, target.generalTexts, choicesKey, earlier]);
  const cached = review && askedFor === signature ? review : null;
  const needsCall = cached ? can.sameMeaning && hasMissedDuplicates(cached)
    : (askReword && can.reword) || (askSame && can.sameMeaning);
  return { can, items, target, options: choices, texts, earlier, choicesKey, signature, cached, needsCall };
}

function hasMissedDuplicates(review: Review) {
  return !!review.sameMissed || review.asked.same === 'unreachable' || review.asked.same === 'failed';
}

/** The wording and duplicate requests run concurrently, and only for choices the model offers. */
async function requestChecklistReview(store: Store, texts: string[], options: ReviewOptions, generalTexts: string[]) {
  const { can } = store.get();
  const { ai } = store.services;
  const reword = async () => options.askReword && can.reword ? ai.reword!({ items: texts }) : null;
  const compare = async () => options.askSame && can.sameMeaning
    ? ai.sameMeaning!({ items: texts, against: generalTexts })
    : null;
  const calls = [reword(), compare()] as const;
  try {
    return await Promise.all(calls);
  } catch (error) {
    // A thrown request does not release the review while its parallel request is still in flight.
    await Promise.allSettled(calls);
    throw error;
  }
}

/** Retries ask for the missed rows only, or all rows after a failed full request. */
async function retryChecklistDuplicates(
  store: Store, review: Review, generalTexts: string[], items = review.items.map((item) => item.text),
) {
  const only = review.sameMissed?.at ?? items.map((_, at) => at);
  const reply = await store.services.ai.sameMeaning!({ items, against: generalTexts, only });
  if (reply.ok) return { review: withMissedPairs(review, reply.value), failure: reply.value.missed?.kind ?? null };
  const reason = failedAs(reply);
  if (!review.sameMissed) {
    return { review: { ...review, asked: { ...review.asked, same: reason } }, failure: reason };
  }
  return { review: { ...review, sameMissed: { ...review.sameMissed, kind: reason } }, failure: reason };
}

async function retryChecklistWording(store: Store, review: Review) {
  const items = review.items.map((item) => item.text);
  const reply = await store.services.ai.reword!({ items });
  if (reply.ok) return { review: withRewordings(review, reply.value), failure: null };
  const reason = failedAs(reply);
  return { review: { ...review, asked: { ...review.asked, reword: reason } }, failure: reason };
}

type ReviewPlan = ReturnType<typeof checklistReviewPlan>;
type ReviewFailure = 'unreachable' | 'failed';

export type ChecklistReviewChange =
  | { kind: 'open'; review: Review }
  | { kind: 'fresh'; review: Review; checked: Set<number>; signature: string }
  | { kind: 'retry'; review: Review; failure: ReviewFailure | null; open: boolean; wording?: true };

type ShowReview = (change: ChecklistReviewChange) => void;
type ChecklistRequests = ReturnType<typeof checklistRequests>;
interface ReviewRequestEvents {
  started(): void;
  settled(isCurrent: boolean): void;
}

/** All model review requests share one flight until the reply settles, even after Back (#378). */
function checklistReviewFlight(requests: ChecklistRequests, events: ReviewRequestEvents) {
  let pending = false;
  async function ask<T>(call: () => Promise<T>, apply: (reply: T) => void) {
    if (pending) return;
    pending = true;
    const ticket = requests.newToken();
    let reply: T;
    try {
      events.started();
      reply = await call();
    } finally {
      pending = false;
      events.settled(requests.isLatest(ticket));
    }
    if (requests.isLatest(ticket)) apply(reply);
  }
  return { ask, get pending() { return pending; } };
}

/** The current review, including retries and the local review that can open while an older model reply is pending. */
export function checklistReviewSession(store: Store, requests: ChecklistRequests, events: ReviewRequestEvents) {
  const flight = checklistReviewFlight(requests, events);
  let signature = '';
  let currentTexts: string[] = [];
  function plan(
    items: ListItem[] | null, target: ListTarget, options: ReviewOptions, review: Review | null, askedFor: string,
  ) {
    const next = items && checklistReviewPlan(store.get().can, items, target, options, review, askedFor);
    signature = next?.signature ?? '';
    currentTexts = next?.texts ?? [];
    return next && { ...next, waiting: !!next.texts.length && next.needsCall && flight.pending };
  }
  async function askModel<T>(call: () => Promise<T>, show: (reply: T) => void) {
    const askedFor = signature;
    await flight.ask(call, (reply) => {
      if (signature === askedFor) show(reply);
    });
  }
  function duplicates(review: Review, generalTexts: string[], show: ShowReview, open = false, texts?: string[]) {
    if (!store.get().can.sameMeaning || requests.tableReadPending()) return;
    return askModel(() => retryChecklistDuplicates(store, review, generalTexts, texts), (next) => {
      show({ kind: 'retry', ...next, open });
    });
  }
  function wording(review: Review, show: ShowReview) {
    if (!store.get().can.reword || requests.tableReadPending()) return;
    const requested = currentTexts;
    return flight.ask(() => retryChecklistWording(store, review), (next) => {
      // Wording uses the imported items. General's items are only inputs to duplicate matching.
      const changed = requested.length !== currentTexts.length
        || requested.some((text, index) => text !== currentTexts[index]);
      if (!changed) show({ kind: 'retry', ...next, open: false, wording: true });
    });
  }
  function next(plan: ReviewPlan, show: ShowReview) {
    const { target, options, texts, cached, needsCall, can, items, earlier, choicesKey } = plan;
    // the items are those of the worksheet being read until that read ends (#821)
    if (requests.tableReadPending()) return;
    if (!texts.length || !target.named || signature !== plan.signature) return;
    if (cached) {
      const review = { ...cached, destinationItems: target.replaces?.items ?? null };
      if (!needsCall) return show({ kind: 'open', review });
      return duplicates(review, target.generalTexts, show, true, texts);
    }
    const fresh = ([rewordReply, sameReply]: readonly [RewordReply | null, SameMeaningReply | null] = [null, null]) => {
      const result = makeReview({ items, earlier, target, choicesKey, ...options, can, rewordReply, sameReply });
      show({ kind: 'fresh', ...result, signature: plan.signature });
    };
    if (!needsCall) return fresh();
    return askModel(() => requestChecklistReview(store, texts, options, target.generalTexts), fresh);
  }
  return { plan, next, duplicates, wording };
}

export function checklistReviewCounts(review: Review) {
  return {
    suggestions: review.rewords.length,
    duplicates: review.pairs.length,
    missed: review.sameMissed?.at.length ?? 0,
  };
}

export function checklistSelection(review: Review | null, remove: Set<number>, useReword: Set<number>) {
  const rewordAt = new Map((review?.rewords ?? []).map(({ at, text, also }) => [at, [text, ...(also ?? [])]]));
  const items = review ? itemsToBringIn(review, remove, useReword, rewordAt) : [];
  const taken = [...useReword].filter((at) => !remove.has(at));
  const split = taken.filter((at) => (rewordAt.get(at)?.length ?? 1) > 1).length;
  return { items, counts: { items: items.length, reworded: taken.length - split, split, removed: remove.size } };
}

export function checklistWordingChoices(
  review: Review, remove: Set<number>, useReword: Set<number>, importing: boolean,
) {
  // A removed item's wording, and every wording while the list is brought in, cannot be changed.
  const locked = (at: number) => importing || remove.has(at);
  const eligible = review.rewords.map(({ at }) => at).filter((at) => !locked(at));
  return { eligible, locked, allChecked: eligible.length > 0 && eligible.every((at) => useReword.has(at)) };
}

export function checklistTotals(lists: FirmLayerList[]) {
  const general = lists.some((list) => list.layer === 'broad');
  const items = lists.reduce((sum, list) => sum + list.items.length, 0);
  return { lists: lists.length, items, general, others: lists.length - (general ? 1 : 0) };
}

export function checklistShelf(state: State) {
  const { lists } = firmOf(state.firmList);
  const sections = LAYERS.map((layer) => {
    const rows = lists.filter((list) => list.layer === layer).map((list) => {
      const clash = state.conflicts[listId(list.layer, list.name)];
      return { list, items: list.items.length, clash, versions: clash?.versions.length ?? 0 };
    });
    return { layer, rows, count: rows.length };
  });
  return { sections, totals: checklistTotals(lists) };
}

export async function submitChecklist(
  store: Store, importKey: string, target: ListTarget, items: ListItem[], file: string,
  reviewed?: ListReviewRevisions,
) {
  const kept = keptImport(importKey);
  const name = target.layer === 'broad' ? '' : target.name;
  // The draft stays kept until the list is written, so a reload or a failure mid-write loses nothing (#931).
  // Kept after a write, it is offered again; bringing in the same list again writes nothing.
  const result = await bringIn(store, { layer: target.layer, name, items, file, fileDate: '' }, reviewed);
  if (result.ok && kept && keptUnchanged(kept, keptImport(importKey))) dropImport(importKey);
  return result;
}

/** Whether the kept draft is as it was: one written while the list was brought in is newer, and stays (#931). */
function keptUnchanged(before: Readonly<Record<string, unknown>>, now: Readonly<Record<string, unknown>> | undefined) {
  if (!now) return false;
  const parts = Object.keys(before);
  const same = (part: string) => part in now && Object.is(before[part], now[part]);
  return parts.length === Object.keys(now).length && parts.every(same);
}
