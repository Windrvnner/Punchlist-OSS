import { key, type ListItem, type ListRecord } from '../domain/checklist';
import { differingFields } from '../domain/versions';
import type { Conflict, State } from './state';

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

/**
 * The fields shown for each version, from the record's fields in reading order. Changed on two PCs: the fields that
 * differ. With a delete: the first two fields any readable version holds, so a person sees what each choice keeps,
 * and the status rides on the line under the PC's name rather than taking a row of its own.
 */
export function comparedFields(conflict: Pick<Conflict, 'versions'>, fields: readonly string[]) {
  const withDelete = conflict.versions.some((version) => version.deleted);
  // a deleted version shows the words it held (the deleting PC's copy) when it has them
  const readable = conflict.versions.filter((version) => !version.deleted || version.data);
  const values = readable.map((version) => version.data as Record<string, unknown> | null);
  if (!withDelete) return { shown: differingFields(values, fields), statusOnLine: false };
  const held = (field: string) => values.some((data) => data && String(data[field] ?? '').trim());
  const shown = fields.filter((field) => field !== 'status').slice(0, 2).filter(held);
  return { shown, statusOnLine: true };
}
