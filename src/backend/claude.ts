/**
 * A model service on Claude, through the Anthropic API. It fills the same six calls as the other connectors
 * (src/backend/service.ts), so the backend runs on it unchanged, and nothing above this file depends on which service
 * is used. The opt-in live tests use this connector.
 *
 * This connector uploads documents through the Files API. Files stay there between runs, and another PC using the same
 * key can list and reuse them. The API reads PDFs and plain text, so LibreOffice converts spreadsheets on the way in.
 *
 * The key is given by the caller and never written anywhere. Light by default: every tier goes to Haiku, as live tests
 * use; `routing` sends fast, standard and thorough to Haiku, Sonnet and Opus.
 */
import fs from 'node:fs';
import { decodeText } from '../domain/textEncoding';
import os from 'node:os';
import path from 'node:path';
import Anthropic, { toFile, type Middleware } from '@anthropic-ai/sdk';
import type { ModelService } from './service';
import type { SignInToken } from './signInToken';
import type { Converter } from './convert';
import { SERVICE, control } from '../control';
import { cutOff, limitsOf, saysTooLong, tooLong } from './limits';
import { retryDroppedRequest } from './requestRetry';

/** the current Claude models for the three tiers (the control file can pass others in `models`) */
export const CLAUDE_MODELS = { fast: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', thorough: 'claude-opus-5-5' };
const NAMES: Record<string, string> = { 'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5' };
const SHEET = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;

export interface ClaudeOptions {
  /** the API key, or where the person's signed-in key comes from (src/backend/signInToken.ts): calls wait while there is none */
  key: string | SignInToken;
  /** false (the default): every tier goes to the fast model; true: each tier to its own model */
  routing?: boolean;
  /** the model for each tier; CLAUDE_MODELS when left out */
  models?: { fast: string; standard: string; thorough: string };
  /** who whoami() names; without it whoami() fails and the PC's signed-in user is used (src/backend/session.ts) */
  who?: string;
  /** stop with an error after this many calls to complete(), as a guard on spend in tests */
  maxCalls?: number;
  /** one request's deadline, including its reply (control: timings.modelCall) */
  timeoutMs?: number;
  /** LibreOffice, for reading a spreadsheet as text; without it a spreadsheet cannot be uploaded */
  convert?: Converter;
  /** for tests: stands in for the network */
  fetch?: typeof fetch;
  /** retries on a busy or failing API (the SDK's own backoff); 2 unless set */
  maxRetries?: number;
  /** A cloud route using the Claude Messages shape, with provider-specific auth and inline documents. */
  transport?: {
    messages(input: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
    parts(ids: string[] | undefined): (Anthropic.DocumentBlockParam | Anthropic.TextBlockParam)[];
    checkSignIn(): Promise<void>;
  } & Pick<ModelService, 'upload' | 'remove' | 'list'>;
}

/** What the calls cost, for the usage log and for the person who pays. `uploaded` is what this service put in the store and has not removed. */
export interface ClaudeUse { calls: number; input: number; output: number; byModel: Record<string, number>; uploaded: string[]; /** each call's question line, files and reply (the last 200), for reading a failure */ log: { ask: string; files: string[]; reply: string }[] }

/** a failure the app shows as "cannot be reached, retrying" rather than as one answer that failed */
const unreachable = (e: unknown) => Object.assign(new Error(`${SERVICE} could not be reached: ${(e as Error).message}`), { code: 'unreachable' });
/** a timeout (408), a rate limit (429), an overload (529) or a server error (500 and up): the service is there but cannot answer now */
const busy = (status: number | undefined) => status === 408 || status === 429 || (status !== undefined && status >= 500);

/** The SDK propagates middleware errors of this type immediately, leaving its HTTP retry rules in place. */
class RequestEnded extends Error {
  constructor(readonly original: unknown) {
    super('The request ended.');
  }
}

function requestAborted(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  const failure = error as { cause?: { code?: unknown }; code?: unknown };
  const code = failure.cause?.code ?? failure.code;
  return code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
}

/** Undici reports a lost response body as a terminated stream. */
const replyDropped = (error: unknown) => error instanceof TypeError && error.message === 'terminated';

function requestRetries(timeoutMs: number): Middleware {
  return async (request, next) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const method = request.method ?? 'GET';
    try {
      return await untilAbort(signal, async () => {
        const response = await next({ ...request, signal });
        if (response.ok && response.body && (method === 'GET' || method === 'DELETE')) return finishRead(response);
        return response;
      });
    } catch (error) {
      if (!signal.aborted && !requestAborted(error) && retryDroppedRequest(error, method)) throw error;
      // No cause: the SDK inspects causes for fetch failures and kicks off its own retry.
      throw new RequestEnded(error);
    }
  };
}

/** Read successful GET/DELETE replies inside the SDK attempt so a dropped body uses the same retry budget as a drop
 * before headers. The SDK can still parse the complete response. */
async function finishRead(response: Response): Promise<Response> {
  let body: ArrayBuffer;
  try {
    body = await response.arrayBuffer();
  } catch (error) {
    if (requestAborted(error)) throw error;
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new Anthropic.APIConnectionError({ cause });
  }
  return new Response(body, response);
}

/** Settle the attempt at its deadline even if the fetch has not reacted to its abort signal yet. */
function untilAbort<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    void run().then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** a spreadsheet as text Claude can read: each sheet under its name, one row a line, cells split by tabs */
async function sheetText(convert: Converter, file: { name: string; bytes: Uint8Array }): Promise<string> {
  if (!convert.sheets) throw new Error(`${file.name} is a spreadsheet, and this converter cannot read one`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-claude-'));
  try {
    const at = path.join(dir, path.basename(file.name)); fs.writeFileSync(at, file.bytes);
    const sheets = await convert.sheets(at, true);
    return sheets.map((s) => `Sheet "${s.name}"\n${s.grid.map((r) => r.join('\t')).join('\n')}`).join('\n\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** a text file as UTF-8: its own bytes when they are UTF-8, else read as a spreadsheet program reads a .csv or .txt (UTF-16, Windows-1252) */
function plainTextBytes(file: { name: string; bytes: Uint8Array }): Uint8Array {
  try { new TextDecoder('utf-8', { fatal: true }).decode(file.bytes); return file.bytes; } catch { /* another encoding, or not text */ }
  if (/\.(csv|txt|text|md)$/i.test(file.name)) return new TextEncoder().encode(decodeText(file.bytes));
  throw new Error(`${SERVICE} cannot read ${file.name}: only PDFs, text and spreadsheets`);
}

/** what goes into the store for a file: a PDF as it is, a spreadsheet as text, any other text as it is */
export async function storable(file: { name: string; bytes: Uint8Array }, convert?: Converter): Promise<{ bytes: Uint8Array; type: string }> {
  if (file.bytes[0] === 0x25 && file.bytes[1] === 0x50 && file.bytes[2] === 0x44 && file.bytes[3] === 0x46) return { bytes: file.bytes, type: 'application/pdf' };   // %PDF
  if (SHEET.test(file.name)) {
    if (!convert) throw new Error(`${file.name} is a spreadsheet, and there is no converter to read it with`);
    return { bytes: new TextEncoder().encode(await sheetText(convert, file)), type: 'text/plain' };
  }
  return { bytes: plainTextBytes(file), type: 'text/plain' };
}

export function claudeService(o: ClaudeOptions): ModelService & { use: ClaudeUse } {
  // one client per key: a new key from a sign-in makes a new client, and a refused key asks for a sign-in and waits
  // the client's timeout is the control file's, as on the other connectors; set, it also lets the SDK send any limits.outputTokens
  // without streaming (unset, it refuses a reply that could take longer than ten minutes)
  const timeout = o.timeoutMs ?? control.timings.modelCall;
  let client: Anthropic | null = null, clientKey = '';
  async function call<T>(run: (c: Anthropic) => Promise<T>): Promise<T> {
    for (;;) {
      const key = typeof o.key === 'string' ? o.key : await o.key.get();
      if (!client || key !== clientKey) {
        client = new Anthropic({
          apiKey: key, authToken: null, maxRetries: o.maxRetries ?? 2, timeout,
          middleware: [requestRetries(timeout)], ...(o.fetch ? { fetch: o.fetch } : {}),
        });
        clientKey = key;
      }
      try { return await run(client); }
      catch (e) { if (typeof o.key !== 'string' && e instanceof Anthropic.AuthenticationError) { o.key.refused(key); continue; } throw e; }
    }
  }
  const send = (input: Anthropic.MessageCreateParamsNonStreaming) =>
    o.transport ? o.transport.messages(input) : call((client) => client.messages.create(input));
  const documents = (files?: string[]) => o.transport?.parts(files)
    ?? (files ?? []).map((id) => ({
      type: 'document', source: { type: 'file', file_id: id }, ...(names.has(id) ? { title: names.get(id) } : {}),
    }));
  const tiers = o.models ?? CLAUDE_MODELS;
  const use: ClaudeUse = { calls: 0, input: 0, output: 0, byModel: {}, uploaded: [], log: [] };
  const names = new Map<string, string>();                                         // file id → its name, for the document's title
  const talks = new Map<string, { system?: string; messages: Anthropic.MessageParam[] }>(); let talkN = 0;   // the conversations kept (converse)
  // the model for a call: a tier's name (what the stand-in uses, and older tests) or a model's own id
  const pick = (m: string) => { const t = m === 'fast' || m === 'standard' || m === 'thorough' ? tiers[m] : m; return o.routing ? t : tiers.fast; };
  // an API error as the backend reads it: no connection at all, or a service too busy to answer (a rate limit, an
  // overload, a server error, still there after the SDK's own retries), is "unreachable", so the checks wait and try
  // again as they do when the service is away; anything else fails this one call
  // room for a reply, and for a request (control: limits.outputTokens, limits.inputTokens); a reply cut off at the one throws with
  // `code: 'cutoff'`, a request refused as longer than the other with `code: 'toolong'`, so the backend asks about less (limits.ts)
  const { output: MAX_TOKENS, input: MAX_INPUT } = limitsOf();
  const failed = (e: unknown, upload = false): never => {
    if (e instanceof RequestEnded) throw unreachable(e.original);
    if (e instanceof Anthropic.APIConnectionError || requestAborted(e) || replyDropped(e)) throw unreachable(e);
    if (e instanceof Anthropic.APIError && busy(e.status)) throw Object.assign(new Error(`${SERVICE} is busy (${e.status}): ${e.message}`), { code: 'unreachable' });
    if (e instanceof Anthropic.APIError && saysTooLong(e.status, e.message, upload)) throw tooLong(`${SERVICE} said the request is too long: ${e.message}`, e.status);
    if (e instanceof Anthropic.APIError) throw Object.assign(new Error(`${SERVICE} said ${e.status ?? ''}: ${e.message}`), { status: e.status });
    throw e;
  };
  return {
    use,
    // listing one model needs the key and runs nothing
    async checkSignIn() {
      try {
        if (o.transport) await o.transport.checkSignIn();
        else await call((c) => c.models.list({ limit: 1 }));
      } catch (e) { failed(e); }
    },
    outputLimit: () => MAX_TOKENS,
    inputLimit: () => MAX_INPUT,
    async whoami() { if (!o.who) throw new Error('the Anthropic API does not say who is signed in'); return { name: o.who }; },
    async models() {
      const ids = o.routing ? [tiers.fast, tiers.standard, tiers.thorough] : [tiers.fast];
      const models = [...new Set(ids)].map((id) => ({ id, name: NAMES[id] ?? id }));
      return o.routing ? { models, default: tiers.standard, ...tiers } : { models, default: tiers.fast, fast: tiers.fast, standard: tiers.fast, thorough: tiers.fast };
    },
    async complete(input) {
      if (o.maxCalls !== undefined && use.calls >= o.maxCalls) throw Object.assign(new Error(`stopped at the limit of ${o.maxCalls} calls`), { code: 'maxcalls' });   // a guard on spend, never asked again
      const model = pick(input.model); use.calls++; use.byModel[model] = (use.byModel[model] ?? 0) + 1;
      const docs = documents(input.files);
      let r: Anthropic.Message;
      try {
        r = await send({
          model, max_tokens: MAX_TOKENS, ...(input.system ? { system: input.system } : {}),
          messages: [{ role: 'user', content: [...docs, { type: 'text', text: input.prompt }] }],
        });
      } catch (e) { return failed(e); }
      use.input += r.usage.input_tokens; use.output += r.usage.output_tokens;
      const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      use.log.push({ ask: input.prompt.split('\n').find((l) => /\?|Reply as JSON/.test(l))?.slice(0, 160) ?? input.prompt.slice(0, 160), files: (input.files ?? []).map((id) => names.get(id) ?? id), reply: text.slice(0, 1500) });
      if (use.log.length > 200) use.log.shift();
      if (r.stop_reason === 'refusal') throw new Error(`${SERVICE} declined to answer this`);
      if (r.stop_reason === 'max_tokens') throw cutOff(`${SERVICE}'s reply was cut off at ${MAX_TOKENS} tokens`, text);
      return text;
    },
    // The Anthropic API keeps no conversation, so this connector keeps each one itself, in memory, and resends it with
    // prompt caching on: the part sent before is read from the cache at about a tenth of the price. After a
    // restart the conversation is gone, and the app carries on in a new one with the transcript attached.
    async converse(input) {
      if (o.maxCalls !== undefined && use.calls >= o.maxCalls) throw Object.assign(new Error(`stopped at the limit of ${o.maxCalls} calls`), { code: 'maxcalls' });   // a guard on spend, never asked again
      let id = input.conversation; let c = id ? talks.get(id) : undefined;
      if (id && !c) throw Object.assign(new Error(`${SERVICE} no longer has this conversation`), { code: 'gone' });
      if (!c || !id) { id = `talk_${++talkN}_${Date.now().toString(36)}`; c = { system: input.system, messages: [] }; talks.set(id, c); }
      const model = pick(input.model); use.calls++; use.byModel[model] = (use.byModel[model] ?? 0) + 1;
      const docs = documents(input.files);
      // every tool the model called on the turn before is answered first, as the API requires: with its result, or pointing to
      // the message, where the chat sends results that way (hybrid)
      const before = c.messages.at(-1); const pending = before && Array.isArray(before.content) ? before.content.flatMap((b) => (b.type === 'tool_use' ? [b.id] : [])) : [];
      const answered = pending.map((id): Anthropic.ToolResultBlockParam => ({ type: 'tool_result', tool_use_id: id, content: input.results?.find((x) => x.id === id)?.text || 'Its result is in the message that follows.' }));
      const messages: Anthropic.MessageParam[] = [...c.messages, { role: 'user', content: [...answered, ...docs, { type: 'text', text: input.prompt }] }];
      const tools = input.tools?.map((t): Anthropic.Tool => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema }));
      let r: Anthropic.Message;
      try {
        r = await send({
          model, max_tokens: MAX_TOKENS, ...(o.transport ? {} : { cache_control: { type: 'ephemeral' } }),
          ...(c.system ? { system: c.system } : {}), messages,
          ...(tools ? { tools, tool_choice: { type: 'any' } } : {}),
        });
      } catch (e) { return failed(e); }
      const read = r.usage.cache_read_input_tokens ?? 0, wrote = r.usage.cache_creation_input_tokens ?? 0;
      use.input += r.usage.input_tokens + read + wrote; use.output += r.usage.output_tokens;
      const text = r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      if (r.stop_reason === 'refusal') throw new Error(`${SERVICE} declined to answer this`);
      if (r.stop_reason === 'max_tokens') throw cutOff(`${SERVICE}'s reply was cut off at ${MAX_TOKENS} tokens`, text);
      const calls = r.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, args: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown> }] : []));
      const kept: Anthropic.ContentBlockParam[] = [...(text ? [{ type: 'text' as const, text }] : []), ...calls.map((x): Anthropic.ToolUseBlockParam => ({ type: 'tool_use', id: x.id, name: x.name, input: x.args }))];
      c.messages = [...messages, { role: 'assistant', content: kept.length ? kept : '(no reply)' }];   // kept only once the turn is whole; an empty turn is refused by the API
      return { text, conversation: id, tokens: r.usage.input_tokens + read + wrote + r.usage.output_tokens, ...(calls.length ? { calls } : {}) };
    },
    async upload(file) {
      if (o.transport) return o.transport.upload(file);
      const { bytes, type } = await storable(file, o.convert);
      let id: string;
      // the store keeps only the last part of a name, and the document id at its front must survive
      try { const named = await toFile(bytes, file.name.replace(/[\\/]/g, '_'), { type }); id = (await call((c) => c.files.upload({ file: named }))).id; } catch (e) { return failed(e, true); }
      names.set(id, file.name); use.uploaded.push(id); return id;
    },
    async remove(fileId) {
      if (o.transport) return o.transport.remove(fileId);
      try { await call((c) => c.files.delete(fileId)); } catch (e) { if (!(e instanceof Anthropic.NotFoundError)) failed(e); }   // already gone is not an error
      names.delete(fileId); use.uploaded = use.uploaded.filter((x) => x !== fileId);
    },
    async list() {
      if (o.transport) return o.transport.list();
      const out: { id: string; name: string }[] = [];
      try { await call(async (c) => { out.length = 0; for await (const f of c.files.list()) { out.push({ id: f.id, name: f.filename }); if (!names.has(f.id)) names.set(f.id, f.filename); } }); } catch (e) { return failed(e); }
      return out;
    },
  };
}
