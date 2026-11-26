// @vitest-environment node
// The Claude model service, on a stand-in for the Anthropic API: what it sends, what it reads back, and how it fails.
// No network and no key; the real API is tried by the live tests (tests/e2e/live.test.ts).
import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { claudeService, CLAUDE_MODELS } from '../../src/backend/claude';
import { StoreKeeper, fromStoreName } from '../../src/backend/storeKeeper';
import type { Converter } from '../../src/backend/convert';
import { tokenHolder } from '../../src/backend/signInToken';
import { fakeApi } from './claudeStandIn';
import { agentReply, answerOn, AGENT_ANSWER, HYBRID_RESULT, SEARCH_RESULT } from './connectorAgentKit';

const svc = (api: ReturnType<typeof fakeApi>, more: Partial<Parameters<typeof claudeService>[0]> = {}) => claudeService({ key: 'test', fetch: api.fetch, maxRetries: 0, ...more });
const text = (s: string) => new TextEncoder().encode(s);
const PDF = text('%PDF-1.7 a page');

describe('the models on offer', () => {
  it('light by default: every tier is Haiku 5.5, and a tier name or any model id is sent as Haiku', async () => {
    const api = fakeApi(); const s = svc(api);
    expect(await s.models()).toEqual({ models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }], default: 'claude-haiku-5-5', fast: 'claude-haiku-5-5', standard: 'claude-haiku-5-5', thorough: 'claude-haiku-5-5' });
    await s.complete({ model: 'thorough', prompt: 'q' }); await s.complete({ model: 'claude-opus-5-5', prompt: 'q' });
    expect(api.sent.map((b) => b.model)).toEqual(['claude-haiku-5-5', 'claude-haiku-5-5']);
  });
  it('with routing, each tier goes to its own model, and the standard one is preselected', async () => {
    const api = fakeApi(); const s = svc(api, { routing: true });
    const m = await s.models(); expect(m.models.map((x) => x.id)).toEqual([CLAUDE_MODELS.fast, CLAUDE_MODELS.standard, CLAUDE_MODELS.thorough]); expect(m.default).toBe(CLAUDE_MODELS.standard);
    for (const t of ['fast', 'standard', 'thorough', m.thorough]) await s.complete({ model: t, prompt: 'q' });
    expect(api.sent.map((b) => b.model)).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
    expect(s.use.byModel).toEqual({ 'claude-haiku-5-5': 1, 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 2 });
  });
  it('whoami names the person given, and fails without one so the PC user is used', async () => {
    await expect(svc(fakeApi(), { who: 'adoe' }).whoami()).resolves.toEqual({ name: 'adoe' });
    await expect(svc(fakeApi()).whoami()).rejects.toThrow();
  });
});

describe('signing in with an API key', () => {
  it('waits for a key, sends it, and after a refused key waits for the next one', async () => {
    const keys: (string | null)[] = []; const inner = fakeApi();
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const k = new Request(url, init).headers.get('authorization')?.replace(/^Bearer /, '') ?? null; keys.push(k);   // this SDK sends the key as a bearer token
      if (k === 'bad-key') return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
      return inner.fetch(url, init);
    }) as typeof globalThis.fetch;
    const holder = tokenHolder({ waitMs: 2000 }); const s = claudeService({ key: holder, fetch, maxRetries: 0 });
    const answer = s.complete({ model: 'fast', prompt: 'q' });
    holder.set('bad-key'); for (let i = 0; i < 100 && holder.signedIn(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(holder.signedIn()).toBe(false);
    holder.set('good-key');
    expect(await answer).toBe('ok'); expect(keys).toEqual(['bad-key', 'good-key']);
  });
});

describe('asking', () => {
  it('sends the files by their store ids, titled by name, before the question, and returns the text', async () => {
    const api = fakeApi([{ text: '{"answer": 1}' }]); const s = svc(api);
    const id = await s.upload({ name: 'doc_000000000000000000000001__Facility.pdf', bytes: PDF });
    expect(await s.complete({ model: 'fast', system: 'JSON only', prompt: 'What ratio?', files: [id] })).toBe('{"answer": 1}');
    expect(api.sent[0]).toMatchObject({ system: 'JSON only', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'file', file_id: id }, title: 'doc_000000000000000000000001__Facility.pdf' }, { type: 'text', text: 'What ratio?' }] }] });
    expect(s.use).toMatchObject({ calls: 1, input: 10, output: 2 });
  });
  it('a service that cannot be reached fails as "unreachable"; an error from the API fails that call only', async () => {
    const api = fakeApi([{ down: true }, { status: 400 }]); const s = svc(api);
    await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
    const e = await s.complete({ model: 'fast', prompt: 'q' }).catch((x) => x); expect(e.message).toMatch(/400/); expect(e.code).toBeUndefined();
  });
  it('a timeout, a rate limit, an overload or a server error left after the retries fails as "unreachable", so the checks wait and try again', async () => {
    const err = (type: string) => ({ type: 'error', error: { type, message: 'busy' } });
    const api = fakeApi([{ status: 429, body: err('rate_limit_error') }, { status: 529, body: err('overloaded_error') }, { status: 500, body: err('api_error') }, { status: 408, body: err('timeout_error') }, { status: 404, body: err('not_found_error') }]); const s = svc(api);
    for (const n of [429, 529, 500, 408]) { const e = await s.complete({ model: 'fast', prompt: 'q' }).catch((x) => x); expect(e.code).toBe('unreachable'); expect(e.message).toMatch(String(n)); }
    const e = await s.complete({ model: 'fast', prompt: 'q' }).catch((x) => x); expect(e.message).toMatch(/404/); expect(e.code).toBeUndefined();
  });
  it('a declined or cut-off reply is a failure, not an answer', async () => {
    const s = svc(fakeApi([{ stop: 'refusal' }, { stop: 'max_tokens', text: '{"cut' }]));
    await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/declined/);
    await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/cut off/);
  });
  it('marks a reply cut off at the length limit, in a single call and a conversation alike, and a request refused as too long', async () => {
    const tooBig = { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 210000 tokens > 200000 maximum' } } };
    const api = fakeApi([{ stop: 'max_tokens', text: '{"cut' }, { stop: 'max_tokens', text: '{"cut' }, tooBig]); const s = svc(api);
    await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'cutoff' });
    await expect(s.converse!({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'cutoff' });
    await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'toolong', status: 400 });
    expect(api.sent.map((b) => b.max_tokens)).toEqual([16000, 16000, 16000]);                  // the control file's limits.outputTokens
    expect([s.outputLimit!('fast'), s.inputLimit!('fast')]).toEqual([16000, 180000]);
  });
  it('stops at its call limit before sending', async () => {
    const api = fakeApi(); const s = svc(api, { maxCalls: 1 });
    await s.complete({ model: 'fast', prompt: 'q' }); await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/limit of 1/);
    expect(api.sent).toHaveLength(1);
  });
});

describe('the file store', () => {
  const sheets = Object.assign(async () => '', { id: 'stand-in', sheets: async () => [{ name: 'Debt', grid: [['Item', 'Value'], ['Senior', '412.5']] }] }) as unknown as Converter;
  it('a PDF goes in as it is, a spreadsheet as text through the converter, other text as it is', async () => {
    const api = fakeApi(); const s = svc(api, { convert: sheets });
    const a = await s.upload({ name: 'a.pdf', bytes: PDF }), b = await s.upload({ name: 'Model.xlsx', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) }), c = await s.upload({ name: 'notes.csv', bytes: text('x,y') });
    expect(api.files.get(a)?.type).toBe('application/pdf');
    expect(api.files.get(b)).toMatchObject({ type: 'text/plain', text: 'Sheet "Debt"\nItem\tValue\nSenior\t412.5' });
    expect(api.files.get(c)).toMatchObject({ type: 'text/plain', text: 'x,y' });
  });
  it('a file Claude cannot read is refused before anything is uploaded', async () => {
    const api = fakeApi(); const s = svc(api);
    await expect(s.upload({ name: 'Model.xlsx', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) })).rejects.toThrow(/no converter/);
    await expect(s.upload({ name: 'photo.bin', bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x9f]) })).rejects.toThrow(/cannot read/);
    expect(api.files.size).toBe(0);
  });
  it('lists everything in the store, and removing a file twice is not an error', async () => {
    const api = fakeApi(); const s = svc(api);
    const id = await s.upload({ name: 'a.txt', bytes: text('a') }); api.files.set('file_other', { name: 'theirs.pdf', type: 'application/pdf', text: '' });
    expect(await s.list()).toEqual([{ id, name: 'a.txt' }, { id: 'file_other', name: 'theirs.pdf' }]);
    await s.remove(id); await s.remove(id); expect(s.use.uploaded).toEqual([]); expect(api.files.has(id)).toBe(false);
  });
  it('the store keeper runs on it: names keep the document id, so the keeper recognizes its own files', async () => {
    const api = fakeApi(); const s = svc(api); const mem = new Map<string, string>();
    const local = { list: () => [...mem.keys()], size: () => -1, read: (n: string) => mem.get(n) ?? null, append: () => {}, write: (n: string, t: string) => { mem.set(n, t); } };
    const keeper = new StoreKeeper(s, local, { limit: 1, recheckMs: 0 });
    const doc = (n: number) => ({ docId: `doc_${String(n).padStart(24, '0')}`, name: `Folder/Doc ${n}.pdf`, read: () => PDF });
    await keeper.ensure([doc(1)]); await keeper.ensure([doc(2)]);                    // room for one: the first is taken out
    expect((await s.list()).map((f) => fromStoreName(f.name)?.docId)).toEqual([doc(2).docId]);
  });
});

describe('the Claude chat agent', () => {
  function agentApi(noTools = false) {
    return fakeApi({ noTools, answer: (seen) => {
      const reply = agentReply(seen);
      if (!reply.call) return { text: reply.text };
      const { name, args } = reply.call;
      return { tool: { id: `toolu_${name}`, name, input: args } };
    } });
  }

  it.each(['inline', 'hybrid', 'native'] as const)(
    'answers in %s mode by reading the attached PDF after a tool search',
    async (mode) => {
      const api = agentApi();
      const answer = await answerOn(svc(api), mode);
      expect(answer.ok && answer.value.text).toBe(AGENT_ANSWER);

      const turns = api.sent.filter((body) =>
        typeof body.system === 'string' && body.system.includes('You work in turns'));
      expect(turns).toHaveLength(2);
      expect(turns.every((body) => Boolean(body.tools) === (mode !== 'inline'))).toBe(true);
      const messages = turns[1].messages as Anthropic.MessageParam[];
      const followUp = messages.at(-1);
      expect(followUp?.role).toBe('user');
      if (mode === 'native') {
        expect(followUp?.content[0]).toMatchObject({
          type: 'tool_result', tool_use_id: 'toolu_search', content: expect.stringContaining(SEARCH_RESULT),
        });
      } else {
        expect(followUp?.content).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'text', text: expect.stringContaining(SEARCH_RESULT) }),
        ]));
      }
      if (mode === 'hybrid') {
        expect(followUp?.content[0]).toEqual({
          type: 'tool_result', tool_use_id: 'toolu_search', content: HYBRID_RESULT,
        });
      }
      if (mode === 'inline') {
        expect(followUp?.content).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'tool_result' }),
        ]));
      }
    },
  );

  it('steps down to the JSON block when the model refuses tools', async () => {
    const api = agentApi(true);
    const answer = await answerOn(svc(api), 'native');
    expect(answer.ok && answer.value.text).toBe(AGENT_ANSWER);
    expect(api.sent.some((body) => body.tools)).toBe(true);
    expect(api.sent.at(-1)?.tools).toBeUndefined();
  });

  it('the stand-in rejects a missing tool result even when a later user message supplies it', async () => {
    const api = fakeApi();
    const messages = [
      { role: 'user', content: 'Find the ratio.' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_first', name: 'search', input: { query: 'ratio' } },
        { type: 'tool_use', id: 'toolu_second', name: 'search', input: { query: 'lock-up' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_first', content: '1.25x' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_second', content: '1.25x' }] },
    ];
    const response = await api.fetch('https://claude.example/v1/messages', {
      method: 'POST', body: JSON.stringify({ messages }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { type: 'invalid_request_error', message: expect.stringContaining('toolu_second') },
    });
  });
});

describe('conversations', () => {
  it('keeps each conversation and resends it with prompt caching on; its size counts what was read from the cache', async () => {
    const api = fakeApi([{ text: 'one' }, { text: 'two' }]); const s = svc(api);
    const a = await s.converse!({ model: 'standard', system: 'Rules', prompt: 'first' });
    const b = await s.converse!({ model: 'standard', system: 'ignored later', prompt: 'second', conversation: a.conversation });
    expect([a.text, b.text, b.conversation]).toEqual(['one', 'two', a.conversation]);
    expect(api.sent[1]).toMatchObject({ system: 'Rules', cache_control: { type: 'ephemeral' } });
    expect((api.sent[1].messages as { role: string; content: unknown }[]).map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect((api.sent[1].messages as { content: unknown }[])[1].content).toEqual([{ type: 'text', text: 'one' }]);
    expect(b.tokens).toBe(12);
  });
  it('a conversation it does not have (after a restart) is "gone"; a failed turn is not kept', async () => {
    const api = fakeApi([{ status: 400 }, { text: 'ok' }]); const s = svc(api);
    await expect(s.converse!({ model: 'fast', prompt: 'q', conversation: 'talk_lost' })).rejects.toMatchObject({ code: 'gone' });
    await expect(s.converse!({ model: 'fast', prompt: 'q' })).rejects.toThrow();
    const r = await s.converse!({ model: 'fast', prompt: 'again' });
    expect((api.sent[1].messages as unknown[]).length).toBe(1); expect(r.text).toBe('ok');
  });
  it('with tools, the model must call one; the call comes back with its arguments, and the next turn answers it first, as a tool result', async () => {
    const api = fakeApi([{ tool: { id: 'toolu_1', name: 'search', input: { query: 'lock-up' } } }, { tool: { id: 'toolu_2', name: 'answer', input: { text: 'It is 1.25x.' } } }, { text: 'fine' }]); const s = svc(api);
    const tools = [{ name: 'search', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
    const a = await s.converse!({ model: 'standard', system: 'Rules', prompt: 'q', tools });
    expect(api.sent[0]).toMatchObject({ tools: [{ name: 'search', description: 'Search.', input_schema: tools[0].parameters }], tool_choice: { type: 'any' } });
    expect(a.calls).toEqual([{ id: 'toolu_1', name: 'search', args: { query: 'lock-up' } }]);
    const b = await s.converse!({ model: 'standard', prompt: 'turn 2', tools, results: [{ id: 'toolu_1', text: 'Found on p. 3.' }], conversation: a.conversation });
    const sent = api.sent[1].messages as { role: string; content: { type: string; tool_use_id?: string; content?: string }[] }[];
    expect(sent[1].content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'lock-up' } }]); expect(sent[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Found on p. 3.' });
    await s.converse!({ model: 'standard', prompt: 'next question', conversation: b.conversation });                                   // a call left unanswered is answered as not run, as the API requires
    expect((api.sent[2].messages as { content: { type: string; tool_use_id?: string }[] }[])[4].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_2' }); expect(api.sent[2].tools).toBeUndefined();
  });
});

describe('request retries', () => {
  const question = { model: 'fast', prompt: 'What ratio?' };
  const dropped = (code: string) => new TypeError('fetch failed', { cause: { code } });

  it.each(['complete', 'converse'] as const)('does not resend a dropped %s POST', async (operation) => {
    const api = fakeApi();
    let posts = 0;
    const service = claudeService({
      key: 'test',
      fetch: async (url, init) => {
        if (init?.method === 'POST' && ++posts === 1) throw dropped('UND_ERR_SOCKET');
        return api.fetch(url, init);
      },
    });
    await expect(service[operation]!(question)).rejects.toMatchObject({ code: 'unreachable' });
    expect(posts).toBe(1);
  });

  it('retries connections that failed before sending the request', async () => {
    const api = fakeApi();
    let attempts = 0;
    const service = claudeService({
      key: 'test',
      fetch: async (url, init) => {
        if (++attempts <= 2) throw dropped('ECONNREFUSED');
        return api.fetch(url, init);
      },
    });
    await expect(service.complete(question)).resolves.toBe('ok');
    expect(attempts).toBe(3);
  });

  it('counts a stalled request as unreachable within one deadline', async () => {
    let posts = 0;
    let signal: AbortSignal | null | undefined;
    const service = claudeService({
      key: 'test',
      timeoutMs: 35,
      fetch: (_url, init) => {
        posts++;
        signal = init?.signal;
        return new Promise(() => {});
      },
    });
    const started = Date.now();
    await expect(service.complete(question)).rejects.toMatchObject({ code: 'unreachable' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(posts).toBe(1);
    expect(signal?.aborted).toBe(true);
  });

  it.each(['stalled', 'dropped'])('counts a %s response body as unreachable after one POST', async (failure) => {
    let posts = 0;
    const service = claudeService({
      key: 'test',
      timeoutMs: 35,
      fetch: async (_url, init) => {
        posts++;
        const signal = init?.signal;
        const body = new ReadableStream({
          start(controller) {
            if (failure === 'dropped') controller.error(new TypeError('terminated'));
            else signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
          },
        });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(service.complete(question)).rejects.toMatchObject({ code: 'unreachable' });
    expect(posts).toBe(1);
  });

  it('leaves a dropped upload alone and retries a dropped list and delete', async () => {
    const api = fakeApi();
    const upload = { name: 'a.pdf', bytes: PDF };
    const id = await svc(api).upload(upload);
    const methods: string[] = [];
    const service = claudeService({
      key: 'test',
      fetch: async (url, init) => {
        if (url === 'data:,') return new Response(); // the SDK checks its multipart implementation
        const method = init?.method ?? 'GET';
        const first = !methods.includes(method);
        methods.push(method);
        if (first) throw dropped('UND_ERR_SOCKET');
        return api.fetch(url, init);
      },
    });
    await expect(service.upload(upload)).rejects.toMatchObject({ code: 'unreachable' });
    await expect(service.list()).resolves.toEqual([{ id, name: upload.name }]);
    await service.remove(id);
    expect(api.files.size).toBe(0);
    expect(methods).toEqual(['POST', 'GET', 'GET', 'DELETE', 'DELETE']);
  });

  it('retries list and delete when the response body drops after headers', async () => {
    const api = fakeApi();
    const file = { name: 'a.pdf', bytes: PDF };
    const id = await svc(api).upload(file);
    const methods: string[] = [];
    const service = claudeService({
      key: 'test',
      fetch: async (url, init) => {
        const method = init?.method ?? 'GET';
        const first = !methods.includes(method);
        methods.push(method);
        const reply = await api.fetch(url, init);
        if (!first) return reply;
        const body = new ReadableStream({
          start(controller) { controller.error(new TypeError('terminated')); },
        });
        return new Response(body, reply);
      },
    });
    await expect(service.list()).resolves.toEqual([{ id, name: file.name }]);
    await service.remove(id);
    expect(api.files.size).toBe(0);
    expect(methods).toEqual(['GET', 'GET', 'DELETE', 'DELETE']);
  });

  it.each(['stalled', 'timed out'])('stops after one attempt when a list reply body has %s', async (failure) => {
    let attempts = 0;
    const service = claudeService({
      key: 'test',
      timeoutMs: 35,
      fetch: async () => {
        attempts++;
        const body = new ReadableStream({
          start(controller) {
            if (failure === 'timed out') {
              controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } }));
            }
          },
        });
        return new Response(body, { headers: { 'content-type': 'application/json' } });
      },
    });
    await expect(service.list()).rejects.toMatchObject({ code: 'unreachable' });
    expect(attempts).toBe(1);
  });

  it.each([408, 429, 500, 529])('still retries an explicit %i HTTP response', async (status) => {
    const api = fakeApi();
    let attempts = 0;
    const service = claudeService({
      key: 'test',
      fetch: async (url, init) => {
        if (++attempts === 1) return new Response(null, { status, headers: { 'retry-after-ms': '1' } });
        return api.fetch(url, init);
      },
    });
    await expect(service.complete(question)).resolves.toBe('ok');
    expect(attempts).toBe(2);
  });

  it('retries a busy service twice by default, then reports it unreachable (#1110)', async () => {
    let attempts = 0;
    const service = claudeService({
      key: 'test',
      fetch: async () => {
        attempts++;
        return new Response(null, { status: 429, headers: { 'retry-after-ms': '1' } });
      },
    });
    await expect(service.complete(question)).rejects.toMatchObject({ code: 'unreachable' });
    expect(attempts).toBe(3);
  });
});
