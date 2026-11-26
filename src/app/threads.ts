/**
 * Rules for a conversation's list of messages that both the store and the conversation screens rely on, and where a
 * window keeps conversations when nothing else does. Kept apart from conversations.ts so the store can use them without
 * importing the screens' code.
 */
import { z } from 'zod';
import type { Message } from './state';
import { Source } from '../domain/model';
import type { ConversationStore, KeptMessage, LocalStore } from '../ports';
import { ok } from '../domain/result';

/** The id given to the stand-in answer of a question whose answer never arrived (see `paired`). */
export const unanswered = (questionId: string) => `${questionId}~unanswered`;
const isStandIn = (m: Message) => m.id.endsWith('~unanswered');

/**
 * The messages as question-and-answer pairs, in order: every question is followed by exactly one answer. Screens pair
 * messages by position, so this must hold even when the list was put together from several PCs:
 *  - a question with no answer (asked on a PC that closed before the answer came) gets a failed stand-in answer, which
 *    the person can retry. Its id comes from the question's, so every PC makes the same one and it is kept only once;
 *  - a question with more than one answer keeps one: one still being worked on here, else the latest finished one; a
 *    failed stand-in gives way to any real answer;
 *  - an answer with no question before it is left out of the list (it stays in the person's files).
 */
export function paired(list: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < list.length; ) {
    const q = list[i];
    if (q.role !== 'me') { i++; continue; }
    const answers: Message[] = [];
    let j = i + 1; while (j < list.length && list[j].role === 'ai') answers.push(list[j++]);
    const real = answers.filter((a) => !(isStandIn(a) && a.state === 'failed'));
    const one = real.find((a) => a.state === 'pending') ?? [...real].reverse().find((a) => a.state === 'done') ?? real[real.length - 1]
      ?? answers[0] ?? { id: unanswered(q.id), role: 'ai' as const, text: '', state: 'failed' as const, at: q.at };
    out.push(q, one); i = j;
  }
  return out;
}


/**
 * One conversation as kept (`kept`) and as this window holds it (`here`), merged by message id. A kept message stands
 * unless the kept copy is not answered and this window has it waiting for its answer, or answered (a retry whose saving
 * failed); a finished answer is never replaced by one that is not. A message only this window has stays. Returns the
 * messages in order, as pairs, and whether this window holds a finished message the kept copy lacks, or a stand-in answer
 * was added: then it is kept.
 */
export function merged(kept: Message[], here: Message[]): { list: Message[]; unkept: boolean } {
  const known = new Map(kept.map((m) => [m.id, m])); const out = new Map(known); let unkept = false;
  for (const m of here) {
    const k = known.get(m.id);
    if (!k || (k.state !== 'done' && (m.state === 'pending' || m.state === 'done'))) { out.set(m.id, m); if (m.state !== 'pending') unkept = true; }
  }
  const order = (m: Message) => here.findIndex((x) => x.id === m.id);
  const list = paired([...out.values()].sort((a, b) => (a.at !== b.at ? (a.at < b.at ? -1 : 1) : a.role !== b.role ? (a.role === 'me' ? -1 : 1) : order(a) - order(b))));
  return { list, unkept: unkept || list.some((m) => !out.has(m.id)) };
}

/** what the chat agent did for an answer, as it is kept with the answer */
const Research = z.object({ steps: z.array(z.object({ kind: z.enum(['search', 'read', 'stop']), text: z.string(), result: z.string(), done: z.boolean(), found: z.array(z.object({ where: z.string(), quote: z.string() })).optional() })), ms: z.number(), read: z.object({ docs: z.number(), of: z.number() }).optional() });
/** the model service's conversation an answer left, as it is kept with the answer */
const Thread = z.object({
  id: z.string().min(1), model: z.string(), tokens: z.number(),
  tags: z.array(z.object({ tag: z.string(), dealId: z.string(), docId: z.string() })),
  transcript: z.string().optional(), call: z.string().optional(),
  questions: z.array(z.object({ handle: z.string(), id: z.string() })).optional(),
});
/** the action offered under an answer (#1054), as it is kept with the answer */
const Offer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('newDeal') }),
  z.object({ kind: z.literal('page'), dealId: z.string(), page: z.enum(['overview', 'findings', 'checklist', 'qa']) }),
  z.object({ kind: z.literal('unresolved'), dealId: z.string() }),
  z.object({ kind: z.literal('question'), text: z.string() }),
]);
const Kept = z.object({
  id: z.string(),
  role: z.enum(['me', 'ai']),
  text: z.string(),
  sources: z.array(Source).optional(),
  state: z.enum(['done', 'pending', 'failed']),
  at: z.string(),
  attached: z.array(z.object({ doc: z.string(), docId: z.string().min(1) })).optional(),
  research: Research.optional(),
  thread: Thread.optional(),
  offer: Offer.optional(),
});
/**
 * Conversations kept in the window's local store, for a Store given no ConversationStore (the browser demo). A save adds
 * messages to a conversation by id and never writes the whole set back, so two windows asking in one conversation each
 * keep their messages. An answer still waiting is kept too, so another window shows it waiting. A finished answer is
 * never written over by a copy that is not (a window still showing another window's answer as waiting), so one window
 * cannot take back another's answer. One damaged conversation does not cost the others.
 */
export function localConversations(local: LocalStore): ConversationStore {
  const read = (): Record<string, KeptMessage[]> => {
    const raw = local.read('threads'); const out: Record<string, KeptMessage[]> = {};
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [key, list] of Object.entries(raw)) { const t = z.array(Kept).safeParse(list); if (t.success) out[key] = t.data as KeptMessage[]; }
    return out;
  };
  return {
    async load() { return ok(read()); },
    async save(key, messages) {
      const all = read(); const byId = new Map((all[key] ?? []).map((m) => [m.id, m]));
      for (const m of messages) if (byId.get(m.id)?.state !== 'done' || m.state === 'done') byId.set(m.id, m);
      return local.write('threads', { ...all, [key]: [...byId.values()] });
    },
    ...(local.watch ? { watch: (onChange: () => void) => local.watch!((key) => { if (key === 'threads') onChange(); }) } : {}),
  };
}
