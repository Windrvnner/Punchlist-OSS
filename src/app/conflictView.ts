import { key, type ListItem, type ListRecord } from '../domain/checklist';
import type { State } from './state';

/** Count what this version holds and what a person would set aside by choosing it. */
export function compareChecklistVersion(
  state: Pick<State, 'conflicts'>, record: ListRecord, items: ListRecord['items'] = [],
) {
  const others = (state.conflicts[record.id]?.versions ?? [])
    .map((version) => version.data as ListRecord | null)
    .filter((other): other is ListRecord => !!other && other !== record && other.items !== items);
  const mine = new Set(items.map((item) => key(item.text)));
  const theirs = new Set(others.flatMap((other) => other.items.map((item) => key(item.text))));
  const only = items.filter((item) => !theirs.has(key(item.text)));
  const lacking = new Map<string, ListRecord['items'][number]>();
  for (const other of others) {
    for (const item of other.items) {
      const itemKey = key(item.text);
      if (!mine.has(itemKey) && !lacking.has(itemKey)) lacking.set(itemKey, item);
    }
  }
  const same = others.length > 0 && !only.length && !lacking.size
    && others.every((other) => new Set(other.items.map((item) => key(item.text))).size === theirs.size);
  return {
    count: items.length, compared: others.length > 0, same,
    only: preview(only), lacks: preview([...lacking.values()]),
  };
}

function preview(items: ListItem[]) {
  const names = items.slice(0, 5).map(({ text }) => text);
  return { count: items.length, names, more: items.length - names.length };
}
