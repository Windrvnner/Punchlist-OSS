/**
 * A list read whole by the model, tied out line by line. The input, pasted text, a document or a table, is a list of
 * lines. The model reads it in one call and says what kind each line is, and for a table which columns hold the
 * item, section and subsection, and the headings of section and subsection rows; it never gives the words. Every item
 * and heading is worded as its line in the file. The app accounts for every line: an item (or the rest of the item
 * above it), a heading, a table's own heading row, a blank, or a line left out. A line the model did not name, or a
 * table row whose named cell is blank, is unplaced: it is asked about again and, if still unplaced, left out. Nothing
 * in the input is dropped: a line left out is listed, and a person can bring it in where it sits.
 */
import { key, type ListItem } from './checklist';

/** what the model says a line is */
export interface LineRead {
  /** the line's number, from 1 */
  n: number;
  /** section or subsection: a heading; item: a new item; more: the rest of the item above (a wrapped line); columns: a table's heading row; left: not an item */
  k: 'section' | 'subsection' | 'item' | 'more' | 'columns' | 'left';
}

/**
 * For a table, the columns (from 1) that hold each row's item, section and subsection, and the heading of a row read
 * as a section (`heading`) or a subsection (`subheading`).
 */
export interface ListCells {
  item: number; section?: number; subsection?: number; heading?: number; subheading?: number;
}

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
const rowCells = (line: string) => line.split(' | ');

/** the cell a column names, as written, or '' when the line is not a table row or the column is past it */
function cellAt(line: string, column: number | undefined): string {
  const cells = rowCells(line);
  return cells.length > 1 && column && column >= 1 ? (cells[column - 1] ?? '') : '';
}

/**
 * The words a line's item or heading stands for, exactly as the file has them: a text line whole (its edge spaces
 * aside), a table row the cell the model's columns name: the item column for an item, the heading or subheading
 * column for a section or subsection row. '' when there are none.
 */
function wordsOf(line: string, k: LineRead['k'], cells: ListCells | undefined): string {
  if (rowCells(line).length === 1) return line.trim();     // edge spaces are layout
  const column = k === 'item' ? cells?.item : k === 'section' ? cells?.heading : cells?.subheading;
  const cell = cellAt(line, column);
  return key(cell) ? cell : '';
}

/** The lines that are not blank and have no usable reading: the ones to ask about again. */
export function unplaced(lines: string[], reading: ListReading): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (key(line) && !usable(line, reading.reads.get(i + 1), reading.cells)) out.push(i + 1);
  });
  return out;
}

/**
 * The first reading, with the lines it left unplaced taken from a second reading of the whole list: what the first
 * placed is kept. A column one reading did not name is taken from the other. Where both name a column, the first's
 * columns stand unless the second's leave fewer lines unplaced, since a wrong column is what leaves table rows
 * unplaced (#1073).
 */
export function fillUnplaced(lines: string[], first: ListReading, second: ListReading): ListReading {
  const reads = new Map(first.reads);
  for (const n of unplaced(lines, first)) {
    const again = second.reads.get(n);
    if (again) reads.set(n, again);
  }
  if (!first.cells && !second.cells) return { reads };
  const firstWins = { reads, cells: { ...second.cells, ...first.cells } as ListCells };
  const secondWins = { reads, cells: { ...first.cells, ...second.cells } as ListCells };
  return unplaced(lines, secondWins).length < unplaced(lines, firstWins).length ? secondWins : firstWins;
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
  const count = { lines: lines.length, items: 0, more: 0, headings: 0, blank: 0, left: 0 };
  const tied: TiedOut = { items: [], left: [], count };
  const at: TieState = { section: '', subsection: '', last: null };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!key(line)) {
      count.blank++;
      return;
    }
    const r = reading.reads.get(n);
    const placed = !!r && usable(line, r, reading.cells) && place(tied, at, line, r, reading.cells);
    if (placed) return;
    if (!bringIn.has(n)) {
      tied.left.push(n);
      count.left++;
      return;
    }
    // a line brought in comes in exactly as written, its bullet or list number included
    addItem(tied, at, lines[n - 1], n);
    at.last = null;
  });
  return tied;
}

/** where a tie-out has got to: the headings over the next item, and the item a "more" line would join */
interface TieState { section: string; subsection: string; last: ReadItem | null }

/** a new item under the headings above it */
function addItem(tied: TiedOut, at: TieState, text: string, n: number) {
  const section = at.section ? { section: at.section } : {};
  const headings = { ...section, ...(at.subsection ? { subsection: at.subsection } : {}) };
  at.last = { text, lines: [n], ...headings };
  tied.items.push(at.last);
  tied.count.items++;
}

/**
 * Accounts for a line with a usable reading; false when it is to be left out: "left", or a "more" line with no item
 * above it.
 */
function place(tied: TiedOut, at: TieState, line: string, r: LineRead, cells: ListCells | undefined): boolean {
  if (r.k === 'left') return false;
  if (r.k === 'section' || r.k === 'subsection') {
    if (r.k === 'section') at.subsection = '';
    at[r.k] = wordsOf(line, r.k, cells);
    at.last = null;
    tied.count.headings++;
    return true;
  }
  if (r.k === 'columns') {
    tied.count.headings++;
    return true;
  }
  if (r.k === 'more') {
    if (!at.last) return false;
    at.last.text = `${at.last.text} ${line.trim()}`;
    at.last.lines.push(r.n);
    tied.count.more++;
    return true;
  }
  rowHeadings(at, line, cells);
  addItem(tied, at, wordsOf(line, r.k, cells), r.n);
  return true;
}

/**
 * A table row's own section cell starts that section (and no subsection) for it and the rows under it, as a section
 * filled in only on the first row of each section is laid out; its subsection cell does the same within the section.
 */
function rowHeadings(at: TieState, line: string, cells: ListCells | undefined) {
  const section = cellAt(line, cells?.section);
  const subsection = cellAt(line, cells?.subsection);
  if (key(section) && key(section) !== key(at.section)) {
    at.section = section;
    at.subsection = '';
  }
  if (key(subsection)) at.subsection = subsection;
}
