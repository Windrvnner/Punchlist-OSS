// The cards an answer opens to add it as a new question or a new finding.
import { useRef, useState } from 'preact/hooks';
import { useSaveOut } from './saveOut';
import { useAppState, useStore } from './hooks';
import type { Store } from '../app/store';
import { findingHref } from './findings';
import {
  answerCardDraft, answerFindingDrafts, answerQuestionDrafts, type CardDraft, saveAnswerFinding, saveAnswerQuestion,
} from '../app/answerDrafts';
import { focusCard, closeOnEscape } from './focus';
import { workstreamChoices } from '../domain/order';
import { TEXT_MAX } from '../domain/importExport';
import { limitClass, limitTitle } from './limit';
import { dealIdOf, findingFromAnswer, type Scope } from '../app/conversations';
import type { Message } from '../app/state';
import { TITLE_MAX } from '../app/commands/findings';
import type { Finding } from '../domain/model';

/** Keep the input as typed so leaving immediately after input keeps the latest text (#51). */
function useCardDraft(drafts: Map<string, CardDraft>, answerId: string, start: CardDraft) {
  const kept = answerCardDraft(drafts, answerId, start);
  const [typed, setTyped] = useState(kept.latest);
  const now = useRef(typed);
  const change = (patch: Partial<CardDraft>) => {
    const next = { ...now.current, ...patch };
    now.current = next;
    setTyped(next);
    kept.remember(next);
  };
  return { typed, change, ...kept };
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
  const draft = useCardDraft(answerQuestionDrafts, answerId, { text: initial, ws: finding?.workstream ?? '' });
  const { text, ws: workstream } = draft.typed;
  // a question logged is let go once it lands, unless more was typed since: that stays for another Log, as Ask does.
  // The card on screen then, this one or this answer's card opened again since, closes (#771)
  const out = useSaveOut('answer-question:' + answerId, (closes: boolean) => {
    if (closes) onDone();
  });
  const busy = out.busy;
  const log = () => {
    const sent = draft.typed;
    void out.send((cancelled) => saveAnswerQuestion(store, {
      dealId, linkedFinding: finding?.id, draft, sent, cancelled,
    }));
  };
  const cancel = () => {
    out.cancel();
    draft.forget();
    onDone();
  };
  return (
    <div class="card addq" data-holds-work onKeyDown={closeOnEscape(onDone)}>
      <div class="lbl">New Question for {deal.counterparty || 'the Counterparty'}</div>
      <textarea class={`in ta${limitClass(text)}`}
        title={limitTitle(text)} id="aq-text" maxLength={TEXT_MAX} rows={3}
        aria-label="Question" ref={focusCard}
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

/** "Add as finding": a new finding from the answer, with its sources. */
export function FindingCard({ dealId, answer, onDone }: {
  dealId: string; answer: Message; onDone: () => void;
}) {
  const store = useStore();
  const state = useAppState();
  const deal = state.deals[dealId];
  const answerId = answer.id;
  const sources = answer.sources ?? [];
  const { text, preview, title: initial } = findingFromAnswer(answer);
  // the answer's first sentence starts as the title, as a real value to keep or change: shown only as a hint, it
  // looked filled in when it was not
  const draft = useCardDraft(answerFindingDrafts, answerId, { text: initial, ws: '' });
  const { text: title, ws: workstream } = draft.typed;
  // why Create is off, said on hover
  const need = !title.trim() ? 'Give the finding a title' : !workstream ? 'Choose a workstream' : null;
  // the card on screen once Create lands, this one or this answer's card opened again since, closes (#771)
  const out = useSaveOut('answer-finding:' + answerId, (closes: boolean) => {
    if (closes) onDone();
  });
  const busy = out.busy;
  const create = () => {
    const sent = draft.typed;
    void out.send(async (cancelled, onScreen) => {
      const result = await saveAnswerFinding(store, { dealId, text, sources, draft, sent, cancelled });
      if (result.kind === 'refused') {
        store.toast(result.reason, 'warn');
        return false;
      }
      if (result.editing && result.made && onScreen()) location.hash = findingHref(result.made);
      // The notice can omit Open when the new finding is already shown.
      toastCreated(store, result.made);
      return result.closes;
    });
  };
  const cancel = () => {
    out.cancel();
    draft.forget();
    onDone();
  };
  return (
    <div class="card addf" data-holds-work onKeyDown={closeOnEscape(onDone)}>
      <div class="lbl">New Finding on {deal.name}</div>
      <input class="in" id="af-title" placeholder="Title" aria-label="Title" maxLength={TITLE_MAX} ref={focusCard}
        value={title} onInput={(e) => draft.change({ text: (e.currentTarget as HTMLInputElement).value })} />
      <WorkstreamSelect id="af-ws" value={workstream} onChange={(ws) => draft.change({ ws })} />
      <p class="cbody">{preview}</p>
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
function toastCreated(store: Store, created: Finding | undefined) {
  const href = created && findingHref(created);
  // already open in Edit (#115): Open would only take the person where they are
  if (!href || location.hash === href) {
    store.toast('Finding created', 'done');
    return;
  }
  const open = () => {
    location.hash = href.slice(1);
  };
  store.toast('Finding created', 'done', { label: 'Open', run: open });
}
