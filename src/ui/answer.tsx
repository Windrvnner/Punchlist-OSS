// An answer in a conversation, the actions under it, the suggested question under it, and using it as a question's
// response.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, lastInput } from './hooks';
import type { Store } from '../app/store';
import { Icon } from './icons';
import { AI_LABEL } from '../control';
import { showTip, hideTip } from './tip';
import { Brief, Cited } from './findings';
import { ResearchView } from './research';
import { closeOnEscape, focusOnce, focusOnceInPlace } from './focus';
import {
  answerQuestionChoices, answerText, askVerdict, dealIdOf, questionFromAnswer, responseToReplace, useAnswer,
  withoutFindingLinks, type Scope,
} from '../app/conversations';
import { splitCited } from '../domain/cite';
import type { Message, State } from '../app/state';
import type { Deal, Question, Source } from '../domain/model';
import { QuestionCard, FindingCard } from './answerCards';

type Verdict = State['ui']['verdicts'][string];

/** What putting an answer in as a question's response needs to know. */
type UseOptions = {
  store: Store; scope: Scope; answer: Message;
  /** what had the focus, which it goes back to when a card or the Replace prompt closes */
  from: { current: HTMLElement | null };
  /** closes the "Use as response to a question…" list, when that is what is open */
  closeUseCard: () => void;
  /** closes that list at once, when a question picked from it needs the Replace prompt */
  closeList: () => void;
};

/**
 * Putting an answer in as a question's response: replacing a response that is already there is asked first (the
 * Replace prompt, for the question in `replace`); filling an empty one is not.
 */
function useUseAsResponse({ store, scope, answer, from, closeUseCard, closeList }: UseOptions) {
  const [replace, setReplace] = useState<{ questionId: string; response: string } | null>(null);
  const useOn = (questionId: string, over: string | null = null) =>
    useAnswer(store, dealIdOf(scope) as string, questionId, answer, over);
  // Picked from the list, the list gives way to the Replace prompt, and the focus goes back to the button that opened
  // the list.
  const askUse = (questionId: string, picked = false) => {
    const response = responseToReplace(store.get().questions[questionId]);
    if (response === null) {
      void useOn(questionId).then(closeUseCard);
      return;
    }
    if (picked) closeList();
    else from.current = document.activeElement as HTMLElement | null;
    setReplace({ questionId, response });
  };
  return { replace, setReplace, useOn, askUse };
}

/**
 * An answer in a conversation. `asked`: what was asked, which a document opened from the answer is searched for, and
 * which an "Add as question" card starts from. `suggest`: an open question this answer may address, named in a card
 * under it for a person to check (or ask the model about) and use, or not.
 */
export function Answer({ scope, message: answer, asked, onOpen, suggest }: {
  scope: Scope; message: Message; asked: string; onOpen: (s: Source, ask?: string) => void; suggest?: string;
}) {
  const store = useStore();
  const state = useAppState();
  const deal = scope.kind === 'all' ? null : state.deals[scope.dealId];
  const [card, setCard] = useState<null | 'q' | 'f' | 'use'>(null);
  // a card or the Replace prompt, opened from a button (or a question picked from the list), gives the focus back to
  // it when it closes
  const from = useRef<HTMLElement | null>(null);
  const focusBack = () => requestAnimationFrame(() => {
    const nothingFocused = !document.activeElement || document.activeElement === document.body;
    if (from.current?.isConnected && nothingFocused) from.current.focus();
  });
  const closeCard = () => {
    setCard(null);
    focusBack();
  };
  const suggested = suggest && deal ? state.questions[suggest] : null;
  const plain = withoutFindingLinks(answer.text);
  // An answer is cited the way a finding is: [n] after a sentence points at the nth source. Without markers the whole
  // answer rests on all its sources. Text that leaves as a response or a question goes without the markers.
  const sourceCount = answer.sources?.length ?? 0;
  const marked = sourceCount > 0 && splitCited(plain, sourceCount).some((part) => part.refs.length > 0);
  const clean = answerText(answer);
  const closeUseCard = () => {
    if (card === 'use') closeCard();
  };
  const use = useUseAsResponse({ store, scope, answer, from, closeUseCard, closeList: () => setCard(null) });
  const closeReplace = () => {
    use.setReplace(null);
    focusBack();
  };
  const replaceIt = () => {
    if (!use.replace) return;
    const { questionId, response } = use.replace;
    closeReplace();
    void use.useOn(questionId, response).then(closeUseCard);
  };
  const openCard = (opener: HTMLElement, which: 'q' | 'f' | 'use') => {
    from.current = opener;
    setCard(which);
  };
  const openFromAnswer = (src: Source) => onOpen(src, asked);
  const replacing = use.replace ? state.questions[use.replace.questionId] : undefined;
  return (
    <div class="ai">
      {answer.research && <ResearchView research={answer.research} sources={answer.sources} dealId={dealIdOf(scope)}
        onOpen={openFromAnswer} />}
      <AnswerText answer={answer} plain={plain} marked={marked} deal={deal} onOpen={openFromAnswer} />
      <AnswerActs scope={scope} hasDeal={!!deal} clean={clean} openCard={openCard} askUse={use.askUse} />
      {card === 'use' && deal && <UsePicker id={answer.id} deal={deal}
        onPick={(questionId) => use.askUse(questionId, true)} onClose={closeCard} />}
      {suggested && deal && <SuggestedQuestion question={suggested} dealId={deal.id} answer={answer}
        verdict={state.ui.verdicts[`${answer.id}|${suggested.id}`]} askUse={use.askUse} />}
      {replacing && <ReplacePrompt question={replacing} onReplace={replaceIt} onKeep={closeReplace} />}
      {card === 'q' && deal && <QuestionCard scope={scope} answerId={answer.id}
        initial={questionFromAnswer(scope, answer, asked)} onDone={closeCard} />}
      {card === 'f' && deal && <FindingCard dealId={deal.id} answer={answer} onDone={closeCard} />}
    </div>
  );
}

/**
 * What the answer says: cited sentence by sentence when it has sources (`marked`: it has markers to cite them by);
 * else, in a deal, with its findings named as links that open them beside the conversation.
 */
function AnswerText({ answer, plain, marked, deal, onOpen }: {
  answer: Message; plain: string; marked: boolean; deal: Deal | null | undefined; onOpen: (src: Source) => void;
}) {
  const store = useStore();
  const state = useAppState();
  if (answer.sources?.length) return <Cited text={plain} sources={answer.sources} whole={!marked} onOpen={onOpen} />;
  if (!deal) return <p>{plain}</p>;
  const sideFinding = state.ui.side?.kind === 'finding' ? state.ui.side.id : undefined;
  return (
    <Brief paragraphs={[answer.text]} deal={deal} marked={sideFinding}
      onFinding={(finding) => store.ui({ side: { kind: 'finding', id: finding.id } })} />
  );
}

/** The actions under an answer; which there are depends on what the conversation is about. */
function AnswerActs({ scope, hasDeal, clean, openCard, askUse }: {
  scope: Scope; hasDeal: boolean; clean: string; openCard: (opener: HTMLElement, which: 'q' | 'f' | 'use') => void;
  askUse: (questionId: string) => void;
}) {
  const store = useStore();
  const copy = () => {
    void navigator.clipboard?.writeText(clean);
    store.toast('Copied');
  };
  const canAdd = hasDeal && (scope.kind === 'deal' || scope.kind === 'finding');
  return (
    <div class="acts">
      <Act icon="copy" name="Copy" run={copy} />
      {canAdd && <Act icon="addq" name="Add as question" run={(button) => openCard(button, 'q')} />}
      {canAdd && <Act icon="addf" name="Add as finding" run={(button) => openCard(button, 'f')} />}
      {scope.kind === 'question' && <Act icon="use" name="Use as response" run={() => askUse(scope.questionId)} />}
      {scope.kind === 'deal' && <Act icon="use" name="Use as response to a question…"
        run={(button) => openCard(button, 'use')} />}
    </div>
  );
}

/** The result line of Check, by verdict. */
const VERDICT_SAID = { yes: 'Answers it.', partly: 'Partly answers it.', no: 'Doesn’t answer it.' } as const;

/** What the card says after a person pressed Check: whether the answer addresses the question. */
function verdictText(verdict: Verdict) {
  if (verdict === 'asking') return 'Checking…';
  if (verdict === 'failed') return 'Couldn’t check.';
  return <><b><span class="aim">{AI_LABEL}</span>{' '}{VERDICT_SAID[verdict.verdict]}</b> {verdict.why}</>;
}

/** The label of the card's Check button: Retry after a failure, Check Again once there is a result. */
function checkLabel(verdict: Verdict | undefined) {
  if (verdict === 'failed') return 'Retry';
  return verdict ? 'Check Again' : 'Check';
}

/**
 * The card under an answer that names an open question it may address: the question opens beside the conversation
 * to check, Check asks whether the answer addresses it, and the answer can be used as its response or the suggestion
 * put away. The buttons sit together at the bottom right.
 * `verdict`: the result of Check, when a person pressed it.
 */
function SuggestedQuestion({ question, dealId, answer, verdict, askUse }: {
  question: Question; dealId: string; answer: Message; verdict: Verdict | undefined;
  askUse: (questionId: string) => void;
}) {
  const store = useStore();
  const state = useAppState();
  // the suggested question is open in the side pane, for this answer
  const beside = state.ui.side?.kind === 'question' && state.ui.side.answer === answer.id;
  const check = () => {
    if (verdict !== 'asking') void askVerdict(store, dealId, question.id, answer);
  };
  const putAway = () => {
    store.putAway(answer.id, question.id);
    if (beside) store.ui({ side: null });
  };
  const checkBeside = () => store.ui({ side: { kind: 'question', id: question.id, answer: answer.id } });
  return (
    <div class={`suggest ${beside ? 'on' : ''}`} role="group" aria-label="Suggested open question">
      <div class="lead">This may address an open question</div>
      <button type="button" class="sq" onClick={checkBeside}
        aria-label={`Q${question.n}: ${question.text}. Check it beside the conversation`}>
        <b>Q{question.n}</b><span>{question.text}</span>
      </button>
      {verdict && <p class="verdict" role="status">{verdictText(verdict)}</p>}
      <div class="row">
        {/* while it checks, the button is off but keeps the focus (aria-disabled, not disabled) */}
        {state.can.addresses && <button type="button" class="btn sm ask"
          title={`Check whether this answers Q${question.n}`}
          aria-disabled={verdict === 'asking' ? true : undefined} onClick={check}>
          {checkLabel(verdict)}
        </button>}
        <button type="button" class="btn sm" onClick={() => askUse(question.id)}>Use as Response</button>
        <button type="button" class="ib sm" aria-label="Not this one" title="Not this one" onClick={putAway}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}

/** Asked before an answer replaces a question's response that is already there. */
function ReplacePrompt({ question, onReplace, onKeep }: {
  question: Question; onReplace: () => void; onKeep: () => void;
}) {
  return (
    <div class="card confirm" role="alertdialog" aria-label="Replace the response" onKeyDown={closeOnEscape(onKeep)}>
      <p>Q{question.n} already has a response. Replace it with this answer?</p>
      <div class="cacts">
        <button type="button" class="btn sm pri" id="use-replace" ref={focusOnce} onClick={onReplace}>Replace</button>
        <button type="button" class="btn sm" id="use-keep" onClick={onKeep}>Keep the Current Response</button>
      </div>
    </div>
  );
}

/** An action under an answer: an icon, with its name on hover and focus and for screen readers. */
function Act({ icon, name, run }: { icon: string; name: string; run: (button: HTMLElement) => void }) {
  const tip = (e: Event, delay?: number) => showTip(e.currentTarget as HTMLElement, name, delay);
  const off = (e: Event) => hideTip(e.currentTarget as HTMLElement);
  const focusTip = (e: Event) => {
    if (lastInput.kind === 'key') tip(e, 0);
  };
  return (
    <button type="button" class="ib" aria-label={name} onClick={(e) => run(e.currentTarget as HTMLElement)}
      onMouseEnter={(e) => tip(e)} onMouseLeave={off} onFocus={focusTip} onBlur={off}>
      <Icon name={icon} size={15} />
    </button>
  );
}

/**
 * Opened under the last answer, the list would be behind the composer: the conversation scrolls it up into view, its
 * top kept in sight.
 */
function scrollIntoChat(card: HTMLElement) {
  const chat = card.closest<HTMLElement>('.chat');
  if (!chat) return;
  const cardBox = card.getBoundingClientRect();
  const chatBox = chat.getBoundingClientRect();
  const floor = (document.getElementById('pcomposer')?.getBoundingClientRect().top ?? chatBox.bottom) - 12;
  const over = Math.min(cardBox.bottom - floor, cardBox.top - chatBox.top - 12);
  if (over > 0) chat.scrollTop += over;
}

/** The active row stays in view; only the list scrolls, never the conversation under it. */
function keepActiveInView(list: HTMLElement) {
  const row = list.querySelector<HTMLElement>('[aria-selected="true"]');
  if (!row) return;
  if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
  }
}

/** What the list says beside a question: whether it has a response and, under All, a status other than Open */
function tagOf(question: Question) {
  if (question.status === 'answered') return 'Answered';
  const tags = [question.status === 'closed' && 'Closed', responseToReplace(question) !== null && 'Has a response'];
  return tags.filter(Boolean).join(' · ');
}

/**
 * "Use as response to a question…": the deal's open questions, number and text, to pick from (never a
 * number typed from memory). A filter in the Q&A tab's style shows all of them instead, the answered and closed too
 *; it opens on Open each time. Typing narrows the list within the filter (findQuestions); the arrows
 * move through it and Enter picks, as a click does; Escape closes it. The focus stays in the field throughout
 * (aria-activedescendant). `id`: the answer's; `questions`: all the deal's.
 */
function UsePicker({ id, deal, onPick, onClose }: {
  id: string; deal: Deal; onPick: (questionId: string) => void; onClose: () => void;
}) {
  const state = useAppState();
  const [typed, setTyped] = useState('');
  const [active, setActive] = useState(0);
  const [all, setAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // again when All makes the list longer
  useLayoutEffect(() => {
    if (box.current) scrollIntoChat(box.current);
  }, [all]);
  const { rows, openCount, hasQuestions } = answerQuestionChoices(state, deal.id, typed, all);
  const current = Math.min(active, Math.max(0, rows.length - 1));
  // picked once: pressing Enter again while it is being used does nothing
  const busy = useRef(false);
  const pick = (question: Question | undefined) => {
    if (!question || busy.current) return;
    busy.current = true;
    onPick(question.id);
  };
  useLayoutEffect(() => {
    if (list.current) keepActiveInView(list.current);
  }, [current, typed, all]);
  const keys = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') closeOnEscape(onClose)(e);
    else if (e.key === 'Enter') {
      e.preventDefault();
      pick(rows[current]);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      e.preventDefault();
      setActive((current + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
    }
  };
  const optionId = (question: Question) => `use-${id}-${question.id}`;
  const show = (showAll: boolean) => {
    setAll(showAll);
    setActive(0);
  };
  const type = (text: string) => {
    setTyped(text);
    setActive(0);
  };
  return (
    <div class="card usecard" ref={box} onKeyDown={closeOnEscape(onClose)}>
      {/* the filter sits on the label's line, as the Checklist's does; a click on it leaves the focus in the field
          below */}
      <div class="lbl flagsl"><label for={`use-find-${id}`}>Use as response to a question</label>
        <span class="lblacts"><OpenOrAll all={all} openCount={openCount} show={show} /></span></div>
      <span class="ufind"><Icon name="search" size={14} />
        <input class="in" id={`use-find-${id}`} placeholder="Find by number or words" autoComplete="off"
          spellcheck={false} role="combobox" aria-expanded="true" aria-autocomplete="list"
          aria-controls={`use-list-${id}`} aria-activedescendant={rows.length ? optionId(rows[current]) : undefined}
          ref={focusOnceInPlace} value={typed} onKeyDown={keys}
          onInput={(e) => type((e.currentTarget as HTMLInputElement).value)} /></span>
      {/* a click picks without taking the focus from the field */}
      <div class="ulist" id={`use-list-${id}`} role="listbox"
        aria-label={`${all ? 'Questions' : 'Open questions'} on ${deal.name}`} ref={list}
        onMouseDown={(e) => e.preventDefault()}>
        {rows.map((question, i) => <UseOption key={question.id} id={optionId(question)} question={question}
          active={i === current} onHover={() => setActive(i)} onPick={() => pick(question)} />)}
        {!rows.length && <p class="unone">{noneText(all, hasQuestions, typed, deal.name)}</p>}
      </div>
      <div class="cacts"><button type="button" class="btn sm" onClick={onClose}>Cancel</button></div>
    </div>
  );
}

/** A question in the list; `onHover` makes it the active one, as the arrow keys do. */
function UseOption({ id, question, active, onHover, onPick }: {
  id: string; question: Question; active: boolean; onHover: () => void; onPick: () => void;
}) {
  const tag = tagOf(question);
  const hover = () => {
    if (!active) onHover();
  };
  return (
    <div id={id} role="option" aria-selected={active} class={`uopt ${active ? 'on' : ''}`} onMouseMove={hover}
      onClick={onPick}>
      <b>Q{question.n}</b><span class="ut">{question.text}</span>{tag && <span class="uhas">{tag}</span>}
    </div>
  );
}

/** What the list says when no question is in it. */
function noneText(all: boolean, anyInFilter: boolean, typed: string, deal: string) {
  const which = all ? '' : 'open ';
  return anyInFilter ? `No ${which}question matches “${typed.trim()}”.` : `${deal} has no ${which}questions.`;
}

/** The filter: the open questions, with their count, or all of them. A click on it leaves the focus where it is. */
function OpenOrAll({ all, openCount, show }: { all: boolean; openCount: number; show: (all: boolean) => void }) {
  const choices = [[false, `Open ${openCount}`], [true, 'All']] as const;
  return (
    <span class="seg" role="group" aria-label="Show" onMouseDown={(e) => e.preventDefault()}>
      {choices.map(([showAll, label]) => <button type="button" key={label} data-filter={showAll ? 'all' : 'open'}
        class={all === showAll ? 'on' : ''} aria-pressed={all === showAll}
        onClick={() => show(showAll)}>{label}</button>)}
    </span>
  );
}
