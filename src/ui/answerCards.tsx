// The cards an answer opens to add it as a new question or a new finding.
import { useEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import type { Store } from '../app/store';
import { createdFinding, findingHref, keepAsEdit } from './findings';
import { hasTexts, keptDrafts } from './keptDrafts';
import { focusCard, closeOnEscape } from './focus';
import { workstreamChoices } from '../domain/order';
import { TEXT_MAX } from '../domain/importExport';
import { dealIdOf, type Scope } from '../app/conversations';
import { toParagraphs, withoutMarkers } from '../domain/cite';
import { CreateQuestion } from '../app/commands/questions';
import { CreateFinding, TITLE_MAX } from '../app/commands/findings';
import { dealFindings } from '../app/state';
import type { Finding, Source } from '../domain/model';

/** What a card holds as typed: the question or the finding's title, and its workstream. */
type CardDraft = { text: string; ws: string };
/** "Add as question" and "Add as finding" cards half typed, per answer: kept on Escape, leaving and a restart */
const questionDrafts = keptDrafts('answer-question', hasTexts('text', 'ws'));
const findingDrafts = keptDrafts('answer-finding', hasTexts('text', 'ws'));

/**
 * A card's text and workstream, kept per answer as they are typed (#51): Escape and leaving keep them; Cancel, or a
 * save that lands with nothing typed since, clears them. Back at what the answer proposed, nothing is kept.
 */
function useCardDraft(drafts: Map<string, CardDraft>, answerId: string, start: CardDraft) {
  const [typed, setTyped] = useState(() => drafts.get(answerId) ?? start);
  // as typed, not as last drawn, so leaving straight after typing keeps it
  const now = useRef(typed);
  const change = (patch: Partial<CardDraft>) => {
    const next = { ...now.current, ...patch };
    now.current = next;
    setTyped(next);
    if (next.text === start.text && next.ws === start.ws) drafts.delete(answerId);
    else drafts.set(answerId, next);
  };
  const forget = () => drafts.delete(answerId);
  // Cancel lets the draft go, and a save still out then leaves alone a card opened again since
  const cancelled = useRef(false);
  const cancel = () => {
    cancelled.current = true;
    forget();
  };
  /** after a save of `sent` lands: whether nothing was typed since, and then the draft is let go */
  const landed = (sent: CardDraft) => {
    if (cancelled.current) return false;
    const same = now.current.text === sent.text && now.current.ws === sent.ws;
    if (same) forget();
    return same;
  };
  return { typed, change, forget, cancel, cancelled, landed, now };
}

/** The workstream a new question or finding goes in, chosen from the firm's list. */
function WorkstreamSelect({ id, value, onChange }: {
  id: string; value: string; onChange: (workstream: string) => void;
}) {
  return (
    <select class={`field ${value ? '' : 'unset'}`} id={id} aria-label="Workstream" value={value}
      onChange={(e) => onChange((e.currentTarget as HTMLSelectElement).value)}>
      <option value="">Workstream</option>
      {workstreamChoices().map((workstream) => <option key={workstream} value={workstream}>{workstream}</option>)}
    </select>
  );
}

/** "Add as question": a new question for the counterparty, from the answer (or, under a finding, linked to it). */
export function QuestionCard({ scope, answerId, initial, onDone }: {
  scope: Scope; answerId: string; initial: string; onDone: () => void;
}) {
  const store = useStore();
  const state = useAppState();
  const dealId = dealIdOf(scope) as string;
  const deal = state.deals[dealId];
  const finding = scope.kind === 'finding' ? state.findings[scope.findingId] : null;
  const draft = useCardDraft(questionDrafts, answerId, { text: initial, ws: finding?.workstream ?? '' });
  const { text, ws: workstream } = draft.typed;
  const [busy, setBusy] = useState(false);
  // a question logged is let go once it lands, unless more was typed since: that stays for another Log, as Ask does
  const log = async () => {
    if (busy) return;
    setBusy(true);
    const sent = draft.typed;
    const question = { dealId, text: text.trim(), workstream, linkedFinding: finding?.id };
    const result = await store.dispatch(CreateQuestion, question, { idempotencyKey: 'card-q-' + dealId });
    setBusy(false);
    if (result.ok && draft.landed(sent)) onDone();
  };
  const cancel = () => {
    draft.cancel();
    onDone();
  };
  return (
    <div class="card addq" data-holds-work onKeyDown={closeOnEscape(onDone)}>
      <div class="lbl">New Question for {deal.counterparty || 'the Counterparty'}</div>
      <textarea class="in ta" id="aq-text" maxLength={TEXT_MAX} rows={3} aria-label="Question" ref={focusCard}
        value={text} onInput={(e) => draft.change({ text: (e.currentTarget as HTMLTextAreaElement).value })} />
      <WorkstreamSelect id="aq-ws" value={workstream} onChange={(ws) => draft.change({ ws })} />
      {finding && <span class="clink">Linked to “{finding.title}”</span>}
      <div class="cacts">
        <button type="button" class="btn sm pri" id="aq-log" disabled={busy || !text.trim()} onClick={() => void log()}>
          Log Question
        </button>
        <button type="button" class="btn sm" onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}

/** The answer's first sentence, as a title: without the sentence's period, and 140 characters at most. */
function firstSentence(text: string) {
  const sentence = /^[^.!?]*[.!?]/.exec(text)?.[0] ?? text;
  return sentence.trim().replace(/[.!?]$/, '').slice(0, 140);
}

/** "Add as finding": a new finding from the answer, with its sources. */
export function FindingCard({ dealId, answerId, text, sources, onDone }: {
  dealId: string; answerId: string; text: string; sources: Source[]; onDone: () => void;
}) {
  const store = useStore();
  const state = useAppState();
  const deal = state.deals[dealId];
  // the answer's first sentence starts as the title, as a real value to keep or change: shown only as a hint, it
  // looked filled in when it was not
  const plainText = withoutMarkers(text, sources.length);
  const draft = useCardDraft(findingDrafts, answerId, { text: firstSentence(plainText), ws: '' });
  const { text: title, ws: workstream } = draft.typed;
  const [busy, setBusy] = useState(false);
  const shown = useRef(true);
  useEffect(() => () => {
    shown.current = false;
  }, []);
  // why Create is off, said on hover
  const need = !title.trim() ? 'Give the finding a title' : !workstream ? 'Choose a workstream' : null;
  const create = async () => {
    if (busy) return;
    setBusy(true);
    const sent = draft.typed;
    const body = toParagraphs(text);
    const finding = { dealId, title: title.trim(), workstream, body, sources, origin: 'chat' as const };
    const result = await store.dispatch(CreateFinding, finding, { idempotencyKey: 'card-f-' + dealId, quiet: true });
    setBusy(false);
    if (!result.ok) {
      store.toast(result.error.message);
      return;
    }
    // cancelled while it was out: the finding is made all the same, and said so; a card opened since stays open
    if (!draft.cancelled.current) {
      if (!draft.landed(sent) && !editMade(createdFinding(store, result.value.opId), finding)) return;
      onDone();
    }
    toastCreated(store, dealId, finding.title);
  };
  // #115's decision for this card too: what was typed since Create was sent becomes an open edit of the finding made,
  // and its page opens in Edit while the card is still in sight. A finding that cannot be found leaves the card open
  // with the typing
  const editMade = (made: Finding | undefined, sent: { title: string; workstream: string; body: string[] }) => {
    if (!made) return false;
    const typed = { title: draft.now.current.text, ws: draft.now.current.ws, body: made.body.join('\n\n') };
    keepAsEdit(made, typed, { title: sent.title, workstream: sent.workstream, body: sent.body });
    draft.forget();
    if (shown.current) location.hash = findingHref(made);
    return true;
  };
  const cancel = () => {
    draft.cancel();
    onDone();
  };
  return (
    <div class="card addf" data-holds-work onKeyDown={closeOnEscape(onDone)}>
      <div class="lbl">New Finding on {deal.name}</div>
      <input class="in" id="af-title" placeholder="Title" aria-label="Title" maxLength={TITLE_MAX} ref={focusCard}
        value={title} onInput={(e) => draft.change({ text: (e.currentTarget as HTMLInputElement).value })} />
      <WorkstreamSelect id="af-ws" value={workstream} onChange={(ws) => draft.change({ ws })} />
      <p class="cbody">{plainText}</p>
      {sources.length > 0 && <div class="csrc">{sources.map((source, i) => (
        <span class="ref" key={i}><span class="rb">{source.doc}{source.loc ? ` · ${source.loc}` : ''}</span></span>
      ))}</div>}
      <div class="cacts">
        <span class="needs" id="af-need" title={need ?? undefined}>
          <button type="button" class="btn sm pri" id="af-create" disabled={busy || !!need}
            aria-description={need ?? undefined} onClick={() => void create()}>Create Finding</button>
        </span>
        <button type="button" class="btn sm" onClick={cancel}>Cancel</button>
      </div>
    </div>
  );
}

/** "Finding created", with a way to open it. */
function toastCreated(store: Store, dealId: string, title: string) {
  const created = dealFindings(store.get(), dealId).find((finding) => finding.title === title);
  // already open in Edit (#115): Open would only take the person where they are
  if (created && location.hash === findingHref(created)) {
    store.toast('Finding created');
    return;
  }
  const open = () => {
    location.hash = findingHref(created!).slice(1);
  };
  store.toast('Finding created', created ? { label: 'Open', run: open } : undefined);
}
