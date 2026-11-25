import { bareDealName } from './commands/deals';
import { dealNameKey, dealTwinLabels, type State } from './state';

export interface TwinFocus { start: number; end: number }

// #492: reserve the difference from the closest label that shares a long beginning.
// Keep the word before it for context ("Fund IV"), dropping shared legal-form words first.
export function distinguishingWords(label: string, others: string[]): TwinFocus | undefined {
  label = label.replace(/\s+/g, ' ');
  const words = [...label.matchAll(/\S+/g)];
  const keys = words.map(([word]) => word.toLocaleLowerCase('en-US'));
  let bestPrefix = 0;
  let bestSuffix = 0;
  for (const other of others) {
    if (other === label) continue;
    const parts = other.toLocaleLowerCase('en-US').match(/\S+/g) ?? [];
    const end = Math.min(parts.length, keys.length);
    let prefix = 0;
    while (prefix < end && keys[prefix] === parts[prefix]) prefix++;
    if (prefix < 2 || prefix < bestPrefix) continue;
    let suffix = 0;
    while (suffix < end - prefix && keys.at(-suffix - 1) === parts.at(-suffix - 1)) suffix++;
    if (prefix === bestPrefix && suffix <= bestSuffix) continue;
    bestPrefix = prefix;
    bestSuffix = suffix;
  }
  if (!bestPrefix) return;
  const start = words[bestPrefix - 1].index;
  const end = bestSuffix ? words[words.length - bestSuffix].index : label.length;
  return { start, end: start + label.slice(start, end).trimEnd().length };
}

export type FolderDealPlace = { dealId: string; folder: string };

export const folderDealIds = (folders: FolderDealPlace[]) => [...new Set(folders.map(({ dealId }) => dealId))];

/** Choose a distinct label for each deal shown anywhere in Locate (#628). */
export function folderDealLabels(state: Pick<State, 'deals'>, folders: FolderDealPlace[]) {
  const twinOf = dealTwinLabels(Object.values(state.deals));
  const counts = new Map<string, number>();
  const names = folderDealIds(folders).map((id) => {
    const deal = state.deals[id];
    const name = deal?.name ?? id;
    const short = bareDealName(name);
    const key = dealNameKey(short);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const twin = deal && twinOf(deal);
    const full = twin ? `${name} (${twin})` : name;
    return { id, full, short, key };
  });
  const fullKeys = new Set(names.map(({ full }) => dealNameKey(full)));
  const used = new Set<string>();
  return new Map(names.map(({ id, full, short, key }) => {
    const canShorten = counts.get(key) === 1 && (key === dealNameKey(full) || !fullKeys.has(key));
    return [id, uniqueFolderDealLabel(canShorten ? short : full, used, fullKeys)];
  }));
}

/** Even a counterparty and date can be shared, or be part of another deal's name. */
function uniqueFolderDealLabel(label: string, used: Set<string>, full: Set<string>) {
  let text = label;
  if (used.has(dealNameKey(text))) {
    let number = 2;
    do {
      text = `${label} (${number++})`;
    } while (used.has(dealNameKey(text)) || full.has(dealNameKey(text)));
  }
  used.add(dealNameKey(text));
  return text;
}
