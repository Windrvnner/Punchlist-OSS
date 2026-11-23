/**
 * Conversations: a person's own working threads with the AI. Never a record: kept in
 * the person's own files in the shared folder (the window's store is only a cache), keyed by scope. An answer is applied only to the pending
 * message it was requested for, so navigating, retrying or deleting mid-flight
 * cannot misplace it.
 */
import { isMine } from './commands/members';
import type { Store } from './store';
import { dealHash, pageHash, dealQuestions, type State, type Message } from './state';
import { docKey, ownFilesId, type Source } from '../domain/model';
import { CreateQuestion, UseAsResponse } from './commands/questions';
import { mayAddress } from '../domain/suggest';
import { withoutMarkers } from '../domain/cite';
import type { Research } from '../ports';
import { bareDealName, cleanName } from './commands/deals';
import { filesSendable } from './attachments';

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
    const preview = !ai ? '' : ai.state === 'pending' ? 'Answering…' : ai.state === 'failed' ? 'Couldn’t get an answer' : oneLine(withoutMarkers(ai.text.replace(/\{([^|}]+)\|f_[0-9A-Z]{26}\}/g, '$1'), ai.sources?.length ?? 0));
    const about = scope.kind === 'finding' ? s.findings[scope.findingId]?.title ?? 'Finding' : scope.kind === 'question' ? (s.questions[scope.questionId] ? `Q${s.questions[scope.questionId].n}` : 'Question') : undefined;
    out.push({ key, scope, dealId, about, title: oneLine(first.text), preview, at: last.at, words: list.map((m) => m.text).join(' ').toLowerCase() });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

let seq = 0;
const mid = () => `m${Date.now().toString(36)}${(seq++).toString(36)}`;

// #500: only the explicit verb and page suffix are syntax; a deal name can contain punctuation or Unicode.
function typedDealDestination(store: Store, text: string) {
  const command = /^(?:take me to|go to|open|show me|show|switch to|jump to)\s+(.+)$/is.exec(text);
  if (!command) return;
  const target = cleanName(command[1]);
  const lookup = (name: string) => {
    const key = bareDealName(name.trim(), 'navigation').toLowerCase();
    if (!key) return;
    return Object.values(store.get().deals).find((candidate) =>
      bareDealName(candidate.name, 'navigation').toLowerCase() === key);
  };
  const possessive = (name: string) => lookup(name.replace(/['’]s$/i, '')) ?? lookup(name);
  const named = (name: string) => {
    const withoutArticle = name.replace(/^the\s+/i, '');
    return possessive(withoutArticle) ?? (withoutArticle !== name ? possessive(name) : undefined);
  };
  const suffix = /^(.+?)\s+(q ?& ?a|questions|findings|checklist|overview)$/i.exec(target);
  const deal = suffix && named(suffix[1]);
  return deal ? { deal, page: suffix[2].toLowerCase() } : { deal: named(target), page: '' };
}

/** "Go to Proseware findings", "open Trey Q&A", "new deal". Resolved against loaded deals; no service call. */
export function navIntent(store: Store, text: string): boolean {
  const t = text.trim();
  if (/^(new|create|add|start) (a )?(new )?deal\b/i.test(t)) { store.ui({ newDeal: { name: '', folders: [], error: '', busy: false } }); return true; }
  const destination = typedDealDestination(store, t);
  if (!destination?.deal) return false;
  const { deal, page } = destination;
  location.hash = page
    ? pageHash(/q|question/.test(page) ? 'qa' : page as 'findings' | 'checklist' | 'overview', deal.id)
    : dealHash(store.get().prefs, deal.id);
  return true;
}

/** "Add all unresolved to Q&A", typed in a deal's ask box: opens the same preview as the Checklist's ⋯ menu (decisions, #2) */
export function unresolvedIntent(store: Store, dealId: string, text: string): boolean {
  if (!/^(?:please\s+)?add (?:all )?(?:the )?unresolved(?: (?:items|points|gaps(?: and(?: open)? findings)?))?(?: (?:to|into|in) (?:the )?(?:q ?& ?a|questions))?\s*[.!]?$/i.test(text.trim())) return false;
  store.ui({ dialog: { kind: 'addUnresolved', dealId } }); return true;
}

/**
 * "add a question: …" on a deal. 'none' when the text is not that command; otherwise whether the question was made.
 * A refusal (storage full, a copied install, …) has already been told to the person by the store, except for input it
 * rejects before planning, which is said here; the caller keeps the typed text so nothing is lost.
 */
export async function questionIntent(store: Store, dealId: string, text: string): Promise<'none' | 'made' | 'refused'> {
  const m = /^(?:add|log) (?:a )?question[:\s]+(.+)/is.exec(text.trim());
  if (!m) return 'none';
  const r = await store.dispatch(CreateQuestion, { dealId, text: m[1].trim() }, { idempotencyKey: 'ask-addq-' + dealId, noRetry: true });   // the text goes back in the box, which is the way to try again: a Retry as well could log it twice
  if (r.ok) return 'made';
  if (r.error.kind === 'invalid') store.toast(r.error.message);
  return 'refused';
}

/** "Does this answer any of our open questions?", "would that address an open question": a person asking in words */
export const asksOpenQuestions = (text: string) => /\b(answer|address|respond|cover|settle|resolve)\w*\b.*\bopen questions?\b|\bopen questions?\b.*\b(answer|address|cover|settle|resolve)\w*\b/i.test(text);
/** the app's own reply to that, at `i`: it stands for no answer of its own, so nothing is suggested under it */
const isCheck = (list: Message[], i: number) => list[i].role === 'ai' && list[i - 1]?.role === 'me' && asksOpenQuestions(list[i - 1].text);
/**
 * The reply to a person asking whether the answer above addresses any open question. No model is asked: the answer is
 * checked as every answer is (suggestions), and the card under it shows again if a person had put it away.
 */
function checkOpenQuestions(store: Store, scope: Scope & { dealId: string }, prior: Message[]): string {
  let j = prior.length - 1; while (j >= 0 && (prior[j].role !== 'ai' || prior[j].state !== 'done' || isCheck(prior, j))) j--;
  if (j < 0) return 'There is no answer in this conversation yet to check against the open questions.';
  const id = prior[j].id; store.bringBack(id);
  const q = store.get().questions[suggestions(store.get(), scope).get(id) ?? ''];
  return q ? `The answer above may address Q${q.n}: “${q.text}” It is named under that answer, to check and use as the response if it does.` : 'None of the open questions looks to be addressed by the answer above.';
}

export async function ask(store: Store, scope: Scope, text: string) {
  text = text.trim(); if (!text) return;
  const ro = store.readOnly(); if (ro) { store.toast(ro); return; }   // read-only while nobody is signed in: nothing new is asked
  const key = convKey(scope);
  const atts = store.get().ui.attachments.filter((a) => a.conv === key && a.state === 'done' && a.doc && a.docId);
  if (atts.length) store.ui((ui) => ({ attachments: ui.attachments.filter((a) => !atts.includes(a)) }));
  const prior = store.get().threads[key] ?? [];
  const sent = atts.map((a) => ({ doc: a.doc!, docId: a.docId! }));
  const me: Message = { id: mid(), role: 'me', text, state: 'done', at: store.services.clock.now(), ...(sent.length ? { attached: sent } : {}) };
  if ((scope.kind === 'deal' || scope.kind === 'finding') && asksOpenQuestions(text)) { store.setThread(key, [...prior, me, { id: mid(), role: 'ai', text: checkOpenQuestions(store, scope, prior), state: 'done', at: me.at }]); return; }
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
  const ro = store.readOnly(); if (ro) { store.toast(ro); return; }
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
export const answerText = (m: Message) => withoutMarkers(m.text.replace(/\{([^|}]+)\|f_[0-9A-Z]{26}\}/g, '$1'), m.sources?.length ?? 0);
/** A person makes an answer the response to a question: with the answer's own sources, and once however often it is pressed. */
export const useAnswer = (store: Store, dealId: string, questionId: string, m: Message) => store.dispatch(UseAsResponse, { dealId, questionId, text: answerText(m), sources: m.sources ?? [] }, { idempotencyKey: 'use-' + m.id });

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
    const m = list[i]; if (m.role !== 'ai' || m.state !== 'done' || isCheck(list, i)) continue;
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
