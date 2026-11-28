import { findList, key, listId, type FirmList, type Layer } from '../domain/checklist';
import { alphabetical } from '../domain/order';
import { sameContent } from '../domain/versions';
import type { RemovalChoice, Review, WordingChoice } from './checklistImport';
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
  /** the list in two versions, when it is: it waits for a choice before it can be brought in */
  split: State['conflicts'][string] | undefined;
  splitSays: string;
  listNames: string[];
  hasGeneral: boolean;
  /** the general list's items, which another list's items are checked against for duplicates */
  generalTexts: string[];
}

export function listTarget(state: State, firm: FirmList, layer: Layer, name: string): ListTarget {
  const named = layer === 'broad' || !!key(name);
  const replaces = findList(firm, layer, name);
  const id = listId(layer, name);
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
    id, layer, name, named, replaces, split, splitSays, generalTexts, listNames, hasGeneral: !!general,
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
  const remembered = new Map<number, RemovalChoice>(previous.pendingRemovals?.map((choice) => [choice.at, choice]));
  for (const at of checked) {
    const pairs = was.get(at);
    if (pairs) remembered.set(at, { at, pairs: [...pairs] });
  }
  const incomplete = current.sameMissed || current.asked.same === 'unreachable' || current.asked.same === 'failed';
  const remove = new Set<number>();
  const pendingRemovals: RemovalChoice[] = [];
  for (const choice of remembered.values()) {
    const matching = now.get(choice.at);
    if (matching && choice.pairs.every((pair) => matching.has(pair))) remove.add(choice.at);
    else if (incomplete) pendingRemovals.push(choice);
  }
  return { remove, pendingRemovals };
}

function keepWording(previous: Review, current: Review, checked: Set<number>, defaults: Set<number>) {
  const remembered = new Map<number, WordingChoice>(previous.pendingWording?.map((choice) => [choice.at, choice]));
  for (const { at, text, also, earlier } of previous.rewords) {
    remembered.set(at, { at, text, also, earlier, checked: checked.has(at) });
  }
  const useReword = new Set<number>();
  for (const { at, text, also, earlier } of current.rewords) {
    const prior = remembered.get(at);
    // An identical offer can become a saved approval. A revoked approval loses its previous check (#56).
    const revoked = prior?.earlier && !earlier;
    const applies = prior?.text === text && sameContent(prior.also, also) && !revoked;
    if (applies ? prior.checked : defaults.has(at)) useReword.add(at);
    remembered.delete(at);
  }
  const failed = current.asked.reword === 'unreachable' || current.asked.reword === 'failed';
  const excluded = new Set(current.noReword);
  // A recalled approval that vanished was changed in the saved list, rather than missed by the model.
  const pendingWording = failed
    ? [...remembered.values()].filter(({ at, earlier }) => !earlier && !excluded.has(at))
    : [];
  return { useReword, pendingWording };
}

/** Carry choices only for the same reviewed rows, options and destination (#56). */
export function keepChecklistReviewChoices(previous: Review | null, review: Review, checked: Set<number>, was: Checks) {
  if (!previous || previous.choicesKey !== review.choicesKey || !sameContent(previous.items, review.items)) {
    return { review, useReword: checked, remove: new Set<number>() };
  }
  const { useReword, pendingWording } = keepWording(previous, review, was.useReword, checked);
  const { remove, pendingRemovals } = keepRemovals(previous, review, was.remove);
  return { review: { ...review, pendingWording, pendingRemovals }, useReword, remove };
}

/** A checked General removal still has its match when the exact reviewed wording remains in General (#56). */
export function reviewChanged(review: Review, target: ListTarget, remove: Set<number>) {
  if (review.destination !== target.id || !sameContent(review.destinationItems, target.replaces?.items ?? null)) {
    return true;
  }
  if (!remove.size) return false;
  const general = new Set(target.generalTexts);
  return review.pairs.some(({ a, b, inAgainst }) => inAgainst && remove.has(a) && !general.has(review.generalTexts[b]));
}
