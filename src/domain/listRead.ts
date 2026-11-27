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
  item: number;
  section?: number;
  subsection?: number;
  heading?: number;
  subheading?: number;
}

/** the model's reading of a whole list, as the service sends it: each named line's kind, and a table's columns */
export interface ListReply { lines: LineRead[]; cells?: ListCells }

/** the reading the app ties out: each line's kind, by its number, and a table's columns */
export interface ListReading extends ListLayout { reads: Map<number, LineRead> }

/**
 * How a list's lines are laid out: a table's columns as the model named them, and `cellRows`, the numbers of the lines
 * the app built from cells (a spreadsheet's rows, a paste's tab-separated lines). Only those lines are split at " | ";
 * every other line is text, taken as it is, whatever its characters (#1227).
 */
export interface ListLayout { cells?: ListCells; cellRows?: ReadonlySet<number> }

export const readingOf = (reply: ListReply, cellRows?: ReadonlySet<number>): ListReading => ({
  reads: new Map(reply.lines.map((r) => [r.n, r])),
  ...(reply.cells ? { cells: reply.cells } : {}),
  ...(cellRows?.size ? { cellRows } : {}),
});

/** an item, with the lines it came from */
export type ReadItem = ListItem & { lines: number[] };

export interface TiedOut {
  /** the items, in the input's order */
  items: ReadItem[];
  /** the lines left out, by number, in order: the model's "not an item", and lines it never placed */
  left: number[];
  /** each line left out as the file holds it, in the order of `left` */
  leftText: string[];
  /** how every line was accounted for; they add up to the number of lines */
  count: { lines: number; items: number; more: number; headings: number; blank: number; left: number };
}

/**
 * A cell as written in a line of a table of several columns: its backslashes and pipes are escaped, so that a " | " in
 * the cell's own text is never taken for the separator between cells (#1227).
 */
export const cellText = (cell: string): string => cell.replace(/[\\|]/g, '\\$&');

/**
 * A table as lines for the model: the heading row, then each row, its cells joined by " | ". The one cell of a table
 * of one column is the line as it is, with nothing escaped (#1227).
 */
export function tableLines(columns: string[], rows: string[][]): string[] {
  // a line break inside a cell would split the row, so it becomes a space; the cell's other characters are kept
  const written = columns.length > 1 ? cellText : (cell: string) => cell;
  const line = (r: string[]) => r.map((c) => written(String(c ?? '').replace(/\r\n?|\n/g, ' '))).join(' | ');
  return [line(columns), ...rows.map(line)];
}

/**
 * A table's rows as a spreadsheet copies them, line for line with `tableLines`: each row's cells separated by tabs, its
 * cells' own line breaks kept, and so are empty cells at the row's edges. A left-out row a person brings in comes in
 * so (decisions: Checklist; #1061).
 */
export function tableRowsAsWritten(columns: string[], rows: string[][]): string[] {
  const row = (r: string[]) => r.map((c) => String(c ?? '')).join('\t');
  return [row(columns), ...rows.map(row)];
}

/** Text as lines: every line break counts, so a line number means the same line to the person, the model and the app. */
export const textLines = (text: string): string[] => text.split(/\r\n?|\n/);

/** a table row's cells, as tableLines joins them, each as its own text (an escaped backslash or pipe undone) */
const rowCells = (line: string) => line.split(' | ').map(uncellText);
const uncellText = (cell: string) => cell.replace(/\\([\\|])/g, '$1');

/**
 * The cell a column names, as the source writes it: from the row's own tab-separated cells (`own`) when they are as
 * many as the line's, so that a line break in the cell stays, else from the line's. '' when the line is not a cell
 * row (the app did not build it from cells, `cellRows`) or the column is past the row.
 */
function cellAt(line: string, own: string, n: number, column: number | undefined, layout: ListLayout): string {
  if (!layout.cellRows?.has(n) || !column || column < 1) return '';
  const cells = rowCells(line);
  const ownCells = own.split('\t');
  return (ownCells.length === cells.length ? ownCells : cells)[column - 1] ?? '';
}

/**
 * The words a line's item or heading stands for, exactly as the source writes them, edge spaces and tabs included
 * (#1215): a line that is not a cell row whole (`own`, the line as `written` gives it), a cell row the cell the model's
 * columns name: the item column for an item, the heading or subheading column for a section or subsection row. '' when
 * there are none.
 */
function wordsOf(line: string, own: string, r: LineRead, layout: ListLayout): string {
  if (!layout.cellRows?.has(r.n)) return line.trim() ? own : '';
  const { cells } = layout;
  const column = r.k === 'item' ? cells?.item : r.k === 'section' ? cells?.heading : cells?.subheading;
  const cell = cellAt(line, own, r.n, column, layout);
  return key(cell) ? cell : '';
}

/** The lines that are not blank and have no usable reading: the ones to ask about again. */
export function unplaced(lines: string[], reading: ListReading): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (key(line) && !usable(line, reading.reads.get(i + 1), reading)) out.push(i + 1);
  });
  return out;
}

/**
 * The first reading, with the lines it left unplaced taken from a second reading of the whole list: what the first
 * placed is kept, and so are its columns. A line those columns cannot place stays unplaced.
 */
export function fillUnplaced(lines: string[], first: ListReading, second: ListReading): ListReading {
  const reads = new Map(first.reads);
  for (const n of unplaced(lines, first)) {
    const again = second.reads.get(n);
    if (again && usable(lines[n - 1], again, first)) reads.set(n, again);
  }
  return { ...first, reads };
}

/** a reading is usable when its kind is known and an item or heading has words in its line */
function usable(line: string, r: LineRead | undefined, layout: ListLayout): boolean {
  if (!r) return false;
  if (r.k === 'left' || r.k === 'columns' || r.k === 'more') return true;
  if (r.k !== 'item' && r.k !== 'section' && r.k !== 'subsection') return false;
  return !!wordsOf(line, line, r, layout).trim();
}

/**
 * Every line accounted for. `bringIn` holds lines left out that a person checked: each becomes an item where it sits,
 * under the heading above it, with its own words as the source writes them (`written`, line for line with `lines`:
 * a pasted line as pasted, a table row as `tableRowsAsWritten` gives it), as does the rest of an item on a line below
 * it and a line shown as left out (`leftText`). A reading that is not usable leaves its line out; a "more" line with no
 * item above it in the same section is left out too, never joined to an item it does not belong to.
 */
export function tieOut(
  lines: string[], reading: ListReading, bringIn: ReadonlySet<number> = new Set(), written = lines,
): TiedOut {
  const count = { lines: lines.length, items: 0, more: 0, headings: 0, blank: 0, left: 0 };
  const tied: TiedOut = { items: [], left: [], leftText: [], count };
  const at: TieState = { section: '', subsection: '', last: null };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!key(line)) {
      count.blank++;
      return;
    }
    const r = reading.reads.get(n);
    const own = written[i] ?? line;
    const placed = !!r && usable(line, r, reading) && place(tied, at, { line, own }, r, reading);
    if (placed) return;
    if (!bringIn.has(n)) {
      tied.left.push(n);
      tied.leftText.push(own);
      count.left++;
      return;
    }
    // a line brought in comes in exactly as written, its bullet or list number included
    addItem(tied, at, own, n);
    at.last = null;
  });
  return tied;
}

/** where a tie-out has got to: the headings over the next item, and the item a "more" line would join */
interface TieState {
  section: string;
  subsection: string;
  last: ReadItem | null;
}

/** a line as the model reads it, and as its source writes it */
interface SourceLine { line: string; own: string }

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
function place(tied: TiedOut, at: TieState, source: SourceLine, r: LineRead, layout: ListLayout): boolean {
  const { line, own } = source;
  if (r.k === 'left') return false;
  if (r.k === 'section' || r.k === 'subsection') {
    if (r.k === 'section') at.subsection = '';
    at[r.k] = wordsOf(line, own, r, layout);
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
    // the rest of the item as the source writes it, after a space (#1215)
    at.last.text = `${at.last.text} ${own}`;
    at.last.lines.push(r.n);
    tied.count.more++;
    return true;
  }
  rowHeadings(at, source, r.n, layout);
  addItem(tied, at, wordsOf(line, own, r, layout), r.n);
  return true;
}

/**
 * A table row's own section cell starts that section (and no subsection) for it and the rows under it, as a section
 * filled in only on the first row of each section is laid out; its subsection cell does the same within the section.
 */
function rowHeadings(at: TieState, { line, own }: SourceLine, n: number, layout: ListLayout) {
  const section = cellAt(line, own, n, layout.cells?.section, layout);
  const subsection = cellAt(line, own, n, layout.cells?.subsection, layout);
  if (key(section) && key(section) !== key(at.section)) {
    at.section = section;
    at.subsection = '';
  }
  if (key(subsection)) at.subsection = subsection;
}
