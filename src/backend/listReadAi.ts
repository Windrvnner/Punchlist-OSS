/**
 * The model's read of a whole list brought in (ai.ts `readList`): the prompt that shows every line at once, and the
 * reply read back into a reading the app ties out (domain/listRead). The model names each line's kind by line
 * numbers and ranges, and a table's columns; it gives no words, so every item is worded as its line in the file.
 */
import { int, isObject, list } from './lenient';
import type { LineRead, ListCells, ListReply } from '../domain/listRead';

export const LIST_KINDS: LineRead['k'][] = ['section', 'subsection', 'item', 'more', 'columns', 'left'];

/** Every line that is not blank, numbered from 1, and what to say of each. */
export function listReadPrompt(lines: string[]): string {
  const shown = lines.flatMap((line, k) => (line.trim() ? [`${k + 1}: ${line.replace(/\s+$/, '')}`] : [])).join('\n');
  return [
    'A firm\'s due diligence checklist for project-finance deals was pasted or imported as the numbered lines below.',
    'A table\'s row has its cells joined by " | ".',
    shown,
    '',
    'Say what kind each line is, naming every line under exactly one kind, by its number or a range such as "4-39":',
    '- "section" or "subsection": a heading that the items under it belong to;',
    '- "item": one thing to check;',
    '- "more": the rest of the item on the line above (a long item wrapped onto the next line);',
    '- "columns": a table\'s heading row;',
    '- "left": anything else (a title, a note, a page number or footer, a date).',
    'For a table, "cells" gives the column numbers, counted from 1: "item", the column that holds each row\'s item;',
    '"section" and "subsection", columns of their own that hold a row\'s section and subsection, when the table has',
    'them; "heading" and "subheading", the columns that hold the heading of a section row and of a subsection row.',
    'Reply as JSON: {"section": ["3"], "subsection": [], "item": ["4-39", "41"], "more": ["12"], "columns": ["1"],',
    '"left": ["2", "40"], "cells": {"item": 3, "section": 1, "subsection": 2, "heading": 1, "subheading": 2}}',
  ].join('\n');
}

/** the line numbers an entry names: a number, or a range "a-b" or "a–b" (both ends in), within the list */
function numbersIn(entry: unknown, count: number): number[] {
  const range = typeof entry === 'string' ? /^\s*(\d+)\s*[-–]\s*(\d+)\s*$/.exec(entry) : null;
  const [from, to] = range ? [Number(range[1]), Number(range[2])] : [int(entry), int(entry)];
  if (from === null || to === null) return [];
  const out: number[] = [];
  for (let n = Math.max(1, from); n <= Math.min(to, count); n++) out.push(n);
  return out;
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
 * The reply as a reading: each line that is not blank and is named under exactly one kind. A line named under two
 * kinds is left without a reading, so the app asks about it again rather than choose one.
 */
export function listReply(reply: Record<string, unknown>, lines: string[]): ListReply {
  const named = new Map<number, Set<LineRead['k']>>();
  for (const k of LIST_KINDS) {
    for (const entry of list(reply[k])) {
      for (const n of numbersIn(entry, lines.length)) {
        if (lines[n - 1].trim()) named.set(n, (named.get(n) ?? new Set()).add(k));
      }
    }
  }
  const read = [...named].filter(([, kinds]) => kinds.size === 1).sort((a, b) => a[0] - b[0]);
  const cells = columnsOf(reply.cells);
  return { lines: read.map(([n, kinds]) => ({ n, k: [...kinds][0] })), ...(cells ? { cells } : {}) };
}
