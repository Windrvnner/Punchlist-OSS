/**
 * Bringing in a checklist from a spreadsheet, as pure functions over the table the SpreadsheetCodec read:
 * which column holds the items and which their section, the rows as items, and the items worded the same.
 */
import { key, norm, type ListItem } from './checklist';

export interface ChecklistMapping { item: number | null; section: number | null; subsection?: number | null }

const squash = (c: string) => String(c ?? '').toLowerCase().replace(/[^a-z]/g, '');
const ITEM_HEADINGS = ['item', 'items', 'checklistitem', 'requirement', 'requirements', 'description', 'diligenceitem', 'request', 'requested', 'documentrequested', 'question', 'check', 'criterion', 'criteria', 'condition', 'text'];
const SECTION_HEADINGS = ['section', 'area', 'category', 'workstream', 'topic', 'heading', 'group', 'subject'];
const SUBSECTION_HEADINGS = ['subsection', 'subsections', 'subarea', 'subcategory', 'subtopic', 'subheading', 'subgroup'];

/**
 * Which column holds the items, and which their section and subsection headings: each is the first column whose
 * heading is one of the known names, or none, for the person to choose. Nothing is guessed from the cells.
 */
export function suggestChecklistColumns(columns: string[]): ChecklistMapping {
  const find = (names: string[]) => {
    const at = columns.findIndex((column) => names.includes(squash(column)));
    return at < 0 ? null : at;
  };
  return { item: find(ITEM_HEADINGS), section: find(SECTION_HEADINGS), subsection: find(SUBSECTION_HEADINGS) };
}

/**
 * The rows as items: the item column's wording, normalized, with the section column's heading when there is one. A row
 * whose item cell is empty is left out and counted. A section column that is filled only on the first row of each
 * section (as such lists are often laid out) gives its heading to the rows under it. A subsection column does the same
 * within its section: a new section starts with no subsection.
 */
export function prepareChecklist(rows: string[][], m: ChecklistMapping): { items: ListItem[]; skipped: number } {
  const items: ListItem[] = []; let skipped = 0; let section = ''; let subsection = '';
  for (const r of rows) {
    if (m.section !== null) { const s = norm(String(r[m.section] ?? '')); if (s && s !== section) { section = s; subsection = ''; } }
    if (m.subsection != null) { const s = norm(String(r[m.subsection] ?? '')); if (s) subsection = s; }
    const text = m.item === null ? '' : norm(String(r[m.item] ?? ''));
    if (!key(text)) { skipped++; continue; }
    items.push({ text, ...(section ? { section } : {}), ...(subsection ? { subsection } : {}) });
  }
  return { items, skipped };
}

/** Items worded the same (by key: case, spacing and a final period do not count), as groups of their places, each in order. */
export function sameWording(items: { text: string }[]): number[][] {
  const by = new Map<string, number[]>();
  items.forEach((it, i) => { const k = key(it.text); const l = by.get(k) ?? []; l.push(i); by.set(k, l); });
  return [...by.values()].filter((g) => g.length > 1);
}

/**
 * The rewordings a person took when this list was last brought in, for the rows of the file that still read as they did
 * then: each row whose wording matches an item's `was` (by key) and not already its new wording, with that new
 * wording. A row that matches no earlier rewording is left to the model's suggestions, if any.
 */
export function earlierRewordings(items: { text: string }[], before: { text: string; was?: string }[] | undefined): { at: number; text: string; also?: string[] }[] {
  // an item split in two left two or more items with the same `was`: they come back together, in their order. A
  // row the file had twice (in two sections), reworded alike, left the same wording twice: that is one rewording, not a split
  const by = new Map<string, string[]>();
  for (const it of before ?? []) if (it.was && key(it.was) !== key(it.text)) { const t = by.get(key(it.was)) ?? []; if (!t.some((x) => key(x) === key(it.text))) by.set(key(it.was), [...t, it.text]); }
  return items.flatMap((it, at) => { const t = by.get(key(it.text)); return t ? [{ at, text: t[0], ...(t.length > 1 ? { also: t.slice(1) } : {}) }] : []; });
}
