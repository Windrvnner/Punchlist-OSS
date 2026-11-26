/**
 * A model service for any server that speaks the OpenAI-compatible API: OpenAI itself, or an organization's own
 * open-source models behind a compatible server. It implements ModelService (src/backend/service.ts), including chat.
 * Choose a compatible route in `models.service` (decisions: AI and models; src/desktop/model.ts).
 *
 * Two ways of asking, chosen by `api`:
 * - 'responses' (the default): the Responses API (POST /responses). It is the one that keeps conversations on the server
 *   (`previous_response_id`, decisions: Long conversations) and that reads documents other than PDFs by file id.
 * - 'chat': chat completions (POST /chat/completions), which most compatible servers offer. It keeps no conversation, so
 *   this connector keeps each one in memory and resends it; servers with prefix caching read the repeated part cheaply.
 *   Only PDFs can be named by file id here, so a text document (a spreadsheet included, once converted) is kept in
 *   memory instead of the server's store and goes in the message as text; it is listed under a local id, so after a
 *   restart the store keeper finds it gone and gives it again. A server with no file store at all can still read text.
 *
 * Routes with a file store upload once (`/files`, purpose "user_data") and refer to files by ID in a call.
 * The store keeper lists and trims files with that purpose. Azure sends the documents inline. LibreOffice converts
 * spreadsheets to .txt so they can be read as text. The connector calls the API with fetch.
 *
 * The connector retries HTTP 408, 429 and 5xx responses up to `maxRetries`. After a connection drop it repeats only
 * reads, deletes or requests that never went out (#454). A request past `timeoutMs` (control: timings.modelCall) or one
 * that cannot be repeated counts as `unreachable` immediately, so checks wait and resume later. A refused key from a
 * sign-in (401, 403) asks for a new one and waits.
 */
import type { ModelService } from './service';
import { credentialFrom, type SignInToken } from './signInToken';
import { inlineDocuments } from './inlineDocuments';
import type { Converter } from './convert';
import { storable } from './claude';
import { SERVICE } from '../control';
import { cutOff as cutOffError, limitsOf, saysTooLong, tooLong } from './limits';
import { retryDroppedRequest } from './requestRetry';

export interface OpenAiOptions {
  /** the server's API root, such as https://api.openai.com/v1 */
  base: string;
  /** which API to ask on: the Responses API (the default), or chat completions for a server without it */
  api?: 'responses' | 'chat';
  /** Azure Responses uses resource keys and inline PDFs. The gateway also uses the authenticated stand-alone route. */
  route?: 'azure' | 'gateway';
  /** the API key, or where the person's signed-in key comes from: calls wait while there is none */
  key: string | SignInToken;
  /** the model for each tier, as the server names them */
  models: { fast: string; standard: string; thorough: string };
  /** who whoami() names; without it whoami() fails and the PC's signed-in user is used (src/backend/session.ts) */
  who?: string;
  /** LibreOffice, for reading a spreadsheet as text; without it a spreadsheet cannot be uploaded */
  convert?: Converter;
  /** for tests: stands in for the network */
  fetch?: typeof fetch;
  /** waits on a busy or failing server before it counts as unreachable; 2 unless set */
  maxRetries?: number;
  /** the first wait in milliseconds, doubling each time; 1000 unless set */
  retryMs?: number;
  /** how long one request may take, reply included, before it counts as unreachable; 10 minutes unless set */
  timeoutMs?: number;
}

const busy = (status: number) => status === 408 || status === 429 || status >= 500;
const away = (message: string) => Object.assign(new Error(message), { code: 'unreachable' });
const SHEET = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;
type Reply = Pick<Response, 'ok' | 'status'> & { text: string };
type Attempt =
  | { kind: 'reply'; reply: Reply }
  | { kind: 'signedOut' }
  | { kind: 'retry'; problem: string; retryAfter?: string | null };
type SkipBody = (status: number) => boolean;

function canRetryConnection(error: unknown, method: string, signal: AbortSignal, reply?: Response): boolean {
  if (signal.aborted) return false;
  // Once headers arrive, the server has seen the request (#454).
  if (reply && (!reply.ok || (method !== 'GET' && method !== 'DELETE'))) return false;
  return retryDroppedRequest(error, method);
}

export function openAiService(o: OpenAiOptions): ModelService {
  const base = o.base.replace(/\/+$/, ''); const go = o.fetch ?? fetch; const timeout = o.timeoutMs ?? 10 * 60_000;
  // room for a reply, and for a request (control: limits.outputTokens, limits.inputTokens): see claude.ts
  const { output: MAX_TOKENS, input: MAX_INPUT } = limitsOf();
  const tier = (m: string) => (m === 'fast' || m === 'standard' || m === 'thorough' ? o.models[m] : m);
  const inline = o.route === 'azure' ? inlineDocuments(o.convert) : undefined;
  const maxRetries = o.maxRetries ?? 2;
  const noFileStore = (status: number) => status === 404 && o.api === 'chat';
  /** Receipt includes the response body so a dropped read or delete can share the request's retry budget. */
  async function request(path: string, init: RequestInit = {}, skipBody?: SkipBody): Promise<Reply> {
    for (let tries = 0; ; tries++) {
      const { token, kind } = await credentialFrom(o.key);
      const headers = new Headers(init.headers);
      if (o.route === 'azure' && kind === 'apiKey') headers.set('api-key', token);
      else headers.set('authorization', `Bearer ${token}`);
      const attempt = await send(path, { ...init, headers }, skipBody);
      switch (attempt.kind) {
        case 'reply': return attempt.reply;
        case 'signedOut':
          if (typeof o.key !== 'string') o.key.refused(token);
          break;
        case 'retry':
          if (tries >= maxRetries) throw away(attempt.problem);
          await wait(tries, attempt.retryAfter);
          break;
      }
    }
  }

  /** Send one HTTP attempt and read its body with the same deadline as the headers. */
  async function send(path: string, init: RequestInit, skipBody?: SkipBody): Promise<Attempt> {
    const signal = AbortSignal.timeout(timeout);
    let response: Response | undefined;
    try {
      response = await go(`${base}${path}`, { ...init, signal, ...(o.route ? { redirect: 'error' } : {}) });
      return await readAttempt(response, skipBody);
    } catch (e) {
      const problem = response ? 'stopped answering' : 'could not be reached';
      const message = `${SERVICE} ${problem}: ${(e as Error).message}`;
      if (!canRetryConnection(e, init.method ?? 'GET', signal, response)) throw away(message);
      return { kind: 'retry', problem: message };
    }
  }

  async function readAttempt(response: Response, skipBody?: SkipBody): Promise<Attempt> {
    const { status, ok } = response;
    if ((status === 401 || status === 403) && typeof o.key !== 'string') {
      void response.body?.cancel().catch(() => undefined);
      return { kind: 'signedOut' };
    }
    if (busy(status)) {
      const retryAfter = response.headers.get('retry-after');
      return { kind: 'retry', problem: `${SERVICE} is busy (${status})`, retryAfter };
    }

    const skip = skipBody?.(status);
    if (skip) void response.body?.cancel().catch(() => undefined);
    const text = skip ? '' : await response.text();
    return { kind: 'reply', reply: { ok, status, text } };
  }
  const wait = (tries: number, after?: string | null) => new Promise((res) => setTimeout(res, after && +after >= 0 ? Math.min(+after * 1000, 60_000) : (o.retryMs ?? 1000) * 2 ** tries));
  /** the body of a response that should have succeeded; an error that says what the server said otherwise */
  function parseReply<T>(r: Reply, upload = false): T {
    const { text } = r;
    let parsed: unknown; try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    // the status goes with the error, so that a model that refuses tools (400, 422) steps down to the next way of calling them (ai.ts)
    const err = (parsed as { error?: { message?: string; param?: string | null; code?: string | null } } | undefined)?.error;
    if (!r.ok && !upload && (err?.code === 'context_length_exceeded' || saysTooLong(r.status, err?.message ?? text.slice(0, 500)))) throw tooLong(`${SERVICE} said the request is too long: ${err?.message ?? r.status}`, r.status);
    if (!r.ok) throw Object.assign(new Error(`${SERVICE} said ${r.status}: ${err?.message ?? text.slice(0, 200)}`), { status: r.status, param: err?.param ?? undefined });
    if (parsed === undefined) throw new Error(`${SERVICE} sent a reply that is not JSON`);
    return parsed as T;
  }
  const post = <T>(path: string, payload: Record<string, unknown>) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  }).then((r) => parseReply<T>(r));
  const declined = () => new Error(`${SERVICE} declined to answer this`);
  const cutOff = (text?: string) => cutOffError(`${SERVICE}'s reply was cut off at ${MAX_TOKENS} tokens`, text);   // see claude.ts
  // a message's documents and question, as each API writes them
  const inputParts = (files: string[] | undefined, text: string) => {
    const documents = inline?.parts(files, (file) => file.type === 'application/pdf'
      ? { type: 'input_file', filename: file.name, file_data: `data:application/pdf;base64,${file.data}` }
      : { type: 'input_text', text: `Document "${file.name}":\n${file.data}` });
    const parts = documents ?? (files ?? []).map((id) => ({ type: 'input_file', file_id: id }));
    return [...parts, { type: 'input_text', text }];
  };
  const chatParts = (files: string[] | undefined, text: string) => [...(files ?? []).map((id) => { const t = local.get(id); return t ? { type: 'text', text: `Document "${t.name}":\n${t.text}` } : { type: 'file', file: { file_id: id } }; }), { type: 'text', text }];
  const local = new Map<string, { name: string; text: string }>(); let localN = 0;   // on chat completions, the text documents, by a local id

  const talks = new Map<string, ChatMessage[]>(); let talkN = 0;                 // the conversations kept here, on chat completions
  const pending = new Map<string, string[]>();                                      // a response's id → the tools it called, still to be answered
  /** the tools a response called, asked of the server when this PC did not make it (the conversation began on another PC, or before a restart) */
  async function calledIn(id: string): Promise<string[]> {
    try {
      const reply = parseReply<Responded>(await request(`/responses/${encodeURIComponent(id)}`));
      return (reply.output ?? []).flatMap((i) => (i.type === 'function_call' && i.call_id ? [i.call_id] : []));
    }
    catch (e) { if ((e as { status?: number }).status === 404) throw Object.assign(new Error(`${SERVICE} no longer has this conversation`), { code: 'gone' }); throw e; }
  }
  /** the server no longer has the response a turn carries on from (stored responses expire) */
  const gone = (e: unknown) => { const x = e as { status?: number; param?: string; message?: string }; return (x.status === 400 || x.status === 404) && (x.param === 'previous_response_id' || /previous.?response/i.test(x.message ?? '')); };

  /** one call to the Responses API: its id, the reply's text, the tools it called and the tokens the conversation now holds */
  async function respond(payload: Record<string, unknown>): Promise<{ id: string; text: string; calls: Called[]; tokens?: number }> {
    const r = await post<Responded>('/responses', { ...payload, max_output_tokens: MAX_TOKENS });
    if (r.status === 'failed') throw new Error(`${SERVICE} did not finish the reply${r.error?.message ? `: ${r.error.message}` : ''}`);
    const out = r.output ?? []; const parts = out.flatMap((i) => (i.type === 'message' ? i.content ?? [] : []));
    if (r.status === 'incomplete') throw r.incomplete_details?.reason === 'content_filter' ? declined() : cutOff(parts.map((c) => (c.type === 'output_text' ? c.text ?? '' : '')).join(''));
    if (parts.some((c) => c.type === 'refusal')) throw declined();
    const calls = out.flatMap((i) => (i.type === 'function_call' && i.call_id ? [{ id: i.call_id, name: i.name ?? '', args: argsOf(i.arguments) }] : []));
    const u = r.usage; const tokens = typeof u?.input_tokens === 'number' ? u.input_tokens + (u.output_tokens ?? 0) : undefined;
    return { id: r.id, text: parts.map((c) => (c.type === 'output_text' ? c.text ?? '' : '')).join(''), calls, ...(tokens !== undefined ? { tokens } : {}) };
  }
  /** one call to chat completions: the reply's text, the tools it called, the message to keep and the tokens it holds */
  async function chat(payload: Record<string, unknown>): Promise<{ text: string; calls: Called[]; message: ChatMessage; tokens?: number }> {
    const r = await post<{ choices?: { message?: ChatMessage & { refusal?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>('/chat/completions', { ...payload, max_tokens: MAX_TOKENS });
    const c = r.choices?.[0]; if (!c) throw new Error(`${SERVICE} sent no answer`);
    if (c.message?.refusal || c.finish_reason === 'content_filter') throw declined();
    if (c.finish_reason === 'length') throw cutOff(typeof c.message?.content === 'string' ? c.message.content : '');
    const calls = (c.message?.tool_calls ?? []).map((x) => ({ id: x.id, name: x.function?.name ?? '', args: argsOf(x.function?.arguments) }));
    const text = typeof c.message?.content === 'string' ? c.message.content : '';
    const u = r.usage; const tokens = typeof u?.prompt_tokens === 'number' ? u.prompt_tokens + (u.completion_tokens ?? 0) : undefined;
    return { text, calls, message: { role: 'assistant', content: text || null, ...(c.message?.tool_calls?.length ? { tool_calls: c.message.tool_calls } : {}) }, ...(tokens !== undefined ? { tokens } : {}) };
  }

  return {
    // the model list needs the key and runs nothing; a server without one (404) still let the key through
    async checkSignIn() {
      const r = await request('/models', undefined, () => true);
      if (!r.ok && (r.status !== 404 || o.route === 'azure')) {
        throw Object.assign(new Error(`${SERVICE} said ${r.status}`), { status: r.status });
      }
    },
    outputLimit: () => MAX_TOKENS,
    inputLimit: () => MAX_INPUT,
    async whoami() { if (!o.who) throw new Error('this server does not say who is signed in'); return { name: o.who }; },
    async models() {
      const ids = [...new Set([o.models.fast, o.models.standard, o.models.thorough])];
      return { models: ids.map((id) => ({ id, name: id })), default: o.models.standard, ...o.models };
    },
    async complete(input) {
      if (o.api === 'chat') return (await chat({ model: tier(input.model), messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), { role: 'user', content: chatParts(input.files, input.prompt) }] })).text;
      return (await respond({ model: tier(input.model), ...(input.system ? { instructions: input.system } : {}), input: [{ role: 'user', content: inputParts(input.files, input.prompt) }], store: false })).text;
    },
    // A chat's conversation. On the Responses API the server keeps it: each turn names the last response by its id
    // and sends only what is new, and the system prompt goes in as the first turn's opening message, since `instructions`
    // are not carried on. On chat completions it is kept here and resent; after a restart it is gone, and the app carries
    // on in a new conversation with the transcript attached. Every tool the model called on the turn before is answered
    // first, as both APIs require: with its result (native), or pointing to the message, where the result is (hybrid).
    async converse(input) {
      const model = tier(input.model);
      const answer = (ids: string[]) => ids.map((id) => ({ id, text: input.results?.find((x) => x.id === id)?.text || 'Its result is in the message that follows.' }));
      if (o.api === 'chat') {
        let id = input.conversation; let c = id ? talks.get(id) : undefined;
        if (id && !c) throw Object.assign(new Error(`${SERVICE} no longer has this conversation`), { code: 'gone' });
        if (!c || !id) { id = `talk_${++talkN}_${Date.now().toString(36)}`; c = input.system ? [{ role: 'system', content: input.system }] : []; talks.set(id, c); }
        const before = c.at(-1)?.tool_calls?.map((x) => x.id) ?? [];
        const messages: ChatMessage[] = [...c, ...answer(before).map((x) => ({ role: 'tool', tool_call_id: x.id, content: x.text })), { role: 'user', content: chatParts(input.files, input.prompt) }];
        const tools = input.tools?.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
        const r = await chat({ model, messages, ...(tools ? { tools, tool_choice: 'required' } : {}) });
        talks.set(id, [...messages, r.message]);                                 // kept only once the turn is whole
        return { text: r.text, conversation: id, ...(r.tokens !== undefined ? { tokens: r.tokens } : {}), ...(r.calls.length ? { calls: r.calls } : {}) };
      }
      const last = input.conversation;
      const before = last ? pending.get(last) ?? await calledIn(last) : [];
      const tools = input.tools?.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
      let r: Awaited<ReturnType<typeof respond>>;
      try {
        r = await respond({
          model, store: true, ...(last ? { previous_response_id: last } : {}), ...(tools ? { tools, tool_choice: 'required' } : {}),
          input: [...answer(before).map((x) => ({ type: 'function_call_output', call_id: x.id, output: x.text })), ...(!last && input.system ? [{ role: 'system', content: input.system }] : []), { role: 'user', content: inputParts(input.files, input.prompt) }],
        });
      } catch (e) { if (last && gone(e)) throw Object.assign(e as Error, { code: 'gone' }); throw e; }
      pending.set(r.id, r.calls.map((x) => x.id)); if (pending.size > 200) pending.delete(pending.keys().next().value!);
      return { text: r.text, conversation: r.id, ...(r.tokens !== undefined ? { tokens: r.tokens } : {}), ...(r.calls.length ? { calls: r.calls } : {}) };
    },
    async upload(file) {
      if (inline) return inline.upload(file);
      const { bytes, type } = await storable(file, o.convert);
      const name = `${file.name.replace(/[\\/]/g, '_')}${type === 'text/plain' && SHEET.test(file.name) ? '.txt' : ''}`;   // a converted sheet is text, and named so
      if (o.api === 'chat' && type === 'text/plain') { const id = `local_${++localN}_${Date.now().toString(36)}`; local.set(id, { name, text: new TextDecoder().decode(bytes) }); return id; }
      const form = new FormData(); form.set('purpose', 'user_data'); form.set('file', new Blob([bytes as BlobPart], { type }), name);
      const res = await request('/files', { method: 'POST', body: form }, noFileStore);
      if (res.status === 404 && o.api === 'chat') throw new Error(`${SERVICE} has no file store, so only text documents can be read, not ${file.name}`);
      const r = parseReply<{ id?: string }>(res, true);   // Apply the upload error rules to the response.
      if (!r.id) throw new Error(`${SERVICE} kept no id for ${file.name}`);
      return r.id;
    },
    async remove(fileId) {
      if (inline) return inline.remove(fileId);
      if (local.delete(fileId) || fileId.startsWith('local_')) return;
      const r = await request(`/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' }, (status) => status === 404);
      if (r.status !== 404) parseReply(r);
    },
    async list() {
      if (inline) return inline.list();
      const out = [...local.entries()].map(([id, f]) => ({ id, name: f.name }));
      for (let after = ''; ;) {
        const path = `/files?purpose=user_data&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        const res = await request(path, undefined, noFileStore);
        if (res.status === 404 && o.api === 'chat') return out;                 // a server with no file store: only the text kept here
        const r = parseReply<ListedFiles>(res);
        for (const f of r.data ?? []) { if (f.purpose && f.purpose !== 'user_data') continue; out.push({ id: f.id, name: f.filename }); }
        const last = r.last_id ?? r.data?.at(-1)?.id;
        if (!r.has_more || !last || last === after) return out;               // a server that does not page sends everything at once
        after = last;
      }
    },
  };
}

type Called = { id: string; name: string; args: Record<string, unknown> };
type ListedFiles = {
  data?: { id: string; filename: string; purpose?: string }[];
  has_more?: boolean;
  last_id?: string;
};
/** what the Responses API sends back, as much of it as this connector reads */
type Responded = { id: string; status?: string; incomplete_details?: { reason?: string } | null; error?: { message?: string } | null; output?: { type: string; content?: { type: string; text?: string }[]; call_id?: string; name?: string; arguments?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
/** a chat completions message, as kept for a conversation and resent */
type ChatMessage = { role: string; content: unknown; tool_calls?: { id: string; type?: string; function?: { name?: string; arguments?: string } }[]; tool_call_id?: string };

/** a tool call's arguments, which both APIs send as a JSON string; what cannot be read is no arguments */
function argsOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  try { const v = JSON.parse(String(raw ?? '')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
