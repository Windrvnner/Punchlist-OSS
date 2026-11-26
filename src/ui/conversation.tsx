// A conversation with the model: the page (what it is about, the exchanges, and reading mode's document or the side
// pane beside them) and the composer, which is also the ask box at the top of a deal's pages and on Home.
import type { RefObject } from 'preact';
import { useSlashCommands } from './slashMenu';
import { SERVICE } from '../control';
import { isMine } from '../app/commands/members';
import { ReadOnlyContext } from './editField';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, lastInput } from './hooks';
import type { Store } from '../app/store';
import { Icon } from './icons';
import { FindingOpening } from './findings';
import { SidePane } from './sidePane';
import {
  composerScope, composerText, convKey, dealIdOf, suggestions, conversationDocs, findDoc, filesDealOf, scopeValid,
  sendTyped, setComposerText, type Scope,
} from '../app/conversations';
import { isOwnFiles, type Deal, type Question, type Source } from '../domain/model';
import { attachFiles, composerChips } from '../app/attachments';
import { type Message, type State, isReading, askAbout, askAcross } from '../app/state';
import { DocPanel } from './docPanel';
import { PastList } from './pastList';
import { useRotatingExample } from './homeExamples';
import { AttachButton, Chip, ModelPill, SendButton, type AttachTarget } from './composerParts';
import { Exchange, NotHere, QuestionOpening, Trail } from './conversationParts';

/**
 * the space between one exchange and the next in a conversation, and between the last one and the composer (.msgs
 * gap in ui.css)
 */
const THREAD_GAP = 34;
/**
 * the composer grows to this many lines of text and then scrolls; a whole number of lines, so a line is never shown
 * cut in half (line height 24px, ui.css)
 */
const COMPOSER_LINES = 7;

/** What reading mode shows in this conversation: the documents it steps through, the open one and the deal it is in. */
function readingState(state: State, scope: Scope, deal: Deal | null | undefined) {
  const docs = conversationDocs(state, scope);
  const { doc, docAside } = state.ui;
  const open = docAside ?? (doc != null && docs[doc] ? docs[doc] : null);
  // across deals, the citation says which deal its document is in
  const readDeal = open ? open.dealId ?? deal?.id : undefined;
  // Reading mode is on only while there is a document to show: an index left over from a list that has since changed,
  // or a document of a deal that has been deleted, closes it rather than leaving the layout folded around nothing.
  const indexGone = doc != null && !docAside && !docs[doc];
  const dealGone = !!open && (!readDeal || (!state.deals[readDeal] && !isOwnFiles(readDeal)));
  return { docs, open, readDeal, stale: indexGone || dealGone };
}

/**
 * Opening a document from the conversation. A source that is part of what is under review opens in the list; one
 * cited only by a follow-up answer opens on its own. `opener`: what had the focus when the document was opened by
 * keyboard; closing the document goes back to it. Opened with the mouse, nothing is moved.
 */
function useDocOpener(store: Store, scope: Scope) {
  const opener = useRef<HTMLElement | null>(null);
  const openDoc = (src: Source, ask?: string) => {
    if (src.dealId && !isOwnFiles(src.dealId) && !store.get().deals[src.dealId]) {
      store.toast('That deal has been deleted, so its documents can’t be opened');
      return;
    }
    if (!isReading(store.get().ui)) {
      opener.current = lastInput.kind === 'key' ? document.activeElement as HTMLElement | null : null;
    }
    const listed = findDoc(conversationDocs(store.get(), scope), src);
    if (listed >= 0) {
      store.ui({ doc: listed, docAside: null, side: null });
      return;
    }
    const from = 'From the conversation';
    const aside = { doc: src.doc, docId: src.docId, dealId: src.dealId, loc: src.loc || '', from, ask };
    store.ui({ doc: null, side: null, docAside: aside });
  };
  return { opener, openDoc };
}

/** Keeps the newest message in view when the thread grows, or its last message changes state. */
function useNewestInView(chat: RefObject<HTMLDivElement | null>, thread: Message[]) {
  const count = thread.length;
  useLayoutEffect(() => {
    const el = chat.current;
    if (el && count) el.scrollTop = el.scrollHeight;
  }, [count, thread[count - 1]?.state]);
}

/**
 * Reading mode is a class on the page. Closing a document opened by keyboard puts the focus back where it was, on the
 * phrase it was opened from.
 */
function useReadingFocus(open: boolean, opener: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    document.body.classList.toggle('reading', open);
    return () => document.body.classList.remove('reading');
  }, [open]);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !open && lastInput.kind === 'key') focusOpener(opener.current);
    wasOpen.current = open;
  }, [open]);
}

/** Back on the phrase, without its popup over the answer again; only while nothing else has taken the focus. */
function focusOpener(el: HTMLElement | null) {
  const focused = document.activeElement;
  const free = !focused || focused === document.body || focused.id === 'pask';
  if (!el?.isConnected || !free) return;
  el.focus({ preventScroll: true });
  el.closest('.ref')?.classList.add('nopop');
}

export function ConversationPage({ scope }: { scope: Scope }) {
  const store = useStore();
  const state = useAppState();
  const dealId = dealIdOf(scope);
  const deal = dealId === undefined ? null : state.deals[dealId];
  useEffect(() => {
    if (dealId !== undefined) void store.loadDeal(dealId);
  }, [dealId ?? '']);
  const thread = state.threads[convKey(scope)] ?? [];
  const { docs, open, readDeal, stale } = readingState(state, scope, deal);
  useLayoutEffect(() => {
    if (stale) store.ui({ doc: null, docAside: null });
  }, [stale]);
  const chatRef = useRef<HTMLDivElement>(null);
  const { opener, openDoc } = useDocOpener(store, scope);
  useNewestInView(chatRef, thread);
  useReadingFocus(!!open, opener);
  const fromList = checklistOrigin(state);
  const trail = <Trail scope={scope} deal={deal} backToList={fromList?.back} />;
  const valid = scopeValid(state, scope);
  if (valid !== true) return <NotHere scope={scope} deal={deal} loading={valid === 'loading'} trail={trail} />;
  const question = scope.kind === 'question' ? state.questions[scope.questionId] : null;
  // the finding open beside the conversation; a document, when one is open, has the room instead
  const side = open || dealId === undefined ? null : state.ui.side;
  const empty = thread.length === 0;
  return (
    <div class={`chatwrap ${open ? 'withdoc' : ''} ${side ? 'withside' : ''}`}>
      <div class={open ? 'reading-pane glass' : 'reading-pane'}>
        <div class="chat" ref={chatRef}>
          <div class="chathead">{trail}</div>
          <Opening scope={scope} deal={deal} question={question} checklistItem={empty ? fromList?.item : undefined}
            onOpen={openDoc} />
          <Messages scope={scope} thread={thread} onOpen={openDoc} />
        </div>
      </div>
      {side && <SidePane onOpen={openDoc} thread={thread} />}
      {open && readDeal && !stale && <DocPanel dealId={readDeal} docs={docs}
        index={state.ui.docAside ? null : state.ui.doc} aside={state.ui.docAside} headed={isAsking(scope)} />}
    </div>
  );
}

/**
 * A document opened from the Checklist: the trail leads back there, and the item it was opened for is named
 */
function checklistOrigin(state: State) {
  const aside = state.ui.docAside;
  return aside?.back && aside.item !== undefined ? aside : null;
}

/** A conversation asked from a deal's pages or from Home, rather than about one finding or question. */
const isAsking = (scope: Scope) => scope.kind === 'deal' || scope.kind === 'all';

/**
 * The top of the conversation: the heading screen readers find on a deal's or Home's conversations, the Checklist
 * item a document was opened for (until something is asked), and the finding or question it is about.
 */
function Opening({ scope, deal, question, checklistItem, onOpen }: {
  scope: Scope; deal: Deal | null | undefined; question: Question | null | undefined; checklistItem?: string;
  onOpen: (src: Source) => void;
}) {
  return (
    <>
      {isAsking(scope) && <h1 class="sr-only">{deal ? `Ask about ${deal.name}` : 'Ask across your deals'}</h1>}
      {checklistItem !== undefined && <div class="opening" id="from-item">
        <div class="lbl">Checklist Item</div><p class="qtxt">{checklistItem}</p>
      </div>}
      {scope.kind === 'finding' && <FindingOpening dealId={scope.dealId} findingId={scope.findingId} onOpen={onOpen} />}
      {question && <QuestionOpening question={question} onOpen={onOpen} />}
    </>
  );
}

/** The exchanges, a question and its answer each. */
function Messages({ scope, thread, onOpen }: {
  scope: Scope; thread: Message[]; onOpen: (src: Source, ask?: string) => void;
}) {
  const state = useAppState();
  const pairs: [Message, Message | undefined][] = [];
  for (let i = 0; i < thread.length; i += 2) pairs.push([thread[i], thread[i + 1]]);
  const suggested = suggestions(state, scope);
  // an answer under way while nobody is signed in waits for the sign-in, and says so rather than "Researching";
  // it carries on after
  const waiting = state.signin?.out ? `Waiting for ${SERVICE} sign-in` : undefined;
  return (
    <div class="msgs">{pairs.map(([mine, reply]) => (
      <Exchange key={mine.id} scope={scope} mine={mine} reply={reply} waiting={waiting} onOpen={onOpen}
        suggest={reply ? suggested.get(reply.id) : undefined} />
    ))}</div>
  );
}

type Launch = 'deal' | 'home' | undefined;

/**
 * Text in progress lives in the per-conversation map and is read straight from it, so changing conversation shows
 * that conversation's text at once and nothing can overwrite what is being typed.
 */
function useKeptText(key: string) {
  const [, bump] = useState(0);
  const textChanged = () => bump((n) => n + 1);
  const setText = (value: string) => {
    setComposerText(key, value);
    textChanged();
  };
  return { text: composerText(key), setText, textChanged };
}

/** The box grows with its text up to COMPOSER_LINES; the one-line ask box keeps the style sheet's height. */
function fitHeight(box: HTMLTextAreaElement, oneLine: boolean) {
  if (oneLine) {
    box.style.removeProperty('height');
    return;
  }
  box.style.height = 'auto';
  box.style.height = Math.min(COMPOSER_LINES * 24, box.scrollHeight) + 'px';
}

/**
 * Geometry: in reading mode the composer sits inside the conversation column; beside the side pane it follows the
 * conversation, which is narrower and no longer centered; else it is exactly as wide as the conversation above
 * it. The thread ends as far above the composer as its messages are from each other (THREAD_GAP), however tall the
 * composer is; and when the composer grows or shrinks, what was in view stays in view above it.
 */
function placeComposer(composer: HTMLFormElement, chat: HTMLElement, reading: boolean, beside: boolean) {
  const frame = composer.offsetParent as HTMLElement | null;
  const pane = reading && frame ? chat.parentElement : null;
  if (pane && frame) {
    const wrapLeft = pane.parentElement!.getBoundingClientRect().left;
    composer.style.setProperty('--cl', wrapLeft - frame.getBoundingClientRect().left + 14 + 'px');
    composer.style.setProperty('--cw', pane.offsetWidth - 28 + 'px');
    composer.style.removeProperty('--tw');
  } else if (beside && frame) {
    composer.style.setProperty('--cl', chat.getBoundingClientRect().left - frame.getBoundingClientRect().left + 'px');
    composer.style.setProperty('--cw', chat.offsetWidth + 'px');
  } else {
    composer.style.setProperty('--tw', chat.offsetWidth + 'px');
  }
  const bottom = (pane ?? chat).getBoundingClientRect().bottom;
  fitThread(chat, Math.round(bottom - composer.getBoundingClientRect().top), !!pane);
}

/** In reading mode, take the covered height out of both the scrollport and its padding (#438). */
function fitThread(chat: HTMLElement, gap: number, reading: boolean) {
  const padding = gap + THREAD_GAP + 'px';
  const cover = reading ? gap + 'px' : '';
  if (chat.style.getPropertyValue('--thread-padding') === padding &&
      chat.style.getPropertyValue('--composer-cover') === cover) return;
  const fromEnd = chat.scrollHeight - chat.clientHeight - chat.scrollTop;
  chat.style.setProperty('--thread-padding', padding);
  chat.style.setProperty('--composer-cover', cover);
  chat.scrollTop = chat.scrollHeight - chat.clientHeight - fromEnd;
}

/** The composer under a conversation is placed on every render and when the window changes size; an ask box is not. */
function useComposerPlace(form: RefObject<HTMLFormElement | null>, launch: Launch, reading: boolean, beside: boolean) {
  useLayoutEffect(() => {
    if (launch) return;
    const composer = form.current;
    const chat = document.querySelector<HTMLElement>('#view .chat');
    if (!composer || !chat) return;
    const place = () => placeComposer(composer, chat, reading, beside);
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  });
}

/**
 * Where files attached in a conversation go. A file attached on Home is kept with the person's own conversations, in
 * no deal; with nobody signed in, Home attaches nothing.
 */
function attachTarget(state: State, scope: Scope, key: string): AttachTarget | null {
  const dealId = filesDealOf(state, scope);
  if (!dealId) return null;
  return { dealId, findingId: scope.kind === 'finding' ? scope.findingId : undefined, conv: key };
}

/** What the empty box says: what a follow-up would be on, or which deal or deals a question is asked about. */
function placeholderFor(state: State, scope: Scope, deal: Deal | null | undefined) {
  if (scope.kind === 'question') return `Follow up on Q${state.questions[scope.questionId]?.n ?? ''}…`;
  if (scope.kind === 'finding') return 'Follow up on this finding…';
  if (deal) return askAbout(deal.name);
  const myDeals = Object.values(state.deals).filter((other) => isMine(state, other.id));
  return askAcross(myDeals.map((other) => other.name));
}

/** The form's id and look: the ask box on Home or on a deal's pages, or the composer under a conversation. */
function composerLook(launch: Launch, oneLine: boolean, reading: boolean, beside: boolean, menu: boolean) {
  if (launch === 'home') return { id: 'homeask', look: 'askbox glass' };
  if (launch === 'deal') return { id: 'dask', look: `askbox glass line ${oneLine ? '' : 'open'}` };
  const look = `askbox glass pcomp tcomp ${reading ? 'narrow' : ''} ${beside ? 'beside' : ''} ${menu ? 'open' : ''}`;
  return { id: 'pcomposer', look };
}

/** What the composer is doing, for the style sheet: text in it, the past conversations open, read-only. */
const composerState = (typing: boolean, past: boolean, readOnly: string | null) =>
  `${typing ? 'typing' : ''} ${past ? 'pastopen' : ''} ${readOnly ? 'ro' : ''}`;

/** Enter sends; Shift+Enter, and Enter that ends a character being composed (an IME), do not. */
const isSendKey = (e: KeyboardEvent) => e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;

/** Focus inside the composer opens a one-line ask box, unless it is on the past conversations' button or list. */
const inPastList = (el: HTMLElement) => !!el.closest('.pastpop, .pastbtn');

export function Composer({ scope: given, launch, placeholder: placeholderGiven, examples }: {
  scope: Scope; launch?: 'deal' | 'home'; placeholder?: string; examples?: string[];
}) {
  const store = useStore();
  const state = useAppState();
  // read-only while nobody is signed in: nothing is sent and nothing attached; what was typed stays in the box
  const readOnly = useContext(ReadOnlyContext);
  const { scope, launchSlot } = composerScope(given, !!launch);
  const key = convKey(scope);
  const currentKey = useRef(key);
  currentKey.current = key;
  const { text, setText, textChanged } = useKeptText(key);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menu = menuFor === key;
  const setMenu = (open: boolean) => setMenuFor(open ? key : null);
  const [past, setPast] = useState(false);
  // the ask box on a deal's pages is one line until it is used; then it is the full composer, in place
  const [active, setActive] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const oneLine = launch === 'deal' && !active && !menu;
  useLayoutEffect(() => {
    if (box.current) fitHeight(box.current, oneLine);
  }, [text, key, oneLine]);
  const reading = isReading(state.ui);
  // beside the side pane the conversation is narrower and no longer centered: the composer follows it
  const beside = !launch && !reading && !!state.ui.side && given.kind !== 'all';
  useComposerPlace(form, launch, reading, beside);
  const target = attachTarget(state, scope, key);
  const chips = target ? composerChips(state, key) : [];
  const send = () => sendTyped(store, scope, {
    launchSlot, textChanged,
    navigate: (hash) => { location.hash = hash; },
    sending: () => { if (launch && currentKey.current === key) box.current?.blur(); },
    refused: () => { if (currentKey.current === key) box.current?.focus(); },
  });
  const deal = target ? state.deals[target.dealId] : null;
  const example = useRotatingExample(examples, box, !!text);   // Home's example questions (homeExamples.ts)
  const placeholder = readOnly ? 'Read-only' : example ?? placeholderGiven ?? placeholderFor(state, scope, deal);
  const { id, look } = composerLook(launch, oneLine, reading, beside, menu);
  const pastId = launch ? 'past' : 'p-past';
  const slash = useSlashCommands({ scope, boxKey: key, text, formId: id, up: !launch, changed: textChanged });
  const focusOut = (e: FocusEvent) => {
    const to = e.relatedTarget as HTMLElement | null;
    if (!to || !form.current?.contains(to) || inPastList(to)) setActive(false);
  };
  return (
    <form class={`${look} ${composerState(!!text.trim(), past, readOnly)}`} id={id} aria-label="Ask" ref={form}
      onSubmit={(e) => submit(e, send)} onFocusOut={focusOut}
      onFocusIn={(e) => { if (!inPastList(e.target as HTMLElement)) setActive(true); }}
      onDragOver={(e) => { if (target && !readOnly) e.preventDefault(); }}
      onDrop={(e) => dropFiles(e, store, readOnly ? null : target)}>
      <div class="chips">{slash.chip}{chips.map((chip) => <Chip key={chip.id} chip={chip} scope={scope} />)}</div>
      <textarea id={launch ? 'hask' : 'pask'} ref={box} rows={1} dir="auto" placeholder={placeholder} aria-label="Ask"
        readOnly={!!readOnly} title={readOnly ?? undefined} value={text}
        aria-controls={slash.listId} aria-expanded={slash.listId ? true : undefined}
        aria-activedescendant={slash.activeId}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => { if (!slash.onKey(e) && isSendKey(e)) submit(e, send); }} />
      {slash.menu}
      <div class="bar">
        {target && <AttachButton target={target} count={chips.length} readOnly={readOnly} />}
        <ModelPill open={menu} setOpen={setMenu} up={!launch} />
        <button type="button" class={`scopebtn pastbtn ${past ? 'on' : ''}`} id={pastId} aria-haspopup="dialog"
          aria-expanded={past} aria-label="Past conversations" title="Past conversations"
          onClick={() => setPast(!past)}>
          <Icon name="clock" size={13} /><span class="t">Past Conversations</span>
        </button>
        <SendButton readOnly={readOnly} />
      </div>
      {past && <PastList close={() => setPast(false)} within={`#${id}`} opener={`#${pastId}`}
        dealId={dealIdOf(scope)} current={launch ? undefined : key} below={!!launch} />}
    </form>
  );
}

/** Sends instead of what the event would do (submit the form, or put a new line in the box). */
function submit(e: Event, send: () => Promise<void>) {
  e.preventDefault();
  void send();
}

/** Files dropped on the composer are attached; with nowhere to attach them (`target` null), the drop does nothing. */
function dropFiles(e: DragEvent, store: Store, target: AttachTarget | null) {
  if (!target) return;
  e.preventDefault();
  e.stopPropagation();
  void attachFiles(store, target, [...(e.dataTransfer?.files ?? [])]);
}
