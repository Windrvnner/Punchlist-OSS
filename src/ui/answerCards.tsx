// The cards an answer opens to add it as a new question or a new finding.
import { useState } from 'preact/hooks';
import { useAppState, useStore } from './hooks';
import type { Store } from '../app/store';
import { findingHref } from './findings';
import { focusCard, closeOnEscape } from './focus';
import { workstreamChoices } from '../domain/order';
import { TEXT_MAX } from '../domain/importExport';
import { dealIdOf, type Scope } from '../app/conversations';
import { toParagraphs, withoutMarkers } from '../domain/cite';
import { CreateQuestion } from '../app/commands/questions';
import { CreateFinding, TITLE_MAX } from '../app/commands/findings';
import { dealFindings } from '../app/state';
import type { Source } from '../domain/model';

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
export function QuestionCard({ scope, initial, onDone }: { scope: Scope; initial: string; onDone: () => void }) {
  const store = useStore();
  const state = useAppState();
  const dealId = dealIdOf(scope) as string;
  const deal = state.deals[dealId];
  const finding = scope.kind === 'finding' ? state.findings[scope.findingId] : null;
  const [text, setText] = useState(initial);
  const [workstream, setWorkstream] = useState(finding?.workstream ?? '');
  const [busy, setBusy] = useState(false);
  const log = async () => {
    if (busy) return;
    setBusy(true);
    const question = { dealId, text: text.trim(), workstream, linkedFinding: finding?.id };
    const result = await store.dispatch(CreateQuestion, question, { idempotencyKey: 'card-q-' + dealId });
    setBusy(false);
    if (result.ok) onDone();
  };
  return (
    <div class="card addq" onKeyDown={closeOnEscape(onDone)}>
      <div class="lbl">New Question for {deal.counterparty || 'the Counterparty'}</div>
      <textarea class="in ta" id="aq-text" maxLength={TEXT_MAX} rows={3} aria-label="Question" ref={focusCard}
        value={text} onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} />
      <WorkstreamSelect id="aq-ws" value={workstream} onChange={setWorkstream} />
      {finding && <span class="clink">Linked to “{finding.title}”</span>}
      <div class="cacts">
        <button type="button" class="btn sm pri" id="aq-log" disabled={busy || !text.trim()} onClick={() => void log()}>
          Log Question
        </button>
        <button type="button" class="btn sm" onClick={onDone}>Cancel</button>
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
export function FindingCard({ dealId, text, sources, onDone }: {
  dealId: string; text: string; sources: Source[]; onDone: () => void;
}) {
  const store = useStore();
  const state = useAppState();
  const deal = state.deals[dealId];
  // the answer's first sentence starts as the title, as a real value to keep or change: shown only as a hint, it
  // looked filled in when it was not
  const plainText = withoutMarkers(text, sources.length);
  const [title, setTitle] = useState(firstSentence(plainText));
  const [workstream, setWorkstream] = useState('');
  const [busy, setBusy] = useState(false);
  // why Create is off, said on hover
  const need = !title.trim() ? 'Give the finding a title' : !workstream ? 'Choose a workstream' : null;
  const create = async () => {
    if (busy) return;
    setBusy(true);
    const body = toParagraphs(text);
    const finding = { dealId, title: title.trim(), workstream, body, sources, origin: 'chat' as const };
    const result = await store.dispatch(CreateFinding, finding, { idempotencyKey: 'card-f-' + dealId, quiet: true });
    setBusy(false);
    if (result.ok) {
      onDone();
      toastCreated(store, dealId, title.trim());
    } else store.toast(result.error.message);
  };
  return (
    <div class="card addf" onKeyDown={closeOnEscape(onDone)}>
      <div class="lbl">New Finding on {deal.name}</div>
      <input class="in" id="af-title" placeholder="Title" aria-label="Title" maxLength={TITLE_MAX} ref={focusCard}
        value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
      <WorkstreamSelect id="af-ws" value={workstream} onChange={setWorkstream} />
      <p class="cbody">{plainText}</p>
      {sources.length > 0 && <div class="csrc">{sources.map((source, i) => (
        <span class="ref" key={i}><span class="rb">{source.doc}{source.loc ? ` · ${source.loc}` : ''}</span></span>
      ))}</div>}
      <div class="cacts">
        <span class="needs" id="af-need" title={need ?? undefined}>
          <button type="button" class="btn sm pri" id="af-create" disabled={busy || !!need}
            aria-description={need ?? undefined} onClick={() => void create()}>Create Finding</button>
        </span>
        <button type="button" class="btn sm" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

/** "Finding created", with a way to open it. */
function toastCreated(store: Store, dealId: string, title: string) {
  const created = dealFindings(store.get(), dealId).find((finding) => finding.title === title);
  const open = () => {
    location.hash = findingHref(created!).slice(1);
  };
  store.toast('Finding created', created ? { label: 'Open', run: open } : undefined);
}
