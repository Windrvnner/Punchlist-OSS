/**
 * The review of a checklist being brought in (firmChecklist.tsx): the rewordings the model suggests and the duplicates
 * found, worked out from the model's replies. Nothing here touches the screen or the model.
 */
import type { AiService } from '../ports';
import type { State } from '../app/state';
import { versionsWord } from '../app/state';
import type { BringInResult } from '../app/checklistImport';
import { sameWording, earlierRewordings } from '../domain/checklistImport';
import { findList, key, listId, type FirmList, type Layer, type ListItem } from '../domain/checklist';
import { SERVICE } from '../control';

export const plural = (count: number, word: string) =>
  `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;

/**
 * what became of asking the model: not asked, done, or failed because it could not be reached or its reply could not
 * be used
 */
export type Asked = 'off' | 'done' | 'unreachable' | 'failed';
export const failedAs = (reply: { ok: boolean; error?: { kind: string } } | null): Asked =>
  reply && !reply.ok && reply.error?.kind === 'unreachable' ? 'unreachable' : 'failed';
export const NOT_DONE: Record<string, string> = {
  unreachable: `${SERVICE} could not be reached`,
  failed: `${SERVICE}’s reply could not be used`,
};

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
export interface Review {
  items: ListItem[];
  rewords: Rewording[];
  pairs: Pair[];
  asked: { reword: Asked; same: Asked };
  sameMissed?: { kind: 'unreachable' | 'failed'; at: number[] };
  /** rows offered no rewording: a later copy of the same wording, or one worded as in the general list */
  noReword?: number[];
}

export const pairKey = (pair: { a: number; b: number; inAgainst: boolean }) => `${pair.a}:${pair.b}:${pair.inAgainst}`;
const byRow = (one: { at: number }, other: { at: number }) => one.at - other.at;

/** `set` with `at` added, or taken out if it was in */
export function toggled(set: Set<number>, at: number): Set<number> {
  const next = new Set(set);
  if (next.has(at)) next.delete(at);
  else next.add(at);
  return next;
}

/** 'The general list', or 'The Solar list' */
export const theList = (layer: Layer, name: string) => (layer === 'broad' ? 'The general list' : `The ${name} list`);

/** Which list the import brings in or replaces, as the person has chosen it so far. */
export interface ListTarget {
  layer: Layer;
  name: string;
  /** the general list needs no name; the others do, as deals will pick it */
  named: boolean;
  /** the list of that name the firm has now, if any */
  replaces: ReturnType<typeof findList>;
  /** the list in two versions, when it is: it waits for a choice before it can be brought in */
  split: State['conflicts'][string] | undefined;
  splitSays: string;
  /** the general list's items, which another list's items are checked against for duplicates */
  generalTexts: string[];
}

export function listTarget(state: State, firm: FirmList, layer: Layer, name: string): ListTarget {
  const named = layer === 'broad' || !!key(name);
  const replaces = findList(firm, layer, name);
  // a list in two versions waits for a choice: said here, before its review is made, so no review is thrown away
  const split = named ? state.conflicts[listId(layer, layer === 'broad' ? '' : name)] : undefined;
  const versions = split ? versionsWord(split.versions.length).toLowerCase() : '';
  const splitSays = split ? `${theList(layer, replaces?.name ?? name)} has ${versions}` : '';
  const general = layer === 'broad' ? [] : (findList(firm, 'broad', '')?.items ?? []);
  return { layer, name, named, replaces, split, splitSays, generalTexts: general.map((item) => item.text) };
}

/** What the review was asked about: a review asked for other choices is not shown again. */
export const askedAbout = (texts: string[], askReword: boolean, askSame: boolean, generalTexts: string[]) =>
  JSON.stringify([texts, askReword, askSame, generalTexts]);

/** What a new review is made from: the items, the person's choices, and the model's replies (null when not asked). */
export interface ReviewInput {
  items: ListItem[];
  /** the items of the list this one replaces, which hold the rewordings taken last time */
  earlierItems: ListItem[] | undefined;
  generalTexts: string[];
  askReword: boolean;
  askSame: boolean;
  canReword: boolean;
  canAskSame: boolean;
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

function rewordAsked({ askReword, canReword, rewordReply }: ReviewInput): Asked {
  if (!askReword || !canReword) return 'off';
  return rewordReply?.ok ? 'done' : failedAs(rewordReply);
}

function sameAsked({ askSame, canAskSame, sameReply }: ReviewInput): Asked {
  if (!askSame) return 'off';
  return !canAskSame || sameReply?.ok ? 'done' : failedAs(sameReply);
}

/**
 * Step 2's review: what the model proposes, and the items worded the same, which need no model. A model that could not
 * be asked leaves its part out and says so. `checked` holds the rewordings taken last time, which start checked.
 */
export function makeReview(input: ReviewInput): { review: Review; checked: Set<number> } {
  const { items, rewordReply, sameReply } = input;
  const worded = input.askSame
    ? pairsWordedTheSame(items, input.generalTexts)
    : { later: new Set<number>(), same: [], inGeneral: [] };
  const found = new Set([...worded.same, ...worded.inGeneral].map(pairKey));
  const inGeneralAt = new Set(worded.inGeneral.map((pair) => pair.a));
  const model = sameReply?.ok ? sameReply.value.pairs.filter((pair) => !found.has(pairKey(pair))) : [];
  const offered = (at: number) => !worded.later.has(at) && !inGeneralAt.has(at);
  // a rewording taken last time comes back checked, in place of anything the model suggests for that row
  const earlier = earlierRewordings(items, input.earlierItems)
    .filter((rewording) => offered(rewording.at))
    .map((rewording) => ({ ...rewording, why: '', earlier: true }));
  const checked = new Set(earlier.map((rewording) => rewording.at));
  const suggested = rewordReply?.ok
    ? rewordReply.value.filter((rewording) => offered(rewording.at) && !checked.has(rewording.at))
    : [];
  const review: Review = {
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
export function withMissedPairs(was: Review, again: SameMeaning): Review {
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
export function withRewordings(was: Review, suggested: Rewording[]): Review {
  const skip = new Set([...(was.noReword ?? []), ...was.rewords.map((rewording) => rewording.at)]);
  const added = suggested.filter((rewording) => !skip.has(rewording.at));
  return { ...was, asked: { ...was.asked, reword: 'done' }, rewords: [...was.rewords, ...added].sort(byRow) };
}

/**
 * The items as they will be brought in. A reworded item keeps the file's own wording as `was`, so that bringing the
 * same file in again offers the rewording checked; an item split in two becomes its items in order, each keeping
 * the file's wording as `was`.
 */
export function itemsToBringIn(
  review: Review, remove: Set<number>, useReword: Set<number>, rewordAt: Map<number, string[]>,
): ListItem[] {
  return review.items.flatMap((item, at) => {
    if (remove.has(at)) return [];
    if (!useReword.has(at)) return [item];
    return rewordAt.get(at)!.map((text) => ({ ...item, text, was: item.text }));
  });
}

/** The toast once a list is in: how many items went to how many deals, and the deals it could not reach. */
export function broughtInSays(layer: Layer, name: string, result: BringInResult): string {
  const parts = [`${theList(layer, name)} imported`];
  if (result.items) parts.push(`${plural(result.items, 'item')} added to ${plural(result.deals, 'deal')}`);
  if (result.missed.length) parts.push(`not added to ${result.missed.map((missed) => missed.deal).join(', ')}`);
  return parts.join(' · ');
}
