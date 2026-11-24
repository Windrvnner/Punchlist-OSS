import { isChangedElsewhere } from './changedElsewhere';
import { type FieldDraft, type FieldValue, unsavedFields } from './fieldDrafts';

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
  | { kind: 'failed'; unreachable: boolean };

function fieldSaveOutcome(result: FieldCommitResult): FieldSaveOutcome {
  if (result.ok) return { kind: 'saved', written: !result.value?.unchanged };
  const { error } = result;
  if (error?.kind === 'conflict' && isChangedElsewhere(error)) return { kind: 'changedElsewhere' };
  if (error?.kind === 'invalid' || error?.kind === 'rejected') return { kind: 'refused', reason: error.message };
  return { kind: 'failed', unreachable: error?.kind === 'unreachable' };
}

type FieldAttempt = {
  text: string;
  over: string;
  again: boolean;
  choice: boolean;
  baselineVersion: number;
  arrivalsBeforeMatch?: string[];
};

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

/** The input supplies its live text and browser state. Save policy only returns changes for it to show. */
export type FieldInput = {
  text(): string;
  partial(): boolean;
  partialNow(): boolean;
  locked(): boolean;
  focused(): boolean;
  stopTimer(): boolean;
  markPartial(): void;
  replaceText(value: string): void;
  adoptBase(value: string): void;
  landedEntryText(value: string): void;
  show(view: FieldSaveView): void;
};

/** One field's save state. The input owns focus, native date parts, and when its debounce or lifecycle event fires. */
export class FieldSave {
  view: FieldSaveView;
  base: string;
  seen: FieldValue;
  private baseRev: number;
  private retryDraft: string | undefined;
  private gone = false;
  private jumped = false;
  private byJump = false;
  private inFlight: FieldAttempt[] = [];
  private arrived: string[] = [];
  private saving = 0;
  private choicesPending = 0;
  private baselineVersion = 0;
  private waits = false;
  private resending = false;

  constructor(
    record: FieldValue, private keep: string | undefined, draft: FieldDraft | undefined, private input: FieldInput,
  ) {
    this.seen = record;
    this.base = draft?.base ?? record.value;
    const external = !!draft && (draft.base !== record.value || draft.rev !== record.rev);
    this.baseRev = external ? -1 : record.rev;
    this.retryDraft = draft?.text;
    this.view = { external, status: draft && !external ? 'failed' : 'idle', byItself: false, reason: '' };
  }

  private show(change: Partial<FieldSaveView>) {
    const next = { ...this.view, ...change };
    const { status, external, byItself, reason } = this.view;
    if (status === next.status && external === next.external && byItself === next.byItself && reason === next.reason) {
      return;
    }
    this.view = next;
    this.input.show(next);
  }

  private takeBase(value: string) {
    this.baselineVersion++;
    this.base = value;
    this.baseRev = this.seen.rev;
    this.jumped = false;
    this.input.adoptBase(value);
  }

  private keepText(text: string) {
    if (this.keep === undefined || this.input.partial()) return;
    // After unmount the off-screen watch owns the kept revision unless a save moves its base.
    const kept = this.gone ? unsavedFields.get(this.keep) : undefined;
    const rev = kept?.base === this.base ? kept.rev : this.baseRev;
    unsavedFields.set(this.keep, { text, base: this.base, rev: this.view.external ? -1 : rev });
  }

  private forgetText() {
    if (this.keep !== undefined) unsavedFields.delete(this.keep);
  }

  keepCurrent() {
    if (this.input.text() !== this.seen.value) this.keepText(this.input.text());
  }

  refuseInput(reason: string) {
    if (!this.view.external) this.show({ status: 'refused', reason });
  }

  typed(text: string): boolean {
    this.show({ status: 'idle' });
    this.input.stopTimer();
    if (this.input.partial()) return false;
    this.retryDraft = undefined;
    if (this.keep !== undefined && (unsavedFields.has(this.keep) || this.view.external)) this.keepText(text);
    else if (this.input.locked() && text !== this.seen.value) this.keepText(text);
    return !this.view.external;
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
    const expected = this.inFlight.findIndex(({ text }) => text === record.value);
    if (expected >= 0) {
      this.followExpectedWrite(record, expected);
      return;
    }
    if (this.inFlight.length) {
      this.arrived.push(record.value);
      if (record.value === this.base) this.jumped = true;
      return;
    }
    const text = this.input.text();
    if (!this.input.partial() && (text === previous.value || text === record.value)) {
      this.input.replaceText(record.value);
      this.show({ external: false });
      this.takeBase(record.value);
    } else this.keepExternal();
  }

  private followExpectedWrite(record: FieldValue, expected: number) {
    // A normalized write can have the exact text of a later save. Keep the arrivals for the earlier attempts.
    const arrivals = [...this.arrived, record.value];
    for (const attempt of this.inFlight.slice(0, expected)) attempt.arrivalsBeforeMatch = arrivals;
    this.arrived = [];
    this.inFlight = this.inFlight.slice(expected + 1);
    this.base = record.value;
    this.baseRev = record.rev;
    this.jumped = false;
  }

  private followRevision(previousRev: number) {
    const { value, rev } = this.seen;
    if (value !== this.base) return;
    if (this.baseRev === previousRev && rev === previousRev + 1) {
      this.baseRev = rev;
      const kept = this.keep === undefined ? undefined : unsavedFields.get(this.keep);
      if (this.keep !== undefined && kept && kept.rev >= 0) unsavedFields.set(this.keep, { ...kept, rev });
    } else if (this.inFlight.length) {
      if (rev > previousRev + 1) this.jumped = true;
    } else if (this.input.text() === value) this.baseRev = rev;
    else if (rev > previousRev + 1) this.keepExternal();
  }

  private keepExternal() {
    this.input.stopTimer();
    this.show(this.saving ? { external: true } : { external: true, status: 'idle' });
    this.keepText(this.input.text());
  }

  private otherSince(text: string): boolean {
    if (text === this.seen.value || (this.base === this.seen.value && !this.jumped)) return false;
    this.byJump = this.base === this.seen.value;
    this.keepExternal();
    return true;
  }

  get acceptingChoice() {
    return this.choicesPending > 0;
  }

  async save(text: string, commit: FieldCommit, chosen = false): Promise<FieldSaveOutcome | undefined> {
    const choice = chosen && this.view.external;
    this.input.stopTimer();
    if (!this.shouldSend(text, chosen)) return undefined;
    if (text === this.retryDraft) this.retryDraft = undefined;
    this.show({ status: 'saving', external: false });
    const attempt: FieldAttempt = {
      text, over: this.base, again: this.resending, choice, baselineVersion: this.baselineVersion,
    };
    this.inFlight.push(attempt);
    this.saving++;
    if (choice) this.choicesPending++;
    this.resending = false;
    const outcome = fieldSaveOutcome(await commit(text, attempt.over));
    this.saving--;
    this.handleOutcome(attempt, outcome, commit);
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
      if (chosen) this.acceptChoice(text, text);
      if (!this.saving) this.show({ status: 'idle' });
      return false;
    }
    return this.inFlight.at(-1)?.text !== text;
  }

  private handleOutcome(attempt: FieldAttempt, outcome: FieldSaveOutcome, commit: FieldCommit) {
    const { text, again } = attempt;
    if (outcome.kind === 'changedElsewhere') {
      this.settleAttempt(attempt, false, false, commit);
      this.handleConflict(attempt, commit);
      return;
    }
    if (outcome.kind === 'saved') {
      // The record's layout effect observes the write before a normalized value is matched to this attempt.
      setTimeout(() => this.settleAttempt(attempt, true, outcome.written, commit), 0);
      if (this.keep !== undefined && unsavedFields.get(this.keep)?.text === text) this.forgetText();
      this.waits = false;
      if (!this.saving) this.show({ status: 'idle' });
      return;
    }
    this.settleAttempt(attempt, false, false, commit);
    if (attempt.choice) {
      this.keepUnacceptedChoice(outcome);
      return;
    }
    this.keepText(this.input.text());
    if (outcome.kind === 'refused') this.show({ reason: outcome.reason, status: 'refused' });
    else {
      this.waits = true;
      if (!this.otherSince(this.input.text())) this.show({ byItself: outcome.unreachable && !again, status: 'failed' });
    }
  }

  private keepUnacceptedChoice(outcome: Extract<FieldSaveOutcome, { kind: 'failed' | 'refused' }>) {
    if (outcome.kind === 'failed') this.waits = true;
    this.keepExternal();
    if (outcome.kind === 'refused') this.show({ reason: outcome.reason, status: 'refused' });
  }

  /**
   * Record writes land one at a time. If this save was normalized, its value is the first unmatched arrival.
   * Any later arrival is still a change from elsewhere and leaves the typed text waiting for a choice.
   */
  private settleAttempt(attempt: FieldAttempt, saved: boolean, written: boolean, commit: FieldCommit) {
    const { text, choice } = attempt;
    const followed = !this.inFlight.includes(attempt);
    this.inFlight = this.inFlight.filter((pending) => pending !== attempt);
    if (saved) this.input.landedEntryText(text);
    const stored = this.settledValue(attempt, written, followed);
    if (choice) this.settleChoice(attempt, saved ? stored : undefined);
    if (this.inFlight.length) return;
    this.arrived = [];
    if (written) this.jumped = false;
    if (written && this.byJump && this.view.external && this.base === this.seen.value) {
      this.byJump = false;
      this.show({ external: false });
      void this.save(this.input.text(), commit);
    } else this.otherSince(this.input.text());
  }

  private settledValue(attempt: FieldAttempt, written: boolean, followed: boolean) {
    if (!written) return attempt.over;
    if (!followed) return this.followStoredWrite() ?? attempt.text;
    // The base already advanced to the matching arrival. Settle earlier writes without moving the base back.
    return attempt.arrivalsBeforeMatch?.shift() ?? attempt.text;
  }

  private followStoredWrite() {
    const stored = this.arrived.shift();
    if (stored === undefined) return;
    this.base = stored;
    this.baseRev = this.arrived.length ? -1 : this.seen.rev;
    const kept = this.keep === undefined ? undefined : unsavedFields.get(this.keep);
    if (kept) this.keepText(kept.text);
    return stored;
  }

  private settleChoice(attempt: FieldAttempt, stored: string | undefined) {
    this.choicesPending--;
    // The field may already have followed another PC or a newer Take Theirs while this result was settling.
    if (stored === undefined || attempt.baselineVersion !== this.baselineVersion) return;
    this.acceptChoice(attempt.text, stored);
  }

  // Escape can undo later typing, but cannot go back through a choice that settled a change from elsewhere (#228).
  private acceptChoice(text: string, stored: string) {
    this.input.adoptBase(stored);
    if (text !== stored && this.input.text() === text && this.seen.value === stored && !this.input.partial()) {
      this.input.replaceText(stored);
    }
  }

  private handleConflict({ over, choice }: FieldAttempt, commit: FieldCommit) {
    if (!this.saving) this.show({ status: 'idle' });
    const now = this.seen.value;
    const text = this.input.text();
    if (!this.input.partial() && text === now) {
      this.takeBase(now);
      this.show({ external: false });
      this.forgetText();
      return;
    }
    if (!choice && !this.input.partial() && text === over) {
      this.forgetText();
      if (now !== over) {
        this.input.replaceText(now);
        this.takeBase(now);
        this.show({ external: false });
        if (this.waits) void this.save(now, commit, true);
      }
      return;
    }
    this.input.stopTimer();
    this.show({ external: true });
    this.keepText(text);
  }

  takeTheirs(value: string, commit: FieldCommit) {
    this.input.stopTimer();
    this.forgetText();
    this.takeBase(value);
    this.input.replaceText(value);
    this.show({ external: false, status: 'idle' });
    if (this.waits) void this.save(value, commit, true);
  }

  escape(text: string, entry: FieldAtFocus | null, commit: FieldCommit) {
    if (!entry) {
      this.forgetText();
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
    if (this.input.stopTimer() && text !== this.seen.value && !this.input.partial()
      && !this.view.external && !this.input.locked() && this.base === this.seen.value) {
      void commit(text, this.base);
    }
  }

  offScreen() {
    this.gone = true;
  }

  reconnect(commit: FieldCommit) {
    if (this.view.status !== 'failed' || !this.view.byItself || this.view.external) return;
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
