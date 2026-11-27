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
type ModelNames = { name: string; display_name: string }[];

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

export async function northStandIn(o: StandInOptions = {}) {
  const tokens = new Set(o.tokens ?? ['good-token']);
  const files = new Map<string, StandInFile>();
  const chats: ChatBody[] = []; const seen: { method: string; path: string; auth?: string }[] = []; const conversations = new Set<string>();
  const faults: Fault[] = [];
  let n = 0, requests = 0;
  const models = (o.models?.map((m, i) => ({ id: `m${i + 1}`, ...m })) ?? [
    { id: 'm1', name: 'model-fast', display_name: 'Model Fast' },
    { id: 'm2', name: 'model-standard', display_name: 'Model Standard' },
    { id: 'm3', name: 'model-thorough', display_name: 'Model Thorough' },
    { id: 'm4', name: 'command-a', display_name: 'Command A', max_tokens: 4000, context_length: 128_000 },
  ]).map((m) => ({
    ...m,
    provider: { name: 'cohere_platform', instance: 'p1' },
    created_at: 1_700_000_000_000,
  }));
  const page = o.pageSize ?? 2;
  const fileObject = (f: StandInFile) => ({ object: 'file', id: f.id, filename: f.filename, bytes: f.bytes.length, created_at: f.created_at, status: f.failed ? 'error' : f.looks >= (o.processAfter ?? 1) ? 'processed' : 'uploaded', ...(f.failed ? { status_details: f.failed } : {}) });
  /** one page of a list, and the token for the next (the offset, as an opaque-looking string) */
  const paged = <T>(all: T[], url: URL) => { const at = Number(Buffer.from(url.searchParams.get('next_token') ?? '', 'base64url').toString() || 0); const limit = Math.min(Number(url.searchParams.get('limit') ?? page), page); const data = all.slice(at, at + limit); return { data, next_token: at + limit < all.length ? Buffer.from(String(at + limit)).toString('base64url') : null }; };

  const server = http.createServer(async (req, res) => {
    const id = `req_${++requests}`;
    const url = new URL(req.url ?? '/', 'http://x'); const p = url.pathname.replace(/^\/api/, '');
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': id, ...headers }); res.end(JSON.stringify(body)); };
    const error = (status: number, code: string, message: string, extra: { type?: string; retryAfter?: number } = {}) => {
      const retryable = status === 429 || status === 503;
      send(status, { error_type: extra.type ?? TYPES[status] ?? 'invalid_request_error', error_code: code, message, request_id: id, status_code: status, is_retryable: retryable, trace_id: null, details: extra.retryAfter !== undefined ? { retry_after_seconds: extra.retryAfter } : {} },
        { 'x-north-error-code': code, ...(retryable && extra.retryAfter !== undefined ? { 'retry-after': String(extra.retryAfter) } : {}) });
    };
    const body = await new Promise<Buffer>((resolve) => { const parts: Buffer[] = []; req.on('data', (c) => parts.push(c)); req.on('end', () => resolve(Buffer.concat(parts))); });
    seen.push({ method: req.method ?? '', path: p, auth: req.headers.authorization });
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html', ...(o.ssoToken ? { 'set-cookie': `north_session=${typeof o.ssoToken === 'function' ? o.ssoToken() : o.ssoToken}; Path=/; HttpOnly` } : {}) }); res.end('<!doctype html><title>North</title><p>Signed in.</p>'); return; }
    if (!url.pathname.startsWith('/api/')) return error(404, 'NOT_FOUND', 'Not found.');
    const fault = faults.findIndex((f) => p.startsWith(f.path));
    if (fault >= 0) { const f = faults.splice(fault, 1)[0]; if (f.drop) { req.socket.destroy(); return; } return error(f.status ?? 500, f.code ?? 'STAND_IN_FAULT', f.message ?? 'A fault the test asked for.', { type: f.type, retryAfter: f.retryAfter }); }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const exp = token?.split('.').length === 3 ? (() => { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp as number | undefined; } catch { return undefined; } })() : undefined;
    if (!token || !tokens.has(token) || (exp !== undefined && exp * 1000 < Date.now())) return error(401, 'INVALID_TOKEN', 'Your session has expired. Please sign in again.');

    if (req.method === 'GET' && p === '/v1/users/me')
      return send(200, {
        id: 'u1',
        created_at: '2026-01-15T09:30:00Z',
        updated_at: '2026-01-15T09:30:00Z',
        first_name: 'jdoe',
        last_name: '',
        locale: 'en-US',
        email: 'jdoe@example.com',
      });
    if (req.method === 'GET' && p === '/v2/models') return send(200, paged(models, url));
    if (req.method === 'GET' && p === '/v1/models') return send(200, models.map((m) => ({ id: m.name })));
    if (req.method === 'POST' && p === '/v1/files') {
      let form: FormData; try { form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: new Uint8Array(body) }).formData(); } catch { return error(400, 'INVALID_MULTIPART', 'Expected a multipart form with a file.'); }
      const f = form.get('file'); if (!(f instanceof File)) return error(422, 'VALIDATION_ERROR', 'Request validation failed.');
      if (/[^\u0000-ɏ]/.test(f.name)) return error(400, 'INVALID_FILENAME', 'File names must use the Latin alphabet.');
      const file: StandInFile = { id: `file_${++n}`, filename: f.name, bytes: new Uint8Array(await f.arrayBuffer()), created_at: Math.floor(Date.now() / 1000), looks: 0, ...(o.failFile?.test(f.name) ? { failed: 'The file could not be parsed.' } : {}) };
      files.set(file.id, file); return send(200, fileObject(file));
    }
    if (req.method === 'GET' && p === '/v1/files') return send(200, paged([...files.values()].map(fileObject), url));
    const one = /^\/v1\/files\/([^/]+)$/.exec(p);
    if (one) {
      const f = files.get(one[1]); if (!f) return error(404, 'FILE_NOT_FOUND', 'File not found.');
      if (req.method === 'GET') { f.looks++; return send(200, fileObject(f)); }
      if (req.method === 'DELETE') { files.delete(f.id); return send(200, { id: f.id, deleted: true }); }
    }
    // the person's agents (List Agents), with North's own tools by name
    if (req.method === 'GET' && p === '/v1/agents') return send(200, [{ id: 'ag_1', name: 'Research', tools: [{ type: 'north_tool', north_tool: { name: 'file_reader' } }, { type: 'function', function: { name: 'lookup' } }] }, { id: 'ag_2', name: 'Web', tools: [{ type: 'north_tool', north_tool: { name: 'web_search' } }] }]);
    if (req.method === 'POST' && p === '/v1/chat') {
      let b: ChatBody; try { b = JSON.parse(body.toString()); } catch { return error(400, 'INVALID_JSON', 'The request body is not JSON.'); }
      if (b.stream !== false) return error(422, 'VALIDATION_ERROR', 'Request validation failed.');
      if (!Array.isArray(b.messages) || !b.messages.every((m) => ['user', 'system', 'assistant', 'tool'].includes(m?.role))) return error(422, 'VALIDATION_ERROR', 'Request validation failed.');
      const given: StandInFile[] = [];
      for (const fid of b.file_ids ?? []) { const f = files.get(fid); if (!f) return error(404, 'FILE_NOT_FOUND', `File ${fid} not found.`); if (fileObject(f).status !== 'processed') return error(400, 'FILE_NOT_READY', `File ${fid} is still being processed.`); given.push(f); }
      // a conversation North does not have (never started, or deleted) is not found, as any missing resource is
      if (b.conversation?.id && !conversations.has(b.conversation.id)) return error(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found.');
      // as North does: a client tool's result sent back as a role:tool message fails with a 500
      if (o.rejectToolResults && b.messages.some((m) => m.role === 'tool')) return error(500, 'INTERNAL_ERROR', 'An internal error occurred.');
      chats.push(b);
      // with `fileTool`, a call that lists tools reads its files only when that North tool is among them, as North's default tools are left out then
      const reads = !b.tools || !o.fileTool || (b.tools as { type?: string; north_tool?: { name?: string } }[]).some((t) => t.type === 'north_tool' && t.north_tool?.name === o.fileTool);
      const a = o.answer?.(b, reads ? given : []) ?? 'ok'; const r = typeof a === 'string' ? { text: a } : a;
      const conv = b.conversation?.id ?? `conv_${chats.length}`; conversations.add(conv);
      // tool calls (NorthToolCall on the Chat page) come back on the assistant message, with finish_reason TOOL_CALL
      const calls = 'calls' in r && r.calls?.length ? { tool_calls: r.calls.map((c, i) => ({ id: `tc_${chats.length}_${i}`, tool_call_id: `call_${chats.length}_${i}`, type: 'function', function: c })) } : {};
      return send(200, { conversation_id: conv, finish_reason: r.finish ?? (calls.tool_calls ? 'TOOL_CALL' : 'COMPLETE'), messages: [{ role: 'assistant', id: `msg_${chats.length}`, content: r.text === undefined ? [] : [{ type: 'text', text: r.text }], ...calls }], usage: { billed_units: { input_tokens: 10, output_tokens: 2 }, tokens: { input_tokens: 12, output_tokens: 2 }, cached_tokens: 0 } });
    }
    return error(404, 'NOT_FOUND', 'Not found.');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { address, files, chats, conversations, seen, faults, tokens, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
