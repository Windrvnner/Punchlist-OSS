import { LAYERS, type Item, type ItemFrom } from '../domain/checklist';
import type { ChecklistRow } from '../ports';
import type { State } from './state';

/** Turning an item off keeps its findings and the target of a question already being written. */
export function checklistFindings(
  state: State, dealId: string, row: ChecklistRow, off: boolean, draftFindingId?: string,
) {
  if (!off) return { raised: [], finding: row.findingId ? state.findings[row.findingId] : undefined };

  const raised = Object.values(state.findings)
    .filter((finding) => finding.dealId === dealId && finding.itemId === row.id)
    .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open')
      || a.createdAt.localeCompare(b.createdAt));
  const draftTarget = raised.find((finding) => finding.id === draftFindingId && finding.status === 'open');
  return { raised, finding: draftTarget ?? raised[0] };
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
function listName(item: Item | undefined) {
  const sources = [...(item?.from ?? [])];
  const from = sources.sort((a, b) => layerOrder.indexOf(a.layer) - layerOrder.indexOf(b.layer))[0];
  if (!from) return 'Other';
  if (from.layer === 'broad') return 'General';
  if (from.layer === 'deal') return 'Added on This Deal';
  return from.value;
}

/** Group by list, section and subsection, in order of first appearance. Items with no source come last. */
export function placeRows(state: State, rows: ChecklistRow[]) {
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
    const path: string[] = [];
    let newGroup = !previous;
    for (const [depth, level] of levels.entries()) {
      const text = names[depth];
      newGroup ||= previous.names[depth] !== text;
      if (depth > 0 && !text) continue;
      const key = keys[depth];
      const count = groups.get(key)!.count;
      path.push(`${text}, ${count}`);
      if (newGroup) heads.push({ level, key, text, count });
    }
    return { row, heads, path: path.join(' · ') };
  });
}
