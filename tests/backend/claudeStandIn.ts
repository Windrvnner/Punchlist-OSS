// The Anthropic API in memory, for the Claude connector's tests and the AI check. No network and no key.
import type Anthropic from '@anthropic-ai/sdk';
import type { SeenTurn } from './connectorAgentKit';

export interface Reply {
  status?: number;
  body?: unknown;
  stop?: string;
  text?: string;
  down?: boolean;
  tool?: { id: string; name: string; input: Record<string, unknown> };
}

interface Options {
  replies?: Reply[];
  answer?: (seen: SeenTurn) => Reply;
  noTools?: boolean;
  /** what the Models API says each model allows, by id; a model not named here is not found (404) */
  limits?: Record<string, { max_tokens: number | null; max_input_tokens: number | null }>;
  /** how many lookups of a model's limits fail (500) before the Models API answers */
  limitsDown?: number;
}

type Message = Anthropic.MessageParam;
type MessagesRequest = Anthropic.MessageCreateParamsNonStreaming & Record<string, unknown>;
type StoredFile = { name: string; type: string; text: string };

const CREATED_AT = '2026-11-14T00:00:00Z';
const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (type: string, message: string) => ({ type: 'error', error: { type, message } });

/** The Messages API requires the next user turn to provide a result for each preceding tool call. */
function missingResult(messages: Message[]): string | undefined {
  const index = messages.map((message) => message.role).lastIndexOf('assistant');
  const asked = messages[index]?.content;
  if (!Array.isArray(asked)) return undefined;
  const next = messages[index + 1];
  const answered = new Set(next?.role === 'user' && Array.isArray(next.content)
    ? next.content.flatMap((block) => block.type === 'tool_result' ? [block.tool_use_id] : [])
    : []);
  for (const block of asked) {
    if (block.type === 'tool_use' && !answered.has(block.id)) return block.id;
  }
  return undefined;
}

function textOf(block: Anthropic.ContentBlockParam): string {
  if (block.type === 'text') return block.text;
  if (block.type !== 'tool_result') return '';
  if (typeof block.content === 'string') return block.content;
  return (block.content ?? []).flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n');
}

function readTurn(input: MessagesRequest, files: Map<string, StoredFile>): SeenTurn {
  const user = input.messages.filter((message) => message.role === 'user');
  const parts = user.flatMap((message) => typeof message.content === 'string'
    ? [{ type: 'text' as const, text: message.content }]
    : message.content);
  const system = typeof input.system === 'string' ? input.system : input.system?.map((block) => block.text).join('\n');
  const documents = parts.flatMap((block) => {
    if (block.type !== 'document' || block.source.type !== 'file') return [];
    return [files.get(block.source.file_id)?.text ?? ''];
  });
  return {
    system: system ?? '',
    said: parts.map(textOf).filter(Boolean).join('\n'),
    files: documents.join(' '),
    tools: !!input.tools,
  };
}

function replyTo(input: MessagesRequest, files: Map<string, StoredFile>, options: Options): Reply {
  const missing = missingResult(input.messages);
  if (missing) {
    return { status: 400, body: error('invalid_request_error', `Missing tool_result for ${missing}`) };
  }
  if (input.tools && options.noTools) {
    return { status: 400, body: error('invalid_request_error', 'This model does not support tools.') };
  }
  return options.answer?.(readTurn(input, files)) ?? options.replies?.shift() ?? {};
}

function messageResponse(reply: Reply) {
  if (reply.status) return json(reply.body ?? error('invalid_request_error', 'bad'), reply.status);
  const content = reply.tool ? [{ type: 'tool_use', ...reply.tool }] : [{ type: 'text', text: reply.text ?? 'ok' }];
  return json({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'x', content,
    stop_reason: reply.stop ?? (reply.tool ? 'tool_use' : 'end_turn'), usage: { input_tokens: 10, output_tokens: 2 },
  });
}

function fileDescription(id: string, file: StoredFile, size = 1) {
  return { id, type: 'file', filename: file.name, mime_type: file.type, size_bytes: size, created_at: CREATED_AT };
}

async function fileResponse(
  request: Request, path: string, files: Map<string, StoredFile>, nextId: () => string,
) {
  if (path === '/v1/files') {
    if (request.method === 'POST') {
      const upload = (await request.formData()).get('file') as File;
      const id = nextId();
      const file = { name: upload.name, type: upload.type, text: await upload.text() };
      files.set(id, file);
      return json(fileDescription(id, file, upload.size));
    }
    const data = [...files].map(([id, file]) => fileDescription(id, file));
    return json({ data, has_more: false, first_id: null, last_id: null });
  }
  const removed = /^\/v1\/files\/(.+)$/.exec(path);
  if (removed && request.method === 'DELETE') {
    if (!files.delete(removed[1])) return json(error('not_found_error', 'gone'), 404);
    return json({ id: removed[1], type: 'file_deleted' });
  }
  return json(error('not_found_error', path), 404);
}

/** one model as the Models API describes it: what it allows, a failure while `limitsDown` lasts, or not found */
function modelResponse(id: string, options: Options): Response {
  if ((options.limitsDown ?? 0) > 0) {
    options.limitsDown! -= 1;
    return json(error('api_error', 'down'), 500);
  }
  const limits = options.limits?.[id];
  if (!limits) return json(error('not_found_error', id), 404);
  return json({ type: 'model', id, display_name: id, created_at: CREATED_AT, ...limits });
}

/** A file store and the portion of the Messages and Models APIs used by the connector. */
export function fakeApi(script: Reply[] | Options = []) {
  const options = Array.isArray(script) ? { replies: script } : script;
  const files = new Map<string, StoredFile>();
  const sent: Record<string, unknown>[] = [];
  let nextFile = 0;

  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    const path = new URL(request.url).pathname;
    if (path === '/v1/messages') {
      const input = await request.json() as MessagesRequest;
      const reply = replyTo(input, files, options);
      if (reply.down) throw new TypeError('fetch failed');
      sent.push(input);
      return messageResponse(reply);
    }
    if (path === '/v1/models') {
      const id = 'claude-haiku-5-5';
      const model = { type: 'model', id, display_name: 'Claude Haiku 5.5', created_at: CREATED_AT };
      return json({ data: [model], has_more: false, first_id: id, last_id: id });
    }
    const asked = /^\/v1\/models\/(.+)$/.exec(path);
    if (asked) return modelResponse(decodeURIComponent(asked[1]), options);
    return fileResponse(request, path, files, () => `file_${++nextFile}`);
  };
  return { fetch, files, sent };
}
