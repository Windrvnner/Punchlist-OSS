/**
 * A stand-in North server for tests: a real HTTP server on this PC that answers the calls the connector makes
 * (src/backend/north.ts) the way North's published API reference says it does. Real North is never
 * reached from here.
 *
 * What it follows from the reference (its page names in brackets):
 * - every path under /api, with `Authorization: Bearer <token>` (About the North API); a missing, unknown or expired
 *   token is a 401 `authentication_error`;
 * - errors in North's shape (Errors): error_type, error_code, message, request_id, status_code, is_retryable,
 *   details, with the X-Request-ID and X-North-Error-Code headers, and Retry-After on 429 and 503;
 * - GET /v1/users/me (Get Me); GET /v2/models, paged by next_token (List models), and GET /v1/models;
 * - POST /v1/files as multipart with one `file`; the file starts "uploaded" and is "processed" after `processAfter`
 *   looks at it (Upload file, Retrieve file); GET /v1/files paged by next_token (List files); DELETE, 404 when gone;
 *   a name outside the Latin alphabet is refused, since North takes file names in the Latin alphabet only (the
 *   "Using My Files" guide);
 * - POST /v1/chat with `stream: false` required, a list of messages and `file_ids` (Chat), and function `tools`,
 *   answering with conversation_id, messages (assistant content as text parts), finish_reason and usage. A file that
 *   is not processed yet, or not there, is refused.
 * How it answers a question is up to the test (`answer`). `faults` makes the next calls fail in a chosen way.
 * For the desktop sign-in test, its home page stands in for the firm's SSO page too: with `ssoToken`, opening it sets
 * that token as a cookie, as signing in on the SSO site would.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StandInFile { id: string; filename: string; bytes: Uint8Array; created_at: number; looks: number; failed?: string }
export interface ChatBody { model?: string; messages?: { role: string; content: unknown; tool_call_id?: string }[]; file_ids?: string[]; conversation?: { id: string }; stream?: unknown; agent?: unknown; tools?: unknown }
/** the next call to `path` (a prefix, like "/v1/chat") fails: an HTTP error in North's shape, or a dropped connection */
export interface Fault { path: string; status?: number; type?: string; code?: string; retryAfter?: number; drop?: boolean; message?: string }

const TYPES: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 422: 'invalid_request_error', 429: 'rate_limit_error', 500: 'internal_error', 503: 'overloaded_error' };

/** a JWT with the given payload; the stand-in reads `exp` and does not check the signature */
export const jwt = (payload: Record<string, unknown>) => [{ alg: 'RS256', typ: 'JWT' }, payload].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') + '.c2ln';

/** the model list the stand-in serves, in place of its default */
type ModelNames = { name: string; display_name?: string }[];

interface StandInOptions {
  ssoToken?: string | (() => string);
  answer?: (body: ChatBody, files: StandInFile[]) => string | {
    text?: string;
    finish?: string;
    calls?: { name: string; arguments: string }[];
  };
  tokens?: string[];
  processAfter?: number;
  pageSize?: number;
  models?: ModelNames;
  failFile?: RegExp;
  rejectToolResults?: boolean;
  fileTool?: string;
}

type Reply = {
  send: (status: number, body: unknown, headers?: Record<string, string>) => void;
  error: (status: number, code: string, message: string, extra?: { type?: string; retryAfter?: number }) => void;
};

/** what one stand-in server keeps between calls */
interface StandIn {
  o: StandInOptions;
  tokens: Set<string>;
  files: Map<string, StandInFile>;
  chats: ChatBody[];
  seen: { method: string; path: string; auth?: string }[];
  conversations: Set<string>;
  faults: Fault[];
  models: Record<string, unknown>[];
  counts: { files: number; requests: number };
}

/** a call as the handlers see it */
interface Call {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  p: string;
  body: Buffer;
  reply: Reply;
}

function defaultModels(o: StandInOptions) {
  return (o.models?.map((m, i) => ({ id: `m${i + 1}`, ...m })) ?? [
    { id: 'm1', name: 'model-fast', display_name: 'Model Fast' },
    { id: 'm2', name: 'model-standard', display_name: 'Model Standard' },
    { id: 'm3', name: 'model-thorough', display_name: 'Model Thorough' },
    { id: 'm4', name: 'command-a', display_name: 'Command A', max_tokens: 4000, context_length: 128_000 },
  ]).map((m) => ({
    ...m,
    provider: { name: 'cohere_platform', instance: 'p1' },
    created_at: 1_700_000_000_000,
  }));
}

function fileObject(s: StandInFile, processAfter: number) {
  const status = s.failed ? 'error' : s.looks >= processAfter ? 'processed' : 'uploaded';
  return {
    object: 'file',
    id: s.id,
    filename: s.filename,
    bytes: s.bytes.length,
    created_at: s.created_at,
    status,
    ...(s.failed ? { status_details: s.failed } : {}),
  };
}

/** one page of a list, and the token for the next (the offset, as an opaque-looking string) */
function paged<T>(all: T[], url: URL, page: number) {
  const at = Number(Buffer.from(url.searchParams.get('next_token') ?? '', 'base64url').toString() || 0);
  const limit = Math.min(Number(url.searchParams.get('limit') ?? page), page);
  const data = all.slice(at, at + limit);
  return { data, next_token: at + limit < all.length ? Buffer.from(String(at + limit)).toString('base64url') : null };
}

function makeReply(res: http.ServerResponse, id: string): Reply {
  const send: Reply['send'] = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': id, ...headers });
    res.end(JSON.stringify(body));
  };
  const error: Reply['error'] = (status, code, message, extra = {}) => {
    const retryable = status === 429 || status === 503;
    const retryAfter = extra.retryAfter;
    send(status, {
      error_type: extra.type ?? TYPES[status] ?? 'invalid_request_error',
      error_code: code,
      message,
      request_id: id,
      status_code: status,
      is_retryable: retryable,
      trace_id: null,
      details: retryAfter !== undefined ? { retry_after_seconds: retryAfter } : {},
    }, {
      'x-north-error-code': code,
      ...(retryable && retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}),
    });
  };
  return { send, error };
}

function readBody(req: http.IncomingMessage) {
  return new Promise<Buffer>((resolve) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });
}

/** the home page, which stands in for the SSO page; it sets the token cookie when `ssoToken` is given */
function homePage({ o }: StandIn, { res }: Call) {
  const token = typeof o.ssoToken === 'function' ? o.ssoToken() : o.ssoToken;
  const cookie = o.ssoToken ? { 'set-cookie': `north_session=${token}; Path=/; HttpOnly` } : {};
  res.writeHead(200, { 'content-type': 'text/html', ...cookie });
  res.end('<!doctype html><title>North</title><p>Signed in.</p>');
}

/** the next fault whose path matches, if any; a drop destroys the connection */
function fireFault({ faults }: StandIn, { req, p, reply }: Call) {
  const at = faults.findIndex((f) => p.startsWith(f.path));
  if (at < 0) return false;
  const f = faults.splice(at, 1)[0];
  if (f.drop) {
    req.socket.destroy();
    return true;
  }
  const message = f.message ?? 'A fault the test asked for.';
  reply.error(f.status ?? 500, f.code ?? 'STAND_IN_FAULT', message, { type: f.type, retryAfter: f.retryAfter });
  return true;
}

function tokenExpiry(token: string) {
  if (token.split('.').length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp as number | undefined;
  } catch {
    return undefined;
  }
}

/** answers 401 and returns false when the bearer token is missing, unknown or expired */
function authorized({ tokens }: StandIn, { req, reply }: Call) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  const exp = token ? tokenExpiry(token) : undefined;
  if (token && tokens.has(token) && (exp === undefined || exp * 1000 >= Date.now())) return true;
  reply.error(401, 'INVALID_TOKEN', 'Your session has expired. Please sign in again.');
  return false;
}

const me = {
  id: 'u1',
  created_at: '2026-01-15T09:30:00Z',
  updated_at: '2026-01-15T09:30:00Z',
  first_name: 'jdoe',
  last_name: '',
  locale: 'en-US',
  email: 'jdoe@example.com',
};

const agents = [
  {
    id: 'ag_1',
    name: 'Research',
    tools: [
      { type: 'north_tool', north_tool: { name: 'file_reader' } },
      { type: 'function', function: { name: 'lookup' } },
    ],
  },
  { id: 'ag_2', name: 'Web', tools: [{ type: 'north_tool', north_tool: { name: 'web_search' } }] },
];

async function uploadFile(s: StandIn, { req, body, reply }: Call) {
  const headers = { 'content-type': req.headers['content-type'] ?? '' };
  let form: FormData;
  try {
    form = await new Request('http://x', { method: 'POST', headers, body: new Uint8Array(body) }).formData();
  } catch {
    return reply.error(400, 'INVALID_MULTIPART', 'Expected a multipart form with a file.');
  }
  const f = form.get('file');
  if (!(f instanceof File)) return reply.error(422, 'VALIDATION_ERROR', 'Request validation failed.');
  if (/[^\u0000-ɏ]/.test(f.name)) {
    return reply.error(400, 'INVALID_FILENAME', 'File names must use the Latin alphabet.');
  }
  const file: StandInFile = {
    id: `file_${++s.counts.files}`,
    filename: f.name,
    bytes: new Uint8Array(await f.arrayBuffer()),
    created_at: Math.floor(Date.now() / 1000),
    looks: 0,
    ...(s.o.failFile?.test(f.name) ? { failed: 'The file could not be parsed.' } : {}),
  };
  s.files.set(file.id, file);
  return reply.send(200, fileObject(file, s.o.processAfter ?? 1));
}

/** the /v1/files routes; false when the call is not one of them */
async function fileRoutes(s: StandIn, call: Call) {
  const { req, url, p, reply } = call;
  const processAfter = s.o.processAfter ?? 1;
  if (req.method === 'POST' && p === '/v1/files') {
    await uploadFile(s, call);
    return true;
  }
  if (req.method === 'GET' && p === '/v1/files') {
    const all = [...s.files.values()].map((f) => fileObject(f, processAfter));
    reply.send(200, paged(all, url, s.o.pageSize ?? 2));
    return true;
  }
  const one = /^\/v1\/files\/([^/]+)$/.exec(p);
  if (!one) return false;
  const f = s.files.get(one[1]);
  if (!f) {
    reply.error(404, 'FILE_NOT_FOUND', 'File not found.');
    return true;
  }
  if (req.method === 'GET') {
    f.looks++;
    reply.send(200, fileObject(f, processAfter));
    return true;
  }
  if (req.method !== 'DELETE') return false;
  s.files.delete(f.id);
  reply.send(200, { id: f.id, deleted: true });
  return true;
}

/** the files a chat names, or an error answer (and null) when one is missing or not processed yet */
function chatFiles(s: StandIn, b: ChatBody, reply: Reply) {
  const given: StandInFile[] = [];
  for (const fid of b.file_ids ?? []) {
    const f = s.files.get(fid);
    if (!f) return reply.error(404, 'FILE_NOT_FOUND', `File ${fid} not found.`) ?? null;
    if (fileObject(f, s.o.processAfter ?? 1).status !== 'processed') {
      return reply.error(400, 'FILE_NOT_READY', `File ${fid} is still being processed.`) ?? null;
    }
    given.push(f);
  }
  return given;
}

/** the chat body, or an error answer (and null) when it is not valid */
function chatBody(body: Buffer, reply: Reply) {
  let b: ChatBody;
  try {
    b = JSON.parse(body.toString());
  } catch {
    return reply.error(400, 'INVALID_JSON', 'The request body is not JSON.') ?? null;
  }
  const roles = ['user', 'system', 'assistant', 'tool'];
  const invalid = b.stream !== false || !Array.isArray(b.messages) || !b.messages.every((m) => roles.includes(m?.role));
  return invalid ? (reply.error(422, 'VALIDATION_ERROR', 'Request validation failed.') ?? null) : b;
}

/** with `fileTool`, a call that lists tools reads its files only when that North tool is among them */
function readsFiles(o: StandInOptions, b: ChatBody) {
  if (!b.tools || !o.fileTool) return true;
  const tools = b.tools as { type?: string; north_tool?: { name?: string } }[];
  return tools.some((t) => t.type === 'north_tool' && t.north_tool?.name === o.fileTool);
}

function chatAnswer(s: StandIn, b: ChatBody, given: StandInFile[], reply: Reply) {
  const a = s.o.answer?.(b, readsFiles(s.o, b) ? given : []) ?? 'ok';
  const r = typeof a === 'string' ? { text: a } : a;
  const conv = b.conversation?.id ?? `conv_${s.chats.length}`;
  s.conversations.add(conv);
  // tool calls (NorthToolCall on the Chat page) come back on the assistant message, with finish_reason TOOL_CALL
  const n = s.chats.length;
  const toolCall = (c: { name: string; arguments: string }, i: number) =>
    ({ id: `tc_${n}_${i}`, tool_call_id: `call_${n}_${i}`, type: 'function', function: c });
  const calls = 'calls' in r && r.calls?.length ? { tool_calls: r.calls.map(toolCall) } : {};
  const content = r.text === undefined ? [] : [{ type: 'text', text: r.text }];
  reply.send(200, {
    conversation_id: conv,
    finish_reason: r.finish ?? (calls.tool_calls ? 'TOOL_CALL' : 'COMPLETE'),
    messages: [{ role: 'assistant', id: `msg_${n}`, content, ...calls }],
    usage: {
      billed_units: { input_tokens: 10, output_tokens: 2 },
      tokens: { input_tokens: 12, output_tokens: 2 },
      cached_tokens: 0,
    },
  });
}

function chat(s: StandIn, { body, reply }: Call) {
  const b = chatBody(body, reply);
  if (!b) return;
  const given = chatFiles(s, b, reply);
  if (!given) return;
  // a conversation North does not have (never started, or deleted) is not found, as any missing resource is
  if (b.conversation?.id && !s.conversations.has(b.conversation.id)) {
    return reply.error(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
  }
  // as North does: a client tool's result sent back as a role:tool message fails with a 500
  if (s.o.rejectToolResults && b.messages?.some((m) => m.role === 'tool')) {
    return reply.error(500, 'INTERNAL_ERROR', 'An internal error occurred.');
  }
  s.chats.push(b);
  chatAnswer(s, b, given, reply);
}

/** the routes that need a signed-in call */
async function apiRoutes(s: StandIn, call: Call) {
  const { req, url, p, reply } = call;
  const get = req.method === 'GET';
  if (get && p === '/v1/users/me') return reply.send(200, me);
  if (get && p === '/v2/models') return reply.send(200, paged(s.models, url, s.o.pageSize ?? 2));
  if (get && p === '/v1/models') return reply.send(200, s.models.map((m) => ({ id: m.name })));
  if (await fileRoutes(s, call)) return;
  // the person's agents (List Agents), with North's own tools by name
  if (get && p === '/v1/agents') return reply.send(200, agents);
  if (req.method === 'POST' && p === '/v1/chat') return chat(s, call);
  return reply.error(404, 'NOT_FOUND', 'Not found.');
}

async function handle(s: StandIn, req: http.IncomingMessage, res: http.ServerResponse) {
  const id = `req_${++s.counts.requests}`;
  const url = new URL(req.url ?? '/', 'http://x');
  const p = url.pathname.replace(/^\/api/, '');
  const reply = makeReply(res, id);
  const call: Call = { req, res, url, p, body: await readBody(req), reply };
  s.seen.push({ method: req.method ?? '', path: p, auth: req.headers.authorization });
  if (req.method === 'GET' && url.pathname === '/') return homePage(s, call);
  if (!url.pathname.startsWith('/api/')) return reply.error(404, 'NOT_FOUND', 'Not found.');
  if (fireFault(s, call) || !authorized(s, call)) return;
  return apiRoutes(s, call);
}

export async function northStandIn(o: StandInOptions = {}) {
  const s: StandIn = {
    o,
    tokens: new Set(o.tokens ?? ['good-token']),
    files: new Map(),
    chats: [],
    seen: [],
    conversations: new Set(),
    faults: [],
    models: defaultModels(o),
    counts: { files: 0, requests: 0 },
  };
  const server = http.createServer((req, res) => handle(s, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  const { files, chats, conversations, seen, faults, tokens } = s;
  return { address, files, chats, conversations, seen, faults, tokens, close };
}
