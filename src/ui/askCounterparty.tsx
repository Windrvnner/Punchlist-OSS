/**
 * Ask the counterparty (linking design, sections 6 and 13): the card a linked question is typed in, and the list of the
 * questions already asked. Shared by the Checklist's open item and a finding's page.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { dealQuestions } from '../app/state';
import { TEXT_MAX } from '../domain/importExport';
import type { Finding, Question } from '../domain/model';
import { closeOnEscape, focusCard } from './focus';
import { useStore } from './hooks';
import { navigate } from './nav';

/** a question's status, as a list of asked questions says it */
export const STATUS: Record<Question['status'], string> = { open: 'open', answered: 'answered', closed: 'closed' };

/** the questions put to the counterparty about an item, or about a finding (the one it raised), oldest first */
export function askedAbout(
  s: Parameters<typeof dealQuestions>[0],
  dealId: string,
  itemId: string | null,
  f: Finding | undefined,
): Question[] {
  const aboutItem = (q: Question) => itemId !== null && q.linkedItem?.id === itemId;
  const aboutFinding = (q: Question) => !!f && q.linkedFinding === f.id;
  return dealQuestions(s, dealId).filter((q) => aboutItem(q) || aboutFinding(q)).sort((a, b) => a.n - b.n);
}

/** The questions asked, each as its number (opening it on the Q&A page), its status and its words. */
export function AskedList({ dealId, qs, id }: { dealId: string; qs: Question[]; id: string }) {
  const store = useStore();
  const everyQuestion = { status: 'all', workstream: '', text: '' } as const;
  const open = (q: Question) => navigate(store, `qa-${dealId}`, { selectedQuestion: q.id, qaFilter: everyQuestion });
  return (
    <ul class="ckasked" id={id}>
      {qs.map((q) => (
        <li key={q.id}>
          <button type="button" class="linkb" onClick={() => open(q)}>Q{q.n}</button>
          <span class="cst">{STATUS[q.status]}</span>
          <span class="cqt">{q.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** Questions still saving, by the key their text is kept under. */
const saving = new Map<string, Promise<unknown>>();

/**
 * Log question for a card whose text is kept in `drafts` under `key`. Log stays off while the save runs, also on a card
 * drawn again for the same key meanwhile (the person went to another finding and back). Once the save lands, the kept
 * text is let go (`forget`) only if it is still the text logged, so words typed since are kept; then the card on screen
 * is told (`settle`), and closes if nothing is kept.
 */
export function useLogQuestion(drafts: Map<string, string>, key: string, forget: () => void, settle: () => void) {
  const [busy, setBusy] = useState(() => saving.has(key));
  const shown = useRef(true);
  const landed = () => {
    if (!shown.current) return;
    setBusy(false);
    settle();
  };
  // a card drawn while its question is still saving hears when it lands, or finds it landed already
  useEffect(() => {
    const pending = saving.get(key);
    if (pending) void pending.then(landed);
    else if (busy) landed();
    return () => {
      shown.current = false;
    };
  }, []);
  const log = async (text: string, send: () => Promise<{ ok: boolean }>) => {
    setBusy(true);
    const pending = send();
    saving.set(key, pending);
    const res = await pending;
    saving.delete(key);
    if (res.ok && drafts.get(key)?.trim() === text) forget();
    landed();
  };
  return { busy, log };
}

/** What the card shows and does; `ids` prefixes its fields' ids (`ck-ask` gives ck-ask-text, ck-ask-log and so on). */
export interface AskCardProps {
  ids: string;
  cls: string;
  counterparty: string;
  /** what the question will be linked to, named on the card */
  linked: string;
  text: string;
  onText: (v: string) => void;
  /** why Log question is off just now, said on hover and read out with it */
  why: string | null;
  busy: boolean;
  onLog: () => void;
  onCancel: () => void;
  /** Escape: sets the card aside, keeping its text, where the page can bring it back */
  onEscape: () => void;
}

/** The card a question for the counterparty is typed in, as on a conversation's Add as question card. */
export function AskCard(p: AskCardProps) {
  const type = (e: Event) => p.onText((e.currentTarget as HTMLTextAreaElement).value);
  const why = p.why ?? undefined;
  return (
    <div class={`card addq ${p.cls}`} onKeyDown={closeOnEscape(p.onEscape)}>
      <div class="lbl">New Question for {p.counterparty || 'the Counterparty'}</div>
      <textarea class="in ta" id={`${p.ids}-text`} maxLength={TEXT_MAX} rows={3} aria-label="Question" ref={focusCard}
        value={p.text} onInput={type} />
      <span class="clink">Linked to “{p.linked}”</span>
      <div class="cacts">
        <span class="needs" title={why}>
          <button type="button" class="btn sm pri" id={`${p.ids}-log`} disabled={p.busy || !p.text.trim() || !!p.why}
            title={why} aria-description={why} onClick={p.onLog}>Log Question</button>
        </span>
        <button type="button" class="btn sm" id={`${p.ids}-cancel`} onClick={p.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
