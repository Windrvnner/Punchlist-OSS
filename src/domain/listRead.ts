/**
 * A list read whole by the model, tied out line by line. The input, pasted text, a document or a table, is a list of
 * lines. The model reads it in one call and says what kind each line is, and for a table which columns hold the item,
 * section and subsection; it never gives the words. Every item and heading is worded as its line in the file. The app
 * accounts for every line: an item (or the rest of the item above it), a heading, a table's own heading row, a blank,
 * or a line left out. A line the model did not name, or a table row whose named cell is blank, is unplaced: it is asked
 * about again and, if still unplaced, left out. Nothing in the input is dropped: a line left out is listed, and a person
 * can bring it in where it sits.
 */
import { key, type ListItem } from './checklist';

/** what the model says a line is */
export interface LineRead {
  /** the line's number, from 1 */
  n: number;
  /** section or subsection: a heading; item: a new item; more: the rest of the item above (a wrapped line); columns: a table's heading row; left: not an item */
  k: 'section' | 'subsection' | 'item' | 'more' | 'columns' | 'left';
}

/** for a table, the columns (from 1) that hold each row's item, section and subsection */
export interface ListCells { item: number; section?: number; subsection?: number }

/** the model's reading of a whole list, as the service sends it: each named line's kind, and a table's columns */
export interface ListReply { lines: LineRead[]; cells?: ListCells }

/** the reading the app ties out: each line's kind, by its number, and a table's columns */
export interface ListReading { reads: Map<number, LineRead>; cells?: ListCells }

export const readingOf = (reply: ListReply): ListReading =>
  ({ reads: new Map(reply.lines.map((r) => [r.n, r])), ...(reply.cells ? { cells: reply.cells } : {}) });

/** an item, with the lines it came from */
export type ReadItem = ListItem & { lines: number[] };

export interface TiedOut {
  /** the items, in the input's order */
  items: ReadItem[];
  /** the lines left out, by number, in order: the model's "not an item", and lines it never placed */
  left: number[];
  /** how every line was accounted for; they add up to the number of lines */
  count: { lines: number; items: number; more: number; headings: number; blank: number; left: number };
}

/** A table as lines for the model: the heading row, then each row, its cells joined by " | ". */
export function tableLines(columns: string[], rows: string[][]): string[] {
  // a line break inside a cell would split the row, so it becomes a space; the cell's other characters are kept
  const line = (r: string[]) => r.map((c) => String(c ?? '').replace(/\r\n?|\n/g, ' ')).join(' | ');
  return [line(columns), ...rows.map(line)];
}

/** Text as lines: every line break counts, so a line number means the same line to the person, the model and the app. */
export const textLines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** a table row's cells, as tableLines joins them */
const cellsOf = (line: string) => line.split(' | ');

/** the cell a column names, as written, or '' when the line is not a table row or the column is past it */
function cellAt(line: string, column: number | undefined): string {
  const cells = cellsOf(line);
  return cells.length > 1 && column && column >= 1 ? (cells[column - 1] ?? '') : '';
}

/**
 * The words a line's item or heading stands for, exactly as the file has them: a text line whole (its edge spaces
 * aside), a table row the cell the model's columns name for that kind. '' when there are none.
 */
function wordsOf(line: string, k: LineRead['k'], cells: ListCells | undefined): string {
  if (cellsOf(line).length === 1) return line.trim();     // edge spaces are layout
  const column = k === 'item' ? cells?.item : k === 'section' ? cells?.section : cells?.subsection;
  const cell = cellAt(line, column);
  return key(cell) ? cell : '';
}

/** The lines that are not blank and have no usable reading: the ones to ask about again. */
export function unplaced(lines: string[], reading: ListReading): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => { if (key(line) && !usable(line, reading.reads.get(i + 1), reading.cells)) out.push(i + 1); });
  return out;
}

/** a reading is usable when its kind is known and an item or heading has words in its line */
function usable(line: string, r: LineRead | undefined, cells: ListCells | undefined): boolean {
  if (!r) return false;
  if (r.k === 'left' || r.k === 'columns' || r.k === 'more') return true;
  if (r.k !== 'item' && r.k !== 'section' && r.k !== 'subsection') return false;
  return !!wordsOf(line, r.k, cells);
}

/**
 * Every line accounted for. `bringIn` holds lines left out that a person checked: each becomes an item where it sits,
 * under the heading above it, with its own words. A reading that is not usable leaves its line out; a "more" line with
 * no item above it in the same section is left out too, never joined to an item it does not belong to.
 */
export function tieOut(lines: string[], reading: ListReading, bringIn: ReadonlySet<number> = new Set()): TiedOut {
  const { reads, cells } = reading;
  const items: ReadItem[] = []; const left: number[] = [];
  const count = { lines: lines.length, items: 0, more: 0, headings: 0, blank: 0, left: 0 };
  let section = ''; let subsection = ''; let last: ReadItem | null = null;
  const add = (text: string, n: number, s = section, sub = subsection) => {
    last = { text, lines: [n], ...(s ? { section: s } : {}), ...(sub ? { subsection: sub } : {}) }; items.push(last); count.items++;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!key(line)) { count.blank++; return; }
    const r = reads.get(n);
    if (!r || !usable(line, r, cells)) { leave(n); return; }
    if (r.k === 'section') { section = wordsOf(line, r.k, cells); subsection = ''; last = null; count.headings++; return; }
    if (r.k === 'subsection') { subsection = wordsOf(line, r.k, cells); last = null; count.headings++; return; }
    if (r.k === 'columns') { count.headings++; return; }
    if (r.k === 'more') {
      if (!last) { leave(n); return; }
      const it: ReadItem = last; it.text = `${it.text} ${line.trim()}`; it.lines.push(n); count.more++; return;
    }
    if (r.k === 'item') {
      // a table row's own section cell starts that section (and no subsection) for it and the rows under it, as a section
      // filled in only on the first row of each section is laid out; its subsection cell does the same within the section
      const s = cellAt(line, cells?.section); const sub = cellAt(line, cells?.subsection);
      if (key(s) && key(s) !== key(section)) { section = s; subsection = ''; }
      if (key(sub)) subsection = sub;
      add(wordsOf(line, r.k, cells), n);
      return;
    }
    leave(n);
  });
  return { items, left, count };

  function leave(n: number) {
    // a line brought in comes in exactly as written, its bullet or list number included
    if (bringIn.has(n)) { add(lines[n - 1], n); last = null; return; }
    left.push(n); count.left++;
  }
}
