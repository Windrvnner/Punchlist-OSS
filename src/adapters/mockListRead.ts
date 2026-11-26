/**
 * The stand-in for the model reading a whole list in (mocks.ts `readList`), by the look of each line: a table's
 * columns are known by its heading row; "1." alone is a section, an indented line with no number a subsection, a line
 * numbered "1.2", "a)" or bulleted an item, an indented line after an item its rest, and a line of a "Page 2 of 6"
 * kind, a title or a note is left out. The real one is a model's judgment.
 */
import type { LineRead, ListReply } from '../domain/listRead';
import { suggestChecklistColumns } from '../domain/checklistImport';

/** a numbered or bulleted line */
const NUMBERED = /^\s*(\d+(\.\d+)*\.?|[a-z]\)|[-•])\s+\S/i;
/** an item's own number, letter or bullet */
const ITEM_LABEL = /^(\d+(\.\d+)+|[a-z]\)|[-•])\s+/i;
/** a footer, note, draft or confidentiality line */
const NOTE = /^(page \d+ of \d+|note:|draft\b|confidential\b)/i;

/** the stand-in's reading of a table: its heading row, an item for each row with an item cell, its columns named */
export function mockTableReading(lines: string[]): ListReply {
  const split = (l: string) => l.split(' | ').map((c) => c.trim());
  const cols = suggestChecklistColumns(split(lines[0]));
  const column = (c: number | null | undefined) => (c == null ? undefined : c + 1);
  const read: LineRead[] = [];
  lines.forEach((raw, k) => {
    if (!raw.trim()) return;
    const n = k + 1;
    const item = cols.item == null ? '' : split(raw)[cols.item] ?? '';
    read.push({ n, k: n === 1 ? 'columns' : item ? 'item' : 'left' });
  });
  const section = column(cols.section);
  const subsection = column(cols.subsection);
  const named = { ...(section ? { section } : {}), ...(subsection ? { subsection } : {}) };
  return { lines: read, cells: { item: column(cols.item) ?? 1, ...named } };
}

/** the stand-in's reading of a list with no numbers or bullets at all: one item a line, under a heading row if any */
function plainKind(line: string, n: number): LineRead['k'] {
  if (/^page \d+ of \d+$/i.test(line)) return 'left';
  return n === 1 && /^(checklist )?items?$|^requirements?$|^description$/i.test(line) ? 'columns' : 'item';
}

/** the stand-in's reading of text lines, by the look of each line */
export function mockTextReads(lines: string[]): LineRead[] {
  const reads: LineRead[] = [];
  const plain = !lines.some((l) => NUMBERED.test(l));
  let inItem = false;
  lines.forEach((raw, k) => {
    const n = k + 1;
    const line = raw.trim();
    if (!line) { inItem = false; return; }
    const kind = plain ? plainKind(line, n) : numberedKind(raw, line, inItem);
    if (kind === 'item' || kind === 'more') inItem = true;
    else if (kind === 'section' || kind === 'subsection') inItem = false;
    reads.push({ n, k: kind });
  });
  return reads;
}

/** a line of a numbered list: `inItem` says whether an item came just before it */
function numberedKind(raw: string, line: string, inItem: boolean): LineRead['k'] {
  if (NOTE.test(line) || (/\.$/.test(line) && !/^(\d+(\.\d+)+|[a-z]\)|[-•*])\s/i.test(line))) return 'left';
  if (/^\d+\.\s+\S/.test(line) && !/^\d+\.\d/.test(line)) return 'section';
  if (ITEM_LABEL.test(line)) return 'item';
  if (inItem && /^\s{4,}/.test(raw)) return 'more';
  return /^\s+/.test(raw) && line.length <= 40 ? 'subsection' : 'left';
}
