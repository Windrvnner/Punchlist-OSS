/**
 * What the checklist import (firmChecklist.tsx) remembers and does, one hook for each part: the work under way, the
 * list being read, its review, and leaving. Each part starts as it was kept, if it was (firmChecklistKept.ts). The
 * review and model requests are in app/checklistImport.ts and app/listRead.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Store } from '../app/store';
import type { ImportTable } from '../app/transfer';
import {
  checklistReviewSession, checklistSelection, failedAs, submitChecklist, undoBringIn,
  type Asked, type ChecklistReviewChange, type ListTarget, type Review,
} from '../app/checklistImport';
import {
  checklistItemsAsRead, checklistPaste, checklistOneColumn, checklistReadCounts, checklistReading, checklistRequests,
  checklistSourceLines, clearChecklistHeading, loadChecklistSource, rereadChecklistTable, tieChecklistLines,
} from '../app/listRead';
import type { ListReading } from '../domain/listRead';
import type { ChecklistMapping } from '../domain/checklistImport';
import type { ListItem } from '../domain/checklist';
import { NOT_DONE, broughtInSays, toggled } from './firmChecklistReview';
import type { Keeper } from './firmChecklistKept';
import type { ChecklistChoices, ChecklistKept } from '../app/checklistKept';

export type Busy = '' | 'reading' | 'asking' | 'reviewing' | 'importing';

/**
 * Each read or model call takes a new `token`. Leaving or going back bumps it too, so a late answer is dropped.
 * A retry can still be in flight after Back, while the person chooses and reads another source.
 */
export function useWork() {
  const [busy, setBusy] = useState<Busy>('');
  const [error, setError] = useState('');
  const [requests] = useState(checklistRequests);
  const { newToken } = requests;
  /** a new read or call: says what it is doing, clears the error, and returns its token */
  const begin = (doing: Busy) => {
    const mine = newToken();
    setBusy(doing);
    setError('');
    return mine;
  };
  /** Drops the pending answer and clears the activity associated with it. */
  const drop = () => {
    newToken();
    requests.dropTableReads();
    setBusy('');
  };
  return { busy, setBusy, error, setError, ...requests, begin, drop };
}
export type Work = ReturnType<typeof useWork>;

/**
 * Step 1 and the list as read. Every list is read by the model first: a spreadsheet's rows, a
 * document's text or a pasted list, as lines. `byColumns` is the fallback for a table the model could not read: the
 * columns chosen by hand, as before. The paste stays as typed even when another source is shown.
 */
export function useListSource(store: Store, work: Work, keeper: Keeper) {
  const { left } = keeper;
  const [paste, setPaste] = useState(left?.paste ?? '');
  const pasteSource = useMemo(() => checklistPaste(paste), [paste]);
  const file = useListFile(store, work, keeper, pasteSource);
  const { table, text, mapping, byColumns } = file;
  const lines = useMemo(() => checklistSourceLines(text, table), [text, table]);
  const oneColumn = checklistOneColumn(text, table);
  const reading = useModelReading(store, work, lines, byColumns, left, oneColumn);
  const prepared = useMemo(
    () => checklistItemsAsRead(byColumns, table, mapping, reading.tied),
    [byColumns, table, mapping, reading.tied],
  );
  const reread: typeof file.reread = (opts, accept) => file.reread(opts, (read) => {
    if (!byColumns) reading.forget();
    accept?.(read);
  });
  /** back to the first step, the paste box as it was left */
  const forget = () => {
    file.forget();
    reading.forget();
  };
  /** for "start over": the list, its reading and every choice cleared */
  const reset = () => {
    file.reset();
    setPaste('');
    reading.reset();
  };
  const counts = checklistReadCounts(table, lines, pasteSource);
  return { ...file, ...reading, lines, paste, setPaste, prepared, counts, reread, forget, reset };
}

const NO_MAPPING: ChecklistMapping = { item: null, section: null, subsection: null };

/** The selected file or paste and the choice of spreadsheet columns. An empty text name identifies a paste. */
function useListFile(store: Store, work: Work, { key, left }: Keeper, pasteSource: ReturnType<typeof checklistPaste>) {
  const [table, setTable] = useState<ImportTable | null>(left?.table ?? null);
  const [mapping, setMapping] = useState<ChecklistMapping>(left?.choices?.mapping ?? NO_MAPPING);
  const [text, setText] = useState<{ name: string; lines: string[] } | null>(left?.text ?? null);
  const [byColumns, setByColumns] = useState(!!left?.choices?.byColumns);
  const [sheetRead, setSheetRead] = useState<{ sheet?: string }>();
  const take = (read: ImportTable, suggested: ChecklistMapping) => {
    setTable(read);
    setMapping(suggested);
  };
  const load = async (file: File) => {
    if (work.busy) return;
    const mine = work.begin('reading');
    const read = await loadChecklistSource(store, file);
    if (!work.isLatest(mine)) return;
    work.setBusy('');
    if (!read.ok) {
      work.setError(`Could not read ${file.name}: ${read.error.message}`);
      return;
    }
    if ('table' in read.value) {
      setText(null);
      take(read.value.table, read.value.mapping);
    } else {
      setTable(null);
      setText(read.value.text);
    }
    resetFileHeading(key, setByColumns);
  };
  const reread = async (opts: { sheet?: string; headerRow?: number }, accept?: (read: ImportTable) => void) => {
    if (!table || (work.busy && !(byColumns && work.busy === 'reading'))) return;
    if (opts.headerRow === undefined) setSheetRead(opts);
    await updateTableRead(store, work, table, opts, byColumns, (read, suggested) => {
      take(read, suggested);
      accept?.(read);
    });
    setSheetRead((latest) => latest === opts ? undefined : latest);
  };
  // the fallback when the model could not read a table: its columns chosen by hand
  const chooseColumns = () => {
    if (!table || work.busy) return;
    // Wait for heading detection before showing the editable row (#380).
    void updateTableRead(store, work, table, { sheet: table.sheet }, true, take, () => setByColumns(true));
  };
  // what is pasted stays in the box until it is sent, and after "change"
  const pasted = () => {
    if (!pasteSource || work.busy) return;
    setTable(null);
    work.setError('');
    setText(pasteSource);
    resetFileHeading(key, setByColumns);
  };
  const forget = () => {
    setTable(null);
    setText(null);
    setByColumns(false);
    setSheetRead(undefined);
  };
  const reset = () => {
    forget();
    setMapping(NO_MAPPING);
  };
  return {
    table, mapping, setMapping, text, byColumns, wantedSheet: sheetRead?.sheet,
    load, reread, chooseColumns, pasted, forget, reset, importKey: key,
  };
}

function resetFileHeading(key: string, setByColumns: (byColumns: boolean) => void) {
  setByColumns(false);
  clearChecklistHeading(key);
}

/** Applies a table read to the current screen, leaving the table in place if the read fails. */
async function updateTableRead(
  store: Store, work: Work, table: ImportTable, opts: { sheet?: string; headerRow?: number },
  byColumns: boolean,
  take: (read: ImportTable, suggested: ChecklistMapping) => void,
  onSettled?: () => void,
) {
  await rereadChecklistTable(store, work, table, opts, byColumns, {
    started: () => {
      work.setBusy('reading');
      work.setError('');
    },
    finished: (read) => {
      work.setBusy('');
      onSettled?.();
      if (!read.ok) {
        work.setError(`Could not read ${opts.sheet ?? table.name}: ${read.error.message}`);
        return;
      }
      take(read.value.table, read.value.mapping);
    },
  });
}

/**
 * The model's reading of the lines, tied out line by line. It reads the list as soon as there is one, and again for
 * another sheet; Retry asks again. `bringIn` holds the lines left out that a person checked to bring in.
 */
function useModelReading(
  store: Store, work: Work, lines: string[] | null, byColumns: boolean, left: ChecklistKept | null, oneColumn: boolean,
) {
  const [reads, setReads] = useState<ListReading | null>(left?.reads ?? null);
  const [readFailed, setReadFailed] = useState<Asked | ''>(left?.choices?.readFailed ?? '');
  const [bringIn, setBringIn] = useState<Set<number>>(left?.choices?.bringIn ?? new Set());
  const [reading] = useState(() => checklistReading(store, work, {
    reads: left?.reads, readFailed: left?.choices?.readFailed,
  }));
  const events: Parameters<typeof reading.retry>[2] = {
    started: () => {
      work.setBusy('asking');
      work.setError('');
      setReads(null);
      setReadFailed('');
    },
    finished: (read) => {
      work.setBusy('');
      if (!read.ok) {
        setReadFailed(failedAs(read));
        return;
      }
      setReads(read.value);
      setBringIn(new Set());
    },
  };
  const readNow = () => reading.retry(lines, byColumns, events, oneColumn);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each change of source goes to the same app session
  useEffect(() => { void reading.sourceChanged(lines, byColumns, events, oneColumn); }, [lines, byColumns]);
  /** the lines the model left out, before any is checked to bring in: the "Left out" list */
  const tiedBase = useMemo(() => tieChecklistLines(lines, reads), [lines, reads]);
  const tied = useMemo(() => tieChecklistLines(lines, reads, bringIn), [lines, reads, bringIn]);
  const flipBringIn = (line: number) => setBringIn(toggled(bringIn, line));
  const forget = () => {
    setReads(null);
    setReadFailed('');
  };
  const reset = () => {
    forget();
    setBringIn(new Set());
  };
  return { reads, readFailed, bringIn, tied, tiedBase, readNow, flipBringIn, forget, reset };
}
export type ListSource = ReturnType<typeof useListSource>;

/**
 * Step 2's review and bringing the list in. Back from the review keeps it, check marks and all: Next shows it again unless
 * what it was asked about has changed.
 */
export function useListReview(
  store: Store, work: Work, prepared: { items: ListItem[] } | null, target: ListTarget, keeper: Keeper,
) {
  const left = keeper.left;
  const choices = useReviewChoices(store, left?.choices);
  const { askReword, askSame, useReword, remove } = choices;
  const made = useMadeReview(work, left);
  const { review, setReview, setShown, askedFor } = made;
  const session = useReviewSession(store, work);
  const plan = session.plan(prepared?.items ?? null, target, { askReword, askSame }, review, askedFor.current);
  const toBringIn = useBringIn(store, work, target, keeper, { review, remove, useReword });

  const show = (change: ChecklistReviewChange) => {
    if (change.kind === 'fresh') {
      work.setError('');
      setReview(change.review);
      choices.setUseReword(change.checked);
      choices.setRemove(new Set());
      askedFor.current = change.signature;
    }
    if (change.kind === 'retry') {
      setReview(change.review);
      if (change.failure) work.setError(`${NOT_DONE[change.failure]} again`);
    }
    if (change.kind !== 'retry' || change.open) setShown(true);
  };
  const next = () => {
    if (plan && !work.busy) return session.next(plan, show);
  };
  const retry = () => {
    if (review && !work.busy) return session.duplicates(review, target.generalTexts, show);
  };
  const retryWording = () => {
    if (review && !work.busy) return session.wording(review, show);
  };
  const reset = () => {
    choices.reset();
    made.clear();
  };
  return {
    ...choices, review, shown: made.shown, askedFor, waiting: plan?.waiting ?? false, ...toBringIn,
    next, retry, retryWording, reset, backToList: made.backToList,
  };
}

/** Pending changes redraw the footer even after Back clears the screen's busy state. */
function useReviewSession(store: Store, work: Work) {
  const [, setPending] = useState(false);
  const [session] = useState(() => checklistReviewSession(store, work, {
    started: () => {
      setPending(true);
      work.setBusy('reviewing');
      work.setError('');
    },
    settled: (isCurrent) => {
      setPending(false);
      if (isCurrent) work.setBusy('');
    },
  }));
  return session;
}

/** The review as last made, whether it is on screen, and what it was asked about. */
function useMadeReview(work: Work, left: ChecklistKept | null) {
  const [review, setReview] = useState<Review | null>(left?.review ?? null);
  const [shown, setShown] = useState(!!left?.choices?.shown);
  const askedFor = useRef(left?.choices?.askedFor ?? '');
  /** Back from the review: drops any answer still to come, and keeps the review for Next */
  const backToList = () => {
    work.drop();
    setShown(false);
    work.setError('');
  };
  const clear = () => {
    setReview(null);
    setShown(false);
    askedFor.current = '';
  };
  return { review, setReview, shown, setShown, askedFor, backToList, clear };
}

/** What the review asks for, and the rewordings and removals checked in it. */
function useReviewChoices(store: Store, kept: ChecklistChoices | undefined) {
  const { can } = store.get();
  const [askReword, setAskReword] = useState(kept ? kept.askReword : can.reword);
  const [askSame, setAskSame] = useState(kept?.askSame ?? true);
  const [useReword, setUseReword] = useState<Set<number>>(kept?.useReword ?? new Set());
  const [remove, setRemove] = useState<Set<number>>(kept?.remove ?? new Set());
  const flipReword = (at: number) => setUseReword(toggled(useReword, at));
  const flipRemove = (at: number) => setRemove(toggled(remove, at));
  const reset = () => {
    setAskReword(can.reword);
    setAskSame(true);
    setUseReword(new Set());
    setRemove(new Set());
  };
  return {
    askReword, setAskReword, askSame, setAskSame, useReword, setUseReword, remove, setRemove,
    flipReword, flipRemove, reset,
  };
}

/** The items as checked in the review, and bringing them in. */
function useBringIn(
  store: Store, work: Work, target: ListTarget, keeper: Keeper,
  { review, remove, useReword }: { review: Review | null; remove: Set<number>; useReword: Set<number> },
) {
  const selection = useMemo(() => checklistSelection(review, remove, useReword), [review, remove, useReword]);
  const run = async (fileName: string) => {
    if (!review || !selection.counts.items || work.busy) return;
    work.setBusy('importing');
    work.setError('');
    keeper.holding.current = true;
    const result = await submitChecklist(store, keeper.key, target, selection.items, fileName);
    work.setBusy('');
    keeper.holding.current = false;
    if (!result.ok) {
      work.setError(`Couldn’t import: ${result.error.message}`);
      return;
    }
    store.ui({ firmChecklist: { step: 'lists' } });
    const said = broughtInSays(target.layer, target.name, result.value);
    const ids = result.value.opIds;
    const undo = () => void undoBringIn(store, ids).then((undone) => {
      store.toast(undone.ok ? 'Undone' : undone.error.message, undone.ok ? 'done' : 'warn');
    });
    store.toast(said, 'done', { label: 'Undo All', run: undo });
  };
  return { counts: selection.counts, run };
}
export type ListReview = ReturnType<typeof useListReview>;

/**
 * Leaving the import, and starting over. Leaving loses nothing, as the import is kept (firmChecklistKept.ts), so it
 * does not ask first; "start over", which clears it, does.
 */
export function useLeaving(store: Store, work: Work) {
  // "start over" asks first, in place of the footer's buttons
  const [restart, setRestart] = useState(false);
  const back = () => {
    work.newToken();
    store.ui({ firmChecklist: { step: 'lists' } });
  };
  // while it is brought in, the dialog stays: a held Escape or a double click on the × does not close it
  const close = () => {
    if (work.busy === 'importing') return;
    work.newToken();
    store.ui({ firmChecklist: null });
  };
  return { restart, setRestart, back, close };
}
export type Leaving = ReturnType<typeof useLeaving>;
