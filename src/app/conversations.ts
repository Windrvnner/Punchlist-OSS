/**
 * Conversations: a person's own working threads with the AI. Never a record: kept in
 * the person's own files in the shared folder (the window's store is only a cache), keyed by scope. An answer is applied only to the pending
 * message it was requested for, so navigating, retrying or deleting mid-flight
 * cannot misplace it.
 */
import { isMine } from './commands/members';
import type { Store } from './store';
import { dealHash, pageHash, dealQuestions, type State, type Message } from './state';
import { docKey, ownFilesId, type Question, type Source } from '../domain/model';
import { CreateQuestion, UseAsResponse } from './commands/questions';
import { findQuestions, mayAddress } from '../domain/suggest';
import { withoutMarkers } from '../domain/cite';
import type { Research } from '../ports';
import { bareDealName, sameName } from './commands/deals';
import { TITLE_MAX } from './commands/findings';
import { chipsSendable, dealCopied, filesSendable } from './attachments';
import { isText, keptDrafts } from './keptText';
import {
  boxWithRefused, initializeRefusedCommands, interruptedNow, keptForRetry, takeFromBox,
} from './refusedCommands';

/**
 * A conversation about a deal, or across deals, has its own id (`conv`): each question asked from a deal page's ask
 * box or from Home starts a new one, and its follow-ups continue it. A deal's first conversation, from before there
 * were several, has none. A finding or a question has one conversation, about it.
 */
export type Scope =
  | { kind: 'all'; conv?: string }
  | { kind: 'deal'; dealId: string; conv?: string }
  | { kind: 'finding'; dealId: string; findingId: string }
  | { kind: 'question'; dealId: string; questionId: string };

/** The deal a conversation is about; none for one across every deal. */
export const dealIdOf = (scope: Scope) => (scope.kind === 'all' ? undefined : scope.dealId);

/** Whether what a conversation is about is still there, or its deal has yet to load. */
export function scopeValid(state: State, scope: Scope): boolean | 'loading' {
  if (scope.kind === 'all') return true;
  if (!state.deals[scope.dealId]) return false;
  if (scope.kind === 'deal') return true;
  const load = state.dealLoad[scope.dealId];
  if (load !== 'loaded') return load === 'failed' ? false : 'loading';
  if (scope.kind === 'finding') return state.findings[scope.findingId]?.dealId === scope.dealId;
  return state.questions[scope.questionId]?.dealId === scope.dealId;
}

export const convKey = (s: Scope) => s.kind === 'all' ? (s.conv ? `all:${s.conv}` : 'all') : s.kind === 'deal' ? `deal:${s.dealId}${s.conv ? ':' + s.conv : ''}` : s.kind === 'finding' ? `f:${s.dealId}:${s.findingId}` : `q:${s.dealId}:${s.questionId}`;
export const scopeHash = (s: Scope) => s.kind === 'all' ? (s.conv ? `chat-${s.conv}` : 'chat') : s.kind === 'deal' ? `chat-${s.dealId}${s.conv ? '-' + s.conv : ''}` : s.kind === 'finding' ? `finding-${s.dealId}-${s.findingId}` : `q-${s.dealId}-${s.questionId}`;
/** The scope a stored conversation is about, from its key; null for a key this version does not know. */
export function scopeOfKey(key: string): Scope | null {
  if (key === 'all') return { kind: 'all' };
  let m = /^all:(c[0-9a-z]{4,24})$/.exec(key); if (m) return { kind: 'all', conv: m[1] };
  m = /^deal:(d_[0-9A-Z]{26})(?::(c[0-9a-z]{4,24}))?$/.exec(key); if (m) return m[2] ? { kind: 'deal', dealId: m[1], conv: m[2] } : { kind: 'deal', dealId: m[1] };
  m = /^f:(d_[0-9A-Z]{26}):(f_[0-9A-Z]{26})$/.exec(key); if (m) return { kind: 'finding', dealId: m[1], findingId: m[2] };
  m = /^q:(d_[0-9A-Z]{26}):(q_[0-9A-Z]{26})$/.exec(key); if (m) return { kind: 'question', dealId: m[1], questionId: m[2] };
  return null;
}
/** A new conversation's id. */
export const newConv = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function scopeOfRoute(r: State['ui']['route']): Scope | null {
  if (r.name === 'chat') return r.dealId ? (r.conv ? { kind: 'deal', dealId: r.dealId, conv: r.conv } : { kind: 'deal', dealId: r.dealId }) : r.conv ? { kind: 'all', conv: r.conv } : { kind: 'all' };
  if (r.name === 'finding') return { kind: 'finding', dealId: r.dealId, findingId: r.findingId };
  if (r.name === 'question') return { kind: 'question', dealId: r.dealId, questionId: r.questionId };
  return null;
}

/** One past conversation, as the Past conversations list shows it. */
export interface PastConversation { key: string; scope: Scope; dealId?: string; /** what it was about, for one about a finding or a question */ about?: string; title: string; preview: string; at: string; words: string }
const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();
/**
 * Every conversation with something asked in it, newest first. Those of a deal that has been deleted are left out.
 * The title is the first question; the preview is the start of the latest answer.
 */
export function pastConversations(s: State): PastConversation[] {
  const out: PastConversation[] = [];
  for (const [key, list] of Object.entries(s.threads)) {
    const scope = scopeOfKey(key); if (!scope || !Array.isArray(list)) continue;
    const first = list.find((m) => m.role === 'me'); if (!first) continue;
    const dealId = scope.kind === 'all' ? undefined : scope.dealId;
    if (dealId && !s.deals[dealId]) continue;
    const last = list[list.length - 1]; const ai = [...list].reverse().find((m) => m.role === 'ai');
    const preview = !ai ? '' : ai.state === 'pending' ? 'Answering…'
      : ai.state === 'failed' ? 'Couldn’t get an answer' : oneLine(answerText(ai));
    const about = scope.kind === 'finding' ? s.findings[scope.findingId]?.title ?? 'Finding' : scope.kind === 'question' ? (s.questions[scope.questionId] ? `Q${s.questions[scope.questionId].n}` : 'Question') : undefined;
    out.push({ key, scope, dealId, about, title: oneLine(first.text), preview, at: last.at, words: list.map((m) => m.text).join(' ').toLowerCase() });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

function dayGroup(at: string, now: Date): 'today' | 'week' | 'older' {
  const then = new Date(at);
  const today = +new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.floor((today - +new Date(then.getFullYear(), then.getMonth(), then.getDate())) / 864e5);
  return days <= 0 ? 'today' : days < 7 ? 'week' : 'older';
}

/** Past conversations in the chosen deal and matching every word, with headings at local day boundaries. */
export function pastConversationList(store: Store, { dealId, allDeals, search }: {
  dealId?: string; allDeals: boolean; search: string;
}) {
  const every = pastConversations(store.get());
  const words = search.trim().toLowerCase();
  const terms = words ? words.split(/\s+/) : [];
  const now = new Date(store.services.clock.now());
  let previous: ReturnType<typeof dayGroup> | undefined;
  const rows = every.filter((conversation) => {
    if (!allDeals && conversation.dealId !== dealId) return false;
    const title = conversation.title.toLowerCase();
    return terms.every((term) => title.includes(term) || conversation.words.includes(term));
  }).map((conversation) => {
    const group = dayGroup(conversation.at, now);
    const startsGroup = group !== previous;
    previous = group;
    return { conversation, group, startsGroup };
  });
  return { rows, words, now, hasConversations: every.length > 0 };
}

let seq = 0;
const mid = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

/** a deal name as typed navigation compares it: without "Project", in any case */
const navigationName = (name: string) => sameName(bareDealName(name.trim(), 'navigation')).toLowerCase();
/** The deal a typed name names: that exact name, in any case, without "Project", spaces between words aside. */
function dealByName<T extends { name: string }>(deals: T[], typed: string): T | undefined {
  const exact = navigationName(typed);
  if (!exact) return;
  return deals.find((deal) => navigationName(deal.name) === exact);
}

// #500: only the explicit verb and page suffix are syntax; a deal name can contain punctuation or Unicode.
function typedDealDestination(store: Store, text: string) {
  const command = /^(?:take me to|go to|open|show me|show|switch to|jump to)\s+(.+)$/is.exec(text);
  if (!command) return;
  const target = sameName(command[1]);
  const lookup = (name: string) => dealByName(Object.values(store.get().deals), name);
  const possessive = (name: string) => lookup(name.replace(/['’]s$/i, '')) ?? lookup(name);
  const named = (name: string) => {
    const withoutArticle = name.replace(/^the\s+/i, '');
    return possessive(withoutArticle) ?? (withoutArticle !== name ? possessive(name) : undefined);
  };
  const suffix = /^(.+?)\s+(q ?& ?a|questions|findings|checklist|overview)$/i.exec(target);
  const deal = suffix && named(suffix[1]);
  return deal ? { deal, page: suffix[2].toLowerCase() } : { deal: named(target), page: '' };
}

function destinationHash(store: Store, text: string) {
  const destination = typedDealDestination(store, text);
  if (!destination?.deal) return;
  const { deal, page } = destination;
  return page
    ? pageHash(/q|question/.test(page) ? 'qa' : page as 'findings' | 'checklist' | 'overview', deal.id)
    : dealHash(store.get().prefs, deal.id);
}

/** "Go to Proseware findings", "open Trey Q&A", or "new deal", resolved against loaded deals. */
export function navIntent(
  store: Store, text: string, navigate = navigateWindow, handled?: () => void,
): boolean {
  const typed = text.trim();
  if (/^(new|create|add|start) (a )?(new )?deal\b/i.test(typed)) {
    handled?.();
    store.ui({ newDeal: { name: '', folders: [], error: '', busy: false } });
    return true;
  }
  const hash = destinationHash(store, typed);
  if (!hash) return false;
  handled?.();
  navigate(hash);
  return true;
}

function navigateWindow(hash: string) {
  if (typeof location !== 'undefined') location.hash = hash;
}

/** "Add all unresolved to Q&A" opens the same preview as the Checklist menu (decisions, #2). */
function unresolvedIntent(text: string) {
  const command = '^(?:please\\s+)?add (?:all )?(?:the )?unresolved';
  const points = '(?: (?:items|points|gaps(?: and(?: open)? findings)?))?';
  const destination = '(?: (?:to|into|in) (?:the )?(?:q ?& ?a|questions))?\\s*[.!]?$';
  return new RegExp(command + points + destination, 'i').test(text);
}

let drafts: { text: Map<string, string>; next: Map<string, string> } | undefined;
const composerDrafts = () => drafts ??= {
  text: keptDrafts('composer', isText),
  next: keptDrafts('next-conversation', isText),
};

/** Load both maps before recovery can move saved drafts and their conversation slots to a copy. */
export function initializeComposerDrafts() {
  composerDrafts();
  initializeRefusedCommands();
}

/** The ask box's next conversation is kept with its draft. Within a conversation, keep using that scope. */
export function composerScope(given: Scope, launching: boolean): { scope: Scope; launchSlot?: string } {
  if (!launching) return { scope: given };
  const launchSlot = given.kind === 'all' ? 'all' : `deal:${given.dealId}`;
  const { next } = composerDrafts();
  const conv = next.get(launchSlot) ?? newConv();
  if (!next.has(launchSlot)) next.set(launchSlot, conv);
  const scope: Scope = given.kind === 'all' ? { kind: 'all', conv } : { kind: 'deal', dealId: given.dealId, conv };
  return { scope, launchSlot };
}

export const composerText = (key: string) => composerDrafts().text.get(key) ?? '';
export function setComposerText(key: string, text: string) {
  const kept = composerDrafts().text;
  if (text) kept.set(key, text);
  else kept.delete(key);
}

type SendView = {
  launchSlot?: string;
  navigate(hash: string): void;
  sending?(): void;
  textChanged?(): void;
  refused?(): void;
};

/**
 * The box and its saved draft are already clear, so a restart after the save cannot bring the command back. A refusal
 * (storage full, a copied install, ...) has been told by the store, except input rejected before planning, said here.
 * The typed command then goes back at the head of its box, ahead of anything typed since, so it can be sent again,
 * unless the store kept it as interrupted work to retry (#955).
 */
async function logTypedQuestion(store: Store, dealId: string, question: string, typed: string, key: string,
  view: SendView) {
  // The text going back in the box is the way to try again: a Retry as well could log it twice.
  const before = interruptedNow(store);
  const result = await store.dispatch(CreateQuestion, { dealId, text: question }, {
    idempotencyKey: 'ask-addq-' + dealId, noRetry: true,
  });
  if (result.ok) return;
  if (result.error.kind === 'invalid') store.toast(result.error.message, 'warn');
  if (keptForRetry(store, before, dealId, question)) return;
  setComposerText(key, boxWithRefused(key, typed, composerText(key)));
  view.textChanged?.();
  view.refused?.();
}

/** Send the latest draft after file checks. Navigation and question commands take precedence over a model answer. */
export async function sendTyped(store: Store, scope: Scope, view: SendView) {
  const key = convKey(scope);
  if (!composerText(key).trim() || store.readOnly() || scopeValid(store.get(), scope) !== true) return;
  if (!(await chipsSendable(store, key))) return;
  const state = store.get();
  const filesDeal = filesDealOf(state, scope);
  // A recovered copy now has the draft and files (#117). Do not clear or send them from the old scope.
  if (store.readOnly() || scopeValid(state, scope) !== true || (filesDeal && dealCopied(store, filesDeal))) return;
  // A command put back after a refusal is sent alone, and what was typed after it stays in the box (#955).
  const { send: text, rest } = takeFromBox(key, composerText(key).trim());
  if (!text) return;
  const take = () => {
    setComposerText(key, rest);
    view.textChanged?.();
    view.sending?.();
  };
  if (navIntent(store, text, view.navigate, take)) return;
  const dealId = scope.kind === 'deal' ? scope.dealId : undefined;
  if (dealId && unresolvedIntent(text)) {
    take();
    store.ui({ dialog: { kind: 'addUnresolved', dealId } });
    return;
  }
  const question = dealId ? /^(?:add|log) (?:a )?question[:\s]+(.+)/is.exec(text) : null;
  if (dealId && question) {
    take();
    await logTypedQuestion(store, dealId, question[1].trim(), text, key, view);
    return;
  }
  take();
  if (view.launchSlot) {
    composerDrafts().next.delete(view.launchSlot);
    view.navigate(scopeHash(scope));
  }
  void ask(store, scope, text);
}

export async function ask(store: Store, scope: Scope, text: string) {
  text = text.trim(); if (!text) return;
  // read-only while nobody is signed in: nothing new is asked
  const ro = store.readOnly();
  if (ro) {
    store.toast(ro, 'warn');
    return;
  }
  const key = convKey(scope);
  const atts = store.get().ui.attachments.filter((a) => a.conv === key && a.state === 'done' && a.doc && a.docId);
  if (atts.length) store.ui((ui) => ({ attachments: ui.attachments.filter((a) => !atts.includes(a)) }));
  const prior = store.get().threads[key] ?? [];
  const sent = atts.map((a) => ({ doc: a.doc!, docId: a.docId! }));
  const me: Message = { id: mid(), role: 'me', text, state: 'done', at: store.services.clock.now(), ...(sent.length ? { attached: sent } : {}) };
  const pending: Message = { id: mid(), role: 'ai', text: '', state: 'pending', at: me.at };
  store.setThread(key, [...prior, me, pending]);
  await answer(store, scope, pending.id, text, prior, sent);
}

/** Where a conversation's files go: its deal, or on Home the person's own files; null when nobody is signed in. */
export function filesDealOf(state: State, scope: Scope): string | null {
  if (scope.kind !== 'all') return scope.dealId;
  return state.user ? ownFilesId(state.user.name) : null;
}

/** A reply that failed, with the conversation as it is now; null when it no longer is (retried meanwhile, or gone). */
function failedReply(store: Store, key: string, messageId: string) {
  const list = store.get().threads[key] ?? [];
  const i = list.findIndex((m) => m.id === messageId);
  return i >= 1 && list[i].role === 'ai' && list[i].state === 'failed' ? { list, i } : null;
}

export async function retry(store: Store, scope: Scope, messageId: string) {
  const ro = store.readOnly();
  if (ro) {
    store.toast(ro, 'warn');
    return;
  }
  const key = convKey(scope);
  const before = failedReply(store, key, messageId);
  if (!before) return;
  // the files that went with the question go again, or nothing is asked (#671)
  const files = before.list[before.i - 1].attached ?? [];
  const filesDeal = filesDealOf(store.get(), scope);
  if (filesDeal && files.length && !(await filesSendable(store, filesDeal, files))) return;
  const now = failedReply(store, key, messageId);
  if (!now) return;
  const { list, i } = now;
  store.setThread(key, list.map((m) => (m.id === messageId ? { ...m, state: 'pending' as const } : m)));
  await answer(store, scope, messageId, list[i - 1].text, list.slice(0, i - 1), list[i - 1].attached ?? []);
}

/** The person stops an answer being worked on: it comes back at once from what was found so far. */
export async function stopAnswer(store: Store, messageId: string) { try { await store.services.ai.stop?.(messageId); } catch { /* the answer carries on and comes back as usual */ } }

/** how often the window asks the backend for the steps of an answer it is working on */
const FOLLOW_MS = 700;
async function answer(store: Store, scope: Scope, messageId: string, text: string, prior: Message[], attachments: { doc: string; docId: string }[]) {
  const key = convKey(scope); const ai = store.services.ai;
  // While the chat agent works, its steps so far are asked for and kept for the "Researching" view (option D), by the pending message.
  const setSteps = (r: Research | null) => store.ui((ui) => { const { [messageId]: _was, ...rest } = ui.researching; return { researching: r ? { ...rest, [messageId]: r } : rest }; });
  let following = !!ai.research;
  const follow = async () => { while (following) { await new Promise((ok) => setTimeout(ok, FOLLOW_MS)); if (!following) break; const p = await ai.research!(messageId); if (following && p.ok && p.value) setSteps(p.value); } };
  if (following) void follow();
  const r = await ai.answer({
    dealId: scope.kind === 'all' ? undefined : scope.dealId,
    // asked across deals, only the person's own deals are searched
    ...(scope.kind === 'all' ? { dealIds: Object.keys(store.get().deals).filter((id) => isMine(store.get(), id)) } : {}),
    // and the files the person attached on Home, kept with their own conversations
    ...(scope.kind === 'all' && store.get().user ? { files: ownFilesId(store.get().user!.name) } : {}),
    findingId: scope.kind === 'finding' ? scope.findingId : undefined,
    questionId: scope.kind === 'question' ? scope.questionId : undefined,
    message: text, history: prior.filter((m) => m.state === 'done').map((m) => ({ role: m.role, text: m.text })), model: store.get().model || store.get().prefs.model || 'standard',   // before the models have loaded (just after a sign-in): the person's own default, else the standard tier
    attachments, runId: messageId, conversation: key,
    // the model service's conversation, as the last answer left it, is carried on
    ...((t) => (t ? { thread: t } : {}))([...prior].reverse().find((m) => m.role === 'ai' && m.state === 'done' && m.thread)?.thread),
  }).finally(() => { following = false; setSteps(null); });
  store.touchCached();                                   // answering may have loaded documents into the store
  // apply only to the message this request was made for, if it is still pending
  const list = store.get().threads[key] ?? [];
  if (!list.some((m) => m.id === messageId && m.state === 'pending')) return;
  store.setThread(key, list.map((m) => m.id !== messageId ? m : r.ok ? { ...m, text: r.value.text, sources: r.value.sources, ...(r.value.research ? { research: r.value.research } : {}), ...(r.value.thread ? { thread: r.value.thread } : {}), state: 'done' as const } : { ...m, state: 'failed' as const }));
}

/** An answer's text as it leaves the conversation, as a response or a question: finding links as words, no [n] markers. */
export const withoutFindingLinks = (text: string) => text.replace(/\{([^|}]+)\|f_[0-9A-Z]{26}\}/g, '$1');
export const answerText = (m: Message) => withoutMarkers(withoutFindingLinks(m.text), m.sources?.length ?? 0);

/** A new question from a finding starts with the answer. On a deal, it starts with what was asked. */
export const questionFromAnswer = (scope: Scope, answer: Message, asked: string) =>
  scope.kind === 'finding' ? answerText(answer) : asked;

/** The answer's first sentence, without its last punctuation, starts the new finding's title. */
export function findingFromAnswer(answer: Message) {
  const text = withoutFindingLinks(answer.text);
  const preview = answerText(answer);
  // the first sentence ends at a . ! or ? followed by a space or the end, so "1.5x" and "U.S." do not end it; nothing is cut
  const sentence = /^.*?[.!?](?=\s|$)/s.exec(preview)?.[0] ?? preview;
  // a sentence longer than a title may be is left for the person to word: nothing is cut, and the body keeps it all
  const title = sentence.trim().replace(/[.!?]$/, '');
  return { text, preview, title: title.length > TITLE_MAX ? '' : title };
}

/** The current response to confirm before replacement, when one is present. */
export const responseToReplace = (question?: Question) => question?.response.trim() ? question.response : null;

/** Read the question itself so undoing the response brings the check back. */
export function answerWasUsed(question: Question, answer: Message) {
  const response = responseToReplace(question);
  return response !== null && response.trim() === answerText(answer).trim();
}

/** A person makes an answer the response, with its sources and only once however often it is pressed. */
export function useAnswer(
  store: Store, dealId: string, questionId: string, answer: Message, over: string | null = null,
) {
  return store.dispatch(UseAsResponse, {
    dealId, questionId, text: answerText(answer), sources: answer.sources ?? [], over: over ?? '',
  }, { idempotencyKey: 'use-' + answer.id });
}

/** The question picker searches within Open or All and counts Open before searching. */
export function answerQuestionChoices(state: State, dealId: string, typed: string, all: boolean) {
  const questions = dealQuestions(state, dealId);
  const open = questions.filter((question) => question.status === 'open');
  const within = all ? questions : open;
  return { rows: findQuestions(typed, within), hasQuestions: within.length > 0, openCount: open.length };
}

/**
 * A person asks the model whether an answer addresses the open question suggested under it. The verdict
 * is kept for this session, for the card to show; nothing else changes. Without the port's `addresses` there is no asking.
 */
export async function askVerdict(store: Store, dealId: string, questionId: string, m: Message) {
  const ai = store.services.ai; const q = store.get().questions[questionId]; const key = `${m.id}|${questionId}`;
  if (!ai.addresses || !q || store.get().ui.verdicts[key] === 'asking') return;
  const set = (v: State['ui']['verdicts'][string]) => store.ui((ui) => ({ verdicts: { ...ui.verdicts, [key]: v } }));
  set('asking');
  const r = await ai.addresses({ dealId, question: q.text, answer: answerText(m) });
  set(r.ok ? r.value : 'failed');
}

/**
 * The open question each answer may address, for the card under it: answer message id to question id.
 * One question per answer, and each question under one answer only, the newest that may address it. On a deal's or a
 * finding's conversation; on a question's, the answer is already about that question. A question whose response is
 * already an answer of this conversation is not suggested again. One a person said "not this one" to is not shown, nor
 * offered under an earlier answer instead.
 */
export function suggestions(s: State, scope: Scope): Map<string, string> {
  const out = new Map<string, string>(); if (scope.kind !== 'deal' && scope.kind !== 'finding') return out;
  const list = s.threads[convKey(scope)] ?? []; const texts = new Map(list.map((m) => [m.id, answerText(m).trim()]));
  const used = new Set(texts.values());
  const open = dealQuestions(s, scope.dealId).filter((q) => q.status === 'open' && !used.has(q.response.trim())); const offered = new Set<string>();
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]; if (m.role !== 'ai' || m.state !== 'done') continue;
    const q = mayAddress(texts.get(m.id)!, open.filter((x) => !offered.has(x.id)))[0];
    if (!q) continue;
    offered.add(q.id); if (!s.ui.notThese.includes(`${m.id}|${q.id}`)) out.set(m.id, q.id);
  }
  return out;
}

/** `from` says what cited it; `ask` is the question that led to the answer, when an answer cited it; `dealId` only on answers across deals. */
export interface DocRef { doc: string; docId: string; loc: string; from: string; ask?: string; dealId?: string }
const pageKey = (loc: string) => { const m = /p\.\s*(\d+)/.exec(loc); if (m) return 'p. ' + m[1]; const sh = /^([^!]+)!/.exec(loc); return sh ? sh[1] : loc; };

/**
 * The documents under review in a conversation, one entry per document page, in order. This is the
 * reading list and what the arrows step through.
 *   - on a finding: the finding's own sources, the evidence a reviewer signs off on;
 *   - on a question: the sources of its response, or of its draft while there is no response;
 *   - on a deal or across deals, where nothing is under review: what the answers cited.
 * Follow-up answers on a finding or question do not add to the list: a citation in one opens on its own (ui.docAside).
 */
export function conversationDocs(s: State, scope: Scope): DocRef[] {
  const out: (DocRef & { page: string; locs: string[] })[] = [];
  const add = (src: Source, from: string, ask?: string) => {
    const page = pageKey(src.loc || ''); const ex = out.find((x) => docKey(x) === docKey(src) && x.page === page);
    if (ex) { if (src.loc && !ex.locs.includes(src.loc)) { ex.locs.push(src.loc); ex.loc = ex.locs.join(' · '); } return; }
    out.push({ doc: src.doc, docId: src.docId, dealId: src.dealId, loc: src.loc || '', from, ask, page, locs: src.loc ? [src.loc] : [] });
  };
  if (scope.kind === 'finding') { for (const x of s.findings[scope.findingId]?.sources ?? []) add(x, 'From the finding'); return out; }
  if (scope.kind === 'question') { const q = s.questions[scope.questionId]; for (const x of (q?.response ? q.provenance?.sources : q?.draft?.sources) ?? []) add(x, q?.response ? 'From the response' : 'From the draft'); return out; }
  (s.threads[convKey(scope)] ?? []).forEach((m, i, all) => { if (m.role === 'ai') for (const x of m.sources ?? []) add(x, `From answer ${Math.floor(i / 2) + 1}`, all[i - 1]?.role === 'me' ? all[i - 1].text : undefined); });
  return out;
}
/** Where a source sits in the list, or -1 when it is not part of it. */
export const findDoc = (docs: DocRef[], src: Source) => docs.findIndex((d) => docKey(d) === docKey(src) && pageKey(d.loc.split(' · ')[0]) === pageKey(src.loc || ''));
export const docIndex = (docs: DocRef[], src: Source) => Math.max(0, findDoc(docs, src));

export const pageKeyFor = (dealId: string, ref: { doc: string; docId: string; loc: string }) => `${dealId}|${docKey(ref)}|${ref.loc}`;
/** Load a page for reading mode; cached in state so the panel is a pure view. */
export async function loadPage(store: Store, dealId: string, ref: { doc: string; docId: string; loc: string }) {
  const key = pageKeyFor(dealId, ref);
  const cur = store.get().pages[key];
  if (cur && cur !== 'failed') return;
  store.setPage(key, 'loading');
  const r = await store.services.docs.page(dealId, { doc: ref.doc, docId: ref.docId }, ref.loc.split(' · ')[0]);
  store.setPage(key, r.ok ? r.value : r.error.kind === 'notFound' ? { kind: 'missing', message: r.error.message } : 'failed');
  store.touchCached();                                   // opening a document loads it into the store
}
