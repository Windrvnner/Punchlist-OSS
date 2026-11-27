import { isChangedElsewhere } from './changedElsewhere';
import { type FieldDraft, type FieldValue, joinHandedText, unsavedFields } from './fieldDrafts';

type FieldCommitResult = {
  ok: boolean;
  value?: { unchanged?: boolean };
  error?: { kind: string; message: string };
};

export type FieldCommit = (value: string, over: string) => Promise<FieldCommitResult>;

export type FieldSaveOutcome =
  | { kind: 'saved'; written: boolean }
  | { kind: 'changedElsewhere' }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; unreachable: boolean; reason: string };

function fieldSaveOutcome(result: FieldCommitResult, conflicts: 'field' | 'record'): FieldSaveOutcome {
  if (result.ok) return { kind: 'saved', written: !result.value?.unchanged };
  const { error } = result;
  if (error?.kind === 'conflict' && (conflicts === 'record' || isChangedElsewhere(error))) {
    return { kind: 'changedElsewhere' };
  }
  if (error?.kind === 'invalid' || error?.kind === 'rejected') return { kind: 'refused', reason: error.message };
  return { kind: 'failed', unreachable: error?.kind === 'unreachable', reason: error?.message ?? '' };
}

export type FieldSaveView = {
  status: 'idle' | 'saving' | 'failed' | 'refused';
  external: boolean;
  byItself: boolean;
  reason: string;
};
export type FieldAtFocus = Pick<FieldSaveView, 'byItself' | 'reason'> & {
  saved: string;
  status: 'failed' | 'refused';
};

export type FieldComposition = 'idle' | 'active' | 'held';

/** The input supplies its live text and browser state. Save policy only returns changes for it to show. */
export type FieldInput = {
  text(): string;
  composition?(): FieldComposition;
  partial(): boolean;
  partialNow(): boolean;
  locked(): boolean;
  focused(): boolean;
  markPartial(): void;
  replaceText(value: string): void;
  adoptBase(value: string): void;
  landedEntryText(value: string): void;
  show(view: FieldSaveView): void;
};

/** A field's persisted draft and the result of saving over the value it was typed on. */
export class FieldSave {
  base: string;
  protected baseRev: number;

  constructor(record: FieldValue, protected keep: string | undefined, draft?: FieldDraft) {
    this.base = draft?.base ?? record.value;
    this.baseRev = draft?.rev ?? record.rev;
  }

  protected keepOverBase(text: string, rev = this.baseRev) {
    this.restore({ text, base: this.base, rev });
  }

  get kept(): FieldDraft | undefined {
    return this.keep === undefined ? undefined : unsavedFields.get(this.keep);
  }

  protected restore(draft: FieldDraft | undefined) {
    if (this.keep === undefined) return;
    if (draft) unsavedFields.set(this.keep, draft);
    else unsavedFields.delete(this.keep);
  }

  protected async send(text: string, over: string, commit: FieldCommit, conflicts: 'field' | 'record') {
    return fieldSaveOutcome(await commit(text, over), conflicts);
  }
}

/**
 * One field's save state, and when typing saves: after a pause, or when the field is left. The input owns focus,
 * native date parts and input-method composition, and reports its events.
 */
export class EditFieldSave extends FieldSave {
  view: FieldSaveView;
  seen: FieldValue;
  private retryDraft: string | undefined;
  private gone = false;
  private jumped = false;
  private byJump = false;
  private inFlight: string[] = [];
  private arrived: string[] = [];
  private saving = 0;
  private waits = false;
  private resending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    record: FieldValue, keep: string | undefined, draft: FieldDraft | undefined, private input: FieldInput,
  ) {
    super(record, keep, draft);
    this.seen = record;
    const external = !!draft && (draft.base !== record.value || draft.rev !== record.rev);
    this.baseRev = external ? -1 : record.rev;
    this.retryDraft = draft?.text;
    this.view = { external, status: draft && !external ? 'failed' : 'idle', byItself: false, reason: '' };
  }

  private show(change: Partial<FieldSaveView>) {
    const next = { ...this.view, ...change };
    if (this.input.composition?.() === 'held' && !next.external && this.input.text() !== this.seen.value) {
      next.status = 'failed';
      next.byItself = false;
    }
    const { status, external, byItself, reason } = this.view;
    if (status === next.status && external === next.external && byItself === next.byItself && reason === next.reason) {
      return;
    }
    this.view = next;
    this.input.show(next);
  }

  private takeBase(value: string) {
    this.base = value;
    this.baseRev = this.seen.rev;
    this.jumped = false;
    this.input.adoptBase(value);
  }

  private keepText(text: string) {
    if (this.keep === undefined || this.input.partial()) return;
    // After unmount the off-screen watch owns the kept revision unless a save moves its base.
    const kept = this.gone ? this.kept : undefined;
    const rev = kept?.base === this.base ? kept.rev : this.baseRev;
    this.keepOverBase(text, this.view.external ? -1 : rev);
  }

  keepCurrent() {
    if (this.input.text() !== this.seen.value) this.keepText(this.input.text());
  }

  keepUnconfirmed() {
    this.keepCurrent();
    if (this.input.text() !== this.seen.value && !this.view.external) this.show({ status: 'failed', byItself: false });
  }

  private composing() {
    const composition = this.input.composition?.();
    return composition === 'active' || composition === 'held';
  }

  refuseInput(reason: string) {
    if (!this.view.external) this.show({ status: 'refused', reason });
  }

  /** Stops the wait for a pause in typing. Returns whether a save was waiting. */
  stopTimer(): boolean {
    if (this.timer === null) return false;
    clearTimeout(this.timer);
    this.timer = null;
    return true;
  }

  /** Typing saves after a pause of `debounceMs`, unless it is provisional or waits for a choice. */
  typed(text: string, commit: FieldCommit, debounceMs: number) {
    this.show({ status: 'idle' });
    this.stopTimer();
    if (this.input.partial()) return;
    this.retryDraft = undefined;
    if (this.keep !== undefined && (unsavedFields.has(this.keep) || this.view.external)) this.keepText(text);
    else if (this.input.locked() && text !== this.seen.value) this.keepText(text);
    if (this.view.external || this.composing()) return;
    this.timer = setTimeout(() => void this.save(this.input.text(), commit), debounceMs);
  }

  /** Blur saves now, except text not saved on entry and left untouched, which waits for Retry. */
  blur(commit: FieldCommit, unchangedSinceFocus: boolean) {
    if (unchangedSinceFocus) this.stopTimer();
    else void this.save(this.input.text(), commit);
  }

  /** The page hides: the text is kept, and a save waiting for a pause goes now. */
  leave(commit: FieldCommit) {
    this.keepCurrent();
    if (this.timer !== null) void this.save(this.input.text(), commit);
  }

  receive(record: FieldValue) {
    const previous = this.seen;
    if (previous.rev === record.rev && previous.value === record.value) return;
    this.seen = record;
    this.input.landedEntryText(record.value);
    if (previous.value === record.value) {
      this.followRevision(previous.rev);
      return;
    }
    const expected = this.inFlight.indexOf(record.value);
    if (expected >= 0) {
      this.inFlight = this.inFlight.slice(expected + 1);
      this.base = record.value;
      this.baseRev = record.rev;
      this.jumped = false;
      return;
    }
    if (this.inFlight.length) {
      this.arrived.push(record.value);
      if (record.value === this.base) this.jumped = true;
      return;
    }
    const text = this.input.text();
    if (!this.input.partial() && !this.composing() && (text === previous.value || text === record.value)) {
      this.input.replaceText(record.value);
      this.show({ external: false });
      this.takeBase(record.value);
    } else this.keepExternal();
  }

  private followRevision(previousRev: number) {
    const { value, rev } = this.seen;
    if (value !== this.base) return;
    if (this.baseRev === previousRev && rev === previousRev + 1) {
      this.baseRev = rev;
      const kept = this.kept;
      if (kept && kept.rev >= 0) this.restore({ ...kept, rev });
    } else if (this.inFlight.length) {
      if (rev > previousRev + 1) this.jumped = true;
    } else if (this.input.text() === value) this.baseRev = rev;
    else if (rev > previousRev + 1) this.keepExternal();
  }

  private keepExternal() {
    this.stopTimer();
    this.show(this.saving ? { external: true } : { external: true, status: 'idle' });
    this.keepText(this.input.text());
  }

  private otherSince(text: string): boolean {
    if (text === this.seen.value || (this.base === this.seen.value && !this.jumped)) return false;
    this.byJump = this.base === this.seen.value;
    this.keepExternal();
    return true;
  }

  async save(text: string, commit: FieldCommit, chosen = false): Promise<FieldSaveOutcome | undefined> {
    if (this.composing()) return undefined;
    this.stopTimer();
    if (!this.shouldSend(text, chosen)) return undefined;
    if (text === this.retryDraft) this.retryDraft = undefined;
    this.show({ status: 'saving', external: false });
    this.inFlight.push(text);
    this.saving++;
    const again = this.resending;
    this.resending = false;
    const over = this.base;
    const outcome = await this.send(text, over, commit, 'field');
    this.saving--;
    this.handleOutcome(text, over, outcome, commit, again);
    return outcome;
  }

  private shouldSend(text: string, chosen: boolean): boolean {
    if (this.input.locked()) {
      if (text !== this.seen.value) this.keepText(text);
      return false;
    }
    if (this.view.external && !chosen) return false;
    if (chosen) {
      this.base = this.seen.value;
      this.baseRev = this.seen.rev;
      this.jumped = false;
      this.show({ external: false });
    } else if (this.otherSince(text)) return false;
    if (this.input.partialNow()) {
      if (chosen && !this.input.focused()) this.input.markPartial();
      return false;
    }
    // A failed write still in the journal is settled even if the person took their text back to the saved value.
    if (text === this.seen.value && !this.inFlight.length && !this.waits) {
      if (!this.saving) this.show({ status: 'idle' });
      return false;
    }
    return this.inFlight.at(-1) !== text;
  }

  private handleOutcome(text: string, over: string, outcome: FieldSaveOutcome, commit: FieldCommit, again: boolean) {
    if (outcome.kind === 'changedElsewhere') {
      this.settleAttempt(text, false, false, commit);
      this.handleConflict(over, commit);
      return;
    }
    if (outcome.kind === 'saved') {
      // The record's layout effect observes the write before a normalized value is matched to this attempt.
      setTimeout(() => this.settleAttempt(text, true, outcome.written, commit), 0);
      if (this.kept?.text === text) this.restore(undefined);
      this.waits = false;
      if (!this.saving) this.show({ status: 'idle' });
      return;
    }
    this.settleAttempt(text, false, false, commit);
    this.keepText(this.input.text());
    if (outcome.kind === 'refused') this.show({ reason: outcome.reason, status: 'refused' });
    else {
      this.waits = true;
      if (!this.otherSince(this.input.text())) this.show({ byItself: outcome.unreachable && !again, status: 'failed' });
    }
  }

  /**
   * Record writes land one at a time. If this save was normalized, its value is the first unmatched arrival.
   * Any later arrival is still a change from elsewhere and leaves the typed text waiting for a choice.
   */
  private settleAttempt(text: string, saved: boolean, written: boolean, commit: FieldCommit) {
    const exact = !this.inFlight.includes(text);
    this.inFlight = this.inFlight.filter((value) => value !== text);
    if (saved) this.input.landedEntryText(text);
    if (written && !exact) this.followStoredWrite();
    if (this.inFlight.length) return;
    this.arrived = [];
    if (written) this.jumped = false;
    if (written && this.byJump && this.view.external && this.base === this.seen.value) {
      this.byJump = false;
      this.show({ external: false });
      void this.save(this.input.text(), commit);
    } else this.otherSince(this.input.text());
  }

  private followStoredWrite() {
    const stored = this.arrived.shift();
    if (stored === undefined) return;
    this.base = stored;
    this.baseRev = this.arrived.length ? -1 : this.seen.rev;
    const kept = this.kept;
    if (kept) this.keepText(kept.text);
  }

  private handleConflict(over: string, commit: FieldCommit) {
    if (!this.saving) this.show({ status: 'idle' });
    const now = this.seen.value;
    const text = this.input.text();
    if (!this.input.partial() && text === now) {
      this.takeBase(now);
      this.show({ external: false });
      this.restore(undefined);
      return;
    }
    if (!this.input.partial() && text === over) {
      this.restore(undefined);
      if (now !== over) {
        this.input.replaceText(now);
        this.takeBase(now);
        this.show({ external: false });
        if (this.waits) void this.save(now, commit, true);
      }
      return;
    }
    this.stopTimer();
    this.show({ external: true });
    this.keepText(text);
  }

  /** Text handed in from elsewhere (handFieldText) waits in the box for Keep Mine or Take Theirs (#939). */
  takeHanded(text: string) {
    if (this.input.partial()) return;
    const current = this.input.text();
    const next = joinHandedText(current === this.seen.value ? '' : current, text);
    this.input.replaceText(next);
    this.keepExternal();
  }

  takeTheirs(value: string, commit: FieldCommit) {
    this.stopTimer();
    this.restore(undefined);
    this.takeBase(value);
    this.input.replaceText(value);
    this.show({ external: false, status: 'idle' });
    if (this.waits) void this.save(value, commit, true);
  }

  escape(text: string, entry: FieldAtFocus | null, commit: FieldCommit) {
    if (!entry) {
      this.restore(undefined);
      this.show({ status: 'idle' });
      void this.save(text, commit);
      return;
    }
    if (entry.status === 'failed' && !entry.byItself) this.retryDraft = text;
    const back = () => {
      if (this.input.text() !== text || this.view.external) return;
      this.keepText(text);
      const { byItself, reason, status } = entry;
      this.show({ byItself, reason, status });
    };
    if (this.seen.value === entry.saved && !this.inFlight.length && !(this.waits && this.keep !== undefined)) back();
    else void this.save(entry.saved, commit).then(back);
  }

  unmount(commit: FieldCommit) {
    this.keepCurrent();
    const text = this.input.text();
    if (this.stopTimer() && text !== this.seen.value && !this.input.partial() && !this.composing()
      && !this.view.external && !this.input.locked() && this.base === this.seen.value) {
      void commit(text, this.base);
    }
  }

  offScreen() {
    this.gone = true;
  }

  reconnect(commit: FieldCommit) {
    if (this.view.status !== 'failed' || !this.view.byItself || this.view.external || this.composing()) return;
    this.resending = true;
    void this.save(this.input.text(), commit);
  }

  lockChanged(locked: boolean, commit: FieldCommit) {
    const text = this.input.text();
    // A read-only lock cannot submit a restored draft. Older save results can still finish during new typing (#229).
    if (!locked && text !== this.retryDraft && !this.input.focused() && text !== this.seen.value) {
      void this.save(text, commit);
    }
  }
}
