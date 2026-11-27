/**
 * The model's read of a whole list brought in (ai.ts `readList`): the prompt that shows every line at once, and the
 * reply read back into a reading the app ties out (domain/listRead). The model names each line's kind by line
 * numbers and ranges, and a table's columns; it gives no words, so every item is worded as its line in the file.
 */
import { int, isObject, list } from './lenient';
import { UNREAD_REPLY } from './limits';
import { inParts } from './parts';
import type { LineRead, ListCells, ListReply } from '../domain/listRead';

export const LIST_KINDS: LineRead['k'][] = ['section', 'subsection', 'item', 'more', 'columns', 'left'];

/** the lines `from` to `to` (0-based, `to` not included) of a list: the whole list unless it is asked in parts */
export interface ListSpan { from: number; to: number }

/** a line's handle in the prompt: its number in the whole list, from 1, with an L and in square brackets (#1227) */
const handleOf = (n: number): string => `L${n}`;

/**
 * Every line of the span that is not blank, behind its handle, and what to say of each. A handle is a tag no line's own
 * text starts with, so a line that begins "1.2" or holds "Q1" is never taken for a number the model is to give back.
 */
export function listReadPrompt(lines: string[], span: ListSpan = { from: 0, to: lines.length }): string {
  const own = lines.slice(span.from, span.to);
  const tagged = (line: string, k: number) => `[${handleOf(span.from + k + 1)}] ${line.replace(/\s+$/, '')}`;
  const shown = own.flatMap((line, k) => (line.trim() ? [tagged(line, k)] : [])).join('\n');
  return [
    'A firm\'s due diligence checklist for project-finance deals was pasted or imported as the lines below.',
    'Each line starts with its handle in square brackets, such as [L12]; the handle is not part of the line.',
    'A table\'s row has its cells joined by " | ".',
    shown,
    '',
    'Say what kind each line is, naming every line under exactly one kind, by its handle (such as "L7") or by a range',
    'of two handles joined by a hyphen (such as "L4-L39"):',
    '- "section" or "subsection": a heading that the items under it belong to;',
    '- "item": one thing to check;',
    '- "more": the rest of the item on the line above (a long item wrapped onto the next line);',
    '- "columns": a table\'s heading row;',
    '- "left": anything else (a title, a note, a page number or footer, a date).',
    'For a table, "columns" gives the column numbers, counted from 1: "item", the column that holds each row\'s item;',
    '"section" and "subsection", columns of their own that hold a row\'s section and subsection, when the table has',
    'them; "heading" and "subheading", the columns that hold the heading of a section row and of a subsection row.',
    'Reply as JSON: {"lines": {"section": ["L3"], "subsection": [], "item": ["L4-L11", "L13-L39", "L41"],',
    '"more": ["L12"], "columns": ["L1"], "left": ["L2", "L40"]},',
    '"columns": {"item": 3, "section": 1, "subsection": 2, "heading": 1, "subheading": 2}}',
  ].join('\n');
}

/** the line indexes a handle, or a range of two handles, names by exact lookup among those shown; none otherwise */
function indexesOf(entry: unknown, at: Map<string, number>): number[] {
  if (typeof entry !== 'string') return [];
  const ends = entry.split('-').map((h) => at.get(h));
  if (ends.length > 2 || ends.some((e) => e === undefined)) return [];
  const [from, to] = [ends[0]!, ends[ends.length - 1]!];
  return from <= to ? Array.from({ length: to - from + 1 }, (_, k) => from + k) : [];
}

/** a column number from the reply, counted from 1 */
function column(value: unknown): number | undefined {
  const c = int(value);
  return c !== null && c >= 1 ? c : undefined;
}

/**
 * A table's columns as the reply gives them; none without an item column. A row's section and subsection are cells
 * of their own, so a section or subsection column that is the item column is not taken.
 */
function columnsOf(value: unknown): ListCells | undefined {
  if (!isObject(value)) return undefined;
  const item = column(value.item);
  if (!item) return undefined;
  const own = (v: unknown) => (column(v) !== item ? column(v) : undefined);
  const section = own(value.section);
  const subsection = own(value.subsection);
  const heading = column(value.heading);
  const subheading = column(value.subheading);
  const named = { ...(section ? { section } : {}), ...(subsection ? { subsection } : {}) };
  return { item, ...named, ...(heading ? { heading } : {}), ...(subheading ? { subheading } : {}) };
}

/**
 * The reply as a reading: each line that is not blank and is named under exactly one kind, by a handle the prompt
 * gave. A line named under two kinds is left without a reading, so the app asks about it again rather than choose.
 */
export function listReply(
  reply: Record<string, unknown>, lines: string[], span: ListSpan = { from: 0, to: lines.length },
): ListReply {
  const at = new Map<string, number>();
  for (let k = span.from; k < span.to; k++) at.set(handleOf(k + 1), k);
  const named = new Map<number, Set<LineRead['k']>>();
  const kinds = isObject(reply.lines) ? reply.lines : {};
  for (const k of LIST_KINDS) {
    for (const entry of list(kinds[k])) {
      for (const index of indexesOf(entry, at)) {
        if (lines[index].trim()) named.set(index + 1, (named.get(index + 1) ?? new Set()).add(k));
      }
    }
  }
  const read = [...named].filter(([, found]) => found.size === 1).sort((a, b) => a[0] - b[0]);
  const cells = columnsOf(reply.columns);
  return { lines: read.map(([n, found]) => ({ n, k: [...found][0] })), ...(cells ? { cells } : {}) };
}

/**
 * Read a list whole, in one call, through `inParts` (parts.ts), which asks again in halves when the service refuses a
 * request as too long (`toolong`), down to one line, and does the same for a reply cut off at the length limit
 * (decisions: every AI feature adapts to a request that is too long or a reply cut off). The halves' readings are
 * joined; a table's columns are taken from the first part that gives them, as its heading row is in the first part.
 * A line never read, a reply that cannot be read and any other failure stop the run: `stopped` says why, and `read`
 * is then absent, so half a list is never shown as all of it.
 */
export async function readListInParts(
  lines: string[], ask: (span: ListSpan) => Promise<ListReply | null>,
): Promise<{ read?: ListReply; stopped?: unknown }> {
  const cellsFound: ListCells[] = [];
  const done = await inParts(lines.map((_, at) => at), lines.length, async (part) => {
    // a half of blank lines holds nothing to read: no call for it
    if (part.every((at) => !lines[at].trim())) return { got: new Map() };
    const reply = await ask({ from: part[0], to: part[part.length - 1] + 1 });
    if (!reply) throw Object.assign(new Error(UNREAD_REPLY), { code: 'unread' });
    if (reply.cells) cellsFound.push(reply.cells);
    return { got: new Map(reply.lines.map((r) => [r.n - 1 - part[0], r])) };
  });
  if (done.stopped !== undefined) return { stopped: done.stopped };
  const cells = cellsFound[0];
  const read = [...done.got.values()].sort((a, b) => a.n - b.n);
  return { read: { lines: read, ...(cells ? { cells } : {}) } };
}
