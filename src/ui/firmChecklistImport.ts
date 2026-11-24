/**
 * What the checklist import (firmChecklist.tsx) remembers and does, one hook for each part: the work under way, the
 * list being read, its review, and leaving. Each part starts as it was kept, if it was (firmChecklistKept.ts). The
 * review's sums are in firmChecklistReview.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Store } from '../app/store';
import { readImportBytes, type ImportTable } from '../app/transfer';
import { bringIn as bringInList, undoBringIn } from '../app/checklistImport';
import { readList, readListFile, pastedLines } from '../app/listRead';
import { tieOut, tableLines, type LineRead, type TiedOut } from '../domain/listRead';
import { suggestChecklistColumns, prepareChecklist, type ChecklistMapping } from '../domain/checklistImport';
import type { ListItem } from '../domain/checklist';
import {
  NOT_DONE, askedAbout, broughtInSays, failedAs, itemsToBringIn, makeReview, toggled, withMissedPairs, withRewordings,
  type Asked, type ListTarget, type Review,
} from './firmChecklistReview';
import { dropKept, type ChecklistChoices, type ChecklistKept, type Keeper } from './firmChecklistKept';

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

/** The items as read: by the model, or by the columns chosen by hand. An item keeps no note of its lines once read */
function itemsAsRead(byColumns: boolean, table: ImportTable | null, mapping: ChecklistMapping, tied: TiedOut | null) {
  if (byColumns) return table ? prepareChecklist(table.rows, mapping) : null;
  if (!tied) return null;
  return { items: tied.items.map(({ lines: _, ...item }) => item), skipped: 0 };
}

/**
 * Step 1 and the list as read. Every list is read by the model first: a spreadsheet's rows, a
 * document's text or a pasted list, as lines. `byColumns` is the fallback for a table the model could not read: the
 * columns chosen by hand, as before.
 */
export function useListSource(store: Store, work: Work, left: ChecklistKept | null) {
  const file = useListFile(store, work, left);
  const { table, text, mapping, byColumns } = file;
  const lines = useMemo(
    () => (text ? text.lines : table ? tableLines(table.columns, table.rows) : null),
    [text, table],
  );
  const reading = useModelReading(store, work, lines, byColumns, left);
  const prepared = useMemo(
    () => itemsAsRead(byColumns, table, mapping, reading.tied),
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
  return { ...file, ...reading, lines, prepared, forget, reset };
}

const NO_MAPPING: ChecklistMapping = { item: null, section: null, subsection: null };

/**
 * The file or paste the list comes from. `text` is a document's or a paste's lines ('' names a paste); `paste` is what
 * is typed in the box, kept through "change" so nothing typed is lost.
 */
function useListFile(store: Store, work: Work, left: ChecklistKept | null) {
  const [table, setTable] = useState<ImportTable | null>(left?.table ?? null);
  const [mapping, setMapping] = useState<ChecklistMapping>(left?.choices?.mapping ?? NO_MAPPING);
  const [text, setText] = useState<{ name: string; lines: string[] } | null>(left?.text ?? null);
  const [paste, setPaste] = useState(left?.paste ?? '');
  const [byColumns, setByColumns] = useState(!!left?.choices?.byColumns);
  const take = (read: ImportTable) => {
    setTable(read);
    setMapping(suggestChecklistColumns(read.columns, read.rows));
  };
  const load = async (file: File) => {
    if (work.busy) return;
    const mine = work.begin('reading');
    const read = await readListFile(store, file);
    if (!work.isLatest(mine)) return;
    work.setBusy('');
    if (!read.ok) {
      work.setError(`Could not read ${file.name}: ${read.error.message}`);
      return;
    }
    setByColumns(false);
    if ('table' in read.value) {
      setText(null);
      take(read.value.table);
    } else {
      setTable(null);
      setText({ name: file.name, lines: read.value.lines });
    }
  };
  const reread = (opts: { sheet?: string; headerRow?: number }) => {
    if (!table || work.busy) return;
    void readTableAgain(store, work, table, byColumns ? opts : { ...opts, headerRow: 1 }, take);
  };
  // the fallback when the model could not read a table: its columns chosen by hand
  const chooseColumns = () => {
    if (!table) return;
    setByColumns(true);
    void readForColumns(store, work, table, take);
  };
  // what is pasted stays in the box until it is sent, and after "change"
  const pasted = () => {
    if (!paste.trim() || work.busy) return;
    setTable(null);
    setByColumns(false);
    work.setError('');
    setText({ name: '', lines: pastedLines(paste) });
  };
  const forget = () => {
    setTable(null);
    setText(null);
    setByColumns(false);
  };
  const reset = () => {
    forget();
    setPaste('');
    setMapping(NO_MAPPING);
  };
  return {
    table, mapping, setMapping, text, paste, setPaste, byColumns,
    load, reread, chooseColumns, pasted, forget, reset,
  };
}

/** Reads the sheet again, for its columns to be chosen by hand. */
async function readForColumns(store: Store, work: Work, table: ImportTable, take: (read: ImportTable) => void) {
  const mine = work.newToken();
  const read = await readImportBytes(store, table.name, table.bytes, { sheet: table.sheet });
  if (read.ok && work.isLatest(mine)) take(read.value);
}

/** Reads a table's file again for another sheet or heading row: an error is said in the footer, and the table kept. */
async function readTableAgain(
  store: Store, work: Work, table: ImportTable, opts: { sheet?: string; headerRow?: number },
  take: (read: ImportTable) => void,
) {
  const mine = work.newToken();
  const read = await readImportBytes(store, table.name, table.bytes, opts);
  if (!work.isLatest(mine)) return;
  if (!read.ok) {
    work.setError(`Could not read ${table.name}: ${read.error.message}`);
    return;
  }
  work.setError('');
  take(read.value);
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
    const read = await readList(store.services.ai, lines);
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
  const tiedBase = useMemo(() => (lines && reads ? tieOut(lines, reads) : null), [lines, reads]);
  const tied = useMemo(() => (lines && reads ? tieOut(lines, reads, bringIn) : null), [lines, reads, bringIn]);
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
  const { generalTexts } = target;
  const texts = prepared?.items.map((item) => item.text);
  const sig = texts ? askedAbout(texts, askReword, askSame, generalTexts) : '';
  sigNow.current = sig;
  const cached = review && askedFor.current === sig ? review : null;
  const canReword = can.reword;
  const canAskSame = can.sameMeaning;
  const needsCall = cached
    ? canAskSame && hasMissedDuplicates(cached)
    : (askReword && canReword) || (askSame && canAskSame);
  const retries = useReviewRetries(store, work, review, setReview, generalTexts);
  const waiting = !!texts?.length && needsCall && retries.pending;
  const toBringIn = useBringIn(store, work, target, keeper, { review, remove, useReword });

  // A model that cannot be asked leaves its part out and says so; the list can still be brought in.
  const next = async () => {
    if (!prepared || !texts?.length || !target.named || work.busy) return;
    if (cached) {
      if (needsCall) {
        const missedAt = cached.sameMissed?.at ?? texts.map((_, at) => at);
        if (!(await retries.askMissed(cached, texts, missedAt))) return;
      }
      if (sigNow.current === sig) setShown(true);
      return;
    }
    const replies = needsCall
      ? await retries.ask(() => askModel(store, texts, { askReword, askSame }, generalTexts))
      : [null, null] as const;
    if (!replies || sigNow.current !== sig) return;
    const [rewordReply, sameReply] = replies;
    work.setError('');
    const fresh = makeReview({
      items: prepared.items, earlierItems: target.replaces?.items, generalTexts, askReword, askSame,
      canReword, canAskSame, rewordReply, sameReply,
    });
    setReview(fresh.review);
    choices.setUseReword(fresh.checked);
    choices.setRemove(new Set());
    askedFor.current = sig;
    setShown(true);
  };
  return {
    ...choices, review, shown: made.shown, askedFor, waiting, ...toBringIn,
    next, retry: retries.retry, retryWording: retries.retryWording, reset, backToList: made.backToList,
  };
}

/** A duplicate check can leave some or all items unchecked. */
function hasMissedDuplicates(review: Review) {
  return !!review.sameMissed || review.asked.same === 'unreachable' || review.asked.same === 'failed';
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

/** The wording suggestions and the duplicates, each asked for only if checked and offered, both at once. */
function askModel(
  store: Store, texts: string[], ask: { askReword: boolean; askSame: boolean }, generalTexts: string[],
) {
  const { can } = store.get();
  const ai = store.services.ai;
  const rewording = ask.askReword && can.reword ? ai.reword!({ items: texts }) : null;
  const duplicates = ask.askSame && can.sameMeaning ? ai.sameMeaning!({ items: texts, against: generalTexts }) : null;
  return Promise.all([rewording, duplicates]);
}

/** A failed duplicate retry changes the reason for the rows it asked about (#378). */
function withFailedPairs(was: Review, reason: Asked): Review {
  if (!was.sameMissed) return { ...was, asked: { ...was.asked, same: reason } };
  const kind = reason === 'unreachable' ? reason : 'failed';
  return { ...was, sameMissed: { ...was.sameMissed, kind } };
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
  // The duplicate check missed some items last time (a part the service did not answer): Next asks about those alone
  // again, and adds what it finds.
  const askMissed = async (was: Review, texts: string[], missedAt: number[]) => {
    if (!can.sameMeaning) return false;
    const query = { items: texts, against: generalTexts, only: missedAt };
    const sameReply = await ask(() => store.services.ai.sameMeaning!(query));
    if (!sameReply) return false;
    const updated = sameReply.ok ? withMissedPairs(was, sameReply.value) : withFailedPairs(was, failedAs(sameReply));
    setReview(updated);
    const reason = NOT_DONE[updated.sameMissed?.kind ?? updated.asked.same];
    if (reason) work.setError(`${reason} again`);
    return true;
  };
  // Retry beside the duplicates line does what Back then Next does: asks about the missed items alone, or all of them
  // when the check failed outright, and keeps the review on screen while it waits. Back drops its answer: Next
  // asks again
  const retry = async () => {
    if (!review || work.busy || !can.sameMeaning) return;
    const missedAt = review.sameMissed?.at ?? review.items.map((_, at) => at);
    await askMissed(review, review.items.map((item) => item.text), missedAt);
  };
  // The wording suggestions failed (decisions: Retries): Retry asks for them again, and adds them unchecked beside any
  // taken last time.
  const retryWording = async () => {
    if (!review || !can.reword) return;
    const items = review.items.map((item) => item.text);
    const reply = await ask(() => store.services.ai.reword!({ items }));
    if (!reply) return;
    // failed again: the line gives this failure's reason, and the footer says it was asked again
    if (!reply.ok) {
      const reason = failedAs(reply);
      setReview({ ...review, asked: { ...review.asked, reword: reason } });
      work.setError(`${NOT_DONE[reason]} again`);
      return;
    }
    setReview(withRewordings(review, reply.value));
  };
  return { ask, pending, askMissed, retry, retryWording };
}

/** The items as checked in the review, and bringing them in. */
function useBringIn(
  store: Store, work: Work, target: ListTarget, keeper: Keeper,
  { review, remove, useReword }: { review: Review | null; remove: Set<number>; useReword: Set<number> },
) {
  const rewordAt = useMemo(
    () => new Map((review?.rewords ?? []).map((reword) => [reword.at, [reword.text, ...(reword.also ?? [])]])),
    [review],
  );
  const items = review ? itemsToBringIn(review, remove, useReword, rewordAt) : [];
  const run = async (fileName: string) => {
    if (!review || !items.length || work.busy) return;
    work.setBusy('importing');
    work.setError('');
    // let go of the kept import first, so a reload while it is brought in never offers it again; a failure keeps it
    // again
    keeper.holding.current = true;
    dropKept(keeper);
    const name = target.layer === 'broad' ? '' : target.name;
    const result = await bringInList(store, { layer: target.layer, name, items, file: fileName, fileDate: '' });
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
  return { rewordAt, items, run };
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
