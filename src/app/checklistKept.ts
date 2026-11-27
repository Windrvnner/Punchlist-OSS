/**
 * The checklist import kept on this PC as it changes: what can be shown again, and what a paste or a list writes over
 * what was kept (#381). The storage itself is in keptImports.ts.
 */
import type { ImportTable } from './transfer';
import type { ListReading } from '../domain/listRead';
import type { ChecklistMapping } from '../domain/checklistImport';
import { LAYERS, type Layer } from '../domain/checklist';
import { keptImport, keepImport } from './keptImports';
import type { Asked, Review } from './checklistImport';
import type { ChecklistText } from './listRead';

/** Every choice and check mark, kept beside the list */
export interface ChecklistChoices {
  mapping: ChecklistMapping;
  layer: Layer;
  name: string;
  askReword: boolean;
  askSame: boolean;
  shown: boolean;
  askedFor: string;
  useReword: Set<number>;
  remove: Set<number>;
  readFailed: Asked | '';
  byColumns: boolean;
  bringIn: Set<number>;
}

/**
 * The checklist import as it was left: the list as given (a table, a document's or a paste's lines, and the
 * paste box), the model's reading, the review, and every choice and check mark. A paste typed but not yet sent is
 * kept on its own.
 */
export interface ChecklistKept {
  paste?: string;
  table?: ImportTable | null;
  text?: ChecklistText | null;
  reads?: ListReading | null;
  review?: Review | null;
  choices?: ChecklistChoices;
}

function isKeptTable(table: ImportTable | null | undefined) {
  return !table || (Array.isArray(table.rows) && Array.isArray(table.columns) && table.bytes instanceof Uint8Array);
}

function isKeptReview(review: Review | null | undefined) {
  if (!review) return true;
  return Array.isArray(review.items) && Array.isArray(review.rewords) && Array.isArray(review.pairs) && !!review.asked;
}

function isKeptChoices(choices: ChecklistChoices | undefined) {
  if (!choices) return true;
  const sets = choices.useReword instanceof Set && choices.remove instanceof Set && choices.bringIn instanceof Set;
  return LAYERS.includes(choices.layer) && typeof choices.name === 'string' && sets && !!choices.mapping;
}

/** Whether what was kept can be shown: a kept import that cannot be read opens fresh */
function isChecklistKept(value: unknown): value is ChecklistKept {
  const kept = value as ChecklistKept | undefined;
  if (!kept || typeof kept !== 'object') return false;
  if (kept.paste !== undefined && typeof kept.paste !== 'string') return false;
  if (kept.text && !Array.isArray(kept.text.lines)) return false;
  if (kept.reads && !(kept.reads instanceof Map) && !(kept.reads.reads instanceof Map)) return false;
  return isKeptTable(kept.table) && isKeptReview(kept.review) && isKeptChoices(kept.choices);
}

/**
 * A kept import from before a reading carried its table's columns holds its lines' readings as a bare Map by line
 * number. A text's lines are shown with that Map as the reading. A table's rows, and the lines of text pasted from a
 * spreadsheet (cells joined with " | "), cannot be worded without the columns the reading named, so the reading is
 * dropped and the list is read again, keeping its pasted text, table and choices, and no row is silently left out
 * (#1073).
 */
function inCurrentShape(kept: ChecklistKept): ChecklistKept {
  const marked = withCellRows(kept);
  const old: unknown = marked.reads;
  if (!(old instanceof Map)) return marked;
  const hasCells = marked.table || marked.text?.lines.some((line) => line.includes(' | '));
  return hasCells ? { ...marked, reads: null } : { ...marked, reads: { reads: old } };
}

/**
 * A kept text from before the app marked the lines it built from cells (`cellRows`) took those lines to be the ones
 * that hold " | "; that is the one place a line is taken for a row of cells by its characters, for what was kept then
 * (#1227).
 */
function withCellRows(kept: ChecklistKept): ChecklistKept {
  const text = kept.text;
  if (!text || text.cellRows) return kept;
  const cellRows = text.lines.flatMap((line, i) => (line.includes(' | ') ? [i + 1] : []));
  return { ...kept, text: { ...text, cellRows } };
}

/**
 * What was left where the import is kept. `fresh` opens it fresh past a kept import it could not show; `unreadable`
 * says a kept import failed its shape check and is left as it is.
 */
export function readKeptChecklist(key: string, fresh: boolean): { left: ChecklistKept | null; unreadable: boolean } {
  const kept = fresh ? undefined : keptImport(key);
  const readable = isChecklistKept(kept);
  return { left: readable ? inCurrentShape(kept) : null, unreadable: kept !== undefined && !readable };
}

/**
 * Writes the import as it is now. A list read in its place is written over whole. Before a list is read only the
 * paste box is kept, as typed. Returns whether a kept import that was not shown is still set aside (#381).
 */
export function keepChecklistImport(key: string, now: ChecklistKept & { paste: string }, setAside: boolean): boolean {
  const { paste, table, text } = now;
  if (!table && !text) return keepPasteAlone(key, paste, setAside);
  keepImport(key, { ...now });
  return false;
}

/** Before a list is read only the paste box is kept, as typed. */
function keepPasteAlone(key: string, paste: string, setAside: boolean): boolean {
  // opened past a kept import it could not show: that one is left as it is until something is typed in its place,
  // which then replaces the whole of it, so no part of it is kept beside the new paste
  if (setAside) {
    if (!paste.trim()) return true;
    const nothingElse = { table: null, text: null, reads: null, review: null, choices: undefined };
    const clearedHeading = keptImport(key)?.headingDraft != null ? { headingDraft: null } : {};
    keepImport(key, { paste, ...nothingElse, ...clearedHeading });
    return false;
  }
  if (paste.trim() || keptImport(key)?.paste) keepImport(key, { paste });
  return false;
}
