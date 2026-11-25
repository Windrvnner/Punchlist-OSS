/**
 * Ask the counterparty (linking design, sections 6 and 13): the card a linked question is typed in, and the list of the
 * questions already asked. Shared by the Checklist's open item and a finding's page.
 */
import { logQuestionDraft, questionDraftAt, questionLogKey } from '../app/logQuestionDraft';
import { TEXT_MAX } from '../domain/importExport';
import { limitClass, limitTitle } from './limit';
import type { Question } from '../domain/model';
import { closeOnEscape, focusCard } from './focus';
import { useStore } from './hooks';
import { moveKey } from '../app/keptText';
import { navigate } from './nav';
import { pendingSaveKeys } from '../app/saveOut';
import { useSaveOut } from './saveOut';

/** a question's status, as a list of asked questions says it */
export const STATUS: Record<Question['status'], string> = { open: 'open', answered: 'answered', closed: 'closed' };

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

/**
 * Log question for a card whose text is kept in `drafts` under `key`. Log stays off while the save runs, also on a card
 * drawn again for the same key meanwhile (the person went to another finding and back). Once the save lands, the kept
 * text is let go (`forget`) only if it is still the text logged, so words typed since are kept; then the card on screen
 * is told (`settle`), and closes if nothing is kept. Cancel leaves any card opened since for the same key alone (#843).
 */
export function useLogQuestion(
  drafts: Map<string, string>, key: string, forget: (currentKey: string) => void, settle: () => void,
  captureTarget?: () => () => boolean,
) {
  const saveKey = questionLogKey(key, pendingSaveKeys(), moveKey);
  const out = useSaveOut(saveKey, (current: boolean) => {
    if (current) settle();
  });
  const draft = questionDraftAt(key, moveKey, drafts, forget);
  const log = (text: string, dispatch: () => Promise<{ ok: boolean }>) =>
    out.send((cancelled) => logQuestionDraft(text, draft, dispatch, cancelled, captureTarget?.()));
  const cancel = () => {
    out.cancel();
    draft.forget();
    settle();
  };
  return { busy: out.busy, log, cancel };
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
      <textarea class={`in ta${limitClass(p.text)}`}
        title={limitTitle(p.text)} id={`${p.ids}-text`} maxLength={TEXT_MAX}
        rows={3} aria-label="Question" ref={focusCard}
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
