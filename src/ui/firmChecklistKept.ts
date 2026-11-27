/**
 * The checklist import kept on this PC as it changes, so the × or Escape, Back to the lists, a reload or a
 * restart loses nothing, the model's reading and review included: opening the import again picks it up where it was
 * left. A paste alone is kept as typed. "change" keeps the list too until another is read in its place; only "start
 * over", which asks first, or bringing the list in lets it go. While it is brought in nothing is written, and it is
 * let go only once the list is written (#931). What is kept and when it is written over is in app/checklistKept.ts.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ImportTable } from '../app/transfer';
import type { ChecklistText } from '../app/listRead';
import type { LineRead } from '../domain/listRead';
import type { Layer } from '../domain/checklist';
import { dropImport, importKey } from '../app/keptImports';
import type { Review } from '../app/checklistImport';
import { keepChecklistImport, readKeptChecklist, type ChecklistChoices } from '../app/checklistKept';

/**
 * Where the import is kept, and what was left there. It is kept by the way in: a kept "Import a list…" never opens in
 * place of the list "Replace…" names, nor the other way round. `fresh` opens it fresh past a kept import it could not
 * show. `setAside` is true while a kept import that was not shown (`fresh`, or one that fails its shape check) is still
 * left as it is: nothing new has been typed or read in its place yet (#381). `holding` stops writes while the list is
 * brought in. The app lets the kept import go once the list is written.
 */
export function useKeeper(layer: Layer | undefined, name: string | undefined, fresh: boolean) {
  const key = importKey.checklist(layer, name);
  const [{ left, unreadable }] = useState(() => readKeptChecklist(key, fresh));
  const setAside = useRef(fresh || unreadable);
  const holding = useRef(false);
  return { key, left, setAside, holding };
}
export type Keeper = ReturnType<typeof useKeeper>;

/** The import's state now, as it is kept */
export interface KeptNow {
  paste: string;
  table: ImportTable | null;
  text: ChecklistText | null;
  reads: Map<number, LineRead> | null;
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
    const kept = { paste, table, text, reads, review, choices: { ...choices, askedFor: now.askedFor.current } };
    keeper.setAside.current = keepChecklistImport(key, kept, keeper.setAside.current);
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

/** Let go of the kept import: the list is brought in, or the person started over. */
export const dropKept = (keeper: Keeper) => dropImport(keeper.key);
