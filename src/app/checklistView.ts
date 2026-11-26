import { LAYERS, type Item, type ItemFrom } from '../domain/checklist';
import type { ChecklistRow } from '../ports';
import { itemStanding, offFindingCount, type ItemKind, type State } from './state';

/** A turned-off item's pane shows its open findings first, oldest first within each status. */
export function findingsRaisedOnItem(state: State, dealId: string, itemId: string) {
  return Object.values(state.findings)
    .filter((finding) => finding.dealId === dealId && finding.itemId === itemId)
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open')
      || a.createdAt.localeCompare(b.createdAt));
}

/** A gap's recorded searches, each once: the case variants of a search are one, shown with the text and count of
 * its last record, in the order each was first searched (#956). */
export function gapSearches(row: Pick<ChecklistRow, 'searched'>) {
  const byKey = new Map((row.searched ?? []).map((search) => [search.q.toLowerCase(), search]));
  return [...byKey.values()];
}

const layerOrder: ItemFrom['layer'][] = [...LAYERS, 'deal'];
const levels = ['list', 'section', 'subsection'] as const;
type ListLevel = typeof levels[number];

interface ListHeading {
  level: ListLevel;
  key: string;
  text: string;
  count: number;
}

/** An item in several layers belongs under the first applicable layer, starting with the general list. */
export function listName(item: Item | undefined) {
  const sources = [...(item?.from ?? [])];
  const from = sources.sort((a, b) => layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer))[0];
  if (!from) return 'Other';
  if (from.layer === 'broad') return 'General';
  if (from.layer === 'deal') return 'Added on This Deal';
  return from.value;
}

/** Group by list, section and subsection, in order of first appearance. Items with no source come last. */
function placeRows(state: State, rows: ChecklistRow[]) {
  const groups = new Map<string, { first: number; count: number }>();
  const places = rows.map((row, index) => {
    const item = state.items[row.id];
    const names = [listName(item), item?.section ?? '', item?.subsection ?? ''];
    const keys = names.map((_, depth) => names.slice(0, depth + 1).join('|'));
    const ranks = keys.map((key) => {
      const group = groups.get(key);
      if (group) {
        group.count++;
        return group.first;
      }
      groups.set(key, { first: index, count: 1 });
      return index;
    });
    return { row, names, keys, ranks, last: !item?.from.length };
  });
  places.sort((a, b) => Number(a.last) - Number(b.last) || a.ranks[0] - b.ranks[0]
    || a.ranks[1] - b.ranks[1] || a.ranks[2] - b.ranks[2]);

  return places.map(({ row, names, keys }, index) => {
    const previous = places[index - 1];
    const heads: ListHeading[] = [];
    const groupsForRow: ListHeading[] = [];
    let newGroup = !previous;
    for (const [depth, level] of levels.entries()) {
      const text = names[depth];
      newGroup ||= previous.names[depth] !== text;
      if (depth > 0 && !text) continue;
      const key = keys[depth];
      const count = groups.get(key)!.count;
      const heading = { level, key, text, count };
      groupsForRow.push(heading);
      if (newGroup) heads.push(heading);
    }
    return { row, heads, groups: groupsForRow };
  });
}

type Filter = State['ui']['checklistFilter'];
const standingOrder: ItemKind[] = ['finding', 'gone', 'gap', 'open', 'person', 'satisfied'];

function uncheckedRow(item: Item): ChecklistRow {
  return { id: item.id, text: item.text, result: 'unchecked', docs: [] };
}

function visibleFilters(counts: Record<Filter, number>) {
  const filters: Filter[] = ['all'];
  if (counts.all > counts.off) {
    for (const kind of standingOrder) {
      if (counts[kind] || kind === 'finding' || kind === 'gap' || kind === 'satisfied') filters.push(kind);
    }
  }
  if (counts.off) filters.push('off');
  return filters;
}

/** A completed read can be behind the deal's own list. Include new items immediately and drop stale results for
 * turned-off items. While loading or after a failed read, only the turned-off items are known. */
export function checklistRows(state: State, dealId: string) {
  const own = Object.values(state.items).filter((item) => item.dealId === dealId);
  const checked = state.checklists[dealId];
  const active = Array.isArray(checked) ? checked.filter((row) => !state.items[row.id]?.off) : [];
  const seen = new Set(active.map((row) => row.id));
  const offRows: ChecklistRow[] = [];
  for (const item of own) {
    if (item.off) offRows.push(uncheckedRow(item));
    else if (Array.isArray(checked) && !seen.has(item.id)) active.push(uncheckedRow(item));
  }
  const counts: Record<Filter, number> = {
    all: active.length + offRows.length, finding: 0, gone: 0, gap: 0, open: 0, person: 0, satisfied: 0,
    off: offRows.length,
  };
  const kinds = new Map(active.map((row) => [row.id, itemStanding(state, dealId, row).kind]));
  for (const row of active) counts[kinds.get(row.id)!]++;
  const itemOrder = new Map(own.map((item, index) => [item.id, index]));
  return { active, offRows, counts, kinds, itemOrder, filters: visibleFilters(counts) };
}

export type ChecklistHeading = ListHeading | { level: 'standing'; key: string; text: ItemKind; count: number };

/** With no deal items, group by standing. A single-status filter supplies its own heading. */
function byStanding(kept: ChecklistRow[], checklist: ReturnType<typeof checklistRows>, on: Filter) {
  const kind = (row: ChecklistRow) => checklist.kinds.get(row.id)!;
  kept.sort((a, b) => standingOrder.indexOf(kind(a)) - standingOrder.indexOf(kind(b)));
  return kept.map((row, index) => {
    const text = kind(row);
    const heading: ChecklistHeading = { level: 'standing', key: text, text, count: checklist.counts[text] };
    const groups = on === 'all' ? [heading] : [];
    const heads = !index || text !== kind(kept[index - 1]) ? groups : [];
    return { row, groups, heads };
  });
}

/** Keep the selected row in view even when it belongs to another filter. Filter badges count matching rows only. */
export function checklistView(state: State, dealId: string) {
  const checklist = checklistRows(state, dealId);
  const { active, offRows, kinds, counts, itemOrder, filters } = checklist;
  const { checklistFilter, selectedChecklist } = state.ui;
  const on = filters.includes(checklistFilter) ? checklistFilter : 'all';
  const kept = [...active, ...offRows].filter((row) =>
    on === 'all' || row.id === selectedChecklist || (kinds.get(row.id) ?? 'off') === on);
  const byList = itemOrder.size > 0;
  const position = (row: ChecklistRow) => itemOrder.get(row.id) ?? Infinity;
  const shown: { row: ChecklistRow; groups: ChecklistHeading[]; heads: ChecklistHeading[] }[] = byList
    ? placeRows(state, kept.sort((a, b) => position(a) - position(b)))
    : byStanding(kept, checklist, on);
  const selected = kept.find((row) => row.id === selectedChecklist);
  const offIds = new Set(offRows.map((row) => row.id));
  return { counts, filters, on, shown, selected, byList, offIds, offOpen: offFindingCount(state, dealId) };
}
