// A conversation with the model: the page (what it is about, the exchanges, and reading mode's document or the side
// pane beside them) and the composer, which is also the ask box at the top of a deal's pages and on Home.
import type { RefObject } from 'preact';
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
  ask, convKey, dealIdOf, suggestions, conversationDocs, findDoc, navIntent, questionIntent, unresolvedIntent,
  scopeHash, newConv, type Scope,
} from '../app/conversations';
import { isOwnFiles, ownFilesId, type Deal, type Question, type Source } from '../domain/model';
import { attachFiles, filesSendable } from '../app/attachments';
import { type Attachment, type Message, type State , isReading, askAbout, askAcross } from '../app/state';
import { keptDrafts, isText } from './keptDrafts';
import { DocPanel } from './docPanel';
import { PastList } from './pastList';
import { useRotatingExample } from './homeExamples';
import { AttachButton, Chip, ModelPill, SendButton, type AttachTarget } from './composerParts';
import { Exchange, NotHere, QuestionOpening, Trail } from './conversationParts';

/** Whether what a conversation is about is still there: 'loading' while its deal is loaded to find out. */
export function scopeValid(state: State, scope: Scope): boolean | 'loading' {
  if (scope.kind === 'all') return true;
  if (!state.deals[scope.dealId]) return false;
  if (scope.kind === 'deal') return true;
  const load = state.dealLoad[scope.dealId];
  if (load !== 'loaded') return load === 'failed' ? false : 'loading';
  if (scope.kind === 'finding') return state.findings[scope.findingId]?.dealId === scope.dealId;
  return state.questions[scope.questionId]?.dealId === scope.dealId;
}

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
      <div class="chat" ref={chatRef}>
        <div class="chathead">{trail}</div>
        <Opening scope={scope} deal={deal} question={question} checklistItem={empty ? fromList?.item : undefined}
          onOpen={openDoc} />
        <Messages scope={scope} thread={thread} onOpen={openDoc} />
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

/**
 * The composer: under a conversation (`#pcomposer`), and the ask box at the top of a deal's pages and on Home
 * (option A, the same composer in place). Enter sends; Shift+Enter is a new line. Text in progress is kept per
 * conversation. Asked from a deal page or from Home, a question starts a new conversation; under one, it continues it.
 */
const drafts = keptDrafts('composer', isText);                // kept across a restart too
/** the conversation the next question asked from a deal's pages, or from Home, will start */
const nextConv = keptDrafts('next-conversation', isText);   // so the ask box's kept text finds its conversation again

type Launch = 'deal' | 'home' | undefined;

/**
 * The conversation a composer asks in: its own, or for an ask box, the new one its next question will start.
 * `slot`: the ask box's place in the list of next conversations.
 */
function composerScope(given: Scope, launch: Launch) {
  const slot = given.kind === 'all' ? 'all' : `deal:${given.dealId}`;
  if (launch && !nextConv.has(slot)) nextConv.set(slot, newConv());
  if (!launch) return { slot, scope: given };
  const conv = nextConv.get(slot)!;
  const scope: Scope = given.kind === 'all' ? { kind: 'all', conv } : { kind: 'deal', dealId: given.dealId, conv };
  return { slot, scope };
}

/**
 * Text in progress lives in the per-conversation map and is read straight from it, so changing conversation shows
 * that conversation's text at once and nothing can overwrite what is being typed.
 */
function useKeptText(key: string) {
  const [, bump] = useState(0);
  const text = drafts.get(key) ?? '';
  const setText = (value: string) => {
    if (value) drafts.set(key, value);
    else drafts.delete(key);
    bump((n) => n + 1);
  };
  return { text, setText };
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
  if (reading && frame) {
    const wrapLeft = chat.parentElement!.getBoundingClientRect().left;
    composer.style.setProperty('--cl', wrapLeft - frame.getBoundingClientRect().left + 14 + 'px');
    composer.style.setProperty('--cw', chat.offsetWidth - 28 + 'px');
    composer.style.removeProperty('--tw');
  } else if (beside && frame) {
    composer.style.setProperty('--cl', chat.getBoundingClientRect().left - frame.getBoundingClientRect().left + 'px');
    composer.style.setProperty('--cw', chat.offsetWidth + 'px');
  } else {
    composer.style.setProperty('--tw', chat.offsetWidth + 'px');
  }
  const gap = Math.round(chat.getBoundingClientRect().bottom - composer.getBoundingClientRect().top);
  const want = gap + THREAD_GAP + 'px';
  if (chat.style.paddingBottom === want) return;
  const fromEnd = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
  chat.style.paddingBottom = want;
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
  if (scope.kind !== 'all') {
    return { dealId: scope.dealId, findingId: scope.kind === 'finding' ? scope.findingId : undefined, conv: key };
  }
  return state.user ? { dealId: ownFilesId(state.user.name), conv: key } : null;
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

/** What sending needs: the conversation, where its text is kept, and where its files go. */
type Sending = {
  store: Store; scope: Scope; key: string; slot: string; launch: Launch; target: AttachTarget | null;
  chips: Attachment[]; readOnly: string | null; box: RefObject<HTMLTextAreaElement | null>;
  setText: (text: string) => void;
};

/**
 * Sends what is typed, read at the moment of sending, not from the last render. Typed text that asks to go somewhere,
 * or on a deal's pages to add a question or an unresolved item, is done as asked instead of being asked of the model.
 */
async function sendTyped({ store, scope, key, slot, launch, target, chips, readOnly, box, setText }: Sending) {
  if (!(drafts.get(key) ?? '').trim() || readOnly) return;
  if (chips.some((chip) => chip.state === 'pending')) {
    store.toast('Still attaching — send when it finishes');
    return;
  }
  if (!(await chipsSendable(store, key, chips))) return;
  // read after the files are checked, so anything typed meanwhile goes too
  const typed = (drafts.get(key) ?? '').trim();
  if (!typed) return;
  setText('');
  if (launch) box.current?.blur();
  if (navIntent(store, typed)) return;
  const inDeal = target && scope.kind === 'deal' ? target.dealId : null;
  if (inDeal && unresolvedIntent(store, inDeal, typed)) return;
  const intent = inDeal ? await questionIntent(store, inDeal, typed) : 'none';
  // refused: the typed text comes back, unless something new has been typed since, so it can be sent again
  if (intent === 'refused' && !drafts.get(key)) {
    setText(typed);
    box.current?.focus();
  }
  if (intent !== 'none') return;
  if (launch) {
    nextConv.delete(slot);
    location.hash = scopeHash(scope);   // the new conversation opens, with its question in it
  }
  void ask(store, scope, typed);
}

/** the conversations whose files are being checked before a send, so a second Enter meanwhile sends nothing twice */
const checking = new Set<string>();

/** Whether the composer's files can all be sent from this PC (#671); the person is told of any that can't. */
async function chipsSendable(store: Store, key: string, chips: Attachment[]) {
  const ready = chips.filter((chip) => chip.state === 'done' && chip.doc && chip.docId);
  if (!ready.length) return true;
  if (checking.has(key)) return false;
  checking.add(key);
  try {
    const files = ready.map((chip) => ({ dealId: chip.dealId, doc: chip.doc!, docId: chip.docId! }));
    for (const dealId of new Set(files.map((file) => file.dealId))) {
      if (!(await filesSendable(store, dealId, files.filter((file) => file.dealId === dealId)))) return false;
    }
    return true;
  } finally { checking.delete(key); }
}

export function Composer({ scope: given, launch, placeholder: placeholderGiven, examples }: {
  scope: Scope; launch?: 'deal' | 'home'; placeholder?: string; examples?: string[];
}) {
  const store = useStore();
  const state = useAppState();
  // read-only while nobody is signed in: nothing is sent and nothing attached; what was typed stays in the box
  const readOnly = useContext(ReadOnlyContext);
  const { slot, scope } = composerScope(given, launch);
  const key = convKey(scope);
  const { text, setText } = useKeptText(key);
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
  const chips = target ? state.ui.attachments.filter((attachment) => attachment.conv === key) : [];
  const send = () => sendTyped({ store, scope, key, slot, launch, target, chips, readOnly, box, setText });
  const deal = target ? state.deals[target.dealId] : null;
  const example = useRotatingExample(examples, box, !!text);   // Home's example questions (homeExamples.ts)
  const placeholder = readOnly ? 'Read-only' : example ?? placeholderGiven ?? placeholderFor(state, scope, deal);
  const { id, look } = composerLook(launch, oneLine, reading, beside, menu);
  const pastId = launch ? 'past' : 'p-past';
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
      <div class="chips">{chips.map((chip) => <Chip key={chip.id} chip={chip} scope={scope} />)}</div>
      <textarea id={launch ? 'hask' : 'pask'} ref={box} rows={1} dir="auto" placeholder={placeholder} aria-label="Ask"
        readOnly={!!readOnly} title={readOnly ?? undefined} value={text}
        onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => { if (isSendKey(e)) submit(e, send); }} />
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
