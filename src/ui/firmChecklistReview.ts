import { theList, type BringInResult } from '../app/checklistImport';
import type { Layer } from '../domain/checklist';
import { SERVICE } from '../control';
import { plural } from './counts';

export const NOT_DONE: Record<string, string> = {
  unreachable: `${SERVICE} could not be reached`,
  failed: `${SERVICE}’s reply could not be used`,
};

/** `set` with `at` added, or taken out if it was in */
export function toggled(set: Set<number>, at: number): Set<number> {
  const next = new Set(set);
  if (next.has(at)) next.delete(at);
  else next.add(at);
  return next;
}

/** The toast once a list is in: how many items went to how many deals, and the deals it could not reach. */
export function broughtInSays(layer: Layer, name: string, result: BringInResult): string {
  const parts = [`${theList(layer, name)} imported`];
  if (result.items) parts.push(`${plural(result.items, 'item')} added to ${plural(result.deals, 'deal')}`);
  if (result.missed.length) parts.push(`not added to ${result.missed.map((missed) => missed.deal).join(', ')}`);
  return parts.join(' · ');
}
