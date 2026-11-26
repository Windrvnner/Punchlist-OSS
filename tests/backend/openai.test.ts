// @vitest-environment node
// The connector for OpenAI-compatible servers, on a stand-in server in memory: what it sends, what it reads
// back, the conversations it keeps on each API, the three ways of calling tools, and how it fails. No network and no key.
import { describe, it, expect } from 'vitest';
import { openAiService } from '../../src/backend/openai';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { tokenHolder } from '../../src/backend/signInToken';
import { agentReply, answerOn, AGENT_ANSWER, HYBRID_RESULT, SEARCH_RESULT } from './connectorAgentKit';
import { fakeServer } from './openaiStandIn';

const MODELS = { fast: 'small-model', standard: 'mid-model', thorough: 'large-model' };
const svc = (api: ReturnType<typeof fakeServer>, more: Partial<Parameters<typeof openAiService>[0]> = {}) => openAiService({ base: 'https://models.example/v1/', key: 'k1', models: MODELS, fetch: api.fetch, maxRetries: 0, retryMs: 1, ...more });
const text = (s: string) => new TextEncoder().encode(s);
const TOOLS = [{ name: 'search', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } } } }, { name: 'answer', description: 'Answer.', parameters: { type: 'object' } }];
const APIS = ['responses', 'chat'] as const;
const DROP_PHASES = ['before headers', 'in the body'] as const;

describe('the OpenAI-compatible connector', () => {
  it('a one-off call sends the tier\'s model, the system prompt, the documents by file id and the question last, on either API, and keeps nothing', async () => {
    const api = fakeServer({ replies: [{ text: '{"a": 1}' }, { text: '{"b": 2}' }] }); const s = svc(api);
    expect(await s.models()).toEqual({ models: [{ id: 'small-model', name: 'small-model' }, { id: 'mid-model', name: 'mid-model' }, { id: 'large-model', name: 'large-model' }], default: 'mid-model', ...MODELS });
    const id = await s.upload({ name: 'doc_1__Credit Agreement.pdf', bytes: text('%PDF-1.7 a page') });
    expect(await s.complete({ model: 'thorough', system: 'Be brief.', prompt: 'What is the ratio?', files: [id] })).toBe('{"a": 1}');
    expect(api.sent[0]).toEqual({ path: '/v1/responses', body: { model: 'large-model', instructions: 'Be brief.', input: [{ role: 'user', content: [{ type: 'input_file', file_id: id }, { type: 'input_text', text: 'What is the ratio?' }] }], store: false, max_output_tokens: 16000 } });
    expect(api.responses.size).toBe(0);
    expect(await svc(api, { api: 'chat' }).complete({ model: 'fast', system: 'Be brief.', prompt: 'And now?', files: [id] })).toBe('{"b": 2}');
    expect(api.sent[1]).toEqual({ path: '/v1/chat/completions', body: { model: 'small-model', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'file', file: { file_id: id } }, { type: 'text', text: 'And now?' }] }], max_tokens: 16000 } });
    expect(api.files.get(id)).toMatchObject({ name: 'doc_1__Credit Agreement.pdf', type: 'application/pdf', purpose: 'user_data' });
    expect(api.keys.every((k) => k === 'Bearer k1')).toBe(true);
  });

  it('on the Responses API a conversation is kept on the server: later turns name the last response and send only what is new', async () => {
    const api = fakeServer({ answer: (s) => ({ text: `heard ${s.said.split('\n').length} turns; ${s.system}; ${s.files}` }) }); const s = svc(api);
    const id = await s.upload({ name: 'doc_1__Note.txt', bytes: text('The ratio is 1.25x.') });
    const one = await s.converse!({ model: 'standard', system: 'Rules.', prompt: 'first', files: [id] });
    expect(one).toMatchObject({ text: 'heard 1 turns; \nRules.; The ratio is 1.25x.', conversation: 'resp_2' }); expect(one.tokens).toBeGreaterThan(0);
    const two = await s.converse!({ model: 'standard', prompt: 'second', conversation: one.conversation });
    expect(two.text).toBe('heard 2 turns; \nRules.; The ratio is 1.25x.');              // the system and the file came from the server's copy
    expect(api.sent[1].body).toEqual({ model: 'mid-model', store: true, previous_response_id: 'resp_2', input: [{ role: 'user', content: [{ type: 'input_text', text: 'second' }] }], max_output_tokens: 16000 });
    expect(two.tokens!).toBeGreaterThan(one.tokens!);
  });

  it('on chat completions a conversation is kept here and resent whole', async () => {
    const api = fakeServer({ answer: (s) => ({ text: `heard ${s.said.split('\n').length}` }) }); const s = svc(api, { api: 'chat' });
    const one = await s.converse!({ model: 'standard', system: 'Rules.', prompt: 'first' });
    const two = await s.converse!({ model: 'standard', prompt: 'second', conversation: one.conversation });
    expect(two.text).toBe('heard 2');
    expect(api.sent[1].body.messages).toEqual([{ role: 'system', content: 'Rules.' }, { role: 'user', content: [{ type: 'text', text: 'first' }] }, { role: 'assistant', content: 'heard 1' }, { role: 'user', content: [{ type: 'text', text: 'second' }] }]);
    await expect(svc(api, { api: 'chat' }).converse!({ model: 'standard', prompt: 'after a restart', conversation: one.conversation })).rejects.toMatchObject({ code: 'gone' });
  });

  for (const which of APIS) {
    it(`tool calls on ${which}: offered and required, read back by id, answered with their result (native) or pointing to the message (hybrid)`, async () => {
      const api = fakeServer({ answer: (s) => (s.said.includes('found it') ? { call: { name: 'answer', args: { text: 'done' } } } : { call: { name: 'search', args: { query: 'ratio' } } }) }); const s = svc(api, { api: which });
      const one = await s.converse!({ model: 'standard', system: 'Rules.', prompt: 'q', tools: TOOLS });
      expect(one.text).toBe(''); expect(one.calls).toEqual([{ id: expect.any(String), name: 'search', args: { query: 'ratio' } }]);
      expect(api.sent[0].body.tool_choice).toBe('required');
      expect(api.sent[0].body.tools[0]).toEqual(which === 'responses' ? { type: 'function', name: 'search', description: 'Search.', parameters: TOOLS[0].parameters, strict: false } : { type: 'function', function: { name: 'search', description: 'Search.', parameters: TOOLS[0].parameters } });
      const native = await s.converse!({ model: 'standard', prompt: 'turn 2', tools: TOOLS, results: [{ id: one.calls![0].id, text: 'found it' }], conversation: one.conversation });
      expect(native.calls).toEqual([{ id: expect.any(String), name: 'answer', args: { text: 'done' } }]);
      // hybrid: no results given, the result is in the prompt, and the call still gets its answer
      const two = await s.converse!({ model: 'standard', prompt: 'q', tools: TOOLS });
      const hybrid = await s.converse!({ model: 'standard', prompt: 'found it\n\nturn 2', tools: TOOLS, conversation: two.conversation });
      expect(hybrid.calls?.[0].name).toBe('answer');
      const last = api.sent.at(-1)!.body;
      if (which === 'responses') expect(last.input[0]).toEqual({ type: 'function_call_output', call_id: two.calls![0].id, output: 'Its result is in the message that follows.' });
      else expect(last.messages.at(-2)).toEqual({ role: 'tool', tool_call_id: two.calls![0].id, content: 'Its result is in the message that follows.' });
    });
  }

  it('a conversation begun on another PC (or before a restart) is carried on: the tools its last response called are asked of the server', async () => {
    const api = fakeServer({ answer: (s) => (s.tools ? { call: { name: 'search', args: {} } } : { text: 'ok' }) });
    const one = await svc(api).converse!({ model: 'standard', prompt: 'q', tools: TOOLS });
    const other = svc(api);                                                         // a new connector: knows nothing of resp_1's calls
    expect((await other.converse!({ model: 'standard', prompt: 'next', conversation: one.conversation })).text).toBe('ok');
    expect(api.gets).toEqual([one.conversation]);
    expect(api.sent.at(-1)!.body.input[0]).toMatchObject({ type: 'function_call_output', call_id: one.calls![0].id });
  });

  it('a conversation the server no longer has is "gone", so the app carries on in a new one; a model without tools fails with its status', async () => {
    const api = fakeServer(); const s = svc(api);
    await expect(s.converse!({ model: 'standard', prompt: 'q', conversation: 'resp_expired' })).rejects.toMatchObject({ code: 'gone' });   // asked of the server: 404
    const known = await s.converse!({ model: 'standard', prompt: 'q' }); api.responses.clear();
    await expect(s.converse!({ model: 'standard', prompt: 'q', conversation: known.conversation })).rejects.toMatchObject({ code: 'gone' });   // previous_response_id refused
    for (const which of APIS) {
      const e = await svc(fakeServer({ noTools: true }), { api: which }).converse!({ model: 'standard', prompt: 'q', tools: TOOLS }).catch((x) => x);
      expect(e.status).toBe(400); expect(e.code).toBeUndefined();                   // ai.ts reads a 400 on a turn with tools as the model refusing them, and steps down
    }
  });

  async function agentOn(which: (typeof APIS)[number], mode: 'inline' | 'hybrid' | 'native', noTools = false) {
    const api = fakeServer({ noTools, answer: agentReply });
    return { api, r: await answerOn(svc(api, { api: which }), mode) };
  }
  for (const which of APIS) {
    it(`the chat agent answers on ${which} in every way of calling tools, reading the attached file`, async () => {
      for (const mode of ['inline', 'hybrid', 'native'] as const) {
        const { api, r } = await agentOn(which, mode);
        expect(r.ok && r.value.text).toBe(AGENT_ANSWER);
        const turns = api.sent.filter((x) => JSON.stringify(x.body).includes('You work in turns') || x.body.previous_response_id);
        expect(turns.length).toBeGreaterThan(1);
        expect(turns.every((x) => (mode === 'inline' ? !x.body.tools : !!x.body.tools))).toBe(true);
        const outputs = JSON.stringify(api.sent.map((x) => x.body.input ?? x.body.messages));
        if (mode === 'native') expect(outputs).toContain(SEARCH_RESULT);
        if (mode === 'hybrid') expect(outputs).toContain(HYBRID_RESULT);
        if (which === 'responses') expect(turns.slice(1).every((x) => x.body.previous_response_id && !JSON.stringify(x.body).includes('You work in turns'))).toBe(true);   // later turns send only what is new
      }
    });
  }
  it('a model that refuses tool calls steps down to the JSON block and still answers', async () => {
    const { api, r } = await agentOn('responses', 'native', true);
    expect(r.ok && r.value.text).toBe(AGENT_ANSWER);
    expect(api.sent.some((x) => x.body.tools)).toBe(true); expect(api.sent.at(-1)!.body.tools).toBeUndefined();
  });

  it('keeps a store the store keeper can trim: list pages through its own files only, and removing a file already gone is not an error', async () => {
    const api = fakeServer(); const s = svc(api);
    for (let i = 1; i <= 5; i++) await s.upload({ name: `doc_${i}__Note ${i}.txt`, bytes: text(`note ${i}`) });
    api.files.set('file-fine-tune', { name: 'training.jsonl', type: 'application/jsonl', purpose: 'fine-tune', text: '' });   // the account's other files are never listed, so never trimmed
    expect((await s.list()).map((f) => f.name)).toEqual([1, 2, 3, 4, 5].map((i) => `doc_${i}__Note ${i}.txt`));       // three pages of two
    await s.remove('file-2'); await s.remove('file-2'); expect([...api.files.keys()]).toEqual(['file-1', 'file-3', 'file-4', 'file-5', 'file-fine-tune']);
    const local = { files: new Map<string, string>(), list() { return [...this.files.keys()]; }, read(n: string) { return this.files.get(n) ?? null; }, write(n: string, t: string) { this.files.set(n, t); }, append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }, size(n: string) { return this.files.get(n)?.length ?? -1; } };
    const keeper = new StoreKeeper(s, local, { limit: 10, recheckMs: 0 });
    expect(await keeper.ensure([{ docId: 'doc_9', name: 'Term sheet.pdf', read: () => text('%PDF-1.7 x') }])).toEqual({ doc_9: 'file-6' });
  });

  for (const which of APIS) {
    it(`on ${which}, a server that cannot be reached, or stays busy, is "unreachable"; a busy one is waited out; other refusals fail the one call`, async () => {
      const down = fakeServer({ replies: [{ down: true }] }); await expect(svc(down, { api: which }).complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
      const busy = fakeServer({ replies: [{ status: 429 }, { status: 503 }] }); await expect(svc(busy, { api: which }).complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
      const waited = fakeServer({ replies: [{ status: 429 }, { status: 503 }, { text: 'fine' }] }); expect(await svc(waited, { api: which, maxRetries: 2 }).complete({ model: 'fast', prompt: 'q' })).toBe('fine');
      const bad = fakeServer({ replies: [{ status: 400 }] }); const e = await svc(bad, { api: which }).complete({ model: 'fast', prompt: 'q' }).catch((x) => x); expect(e.message).toMatch(/said 400: no/); expect(e.code).toBeUndefined();
    });

    it(`on ${which}, a reply cut off or declined is an error, never passed on as an answer`, async () => {
      const api = fakeServer({ replies: [{ finish: 'length', text: '{"a": ' }, { refusal: 'I cannot help with that.' }, { finish: 'content_filter' }] }); const s = svc(api, { api: which });
      await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/cut off/);
      await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/declined/);
      await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/declined/);
    });
    it(`on ${which}, a cut-off is marked as one in a conversation too, and a request refused as too long says so`, async () => {
      const api = fakeServer({ replies: [{ finish: 'length', text: '{"a": ' }, { status: 400, error: { message: "This model's maximum context length is 128000 tokens.", code: 'context_length_exceeded' } }, { status: 400, error: { message: 'Input exceeds the context window of this model' } }] }); const s = svc(api, { api: which });
      await expect(s.converse!({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'cutoff' });
      await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'toolong' });
      await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'toolong' });
      expect([s.outputLimit!('fast'), s.inputLimit!('fast')]).toEqual([16000, 180000]);
    });
  }

  it('a refused sign-in token asks for a new one and the call goes on with it', async () => {
    const api = fakeServer(); let calls = 0;
    const inner = api.fetch; const fetch = (async (u: any, i?: any) => { const auth = new Headers(i?.headers).get('authorization'); if (auth === 'Bearer old' && calls++ === 0) return new Response('{"error":{"message":"expired"}}', { status: 401 }); return inner(u, i); }) as typeof globalThis.fetch;
    const holder = tokenHolder({ token: 'old' }); const s = svc(api, { key: holder, fetch });
    const going = s.complete({ model: 'fast', prompt: 'q' }); setTimeout(() => holder.set('new'), 10);
    expect(await going).toBe('ok'); expect(api.keys.at(-1)).toBe('Bearer new');
  });

  it('a spreadsheet needs the converter to go in as text; anything that is neither a PDF nor text is refused', async () => {
    const api = fakeServer(); const s = svc(api);
    await expect(s.upload({ name: 'Model.xlsx', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) })).rejects.toThrow(/no converter/);
    await expect(s.upload({ name: 'photo.jpg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xfe]) })).rejects.toThrow(/cannot read photo\.jpg/);
    const sheets = { sheets: async () => [{ name: 'Debt', grid: [['DSCR', '1.32']] }] } as any;
    const id = await svc(api, { convert: sheets }).upload({ name: 'Model.xlsx', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) });
    expect(api.files.get(id)).toMatchObject({ name: 'Model.xlsx.txt', type: 'text/plain', text: 'Sheet "Debt"\nDSCR\t1.32' });   // named as the text it now is
  });

  it('on chat completions, which names only PDFs by file id, a text document is kept here and goes in the message as text', async () => {
    const api = fakeServer({ answer: (s) => ({ text: s.said }) }); const sheets = { sheets: async () => [{ name: 'Debt', grid: [['DSCR', '1.32']] }] } as any;
    const s = svc(api, { api: 'chat', convert: sheets });
    const pdf = await s.upload({ name: 'doc_1__Credit Agreement.pdf', bytes: text('%PDF-1.7 a page') });
    const note = await s.upload({ name: 'doc_2__Note.txt', bytes: text('The ratio is 1.25x.') });
    const sheet = await s.upload({ name: 'doc_3__Model.xlsx', bytes: new Uint8Array([0x50, 0x4b, 3, 4]) });
    expect([...api.files.keys()]).toEqual([pdf]);                                    // only the PDF is in the server's store
    expect(await s.complete({ model: 'fast', prompt: 'q', files: [pdf, note, sheet] })).toBe('Document "doc_2__Note.txt":\nThe ratio is 1.25x.Document "doc_3__Model.xlsx.txt":\nSheet "Debt"\nDSCR\t1.32q');
    expect(api.sent[0].body.messages[0].content[0]).toEqual({ type: 'file', file: { file_id: pdf } });
    expect((await s.list()).map((f) => f.name)).toEqual(['doc_2__Note.txt', 'doc_3__Model.xlsx.txt', 'doc_1__Credit Agreement.pdf']);
    await s.remove(note); await s.remove(note); expect((await s.list()).map((f) => f.id)).toEqual([sheet, pdf]);
    expect((await svc(api, { api: 'chat' }).list()).map((f) => f.id)).toEqual([pdf]);   // after a restart the text is gone, and the store keeper gives it again
    const bare = svc(fakeServer({ noStore: true }), { api: 'chat' });               // a server with no file store still reads text
    const id = await bare.upload({ name: 'doc_4__Memo.txt', bytes: text('memo') }); expect(await bare.list()).toEqual([{ id, name: 'doc_4__Memo.txt' }]);
    await expect(bare.upload({ name: 'doc_5__Lease.pdf', bytes: text('%PDF-1.7 x') })).rejects.toThrow(/no file store, so only text documents can be read, not doc_5__Lease\.pdf/);
  });

  for (const [api, path] of [['responses', '/v1/responses'], ['chat', '/v1/chat/completions']] as const) {
    it.each(DROP_PHASES)(`does not resend a ${api} POST when the response drops %s (#454)`, async (phase) => {
      const standIn = fakeServer();
      const drop = dropFirstReply(standIn, 'POST', phase);
      const s = svc(standIn, { api, fetch: drop.fetch, maxRetries: 2 });
      await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
      expect(drop.paths).toEqual([path]);
      expect(standIn.sent).toHaveLength(1);
    });
  }

  it.each(DROP_PHASES)('does not resend a file upload when the response drops %s (#454)', async (phase) => {
    const api = fakeServer();
    const drop = dropFirstReply(api, 'POST', phase);
    const s = svc(api, { fetch: drop.fetch, maxRetries: 2 });
    await expect(s.upload({ name: 'Note.txt', bytes: text('note') })).rejects.toMatchObject({ code: 'unreachable' });
    expect(drop.paths).toEqual(['/v1/files']);
    expect(api.files.size).toBe(1);
  });

  it('retries a POST when the connection could not be made (#454)', async () => {
    const api = fakeServer();
    let attempts = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      if (++attempts <= 2) throw networkFailure('ECONNREFUSED');
      return api.fetch(url, init);
    };
    const s = svc(api, { fetch, maxRetries: 2 });
    expect(await s.complete({ model: 'fast', prompt: 'q' })).toBe('ok');
    expect(attempts).toBe(3);
    expect(api.sent).toHaveLength(1);
  });

  it.each(DROP_PHASES)('retries a file list or deletion when the response drops %s (#454)', async (phase) => {
    const api = fakeServer();
    const id = await svc(api).upload({ name: 'Note.txt', bytes: text('note') });
    const read = dropFirstReply(api, 'GET', phase);
    expect(await svc(api, { fetch: read.fetch, maxRetries: 2 }).list()).toEqual([{ id, name: 'Note.txt' }]);
    expect(read.paths).toEqual(['/v1/files', '/v1/files']);
    const remove = dropFirstReply(api, 'DELETE', phase);
    await svc(api, { fetch: remove.fetch, maxRetries: 2 }).remove(id);
    expect(remove.paths).toEqual([`/v1/files/${id}`, `/v1/files/${id}`]);
    expect(api.files.has(id)).toBe(false);
  });

  it('a request that stalls past the timeout is "unreachable" at once, not run again', async () => {
    let tries = 0;
    const stalled = (async (_u: unknown, i?: RequestInit) => { tries++; return new Promise<Response>((_, no) => i?.signal?.addEventListener('abort', () => no(i.signal!.reason))); }) as typeof globalThis.fetch;
    const s = openAiService({ base: 'https://models.example/v1', key: 'k1', models: MODELS, fetch: stalled, maxRetries: 1, retryMs: 1, timeoutMs: 20 });
    await expect(s.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' }); expect(tries).toBe(1);
  });

  it('does not retry a file list when its body stalls past the timeout (#454)', async () => {
    let tries = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      tries++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text('{"data":['));
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('body aborted', 'AbortError'));
          }, { once: true });
        },
      });
      return new Response(body);
    };
    const s = svc(fakeServer(), { fetch, maxRetries: 2, timeoutMs: 20 });
    await expect(s.list()).rejects.toMatchObject({ code: 'unreachable' });
    expect(tries).toBe(1);
  });

  it('retries a busy service twice by default, then reports it unreachable (#1110)', async () => {
    const api = fakeServer({ replies: [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }] });
    const service = openAiService({
      base: 'https://models.example/v1/', key: 'k1', models: MODELS, fetch: api.fetch, retryMs: 1,
    });
    await expect(service.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(api.sent).toHaveLength(3);
  });
});

function networkFailure(code: string) {
  return new TypeError('fetch failed', { cause: { code } });
}

function dropFirstReply(api: ReturnType<typeof fakeServer>, method: string, phase: (typeof DROP_PHASES)[number]) {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    const reply = await api.fetch(request);
    if (request.method !== method) return reply;
    paths.push(new URL(request.url).pathname);
    if (paths.length > 1) return reply;
    const failure = networkFailure('UND_ERR_SOCKET');
    if (phase === 'before headers') throw failure;
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.error(failure) });
    return new Response(body, { status: reply.status, headers: reply.headers });
  };
  return { fetch, paths };
}
