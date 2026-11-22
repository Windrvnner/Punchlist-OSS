/**
 * A field bound to one record attribute. Native <textarea>/<input>, so the
 * browser owns editing, focus, line breaks and the caret. Keeps a local draft
 * while focused; commits through a command on blur, Enter (single-line) or a
 * debounce. Shows pending / not-saved / updated-elsewhere beside the field.
 */
import { TEXT_MAX } from '../domain/importExport';
import { keptDrafts, hasTexts, saveKeptDrafts } from './keptDrafts';
import { fmtDate, StoreContext } from './hooks';
import type { State } from '../app/state';
import { CONNECTED } from '../app/connection';
import { CHANGED_ELSEWHERE } from '../app/changedElsewhere';
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * Why the fields below this point cannot be edited right now, or null. A field under a reason can be read and
 * copied and sends nothing. Text typed just before the reason arrived is kept in the field, marked as not saved,
 * and is sent when the reason clears.
 */
export const ReadOnlyContext = createContext<string | null>(null);
/** the reason when nobody is signed in to the model service (app root): only that lock lets a field being typed in stay open */
export const SignedOutContext = createContext<string | null>(null);

/**
 * Text typed into a field that could not be saved before the field went away (the record was found changed in two places
 * and the version choice took the field's place, or the person moved on while saving failed), by the field's `keep` key.
 * When the field appears again its text comes back, marked "Not saved", so nothing typed is lost. `base` is the record's
 * value the text was typed over: if the record holds another value by then (changed on another PC meanwhile), the field
 * shows "Changed elsewhere" instead, so a Retry cannot write over that change without the person choosing.
 * `rev` is the record's rev when the field was last seen holding `base`, with no change to the field since, or -1 once it
 * has changed: a field changed elsewhere and then put back holds `base` again, but its record's rev has moved on.
 */
type Kept = { text: string; base: string; rev: number };
const isKept = (v: unknown): v is Kept => hasTexts('text', 'base')(v) && Number.isInteger((v as { rev?: unknown }).rev);
const unsaved = keptDrafts('edit-field', isKept);
/** a field's kept text moved to a record's copy is not vouched for there: the field asks when it is back */
export const staleKept = (v: unknown) => (isKept(v) ? { ...v, rev: -1 } : v);
/** whether a field has typed text kept as not saved: a field that hides while empty still shows to keep it in view */
export const keepsUnsaved = (keep: string) => unsaved.has(keep);

/**
 * While its field is off screen, kept text is watched: the record's rev is followed while the field still holds
 * `base` (another part of the record changing, the field next door saving, is not a change to this field), and the first
 * change to the field itself marks it, so it is still caught when the field is put back. After a restart nothing watched,
 * so any change to the record since counts: the field then asks rather than risk writing over another PC's work.
 */
const watching = new Map<string, () => void>();          // by `keep`: stops watching it
const onScreen = new Map<string, number>();              // by `keep`: fields showing it now, which follow it themselves
type Watchable = { get(): State; subscribe(fn: () => void): () => void };
function watchKept(keep: string, store: Watchable, read: (s: State) => { value: string; rev: number } | undefined) {
  watching.get(keep)?.();
  const off = store.subscribe(() => check());
  const stop = () => { off(); if (watching.get(keep) === stop) watching.delete(keep); };
  let vouched = -1;                                       // the rev this watch last saw the record at with the field holding `base`, unbroken since
  const check = () => {
    const e = unsaved.get(keep);
    if (!e || onScreen.has(keep)) { stop(); return; }
    const now = read(store.get());
    if (!now) { vouched = -1; return; }                                                    // not loaded (another deal open): unseen meanwhile, so the rev decides when it is back
    if (now.value !== e.base) { vouched = -1; if (e.rev >= 0) unsaved.set(keep, { ...e, rev: -1 }); return; }
    if (now.rev === e.rev) { vouched = now.rev; return; }
    // one version on, holding `base`: only another part of the record changed. Two or more at once (one sync) may be a change
    // to the field and another putting it back, so the rev is left behind and the field asks when it is back
    if (e.rev >= 0 && e.rev === vouched && now.rev === vouched + 1) { vouched = now.rev; unsaved.set(keep, { ...e, rev: now.rev }); }
  };
  watching.set(keep, stop); check();
}

/** the text a field kept as not saved under its `keep` key, if any, so a screen can tell typed work is waiting */
export const unsavedText = (keep: string): string | undefined => unsaved.get(keep)?.text;
/** the record's value that kept text was typed over (see `unsaved`) */
export const unsavedBase = (keep: string): string | undefined => unsaved.get(keep)?.base;

/**
 * A reload, close or crash would lose that text, and a reload or close inside the debounce the last words typed.
 * `unsaved` is kept in the window's local storage as it changes (keptDrafts.ts), so it is back after any
 * restart, crash included, and shows "Not saved" for the person to decide; if the save did land, the field's value equals
 * the kept text and it is dropped. When the page goes away every field with text not yet saved also sends it at once and
 * puts it in `unsaved`, which is then written before the page is gone.
 */
const leaving = new Set<() => void>();                 // one per field on screen: send what is waiting, keep what is not saved
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { for (const f of leaving) f(); saveKeptDrafts(); });

/** `read` for a text field of a question or a deal, and for a deal's label for one of its folders */
const fieldOf = (r: { rev: number } | undefined, v: unknown) => (r && typeof v === 'string' ? { value: v, rev: r.rev } : undefined);
export const readQuestion = (id: string, f: string) => (s: State) => { const r = s.questions[id]; return fieldOf(r, (r as unknown as Record<string, unknown> | undefined)?.[f]); };
export const readDeal = (id: string, f: string) => (s: State) => { const r = s.deals[id]; return fieldOf(r, (r as unknown as Record<string, unknown> | undefined)?.[f]); };
export const readFolderLabel = (id: string, path: string) => (s: State) => { const r = s.deals[id]; return fieldOf(r, r?.folders.find((x) => x.path === path)?.label); };

export interface EditFieldProps {
  value: string;                     // the record's current value
  rev: number;                       // the record's rev, to detect external change
  /**
   * `over` is the record's value the text was typed over: the save is refused as changed elsewhere if the record has moved on
   * by its turn. `value.unchanged`: the save went through with nothing to write (the record already held it, as the app stores it)
   */
  commit: (value: string, over: string) => Promise<{ ok: boolean; value?: { unchanged?: boolean }; error?: { kind: string; message: string } }>;
  /** the most characters the record takes: typing stops there, so a value that cannot be saved is never typed */
  maxLength?: number;
  multiline?: boolean;
  placeholder?: string;
  label: string;
  className?: string;
  type?: 'text' | 'date';
  debounceMs?: number;
  /** a stable name for this field of this record (record id and field), so unsaved text survives the field going away */
  keep?: string;
  /**
   * told the field's text as it appears and whenever it changes (what the box holds, saved or not), and '' as it goes,
   * with the record's value it was typed over, for a save made on the field's behalf to send as `over`, and whether the field
 * shows "Changed elsewhere" (a change put back there is caught by its rev, not its value)
   */
  onText?: (text: string, over: string, elsewhere: boolean) => void;
  /** this field and its record's rev in the app's state: text kept while the field is off screen is watched with it */
  read?: (s: State) => { value: string; rev: number } | undefined;
  /**
   * draws the field as an editable value: a capsule (design.md, Editable values) around the field and its leading icon, if
   * any, with the field's notes (Not saved, Changed elsewhere) outside it. `cls` and `title` go on the capsule. A press
   * anywhere in it goes to the field, as a press on its words would.
   */
  cap?: { icon?: ComponentChildren; cls?: string; title?: string };
}

export function EditField({ value, rev, commit, multiline, placeholder, label, className, type = 'text', debounceMs = 500, maxLength = TEXT_MAX, keep, onText, read, cap }: EditFieldProps) {   // no field holds more than one export cell
  const signedOut = useContext(SignedOutContext);
  const locked = useContext(ReadOnlyContext); const lockedRef = useRef(locked); lockedRef.current = locked;
  const store = useContext(StoreContext); const readRef = useRef(read); readRef.current = read;
  const left = keep !== undefined ? unsaved.get(keep) : undefined;
  const kept = left && left.text !== value ? left.text : null;
  if (keep !== undefined && kept === null) unsaved.delete(keep);
  const [draft, setDraftState] = useState(kept ?? value);
  const base = useRef(left && kept !== null ? left.base : value);                       // the record's value the text in the field was typed over: kept with text not saved, so a change elsewhere is still seen after the field goes and comes back
  // the field takes the record's value in place of the person's: it is what is typed next over, and Escape then has no edit of the person's to take back over it
  const takeBase = (v: string) => { base.current = v; baseRev.current = seen.current.rev; jumped.current = false; atFocus.current = v; notSavedAtFocus.current = null; };
  // once the field is gone, the watch below owns the kept rev: a save that ends after that keeps what it has found, unless it moves `base`
  const keepText = (text: string) => { if (keep !== undefined && !halfRef.current) unsaved.set(keep, { text, base: base.current, rev: externalRef.current ? -1 : (gone.current && unsaved.get(keep)?.base === base.current ? unsaved.get(keep)?.rev : undefined) ?? baseRev.current }); };
  // kept text, and the record changed elsewhere since it was typed: to another value, or away and back
  const changedSince = kept !== null && (base.current !== value || left!.rev !== rev);
  const baseRev = useRef(changedSince ? -1 : rev); const gone = useRef(false);
  const jumped = useRef(false);                                                          // several versions arrived at once while a save of this field was out: the field may have been changed and put back                                       // the record's rev when the field was last seen holding `base`, with no change to the field since; -1 when not known
  const [focused, setFocusedState] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed' | 'refused'>(kept !== null && !changedSince ? 'failed' : 'idle');
  const statusRef = useRef(status); statusRef.current = status;
  const [byItself, setByItself] = useState(false);                                       // the save failed because the Punchlist folder was out of reach: the field sends its text again once the app is connected, so its button says "Retry now" (decisions.md)
  const byItselfRef = useRef(false); byItselfRef.current = byItself;
  const waits = useRef(false);                                                           // a save of this field could not be written and none has gone through since
  const resending = useRef(false);                                                       // the save under way is the field's own second try: if the folder is still away, the field leaves it to the person
  // (the app counts itself connected when the service answers, which may be before the folder does: one second try, not a loop)
  const [held, setHeld] = useState(false);                                              // in the field when the app went read-only: it stays open until it is left
  const [reason, setReason] = useState('');                                              // why a save was refused (the value is not accepted, or a rule of the record's says no: retrying cannot help)
  const halfAtFocus = useRef(false);                                                     // the field held a date in part when the person came into it: Escape does not take back parts typed before
  const atFocus = useRef(value);                                                         // the value when the person came into the field: what Escape goes back to
  // the field held text not saved when the person came in (kept "Not saved", or a save refused): what was saved then, and the
  // status shown, so Escape puts the field back as it was and leaves that text for the person to send
  // (a date held in part is not text: Escape and leaving follow #928's rule for it, so it is never taken for this)
  const notSavedAtFocus = useRef<{ saved: string; status: 'failed' | 'refused'; byItself: boolean; reason: string } | null>(null);
  const untouched = useRef(false);                                                       // nothing typed since entry, or Escape put the field back as it was on entry
  const [external, setExternalState] = useState(changedSince);
  const externalRef = useRef(changedSince); const setExternal = (v: boolean) => { externalRef.current = v; setExternalState(v); };
  // Refs mirror what the handlers need, so nothing below decides from a stale render.
  const draftRef = useRef(kept ?? value); const setDraft = (v: string) => { draftRef.current = v; setDraftState(v); };
  const focusedRef = useRef(false); const setFocused = (v: boolean) => { focusedRef.current = v; setFocusedState(v); };
  const seen = useRef({ rev, value });                 // the record as this field last saw it
  const inFlight = useRef<string[]>([]);               // values this field has sent and not yet seen come back
  const arrived = useRef<string[]>([]);                // values the record took while saves of this field were out that were none of them: a save of ours as the app stored it (trimmed, say), or a change from elsewhere
  const timer = useRef<number | null>(null);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  // A date typed in part (11/02/yyyy) reads as empty, and the browser alone holds the parts typed. The field keeps them
  // where they are: it stays a date field, its value stays empty so the parts are not drawn over, and nothing reads that empty
  // value as text to save or keep. Left that way, it says "Not saved: Enter a real date"; a change from elsewhere is asked about.
  const [half, setHalfState] = useState(false); const halfRef = useRef(false);
  const setHalf = (v: boolean) => { halfRef.current = v; setHalfState(v); };
  // puts a value in the field over parts typed, once it is drawn: drawing an empty value over an empty one would leave them in
  // place, and a value written straight in from a key is put back to the drawn one by Preact
  const putBackTo = useRef<string | null>(null);
  const putBack = (v: string) => { setHalf(false); putBackTo.current = v; };
  useLayoutEffect(() => { const v = putBackTo.current; putBackTo.current = null; if (v !== null && ref.current) ref.current.value = v; });

  // The record changed underneath: our own save landing, or someone else (another tab, undo, reload).
  // Runs before paint and never on mount, so it cannot overwrite what is being typed.
  useLayoutEffect(() => {
    const prev = seen.current;
    if (prev.rev === rev && prev.value === value) return;
    seen.current = { rev, value };
    if (value === atFocus.current) notSavedAtFocus.current = null;                      // the text on entry is saved now (a Retry, or the resend on reconnect): Escape has nothing of it to keep back
    if (prev.value === value) {                                                        // another part of the record changed (the field next door saved): this field's value is what it was, so nothing here is in question
      if (value === base.current && baseRev.current === prev.rev && rev === prev.rev + 1) { baseRev.current = rev; const e = keep !== undefined ? unsaved.get(keep) : undefined; if (e && e.rev >= 0) unsaved.set(keep!, { ...e, rev }); }   // and kept text follows the record's rev, so it is not taken for a change when the field comes back
      else if (value === base.current && inFlight.current.length && rev > prev.rev + 1) jumped.current = true;   // the same with a save of this field out: asked about if that save does not land (`otherSince`)
      else if (value === base.current && !inFlight.current.length) {
        // more than one version arrived at once (one sync): one may have changed this field and another put it back
        if (draftRef.current === value) baseRev.current = rev;                                   // nothing of the person's here to be in question
        else if (rev > prev.rev + 1) { if (timer.current) { clearTimeout(timer.current); timer.current = null; } setExternal(true); if (!saving.current) setStatus('idle'); keepText(draftRef.current); }   // autosave has stopped, so the text is kept against a crash
      }
      return;
    }
    const mine = inFlight.current.indexOf(value);
    if (mine >= 0) { inFlight.current = inFlight.current.slice(mine + 1); base.current = value; baseRev.current = rev; jumped.current = false; return; }   // our own save: keep whatever has been typed since
    if (inFlight.current.length) { arrived.current.push(value); if (value === base.current) jumped.current = true; return; }   // back to what the text was typed over after moving off it: changed and put back, asked about if the save out does not land              // a newer save of ours is on its way and will settle it
    // text here that is not what the record held (typed, or not saved) is never overwritten, focused or not: the person chooses
    if (!halfRef.current && (draftRef.current === prev.value || draftRef.current === value)) { setDraft(value); setExternal(false); takeBase(value); }
    else { if (timer.current) { clearTimeout(timer.current); timer.current = null; } externalRef.current = true; setExternalState(true); if (!saving.current) setStatus('idle'); keepText(draftRef.current); }   // typed here and changed elsewhere: nothing saves until the person chooses, so the text is kept against a crash and a failed save's Retry gives way to the choice
  }, [value, rev]);

  // The record's value is no longer the one the text here was typed over, and the change was not this field's own: one that
  // landed while a save of this field was out is not flagged by the effect above, so a Retry would write over it. It is
  // flagged now, and nothing is sent until the person chooses.
  const otherSince = (v: string) => {
    if (v === seen.current.value || (base.current === seen.current.value && !jumped.current)) return false;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    byJump.current = base.current === seen.current.value;                              // asked only because of a jump while a save was out: that save landing answers it
    setExternal(true); keepText(draftRef.current); if (!saving.current) setStatus('idle'); return true;   // nothing autosaves now, so the text is kept against a crash
  };
  const byJump = useRef(false);
  const halfTyped = () => type === 'date' && !!(ref.current as unknown as HTMLInputElement | null)?.validity?.badInput;
  const saving = useRef(0);
  const flush = async (v: string, chosen = false) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (lockedRef.current) { if (v !== seen.current.value) keepText(v); return; }       // read-only: nothing is sent; what was typed stays in the field, and is kept on this PC
    if (externalRef.current && !chosen) return;                                         // waiting for Keep mine / Take theirs: autosave and blur do not decide for the person
    if (chosen) { base.current = seen.current.value; baseRev.current = seen.current.rev; jumped.current = false; setExternal(false); }              // Keep mine: the person has seen the other change and chose over it; a later one is still caught
    else if (otherSince(v)) return;                                                     // a Retry or resend over a change made elsewhere since this text was typed: the person chooses
    if (halfTyped()) { if (chosen && !focusedRef.current) markHalf(); return; }         // a date still being typed reads as empty: that is not an instruction to clear it
    // text taken back to what is saved needs no save, unless one that could not be written waits: it is sent, so the app knows that one is not wanted
    if (v === seen.current.value && !inFlight.current.length && !waits.current) { if (!saving.current) setStatus('idle'); return; }
    if (inFlight.current[inFlight.current.length - 1] === v) return;                    // this exact value is already being saved
    setStatus('saving'); setExternal(false);
    inFlight.current = [...inFlight.current, v]; saving.current++;
    const again = resending.current; resending.current = false;
    const over = base.current;
    const r = await commit(v, over);
    saving.current--;
    const drop = () => { inFlight.current = inFlight.current.filter((x) => x !== v); };
    // Saves of a record are made one at a time, and one that is written is applied before its caller hears back, so the
    // first value the record took that was not exactly ours is our save as the app stored it; any after it came from
    // elsewhere and are not taken as what the text is typed over, so they are still asked about. This relies on the
    // field being drawn once for each value the record takes, which the Store keeps true: it awaits the journal write after
    // applying a save, so a change from elsewhere is drawn apart from it.
    const settle = (own: boolean) => {
      const exact = !inFlight.current.includes(v); drop();
      if (r.ok && v === atFocus.current) notSavedAtFocus.current = null;                 // the text on entry is saved now, even if the app stored it trimmed or had nothing to write: Escape has nothing of it to keep back
      if (own && !exact) { const stored = arrived.current.shift(); if (stored !== undefined) { base.current = stored; baseRev.current = arrived.current.length ? -1 : seen.current.rev; if (keep !== undefined && unsaved.has(keep)) keepText(unsaved.get(keep)!.text); } }   // text kept meanwhile (the field left the screen) is kept as typed over our save, not over what was there before
      if (!inFlight.current.length) {
        arrived.current = []; if (own) jumped.current = false;                            // a save of ours that landed last is what the record holds over any jump
        // asked only because of that jump, and the record now holds our own save: nothing from elsewhere is left to ask about, so the text typed since is sent
        if (own && byJump.current && externalRef.current && base.current === seen.current.value) { byJump.current = false; setExternal(false); void flush(draftRef.current); return; }
        otherSince(draftRef.current);
      }
    };
    if (!r.ok && r.error?.kind === 'conflict' && r.error.message === CHANGED_ELSEWHERE) {
      // the Store refused it: by its turn the record held something other than what the text was typed over, a change from
      // elsewhere that synced in while it waited. Nothing was written.
      settle(false); if (!saving.current) setStatus('idle');
      const now = seen.current.value;
      const dropKept = () => { if (keep !== undefined) unsaved.delete(keep); };            // settle may have kept the text just now: with nothing of the person's left here, a kept copy would offer it again over the newer value
      if (!halfRef.current && draftRef.current === now) { takeBase(now); setExternal(false); dropKept(); return; }
      // nothing of the person's own here (Take theirs, or the text taken back to what it was typed over): it follows the
      // record, and a save of the field still waiting is settled with the newer value. If the field has not been drawn with
      // the newer value yet, the effect above follows it when it is.
      if (!halfRef.current && draftRef.current === over) { dropKept(); if (now !== over) { setDraft(now); takeBase(now); setExternal(false); if (waits.current) void flush(now, true); } return; }
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setExternal(true); keepText(draftRef.current); return;                              // kept until the person chooses, as any text not saved is
    }
    if (r.ok) { setTimeout(() => settle(!r.value?.unchanged), 0); if (keep !== undefined && unsaved.get(keep)?.text === v) unsaved.delete(keep); } else settle(false);                                         // normally the effect above has already seen it come back
    // text that could not be saved is kept for the next start straight away, not only when the field goes, so a crash with "Not saved" on screen keeps it
    if (!r.ok) keepText(draftRef.current);
    waits.current = !r.ok && r.error?.kind !== 'invalid' && r.error?.kind !== 'rejected' ? true : r.ok ? false : waits.current;
    if (!r.ok && r.error?.kind !== 'invalid' && r.error?.kind !== 'rejected' && otherSince(draftRef.current)) return;   // a change from elsewhere landed while this save was out: "Changed elsewhere", not Retry
    if (!r.ok) { if (r.error?.kind === 'invalid' || r.error?.kind === 'rejected') { setReason(r.error.message); setStatus('refused'); } else { setByItself(r.error?.kind === 'unreachable' && !again); setStatus('failed'); } }
    else if (!saving.current) setStatus('idle');
    return r.ok;
  };
  const onInput = (e: Event) => typed((e.currentTarget as HTMLInputElement).value);
  const typed = (v: string) => {
    setHalf(halfTyped()); setDraft(v); setStatus('idle'); untouched.current = false;
    if (halfRef.current) { if (timer.current) { clearTimeout(timer.current); timer.current = null; } return; }   // nothing readable yet: nothing to send or keep
    if (keep !== undefined && (unsaved.has(keep) || externalRef.current)) keepText(v);   // what is kept as not saved follows the typing until a save lands, and while "Changed elsewhere" waits nothing autosaves
    // read-only (held open below): nothing can be sent, so what is typed is kept on this PC as it is typed, and survives a crash
    else if (lockedRef.current && v !== seen.current.value) keepText(v);
    if (timer.current) clearTimeout(timer.current);
    if (!externalRef.current) timer.current = window.setTimeout(() => void flush(draftRef.current), debounceMs);
  };
  // a date typed in part is left in the field, marked as a date that cannot be saved. While "Changed elsewhere" asks, that
  // note is the sign, and its buttons do not move under the pointer as the focus leaves for them; the mark comes once it is answered.
  const markHalf = () => { setHalf(true); if (!externalRef.current) { setReason('Enter a real date'); setStatus('refused'); } };
  const onBlur = () => {
    setHeld(false); setFocused(false);
    if (halfTyped()) { markHalf(); return; }
    // text that was not saved on entry, left untouched or put back by Escape, is not sent by leaving: the person sends it with Retry.
    // Text typed and then deleted back to it is an edit, and leaving sends it as any edit.
    if (notSavedAtFocus.current && untouched.current && draftRef.current === atFocus.current) { if (timer.current) { clearTimeout(timer.current); timer.current = null; } return; }
    void flush(draftRef.current);
  };
  // typing the parts of a date changes nothing the field reads, so no input comes: a key that starts or ends a date in part is followed here
  const onKeyUp = () => { if (type === 'date' && halfTyped() !== halfRef.current) typed((ref.current as HTMLInputElement).value); };
  const onKey = (e: KeyboardEvent) => {
    if (!multiline && e.key === 'Enter') { e.preventDefault(); untouched.current = false; (e.currentTarget as HTMLElement).blur(); }   // Enter sends the text, kept "Not saved" text too: unlike leaving the field, it is the person's own choice to save
    if (e.key === 'Escape' && externalRef.current) return;                                         // "Changed elsewhere" is left for the person to answer: Escape keeps what was typed, the choice stays open, and it closes what holds the field (decisions.md: Escape closes)
    // In a one-line field Escape cancels the edit (as in a spreadsheet): back to the value the field had when it was entered,
    // saving that back if part of the edit was already saved. In a text box Escape closes what holds it and keeps the text,
    // since a long passage thrown away by one key is work lost. An Escape that changes nothing goes on to close what holds the field.
    if (e.key === 'Escape' && !multiline && (draftRef.current !== atFocus.current || (halfTyped() && !halfAtFocus.current)) && !locked) {
      e.stopPropagation(); e.preventDefault();
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      const was = notSavedAtFocus.current; const text = atFocus.current;
      putBack(text); setDraft(text);
      // the edit is taken back, so text of it kept as not saved (its save failed while the person typed on) goes too: it is not offered again when the field comes back
      if (!was) { if (keep !== undefined) unsaved.delete(keep); setStatus('idle'); void flush(text); return; }
      untouched.current = true;
      // the text on entry was not saved: it comes back still not saved, with its Retry, and nothing of it is sent.
      // Part of the edit that was already saved is taken back, as above, by sending back what was saved on entry; that send also
      // settles a save of the edit that could not be written, so it is not offered after a restart (the text stays kept here).
      const back = () => { if (draftRef.current !== text || externalRef.current) return; keepText(text); setByItself(was.byItself); setReason(was.reason); setStatus(was.status); };
      if (seen.current.value === was.saved && !inFlight.current.length && !(waits.current && keep !== undefined)) back();   // with no `keep`, the journal is where text not saved is kept, so it is left as it is
      else void flush(was.saved).then(back);                                              // whether it lands or fails, the field shows the text as on entry: a failure does not make it "Retry now", sent by itself
    }
  };
  // taking theirs drops this field's text; a save of it that could not be written still waits, so the record's own value is
  // sent (nothing to write), which tells the app that save is not wanted and it is not offered after a restart
  const takeTheirs = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } if (keep !== undefined) unsaved.delete(keep); putBack(value); takeBase(value); setDraft(value); setExternal(false); setStatus('idle'); if (waits.current) void flush(value, true); };
  // leaving the field's screen with a save still waiting on the debounce: send it now
  // and keep the text for the next time this field appears, until it is known to be saved
  useLayoutEffect(() => () => { if (draftRef.current !== seen.current.value) keepText(draftRef.current); if (timer.current) { clearTimeout(timer.current); timer.current = null; if (draftRef.current !== seen.current.value && !halfRef.current && !externalRef.current && !lockedRef.current && base.current === seen.current.value) void commit(draftRef.current, base.current); } }, []);   // changed elsewhere since it was typed: kept, and the field asks when it is back
  // on screen, the field follows its kept text itself; once it goes, the text it leaves behind is watched
  useLayoutEffect(() => {
    if (keep === undefined) return;
    watching.get(keep)?.(); onScreen.set(keep, (onScreen.get(keep) ?? 0) + 1);
    return () => {
      gone.current = true; const n = (onScreen.get(keep) ?? 1) - 1; if (n) onScreen.set(keep, n); else onScreen.delete(keep);
      if (!n && store && readRef.current && unsaved.has(keep)) watchKept(keep, store, readRef.current);
    };
  }, []);
  // the page itself going away (reload, close): the same, without unmounting; the module's pagehide listener then writes `unsaved` to storage
  const onLeave = useRef(() => {}); onLeave.current = () => { if (draftRef.current !== seen.current.value) keepText(draftRef.current); if (timer.current) void flush(draftRef.current); };
  useLayoutEffect(() => { const f = () => onLeave.current(); leaving.add(f); return () => { leaving.delete(f); }; }, []);

  // the app is connected again: a save that failed because the folder was out of reach is sent again, with the text as it is now
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const once = () => { if (statusRef.current === 'failed' && byItselfRef.current && !externalRef.current) { resending.current = true; void flush(draftRef.current); } };
    window.addEventListener(CONNECTED, once); return () => window.removeEventListener(CONNECTED, once);
  }, []);

  // the reason cleared: send what was typed before it arrived
  // (text brought back from before the field went away is not sent by itself: it shows "Not saved", and the person decides)
  const restored = useRef(kept !== null);
  // the lock arrives: text typed and not yet sent (still inside the wait before a save) is kept on this PC at once, so a crash keeps it
  useLayoutEffect(() => { if (locked && draftRef.current !== seen.current.value) keepText(draftRef.current); if (locked && focusedRef.current && locked === signedOut) setHeld(true); }, [locked]);
  useLayoutEffect(() => { if (restored.current) { restored.current = false; return; } if (!locked && !focusedRef.current && draftRef.current !== seen.current.value) void flush(draftRef.current); }, [locked]);

  const onTextRef = useRef(onText); onTextRef.current = onText;
  useLayoutEffect(() => { onTextRef.current?.(draft, base.current, external); }, [draft, external, status]);   // what it is typed over moves with a save landing or a change from elsewhere
  useLayoutEffect(() => () => onTextRef.current?.('', '', false), []);   // text it kept as not saved is then in `unsaved`

  // autosize textareas
  useLayoutEffect(() => { const el = ref.current; if (el && multiline) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }, [draft, multiline]);

  const common = { ref: ref as any, value: draft, placeholder, dir: 'auto' as const, 'aria-label': label,   // dir: text in Hebrew or Arabic runs right to left as it is typed
    onInput, onBlur, onKeyUp, onFocus: () => { atFocus.current = draftRef.current; halfAtFocus.current = halfRef.current; untouched.current = true; notSavedAtFocus.current = !halfRef.current && draftRef.current !== seen.current.value && (statusRef.current === 'failed' || statusRef.current === 'refused') ? { saved: seen.current.value, status: statusRef.current, byItself: byItselfRef.current, reason } : null; setFocused(true); }, maxLength, onKeyDown: onKey, readOnly: !!locked && !held, title: locked ?? undefined, class: `ef ${className ?? ''} ${locked ? 'idle' : status} ${external && !locked ? 'external' : ''}` };
  // a date at rest reads as the rest of the app writes one ("Oct 28"); the browser's own field sits over it, unseen,
  // so a click or Tab lands in it and it shows itself while focused
  const asText = type === 'date' && !focused && !half && /^\d{4}-\d{2}-\d{2}$/.test(draft) ? fmtDate(draft) : '';
  const shown = asText && <span class={`dshow ${className ? `${className}-show` : ''}`} aria-hidden="true">{asText}</span>;
  const field = multiline ? <textarea rows={1} {...common} /> : type === 'date' ?
    <input {...({ type: focused || draft || half ? 'date' : 'text' } as any)} {...common}
    placeholder={placeholder ?? 'Date'} onClick={(e) => { const i = e.currentTarget;
    if (i.type === 'date' && !i.readOnly) try { i.showPicker(); } catch
    { /* not allowed here: typing the date still works */ } }} /> : <input type="text" {...common} />;
  return (
    <span class={`efwrap ${asText ? 'dtext' : ''} ${cap ? 'capped' : ''}`}>
      {cap ? <span class={`efcap ${cap.cls ?? ''}`} title={cap.title} onClick={(e) => { const i = ref.current as HTMLInputElement | null; if (i && e.target !== i) { i.focus(); i.click(); } }}>{cap.icon}{shown}{field}</span> : <>{shown}{field}</>}
      {locked && draft !== value && <span class="efstate">Not saved</span>}
      {!locked && status === 'saving' && <i class="efstate" title="Saving">·</i>}
      {!locked && status === 'refused' && <span class="efstate fail" role="alert">Not saved: {reason}</span>}
      {!locked && status === 'failed' && <button type="button" class="efstate fail" onClick={() => void flush(draftRef.current)}>Not saved · {byItself ? 'Retry now' : 'Retry'}</button>}
      {!locked && external && <span class="efstate ext">Changed elsewhere · <button type="button"
        onClick={() => void flush(draftRef.current, true)}>Keep Mine</button> <button type="button"
        onClick={takeTheirs}>Take Theirs</button></span>}
    </span>
  );
}
