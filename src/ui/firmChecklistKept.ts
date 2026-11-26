/**
 * The checklist import kept on this PC as it changes, so the × or Escape, Back to the lists, a reload or a
 * restart loses nothing, the model's reading and review included: opening the import again picks it up where it was
 * left. A paste alone is kept as typed. "change" keeps the list too until another is read in its place; only "start
 * over", which asks first, or bringing the list in lets it go. While it is brought in nothing is written, and it is
 * let go only once the list is written (#931). The storage itself is in app/keptImports.ts.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ImportTable } from '../app/transfer';
import type { ListReading } from '../domain/listRead';
import type { ChecklistMapping } from '../domain/checklistImport';
import { LAYERS, type Layer } from '../domain/checklist';
import { keptImport, keepImport, dropImport, importKey } from '../app/keptImports';
import type { Asked, Review } from '../app/checklistImport';

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
 * paste box), the model's reading, the review, and every choice and check mark. A paste typed but not yet sent is kept on its
 * own.
 */
export interface ChecklistKept {
  paste?: string;
  table?: ImportTable | null;
  text?: { name: string; lines: string[] } | null;
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
  if (kept.reads && !(kept.reads.reads instanceof Map)) return false;
  return isKeptTable(kept.table) && isKeptReview(kept.review) && isKeptChoices(kept.choices);
}

/**
 * Where the import is kept, and what was left there. It is kept by the way in: a kept "Import a list…" never opens in
 * place of the list "Replace…" names, nor the other way round. `fresh` opens it fresh past a kept import it could not
 * show. `setAside` is true while a kept import that was not shown (`fresh`, or one that fails its shape check) is still
 * left as it is: nothing new has been typed or read in its place yet (#381). `holding` stops writes while the list is
 * brought in. The app lets the kept import go once the list is written.
 */
export function useKeeper(layer: Layer | undefined, name: string | undefined, fresh: boolean) {
  const key = importKey.checklist(layer, name);
  const [{ left, unreadable }] = useState(() => {
    const kept = fresh ? undefined : keptImport(key);
    const readable = isChecklistKept(kept);
    return { left: readable ? kept : null, unreadable: kept !== undefined && !readable };
  });
  const setAside = useRef(fresh || unreadable);
  const holding = useRef(false);
  return { key, left, setAside, holding };
}
export type Keeper = ReturnType<typeof useKeeper>;

/** The import's state now, as it is kept */
export interface KeptNow {
  paste: string;
  table: ImportTable | null;
  text: { name: string; lines: string[] } | null;
  reads: ListReading | null;
  review: Review | null;
  /** read when the import is written, as it is then */
  askedFor: { current: string };
  choices: Omit<ChecklistChoices, 'askedFor'>;
}

/** Writes the import as it changes, before the next frame. */
export function useKeepImport(keeper: Keeper, now: KeptNow) {
  const { key } = keeper;
  const { paste, table, text, reads, review, choices } = now;
  const keep = () => {
    if (keeper.holding.current) return;
    if (!table && !text) {
      keepPasteAlone(keeper, paste);
      return;
    }
    keeper.setAside.current = false;   // a list read in its place: what was set aside is written over whole
    const askedFor = now.askedFor.current;
    keepImport(key, { paste, table, text, reads, review, choices: { ...choices, askedFor } });
  };
  const { mapping, layer, name, askReword, askSame, shown } = choices;
  const { useReword, remove, readFailed, byColumns, bringIn } = choices;
  // written as soon as what is kept changes, before the next frame
  // biome-ignore lint/correctness/useExhaustiveDependencies: the parts kept are the dependencies
  useLayoutEffect(keep, [
    paste, table, text, reads, review, mapping, layer, name, askReword, askSame, shown, useReword, remove, readFailed,
    byColumns, bringIn,
  ]);
}

/** Before a list is read only the paste box is kept, as typed. */
function keepPasteAlone(keeper: Keeper, paste: string) {
  const { key } = keeper;
  // opened past a kept import it could not show: that one is left as it is until something is typed in its place,
  // which then replaces the whole of it, so no part of it is kept beside the new paste
  if (keeper.setAside.current) {
    if (!paste.trim()) return;
    const nothingElse = { table: null, text: null, reads: null, review: null, choices: undefined };
    const clearedHeading = keptImport(key)?.headingDraft != null ? { headingDraft: null } : {};
    keepImport(key, { paste, ...nothingElse, ...clearedHeading });
    keeper.setAside.current = false;
    return;
  }
  if (paste.trim() || keptImport(key)?.paste) keepImport(key, { paste });
}

/** Let go of the kept import: the list is brought in, or the person started over. */
export const dropKept = (keeper: Keeper) => dropImport(keeper.key);
