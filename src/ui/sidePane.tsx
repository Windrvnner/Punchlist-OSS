/**
 * The side pane: a finding named in an answer opens beside the conversation instead of replacing it.
 * It is glass on the right of the page, top and bottom on the rail's; the conversation keeps its left edge and gives up
 * width on the right (ui.css). Escape or the close button puts it away; "Open finding page" goes to the finding's page.
 * A suggested open question opens here too, to be checked before an answer becomes its response.
 */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, lastInput, fmtDate } from './hooks';
import { Icon } from './icons';
import { FindingOpening, findingHref } from './findings';
import { STATUS_LABEL } from './qa';
import { navigate } from './nav';
import { answerText, useAnswer } from '../app/conversations';
import type { Message } from '../app/state';
import type { Question, Source } from '../domain/model';

/** `thread`: the conversation beside it, where the answer a suggested question was offered for is */
export function SidePane({ onOpen, thread }: { onOpen: (s: Source) => void; thread: Message[] }) {
  const store = useStore(); const s = useAppState(); const side = s.ui.side;
  const pane = useRef<HTMLElement>(null);
  // opened from the keyboard, the focus goes into the pane; when it closes, back to what opened it, if that is still there
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { if (side && lastInput.kind === 'key') { opener.current = document.activeElement as HTMLElement | null; pane.current?.focus({ preventScroll: true }); } }, [side?.kind, side?.id]);
  useLayoutEffect(() => () => { const el = opener.current; requestAnimationFrame(() => { if (el?.isConnected && (!document.activeElement || document.activeElement === document.body)) el.focus({ preventScroll: true }); }); }, []);
  if (!side) return null;
  const close = () => store.ui({ side: null });
  if (side.kind === 'question') {
    const q = s.questions[side.id]; const answer = thread.find((m) => m.id === side.answer && m.state === 'done');
    return (
      <aside class="sidepane glass" id="sidepane" aria-label="Question" tabIndex={-1} ref={pane}>
        <div class="sphead"><span class="t">Question</span><span class="grow" />
          {q && <button type="button" class="btn sm" id="side-page" onClick={() => navigate(store, `qa-${q.dealId}`, { selectedQuestion: q.id, qaFilter: { status: 'all', workstream: '', text: '' } })}>Open in Q&amp;A</button>}
          <button type="button" class="btn sm ico" id="side-close" aria-label="Close" title="Close" onClick={close}><Icon name="close" size={14} /></button></div>
        <div class="spbody">{q && answer ? <QuestionCheck key={q.id + answer.id} q={q} answer={answer} close={close} /> : <p class="emptyline">That question is no longer here.</p>}</div>
      </aside>
    );
  }
  const f = s.findings[side.id];
  return (
    <aside class="sidepane glass" id="sidepane" aria-label="Finding" tabIndex={-1} ref={pane}>
      <div class="sphead"><span class="t">Finding</span><span class="grow" />
        {f && <a class="btn sm" id="side-page" href={findingHref(f)}>Open Finding Page</a>}
        <button type="button" class="btn sm ico" id="side-close" aria-label="Close" title="Close" onClick={close}><Icon name="close" size={14} /></button></div>
      <div class="spbody">{f ? <FindingOpening dealId={f.dealId} findingId={side.id} onOpen={onOpen} pane /> : <p class="emptyline">That finding is no longer here.</p>}</div>
    </aside>
  );
}

/**
 * A suggested open question, to check before an answer becomes its response: the question in full, its details, its
 * response now and the answer that would take its place. Nothing changes until a person chooses Use as response
 * (asked again first when that would replace a response); "Not this one" puts the suggestion away. Once used, the pane
 * stays open and shows the question with its new response; undone, it is back to the check.
 */
function QuestionCheck({ q, answer, close }: { q: Question; answer: Message; close: () => void }) {
  const store = useStore(); const [replace, setReplace] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // the button pressed goes once the answer is the response: the focus stays in the pane, on what it now says
  const use = async () => { const r = await useAnswer(store, q.dealId, q.id, answer); setReplace(false); if (r.ok) requestAnimationFrame(() => { const a = document.activeElement; if (!a || a === document.body || box.current?.closest('#sidepane')?.contains(a)) box.current?.querySelector<HTMLElement>('#side-used')?.focus({ preventScroll: true }); }); };
  const notThis = () => { store.putAway(answer.id, q.id); close(); };
  // read from the question itself, so an Undo puts the check back
  const used = !!q.response.trim() && q.response.trim() === answerText(answer).trim();
  if (used) return (
    <div class="qcheck" ref={box}>
      <div class="qmeta"><b>Q{q.n}</b><span class="st">{STATUS_LABEL[q.status]}</span>{[q.workstream, q.priority, q.askedBy].filter(Boolean).map((x) => <span key={x}>{x}</span>)}</div>
      {q.received && <p class="qrec">Received {fmtDate(q.received)}</p>}
      <p class="qfull" id="side-q">{q.text}</p>
      <p class="qused" id="side-used" tabIndex={-1} role="status"><Icon name="check" size={14} />This answer is now its response</p>
      <div class="plbl">Response</div>
      <p class="qresp" id="side-now">{q.response}</p>
    </div>
  );
  return (
    <div class="qcheck" ref={box}>
      <div class="qmeta"><b>Q{q.n}</b><span class="st">{STATUS_LABEL[q.status]}</span>{[q.workstream, q.priority, q.askedBy].filter(Boolean).map((x) => <span key={x}>{x}</span>)}</div>
      {q.received && <p class="qrec">Received {fmtDate(q.received)}</p>}
      <p class="qfull" id="side-q">{q.text}</p>
      <div class="plbl">Current Response</div>
      {q.response.trim() ? <p class="qresp" id="side-now">{q.response}</p> : <p class="qnone" id="side-now">None yet</p>}
      <div class="plbl">Would Become the Response</div>
      <p class="qprop" id="side-new">{answerText(answer)}</p>
      {replace ? <div class="card confirm" role="alertdialog" aria-label="Replace the response" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setReplace(false); } }}>
        <p>Q{q.n} already has a response. Replace it with this answer?</p>
        <div class="cacts"><button type="button" class="btn sm pri" id="side-replace"
          ref={(el) => { if (el && !el.dataset.f) { el.dataset.f = '1'; el.focus(); } }}
          onClick={() => void use()}>Replace</button><button type="button" class="btn sm" id="side-keep"
          onClick={() => setReplace(false)}>Keep the Current Response</button></div>
      </div>
      : <div class="pacts"><button type="button" class="btn sm pri" id="side-use"
        onClick={() => { if (q.response.trim()) setReplace(true); else void use(); }}>Use as Response</button><button
        type="button" class="btn sm" id="side-not" onClick={notThis}>Not This One</button></div>}
    </div>
  );
}
