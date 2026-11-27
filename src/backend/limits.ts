/**
 * How long a call to the model may be, both ways, and what a connector says when a call goes past it. A deployment may
 * cut a reply off, or refuse a request, at a limit the app cannot know in advance, so every connector reports both the
 * same way and the backend splits the work and asks again (decisions: Cut-off output).
 *
 * - A reply cut off at the output limit throws with `code: 'cutoff'`, and `text`, what came before the cut.
 * - A request refused as longer than the model takes throws with `code: 'toolong'`.
 */
import { control, SERVICE, AI_LABEL } from '../control';

/** a reply that stopped at the output limit, with what text came before the cut when there was any */
export const cutOff = (message: string, text?: string) => Object.assign(new Error(message), { code: 'cutoff', ...(text ? { text } : {}) });
/** a request the service refused as too long for the model */
export const tooLong = (message: string, status?: number) => Object.assign(new Error(message), { code: 'toolong', ...(status !== undefined ? { status } : {}) });
/** what a person is told when a reply stays cut off at the length limit, or a request stays too long, after the work was split, sent with fewer documents or asked for shorter */
export const TOO_LONG_REPLY = `The reply was longer than ${SERVICE} allows.`;   // the service named as the control file names it
export const TOO_LONG_ASK = `This was too long to send to ${SERVICE}.`;
// a failed call, named with the app's word for the AI, never "the model"
export const UNREAD_REPLY = `The ${AI_LABEL}’s reply could not be read`;
export const UNUSABLE_REPLY = `The ${AI_LABEL}’s reply could not be used`;
export const UNREACHED = `The ${AI_LABEL} could not be reached`;
export const CUT_ON_IT = `The ${AI_LABEL}’s reply on it was cut off at the length limit.`;
export const CUT_BEFORE_IT = `It was not checked: the ${AI_LABEL}’s replies on the items before it were cut off`
  + ' at the length limit.';
export const UNUSABLE_ON_IT = `The ${AI_LABEL}’s reply on it could not be used.`;
export const isCutOff = (e: unknown) => (e as { code?: string } | null)?.code === 'cutoff';
export const isTooLong = (e: unknown) => (e as { code?: string } | null)?.code === 'toolong';

/**
 * Whether a refusal says the request was longer than the model takes, so that sending less would help. Providers word it
 * differently ("prompt is too long", "maximum context length", "context_length_exceeded", "input token count … exceeds",
 * "input length and max_tokens exceed context limit"), so the wording is matched loosely, and only on a status that
 * refuses a request (400, 413, 422). A 413 (the request is too large) counts whatever its body says, since a proxy may
 * answer it with a page of its own, except on an upload, where it is about the file. North documents no code for it, so
 * its wording is a guess.
 *
 * Not counted: a field too long (a tool's description, a name), a rate limit in tokens per minute, and a limit on the
 * reply, which is the control file's to fix. A refusal may name the input and the reply limit together: where it gives
 * the input's size and the model's context, it counts only when the input alone takes more than half the context;
 * without those numbers, it counts unless it names the reply limit and not the input.
 */
export function saysTooLong(status: number | undefined, message: string, upload = false): boolean {
  if (upload) return false;
  if (status === 413) return true;
  if ((status !== 400 && status !== 422) || !/prompt is too long|input is too long|too many (input |prompt )?tokens|context.?(length|window|limit)|maximum context|input token count|exceeds? .{0,60}(context|input tokens|prompt|maximum number of tokens|token limit)|request (entity )?too large|inputs.? tokens|inputs.? must have less than/i.test(message)) return false;
  if (/string too long|name too long|\btools?\b.{0,40}description|description.{0,40}\btools?\b|per (minute|second|hour|day)|rate.?limit/i.test(message)) return false;
  if (!/max_tokens|max_completion_tokens|max_new_tokens|max_output_tokens|output tokens|in the completion/i.test(message)) return true;
  const n = (x: string | undefined) => (x ? Number(x.replace(/,/g, '')) : undefined);
  const sum = /(\d[\d,]*)\s*\+\s*\d[\d,]*\s*>\s*(\d[\d,]*)/.exec(message);            // "188240 + 16000 > 200000": input + reply > context
  const input = n(sum?.[1] ?? /(\d[\d,]*)\s*(?:input tokens|`?inputs`? tokens|in the messages|tokens? in the (?:prompt|input))/i.exec(message)?.[1]);
  const context = n(sum?.[2] ?? /context (?:length|window|limit)\D{0,12}(\d[\d,]*)|must be <= (\d[\d,]*)/i.exec(message)?.slice(1).find(Boolean));
  if (input !== undefined && context) return input > context / 2;
  return /\binput\b|messages|prompt/i.test(message);
}

/**
 * About how many tokens a text holds, counted on the high side: a token is taken as `limits.charsPerToken` characters
 * (three; English prose averages about four), so that work sized by it fits. Only the text the app writes can be counted: documents are read
 * by the service, so a request too long for them is found out when it is refused.
 */
export const tokensOf = (text: string) => Math.ceil(text.length / control.limits.charsPerToken);

/** the most tokens one reply may hold, and one request may send: the control file's values, or less where a model allows less */
export function limitsOf(model?: { maxTokens?: number | null; contextLength?: number | null }): { output: number; input: number } {
  // a reply never takes more than half of a model's context, so a small model is left room for the request
  const output = Math.max(1, Math.min(control.limits.outputTokens, positive(model?.maxTokens) ?? Infinity, Math.floor((positive(model?.contextLength) ?? Infinity) / 2)));
  const input = Math.min(control.limits.inputTokens, (positive(model?.contextLength) ?? Infinity) - output);
  return { output, input: Math.max(1, input) };
}
const positive = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);

/**
 * How much of each draft's tracked-change list a request lists: all of it at first, then half for each refusal as too
 * long, the rest counted, until none is listed, before any document is left out (#1381). `listed` is how many passages
 * the last request listed, and `docs` the documents it sent: other documents start again from all of their changes.
 */
export type ChangeShare = { halvings: number; listed: number; docs: string };
export const allChanges = (): ChangeShare => ({ halvings: 0, listed: 0, docs: '' });
/** before a request is listed: the changes of documents other than the last request's are all listed again */
export function changesFor(share: ChangeShare, docs: string): void {
  if (share.docs !== docs) share.halvings = 0;
  share.docs = docs;
  share.listed = 0;
}
/** after a refusal: whether listing fewer changes could shorten the request, in which case it now will */
export function fewerChanges(share: ChangeShare, e: unknown): boolean {
  if (!isTooLong(e) || !share.listed) return false;
  share.halvings++;
  return true;
}
/** `run` again with fewer changes listed, while a refusal as too long can be met that way */
export async function withFewerChanges<T>(run: (share: ChangeShare) => Promise<T>): Promise<T> {
  const share = allChanges();
  for (;;) {
    try {
      return await run(share);
    } catch (e) {
      if (!fewerChanges(share, e)) throw e;
    }
  }
}
