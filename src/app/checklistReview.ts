import { findList, key, listId, type FirmList, type Layer } from '../domain/checklist';
import { alphabetical } from '../domain/order';
import { sameContent } from '../domain/versions';
import type { Review } from './checklistImport';
import { usableFirm } from './commands/checklist';
import { versionsWord, type State } from './state';

/** 'The general list', or 'The Solar list' */
export const theList = (layer: Layer, name: string) => (layer === 'broad' ? 'The general list' : `The ${name} list`);

/** Which list the import brings in or replaces, as the person has chosen it so far. */
export interface ListTarget {
  id: string;
  layer: Layer;
  name: string;
  /** the general list needs no name; the others do, as deals will pick it */
  named: boolean;
  /** the list of that name the firm has now, if any */
  replaces: ReturnType<typeof findList>;
  revision: number | null;
  /** the list in two versions, when it is: it waits for a choice before it can be brought in */
  split: State['conflicts'][string] | undefined;
  splitSays: string;
  listNames: string[];
  hasGeneral: boolean;
  /** the general list's items, which another list's items are checked against for duplicates */
  generalTexts: string[];
  generalRevision: number;
}

export function listTarget(state: State, firm: FirmList, layer: Layer, name: string): ListTarget {
  const named = layer === 'broad' || !!key(name);
  const replaces = findList(firm, layer, name);
  const id = listId(layer, name);
  const revision = state.firmList[id]?.rev ?? null;
  // a list in two versions waits for a choice: said here, before its review is made, so no review is thrown away
  const split = named ? state.conflicts[id] : undefined;
  const versions = split ? versionsWord(split.versions.length).toLowerCase() : '';
  const splitSays = split ? `${theList(layer, replaces?.name ?? name)} has ${versions}` : '';
  const generalId = listId('broad', '');
  const general = state.firmList[generalId];
  const usable = state.conflicts[generalId] ? findList(usableFirm(state), 'broad', '') : general;
  const generalTexts = layer === 'broad' ? [] : (usable?.items ?? []).map((item) => item.text);
  const listNames = alphabetical(firm.lists.filter((list) => list.layer === layer).map((list) => list.name));
  return {
    id, layer, name, named, replaces, revision, split, splitSays, generalTexts, listNames,
    generalRevision: general?.rev ?? 0, hasGeneral: !!general,
  };
}

type Checks = { remove: Set<number>; useReword: Set<number> };

/** Duplicate checks refer to the General wording shown, even when that wording moves to another row (#41). */
function duplicateChoices(review: Review) {
  const byItem = new Map<number, Set<string>>();
  for (const { a, b, inAgainst } of review.pairs) {
    const other = inAgainst ? ['General', a, review.generalTexts[b]] : [Math.min(a, b), Math.max(a, b)];
    const pair = JSON.stringify(other);
    for (const item of inAgainst ? [a] : [a, b]) {
      const keys = byItem.get(item) ?? new Set<string>();
      keys.add(pair);
      byItem.set(item, keys);
    }
  }
  return byItem;
}

function keepRemovals(previous: Review, current: Review, checked: Set<number>) {
  const was = duplicateChoices(previous);
  const now = duplicateChoices(current);
  return new Set([...checked].filter((at) => {
    const prior = was.get(at);
    const matching = now.get(at);
    return prior && matching && [...prior].every((pair) => matching.has(pair));
  }));
}

function keepWording(previous: Review, current: Review, checked: Set<number>, defaults: Set<number>) {
  const old = new Map(previous.rewords.map((wording) => [wording.at, wording]));
  return new Set(current.rewords.filter(({ at, text, also }) => {
    const prior = old.get(at);
    return prior?.text === text && sameContent(prior.also, also) ? checked.has(at) : defaults.has(at);
  }).map(({ at }) => at));
}

/** Carry only choices still offered for the same rows after General changes (#56). */
export function keepChecklistReviewChoices(previous: Review | null, review: Review, checked: Set<number>, was: Checks) {
  if (!previous || previous.choicesKey !== review.choicesKey || !sameContent(previous.items, review.items)) {
    return { useReword: checked, remove: new Set<number>() };
  }
  return {
    useReword: keepWording(previous, review, was.useReword, checked),
    remove: keepRemovals(previous, review, was.remove),
  };
}
