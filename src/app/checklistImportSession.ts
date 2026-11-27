import { firmOf, LAYER_NAMES, type Layer } from '../domain/checklist';
import type { ChecklistMapping } from '../domain/checklistImport';
import type { ListReading } from '../domain/listRead';
import {
  checklistReviewSession, checklistSelection, checklistWordingChoices, failedAs, listTarget, submitChecklist,
  type ChecklistReviewChange, type ListTarget, type Review,
} from './checklistImport';
import { keepChecklistImport, readKeptChecklist, type ChecklistChoices } from './checklistKept';
import { NOT_DONE, showChecklistOutcome } from './checklistOutcome';
import { dropImport, importKey } from './keptImports';
import {
  checklistCellRows, checklistItemsAsRead, checklistPaste, checklistReadCounts, checklistReading, checklistRequests,
  checklistSourceLines, checklistWrittenLines, clearChecklistHeading, loadChecklistSource, rereadChecklistTable,
  tieChecklistLines, type ChecklistText,
} from './listRead';
import type { Store } from './store';
import type { ImportLocation, ImportTable } from './transfer';

type Busy = '' | 'reading' | 'asking' | 'reviewing' | 'importing';
type Initial = { layer?: Layer; name?: string; fresh?: boolean };
type SourceFile = Parameters<typeof loadChecklistSource>[1];

/** `set` with `at` added, or taken out if it was in */
function toggled(set: Set<number>, at: number): Set<number> {
  const next = new Set(set);
  if (next.has(at)) next.delete(at);
  else next.add(at);
  return next;
}

function initialChoices(initial: Initial, reword: boolean): ChecklistChoices {
  return {
    layer: initial.layer ?? 'broad', name: initial.name ?? '', mapping: { item: null, section: null, subsection: null },
    askReword: reword, askSame: true, shown: false, askedFor: '', byColumns: false, readFailed: '',
    bringIn: new Set(), useReword: new Set(), remove: new Set(),
  };
}

function whyNoNext(target: ListTarget, choices: ChecklistChoices) {
  if (choices.readFailed && !choices.byColumns) return 'The list was not read';
  if (!target.named) return `Name the ${LAYER_NAMES[target.layer].one.toLowerCase()}, as deals will pick it`;
  if (target.split) return `${target.splitSays}. Choose one first`;
}

// Keep the large source and its selection stable across unrelated field, activity and store changes.
function lastCalculation<A extends unknown[], R>(calculate: (...args: A) => R) {
  let previous: A | undefined;
  let result: R;
  return (...args: A) => {
    if (!previous || args.some((value, at) => value !== previous![at])) {
      result = calculate(...args);
      previous = args;
    }
    return result;
  };
}

function readPreview(
  text: ChecklistText | null, table: ImportTable | null, lines: string[] | null, reads: ListReading | null,
  bringIn: Set<number>, mapping: ChecklistMapping, byColumns: boolean,
) {
  const written = checklistWrittenLines(text, table);
  const tiedBase = tieChecklistLines(lines, reads);
  const tied = tieChecklistLines(lines, reads, bringIn, written);
  const prepared = checklistItemsAsRead(byColumns, table, mapping, tied);
  const preview = byColumns ? prepared?.items.slice(0, 5) ?? [] : tied?.items.slice(0, 5) ?? [];
  return { tiedBase, tied, prepared, preview,
    withSection: preview.some((row) => row.section), withSub: preview.some((row) => row.subsection) };
}

/** A single import, from its original file or paste through the reviewed list and its Undo All. */
export class ChecklistImportSession {
  private readonly key: string;
  private setAside: boolean;
  private paste: string;
  private text: ChecklistText | null;
  private table: ImportTable | null;
  private reads: ListReading | null;
  private review: Review | null;
  private choices: ChecklistChoices;
  private lines: string[] | null;
  // Each file read, model reply and sheet read takes a token. Only the latest token's result is used.
  private readonly requests = checklistRequests();
  private readonly reader: ReturnType<typeof checklistReading>;
  private readonly reviewer: ReturnType<typeof checklistReviewSession>;
  private readonly preview = lastCalculation(readPreview);
  private readonly pastedSource = lastCalculation(checklistPaste);
  private readonly selection = lastCalculation(checklistSelection);
  private snapshot?: ReturnType<ChecklistImportSession['buildView']>;
  private listeners = new Set<() => void>();
  private stopWatching?: () => void;
  private live = true;
  private choosing = false;
  private sheetRead?: ImportLocation;
  private busy: Busy = '';
  private error = '';

  constructor(private store: Store, private initial: Initial) {
    this.key = importKey.checklist(initial.layer, initial.name);
    const { left, unreadable } = readKeptChecklist(this.key, !!initial.fresh);
    this.setAside = !!initial.fresh || unreadable;
    this.paste = left?.paste ?? '';
    this.table = left?.table ?? null;
    this.text = left?.text ?? null;
    this.reads = left?.reads ?? null;
    this.review = left?.review ?? null;
    this.choices = { ...initialChoices(initial, store.get().can.reword), ...left?.choices };
    this.lines = checklistSourceLines(this.text, this.table);
    this.reader = checklistReading(store, this.requests, { reads: this.reads, readFailed: this.choices.readFailed });
    this.reviewer = checklistReviewSession(store, this.requests, {
      started: () => this.activity('reviewing'),
      settled: (current) => {
        if (current) this.busy = '';
        this.notify();
      },
    });
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start() {
    let before = this.store.get();
    this.stopWatching = this.store.subscribe((state) => {
      const changed = before.firmList !== state.firmList || before.conflicts !== state.conflicts;
      before = state;
      if (changed) this.notify();
    });
    return this.readSource();
  }

  dispose = () => {
    this.live = false;
    this.requests.newToken();
    this.stopWatching?.();
    this.listeners.clear();
  };

  private keep() {
    if (!this.live) return;
    const { paste, table, text, reads, review, choices } = this;
    const draft = { paste, table, text, reads, review, choices };
    this.setAside = keepChecklistImport(this.key, draft, this.setAside);
    this.notify();
  }

  private activity(busy: Busy, error = '') {
    this.busy = busy;
    this.error = error;
    this.notify();
  }

  private get target() {
    const state = this.store.get();
    return listTarget(state, firmOf(state.firmList), this.choices.layer, this.choices.name);
  }

  private get source() {
    const { text, table, reads, lines, paste, choices } = this;
    const { mapping, byColumns, readFailed, bringIn } = choices;
    const preview = this.preview(text, table, lines, reads, bringIn, mapping, byColumns);
    const counts = checklistReadCounts(table, lines, this.pastedSource(paste));
    return {
      text, table, reads, lines, paste, mapping, byColumns, readFailed, bringIn, counts, ...preview,
      wantedSheet: this.sheetRead?.sheet, importKey: this.key,
      setPaste: this.setPaste, pasted: this.pasted, load: this.load, reread: this.reread, pickColumn: this.pickColumn,
      readNow: this.readNow, chooseColumns: this.chooseColumns, flipBringIn: this.flipBringIn,
    };
  }

  private plan(source: typeof this.source, target: ListTarget) {
    return this.reviewer.plan(source.prepared?.items ?? null, target, this.choices, this.review, this.choices.askedFor);
  }

  private notify() {
    if (!this.live) return;
    // A reply still in flight must see the latest source, options and general list even with no window open.
    if (this.choosing && !this.target.split) this.choosing = false;
    this.snapshot = this.buildView();
    for (const listener of this.listeners) listener();
  }

  private get step() {
    if (!this.table && !this.text) return 'pick';
    if (this.choosing && this.target.split) return 'choose';
    if (this.review && this.choices.shown) return 'review';
    return this.choices.byColumns ? 'columns' : 'read';
  }

  get view() {
    return this.snapshot ??= this.buildView();
  }

  private buildView() {
    const source = this.source;
    const target = this.target;
    const step = this.step;
    const { byColumns, mapping, askSame, askReword, remove, useReword } = this.choices;
    const waiting = !!this.plan(source, target)?.waiting;
    const importing = this.busy === 'importing';
    const whyNext = whyNoNext(target, this.choices);
    const noColumn = byColumns && mapping.item === null;
    const canNext = this.live && !this.busy && !whyNext && !noColumn && !waiting && !!source.prepared?.count
      && (step === 'read' || step === 'columns');
    const { counts } = this.selection(this.review, remove, useReword);
    const wording = this.review && checklistWordingChoices(this.review, remove, useReword, importing);
    const whyBringIn = target.split ? `${target.splitSays}. Choose one first` : undefined;
    const canBringIn = this.live && !this.busy && !whyBringIn && target.named && !!counts.items && step === 'review';
    const listReview = {
      review: this.review, counts, askSame, askReword, remove, useReword, wording,
      waiting: waiting && !whyNext && !noColumn,
      setAskReword: this.setAskReword, setAskSame: this.setAskSame, flipRemove: this.flipRemove,
      flipReword: this.flipReword, setAllWording: this.setAllWording, next: this.next,
      retry: this.retry, retryWording: this.retryWording, backToList: this.backToList,
    };
    return {
      source, target, step, listReview, canNext, whyNext, canBringIn, whyBringIn, can: this.store.get().can,
      work: { busy: this.busy, error: this.error }, setLayer: this.setLayer, setName: this.setName,
      chooseHere: this.chooseHere, stopChoosing: this.stopChoosing, bringItIn: this.bringIn,
    };
  }

  private choose(patch: Partial<ChecklistChoices>) {
    if (!this.live || this.busy === 'importing') return;
    this.choices = { ...this.choices, ...patch };
    this.keep();
  }

  setName = (name: string) => this.choose({ name });
  setLayer = (layer: Layer) => this.choose({ layer });
  setAskSame = (askSame: boolean) => this.choose({ askSame });
  setAskReword = (askReword: boolean) => this.choose({ askReword });
  flipBringIn = (line: number) => this.choose({ bringIn: toggled(this.choices.bringIn, line) });
  flipRemove = (at: number) => this.choose({ remove: toggled(this.choices.remove, at) });
  flipReword = (at: number) => {
    if (!this.choices.remove.has(at)) this.choose({ useReword: toggled(this.choices.useReword, at) });
  };

  // #377: Retain checkmarks on locked rows so restoring a removed item also restores its wording choice.
  setAllWording = (checked: boolean) => {
    const { wording } = this.view.listReview;
    if (!wording) return;
    const next = new Set(this.choices.useReword);
    for (const at of wording.eligible) {
      if (checked) next.add(at);
      else next.delete(at);
    }
    this.choose({ useReword: next });
  };

  pickColumn = (column: keyof ChecklistMapping, value: number | null) => {
    this.error = '';
    this.choose({ mapping: { ...this.choices.mapping, [column]: value } });
  };

  setPaste = (paste: string) => {
    if (!this.live || this.busy === 'importing') return;
    this.paste = paste;
    this.keep();
  };

  private readingEvents = {
    started: () => {
      this.busy = 'asking';
      this.error = '';
      this.reads = null;
      this.choose({ readFailed: '' });
    },
    finished: (reply: Awaited<ReturnType<typeof this.reader.retry>>) => {
      if (!reply) return;
      this.busy = '';
      if (reply.ok) {
        this.reads = reply.value;
        this.choose({ readFailed: '', bringIn: new Set() });
      } else this.choose({ readFailed: failedAs(reply) });
    },
  };

  private readSource() {
    this.lines = checklistSourceLines(this.text, this.table);
    const cells = checklistCellRows(this.text, this.table);
    return this.reader.sourceChanged(this.lines, this.choices.byColumns, this.readingEvents, cells);
  }

  readNow = () => {
    if (!this.busy && this.live) {
      const cells = checklistCellRows(this.text, this.table);
      return this.reader.retry(this.lines, this.choices.byColumns, this.readingEvents, cells);
    }
  };

  private acceptSource(table: ImportTable | null, text: ChecklistText | null, mapping = this.choices.mapping) {
    this.table = table;
    this.text = text;
    this.error = '';
    this.choices = { ...this.choices, mapping, byColumns: false };
    clearChecklistHeading(this.key);
    return this.readSource();
  }

  load = async (file: SourceFile) => {
    if (this.busy || !this.live) return;
    const token = this.requests.newToken();
    this.activity('reading');
    const read = await loadChecklistSource(this.store, file);
    if (!this.requests.isLatest(token)) return;
    this.busy = '';
    if (!read.ok) return this.activity('', `Could not read ${file.name}: ${read.error.message}`);
    if ('table' in read.value) await this.acceptSource(read.value.table, null, read.value.mapping);
    else await this.acceptSource(null, read.value.text);
  };

  loadDropped(file: SourceFile) {
    if (!this.table && !this.text) return this.load(file);
  }

  pasted = () => {
    const text = this.pastedSource(this.paste);
    if (!this.busy && this.live && text) return this.acceptSource(null, text);
  };

  chooseColumns = () => {
    if (this.table && !this.busy && this.live) return this.readTable({ sheet: this.table.sheet }, true);
  };

  reread = (where: ImportLocation, accept?: (read: ImportTable) => void) => {
    // While columns are chosen, a newer sheet or heading row read replaces the one still being read.
    if (!this.live || (this.busy && !(this.choices.byColumns && this.busy === 'reading'))) return Promise.resolve();
    return this.readTable(where, false, accept);
  };

  private async readTable(where: ImportLocation, chooseColumns: boolean, accept?: (read: ImportTable) => void) {
    if (!this.table) return;
    const byColumns = chooseColumns || this.choices.byColumns;
    if (where.headerRow === undefined) this.sheetRead = where;
    await rereadChecklistTable(this.store, this.requests, this.table, where, byColumns, {
      started: () => this.activity('reading'),
      finished: (read) => {
        this.busy = '';
        this.sheetRead = undefined;
        this.choices = { ...this.choices, byColumns };
        if (!read.ok) {
          this.error = `Could not read ${where.sheet ?? this.table!.name}: ${read.error.message}`;
        } else {
          this.table = read.value.table;
          this.choices.mapping = read.value.mapping;
          if (!byColumns) {
            this.reads = null;
            this.choices.readFailed = '';
          }
          accept?.(this.table);
        }
        if (read.ok || chooseColumns) void this.readSource();
        this.keep();
      },
    });
  }

  private showReview = (change: ChecklistReviewChange) => {
    if (change.kind === 'fresh') {
      this.error = '';
      this.review = change.review;
      this.choose({ shown: true, askedFor: change.signature, useReword: change.checked, remove: new Set() });
    } else if (change.kind === 'retry') {
      this.review = change.review;
      if (change.failure) this.error = `${NOT_DONE[change.failure]} again`;
      this.choose({ shown: change.open || this.choices.shown });
    } else this.choose({ shown: true });
  };

  next = async (): Promise<void> => {
    if (!this.live || !this.view.canNext) return;
    const plan = this.plan(this.source, this.target);
    if (plan) await this.reviewer.next(plan, this.showReview);
  };

  retry = () => {
    if (this.review && !this.busy && this.live) {
      return this.reviewer.duplicates(this.review, this.target.generalTexts, this.showReview);
    }
  };

  retryWording = () => {
    if (this.review && !this.busy && this.live) return this.reviewer.wording(this.review, this.showReview);
  };

  private dropWork() {
    this.requests.newToken();
    this.requests.dropTableReads();
    this.busy = '';
    this.error = '';
    this.sheetRead = undefined;
  }

  backToList = () => {
    if (this.busy === 'importing') return;
    this.dropWork();
    this.choose({ shown: false });
  };

  change = () => {
    if (this.busy === 'importing' || !this.live) return;
    this.dropWork();
    this.table = null;
    this.text = null;
    this.reads = null;
    this.choices = { ...this.choices, byColumns: false, readFailed: '' };
    void this.readSource();
    this.keep();
  };

  startOver = () => {
    if (this.busy === 'importing' || !this.live) return;
    dropImport(this.key);
    this.setAside = false;
    this.paste = '';
    this.review = null;
    this.choosing = false;
    this.choices = initialChoices(this.initial, this.store.get().can.reword);
    this.change();
  };

  chooseHere = () => {
    if (!this.target.split || this.busy) return;
    this.choosing = true;
    this.activity('');
  };

  stopChoosing = () => {
    this.choosing = false;
    this.notify();
  };

  back = () => this.leave({ step: 'lists' });
  close = () => this.leave(null);

  private leave(to: { step: 'lists' } | null) {
    if (!this.live || this.busy === 'importing') return;
    this.dispose();
    this.store.ui({ firmChecklist: to });
  }

  bringIn = async (): Promise<void> => {
    if (!this.live || !this.view.canBringIn) return;
    const { remove, useReword } = this.choices;
    const selection = this.selection(this.review, remove, useReword);
    const file = this.table?.name ?? this.text?.name ?? '';
    const target = this.target;
    this.activity('importing');
    try {
      const result = await submitChecklist(this.store, this.key, target, selection.items, file);
      if (!result.ok) return this.activity('', `Couldn’t import: ${result.error.message}`);
      // Once written, the dialog goes back to the lists, even if this session was closed during the write.
      this.dispose();
      this.store.ui({ firmChecklist: { step: 'lists' } });
      showChecklistOutcome(this.store, target.layer, target.name, result.value);
    } catch (error) {
      this.activity('', `Couldn’t import: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
}

export type ChecklistImportView = ChecklistImportSession['view'];
