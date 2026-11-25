/**
 * A list read by the model, tied out line by line. The input, pasted text, a document or a table, is a list of
 * lines. The model says what each line is; the app checks every answer against the line itself and accounts for every
 * line: an item (or the rest of the item above it), a heading, a table's own heading row, a blank, or a line left out.
 * A line the model did not account for, or answered with words the line does not hold, is unplaced: it is asked about
 * again and, if still unplaced, left out. Nothing in the input is dropped: a line left out is listed, and a person can
 * bring it in where it sits.
 */
import { key, norm, type ListItem } from './checklist';

/** what the model says a line is; `text` is the part of the line it takes, as the line has it */
export interface LineRead {
  /** the line's number, from 1 */
  n: number;
  /** section or subsection: a heading; item: a new item; more: the rest of the item above (a wrapped line); columns: a table's heading row; left: not an item */
  k: 'section' | 'subsection' | 'item' | 'more' | 'columns' | 'left';
  text?: string;
  /** a table row's own section and subsection cells, when it has them */
  section?: string;
  subsection?: string;
}

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
  const line = (r: string[]) => r.map((c) => String(c ?? '').replace(/\s+/g, ' ').trim()).join(' | ');
  return [line(columns), ...rows.map(line)];
}

/** Text as lines: every line break counts, so a line number means the same line to the person, the model and the app. */
export const textLines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n');

/** a word of a line's leading label: a number, letter, roman numeral or bullet, or a word such as "Section" before one */
const LABEL = /^((section|part|article|schedule|annex|exhibit|appendix|item)|[-•*–—:.()[\]0-9]+|\(?([a-z]|[ivxlc]+)\)?[.):]?|\d+(\.\d+)*[a-z]?[.):]?)$/i;

/**
 * Whether `part` is all of the line's words, case, spacing and quotes aside: for a table row ("a | b"), one whole cell;
 * otherwise the whole line, but for a leading number, letter or bullet ("1.2", "a)", "Section 3:"). So an item the model
 * shortened is not taken as accounted for with words of its line missing.
 */
function holds(line: string, part: string): boolean {
  const p = key(part); if (!p) return false;
  const cells = line.split(' | ');
  if (cells.length > 1) return cells.some((c) => key(c) === p);
  const l = key(line); if (!l.endsWith(p)) return false;
  return l.slice(0, l.length - p.length).split(/\s+/).filter(Boolean).every((w) => LABEL.test(w));
}

/**
 * The lines that are not blank and have no usable reading: the ones to ask about again. A reading is usable when its kind
 * is known and any words it takes (an item, a heading, a table row's section) are in the line.
 */
export function unplaced(lines: string[], reads: ReadonlyMap<number, LineRead>): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => { if (key(line) && !usable(line, reads.get(i + 1))) out.push(i + 1); });
  return out;
}

function usable(line: string, r: LineRead | undefined): boolean {
  if (!r) return false;
  if (r.k === 'left' || r.k === 'columns' || r.k === 'more') return true;
  if (r.k !== 'item' && r.k !== 'section' && r.k !== 'subsection') return false;
  if (!r.text || !holds(line, r.text)) return false;
  return (!r.section || holds(line, r.section)) && (!r.subsection || holds(line, r.subsection));
}

/**
 * Every line accounted for. `bringIn` holds lines left out that a person checked: each becomes an item where it sits,
 * under the heading above it, with its own words. A reading that is not usable leaves its line out; a "more" line with
 * no item above it in the same section is left out too, never joined to an item it does not belong to.
 */
export function tieOut(lines: string[], reads: ReadonlyMap<number, LineRead>, bringIn: ReadonlySet<number> = new Set()): TiedOut {
  const items: ReadItem[] = []; const left: number[] = [];
  const count = { lines: lines.length, items: 0, more: 0, headings: 0, blank: 0, left: 0 };
  let section = ''; let subsection = ''; let last: ReadItem | null = null;
  const add = (text: string, n: number, s = section, sub = subsection) => {
    last = { text: norm(text), lines: [n], ...(s ? { section: s } : {}), ...(sub ? { subsection: sub } : {}) }; items.push(last); count.items++;
  };
  lines.forEach((line, i) => {
    const n = i + 1;
    if (!key(line)) { count.blank++; return; }
    const r = reads.get(n);
    if (!usable(line, r)) { leave(n); return; }
    if (r!.k === 'section') { section = norm(r!.text!); subsection = ''; last = null; count.headings++; return; }
    if (r!.k === 'subsection') { subsection = norm(r!.text!); last = null; count.headings++; return; }
    if (r!.k === 'columns') { count.headings++; return; }
    if (r!.k === 'more') {
      if (!last) { leave(n); return; }
      const it: ReadItem = last; it.text = norm(`${it.text} ${line}`); it.lines.push(n); count.more++; return;
    }
    if (r!.k === 'item') {
      // a table row's own section cell starts that section (and no subsection) for it and the rows under it, as a section
      // filled in only on the first row of each section is laid out; its subsection cell does the same within the section
      const s = norm(r!.section ?? ''); const sub = norm(r!.subsection ?? '');
      if (s && s !== section) { section = s; subsection = ''; }
      if (sub) subsection = sub;
      add(r!.text!, n);
      return;
    }
    leave(n);
  });
  return { items, left, count };

  function leave(n: number) {
    // a line brought in keeps its words; only a leading bullet or number goes, as the model leaves those off an item
    if (bringIn.has(n)) { add(lines[n - 1].trim().replace(/^([-•*]+|\d+(\.\d+)*[.)]?|[a-z]\))\s+/i, '') || lines[n - 1], n); last = null; return; }
    left.push(n); count.left++;
  }
}
