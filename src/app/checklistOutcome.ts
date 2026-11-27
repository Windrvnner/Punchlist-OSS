import { theList, undoBringIn, type BringInResult } from './checklistImport';
import type { Store } from './store';
import type { Layer } from '../domain/checklist';
import { SERVICE } from '../control';
import { plural } from '../domain/counts';

export const NOT_DONE: Record<string, string> = {
  unreachable: `${SERVICE} could not be reached`,
  failed: `${SERVICE}’s reply could not be used`,
};

/** The toast once a list is in: how many items went to how many deals, and the deals it could not reach. */
function broughtInSays(layer: Layer, name: string, result: BringInResult): string {
  const parts = [`${theList(layer, name)} imported`];
  if (result.items) parts.push(`${plural(result.items, 'item')} added to ${plural(result.deals, 'deal')}`);
  if (result.missed.length) parts.push(`not added to ${result.missed.map((missed) => missed.deal).join(', ')}`);
  return parts.join(' · ');
}

export function showChecklistOutcome(store: Store, layer: Layer, name: string, result: BringInResult) {
  const undo = () => void undoBringIn(store, result.opIds).then((undone) => {
    store.toast(undone.ok ? 'Undone' : undone.error.message, undone.ok ? 'done' : 'warn');
  });
  store.toast(broughtInSays(layer, name, result), 'done', { label: 'Undo All', run: undo });
}
