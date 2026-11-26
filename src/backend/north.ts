/**
 * The model service on North (Cohere): the six calls of ModelService (src/backend/service.ts) on North's REST API,
 * as North's published API reference describes it. Nothing above this file depends on which service is used.
 *
 * - Every call goes to `<address>/api/...` with the person's token as `Authorization: Bearer` (the reference's
 *   overview). The token comes from a SignInToken (src/backend/signInToken.ts): a call waits while nobody is signed in,
 *   and a 401 drops the token, asks for a sign-in and tries the call again with the next token.
 * - whoami: GET /v1/users/me, first and last name. models: GET /v2/models (paged), or /v1/models on a North without v2;
 *   the three tiers are North's names for them from the control file (models.northFast and so on).
 * - complete: POST /v1/chat with `stream: false`, the model's name, the system and user messages, and the documents as
 *   `file_ids`. No agent and no tools are named, so North's default tools read the files (decisions: "AI and models").
 *   One-off calls never name a conversation; `chat` below carries one on, for the conversations that keep theirs.
 *   The chat agent's turns may name function tools (`tools`, `tool_choice: REQUIRED`): the calls come back as the
 *   assistant message's `tool_calls`, and their results go back on the next turn as `tool` messages, by `tool_call_id`
 *   (native), or in the user message (hybrid, for a service that rejects a client tool's `tool` message).
 * - upload: POST /v1/files (multipart), then GET /v1/files/{id} until its status is "processed", since a file that is
 *   still being processed cannot be read. North takes file names in the Latin alphabet only (North's "Using My Files"
 *   guide), so other letters are spelled without accents or replaced; the document id at the front stays.
 * - remove: DELETE /v1/files/{id}; one already gone is not an error. list: GET /v1/files, every page.
 *
 * Failures (the reference's errors page): no connection (a connection that could not be made, or a read that dropped,
 * after two more tries a second and then two apart), or a request that takes longer than `timeoutMs`, is `code:
 * 'unreachable'`, which the backend retries later. A 429 or 503 is retried here after the wait North asks for
 * (Retry-After, or details.retry_after_seconds), with backoff, then counts as unreachable. Any other error fails that
 * one call with North's own message and error code.
 */
import type { ConverseInput, Conversed, ModelService } from './service';
import type { SignInToken } from './signInToken';
import { SERVICE } from '../control';
import { cutOff, limitsOf, saysTooLong, tooLong } from './limits';
import { retryDroppedRequest } from './requestRetry';

export interface NorthOptions {
  /** the North instance, like https://north.example.com (control: north.address) */
  address: string;
  token: SignInToken;
  /** North's names for the three tiers (control: models.northFast, northStandard, northThorough) */
  models: { fast: string; standard: string; thorough: string };
  /** North's own tools sent with the chat agent's function tools, so North still reads the files (control: north.hostedTools) */
  hostedTools?: string[];
  /** for tests: stands in for the network */
  fetch?: typeof fetch;
  /** for tests: how the connector waits between tries */
  sleep?: (ms: number) => Promise<void>;
  /** how often an upload is looked at while North processes it, and for how long at most */
  pollMs?: number; processMs?: number;
  /** tries of a call North says is busy (429, 503) before it counts as unreachable */
  busyTries?: number;
  /** times a call whose connection dropped is tried again before it counts as unreachable; 2 unless set */
  dropTries?: number;
  /** how long one request may take, reply included, before it counts as unreachable (control: timings.modelCall); 10 minutes unless set */
  timeoutMs?: number;
}

/** an error from North: its HTTP status, North's error code and whether North said to retry */
export class NorthError extends Error {
  constructor(message: string, public status: number, public northCode: string, public retryable: boolean, public retryAfterMs?: number) { super(message); }
}

const unreachable = (why: string) => Object.assign(new Error(`${SERVICE} could not be reached: ${why}`), { code: 'unreachable' });

/** a file name North accepts: Latin letters, digits and plain punctuation; accents dropped, anything else an underscore */
export const latinName = (name: string) => name.replace(/[\\/]/g, '_').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ._()&,+'-]/g, '_');

export function northService(o: NorthOptions): ModelService & { chat(input: Parameters<ModelService['complete']>[0] & Partial<ConverseInput>): Promise<Conversed>; agentTools(): Promise<string[]> } {
  const base = `${o.address.replace(/\/+$/, '')}/api`;
  const fetch = o.fetch ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tiers = o.models;
  const pick = (m: string) => (m === 'fast' || m === 'standard' || m === 'thorough' ? tiers[m] : m);
  /**
   * each model's room for a reply and for a request: the control file's limits.outputTokens and limits.inputTokens, or less
   * where /v2/models says the model allows less (`max_tokens`, `context_length`); a model not listed there gets the
   * control file's. Sent as `max_tokens` with every chat (the reference's Chat page), so that North's own default
   * does not decide it.
   */
  const sized = new Map<string, { output: number; input: number }>();
  const limits = (m: string) => sized.get(pick(m)) ?? limitsOf();

  /** one call to North, signed in, retried after a refused token and while North is busy; resolves to the parsed body */
  async function call<T>(method: string, path: string, body?: BodyInit, json = true): Promise<T> {
    let busy = 0, dropped = 0;
    for (;;) {
      const token = await o.token.get();
      let r: Response;
      try { r = await fetch(base + path, { method, signal: AbortSignal.timeout(o.timeoutMs ?? 10 * 60_000), headers: { Authorization: `Bearer ${token}`, ...(json && body ? { 'Content-Type': 'application/json' } : {}) }, body }); }
      catch (e) {
        if (retryDroppedRequest(e, method) && ++dropped <= (o.dropTries ?? 2)) {
          await sleep(1000 * 2 ** (dropped - 1));
          continue;
        }
        throw unreachable((e as Error).message);
      }
      if (r.ok) { try { return (await r.json()) as T; } catch (e) { if (e instanceof SyntaxError) throw e; throw unreachable((e as Error).message); } }   // a reply that stalls past the timeout, or drops
      const e = await failure(r);
      if (e.status === 401) { o.token.refused(token); continue; }        // signed out or expired: wait for a sign-in, then again
      if (e.retryable && ++busy < (o.busyTries ?? 3)) {
        await sleep(Math.min(e.retryAfterMs ?? 1000 * 2 ** busy, 60_000));
        continue;
      }
      if (e.retryable) throw Object.assign(e, { code: 'unreachable' });
      if (saysTooLong(e.status, e.message, method === 'POST' && path === '/v1/files')) throw Object.assign(tooLong(e.message, e.status), { northCode: e.northCode });   // see limits.ts
      throw e;
    }
  }
  return {
    async checkSignIn() { await call('GET', '/v1/users/me'); },
    outputLimit: (m: string) => limits(m).output,
    inputLimit: (m: string) => limits(m).input,
    async whoami() {
      const me = await call<{ first_name?: string; last_name?: string; email?: string }>('GET', '/v1/users/me');
      return { name: [me.first_name, me.last_name].filter(Boolean).join(' ').trim() || me.email || '' };
    },
    async models() {
      let models: { id: string; name: string }[];
      try {
        models = []; let next: string | null | undefined;
        do {
          const q = new URLSearchParams({ limit: '100', ...(next ? { next_token: next } : {}) });
          const page = await call<{ data: { name: string; display_name?: string; max_tokens?: number | null; context_length?: number | null }[]; next_token?: string | null }>('GET', `/v2/models?${q}`);
          for (const m of page.data) { models.push({ id: m.name, name: m.display_name || m.name }); sized.set(m.name, limitsOf({ maxTokens: m.max_tokens, contextLength: m.context_length })); }
          next = page.next_token;
        } while (next);
      } catch (e) {
        if (!(e instanceof NorthError && e.status === 404)) throw e;   // an older North: ids only
        models = (await call<{ id: string }[]>('GET', '/v1/models')).map((m) => ({ id: m.id, name: m.id }));
      }
      const missing = (['fast', 'standard', 'thorough'] as const).filter((t) => !models.some((m) => m.id === tiers[t]));
      if (missing.length) throw new Error(`${SERVICE} does not offer ${missing.map((t) => `${tiers[t]} (the ${t} model in the control file)`).join(', ')}.`);
      return { models, default: tiers.standard, ...tiers };
    },
    async complete(input) { return (await this.chat(input)).text; },
    // A conversation the app keeps carries on in North's own: North holds what was said, so a turn sends only
    // what is new. Its system message goes with the first turn only; a conversation North no longer has is 'gone'.
    async converse(input) {
      try { return await this.chat(input.conversation ? { ...input, system: undefined } : input); }
      catch (e) { if (input.conversation && e instanceof NorthError && e.status === 404 && !/FILE/.test(e.northCode)) throw Object.assign(e, { code: 'gone' }); throw e; }
    },
    async chat(input) {
      const messages = [...(input.system ? [{ role: 'system', content: input.system }] : []), ...(input.results ?? []).map((x) => ({ role: 'tool', tool_call_id: x.id, content: x.text })), { role: 'user', content: input.prompt }];
      // a call that lists tools does not use North's default tools (`tools` on the reference's Chat page): its own are
      // named alongside, so the files are still read
      const tools = input.tools && [...input.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), ...(o.hostedTools ?? []).map((name) => ({ type: 'north_tool', north_tool: { name } }))];
      const r = await call<{ conversation_id: string; finish_reason?: string; messages?: { role?: string; content?: unknown; tool_calls?: { tool_call_id?: string | null; id?: string | null; function?: { name?: string | null; arguments?: string | null } }[] | null }[]; error?: { message?: string; error_code?: string } | null; usage?: { tokens?: { input_tokens?: number | null; output_tokens?: number | null } | null } | null }>('POST', '/v1/chat', JSON.stringify({
        stream: false, model: pick(input.model), max_tokens: limits(input.model).output, messages, ...(input.files?.length ? { file_ids: input.files } : {}), ...(input.conversation ? { conversation: { id: input.conversation } } : {}),
        ...(tools ? { tools, tool_choice: 'REQUIRED' } : {}),
      }));
      const said = (r.messages ?? []).filter((m) => (m.role ?? 'assistant') === 'assistant');
      const text = said.map((m) => textOf(m.content)).join('');
      const calls = said.flatMap((m) => m.tool_calls ?? []).map((c, i) => ({ id: c.tool_call_id || c.id || `call_${i + 1}`, name: c.function?.name ?? '', args: argsOf(c.function?.arguments) }));
      const finish = r.finish_reason ?? 'COMPLETE';
      if (finish === 'MAX_TOKENS') throw cutOff(`${SERVICE}'s reply was cut off at its length limit`, text);   // see claude.ts
      if (finish !== 'COMPLETE' && finish !== 'STOP_SEQUENCE' && !(finish === 'TOOL_CALL' && calls.length)) throw new Error(`${SERVICE} did not finish the reply (${finish}${r.error?.message ? `: ${r.error.message}` : ''})`);
      // what the conversation now holds: this turn's input (everything before it) and its reply
      const t = r.usage?.tokens; const tokens = typeof t?.input_tokens === 'number' ? t.input_tokens + (t.output_tokens ?? 0) : undefined;
      return { text, conversation: r.conversation_id, ...(tokens !== undefined ? { tokens } : {}), ...(calls.length ? { calls } : {}) };
    },
    async upload(file) {
      const form = new FormData();
      form.append('file', new Blob([file.bytes as Uint8Array<ArrayBuffer>]), latinName(file.name));
      let f = await call<{ id: string; status: string; status_details?: string | null }>('POST', '/v1/files', form, false);
      const until = Date.now() + (o.processMs ?? 5 * 60_000);
      while (f.status !== 'processed') {
        if (f.status === 'error') { await this.remove(f.id).catch(() => undefined); throw new Error(`${SERVICE} could not read ${file.name}${f.status_details ? `: ${f.status_details}` : ''}`); }
        if (Date.now() > until) throw new Error(`${SERVICE} was still processing ${file.name} after ${Math.round((o.processMs ?? 300_000) / 1000)} seconds`);
        await sleep(o.pollMs ?? 1000);
        f = await call('GET', `/v1/files/${encodeURIComponent(f.id)}`);
      }
      return f.id;
    },
    async remove(fileId) {
      try { await call('DELETE', `/v1/files/${encodeURIComponent(fileId)}`); } catch (e) { if (!(e instanceof NorthError && e.status === 404)) throw e; }
    },
    /**
     * the names of North's own tools that the person's agents use (GET /v1/agents, the reference's List Agents page),
     * for north.hostedTools
     */
    async agentTools() {
      const agents = await call<{ tools?: { type?: string; north_tool?: { name?: string } }[] | null }[]>('GET', '/v1/agents?limit=100');
      return [...new Set(agents.flatMap((a) => (a.tools ?? []).flatMap((t) => (t.type === 'north_tool' && t.north_tool?.name ? [t.north_tool.name] : []))))].sort();
    },
    async list() {
      const out: { id: string; name: string }[] = []; let next: string | null | undefined;
      do {
        const q = new URLSearchParams({ limit: '1000', ...(next ? { next_token: next } : {}) });
        const page = await call<{ data: { id: string; filename: string }[]; next_token?: string | null }>('GET', `/v1/files?${q}`);
        for (const f of page.data) out.push({ id: f.id, name: f.filename });
        next = page.next_token;
      } while (next);
      return out;
    },
  };
}

/** the text of an assistant message: a plain string, or the `text` parts of a list (thinking and other parts left out) */
/** a tool call's arguments, which North sends as a JSON string; what cannot be read is no arguments */
function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try { const v = JSON.parse(String(raw ?? '')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('');
}

/** a failed response as a NorthError, read from North's error shape where it is one */
async function failure(r: Response): Promise<NorthError> {
  let b: { error_code?: string; message?: string; is_retryable?: boolean; details?: { retry_after_seconds?: number } } = {};
  try { b = await r.json(); } catch { /* not North's shape: the status says enough */ }
  const code = b.error_code ?? r.headers.get('x-north-error-code') ?? '';
  const after = Number(r.headers.get('retry-after') ?? b.details?.retry_after_seconds);
  const retryable = b.is_retryable ?? (r.status === 429 || r.status === 503);
  return new NorthError(`${SERVICE} said ${r.status}${code ? ` ${code}` : ''}: ${b.message ?? r.statusText}`, r.status, code, retryable, Number.isFinite(after) ? after * 1000 : undefined);
}
