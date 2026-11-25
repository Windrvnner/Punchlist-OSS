/**
 * A field bound to one record attribute. Native <textarea>/<input>, so the
 * browser owns editing, focus, line breaks and the caret. Keeps a local draft
 * while focused; commits through a command on blur, Enter (single-line) or a
 * debounce. Shows pending / not-saved / updated-elsewhere beside the field.
 */
import { TEXT_MAX } from '../domain/importExport';
import { limitClass, limitTitle } from './limit';
import {
  type FieldDraft, type FieldValue, type ReadField, restoreFieldDraft, showFieldDraft, takeHandedText,
} from '../app/fieldDrafts';
import {
  type FieldAtFocus, type FieldCommit, type FieldComposition, FieldSave, type FieldSaveView,
} from '../app/fieldSave';
import { saveKeptDrafts } from '../app/keptText';
import { CONNECTED } from '../app/connection';
import { fmtDate, StoreContext } from './hooks';
import { createContext, type ComponentChildren, type JSX } from 'preact';
import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * Why the fields below this point cannot be edited right now, or null. A field under a reason can be read and
 * copied and sends nothing. Text typed just before the reason arrived is kept in the field, marked as not saved,
 * and is sent when the reason clears.
 */
export const ReadOnlyContext = createContext<string | null>(null);
/** the reason when nobody is signed in to the model service (app root): only that lock lets a field being typed in stay open */
export const SignedOutContext = createContext<string | null>(null);

// Collect the last input text before the shell's page-hide flush.
const leaving = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const exit of leaving) exit();
    saveKeptDrafts();
  });
}

export interface EditFieldProps {
  value: string;                     // the record's current value
  rev: number;                       // the record's rev, to detect external change
  /**
   * `over` is the record's value the text was typed over: the save is refused as changed elsewhere if the record has moved on
   * by its turn. `value.unchanged`: the save went through with nothing to write (the record already held it, as the app stores it)
   */
  commit: FieldCommit;
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
  read?: ReadField;
  /**
   * draws the field as an editable value: a capsule (design.md, Editable values) around the field and its leading icon, if
   * any, with the field's notes (Not saved, Changed elsewhere) outside it. `cls` and `title` go on the capsule. A press
   * anywhere in it goes to the field, as a press on its words would.
   */
  cap?: { icon?: ComponentChildren; cls?: string; title?: string };
}

export function EditField({
  value, rev, commit, multiline, placeholder, label, className, type = 'text', debounceMs = 500, maxLength = TEXT_MAX,
  keep, onText, read, cap,
}: EditFieldProps) {
  const input = useFieldInput(value, rev, keep, type, commit, debounceMs, onText, read, multiline);
  const {
    draft, focused, half, held, ref, locked, status, external, onInput, onCompositionStart, onCompositionEnd,
    onBlur, onFocus, onKeyUp,
    onKey, retry, takeTheirs,
  } = input;

  // autosize textareas
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !multiline) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [draft, multiline]);

  // dir: text in Hebrew or Arabic runs right to left as it is typed.
  const common = {
    ref: ref as any, value: draft, placeholder, dir: 'auto' as const, 'aria-label': label,
    onInput, onCompositionStart, onCompositionEnd, onBlur, onKeyUp, onFocus, maxLength, onKeyDown: onKey,
    readOnly: !!locked && !held,
    title: locked ?? limitTitle(draft),
    class: `ef ${className ?? ''} ${locked ? 'idle' : status} ${external && !locked ? 'external' : ''}`
      + limitClass(draft),
  };
  // a date at rest reads as the rest of the app writes one ("Oct 28"); the browser's own field sits over it, unseen,
  // so a click or Tab lands in it and it shows itself while focused
  const asText = dateAtRest(type, focused, half, draft);
  const shown = dateLabel(asText, className);
  const field = multiline ? <textarea rows={1} {...common} />
    : type === 'date' ? dateControl(common, focused || half || !!draft) : <input type="text" {...common} />;
  return (
    <span class={`efwrap ${asText ? 'dtext' : ''} ${cap ? 'capped' : ''}`}>
      {cap ? <span class={`efcap ${cap.cls ?? ''}`} title={cap.title}
        onClick={(e) => focusCapsule(ref.current, e.target)}>
        {cap.icon}{shown}{field}</span> : <>{shown}{field}</>}
      {fieldNotes(input, value, () => retry(false), () => retry(true), takeTheirs)}
    </span>
  );
}

function dateAtRest(type: 'date' | 'text', focused: boolean, half: boolean, value: string): string {
  return type === 'date' && !focused && !half && /^\d{4}-\d{2}-\d{2}$/.test(value) ? fmtDate(value) : '';
}

function dateLabel(text: string, className: string | undefined) {
  return text && <span class={`dshow ${className ? `${className}-show` : ''}`} aria-hidden="true">{text}</span>;
}

function dateControl(props: Omit<JSX.IntrinsicElements['input'], 'type' | 'list' | 'role'>, editable: boolean) {
  const onClick: JSX.IntrinsicElements['input']['onClick'] = (event) => showDatePicker(event.currentTarget);
  const attrs = { ...props, placeholder: props.placeholder ?? 'Date', onClick };
  return editable ? <input {...attrs} type="date" /> : <input {...attrs} type="text" />;
}

function showDatePicker(input: HTMLInputElement) {
  if (input.type !== 'date' || input.readOnly) return;
  try {
    input.showPicker();
  } catch { /* typing the date still works */ }
}

function focusCapsule(input: HTMLInputElement | HTMLTextAreaElement | null, target: EventTarget | null) {
  if (!input || input === target) return;
  input.focus();
  input.click();
}

function fieldNotes(
  { locked, draft, status, reason, byItself, external }: FieldSaveView & { locked: string | null; draft: string },
  value: string, retry: () => void, keepMine: () => void, takeTheirs: () => void,
) {
  if (locked) return draft !== value && <span class="efstate">Not saved</span>;
  return <>
    {status === 'saving' && <i class="efstate" title="Saving">·</i>}
    {status === 'refused' && <span class="efstate fail" role="alert">Not saved: {reason}</span>}
    {status === 'failed' && <button type="button" class="efstate fail"
      onClick={retry}>Not saved · {byItself ? 'Retry now' : 'Retry'}</button>}
    {external && <span class="efstate ext">Changed elsewhere · <button type="button"
      onClick={keepMine}>Keep Mine</button> <button type="button" onClick={takeTheirs}>Take Theirs</button></span>}
  </>;
}

function useFieldInput(
  value: string, rev: number, keep: string | undefined, type: 'text' | 'date', commit: FieldCommit,
  debounceMs: number, onText: EditFieldProps['onText'], read: ReadField | undefined, multiline: boolean | undefined,
) {
  const locked = useContext(ReadOnlyContext);
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const kept = restoreFieldDraft(keep, value);
  const input = useLocalInput(kept?.text ?? value, value, type);
  const [save, view] = useFieldSave({ value, rev }, keep, kept, input, lockedRef);
  const flush = (text: string, chosen = false) => save.save(text, commit, chosen);
  const events = inputEvents(input, save, { commit, flush, debounceMs, multiline, locked });
  const retry = (chosen: boolean) => {
    if (input.composition.current === 'held') input.composition.current = 'idle';
    void flush(input.draftRef.current, chosen);
  };
  const takeTheirs = () => {
    cancelCompositionEnd(input);
    input.composition.current = 'idle';
    input.putBack(value);
    save.takeTheirs(value, commit);
  };

  useFieldLifecycle({ save, keep, read, commit, flush, onText, input, locked });
  return {
    ...view, ...events, locked, retry, takeTheirs, draft: input.draft, focused: input.focused, half: input.half,
    held: input.held, ref: input.ref,
  };
}

function useLocalInput(start: string, value: string, type: 'text' | 'date') {
  const [draft, setDraftState] = useState(start);
  const draftRef = useRef(start);
  const setDraft = (text: string) => {
    draftRef.current = text;
    setDraftState(text);
  };
  const [focused, setFocusedState] = useState(false);
  const focusedRef = useRef(false);
  const setFocused = (next: boolean) => {
    focusedRef.current = next;
    setFocusedState(next);
  };
  const [held, setHeld] = useState(false); // An input held open until blur when sign-in is lost.
  const atFocus = useRef(value);
  const halfAtFocus = useRef(false);
  const notSavedAtFocus = useRef<FieldAtFocus | null>(null);
  const untouched = useRef(false);
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const date = useDateInput(type, ref);
  const composition = useRef<FieldComposition>('idle');
  const compositionEnd = useRef<number | null>(null);
  const timer = useRef<number | null>(null);
  const stopTimer = () => {
    if (timer.current === null) return false;
    window.clearTimeout(timer.current);
    timer.current = null;
    return true;
  };
  return {
    ...date, draft, draftRef, setDraft, focused, focusedRef, setFocused, held, setHeld, atFocus, halfAtFocus,
    notSavedAtFocus, untouched, ref, composition, compositionEnd, timer, stopTimer,
  };
}
type LocalInput = ReturnType<typeof useLocalInput>;

function useDateInput(type: 'text' | 'date', ref: { current: HTMLInputElement | HTMLTextAreaElement | null }) {
  const typeRef = useRef(type);
  typeRef.current = type;
  const [half, setHalfState] = useState(false);
  const halfRef = useRef(false);
  const setHalf = (next: boolean) => {
    halfRef.current = next;
    setHalfState(next);
  };
  const halfTyped = () => typeRef.current === 'date' && !!ref.current?.validity.badInput;
  // Write over partial date parts only after Preact has drawn the field.
  const putBackTo = useRef<string | null>(null);
  const putBack = (text: string) => {
    setHalf(false);
    putBackTo.current = text;
  };
  useLayoutEffect(() => {
    const text = putBackTo.current;
    putBackTo.current = null;
    if (text !== null && ref.current) ref.current.value = text;
  });
  return { half, halfRef, halfTyped, setHalf, putBack };
}

function useFieldSave(
  record: FieldValue, keep: string | undefined, kept: FieldDraft | undefined,
  input: LocalInput, locked: { current: string | null },
) {
  const [view, setView] = useState<FieldSaveView>();
  const saver = useRef<FieldSave | undefined>(undefined);
  const save = saver.current ??= new FieldSave(record, keep, kept, {
    text: () => input.draftRef.current,
    composition: () => input.composition.current,
    partial: () => input.halfRef.current,
    partialNow: input.halfTyped,
    locked: () => !!locked.current,
    focused: () => input.focusedRef.current,
    stopTimer: input.stopTimer,
    markPartial: () => markHalf(input, save),
    replaceText: input.setDraft,
    adoptBase: (text) => {
      input.atFocus.current = text;
      input.notSavedAtFocus.current = null;
    },
    landedEntryText: (text) => {
      if (text === input.atFocus.current) input.notSavedAtFocus.current = null;
    },
    show: setView,
  });
  useLayoutEffect(() => save.receive(record), [record.value, record.rev]);
  return [save, view ?? save.view] as const;
}

function markHalf(input: LocalInput, save: FieldSave) {
  input.setHalf(true);
  save.refuseInput('Enter a real date');
}

type Flush = (text: string, chosen?: boolean) => Promise<unknown>;

function cancelCompositionEnd(input: LocalInput) {
  if (input.compositionEnd.current === null) return;
  window.clearTimeout(input.compositionEnd.current);
  input.compositionEnd.current = null;
}

function holdComposition(input: LocalInput, save: FieldSave) {
  if (input.composition.current === 'idle') return false;
  cancelCompositionEnd(input);
  input.composition.current = 'held';
  save.keepUnconfirmed();
  return true;
}

function compositionEvents(input: LocalInput, save: FieldSave, typed: (text: string) => void) {
  // #239: let the browser finish the candidate before the field can save it.
  const onCompositionStart = () => {
    cancelCompositionEnd(input);
    input.composition.current = 'active';
    input.stopTimer();
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (input.composition.current === 'idle') return;
    typed((event.currentTarget as HTMLInputElement).value);
    if (input.composition.current === 'held') {
      save.keepUnconfirmed();
      return;
    }
    // Chromium can fire compositionend before the blur that caused it, in one event turn.
    cancelCompositionEnd(input);
    input.compositionEnd.current = window.setTimeout(() => {
      input.compositionEnd.current = null;
      input.composition.current = 'idle';
      typed(input.draftRef.current);
    }, 0);
  };
  const onInput = (event: Event) => {
    const composing = (event as InputEvent).isComposing;
    if (composing && input.composition.current === 'idle') onCompositionStart();
    if (!composing && input.composition.current === 'held' && input.focusedRef.current) {
      input.composition.current = 'idle';
    }
    typed((event.currentTarget as HTMLInputElement).value);
    if (input.composition.current === 'held') save.keepUnconfirmed();
  };
  return { onInput, onCompositionStart, onCompositionEnd };
}

function isCompositionKey(event: KeyboardEvent, composing: boolean) {
  if (!composing && !event.isComposing && event.keyCode !== 229) return false;
  if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation();
  return true;
}

function inputEvents(
  input: LocalInput, save: FieldSave, { commit, flush, debounceMs, multiline, locked }: {
    commit: FieldCommit; flush: Flush; debounceMs: number; multiline?: boolean; locked: string | null;
  },
) {
  const { atFocus, halfAtFocus, notSavedAtFocus, untouched, draftRef, halfRef, halfTyped, timer, ref } = input;
  const typed = (text: string) => {
    input.setHalf(halfTyped());
    input.setDraft(text);
    untouched.current = false;
    if (save.typed(text)) timer.current = window.setTimeout(() => void flush(draftRef.current), debounceMs);
  };
  const onFocus = () => {
    const text = draftRef.current;
    atFocus.current = text;
    halfAtFocus.current = halfRef.current;
    untouched.current = true;
    const { status, reason, byItself } = save.view;
    const needsChoice = status === 'failed' || status === 'refused';
    notSavedAtFocus.current = !halfRef.current && text !== save.seen.value && needsChoice
      ? { saved: save.seen.value, status, reason, byItself } : null;
    input.setFocused(true);
  };
  const onBlur = () => {
    input.setHeld(false);
    input.setFocused(false);
    if (holdComposition(input, save)) return;
    if (halfTyped()) {
      markHalf(input, save);
      return;
    }
    if (notSavedAtFocus.current && untouched.current && draftRef.current === atFocus.current) {
      input.stopTimer(); // The person can Retry text that was already not saved on entry.
      return;
    }
    void flush(draftRef.current);
  };
  const onKeyUp = () => {
    if (halfTyped() !== halfRef.current && ref.current) typed(ref.current.value);
  };
  const onKey = (event: KeyboardEvent) => {
    if (isCompositionKey(event, input.composition.current === 'active')) return;
    if (event.key === 'Enter' && !multiline) {
      event.preventDefault();
      untouched.current = false;
      (event.currentTarget as HTMLElement).blur();
    }
    // Escape can take back a one-line edit. In a text box it goes on to close the surrounding screen.
    if (event.key !== 'Escape' || save.view.external || multiline || locked) return;
    const text = atFocus.current;
    if (draftRef.current === text && (!halfTyped() || halfAtFocus.current)) return;
    event.stopPropagation();
    event.preventDefault();
    input.stopTimer();
    input.putBack(text);
    input.setDraft(text);
    if (notSavedAtFocus.current) untouched.current = true;
    save.escape(text, notSavedAtFocus.current, commit);
  };
  return { ...compositionEvents(input, save, typed), onBlur, onFocus, onKeyUp, onKey };
}

function useFieldLifecycle({
  save, keep, read, commit, flush, onText, input, locked,
}: {
  save: FieldSave;
  keep: string | undefined;
  read: ReadField | undefined;
  commit: FieldCommit;
  flush: Flush;
  onText: EditFieldProps['onText'];
  input: LocalInput;
  locked: string | null;
}) {
  const store = useContext(StoreContext);
  const signedOut = useContext(SignedOutContext);
  const readRef = useRef(read);
  readRef.current = read;
  useLayoutEffect(() => () => {
    cancelCompositionEnd(input);
    save.unmount(commit);
  }, []);
  useLayoutEffect(() => {
    if (keep === undefined) return;
    const leave = showFieldDraft(keep);
    const stopTaking = takeHandedText(keep, (text) => save.takeHanded(text));
    return () => {
      stopTaking();
      save.offScreen();
      leave(store, readRef.current);
    };
  }, []);
  const onLeave = useRef(() => {});
  onLeave.current = () => {
    if (holdComposition(input, save)) return;
    save.keepCurrent();
    if (input.timer.current !== null) void flush(input.draftRef.current);
  };
  useLayoutEffect(() => {
    const leave = () => onLeave.current();
    leaving.add(leave);
    return () => { leaving.delete(leave); };
  }, []);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const once = () => save.reconnect(commit);
    window.addEventListener(CONNECTED, once);
    return () => window.removeEventListener(CONNECTED, once);
  }, []);

  useLayoutEffect(() => {
    if (locked) save.keepCurrent();
    if (locked && input.focusedRef.current && locked === signedOut) input.setHeld(true);
  }, [locked]);
  useLayoutEffect(() => save.lockChanged(!!locked, commit), [locked]);

  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const { draft } = input;
  const { external, status } = save.view;
  useLayoutEffect(() => onTextRef.current?.(draft, save.base, external), [draft, external, status]);
  useLayoutEffect(() => () => onTextRef.current?.('', '', false), []);
}
