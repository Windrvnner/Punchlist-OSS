/**
 * What the checklist import (firmChecklist.tsx) remembers and does, one hook for each part: the work under way, the
 * list being read, its review, and leaving. Each part starts as it was kept, if it was (firmChecklistKept.ts). The
 * review and model requests are in app/checklistImport.ts and app/listRead.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Store } from '../app/store';
import type { ImportTable } from '../app/transfer';
import {
  checklistReviewPlan, checklistSelection, failedAs, requestChecklistReview, reviewChecklist, retryChecklistDuplicates,
  retryChecklistWording, submitChecklist, undoBringIn, type Asked, type ListTarget, type Review,
} from '../app/checklistImport';
import {
  checklistItemsAsRead, checklistPaste, checklistReadCounts, checklistSourceLines, clearChecklistHeading,
  loadChecklistSource, readChecklist, readChecklistColumns, tieChecklistLines,
} from '../app/listRead';
import type { LineRead } from '../domain/listRead';
import type { ChecklistMapping } from '../domain/checklistImport';
import type { ListItem } from '../domain/checklist';
import { NOT_DONE, broughtInSays, toggled } from './firmChecklistReview';
import type { ChecklistChoices, ChecklistKept, Keeper } from './firmChecklistKept';

export type Busy = '' | 'reading' | 'asking' | 'reviewing' | 'importing';

/**
 * Each read or model call takes a new `token`. Leaving or going back bumps it too, so a late answer is dropped.
 * A retry can still be in flight after Back, while the person chooses and reads another source.
 */
export function useWork() {
  const [busy, setBusy] = useState<Busy>('');
  const [error, setError] = useState('');
  const token = useRef(0);
  /** a new token: any answer still to come for an older one is dropped */
  const newToken = () => ++token.current;
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
    setBusy('');
  };
  /** whether nothing newer has started, or the dialog been left, since `mine` began */
  const isLatest = (mine: number) => token.current === mine;
  return { busy, setBusy, error, setError, newToken, begin, drop, isLatest };
}
export type Work = ReturnType<typeof useWork>;

/**
 * Step 1 and the list as read. Every list is read by the model first: a spreadsheet's rows, a
 * document's text or a pasted list, as lines. `byColumns` is the fallback for a table the model could not read: the
 * columns chosen by hand, as before.
 */
export function useListSource(store: Store, work: Work, { key, left }: Keeper) {
  const file = useListFile(store, work, key, left);
  const { table, text, mapping, byColumns } = file;
  const lines = useMemo(() => checklistSourceLines(text, table), [text, table]);
  const reading = useModelReading(store, work, lines, byColumns, left);
  const prepared = useMemo(
    () => checklistItemsAsRead(byColumns, table, mapping, reading.tied),
    [byColumns, table, mapping, reading.tied],
  );
  /** back to the first step, the paste box as it was left */
  const forget = () => {
    file.forget();
    reading.forget();
  };
  /** for "start over": the list, its reading and every choice cleared */
  const reset = () => {
    file.reset();
    reading.reset();
  };
  const counts = checklistReadCounts(table, lines, file.pasteSource);
  return { ...file, ...reading, lines, prepared, counts, forget, reset };
}

const NO_MAPPING: ChecklistMapping = { item: null, section: null, subsection: null };

/**
 * The file or paste the list comes from. `text` is a document's or a paste's lines ('' names a paste); `paste` is what
 * is typed in the box, kept through "change" so nothing typed is lost.
 */
function useListFile(store: Store, work: Work, key: string, left: ChecklistKept | null) {
  const [table, setTable] = useState<ImportTable | null>(left?.table ?? null);
  const [mapping, setMapping] = useState<ChecklistMapping>(left?.choices?.mapping ?? NO_MAPPING);
  const [text, setText] = useState<{ name: string; lines: string[] } | null>(left?.text ?? null);
  const [paste, setPaste] = useState(left?.paste ?? '');
  const [byColumns, setByColumns] = useState(!!left?.choices?.byColumns);
  const [sheetRead, setSheetRead] = useState<{ sheet?: string }>();
  const pasteSource = useMemo(() => checklistPaste(paste), [paste]);
  const take = (read: ImportTable, suggested: ChecklistMapping) => {
    setTable(read);
    setMapping(suggested);
  };
  const resetHeading = () => {
    setByColumns(false);
    clearChecklistHeading(key);
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
    resetHeading();
  };
  const reread = async (opts: { sheet?: string; headerRow?: number }, accept?: (read: ImportTable) => void) => {
    if (!table || (work.busy && !(byColumns && work.busy === 'reading'))) return;
    if (byColumns && opts.headerRow === undefined) setSheetRead(opts);
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
    resetHeading();
  };
  const forget = () => {
    setTable(null);
    setText(null);
    setByColumns(false);
    setSheetRead(undefined);
  };
  const reset = () => {
    forget();
    setPaste('');
    setMapping(NO_MAPPING);
  };
  return {
    table, mapping, setMapping, text, paste, setPaste, pasteSource, byColumns, wantedSheet: sheetRead?.sheet,
    load, reread, chooseColumns, pasted, forget, reset, importKey: key,
  };
}

/** Applies a table read to the current screen, leaving the table in place if the read fails. */
async function updateTableRead(
  store: Store, work: Work, table: ImportTable, opts: { sheet?: string; headerRow?: number },
  byColumns: boolean,
  take: (read: ImportTable, suggested: ChecklistMapping) => void,
  onSettled?: () => void,
) {
  const mine = byColumns ? work.begin('reading') : work.newToken();
  const read = await readChecklistColumns(store, table, opts, byColumns);
  if (!work.isLatest(mine)) return;
  if (byColumns) work.setBusy('');
  onSettled?.();
  if (!read.ok) {
    work.setError(`Could not read ${table.name}: ${read.error.message}`);
    return;
  }
  work.setError('');
  take(read.value.table, read.value.mapping);
}

/**
 * The model's reading of the lines, tied out line by line. It reads the list as soon as there is one, and again for
 * another sheet; Retry asks again. `bringIn` holds the lines left out that a person checked to bring in.
 */
function useModelReading(
  store: Store, work: Work, lines: string[] | null, byColumns: boolean, left: ChecklistKept | null,
) {
  const [reads, setReads] = useState<Map<number, LineRead> | null>(left?.reads ?? null);
  const [readFailed, setReadFailed] = useState<Asked | ''>(left?.choices?.readFailed ?? '');
  const [bringIn, setBringIn] = useState<Set<number>>(left?.choices?.bringIn ?? new Set());
  const readNow = async () => {
    if (!lines || byColumns) return;
    const mine = work.begin('asking');
    setReads(null);
    setReadFailed('');
    const read = await readChecklist(store, lines);
    if (!work.isLatest(mine)) return;
    work.setBusy('');
    if (!read.ok) {
      setReadFailed(failedAs(read));
      return;
    }
    setReads(read.value);
    setBringIn(new Set());
  };
  // a list kept from before comes back as it was read: it is read again only if the reading had not come back
  const wasRead = useRef(!!left?.reads || !!left?.choices?.readFailed);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once for each list given, not on every render
  useEffect(() => {
    if (wasRead.current) {
      wasRead.current = false;
      return;
    }
    if (lines && !byColumns) void readNow();
  }, [lines, byColumns]);
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
  const { can } = store.get();
  const left = keeper.left;
  const choices = useReviewChoices(store, left?.choices);
  const { askReword, askSame, useReword, remove } = choices;
  const made = useMadeReview(work, left);
  const { review, setReview, setShown, askedFor } = made;
  /** for "start over": no review, and the choices as a new import starts them */
  const reset = () => {
    choices.reset();
    made.clear();
  };
  /** what the review would be asked about now, as the person last left the choices: one asked for others isn't shown */
  const sigNow = useRef('');
  const options = { askReword, askSame };
  const plan = prepared && checklistReviewPlan(can, prepared.items, target, options, review, askedFor.current);
  sigNow.current = plan?.signature ?? '';
  const retries = useReviewRetries(store, work, review, setReview, target.generalTexts);
  const waiting = !!plan?.texts.length && plan.needsCall && retries.pending;
  const toBringIn = useBringIn(store, work, target, keeper, { review, remove, useReword });

  const next = async () => {
    if (!prepared || !plan?.texts.length || !target.named || work.busy) return;
    const { texts, signature, cached, needsCall } = plan;
    if (cached) {
      if (needsCall && !(await retries.askMissed(cached, texts))) return;
      if (sigNow.current === signature) setShown(true);
      return;
    }
    const replies = needsCall
      ? await retries.ask(() => requestChecklistReview(store, texts, options, target.generalTexts))
      : [null, null] as const;
    if (!replies || sigNow.current !== signature) return;
    work.setError('');
    const fresh = reviewChecklist(can, prepared.items, target, options, replies);
    setReview(fresh.review);
    choices.setUseReword(fresh.checked);
    choices.setRemove(new Set());
    askedFor.current = signature;
    setShown(true);
  };
  return {
    ...choices, review, shown: made.shown, askedFor, waiting, ...toBringIn,
    next, retry: retries.retry, retryWording: retries.retryWording, reset, backToList: made.backToList,
  };
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

/** Fresh reviews and retries share one in-flight guard. Retries keep the person's check marks. */
function useReviewRetries(
  store: Store, work: Work, review: Review | null, setReview: (review: Review) => void, generalTexts: string[],
) {
  const { can } = store.get();
  // The ref guards same-frame presses. Only Next needs to know a model call is still pending after Back.
  const asking = useRef(false);
  const [pending, setPending] = useState(false);
  const ask = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
    if (work.busy || asking.current) return;
    asking.current = true;
    setPending(true);
    const mine = work.begin('reviewing');
    try {
      const reply = await call();
      if (work.isLatest(mine)) return reply;
    } finally {
      asking.current = false;
      setPending(false);
      if (work.isLatest(mine)) work.setBusy('');
    }
  };
  const askMissed = async (was: Review, texts?: string[]) => {
    if (!can.sameMeaning) return false;
    const result = await ask(() => retryChecklistDuplicates(store, was, generalTexts, texts));
    if (!result) return false;
    setReview(result.review);
    if (result.failure) work.setError(`${NOT_DONE[result.failure]} again`);
    return true;
  };
  const retry = async () => {
    if (review) await askMissed(review);
  };
  const retryWording = async () => {
    if (!review || !can.reword) return;
    const result = await ask(() => retryChecklistWording(store, review));
    if (!result) return;
    setReview(result.review);
    if (result.failure) work.setError(`${NOT_DONE[result.failure]} again`);
  };
  return { ask, pending, askMissed, retry, retryWording };
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
      keeper.keepNow.current();
      work.setError(`Couldn’t import: ${result.error.message}`);
      return;
    }
    store.ui({ firmChecklist: { step: 'lists' } });
    const said = broughtInSays(target.layer, target.name, result.value);
    const ids = result.value.opIds;
    const undo = () => void undoBringIn(store, ids).then((undone) => {
      store.toast(undone.ok ? 'Undone' : undone.error.message);
    });
    store.toast(said, { label: 'Undo All', run: undo });
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
