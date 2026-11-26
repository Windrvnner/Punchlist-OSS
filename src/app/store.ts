/**
 * The Store: one state object, one way to change it.
 *
 *   dispatch(command, input)
 *     validate → plan (pure) → journal pending → repository.transaction → settle → apply to state
 *
 * State changes only after the repository accepted the write. Operations on
 * the same record run in order. Duplicate dispatches (same idempotency key
 * while pending) are dropped. Every successful operation keeps its inverse so
 * Undo is itself an ordinary operation.
 */
import { SERVICE } from '../control';
import { commandLabel } from './commandLabels';
import { capabilities } from './capabilities';
import { CONNECTED, SharedFolderConnection, SignInConnection } from './connection';
import { CHANGED_ELSEWHERE } from './changedElsewhere';
import { overLimit, TOO_LONG } from '../domain/importExport';
import type { Command, Plan } from './command';
import { fingerprint, sameContent } from '../domain/versions';
import type { ShownNote, DeletedCopy } from './commands/keptVersions';
import { type State, type Message, type Prefs, type PageState, type Conflict, initialState, DEFAULT_PREFS, FIRM, conflictLabel, versionsWord, findingName, bucketOf, deleteWaits } from './state';
import { z } from 'zod';
import type { Services, ConversationStore } from '../ports';
import type { Transaction, Loaded, Version, CheckSummary } from '../ports';
import { ok, fail, type Result, type Failure } from '../domain/result';
import { Operation, AuditEntry, Deal, Question, Finding, Tombstone, Member, CURRENT_SCHEMA, CLASH_KINDS, memberId, type RecordKind, type Folder } from '../domain/model';
import { keepUnseen, movedHash } from './recovered';
import { scopeOfKey } from './conversations';
import { Item, ListRecord } from '../domain/checklist';
import { Undo } from './commands/undo';
import { lastImport } from './commands/importQuestions';
import { merged, localConversations } from './threads';
import { seenSince } from './draftsSeen';
import { freshen, FOLDER_CHECK } from './folderWatch';
import { reassess } from './findings';
import { indexCommittedFolders } from './indexing';
import { keepUntilSignedIn } from './undoNotice';

type Listener = (s: State) => void;

type DispatchOptions = {
  idempotencyKey?: string;
  quiet?: boolean;
  /** The action's caller has its own wording for this refusal. */
  quietRefusal?: (error: Failure) => boolean;
  /** The caller keeps the input and offers its own retry. */
  noRetry?: boolean;
  /** The field's value before this edit; later changes are refused. */
  over?: string;
  /** Keep a reply pending until it can be written. */
  keep?: boolean;
  again?: Failure['kind'];
  /** An existing effect's follow-up may finish while signed out. */
  system?: boolean;
};
type ExecuteOptions = DispatchOptions & {
  /** Internal Retry keeps the original journal identity. */
  opId?: string;
  landed?: number;
  watch?: FieldWait;
};


/**
 * Which field a field's save is of (record and field), so a later save of it is known to replace an earlier one; null
 * for anything else. A deal's edit names every field it sets. A finding's edit is not here: it writes only what changed
 * from the form's start, so a later edit need not carry an earlier one's change.
 */
export function fieldKey(command: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (command === 'EditQuestionField') return `${command}:${i.questionId}:${i.field}`;
  if (command === 'SetResponse') return `${command}:${i.questionId}`;
  if (command === 'EditDeal') return `${command}:${i.dealId}:${Object.keys(i).filter((k) => k !== 'dealId').sort().join(',')}:${JSON.stringify((i.folder as { path?: unknown } | undefined)?.path ?? '')}`;
  return null;
}
/**
 * A field save's field as the record holds it now, so the Store can tell whether it has changed since the person's text
 * was typed over it; undefined when the record is not here or the save is not of one text field.
 */
export function fieldValue(state: State, command: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (command === 'EditQuestionField' || command === 'SetResponse') {
    const q = state.questions[i.questionId as string] as unknown as Record<string, unknown> | undefined;
    const v = q?.[command === 'SetResponse' ? 'response' : (i.field as string)];
    return typeof v === 'string' ? v : undefined;
  }
  if (command === 'EditDeal') {
    const d = state.deals[i.dealId as string]; const keys = Object.keys(i).filter((k) => k !== 'dealId');
    if (!d || keys.length !== 1) return undefined;
    if (keys[0] === 'folder') return d.folders.find((f) => f.path === (i.folder as { path?: unknown } | undefined)?.path)?.label;
    const v = (d as unknown as Record<string, unknown>)[keys[0]];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}
/** a Retry refused because what it would write has changed since (another PC's work, say): running it again would write over that */
const CHANGED_SINCE = 'This was changed since, so retrying would write over newer work. Nothing was written';
/** a field's save waiting its turn: the field's value and its record's rev as last seen, and whether it has moved since the save was sent */
type FieldWait = { command: string; input: unknown; last: string | undefined; rev: number | undefined; clash: boolean; moved: boolean };
/** the record a field save is of: the question, or the deal */
const fieldRecord = (input: unknown) => { const i = (input ?? {}) as { questionId?: unknown; dealId?: unknown }; return String(i.questionId ?? i.dealId ?? ''); };
/**
 * Whether a record's rev went from `was` to `now` by more than one version: several changes read at once (one sync), so the
 * field may have moved and come back between them unseen. Unknown on either side is no jump.
 */
const jumped = (was: number | undefined, now: number | undefined) => was !== undefined && now !== undefined && now !== was && now !== was + 1;
/** failures in which nothing was wrong with the change itself: it could not be written, and can be once what was in the way is gone */
const UNWRITTEN = new Set<Failure['kind']>(['unreachable', 'failed', 'storageFull']);
/** what the app records for itself, which goes on while read-only: indexing progress and the Q&A log's file and exports */
const SIGNED_OUT_OK = new Set(['RecordIndexingProgress', 'RecordQaLogExport', 'KeepQaLog', 'SetQaLogFolder']);
/** commands a field on screen saves through: when one fails, the field itself is marked "Not saved" */
const FIELD_SAVES = new Set(['EditQuestionField', 'SetResponse', 'EditDeal', 'EditFinding']);
/**
 * Every window of this PC shares one journal. While a window has an operation in flight, or a save of its waits, it stamps
 * the shared `alive` key this often; a window not heard from for STALE_MS is gone, and only then is its pending work
 * interrupted.
 */
export const ALIVE_MS = 5_000, STALE_MS = 20_000;
/**
 * a draft asked for on another PC is taken as abandoned once this PC has seen it pending this long, by its own clock
 * (`seenSince`, #24): the same 15 minutes after which a quiet PC's round is taken over
 */
export const DRAFT_GIVE_UP_MS = 15 * 60_000;
/** how soon start-up is tried again when the deals could not all be read: the pace of the offline check */
export const BOOT_RETRY_MS = 10_000;

/** suggestions put away ("Not this one") remembered on this PC; past this many the oldest are let go, the card coming back at worst */
export const NOT_THESE_KEEP = 2000;

/** settled operations kept for Undo; older ones are pruned once the journal is this much over */
const JOURNAL_KEEP = 200, JOURNAL_SLACK = 50;


/**
 * The records an operation wrote or removed, as they were right after it, keyed by kind and id (see `Operation.results`).
 * Every kind is recorded except the journal's own: a kind Undo has no bucket for is then refused, never undone unchecked.
 */
const NOT_KEPT = new Set(['op', 'audit']);
function resultsOf(plan: Plan, revs: Record<string, number>): NonNullable<Operation['results']> {
  const out: NonNullable<Operation['results']> = {};
  for (const r of plan.removes ?? []) if (!NOT_KEPT.has(r.kind)) out[`${r.kind}/${r.id}`] = null;
  for (const u of plan.upserts) {
    if (NOT_KEPT.has(u.kind)) continue;
    const rec = u.record as { id: string; updatedAt?: unknown; at?: unknown }; const at = u.kind === 'tombstone' ? rec.at : rec.updatedAt;
    out[`${u.kind}/${rec.id}`] = { ...(typeof revs[rec.id] === 'number' ? { rev: revs[rec.id] } : {}), ...(typeof at === 'string' ? { at } : {}), ...(u.kind === 'tombstone' ? { sig: fingerprint(rec) } : {}) };
  }
  return out;
}

/** the schema a stored record of each kind is read through; null for a kind the window does not read */
function schemaOfKind(kind: string): z.ZodTypeAny | null {
  return kind === 'deal' ? Deal : kind === 'question' ? Question : kind === 'finding' ? Finding : kind === 'tombstone' ? Tombstone : kind === 'op' ? Operation : kind === 'item' ? Item : kind === 'firmList' ? ListRecord : kind === 'member' ? Member : null;
}

/**
 * A deletion note as a window shows it. Two PCs that deleted different words wrote two notes: the first is shown,
 * with the PC it came from, and each other note whose copy says something else rides along as a copy, so the Deleted
 * list shows both and Restore of either keeps the other.
 */
function noteWithCopies(t: Tombstone, versions: Version[] | undefined): ShownNote {
  const notes = (versions ?? []).filter((v) => !v.deleted && v.data && typeof v.data === 'object');
  if (notes.length < 2) return t;
  const copies: DeletedCopy[] = [];
  for (const v of notes.slice(1)) {
    const n = v.data as Tombstone;
    if ([t.snapshot, ...copies.map((c) => c.snapshot)].some((x) => sameContent(x, n.snapshot))) continue;
    copies.push({ ver: v.id, from: v.from, actor: n.actor, at: n.at, snapshot: n.snapshot });
  }
  return copies.length ? { ...t, from: notes[0].from, copies } : t;
}

/** the AI service's calls that go to the model service (the others only read what is recorded) */
const MODEL_CALLS = new Set<PropertyKey>([
  'answer', 'draft', 'reassess', 'dealBrief', 'gaps', 'addresses', 'suggestQuestion', 'merge', 'layout', 'reword',
  'sameMeaning', 'issuesList', 'phrase', 'checkAll', 'responses', 'readList', 'memo',
]);

/**
 * The app's own replies to a person's request (a draft's text) are never dropped. One that cannot be written, because
 * another PC's change to the question keeps arriving first or the folder cannot take it, is planned again against the record as it
 * then stands until it is written or no longer applies. Each command's own plan decides that (ApplyDraft writes only onto the request
 * that asked for it), so planning one again never writes over anyone's work.
 */
const KEPT_REPLIES = new Set(['ApplyDraft']);
/** a reply that carries work: a draft whose model call failed carries none, and shows as failed whether it is written or not */
function keepsWork(command: string, input: unknown): boolean { return KEPT_REPLIES.has(command) && (input as { result?: { status?: unknown } } | null)?.result?.status !== 'failed'; }
/** the key a kept reply's tries share, so the one that goes through settles every earlier one still waiting */
const replyKey = (input: unknown) => `reply:${(input as { requestOpId?: unknown } | null)?.requestOpId}`;
/** what keeps a reply from being written for now; any other refusal (the question deleted, in two versions) is the record's to settle */
const NOT_YET = new Set<Failure['kind']>(['conflict', 'unreachable', 'failed', 'storageFull']);
/** a reply refused because another PC's change reached the folder first is planned again at once, this many times while more keep arriving */
const REPLAN_NOW = 10;
/** held replies said in one notice: those held within this long of the first */
const HELD_GATHER = 300;
/** a kept reply waiting to be written: its tries so far, when it is next due, and the gap after that */
type WaitingReply = { cmd: Command<any>; input: unknown; last?: Failure['kind']; tries: number; due: number; gap: number };
/** past that, or while the folder cannot be written, it waits: tried again after this, doubling to the longest, and at once when the folder is back */
export const REPLY_RETRY_FIRST = 5_000, REPLY_RETRY_MAX = 60_000;
/**
 * A reply is tried this many times in all, its first try and then one a round with the waits above (about 75 seconds), before
 * it stops (a stalled draft does not retry for ever). It then shows as failed, and its Retry writes the kept
 * text, with no new request to the model (`retryKeptReply`).
 */
export const REPLY_TRIES = 5;

const CHECK_UNFINISHED = 'The check did not finish. Findings already marked stay marked';
/** the notices kept on this PC until they are closed (Store.toast, 'kept') */
const KEPT_NOTICES = 'kept-notices';
type ToastLinger = boolean | 'stays' | 'kept';
type ToastGlyph = NonNullable<State['ui']['toasts'][number]['glyph']>;
type KeptNotice = { text: string; glyph: ToastGlyph };

const isKeptNotice = (x: unknown): x is KeptNotice => {
  const notice = x as Partial<KeptNotice> | null;
  return typeof notice?.text === 'string' && (notice.glyph === 'done' || notice.glyph === 'warn');
};

export class Store {
  private state: State;
  private listeners = new Map<Listener, boolean>();
  private peerRenderFrame: number | null = null;
  private commands = new Map<string, Command<any>>();
  private queues = new Map<string, Promise<unknown>>();
  /**
   * The person's own saves in this window that could not be written (UNWRITTEN), by operation. In the window each reads as
   * failed, with Retry; its journal entry stays pending, so if the app is closed first the next start offers it as
   * interrupted, with Retry and Discard. The app does not make them by itself: only a person changes a record. A
   * field sends its own text again once the app is connected (editField.tsx), and a field's save that goes through
   * settles every earlier one of that field still waiting (`settleField`). A save sent again from where its caller kept it
   * (the same idempotency key) settles the one it repeats. The value is that key, if any.
   */
  private unwritten = new Map<string, string | undefined>();
  private pendingKeys = new Map<string, string>(); // idempotencyKey → opId
  private probe: ReturnType<typeof setInterval> | null = null;
  private toastSeq = 0;
  /** this window, as recorded on the operations it starts */
  private readonly windowId = globalThis.crypto.randomUUID();

  constructor(public readonly services: Services, commands: Command<any>[]) {
    this.state = initialState(capabilities(services));
    this.conversations = services.conversations ?? localConversations(services.local);
    for (const c of [...commands, Undo]) this.commands.set(c.name, c);
    services.ai = this.watchModel(services.ai);
    services.repo.watch((ch) => void (ch.kind === 'sync'
      ? this.refreshSync() : this.reloadRecord(ch.kind, ch.id, true)));
  }

  // ---- state access -------------------------------------------------------
  get(): State { return this.state; }
  /** Only view renders opt in; indexing and kept text still see each peer change (#359). */
  subscribe(fn: Listener, options: { peerFrame?: boolean } = {}): () => void {
    this.listeners.set(fn, !!options.peerFrame);
    return () => {
      this.listeners.delete(fn);
      if (this.peerRenderFrame !== null && ![...this.listeners.values()].some(Boolean)) this.cancelPeerRender();
    };
  }
  /** told the ids of a deleted deal's records in its copy, old → new, once the copy is kept: the window moves what it keeps by id */
  private renamers = new Set<(ids: Record<string, string>) => void>();
  onRenamed(fn: (ids: Record<string, string>) => void): () => void { this.renamers.add(fn); return () => this.renamers.delete(fn); }
  private set(next: State, peer = false) {
    const prev = this.state;
    this.state = next;
    if ((this.fieldWrote.size || this.fieldWaits.size)
      && (next.questions !== prev.questions || next.deals !== prev.deals)) this.forgetMoved();
    if (!peer) this.cancelPeerRender();
    for (const [listener, deferPeer] of this.listeners) {
      if (peer && deferPeer) this.deferPeerRender();
      else listener(next);
    }
  }
  /** Finding records apply immediately; only the list's view notifications share a frame (#359). */
  private deferPeerRender() {
    if (this.peerRenderFrame !== null) return;
    this.peerRenderFrame = requestAnimationFrame(() => {
      this.peerRenderFrame = null;
      for (const [listener, deferPeer] of this.listeners) if (deferPeer) listener(this.state);
    });
  }
  private cancelPeerRender() {
    if (this.peerRenderFrame === null) return;
    cancelAnimationFrame(this.peerRenderFrame);
    this.peerRenderFrame = null;
  }
  /** UI-only state (route, selection, filters, toasts). Never touches records. */
  ui(patch: Partial<State['ui']> | ((ui: State['ui']) => Partial<State['ui']>)) {
    const p = typeof patch === 'function' ? patch(this.state.ui) : patch;
    this.set({ ...this.state, ui: { ...this.state.ui, ...p } });
  }
  /** How long a toast stays. Long enough to read it and reach Undo; the count stops while the pointer or focus is on it. */
  static readonly TOAST_MS = 8000;
  private toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private toastsHeld = false;
  private armToast(id: number) {
    clearTimeout(this.toastTimers.get(id));
    this.toastTimers.set(id, setTimeout(() => { this.toastTimers.delete(id); this.ui((ui) => ({ toasts: ui.toasts.filter((t) => t.id !== id) })); }, Store.TOAST_MS));
  }
  /**
   * `sticky`: the notice stays until the person closes it or, unless it `'stays'`, until the next change is made. A `'kept'`
   * notice stays too, and is kept on this PC with its glyph until it is closed, so it is back after the app is started
   * again. The glyph is what the caller says happened: 'done' for completed work, 'warn' for a failure or refusal
   * (#1114).
   */
  toast(text: string, glyph: ToastGlyph, action?: State['ui']['toasts'][number]['action'],
    sticky: ToastLinger = false, more?: string, cut?: string) {
    const id = ++this.toastSeq;
    if (sticky === 'kept') this.keepNotice({ text, glyph });
    const list = [...this.state.ui.toasts.filter((t) => !t.sticky || t.text !== text), {
      id, text, action, sticky: !!sticky, more, cut, glyph,
      ...(sticky === 'stays' || sticky === 'kept' ? { stays: true } : {}),
      ...(sticky === 'kept' ? { kept: true } : {}),
    }];
    // at most three notices: a fourth pushes out the oldest, so no Undo waits off screen for Ctrl Z to reach
    while (list.length > 3) { const i = list.findIndex((t) => !t.sticky); if (i < 0 || i === list.length - 1) break; const [old] = list.splice(i, 1); clearTimeout(this.toastTimers.get(old.id)); this.toastTimers.delete(old.id); }
    this.ui({ toasts: list });
    if (!sticky && !this.toastsHeld) this.armToast(id);
    return id;
  }
  dismissToast(id: number) {
    const t = this.state.ui.toasts.find((x) => x.id === id);
    if (t?.kept) this.services.local.write(KEPT_NOTICES, this.keptNotices().filter((x) => x.text !== t.text));
    clearTimeout(this.toastTimers.get(id)); this.toastTimers.delete(id); this.ui((ui) => ({ toasts: ui.toasts.filter((t) => t.id !== id) }));
  }
  private keptNotices(): KeptNotice[] {
    const stored = this.services.local.read(KEPT_NOTICES);
    return Array.isArray(stored) ? stored.filter(isKeptNotice) : [];
  }
  private keepNotice(notice: KeptNotice) {
    const kept = this.keptNotices();
    if (!kept.some((x) => x.text === notice.text)) this.services.local.write(KEPT_NOTICES, [...kept, notice]);
  }
  /** The pointer or keyboard focus is on the toasts: stop the clock so an Undo cannot vanish while someone is reaching for it. */
  holdToasts() { this.toastsHeld = true; for (const t of this.toastTimers.values()) clearTimeout(t); this.toastTimers.clear(); }
  releaseToasts() { if (!this.toastsHeld) return; this.toastsHeld = false; for (const t of this.state.ui.toasts) if (!t.sticky) this.armToast(t.id); }

  // ---- dispatch -----------------------------------------------------------
  dispatch<I, In>(command: Command<I, In>, rawInput: In, opts: DispatchOptions = {}) {
    return this.dispatchAction(command, rawInput, opts);
  }

  private async dispatchAction<I, In>(
    command: Command<I, In>, rawInput: In, opts: ExecuteOptions = {},
  ): Promise<Result<{ opId: string; unchanged?: boolean }>> {
    // read-only while nobody is signed in to Intelligence: no new change is made. The screens show what cannot be used as
    // off; this is the one place that holds for all of them. The app's own record keeping goes on (SIGNED_OUT_OK).
    const ro = this.readOnly();
    if (ro && !opts.system && !SIGNED_OUT_OK.has(command.name)) {
      if (!opts.quiet) this.toast(ro, 'warn');
      return fail({ kind: 'rejected', message: ro });
    }
    const parsed = command.input.safeParse(rawInput);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues) fields[i.path.join('.')] = i.message;
      return fail({ kind: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid input', fields });
    }
    const input = parsed.data;
    // A change that gives a question its number waits for the deal's questions to be loaded: numbered before then,
    // it would take a number an existing question already holds. This comes before the in-progress check,
    // so a second press while the deal loads is still turned away.
    let first: string[] = [];
    try { first = command.targets(this.state, input); } catch { /* reported below, where the targets are taken again */ }
    const numbered = first.filter((t) => t.startsWith('numbers:')).map((t) => t.slice('numbers:'.length)).filter((d) => !!this.state.deals[d]);
    if (numbered.length) {
      await Promise.all(numbered.map((d) => this.loadDeal(d, { gaps: false })));
      if (numbered.some((d) => this.state.dealLoad[d] !== 'loaded')) {
        const message = 'The deal’s questions could not be loaded, so no number can be given yet. Try again in a moment.';
        if (!opts.quiet) this.toast(message, 'warn');
        return fail({ kind: 'rejected', message });
      }
    }
    if (opts.idempotencyKey && this.pendingKeys.has(opts.idempotencyKey)) return fail({ kind: 'rejected', message: 'Already in progress' });

    let targets: string[];
    try { targets = command.targets(this.state, input); } catch (e) { return this.crashed(e, command.name, null, [], opts); }
    const opId = opts.opId ?? this.services.ids.next('op');
    if (opts.idempotencyKey) this.pendingKeys.set(opts.idempotencyKey, opId);

    // Sequence on every target: wait for whatever is in flight on those records.
    const prior = Promise.all(targets.map((t) => this.queues.get(t) ?? Promise.resolve()));
    // A command that throws is a fault in the app or the backend adapter, not a refusal: it is caught here so the person is told and the caller still gets a Result.
    // a field's save: how many of this window's saves of the field had landed when it was sent (see execute). If the record
    // holds this window's last save of the field, that is what the text was typed over, even where the field could not tell
    // (a save the Store trimmed does not come back as the text sent)
    const fk = opts.over !== undefined ? fieldKey(command.name, input) : null;
    const watch = fk ? { command: command.name, input, last: fieldValue(this.state, command.name, input), rev: this.revOf(fieldRecord(input)), clash: !!this.state.conflicts[fieldRecord(input)], moved: !!this.state.conflicts[fieldRecord(input)] } : undefined;   // sent during a clash: whatever settles it may put back the value shown
    if (watch) this.fieldWaits.add(watch);
    const sent = fk ? { ...opts, landed: this.fieldLanded.get(fk) ?? 0, over: this.fieldWrote.get(fk)?.value ?? opts.over, watch } : opts;
    const run = prior.then(() => this.live(() => this.executeRetained(command, input, opId, targets, sent)))
      .catch((error) => this.crashed(error, command.name, opId, targets, opts));
    for (const t of targets) this.queues.set(t, run.catch(() => undefined));
    try {
      const r = await run;
      if (r.ok && this.heldShown.size) for (const v of [...this.heldShown.keys()]) this.sayHeldCount(v);   // a held draft discarded, say: the held notice's count follows
      return r;
    } finally { if (opts.idempotencyKey) this.pendingKeys.delete(opts.idempotencyKey); if (watch) this.fieldWaits.delete(watch); }   // also when the command threw before its turn
  }

  private async execute<I, In>(
    command: Command<I, In>, input: I, opId: string, targets: string[], opts: ExecuteOptions,
    previousRev: number | null = null,
  ): Promise<Result<{ opId: string; unchanged?: boolean }>> {
    // A field's save is planned from the record as it is now, when its turn in the queue comes. A change from another PC
    // that synced in since the person typed would be its base and be written over without a word. So the field
    // says what it typed over; anything else there, other than what this window's own last save of the field put there
    // (an earlier save of the same typing, queued ahead of this one), is another person's change: nothing is written,
    // and the field offers Keep mine / Take theirs.
    const key = opts.over !== undefined ? fieldKey(command.name, input) : null;
    if (key) {
      const now = fieldValue(this.state, command.name, input);
      // once a save of the field this window made after this one was sent has landed, what it was typed over is no base
      // any more: that value there again is a change from elsewhere (another PC taking our save back)
      // and a field that moved while the save waited, with no save of this window's landing, was changed elsewhere, even if
      // it is back to what the text was typed over (one PC's change, then another's putting it back)
      const own = this.fieldWrote.get(key)?.value; const since = (this.fieldLanded.get(key) ?? 0) > (opts.landed ?? 0);
      const moved = !!opts.watch?.moved; if (opts.watch) this.fieldWaits.delete(opts.watch);
      if (now !== undefined && now !== own && (since || moved || now !== opts.over)) return fail({ kind: 'conflict', message: CHANGED_ELSEWHERE });
    }
    const at = this.services.clock.now();
    const actor = this.state.user?.name ?? 'Unknown';
    const firm = FIRM;
    const planned = command.plan(this.state, input, { at, actor, firm, opId, ids: this.services.ids });
    if (!planned.ok) return this.refusePlan(planned.error, opts);
    const plan = planned.value;
    // nothing longer than an export cell holds is saved: the one place the limit is checked (domain/importExport.ts)
    const long = plan.upserts.map((u) => overLimit(u.kind, u.record as Record<string, unknown>)).find(Boolean);
    if (long) {
      if (!opts.quiet) this.toast(TOO_LONG, 'warn');
      return fail({ kind: 'invalid', message: TOO_LONG, fields: { [long]: TOO_LONG } });
    }
    const blocked = this.blockedBy(plan);
    if (blocked) {
      if (!opts.quiet) this.toast(blocked, 'warn');
      return fail({ kind: 'rejected', message: blocked });
    }
    if (!plan.upserts.length && !plan.removes?.length) {
      return this.finishUnchanged(command, input, plan, opId, opts, at, previousRev);
    }

    const pending = await this.journalPending(command, input, opId, targets, plan, opts, at, previousRev);
    if (!pending.ok) return pending;
    const { operation: op, baseRevs, pendingRev } = pending.value;
    const tx = this.toTransaction(plan, op, at, actor, pendingRev);
    const res = await this.services.repo.transaction(tx);
    if (!res.ok) {
      await this.recordFailedWrite(op, res.error, pendingRev, opts);
      this.onFailure(res.error, command, input, opId, opts, baseRevs);
      return res;
    }
    const revs = res.value;
    const settled: Operation = { ...op, ...(plan.settledInput !== undefined ? { input: plan.settledInput } : {}), state: 'succeeded', settledAt: this.services.clock.now(), inverse: plan.inverse, resultRevs: Object.fromEntries(plan.upserts.map((u) => [u.record.id, revs[u.record.id]])), resultAt: Object.fromEntries(plan.upserts.flatMap((u) => { const at = (u.record as { updatedAt?: unknown }).updatedAt; return typeof at === 'string' ? [[u.record.id, at]] : []; })), results: plan.undoesSafely ? {} : resultsOf(plan, revs) };
    this.apply(plan, revs, settled);
    if (key) { const v = fieldValue(this.state, command.name, input); if (v !== undefined) this.fieldWrote.set(key, { command: command.name, input, value: v, rev: this.revOf(fieldRecord(input)) }); this.fieldLanded.set(key, (this.fieldLanded.get(key) ?? 0) + 1); }
    // a version brought back beside the record's own: read the record again, so the two show as two versions to choose between
    for (const u of plan.upserts) if (u.beside) await this.reloadRecord(u.kind, u.record.id);
    // The journal entry kept on this PC was written with the change, before its results were known. It is written again with
    // them, so an Undo after a restart can still tell whether anything changed since (without them it is refused, in Undo).
    // If the journal refuses it, the entry stays pending although the change is made: the window keeps stamping `alive`, so
    // another window does not offer it for a Retry that would make it twice; the next start finds its line and settles it.
    let noted = false; try { noted = (await this.services.repo.transaction({ writes: [{ kind: 'op', id: opId, data: settled, expectedRev: 'any' }] })).ok; } catch { /* the Undo of this one is refused after a restart */ }
    if (!noted) { this.unsettledHere.add(opId); this.pulse(); }
    else if (this.unsettledHere.size) await this.settleLeftovers();
    if (FIELD_SAVES.has(command.name)) await this.settleField(command.name, input);
    // the same action sent again from where its caller kept it: a key is shared by a caller's actions (one per deal), so the input must match too
    if (opts.idempotencyKey) for (const [id, key] of [...this.unwritten]) { const o = this.state.ops[id]; if (key === opts.idempotencyKey && o?.command === command.name && JSON.stringify(o.input) === JSON.stringify(input)) await this.dropOp(id); }
    this.appendAudit(tx.audit ?? []);
    if (plan.dealId && (plan.upserts.some((u) => u.kind === 'finding') || plan.removes?.some((r) => r.kind === 'finding'))) void this.refreshGaps(plan.dealId);
    // a response on a question tied to no finding: the backend is told, and works out for itself whether it is new and which findings it could change
    if (plan.dealId && plan.upserts.some((u) => u.kind === 'question' && !!(u.record as Question).response?.trim() && !(u.record as Question).linkedFinding)) void this.services.ai.responses?.(plan.dealId).catch(() => undefined);
    if (this.state.ui.toasts.some((t) => t.sticky && !t.stays)) this.ui((ui) => ({ toasts: ui.toasts.filter((t) => !t.sticky || t.stays) }));
    if (plan.message) { this.lastMessage.set(opId, plan.message); if (this.lastMessage.size > 50) this.lastMessage.delete(this.lastMessage.keys().next().value!); }
    // An Undo offered earlier for a record this change has just removed, or for anything on a deal it has removed, can no
    // longer apply: it is withdrawn, and its notice stays.
    const removed = new Set((plan.removes ?? []).map((r) => r.id));
    if (removed.size) this.ui((ui) => ({ toasts: ui.toasts.map((t) => { const o = t.action?.opId ? this.state.ops[t.action.opId] : undefined; return o && ([...o.targets, ...Object.keys(o.resultRevs ?? {})].some((id) => removed.has(id)) || removed.has((o.input as { dealId?: string } | undefined)?.dealId ?? '')) ? { ...t, action: undefined } : t; }) }));   // a deal deleted takes the Undos of everything done on it
    if (plan.message && (!opts.quiet || plan.alwaysSay)) {
      const action = plan.inverse ? { label: 'Undo', opId } : undefined;
      // a command's message is completed work
      this.toast(plan.message, 'done', action, false, undefined, plan.messageCut);
    }
    if (plan.effect) this.startEffect(plan.effect, opId);
    if (plan.dealId && plan.indexFolders?.length) indexCommittedFolders(this, plan.dealId, plan.indexFolders);
    void this.pruneJournal();
    return ok({ opId });
  }

  private refusePlan(error: Failure, opts: DispatchOptions) {
    if (!opts.quiet && !opts.quietRefusal?.(error)) this.toast(error.message, 'warn');
    return fail(error);
  }

  /** Track every refused write that remains pending in the journal, including a refused failure marker (#565). */
  private async recordFailedWrite(operation: Operation, error: Failure, revision: number, opts: DispatchOptions) {
    const failed: Operation = {
      ...operation, state: 'failed', settledAt: this.services.clock.now(), error: error.message,
    };
    const field = FIELD_SAVES.has(operation.command);
    let settled = failed;
    if (opts.keep && NOT_YET.has(error.kind)) {
      await this.replaceUnwrittenReply(failed);
    } else if (UNWRITTEN.has(error.kind) && !opts.noRetry && (!opts.quiet || field)) {
      if (field) await this.settleField(operation.command, operation.input);
      this.trackUnwritten(failed);
    } else {
      settled = await this.settleFailedWrite(failed, revision);
    }
    this.set({ ...this.state, ops: { ...this.state.ops, [operation.id]: settled } });
  }

  private trackUnwritten(operation: Operation) {
    this.unwritten.set(operation.id, operation.idempotencyKey);
    this.pulse();
  }

  /** Keep the latest try of a retained reply available for a restart. */
  private async replaceUnwrittenReply(operation: Operation) {
    for (const [id, key] of [...this.unwritten]) if (key === operation.idempotencyKey) await this.forgetOp(id);
    this.trackUnwritten(operation);
  }

  /** The window that still holds a pending entry offers its Retry and Discard if settlement was refused (#565). */
  private async settleFailedWrite(failed: Operation, revision: number): Promise<Operation> {
    const saved = await this.services.repo.transaction({
      writes: [{ kind: 'op', id: failed.id, data: failed, expectedRev: revision }],
    }).catch(() => null);
    if (saved?.ok) return failed;
    const read = await this.readJournalOperation(failed.id).catch(() => null);
    const current = read?.ok ? read.value?.operation : undefined;
    if (current?.state === 'failed' || current?.state === 'succeeded' || current?.state === 'discarded') return current;
    return this.interruptWrite(failed);
  }

  private interruptWrite(failed: Operation): Operation {
    this.trackUnwritten(failed);
    return { ...failed, state: 'interrupted' };
  }

  /**
   * The journal exists for Undo and for recovering interrupted work, not as a permanent log. Settled
   * operations beyond the most recent JOURNAL_KEEP are removed, so the journal cannot fill storage.
   * Pending and interrupted operations are never removed, nor a save that could not be written (pending in the journal),
   * nor a deal's last import while it can be undone.
   */
  /** The retained import still needs its success identity if its reply or log-link step was interrupted. */
  private canPrune(operation: Operation, kept: Set<string>, lastImports: Set<string>) {
    return operation.state !== 'pending' && operation.state !== 'interrupted'
      && !this.unwritten.has(operation.id) && !kept.has(operation.id) && !lastImports.has(operation.id)
      && !(operation.state === 'succeeded' && operation.idempotencyKey?.startsWith('qa-import:'));
  }

  /** A retained import durably recorded completion; its correlation key may now leave the journal. */
  async releaseImport(key: string): Promise<boolean> {
    const read = await this.services.repo.list('op');
    if (!read.ok) return false;
    const writes: Transaction['writes'] = [];
    const released: Record<string, Operation> = {};
    for (const loaded of read.value) {
      const operation = this.parse('op', loaded) as Operation | null;
      if (operation?.idempotencyKey !== key) continue;
      if (operation.state === 'pending' || operation.state === 'interrupted') return false;
      const next = { ...operation, idempotencyKey: undefined };
      writes.push({ kind: 'op', id: operation.id, data: next, expectedRev: loaded.rev });
      released[operation.id] = next;
    }
    if (!writes.length) return true;
    const result = await this.services.repo.transaction({ writes });
    if (result.ok) this.set({ ...this.state, ops: { ...this.state.ops, ...released } });
    return result.ok;
  }

  private pruning = false;
  private async pruneJournal() {
    const all = Object.values(this.state.ops);
    if (this.pruning || all.length <= JOURNAL_KEEP + JOURNAL_SLACK) return;
    this.pruning = true;
    try {
      // each deal's last import stays, however old, for "Undo last import", while the deal does; also while a newer
      // one is still being written, which may yet fail and leave it the last
      const done = { ops: Object.fromEntries(all.filter((o) => o.state !== 'pending').map((o) => [o.id, o])) };
      const lasts = new Set(Object.keys(this.state.deals).flatMap((d) => [lastImport(this.state, d)?.id, lastImport(done, d)?.id].filter((x): x is string => !!x)));
      const kept = new Set([...this.stoppedReplies.values()].flatMap((w) => w.entries));   // a stopped reply's entry is pending in the journal, for the next start
      const settled = all.filter((operation) => this.canPrune(operation, kept, lasts))
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
      const drop = settled.slice(0, Math.max(0, all.length - JOURNAL_KEEP));
      if (!drop.length) return;
      const r = await this.services.repo.transaction({ writes: [], deletes: drop.map((o) => ({ kind: 'op' as RecordKind, id: o.id, expectedRev: null })) });
      if (!r.ok) return;
      const ops = { ...this.state.ops }; for (const o of drop) delete ops[o.id];
      this.set({ ...this.state, ops });
    } finally { this.pruning = false; }
  }

  /**
   * The reasons a plan may not be written, checked here once for every command. A deal with changes from another PC still
   * held back is not deleted. A record last changed by a newer build of the app is left to it. A record with versions
   * nobody has chosen between takes only that choice. Each is judged on the records the plan actually writes: one record
   * in a clash never stops work on another.
   */
  private blockedBy(plan: Plan): string | null {
    const s = this.state;
    const waits = plan.purgeDeal ? deleteWaits(s, plan.purgeDeal) : null; if (waits) return waits;
    const reopened = new Set((plan.reopen ?? []).map((r) => r.id));
    const kinds = new Set<string>(CLASH_KINDS);                                     // a tombstone shares its record's id: writing one is not editing the record
    const touched = [...plan.upserts.filter((u) => kinds.has(u.kind) && !u.resolves && !reopened.has(u.record.id)).map((u) => u.record.id), ...(plan.removes ?? []).filter((r) => kinds.has(r.kind) && !r.resolves).map((r) => r.id)];
    const late = touched.find((id) => this.newer.has(id));
    if (late) { const label = s.questions[late] ? `Q${s.questions[late].n}` : s.findings[late] ? findingName(s.findings[late].title) : s.items[late] ? 'This checklist item' : s.firmList[late] ? 'This list of the firm’s' : s.deals[late]?.name ?? 'This'; return `${label} was last changed on a newer version of Punchlist. Update this PC to change it.`; }
    const hit = touched.map((id) => s.conflicts[id]).find(Boolean);
    return hit ? `${conflictLabel(s, hit)} has ${versionsWord(hit.versions.length).toLowerCase()}. Choose one first` : null;
  }

  private startEffect(effect: NonNullable<Plan['effect']>, opId: string) {
    this.liveRequests.add(opId);
    // run as live work, so another window of this PC that opens the deal meanwhile sees this one is still at it
    let waits = false;
    const p = this.live(async () => { waits = await this.runEffect(effect, opId).catch(() => false); }).finally(() => { this.effects.delete(opId); if (!waits) { this.liveRequests.delete(opId); this.endRequest(opId); } this.touchCached(); });
    this.effects.set(opId, p);
  }

  /** Run a request's effect and write what it brings back; true when that is a kept reply still waiting to be written. */
  private async runEffect(effect: NonNullable<Plan['effect']>, opId: string): Promise<boolean> {
    let follow: { command: string; input: unknown } | null = null;
    try { follow = await effect(this.services, { opId }); } catch (e: any) { console.warn('effect threw', e); return false; }
    if (!follow) return false;
    const cmd = this.commands.get(follow.command); if (!cmd) return false;
    const kept = keepsWork(cmd.name, follow.input);
    // a draft whose model call failed is planned again on a conflict too, so other PCs see it failed, but is not kept
    const r = KEPT_REPLIES.has(cmd.name) ? await this.tryReply(cmd, follow.input, { keep: kept }).catch(() => fail({ kind: 'failed' as const, message: 'That didn’t finish. Reload to see what was saved.' })) : await this.dispatch(cmd, follow.input as any, { quiet: true, system: true });
    // a kept reply is tried again on its own; a failed model call keeps its Retry
    if (!r.ok && r.error.kind === 'failed') {
      const text = kept ? 'Draft not saved ·' : `${r.error.message}`;
      this.toast(text, 'warn', kept ? this.retryNow : this.retryOf(follow));
    } else if (r.ok) {
      const op = this.state.ops[r.value.opId];
      const msg = this.lastMessage.get(r.value.opId);
      if (msg && op?.inverse) this.toast(msg, 'done', { label: 'Undo', opId: r.value.opId });
    }
    if (kept && !r.ok && NOT_YET.has(r.error.kind)) { this.waitReply(opId, cmd, follow.input, r.error.kind); return true; }
    if (kept && !r.ok && r.error.kind === 'rejected') { await this.holdReply(opId, cmd, follow.input, r.error.kind); this.sayHeld(opId, follow.input, r.error.message); return true; }   // said once held, so the notice counts it
    return false;
  }

  /**
   * One try at writing a kept reply. A reply planned against a question that another PC changed in the moment before it was
   * written (its change had reached the folder but not this window) is planned again against the question as it now stands,
   * as long as reading it again finds it moved: each refusal then means another PC's change really arrived.
   */
  private async tryReply(cmd: Command<any>, input: unknown, o: { keep: boolean; again?: Failure['kind'] }): Promise<Result<{ opId: string }>> {
    const opts = { quiet: true, system: true, ...(o.keep ? { keep: true, idempotencyKey: replyKey(input), again: o.again } : {}) };
    // a record this window does not hold (after a restart, its deal not loaded yet) is read first: a read that fails is no
    // reason to take it as deleted, which would end the reply with nothing written
    const ids = cmd.targets(this.state, input as any);
    if (ids.some((id) => this.revOf(id) === undefined) && !(await this.reloadTargets(ids))) return fail({ kind: 'unreachable', message: 'The Punchlist folder could not be read' });
    let r = await this.dispatch(cmd, input as any, opts);
    for (let n = 0; n < REPLAN_NOW && !r.ok && r.error.kind === 'conflict'; n++) {
      const { recordId, expected } = r.error;
      await this.reloadTargets(cmd.targets(this.state, input as any));
      // the window still holds the version the refused plan was made on: planned again, it would be refused the same way
      if (recordId && typeof expected === 'number' && this.revOf(recordId) === expected) break;
      r = await this.dispatch(cmd, input as any, opts);
    }
    // written, or with nothing left to write (superseded, or refused for good): no earlier try of it waits any longer
    // (a refusal while the question is in two versions, or last changed on a newer version of the app, is not for good: the text is kept, `holdReply`)
    if (o.keep && (r.ok || (!NOT_YET.has(r.error.kind) && r.error.kind !== 'rejected'))) for (const [id, key] of [...this.unwritten]) if (key === replyKey(input)) await this.dropOp(id);
    return r;
  }
  /** a notice's button for replies that are already tried again on their own (a held reply is left: only choosing a version helps it) */
  private readonly retryNow = { label: 'Retry Now', run: () =>
    { for (const [req, w] of [...this.stoppedReplies]) if (w.last !== 'rejected') this.retryKeptReply(req);
    void this.tryWaiting(true); } };
  /** how long a kept reply waits between tries (tests shorten it) */
  readonly replyWait = { first: REPLY_RETRY_FIRST, max: REPLY_RETRY_MAX };
  /** kept replies waiting to be written, by the request they answer, oldest first */
  private waitingReplies = new Map<string, WaitingReply>();
  /**
   * Kept replies whose tries ran out, by request: the draft shows as failed, and Retry on it (or the app connecting again) writes
   * this text rather than asking the model again. Their entries stay pending in the journal, so the next start writes them too.
   */
  private stoppedReplies = new Map<string, { cmd: Command<any>; input: unknown; last?: Failure['kind']; entries: string[] }>();
  /** whether the draft of this request has text kept for Retry to write */
  hasKeptReply(requestOpId: string): boolean { return this.stoppedReplies.has(requestOpId); }
  /** Retry on a draft whose kept text could not be saved: its tries start again, at once. */
  retryKeptReply(requestOpId: string) {
    const w = this.stoppedReplies.get(requestOpId); if (!w) return;
    this.stoppedReplies.delete(requestOpId); this.heldSaid.delete(requestOpId);   // tried again by the person: a cause still there is said again
    for (const id of w.entries) this.unwritten.set(id, replyKey(w.input));
    this.endedRequests.delete(requestOpId);                                          // shown as being written again
    const shown = Object.values(this.state.questions).filter((q) => q.draft?.opId === requestOpId);
    if (shown.length) this.set({ ...this.state, questions: { ...this.state.questions, ...Object.fromEntries(shown.map((q) => [q.id, { ...q, draft: { ...q.draft!, status: 'pending' as const } }])) } });
    this.waitReply(requestOpId, w.cmd, w.input, w.last, 0);                          // its five tries start again, the first at once
  }
  private replyRound: { timer: ReturnType<typeof setTimeout> | null; busy: boolean; soon: boolean } = { timer: null, busy: false, soon: false };
  /**
   * A kept reply that could not be written waits here, and its request stays live, so its draft keeps showing as being written
   * rather than failed (Retry there would pay for the model again) and is not given up on (`draftsNotEnded`). Its latest try
   * stays pending in this PC's journal, so if the app is closed first the next start writes it (`resumeReplies`). It ends once
   * written, or once its plan finds nothing to write (the request was superseded or discarded) or is refused for good.
   */
  private waitReply(requestOpId: string, cmd: Command<any>, input: unknown, last: Failure['kind'] | undefined, tries = 1) {
    if (this.waitingReplies.has(requestOpId)) return;
    // each reply keeps its own count and gaps (5, 10, 20, 40 seconds after its first try), whatever else is waiting;
    // one not tried yet (after a restart, or Retry) is due at once
    const first = this.replyWait.first;
    this.waitingReplies.set(requestOpId, { cmd, input, last, tries, due: Date.now() + (tries ? first : 0), gap: tries ? Math.min(first * 2, this.replyWait.max) : first });
    this.liveRequests.add(requestOpId); this.pulse();
    this.nextRound();
  }
  /** the round's timer is set for the reply due first (a round under way sets it when it ends) */
  private nextRound() {
    const round = this.replyRound; if (round.busy) return;
    if (round.timer) { clearTimeout(round.timer); round.timer = null; }
    let due = Infinity; for (const w of this.waitingReplies.values()) if (w.due < due) due = w.due;
    if (due === Infinity) return;
    round.timer = setTimeout(() => { round.timer = null; void this.tryWaiting(); }, Math.max(0, due - Date.now())); (round.timer as any).unref?.();
  }
  /** A reply's tries ran out: it stops waiting, and its draft shows as failed, with Retry writing the kept text. */
  private stopReply(requestOpId: string) {
    const w = this.waitingReplies.get(requestOpId); if (!w) return;
    const key = replyKey(w.input); const entries = [...this.unwritten].filter(([, k]) => k === key).map(([id]) => id);
    for (const id of entries) this.unwritten.delete(id);                             // left pending in the journal, for the next start
    this.stoppedReplies.set(requestOpId, { cmd: w.cmd, input: w.input, last: w.last, entries });
    this.endWait(requestOpId);
  }
  private endWait(requestOpId: string) {
    this.waitingReplies.delete(requestOpId); this.pulse();
    if (this.heldShown.size && this.stoppedReplies.get(requestOpId)?.last !== 'rejected') for (const v of [...this.heldShown.keys()]) this.sayHeldCount(v);   // written or ended: no longer counted as held
    this.liveRequests.delete(requestOpId); this.endRequest(requestOpId); this.touchCached();
  }
  /**
   * One round over the waiting replies that are due, one at a time (with `all`, every waiting reply: the app connected again, or
   * Retry now). When the folder itself refuses one (out of reach, full, or failing), the rest wait rather than each paying a
   * refused write, so thousands of waiting replies cost one try a round; that one goes to the back, so the next round starts with
   * another. A reply due in the round counts a try whether it was tried or held back by that refusal; once a write goes
   * through, the folder is taking writes again, and every waiting reply is tried in the same round.
   */
  private async tryWaiting(all = false): Promise<void> {
    const round = this.replyRound;
    if (round.busy) { if (all) round.soon = true; return; }                          // a reply falling due meanwhile is caught by `nextRound`
    round.busy = true; round.soon = false; if (round.timer) { clearTimeout(round.timer); round.timer = null; }
    const now = Date.now(), gather = this.replyWait.first / 5;                       // replies due within a moment share this round
    const counted: string[] = [];
    let open = all, blocked = false;
    try {
      for (const [req, w] of [...this.waitingReplies]) {
        if (!this.waitingReplies.has(req)) continue;
        const due = w.due <= now + gather;
        if (blocked) { if (due) counted.push(req); continue; }
        if (!open && !due) continue;
        counted.push(req);
        const r = await this.tryReply(w.cmd, w.input, { keep: true, again: w.last }).catch(() => fail({ kind: 'failed' as const, message: 'threw' }));
        if (r.ok) { open = true; this.endWait(req); continue; }
        if (r.error.kind === 'rejected') { await this.holdReply(req, w.cmd, w.input, r.error.kind); this.sayHeld(req, w.input, r.error.message); continue; }
        if (!NOT_YET.has(r.error.kind)) { this.endWait(req); continue; }
        w.last = r.error.kind;
        if (r.error.kind === 'conflict') continue;                                  // this question only: the others are tried
        this.waitingReplies.delete(req); this.waitingReplies.set(req, w);            // to the back
        blocked = true;
      }
    } finally { round.busy = false; }
    const at = Date.now();
    for (const req of counted) {
      const w = this.waitingReplies.get(req); if (!w) continue;
      if (++w.tries >= REPLY_TRIES) { this.stopReply(req); continue; }
      w.due = at + w.gap; w.gap = Math.min(w.gap * 2, this.replyWait.max);
    }
    if (!this.waitingReplies.size) return;
    if (round.soon) return this.tryWaiting(true);                                    // connected again during that round: once more now
    this.nextRound();
  }
  /** held replies to be said in the next notice, by request: the question's number, and whether the cause is its versions */
  private heldToSay = new Map<string, { n?: number; versions: boolean; message: string }>();
  /** held replies already said in this window: said again only after the person tries one again (Retry, Draft all) */
  private heldSaid = new Set<string>();
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  /** the held notice of each cause last shown, and the drafts it counts */
  private heldShown = new Map<boolean, { id: number; drafts: Map<string, { n?: number; versions: boolean; message: string }> }>();
  /**
   * A held reply's cause is said once, in one notice for all the replies held about the same time, by count when there is
   * more than one ("Draft not saved: 120 questions have versions to choose between"), and by the question's number, not the
   * folder's own wording (which names the record by id), when there is one.
   */
  private sayHeld(requestOpId: string, input: unknown, message: string) {
    if (this.heldSaid.has(requestOpId)) return;
    this.heldSaid.add(requestOpId);
    const q = this.state.questions[(input as { questionId?: string } | null)?.questionId ?? ''];
    this.heldToSay.set(requestOpId, { n: q?.n, versions: /versions/.test(message), message });
    if (this.heldTimer) return;
    this.heldTimer = setTimeout(() => {
      this.heldTimer = null; const now = [...this.heldToSay]; this.heldToSay.clear();
      for (const versions of [true, false]) {
        const group = now.filter(([, h]) => h.versions === versions); if (!group.length) continue;
        // a held notice of the same cause still on screen takes these drafts into its count, in place, so drafts held one
        // after another (as the model answers them) take one place in the notices and nothing in front of an Undo moves
        const shown = this.heldShown.get(versions);
        const still = !!shown && this.state.ui.toasts.some((t) => t.id === shown.id);
        const all = new Map([...(still ? shown!.drafts : []), ...group]);
        if (still) { shown!.drafts = all; this.sayHeldCount(versions); continue; }
        const held = this.stillHeld(all); if (!held.size) continue;
        this.heldShown.set(versions, { id: this.toast(this.heldText(versions, held), 'warn'), drafts: held });
      }
    }, HELD_GATHER);
    (this.heldTimer as any).unref?.();
  }
  /** of these held drafts, those still held: one written since (Retry once a version was chosen) is no longer counted */
  private stillHeld(drafts: Map<string, { n?: number; versions: boolean; message: string }>) {
    return new Map([...drafts].filter(([req]) => {
      const w = this.stoppedReplies.get(req) ?? this.waitingReplies.get(req);
      if (!w || (!this.waitingReplies.has(req) && w.last !== 'rejected')) return false;
      // a draft discarded meanwhile (the question no longer names this request) is not held any more; a question
      // this window does not hold (its deal closed) cannot tell, and stays counted
      const q = this.state.questions[(w.input as { questionId?: string } | null)?.questionId ?? ''];
      return !q || q.draft?.opId === req;
    }));
  }
  private heldText(versions: boolean, held: Map<string, { n?: number; versions: boolean; message: string }>): string {
    const [only] = held.values();
    if (versions) return held.size === 1 ? `Draft not saved: ${only.n ? `Q${only.n}` : 'the question'} has versions to choose between` : `Draft not saved: ${held.size} questions have versions to choose between`;
    return held.size === 1 ? `Draft not saved: ${only.message}` : `Draft not saved: ${held.size} questions were last changed on a newer version of Punchlist. Update this PC to save them.`;
  }
  /** The held notice of this cause, if it still shows, says how many drafts are still held: its text changes in place, and it goes once none is. */
  private sayHeldCount(versions: boolean) {
    const shown = this.heldShown.get(versions); if (!shown) return;
    if (!this.state.ui.toasts.some((t) => t.id === shown.id)) { this.heldShown.delete(versions); return; }
    shown.drafts = this.stillHeld(shown.drafts);
    if (!shown.drafts.size) { this.dismissToast(shown.id); this.heldShown.delete(versions); return; }
    const text = this.heldText(versions, shown.drafts);
    if (this.state.ui.toasts.find((t) => t.id === shown.id)?.text === text) return;   // no change: nothing moves, and it times out as it would
    this.ui((ui) => ({ toasts: ui.toasts.map((t) => (t.id === shown.id ? { ...t, text } : t)) }));
    if (!this.toastsHeld) this.armToast(shown.id);                                   // shown for its full time again
  }
  /**
   * A kept reply the question cannot take yet: it is in two versions, or was last changed on a newer version of the app (#22).
   * Not a refusal for good, so the text is kept as when its tries run out: the draft shows as failed, Retry or Draft all writes
   * this text once the question is settled, and the reply's entry stays pending in this PC's journal for the next start
   * (written here if no try of it got one).
   */
  private async holdReply(requestOpId: string, cmd: Command<any>, input: unknown, last: Failure['kind']) {
    const key = replyKey(input);
    if (![...this.unwritten.values()].includes(key)) {
      const opId = this.services.ids.next('op'); const at = this.services.clock.now();
      const op: Operation = { id: opId, command: cmd.name, input, targets: cmd.targets(this.state, input as any), baseRevs: {}, dealId: (input as { dealId?: string }).dealId, state: 'pending', window: this.windowId, startedAt: at };
      const j = await this.services.repo.transaction({ writes: [{ kind: 'op', id: opId, data: op, expectedRev: null }] }).catch(() => null);
      if (j?.ok) { this.set({ ...this.state, ops: { ...this.state.ops, [opId]: op } }); this.unwritten.set(opId, key); }
    }
    if (!this.waitingReplies.has(requestOpId)) this.waitingReplies.set(requestOpId, { cmd, input, last, tries: 0, due: Infinity, gap: 0 });
    else this.waitingReplies.get(requestOpId)!.last = last;
    this.stopReply(requestOpId);
  }
  /**
   * Kept replies whose try was still pending in the journal when the window that made it went away (the app closed while it
   * waited): written now, from the entry's own input. The entry is settled by the try that goes through, or by a later one
   * that is kept in its place.
   */
  private resumeReplies(ops: Operation[]) {
    const mine: Operation[] = [];
    for (const op of ops) {
      if (op.state !== 'interrupted' || !keepsWork(op.command, op.input)) continue;
      const cmd = this.commands.get(op.command); const requestOpId = (op.input as { requestOpId?: unknown } | null)?.requestOpId;
      if (!cmd || typeof requestOpId !== 'string') continue;
      // the entry is this window's now: pending again, so it is not offered in the interrupted bar (whose Discard could not
      // stop it) and another window leaves it to this one
      mine.push({ ...op, state: 'pending', window: this.windowId });
      this.unwritten.set(op.id, replyKey(op.input));
      // tried in the shared round, as any waiting reply, not each at once; one try per reply: a second entry for it
      // (the app closed between writing a try and settling the one before) is settled with it
      if (!this.stoppedReplies.has(requestOpId)) this.waitReply(requestOpId, cmd, op.input, undefined, 0);
    }
    if (!mine.length) return;
    this.set({ ...this.state, ops: { ...this.state.ops, ...Object.fromEntries(mine.map((o) => [o.id, o])) } });
    void this.services.repo.transaction({ writes: mine.map((o) => ({ kind: 'op' as const, id: o.id, data: o, expectedRev: 'any' as const })) }).catch(() => undefined);   // one write for them all
    this.pulse();
  }
  /**
   * Before a deal's pending drafts are given up: a reply to one of them that another window of this PC began after this one
   * started (so this one never saw its entry) and still holds in the journal is watched, and written here once that window is
   * gone, rather than its draft being marked failed (`recheck`, `resumeReplies`).
   */
  private async adoptReplies(dealId: string): Promise<string[]> {
    const asked = new Set(Object.values(this.state.questions).flatMap((q) => (q.dealId === dealId && q.draft?.status === 'pending' && q.draft.opId ? [q.draft.opId] : [])));
    if (!asked.size) return [];
    const all = await this.services.repo.list('op'); if (!all.ok) return [...asked];      // the journal could not be read: nothing is given up this time
    const held: string[] = [];
    for (const l of all.value) {
      const op = this.parse('op', l) as Operation | null;
      if (!op || this.state.ops[op.id] || (op.state !== 'pending' && op.state !== 'interrupted') || !keepsWork(op.command, op.input)) continue;
      const req = (op.input as { requestOpId?: unknown }).requestOpId; if (typeof req !== 'string' || !asked.has(req)) continue;
      this.set({ ...this.state, ops: { ...this.state.ops, [op.id]: op } }); held.push(req);   // not given up meanwhile
      if (op.state === 'interrupted') this.resumeReplies([op]);
      else this.recheck(op.id, this.isLive(op) ? STALE_MS : 0);                        // written here once that window is gone
    }
    return held;
  }
  /**
   * Another window's kept reply puts each new try in place of the last, so the entry this window was watching is settled as
   * discarded while the reply still waits there. The try now pending in its place is watched instead, so if that window
   * closes, this one writes the reply (`recheck`, `resumeReplies`).
   */
  private async followReply(gone: Operation) {
    const key = replyKey(gone.input); const all = await this.services.repo.list('op'); if (!all.ok) return;
    for (const l of all.value) {
      const op = this.parse('op', l) as Operation | null;
      if (!op || op.state !== 'pending' || this.state.ops[op.id] || !KEPT_REPLIES.has(op.command) || replyKey(op.input) !== key) continue;
      this.set({ ...this.state, ops: { ...this.state.ops, [op.id]: op } }); this.recheck(op.id, 0);   // looked at now: its window may be gone already
    }
  }
  private lastMessage = new Map<string, string>();
  /**
   * Retry, on the notice of a model call that failed once its own quiet retries were used up (decisions: Retries). Only for
   * a call that failed: an update refused because the finding changed or closed meanwhile says so, and is run again from the finding.
   */
  private retryOf(follow: { command: string; input: unknown }): State['ui']['toasts'][number]['action'] {
    const i = follow.input as { dealId?: string; findingId?: string; result?: object };
    if (follow.command === 'ApplyReassessment' && i.dealId && i.findingId && i.result && 'error' in i.result) { const { dealId, findingId } = i; return { label: 'Retry', run: () => void reassess(this, dealId, findingId) }; }
    return undefined;
  }

  /** request operation ids whose effect has ended in this session, its follow-up written or not */
  private endedRequests = new Set<string>();
  /**
   * A question as this window shows it. A draft still pending on a request that has ended here has nothing coming: its
   * result was refused (storage full, two versions, the question deleted, then put back with Undo).
   * It shows as failed, so Retry and Discard are offered, and is never left spinning. That cannot
   * always be saved when it happens, for the same reasons, so the stored record catches up with the next change to the
   * question, or with RecoverDrafts when the deal is next loaded.
   */
  private shownQuestion(q: Question): Question {
    return q.draft?.status === 'pending' && q.draft.opId && this.endedRequests.has(q.draft.opId) ? { ...q, draft: { ...q.draft, status: 'failed' } } : q;
  }
  private endRequest(opId: string) {
    this.endedRequests.add(opId);
    const stuck = Object.values(this.state.questions).filter((q) => q.draft?.status === 'pending' && q.draft.opId === opId);
    if (stuck.length) this.set({ ...this.state, questions: { ...this.state.questions, ...Object.fromEntries(stuck.map((q) => [q.id, this.shownQuestion(q)])) } });
  }

  /**
   * The versions this window has read of each record nobody is shown a choice for (a deletion note, a person's own list of
   * deals), while it has more than one. Every write to such a record names them (`seen`), so the repository refuses one
   * planned before another PC's version arrived here, rather than set that version aside unseen.
   */
  private versionsRead = new Map<string, string[]>();
  private seenOf(kind: RecordKind, id: string): { seen?: string[] } {
    return kind === 'op' || (CLASH_KINDS as readonly string[]).includes(kind) ? {} : { seen: this.versionsRead.get(`${kind}/${id}`) ?? [] };
  }

  private toTransaction(plan: Plan, op: Operation, at: string, actor: string, pendingRev: number): Transaction {
    const settled: Operation = { ...op, ...(plan.settledInput !== undefined ? { input: plan.settledInput } : {}), state: 'succeeded', settledAt: at, inverse: plan.inverse };
    return {
      writes: [
        ...plan.upserts.map((u) => ({ kind: u.kind, id: u.record.id, data: u.record, expectedRev: u.expectedRev, ...(u.resolves ? { resolves: u.resolves } : {}), ...(u.beside ? { beside: true } : {}), ...this.seenOf(u.kind, u.record.id) })),
        { kind: 'op' as RecordKind, id: op.id, data: settled, expectedRev: pendingRev },
      ],
      deletes: (plan.removes ?? []).map((r) => ({ kind: r.kind, id: r.id, expectedRev: r.rev, ...(r.resolves ? { resolves: r.resolves } : {}), ...(r.undoesImport ? { undoesImport: true as const } : {}), ...this.seenOf(r.kind, r.id) })),
      ...(plan.expects ? { expects: plan.expects } : {}),
      ...(plan.expectsMembers ? { expectsMembers: plan.expectsMembers } : {}),
      index: plan.index,
      purgeDeal: plan.purgeDeal,
      ...(plan.seen ? { seen: plan.seen } : {}),
      ...(plan.reopen ? { reopen: plan.reopen } : {}),
      audit: plan.audit.map((a) => AuditEntry.parse({ ...a, at, actor, opId: op.id })),
    };
  }

  private apply(plan: Plan, revs: Record<string, number>, op: Operation) {
    const s = { ...this.state, deals: { ...this.state.deals }, questions: { ...this.state.questions }, findings: { ...this.state.findings }, tombstones: { ...this.state.tombstones }, items: { ...this.state.items }, firmList: { ...this.state.firmList }, members: { ...this.state.members }, conflicts: { ...this.state.conflicts }, ops: { ...this.state.ops, [op.id]: op } };
    if (plan.purgeDeal) {
      for (const bucket of [s.questions, s.findings, s.tombstones, s.items] as Record<string, { dealId: string; id: string }>[]) for (const [id, r] of Object.entries(bucket)) if (r.dealId === plan.purgeDeal && id !== plan.purgeDeal) delete bucket[id];
      for (const [id, c] of Object.entries(s.conflicts)) if (c.dealId === plan.purgeDeal) delete s.conflicts[id];
    }
    for (const u of [...plan.upserts.map((x) => ({ id: x.record.id, resolves: x.resolves })), ...(plan.removes ?? [])]) if (u.resolves) delete s.conflicts[u.id];                 // a person chose: the clash is over
    for (const r of plan.reopen ?? []) { const c = this.conflictOf(r.kind, r.id, revs[r.id] ?? 0, r.versions); if (c) s.conflicts[r.id] = c; }
    for (const u of plan.upserts) {
      const rec: any = { ...u.record };
      if ('rev' in rec) rec.rev = revs[u.record.id];
      if (u.kind === 'deal') s.deals[rec.id] = rec as Deal;
      else if (u.kind === 'question') s.questions[rec.id] = this.shownQuestion(rec as Question);
      else if (u.kind === 'finding') s.findings[rec.id] = rec as Finding;
      else if (u.kind === 'tombstone') s.tombstones[rec.id] = rec as Tombstone;
      else if (u.kind === 'item') s.items[rec.id] = rec as Item;
      else if (u.kind === 'firmList') s.firmList[rec.id] = rec as ListRecord;
      else if (u.kind === 'member') s.members[rec.id] = rec as Member;
      else if (u.kind === 'op') s.ops[rec.id] = rec as Operation;
    }
    for (const r of plan.removes ?? []) {
      if (r.kind === 'deal') delete s.deals[r.id];
      else if (r.kind === 'question') { delete s.questions[r.id]; if (s.ui.selectedQuestion === r.id) s.ui = { ...s.ui, selectedQuestion: null }; }
      else if (r.kind === 'finding') delete s.findings[r.id];
      else if (r.kind === 'tombstone') delete s.tombstones[r.id];
      else if (r.kind === 'item') delete s.items[r.id];
      else if (r.kind === 'firmList') delete s.firmList[r.id];
      else if (r.kind === 'member') delete s.members[r.id];
    }
    // a deal whose items changed (a list swap, an item turned off or on, and their Undo) lists and counts them afresh, with no check
    const itemDeals = new Set([...plan.upserts.filter((u) => u.kind === 'item').map((u) => (u.record as Item).dealId), ...(plan.removes ?? []).filter((r) => r.kind === 'item').map((r) => this.state.items[r.id]?.dealId)]);
    this.set(s);
    for (const dealId of itemDeals) if (dealId) { void this.refreshProgress(dealId); if (this.state.checklists[dealId] !== undefined) void this.refreshChecklist(dealId); }
  }

  /**
   * Something threw where a Result was expected. Before the journal entry exists nothing has been written, and the message says so.
   * After it, the write may or may not have happened: the entry is marked failed, and the message offers to read the records again.
   */
  private async crashed(e: unknown, name: string, opId: string | null, targets: string[], opts: { quiet?: boolean; keep?: boolean; idempotencyKey?: string }): Promise<Result<{ opId: string }>> {
    console.error(`command ${name} threw`, e);
    const op = opId ? this.state.ops[opId] : undefined;
    if (!op) {                                                                          // no journal entry: nothing was written
      const message = 'That didn’t work. Nothing was changed.';
      if (!opts.quiet) this.toast(message, 'warn');
      return fail({ kind: 'failed', message });
    }
    if (op.state === 'pending') await this.recordCrashedWrite(op, e, opts.keep);
    const ids = [...new Set([...targets, ...op.targets])];
    if (!opts.quiet) {
      this.toast('That didn’t finish ·', 'warn', { label: 'Reload', run: () => void this.reloadTargets(ids) });
    }
    return fail({ kind: 'failed', message: 'That didn’t finish. Reload to see what was saved.' });
  }

  /** A thrown write may have committed before the adapter could return its receipt. */
  private async recordCrashedWrite(operation: Operation, error: unknown, kept?: boolean) {
    const failed: Operation = {
      ...operation, state: 'failed', settledAt: this.services.clock.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    let current = failed;
    if (kept) await this.replaceUnwrittenReply(failed);
    else current = await this.confirmCrashedWrite(failed);
    this.set({ ...this.state, ops: { ...this.state.ops, [operation.id]: current } });
  }

  private async confirmCrashedWrite(failed: Operation) {
    const read = await this.readJournalOperation(failed.id).catch(() => null);
    if (!read?.ok || !read.value) return this.interruptWrite(failed);
    const { operation, revision } = read.value;
    return operation.state === 'pending' ? this.settleFailedWrite(failed, revision) : operation;
  }

  /** whether any of these records now has another rev than the one given: a change from elsewhere (another PC, another window) has landed since */
  private movedSince(baseRevs: Record<string, number>) { return Object.entries(baseRevs).some(([id, rev]) => { const now = this.revOf(id); return now !== undefined && now !== rev; }); }
  /**
   * A field's save has gone through, found nothing to change, or failed in its turn: it holds the person's latest text.
   * Every earlier save of the same field (or of the same input) that could not be written, in this run (failed) or an
   * earlier one (interrupted), is settled as discarded, so only the latest waits, and a restart does not offer older text
   * for a Retry that would write over newer.
   */
  private async settleField(command: string, input: unknown) {
    const key = fieldKey(command, input); const same = JSON.stringify(input);
    for (const op of Object.values(this.state.ops)) {
      if (op.command !== command || !((op.state === 'failed' && this.unwritten.has(op.id)) || op.state === 'interrupted')) continue;
      if ((key && fieldKey(op.command, op.input) === key) || JSON.stringify(op.input) === same) await this.dropOp(op.id);
    }
  }
  /** by a field's key, the value this window's last save of that field wrote: a save queued behind it was typed over it */
  private fieldWrote = new Map<string, { command: string; input: unknown; value: string; rev: number | undefined }>();
  /** by a field's key, how many of this window's saves of it have been written */
  private fieldLanded = new Map<string, number>();
  /** field saves waiting their turn, with whether their field's value has moved since they were sent */
  private fieldWaits = new Set<FieldWait>();
  /**
   * A field's value moved off what this window's save wrote (a change from elsewhere, an Undo): that write is no base any
   * more, even if the value comes back; and a waiting save's field moved. Each state change is followed one version at a
   * time: when the record's rev jumps by more than one (a change and its put-back read in one sync), the field may have
   * moved unseen, so it counts as moved. So does the record going into a clash: the field shows one of its versions,
   * and another PC's later version can settle it back to that value with no change seen. That can ask although only other
   * fields changed; it never writes over.
   */
  private forgetMoved() {
    for (const [k, w] of this.fieldWrote) {
      const r = this.revOf(fieldRecord(w.input));
      if (fieldValue(this.state, w.command, w.input) !== w.value || jumped(w.rev, r) || this.state.conflicts[fieldRecord(w.input)]) this.fieldWrote.delete(k); else if (r !== undefined) w.rev = r;
    }
    for (const w of this.fieldWaits) {
      const v = fieldValue(this.state, w.command, w.input); const r = this.revOf(fieldRecord(w.input)); const clash = !!this.state.conflicts[fieldRecord(w.input)];
      if (v !== w.last || jumped(w.rev, r) || (clash && !w.clash)) w.moved = true;
      w.last = v; w.clash = clash; if (r !== undefined) w.rev = r;
    }
  }
  /** operations run again by a person's Retry: a second press, or the notice's Retry and the bar's, runs nothing more */
  private rerun = new Set<string>();
  /** actions made here whose journal entry could not be settled: still pending in the journal, left to this window while it is open */
  private unsettledHere = new Set<string>();
  /** The journal took a write again: the entries it refused before are written now, as they stand in the window. */
  private async settleLeftovers() {
    for (const id of [...this.unsettledHere]) {
      const op = this.state.ops[id];
      const r = op ? await this.services.repo.transaction({ writes: [{ kind: 'op', id, data: op, expectedRev: 'any' }] }).catch(() => null) : { ok: true };
      if (r?.ok) this.unsettledHere.delete(id);
    }
    this.pulse();
  }
  /**
   * Remove a kept reply's earlier try from the journal outright: the try made in its place holds the same input, so marking it
   * discarded would only grow the journal with every try while the folder is away.
   */
  private async forgetOp(opId: string) {
    this.unwritten.delete(opId);
    const r = await this.services.repo.transaction({ writes: [], deletes: [{ kind: 'op', id: opId, expectedRev: null }] }).catch(() => null);
    if (!r?.ok) {
      const op = this.state.ops[opId]; const next = op && { ...op, state: 'discarded' as const, settledAt: this.services.clock.now() };
      const m = next ? await this.services.repo.transaction({ writes: [{ kind: 'op', id: opId, data: next, expectedRev: 'any' }] }).catch(() => null) : null;
      if (m?.ok && next) this.set({ ...this.state, ops: { ...this.state.ops, [opId]: next } });
      else this.unwritten.set(opId, op ? replyKey(op.input) : undefined);                   // still pending in the journal: settled with the reply
      return;
    }
    const ops = { ...this.state.ops }; delete ops[opId]; this.set({ ...this.state, ops });
  }
  /** Settle a waiting or interrupted operation as discarded: it is not offered again. */
  private async dropOp(opId: string, revision: number | 'any' = 'any') {
    const operation = this.state.ops[opId];
    if (operation) {
      const next = { ...operation, state: 'discarded' as const, settledAt: this.services.clock.now() };
      const saved = await this.services.repo.transaction({
        writes: [{ kind: 'op', id: opId, data: next, expectedRev: revision }],
      });
      if (!saved.ok) return saved;
      this.set({ ...this.state, ops: { ...this.state.ops, [opId]: next } });
    }
    this.unwritten.delete(opId);
    this.pulse();
  }

  private onFailure(
    err: Failure, command: Command<any>, input: unknown, opId: string,
    opts: DispatchOptions, baseRevs: Record<string, number>,
  ) {
    // a kept reply's later try failing as the last one did: said once, by the first (a try made as the model service answers the
    // probe does not bring the offline bar back while only the folder is out). A new cause, such as a full disk, is said.
    if (opts.again === err.kind) return;
    // The offline bar says the backend is out of reach, but its Retry only reconnects: the action is also said not to have
    // happened, with a Retry of its own, as any other failed action is. A quiet caller says it in its own way.
    if (err.kind === 'unreachable') this.netDown();
    // only a field's own save leaves a field marked "Not saved"; anything else is said plainly, short enough to show whole
    // a waiting draft saves itself once there is room: the notice says only the cause, with Retry now (decisions: one name per thing)
    if (err.kind === 'storageFull' && opts.keep) {
      this.toast('Draft not saved: storage is full ·', 'warn', this.retryNow, true);
      return;
    }
    if (err.kind === 'storageFull') {
      const text = FIELD_SAVES.has(command.name)
        ? 'Not saved: storage is full. Free some space, then retry the fields marked Not saved.'
        : `${commandLabel(command.name, input)}: not saved, storage is full. Free some space, then try again.`;
      this.toast(text, 'warn', undefined, true);
      return;
    }
    if (opts.quiet) return;
    if (opts.noRetry) {
      const text = err.kind === 'conflict' ? 'Changed elsewhere — not saved' : `Couldn’t save: ${err.message}`;
      this.toast(text, 'warn');
      return;
    }
    const label = err.kind === 'conflict' ? 'Reload' : 'Retry';
    // A durable action retries its own entry; one refused by the journal has no entry yet.
    const run = err.kind === 'conflict'
      ? () => void this.reloadTargets(command.targets(this.state, input))
      : () => {
        // signed out, nothing can run: the change is kept and its notice comes back, to be retried after sign-in
        if (keepUntilSignedIn(this, text, 'warn', { label, run })) return;   // it stays until used or dismissed
        if (this.state.ops[opId]) {
          void this.retryOp(opId);
          return;
        }
        if (this.rerun.has(opId)) return;
        // Run again, the action is planned afresh from the records as they are now, so a change from another PC that landed
        // since would be written over without a word. It is refused instead, as the interrupted-actions bar refuses it.
        // Nothing is settled: the journal keeps the action, and the next start offers it with Discard. If the journal
        // refused it (no entry), there is nothing to keep it in, and the person is told to make the change again.
        if (this.movedSince(baseRevs)) {
          this.toast(`${CHANGED_SINCE}; make the change again`, 'warn');
          return;
        }
        this.rerun.add(opId);
        void this.dispatch(command, input, { idempotencyKey: opts.idempotencyKey })
          .finally(() => this.rerun.delete(opId));
      };
    const text = err.kind === 'conflict' ? 'Changed elsewhere — not saved ·' : `Couldn’t save ·`;
    this.toast(text, 'warn', { label, run });
  }

  private appendAudit(entries: AuditEntry[]) {
    if (!entries.length) return;
    const audit = { ...this.state.audit }; let changed = false;
    for (const e of entries) if (audit[e.recordId]) { audit[e.recordId] = [...audit[e.recordId], e]; changed = true; }
    if (changed) this.set({ ...this.state, audit });
  }
  /** History for one record, loaded on demand and kept current by appendAudit. */
  async loadAudit(recordId: string) {
    if (this.state.audit[recordId]) return;
    const r = await this.services.repo.audit(recordId);
    if (r.ok) this.set({ ...this.state, audit: { ...this.state.audit, [recordId]: r.value } });
  }

  /** Undo the operation named, as its own operation. */
  undo(opId: string) { return this.dispatch(Undo, { opId }); }
  commandNamed(name: string) { return this.commands.get(name); }

  /** Hydrate from Home without dropping the durable action before Retry. */
  async retryOp(opId: string) {
    const operation = this.state.ops[opId];
    if (!operation || this.rerun.has(opId) || !['interrupted', 'failed'].includes(operation.state)) return;
    const command = this.commands.get(operation.command);
    if (!command) return;
    const readOnly = this.readOnly();
    if (readOnly) {
      this.toast(readOnly, 'warn');
      return fail({ kind: 'rejected', message: readOnly });
    }
    this.rerun.add(opId);
    try {
      if (operation.dealId) {
        await this.loadDeal(operation.dealId, { gaps: false });
        if (this.state.dealLoad[operation.dealId] !== 'loaded') {
          const message = 'The deal could not be loaded. Retry when it is available.';
          this.toast(message, 'warn');
          return fail({ kind: 'unreachable', message });
        }
      }
      const result = await this.dispatchAction(command, operation.input as any, {
        opId, idempotencyKey: operation.idempotencyKey,
      });
      // A retry that leaves the journal pending must still have its Retry and Discard notices (#565).
      const current = this.state.ops[opId];
      if (operation.state === 'interrupted' && current?.state === 'failed' && this.unwritten.has(opId)) {
        const interrupted = { ...current, state: 'interrupted' as const };
        this.set({ ...this.state, ops: { ...this.state.ops, [opId]: interrupted } });
      }
      return result;
    } finally {
      this.rerun.delete(opId);
    }
  }

  /** A retained no-op import still needs a durable success before its log step can fail. */
  private async finishUnchanged<I, In>(
    command: Command<I, In>, input: I, plan: Plan, opId: string, opts: ExecuteOptions,
    at: string, previousRev: number | null,
  ): Promise<Result<{ opId: string; unchanged: true }>> {
    if (command.name === 'ImportQuestions' && opts.idempotencyKey?.startsWith('qa-import:')) {
      const operation: Operation = {
        id: opId, command: command.name, input, targets: [], results: {},
        dealId: (input as { dealId?: string }).dealId, state: 'succeeded',
        startedAt: at, settledAt: at, window: this.windowId, idempotencyKey: opts.idempotencyKey,
      };
      const saved = await this.services.repo.transaction({
        writes: [{ kind: 'op', id: opId, data: operation, expectedRev: previousRev }],
      });
      if (!saved.ok) {
        this.onFailure(saved.error, command, input, opId, opts, {});
        return saved;
      }
      this.unwritten.delete(opId);
      this.set({ ...this.state, ops: { ...this.state.ops, [opId]: operation } });
    }
    if (FIELD_SAVES.has(command.name)) await this.settleField(command.name, input);
    if (plan.effect) this.startEffect(plan.effect, opId);
    if (plan.message && !opts.quiet) this.toast(plan.message, 'done');
    return ok({ opId, unchanged: true });
  }

  /** Save one operation before its records; Retry updates that same entry with its actual revision. */
  private async journalPending<I, In>(
    command: Command<I, In>, input: I, opId: string, targets: string[], plan: Plan,
    opts: ExecuteOptions, startedAt: string, previousRev: number | null,
  ): Promise<Result<{ operation: Operation; baseRevs: Record<string, number>; pendingRev: number }>> {
    const opTargets = [...new Set([
      ...targets, ...plan.upserts.map((upsert) => upsert.record.id), ...(plan.removes ?? []).map((remove) => remove.id),
    ])];
    const baseRevs: Record<string, number> = {};
    for (const id of opTargets) {
      const revision = this.revOf(id);
      if (revision !== undefined) baseRevs[id] = revision;
    }
    const operation: Operation = {
      id: opId, command: command.name, input, targets: opTargets, baseRevs, dealId: plan.dealId,
      state: 'pending', window: this.windowId, startedAt, idempotencyKey: opts.idempotencyKey,
    };
    const result = await this.services.repo.transaction({
      writes: [{ kind: 'op', id: opId, data: operation, expectedRev: previousRev }],
    });
    if (!result.ok) {
      this.onFailure(result.error, command, input, opId, opts, baseRevs);
      return result;
    }
    this.unwritten.delete(opId);
    this.set({ ...this.state, ops: { ...this.state.ops, [opId]: operation } });
    return ok({ operation, baseRevs, pendingRev: result.value[opId] });
  }

  /** Reuse the saved journal entry, checking its original bases after the target queue drains. */
  private async executeRetained<I, In>(
    command: Command<I, In>, input: I, opId: string, targets: string[], opts: ExecuteOptions,
  ): Promise<Result<{ opId: string; unchanged?: boolean }>> {
    let revision: number | null = null;
    if (opts.opId) {
      const loaded = await this.readJournalOperation(opId);
      if (!loaded.ok) {
        this.toast(loaded.error.message, 'warn');
        return loaded;
      }
      const operation = loaded.value?.operation;
      if (!operation || operation.command !== command.name) {
        return fail({ kind: 'rejected', message: 'This action has already finished' });
      }
      if (operation.state === 'succeeded' || operation.state === 'discarded') {
        this.unwritten.delete(opId);
        this.set({ ...this.state, ops: { ...this.state.ops, [opId]: operation } });
        return operation.state === 'succeeded' ? ok({ opId })
          : fail({ kind: 'rejected', message: 'This action has already finished' });
      }
      const recorded = command.input.safeParse(operation.input);
      if (!recorded.success || JSON.stringify(recorded.data) !== JSON.stringify(input)) {
        return fail({ kind: 'rejected', message: 'The saved action has different input' });
      }
      if (operation.state === 'pending' && operation.window !== this.windowId && this.isLive(operation)) {
        return fail({ kind: 'rejected', message: 'This action is still running in another window' });
      }
      const bases = operation.baseRevs ?? {};
      if (!(await this.reloadTargets(Object.keys(bases)))) {
        const message = 'The saved records could not be loaded. Nothing was written.';
        this.toast(message, 'warn');
        return fail({ kind: 'unreachable', message });
      }
      if (Object.entries(bases).some(([id, rev]) => this.revOf(id) !== rev)) {
        this.toast(`${CHANGED_SINCE}; Discard it, then make the change again`, 'warn');
        return fail({ kind: 'rejected', message: 'Changed since' });
      }
      revision = loaded.value!.revision;
    }
    if (command.prepare) await command.prepare(this, input, { retained: revision !== null });
    const result = await this.execute(command, input, opId, targets, opts, revision);
    if (result.ok && result.value.unchanged && revision !== null && this.state.ops[opId]?.state !== 'succeeded') {
      await this.dropOp(opId);
    }
    return result;
  }
  /** the rev of any record this window holds, by id */
  private revOf(id: string): number | undefined { const s = this.state; return (s.deals[id] ?? s.questions[id] ?? s.findings[id] ?? s.items[id] ?? s.firmList[id] ?? s.members[id])?.rev; }
  private async readJournalOperation(opId: string): Promise<Result<{ operation: Operation; revision: number } | null>> {
    const read = await this.services.repo.get('op', opId);
    if (!read.ok) return read;
    if (!read.value) return ok(null);
    const operation = this.parse('op', read.value) as Operation | null;
    return operation ? ok({ operation, revision: read.value.rev })
      : fail({ kind: 'rejected', message: 'The saved action could not be read' });
  }

  /** A displayed interruption can have settled in another window before Discard (#565). */
  private async discardRetained(opId: string): Promise<Result<void> | undefined> {
    const read = await this.readJournalOperation(opId);
    if (!read.ok) return read;
    const recorded = read.value?.operation;
    if (!recorded || recorded.state === 'succeeded' || recorded.state === 'discarded') {
      const ops = { ...this.state.ops };
      if (recorded) ops[opId] = recorded;
      else delete ops[opId];
      this.set({ ...this.state, ops });
      this.unwritten.delete(opId);
      this.pulse();
      return;
    }
    if (recorded.state === 'pending' && recorded.window !== this.windowId && this.isLive(recorded)) {
      return fail({ kind: 'rejected', message: 'This action is still running in another window' });
    }
    return this.dropOp(opId, read.value!.revision);
  }

  async discardOp(opId: string) {
    if (this.rerun.has(opId)) return;
    this.rerun.add(opId);
    try {
      const discarded = await this.discardRetained(opId);
      if (discarded && !discarded.ok) this.toast(`Couldn’t discard · ${discarded.error.message}`, 'warn');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.toast(`Couldn’t discard · ${message}`, 'warn');
    } finally {
      this.rerun.delete(opId);
    }
  }
  interruptedOps(): Operation[] { return Object.values(this.state.ops).filter((o) => o.state === 'interrupted' || o.state === 'failed').sort((a, b) => a.startedAt.localeCompare(b.startedAt)); }

  // ---- loading ------------------------------------------------------------
  /** records skipped because what is stored could not be read; reported once per load so they do not vanish silently */
  private unreadable = 0;
  /** records last written by a newer build of the app: shown here, not changed (see CURRENT_SCHEMA) */
  private newer = new Set<string>();
  private reportUnreadable() {
    if (!this.unreadable) return;
    const n = this.unreadable;
    this.unreadable = 0;
    const [record, verb] = n === 1 ? ['', 'is'] : ['s', 'are'];
    this.toast(`${n} stored record${record} could not be read and ${verb} not shown`, 'warn', undefined, true);
  }
  private parse(kind: RecordKind, env: { rev: number; envelope: { data: unknown } }): any | null {
    const schema = schemaOfKind(kind);
    if (!schema) return null;
    const data = env?.envelope?.data;
    if (!data || typeof data !== 'object') { console.warn('quarantined', kind, 'no data'); this.unreadable++; return null; }
    const r = schema.safeParse({ ...(env.envelope.data as object), ...('rev' in (env.envelope.data as any) ? { rev: env.rev } : {}) });
    if (!r.success) { console.warn('quarantined', kind, r.error.issues[0]); this.unreadable++; return null; }
    return r.data;
  }

  /** The unchosen versions of a record, each read through the record's own schema. A version that cannot be read is kept, marked. */
  private conflictOf(kind: RecordKind, id: string, rev: number, versions: Version[] | undefined): Conflict | null {
    if (!versions || versions.length < 2 || !(CLASH_KINDS as readonly string[]).includes(kind)) return null;
    const schema = schemaOfKind(kind)!;
    const read = versions.map((v) => {
      const d = v.data ?? (v.deleted ? v.held : undefined);
      const r = d && typeof d === 'object' ? schema.safeParse({ ...(d as object), rev }) : null;
      const data = r?.success ? (r.data as Deal | Question | Finding | Item | ListRecord) : null;
      const marks = { ...(v.here ? { here: true } : {}), ...(v.deleted ? { deleted: true } : {}) };
      const drafts = v.drafts ? { drafts: v.drafts } : {};
      return { id: v.id, by: v.by, from: v.from, at: v.at, ...marks, data, raw: v.data, ...drafts };
    });
    const first = read.find((v) => v.data)?.data as { dealId?: string } | undefined;
    return { kind: kind as Conflict['kind'], id, dealId: kind === 'deal' ? id : first?.dealId ?? '', versions: read };
  }
  /**
   * Put one loaded record into the buckets, with its unchosen versions if it has any. While a record is in a clash it
   * shows as its first readable version and cannot be edited. Only that record's entry is touched.
   */
  private take(kind: RecordKind, l: Loaded, s: Pick<State, 'deals' | 'questions' | 'findings' | 'tombstones' | 'items' | 'firmList' | 'members' | 'conflicts'>): void {
    const bucket = bucketOf(s, kind);
    if (!bucket) return;
    const c = this.conflictOf(kind, l.id, l.rev, l.conflict);
    const shown = c?.versions.find((v) => v.data)?.data ?? null;
    if (c && !shown) this.unreadable++;
    const rec = c ? shown : this.parse(kind, l);
    if (rec) bucket[(rec as { id: string }).id] = kind === 'question' ? this.shownQuestion(rec as Question) : kind === 'tombstone' ? noteWithCopies(rec as Tombstone, l.conflict) : rec;
    if (!(CLASH_KINDS as readonly string[]).includes(kind)) { if (l.conflict) this.versionsRead.set(`${kind}/${l.id}`, l.conflict.map((v) => v.id)); else this.versionsRead.delete(`${kind}/${l.id}`); }
    if (kind === 'tombstone') return;                                          // a tombstone has its record's id: it says nothing about that record's versions
    if ((l.envelope?.schema ?? 1) > CURRENT_SCHEMA) this.newer.add(l.id); else this.newer.delete(l.id);
    if (c && rec) s.conflicts[l.id] = c; else delete s.conflicts[l.id];
  }

  /** Start the app. Anything that goes wrong is shown on the start screen with Retry; nothing is left loading for ever. */
  async boot(o: { retry?: boolean } = {}): Promise<void> {
    try { await this.bootSteps(o); }
    catch (e) { this.bootFailed({ kind: 'failed', message: e instanceof Error && e.message ? e.message : 'Something went wrong while starting' }); }
  }
  /** Try starting again after a failure, from the step that failed. A closed sign-in window opens again only here. */
  async retryBoot(): Promise<void> { this.set({ ...this.state, boot: { stage: this.state.boot.stage } }); await this.boot({ retry: true }); }
  private async bootSteps(o: { retry?: boolean }): Promise<void> {
    const s0 = this.state;
    if (s0.boot.stage === 'session' || !s0.user) {
      const sess = await this.services.session.load(o.retry ? { retry: true } : undefined);
      // a probe and Retry can wait on the same sign-in: the first answer carries start-up on, and a later one leaves it to that (#189)
      if (this.state.boot.stage !== 'session' && this.state.user) return;
      if (!sess.ok) return this.bootFailed(sess.error);
      const prefs = this.readPrefs();
      this.services.local.watch?.((key) => this.localChanged(key));
      const model = prefs.model && sess.value.models.some((m) => m.id === prefs.model) ? prefs.model : sess.value.defaultModel;
      this.set({ ...this.state, user: sess.value.user, models: sess.value.models, model, prefs, ui: { ...this.state.ui, notThese: this.readNotThese() }, boot: { stage: 'deals' } });
      // the person's conversations, shown when they arrive, and again whenever another window or PC adds to them
      void this.loadConversations(true); this.conversations.watch?.(() => void this.loadConversations());
    }
    if (this.state.boot.stage === 'deals') {
      const [ds, fl, ms] = await Promise.all([this.services.repo.list('deal', '_'), this.services.repo.list('firmList'), this.services.repo.list('member', '_')]);
      if (!ds.ok) return this.bootFailed(ds.error);
      if (!ms.ok) return this.bootFailed(ms.error);
      if (!fl.ok) return this.bootFailed(fl.error);
      const into = { deals: {} as Record<string, Deal>, questions: this.state.questions, findings: this.state.findings, tombstones: this.state.tombstones, items: this.state.items, firmList: {} as Record<string, ListRecord>, members: {} as Record<string, Member>, conflicts: { ...this.state.conflicts } };
      for (const l of ds.value) this.take('deal', l, into);
      for (const l of fl.value) this.take('firmList', l, into);                // the firm's lists, which every deal is checked against
      for (const l of ms.value) this.take('member', l, into);                  // who has which deal in their list
      this.set({ ...this.state, deals: into.deals, firmList: into.firmList, members: into.members, conflicts: into.conflicts, boot: { stage: 'journal' } });
    }
    if (this.state.boot.stage === 'journal') {
      const ops = await this.services.repo.list('op');
      if (!ops.ok) return this.bootFailed(ops.error);
      const recovered: Record<string, Operation> = {};
      const fixes: Transaction['writes'] = [];
      const held: string[] = [];
      for (const l of ops.value) {
        const op = this.parse('op', l) as Operation | null; if (!op) continue;
        if (op.state === 'pending' && this.isLive(op)) { recovered[op.id] = op; held.push(op.id); }      // another window is still doing it
        else if (op.state === 'pending') { const i = { ...op, state: 'interrupted' as const, settledAt: this.services.clock.now() }; recovered[op.id] = i; fixes.push({ kind: 'op', id: op.id, data: i, expectedRev: l.rev }); }
        else recovered[op.id] = op;
      }
      if (fixes.length) await this.services.repo.transaction({ writes: fixes });
      this.set({ ...this.state, ops: recovered, boot: { stage: 'ready' } });
      // closed only by the person
      for (const { text, glyph } of this.keptNotices()) this.toast(text, glyph, undefined, 'kept');
      for (const id of held) this.recheck(id);
      this.resumeReplies(Object.values(recovered));
      this.reportUnreadable();
      void this.pruneJournal();
      this.touchCached();
      void this.refreshSync();
    }
    this.netUp();
  }

  // ---- other windows' work in flight -------------------------
  private inFlight = 0; private beat: ReturnType<typeof setInterval> | null = null;
  /** Run one operation, stamping `alive` for as long as any is in flight here, so a window that starts meanwhile leaves it alone. */
  private async live<T>(work: () => Promise<T>): Promise<T> {
    this.inFlight++; this.pulse();
    try { return await work(); } finally { this.inFlight--; this.pulse(); }
  }
  /**
   * Stamp `alive` while an operation is in flight here or a save waits here (its entry is pending in the shared journal): a
   * window that starts meanwhile leaves it to this one, and does not offer it for a Retry of its own.
   */
  private pulse() {
    const on = this.inFlight > 0 || this.unwritten.size > 0 || this.unsettledHere.size > 0 || this.waitingReplies.size > 0;
    if (on && !this.beat) { this.stamp(); this.beat = setInterval(() => this.stamp(), ALIVE_MS); (this.beat as any).unref?.(); }
    if (!on && this.beat) { clearInterval(this.beat); this.beat = null; }
  }
  private alive(): Record<string, unknown> { const v = this.services.local.read('alive'); return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; }
  private stamp() {
    const now = this.services.clock.now(), t = Date.parse(now);
    const others = Object.entries(this.alive()).filter(([, at]) => typeof at === 'string' && t - Date.parse(at) < STALE_MS);   // windows long gone drop out
    this.services.local.write('alive', { ...Object.fromEntries(others), [this.windowId]: now });
  }
  /** The window is closing (reload, close): it stops counting as alive at once, so a window opened next does not wait on its work. */
  closing() { const rest = { ...this.alive() }; delete rest[this.windowId]; this.services.local.write('alive', rest); }
  /** whether the window that started this operation was heard from lately; an entry from before windows were recorded never was */
  private isLive(op: Operation): boolean {
    const at = op.window ? this.alive()[op.window] : undefined;
    return typeof at === 'string' && Date.parse(this.services.clock.now()) - Date.parse(at) < STALE_MS;
  }
  /** Another window's operation that was in flight when this one started: looked at again until it settles, or is interrupted once that window is gone. */
  private recheck(opId: string, delay = STALE_MS) {
    setTimeout(async () => {
      const watched = this.state.ops[opId];
      const r = await this.services.repo.get('op', opId);
      if (!r.ok) return this.recheck(opId);
      const op = r.value ? (this.parse('op', r.value) as Operation | null) : null;
      if (op?.state === 'pending' && this.isLive(op)) return this.recheck(opId);
      let next = op;
      if (op?.state === 'pending') {
        next = { ...op, state: 'interrupted', settledAt: this.services.clock.now() };
        const w = await this.services.repo.transaction({ writes: [{ kind: 'op', id: opId, data: next, expectedRev: r.value!.rev }] });
        if (!w.ok) return this.recheck(opId);                                    // it settled just now: read it again
      }
      const ops = { ...this.state.ops }; if (next) ops[opId] = next; else delete ops[opId];
      this.set({ ...this.state, ops });
      if (next && op?.state === 'pending') this.resumeReplies([next]);        // a reply that window was still waiting to write is written here
      else if ((!next || next.state === 'discarded') && watched && keepsWork(watched.command, watched.input)) await this.followReply(watched);   // replaced by a later try
    }, delay);
  }

  private bootFailed(err: Failure) {
    if (err.kind === 'unreachable') { this.netDown(); return; }
    this.set({ ...this.state, boot: { ...this.state.boot, error: err.message } });
    // The deals could not all be read (one of their files will not open just now): start-up is refused rather than showing
    // part of the list, and tried again by itself at the offline check's pace, so it starts as soon as the file opens. The
    // message stays on screen while it tries (unlike Retry, which shows the start screen), so the screen does not flicker.
    const waits = this.state.boot.stage === 'deals' || this.state.boot.stage === 'journal';          // or the undo journal will not open just now
    if (waits && err.kind === 'failed' && !this.bootRetry) {
      this.bootRetry = setTimeout(() => { this.bootRetry = null; const st = this.state.boot.stage; if ((st === 'deals' || st === 'journal') && this.state.boot.error) void this.boot(); }, BOOT_RETRY_MS);
      (this.bootRetry as { unref?: () => void }).unref?.();
    }
  }
  /** the next try at starting, after the deals could not all be read */
  private bootRetry: ReturnType<typeof setTimeout> | null = null;

  private dealLoads = new Map<string, Promise<void>>();
  private gapsAsked = new Set<string>();             // deals whose gaps and unread responses this session has asked for, so callers that come together ask once
  /** Load the deal and, where available, the checklist rows that can settle its questions. */
  async loadDealWithChecklist(dealId: string): Promise<void> {
    await Promise.all([this.loadDeal(dealId), this.refreshChecklist(dealId)]);
  }

  /**
   * Load a deal's records once. Concurrent callers share the same load. The gaps are fetched once a session, and only
   * for callers that show them (the deal pages), not for search across deals; asked once even when callers come together.
   */
  async loadDeal(dealId: string, opts: { gaps?: boolean } = {}): Promise<void> {
    if (this.state.dealLoad[dealId] !== 'loaded') {
      let p = this.dealLoads.get(dealId);
      if (!p) { p = this.loadDealRecords(dealId).finally(() => this.dealLoads.delete(dealId)); this.dealLoads.set(dealId, p); }
      await p;
    }
    if (opts.gaps !== false && this.state.dealLoad[dealId] === 'loaded' && !this.gapsAsked.has(dealId)) {
      this.gapsAsked.add(dealId);
      void this.refreshGaps(dealId);
      void this.services.ai.responses?.(dealId).catch(() => undefined);      // responses the backend could not look at when they were saved (it was unreachable) are looked at now; with none, this costs nothing
    }
  }
  private async loadDealRecords(dealId: string): Promise<void> {
    this.set({ ...this.state, dealLoad: { ...this.state.dealLoad, [dealId]: 'loading' } });
    const [qs, fs, ts, is] = await Promise.all([this.services.repo.list('question', dealId), this.services.repo.list('finding', dealId), this.services.repo.list('tombstone', dealId), this.services.repo.list('item', dealId)]);
    if (!qs.ok || !fs.ok || !ts.ok || !is.ok) {
      const e = (!qs.ok && qs.error) || (!fs.ok && fs.error) || (!ts.ok && ts.error) || (!is.ok && is.error) as Failure;
      this.set({ ...this.state, dealLoad: { ...this.state.dealLoad, [dealId]: 'failed' } });
      if (e.kind === 'unreachable') this.netDown();
      return;
    }
    const into = { deals: this.state.deals, questions: { ...this.state.questions }, findings: { ...this.state.findings }, tombstones: { ...this.state.tombstones }, items: { ...this.state.items }, firmList: this.state.firmList, members: this.state.members, conflicts: { ...this.state.conflicts } };
    for (const l of qs.value) this.take('question', l, into);
    for (const l of fs.value) this.take('finding', l, into);
    for (const l of ts.value) this.take('tombstone', l, into);
    for (const l of is.value) this.take('item', l, into);
    this.set({ ...this.state, questions: into.questions, findings: into.findings, tombstones: into.tombstones, items: into.items, conflicts: into.conflicts, dealLoad: { ...this.state.dealLoad, [dealId]: 'loaded' } });
    this.reportUnreadable();
    await this.recoverDrafts(dealId);
  }
  /**
   * The pending drafts on a deal that may still be running somewhere, so must not be marked failed: this
   * window's, another window's of this PC while that window is alive, and another PC's (not in this PC's journal) until
   * this PC has seen it for DRAFT_GIVE_UP_MS. Only drafts this PC started in a window now gone, or long-abandoned ones,
   * are given up.
   */
  private async recoverDrafts(dealId: string) {
    const recover = this.commands.get('RecoverDrafts'); if (!recover) return;
    const held = await this.adoptReplies(dealId);
    const live = this.draftsNotEnded(dealId);
    await this.dispatch(recover, { dealId, liveRequestIds: [...live.ids, ...held] }, { quiet: true, system: true });
    // another window of this PC was still at a draft: looked at again once it could have gone quiet, in case it closed mid-way
    if (live.otherWindow || held.length) setTimeout(() => { if (this.state.deals[dealId]) void this.recoverDrafts(dealId); }, STALE_MS);
    this.giveUpLater(dealId, live.otherPcDue);
  }
  /** One look per deal, when the first draft from another PC that is still pending here is due to be given up (#24). */
  private giveUpTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private giveUpLater(dealId: string, due: number | undefined) {
    // a look already set is due no later than this one: each look sets the next
    if (due === undefined || this.giveUpTimers.has(dealId)) return;
    const timer = setTimeout(() => {
      this.giveUpTimers.delete(dealId);
      if (this.state.deals[dealId]) void this.recoverDrafts(dealId);
    }, due);
    (timer as any).unref?.();
    this.giveUpTimers.set(dealId, timer);
  }
  /** the drafts not to give up yet, and how soon the first of another PC's could be (`otherPcDue`, in ms) */
  private draftsNotEnded(dealId: string): { ids: string[]; otherWindow: boolean; otherPcDue?: number } {
    let otherWindow = false;
    const pending = Object.values(this.state.questions).flatMap((q) =>
      q.dealId === dealId && q.draft?.status === 'pending' && q.draft.opId ? [q.draft.opId] : []);
    const otherPc = pending.filter((id) => !this.liveRequests.has(id) && !this.state.ops[id]);
    const now = Date.parse(this.services.clock.now());
    // a deal not loaded here holds no questions to judge: its stored times are left as they are
    const loaded = this.state.dealLoad[dealId] === 'loaded';
    const seen = loaded
      ? seenSince(this.services.local, dealId, otherPc, now)
      : new Map(otherPc.map((id) => [id, now]));
    const seenFor = (id: string) => Math.max(0, now - seen.get(id)!);     // a clock put back counts as no time
    const waits = otherPc.map((id) => DRAFT_GIVE_UP_MS - seenFor(id)).filter((ms) => ms > 0);
    const ids = pending.filter((id) => {
      if (this.liveRequests.has(id)) return true;
      const op = this.state.ops[id];
      if (op) { const alive = op.window !== this.windowId && this.isLive(op); otherWindow ||= alive; return alive; }
      return seenFor(id) < DRAFT_GIVE_UP_MS;
    });
    return { ids, otherWindow, ...(waits.length ? { otherPcDue: Math.min(...waits) } : {}) };
  }
  private gapsSeq = new Map<string, number>();
  /** The deal's document gaps, and with them when it was last checked and how far it has been read. Read-only; a newer
   * request supersedes an older one. No summary is asked for: Overview has none. */
  async refreshGaps(dealId: string) {
    const n = (this.gapsSeq.get(dealId) ?? 0) + 1; this.gapsSeq.set(dealId, n);
    const g = await this.services.ai.gaps(dealId);
    if (this.gapsSeq.get(dealId) !== n) return;
    if (!g.ok && g.error.kind === 'unreachable') this.netDown();
    if (g.ok) this.set({ ...this.state, gaps: { ...this.state.gaps, [dealId]: g.value } });
    void this.refreshChecked(dealId); void this.refreshProgress(dealId);
    if (this.state.checklists[dealId] !== undefined) void this.refreshChecklist(dealId);      // only once the Checklist page has asked for it
  }
  /** Every checklist item of the deal and how it stands. Read-only; a backend that does not say leaves the page to say so. */
  async refreshChecklist(dealId: string) {
    const c = await this.services.ai.checklist?.(dealId); if (!c) return;
    this.set({ ...this.state, checklists: { ...this.state.checklists, [dealId]: c.ok ? c.value : 'failed' } });
  }
  /** How far the review of the deal has got: documents read, core documents read. Read-only; nothing is shown for a backend that does not say. */
  async refreshProgress(dealId: string) {
    const p = await this.services.ai.progress?.(dealId); if (!p?.ok) return;
    this.set({ ...this.state, progress: { ...this.state.progress, [dealId]: p.value } });
  }
  /** When everything on the deal was last checked. Read-only; a check that is running keeps its place. */
  async refreshChecked(dealId: string) {
    const c = await this.services.ai.checked?.(dealId); if (!c?.ok) return;
    const { ended, checking, ...state } = c.value; const was = this.state.checks[dealId];
    this.set({ ...this.state, checks: { ...this.state.checks, [dealId]: { ...(was ?? {}), ...state, checking, ...(was?.busy ? { busy: was.busy } : {}) } } });
    // a check asked for on this PC that ended while it was out of sync with the shared folder: told now, as it would have been then
    // asked for while out of sync and taken up by no round: started now, as the person asked
    if (ended?.restart) { void this.checkEverything(dealId, ended.restart === 'deep', ended.restart === 'rest'); return; }
    if (ended) this.checkEnded(dealId, ended.summary ? { ok: true, value: ended.summary } : { ok: false, error: { kind: 'failed', message: ended.failed ?? '' } }, this.state.checks[dealId] ?? { at: null, offerDeep: null });
  }
  /**
   * A person asks for everything on the deal to be checked again. It changes nothing a person set: findings that may no
   * longer stand come back marked, and new findings arrive as they do from the first pass. One check a deal at a time.
   */
  async checkEverything(dealId: string, deep = false, onlyLeft = false) {
    const ai = this.services.ai; if (!ai.checkAll || this.state.checks[dealId]?.busy) return;
    const was = this.state.checks[dealId] ?? { at: null, offerDeep: null };
    this.set({ ...this.state, checks: { ...this.state.checks, [dealId]: { ...was, busy: deep ? 'deep' : 'quick' } } });
    // the deal's folders are listed first, and anything added, changed or removed since they were read is indexed before the check
    // it waits at most timings.checkFolderWait: a large upload goes on being read, and is checked by the first pass that follows its reading
    let waited: ReturnType<typeof setTimeout> | undefined;
    const by = Date.now() + FOLDER_CHECK.checkWait;          // a run that ends in time leaves its new documents to this check, which reads everything, rather than to a first pass too
    await Promise.race([freshen(this, dealId, { forCheckBy: by }), new Promise<void>((r) => { waited = setTimeout(r, FOLDER_CHECK.checkWait); })]); clearTimeout(waited);
    // `onlyLeft`: only what the latest check left out; offered only while the documents are the ones it checked
    const r = await ai.checkAll({ dealId, deep, ...(onlyLeft ? { only: 'left' as const } : {}) });
    this.checkEnded(dealId, r, was);
  }
  /** what a check of everything came to: the date it moves (or not), what it could not reach, and the message */
  private checkEnded(dealId: string, r: Result<CheckSummary>, was: State['checks'][string]) {
    const now = this.state.checks[dealId] ?? was;
    // a check that could not check everything does not move the date: the last complete check's stands
    // what the check could not reach, or that it did not finish, stays on the page until a later check clears it: a notice that fades is not a record
    const ran = this.services.clock.now(); const u = r.ok ? r.value.unchecked : undefined; const left = u && (u.items || u.findings) ? { items: u.items ?? 0, findings: u.findings ?? 0, at: ran, changed: false } : null;
    this.set({ ...this.state, checks: { ...this.state.checks, [dealId]: r.ok ? { at: r.value.at ?? now.at, offerDeep: r.value.offerDeep ? r.value.sample : null, left, failedAt: null } : { at: now.at, offerDeep: now.offerDeep, left: now.left ?? null, failedAt: r.error.kind === 'failed' || r.error.kind === 'unreachable' ? ran : now.failedAt ?? null } } });   // cut off by a dropped connection: the line says it did not finish
    if (!r.ok) {
      if (r.error.kind === 'unreachable') this.netDown();
      else this.toast(r.error.kind === 'rejected' ? r.error.message : CHECK_UNFINISHED, 'warn');
      return;
    }
    const v = r.value; const bits = [v.toReassess ? `${v.toReassess} to update` : 'nothing to update', ...(v.newFindings ? [`${v.newFindings} new ${v.newFindings === 1 ? 'finding' : 'findings'}`] : [])];
    const out = [v.unchecked?.items ? `${v.unchecked.items} checklist ${v.unchecked.items === 1 ? 'item' : 'items'}` : '', v.unchecked?.findings ? `${v.unchecked.findings} ${v.unchecked.findings === 1 ? 'finding' : 'findings'}` : ''].filter(Boolean);
    // Not complete because a folder in the data room could not be opened, and no PC has read it. One line, as every
    // notice is (design.md): the folder's own name, or how many; the whole, with what the check came to, on hover.
    const f = v.unread ?? [];
    if (f.length) {
      const shown = f.slice(0, 5); const named = f.length > 5 ? `${shown.join(', ')} and ${f.length - 5} more` : f.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : f[0];
      const after = out.length ? `${out.join(' and ')} could not be checked: ${bits.join(', ')}` : bits.join(', ');
      // a name too wide for the line is the part shortened, so the line still says what happened to it, whatever its letters
      const own = f[0].split('/').pop()!;
      const folders = f.length > 1 ? `${f.length} folders` : own;
      const these = `the folder${f.length > 1 ? 's' : ''} ${named}`;
      const whole = `Not complete: ${these} could not be opened. ${after[0].toUpperCase()}${after.slice(1)}`;
      this.toast(`Not complete · ${folders} could not be opened`, 'warn', undefined, false, whole,
        f.length > 1 ? undefined : own);
    } else {
      const bitsText = bits.join(', ');
      const text = out.length
        ? `Checked, except ${out.join(' and ')} that could not be checked: ${bitsText}`
        : `Checklist and findings checked: ${bitsText}`;
      this.toast(text, out.length ? 'warn' : 'done');
    }
    void this.refreshGaps(dealId);
  }
  /** request operation ids whose effect is still running in this session */
  readonly liveRequests = new Set<string>();
  private effects = new Map<string, Promise<void>>();
  /** resolves when the operation's effect (and its follow-up) has settled; immediately if there is none */
  settled(opId: string): Promise<void> { return this.effects.get(opId) ?? Promise.resolve(); }
  retryDeal(dealId: string) { this.set({ ...this.state, dealLoad: { ...this.state.dealLoad, [dealId]: undefined as any } }); return this.loadDeal(dealId); }

  /** Read one record again; false when it could not be read. */
  private async reloadRecord(kind: RecordKind, id: string, peer = false): Promise<boolean> {
    const r = await this.services.repo.get(kind, id);
    if (!r.ok) return false;
    const s = { ...this.state, deals: { ...this.state.deals }, questions: { ...this.state.questions }, findings: { ...this.state.findings }, tombstones: { ...this.state.tombstones }, items: { ...this.state.items }, firmList: { ...this.state.firmList }, members: { ...this.state.members }, conflicts: { ...this.state.conflicts } };
    const bucket = bucketOf(s, kind);
    if (!bucket) return true;
    if (!r.value) { delete bucket[id]; this.versionsRead.delete(`${kind}/${id}`); if (kind !== 'tombstone') delete s.conflicts[id]; }
    else this.take(kind, r.value, s);
    this.set(s, peer && this.findingListRender(kind));
    if (kind === 'finding') this.touchCached();                  // the backend's agents just read documents to write this
    if (kind === 'finding') { const f = (r.value && bucket[id]) as Finding | undefined; const dealId: string | undefined = f?.dealId ?? (this.state.ui.route as any).dealId; if (dealId && this.state.dealLoad[dealId] === 'loaded') void this.refreshGaps(dealId); }
    return true;
  }
  /** Only the read-only Findings list may skip intermediate peer renders (#359); editors see every revision. */
  private findingListRender(kind: RecordKind): boolean {
    return kind === 'finding' && this.state.ui.route.name === 'deal';
  }
  /** Read these records again; false when any could not be read. */
  private async reloadTargets(ids: string[]): Promise<boolean> {
    let all = true;
    for (const id of ids) {
      const kind: RecordKind = id.startsWith('q_') ? 'question' : id.startsWith('f_') ? 'finding' : id.startsWith('i_') ? 'item' : id.startsWith('m_') ? 'member' : /^l_[0-9a-f]{24}$/.test(id) ? 'firmList' : 'deal';
      if (!(await this.reloadRecord(kind, id))) all = false;
      // its deletion note, which shares its id: only where one is listed or the record has gone, so a long list of targets is not read twice
      if ((kind === 'question' || kind === 'finding' || kind === 'deal') && (this.state.tombstones[id] || !bucketOf(this.state, kind)?.[id]) && !(await this.reloadRecord('tombstone', id))) all = false;
    }
    return all;
  }

  // ---- per-person data: conversations and preferences (never part of a record transaction) ----
  /** where the person's conversations are kept: the ConversationStore given, or else this window's local store */
  private readonly conversations: ConversationStore;
  /** The stored preferences, validated; anything missing or damaged takes its default. */
  private readPrefs(): Prefs {
    const p = z.object({ theme: z.enum(['system', 'light', 'dark']), model: z.string().nullable(), hideCols: z.object({ priority: z.boolean().default(DEFAULT_PREFS.hideCols.priority), askedBy: z.boolean().default(DEFAULT_PREFS.hideCols.askedBy), response: z.boolean().default(DEFAULT_PREFS.hideCols.response), status: z.boolean().default(DEFAULT_PREFS.hideCols.status), respondedBy: z.boolean().default(DEFAULT_PREFS.hideCols.respondedBy), responded: z.boolean().default(DEFAULT_PREFS.hideCols.responded) }).default(DEFAULT_PREFS.hideCols), qaOpen: z.record(z.string(), z.string()).default({}), qaSeen: z.record(z.string(), z.string()).default({}), landing: z.enum(['overview', 'findings', 'checklist', 'qa']).default(DEFAULT_PREFS.landing), railOpen: z.record(z.string(), z.boolean()).default(DEFAULT_PREFS.railOpen) }).safeParse(this.services.local.read('prefs'));
    return p.success ? p.data : DEFAULT_PREFS;
  }
  /** The suggestions put away on this PC ("Not this one"), validated; anything damaged reads as none. */
  private readNotThese(): string[] {
    const nt = z.array(z.string()).safeParse(this.services.local.read('notThese'));
    return nt.success ? nt.data : [];
  }
  /**
   * Conversations and preferences belong to the person, not to one window. A window changes one conversation, or one
   * preference, on top of what is stored, so a second window's conversations and choices are kept; each window follows
   * changes the others make.
   */
  setThread(key: string, messages: Message[]) {
    this.set({ ...this.state, threads: { ...this.state.threads, [key]: messages } });
    void this.keep(key, messages);
  }
  /**
   * Keep a conversation. A message the shared folder refused is in this PC's own copy, which shares it at its next look at
   * the folder: said once. One that could not be kept at all (the window's own storage, or this PC's copy, refused it) is
   * only in this window: said every time, plainly, with Retry, and it stays on screen to copy; it is also kept again with
   * the next change to that conversation.
   */
  private async keep(key: string, messages: Message[]) {
    const r = await this.conversations.save(key, messages);
    if (r.ok) { this.keepFailed = false; return; }
    const retry = { label: 'Retry', run: () => void this.keep(key, this.state.threads[key] ?? messages) };
    if (!this.services.conversations) {
      this.toast('Conversation not saved — browser storage is full.', 'warn', retry, true);
      return;
    }
    if (r.error.kind === 'failed') {
      const why = r.error.message === 'The disk is full' ? 'the disk is full' : 'this PC’s copy can’t be written';
      const text = `Conversation not saved — ${why}. Your message is still here to copy or retry.`;
      this.toast(text, 'warn', retry, true);
      return;
    }
    if (!this.keepFailed) {
      const where = r.error.kind === 'storageFull'
        ? 'Conversation not saved for your other PCs — the disk is full. It is kept on this PC.'
        : 'Conversation not saved for your other PCs — the Punchlist folder can’t be reached. '
          + 'It is kept on this PC and saved when the folder is back.';
      this.toast(where, 'warn', undefined, true);
    }
    this.keepFailed = true;
  }
  private keepFailed = false;
  /**
   * The person's conversations as kept, merged with what this window holds (see `merged`); what only this window holds
   * is kept now. `resume` is for start-up only: an answer left waiting by a session that ended is shown as failed, to be retried.
   */
  async loadConversations(resume = false) {
    const r = await this.conversations.load(); if (!r.ok) return;
    const threads: Record<string, Message[]> = {}; const unkept: string[] = [];
    for (const key of new Set([...Object.keys(this.state.threads), ...Object.keys(r.value)])) {
      const kept = (r.value[key] ?? []).map((m) => (resume && m.state === 'pending' ? { ...m, state: 'failed' as const } : m));
      const m = merged(kept, this.state.threads[key] ?? []); threads[key] = m.list;
      if (m.unkept) unkept.push(key);
    }
    this.set({ ...this.state, threads });
    for (const key of unkept) void this.keep(key, threads[key]);
  }
  setPrefs(patch: Partial<Prefs>) {
    const prefs = { ...this.readPrefs(), ...patch };
    this.set({ ...this.state, prefs, model: patch.model ?? prefs.model ?? this.state.model });
    this.services.local.write('prefs', prefs);
  }
  /**
   * "Not this one" on a suggested open question: remembered on this PC through the local store, as
   * `answer message id|question id`, so the card stays away after a reload. Like a preference, it is added on top of
   * what is stored now, so another window's are kept. It changes no record.
   */
  putAway(answerId: string, questionId: string) {
    const key = `${answerId}|${questionId}`; const kept = this.readNotThese().filter((x) => x !== key);
    this.keepNotThese([...kept, key].slice(-NOT_THESE_KEEP));
  }
  private keepNotThese(notThese: string[]) {
    this.set({ ...this.state, ui: { ...this.state.ui, notThese } });
    this.services.local.write('notThese', notThese);
  }
  /** Another window changed preferences or the suggestions put away. (Its conversations arrive through `conversations.watch`.) */
  private localChanged(key: string) {
    if (key === 'prefs') {
      const prefs = this.readPrefs();
      const model = prefs.model && this.state.models.some((m) => m.id === prefs.model) ? prefs.model : this.state.model;
      this.set({ ...this.state, prefs, model });
    } else if (key === 'notThese') this.set({ ...this.state, ui: { ...this.state.ui, notThese: this.readNotThese() } });
  }
  private cachedSeq = 0; private cachedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ask again which documents are loaded, shortly; calls made close together become one request. */
  touchCached() {
    if (this.cachedTimer) return;
    this.cachedTimer = setTimeout(() => { this.cachedTimer = null; void this.refreshCached(); }, 150);
  }
  /** Read-only view of the backend's store; a newer request supersedes an older one, and a failure keeps what was known. */
  async refreshCached() {
    const n = ++this.cachedSeq;
    const r = await this.services.docs.cached();
    if (n !== this.cachedSeq || !r.ok) return;
    const next: Record<string, true> = {}; for (const id of r.value) next[id] = true;
    const cur = this.state.cached; const same = Object.keys(cur).length === r.value.length && r.value.every((id) => cur[id]);
    if (!same) this.set({ ...this.state, cached: next });
  }
  private draftsAsked = new Set<string>();
  /** Read a document's drafts once; a failure is not kept, so the next showing asks again. */
  async loadDrafts(dealId: string, docId: string) {
    const key = `${dealId}|${docId}`; if (this.state.drafts[key] || this.draftsAsked.has(key)) return;
    this.draftsAsked.add(key); const r = await this.services.docs.drafts(dealId, docId); this.draftsAsked.delete(key);
    if (r.ok) this.set({ ...this.state, drafts: { ...this.state.drafts, [key]: r.value } });
  }
  private placesAsked = new Set<string>();
  /** Read where a document sits once; a failure is not kept, so the next showing asks again. */
  async loadPlaces(dealId: string, docId: string) {
    const key = `${dealId}|${docId}`; if (this.state.places[key] || this.placesAsked.has(key)) return;
    this.placesAsked.add(key); const r = await this.services.docs.places(dealId, docId); this.placesAsked.delete(key);
    if (r.ok) this.set({ ...this.state, places: { ...this.state.places, [key]: r.value } });
  }
  /** Forget a deal's drafts and places once its indexing finishes: a draft or a copy may have arrived, and each is read again when next shown. */
  forgetDrafts(dealId: string) {
    const mine = ([k]: [string, unknown]) => !k.startsWith(`${dealId}|`);
    const drafts = Object.fromEntries(Object.entries(this.state.drafts).filter(mine)); const places = Object.fromEntries(Object.entries(this.state.places).filter(mine));
    if (Object.keys(drafts).length !== Object.keys(this.state.drafts).length || Object.keys(places).length !== Object.keys(this.state.places).length) this.set({ ...this.state, drafts, places });
  }
  private syncSeq = 0;
  /** Ask the backend what the other PCs are doing. A backend that shares nothing has no answer, and nothing is shown. */
  async refreshSync() {
    const n = ++this.syncSeq;
    const r = await this.services.repo.sync?.();
    if (!r || n !== this.syncSeq || !r.ok) return;
    const note = r.value.self.note; const had = this.state.sync?.self.note;
    this.set({ ...this.state, sync: r.value });
    // said once, and it stays until the person dismisses it: nothing more can be saved here
    if (note && note !== had) this.toast(note, 'warn', undefined, true);
    if (r.value.unseen?.length) void keepUnseen(this, r.value.unseen);   // a deal deleted elsewhere with changes here it had not seen
  }
  /**
   * A deal deleted on another PC has been kept here as a copy (app/recovered.ts): the copy joins the list, a page left
   * open on the deleted deal moves to the same page of the copy, and the person's conversations about the deal, its findings
   * and its questions are carried over to the copy. `ids` gives each record's id in the copy by its old one.
   */
  async tookCopy(dealId: string, copyId: string, ids: Record<string, string>) {
    await this.reloadRecord('deal', copyId);
    const me = this.state.user?.name; if (me) await this.reloadRecord('member', memberId(copyId, me));
    for (const fn of this.renamers) fn(ids);
    const route = this.state.ui.route;
    if ('dealId' in route && route.dealId === dealId) {
      const sel = this.state.ui.selectedQuestion; this.ui({ selectedQuestion: sel ? ids[sel] ?? null : null });
      if (typeof location !== 'undefined') location.hash = movedHash(location.hash.slice(1), ids);
      void this.loadDeal(copyId);
    }
    const open = this.state.prefs.qaOpen[dealId]; if (open && ids[open]) this.setPrefs({ qaOpen: { ...this.state.prefs.qaOpen, [copyId]: ids[open] } });
    await this.loadConversations();
    for (const [key, messages] of Object.entries(this.state.threads)) {
      const scope = scopeOfKey(key); if (!scope || scope.kind === 'all' || scope.dealId !== dealId) continue;
      const moved = key.split(':').map((part) => ids[part] ?? part).join(':');
      if (moved !== key && !this.state.threads[moved]?.length) this.setThread(moved, messages);
    }
  }
  /** Progress of indexing that is under way. It is shown from here and saved to the deal only when indexing finishes. */
  setIndexing(dealId: string, value: { folders: Folder[]; log: string[] } | undefined) {
    const indexing = { ...this.state.indexing }; if (value === undefined) delete indexing[dealId]; else indexing[dealId] = value;
    this.set({ ...this.state, indexing });
  }
  setPage(key: string, value: PageState | undefined) {
    const pages = { ...this.state.pages }; if (value === undefined) delete pages[key]; else pages[key] = value;
    this.set({ ...this.state, pages });
  }

  // ---- connectivity -------------------------------------------------------
  /**
   * Every answer from a call that goes to the model service says whether it could be reached: the connection card shows the
   * latest. The read-only calls (what is recorded, how far a review has got) never reach it, so they say nothing. A slow
   * answer that comes back after a later one does not overwrite it.
   */
  private watchModel(ai: Services['ai']): Services['ai'] {
    let asked = 0, taken = 0;
    const seen = (n: number) => (r: unknown) => {
      if (n < taken || !r || typeof r !== 'object' || typeof (r as { ok?: unknown }).ok !== 'boolean') return;
      taken = n;
      const down = !(r as { ok: boolean }).ok && (r as { error?: Failure }).error?.kind === 'unreachable';
      if (!!this.state.net.model !== down) this.set({ ...this.state, net: { ...this.state.net, model: down } });
    };
    return new Proxy(ai, { get: (t, k) => { const f = Reflect.get(t, k); return typeof f !== 'function' || !MODEL_CALLS.has(k) ? f : (...a: unknown[]) => { const r = f.apply(t, a); if (r instanceof Promise) void r.then(seen(++asked), () => undefined); return r; }; } });
  }
  settingsSignIn() {
    const { signin } = this.services;
    return signin ? new SignInConnection(signin) : null;
  }
  settingsSharedFolder() {
    const { place } = this.services;
    return place ? new SharedFolderConnection(place) : null;
  }
  signInFromNotice() {
    const { signin } = this.state;
    if (signin?.sso && !signin.apiKey) void this.services.signin?.signIn();
    else this.ui({ settings: true });
  }
  /**
   * Intelligence sign-in, looked at every 2 seconds while the app is open (desktop): while nobody is signed in the app
   * is read-only (decisions: "Intelligence sign-in"). When someone signs in after the app opened signed out, the session
   * is loaded again, so the models on offer and the person's name from the service come in.
   */
  watchSignIn(every = 2000) {
    const signin = this.services.signin; if (!signin) return () => undefined;
    let busy = false, reloading = false;
    const look = async () => {
      if (busy) return; busy = true;
      try {
        const r = await signin.status(); if (!r.ok) return;
        const next = { out: !r.value.signedIn, sso: r.value.sso, apiKey: r.value.apiKey }; const was = this.state.signin;
        if (!was || was.out !== next.out || was.sso !== next.sso || was.apiKey !== next.apiKey) this.set({ ...this.state, signin: next });
        // the reload can wait a long time on the service: it runs beside the look, so a sign-out meanwhile still makes the app read-only
        if (!next.out && this.state.user && !this.state.models.length && !reloading) { reloading = true; void this.reloadSession().catch(() => undefined).finally(() => { reloading = false; }); }
      } catch { /* looked at again on the next round */ } finally { busy = false; }
    };
    void look(); const t = setInterval(() => void look(), every);
    return () => clearInterval(t);
  }
  /** the session again after a sign-in: the models on offer, and the person as the service names them */
  private async reloadSession() {
    const sess = await this.services.session.load(); if (!sess.ok || !sess.value.models.length) return;
    const prefs = this.state.prefs;
    const model = prefs.model && sess.value.models.some((m) => m.id === prefs.model) ? prefs.model : sess.value.defaultModel;
    this.set({ ...this.state, user: sess.value.user, models: sess.value.models, model });
  }
  /** why nothing can be changed just now, if it cannot: nobody is signed in to Intelligence */
  readOnly(): string | null { return this.state.signin?.out ? `Sign in to ${SERVICE} to make changes` : null; }
  private netDown() {
    if (this.state.net.down) return;
    this.set({ ...this.state, net: { ...this.state.net, down: true } });
    if (!this.probe) this.probe = setInterval(() => void this.probeOnce(), 10000);
  }
  private stopProbe() {
    if (this.probe) { clearInterval(this.probe); this.probe = null; }
    if (this.state.net.down) this.set({ ...this.state, net: { ...this.state.net, down: false } });
  }
  private netUp() {
    if (this.probe) { clearInterval(this.probe); this.probe = null; }
    if (this.state.net.down) {
      this.set({ ...this.state, net: { ...this.state.net, down: false } });
      this.toast('Connected again', 'done');
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(CONNECTED));
    }
    for (const [req, w] of [...this.stoppedReplies]) if (w.last === 'unreachable') this.retryKeptReply(req);   // replies that ran out of tries while the folder was away get theirs again
    if (this.waitingReplies.size) void this.tryWaiting(true);   // replies waiting for the folder are written at once
  }
  async probeOnce() {
    // past the session step start-up needs only the shared folder, not the model service: it carries on from there, signed in or not
    if (this.state.boot.stage === 'deals' || this.state.boot.stage === 'journal') return this.boot();
    const r = await this.services.session.load();
    if (!r.ok) {
      // started while out of reach, then nobody signed in: the start screen says so with Retry, rather than the offline bar retrying for ever.
      // Only at the session step, since a Retry from a later step does not load the session again, so it could not reach the sign-in
      if (r.error.kind !== 'unreachable' && this.state.boot.stage === 'session' && this.state.net.down) { this.stopProbe(); this.bootFailed(r.error); }
      return;
    }
    if (this.state.boot.stage !== 'ready') await this.boot(); else this.netUp();
  }
}
