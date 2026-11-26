/**
 * The checklist import kept on this PC as it changes: what can be shown again, and what a paste or a list writes over
 * what was kept (#381). The storage itself is in keptImports.ts.
 */
import type { ImportTable } from './transfer';
import type { LineRead } from '../domain/listRead';
import type { ChecklistMapping } from '../domain/checklistImport';
import { LAYERS, type Layer } from '../domain/checklist';
import { keptImport, keepImport } from './keptImports';
import type { Asked, Review } from './checklistImport';

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
  text?: { name: string; lines: string[] } | null;
  reads?: Map<number, LineRead> | null;
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
  if (kept.reads && !(kept.reads instanceof Map)) return false;
  return isKeptTable(kept.table) && isKeptReview(kept.review) && isKeptChoices(kept.choices);
}

/**
 * What was left where the import is kept. `fresh` opens it fresh past a kept import it could not show; `unreadable`
 * says a kept import failed its shape check and is left as it is.
 */
export function readKeptChecklist(key: string, fresh: boolean): { left: ChecklistKept | null; unreadable: boolean } {
  const kept = fresh ? undefined : keptImport(key);
  const readable = isChecklistKept(kept);
  return { left: readable ? kept : null, unreadable: kept !== undefined && !readable };
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
