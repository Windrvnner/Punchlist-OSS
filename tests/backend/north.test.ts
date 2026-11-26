// @vitest-environment node
// The North connector against the stand-in North server (tests/backend/northStandIn.ts), which follows North's
// published API reference. Real North is never reached from here.
import { describe, it, expect, afterEach } from 'vitest';
import { northService, latinName } from '../../src/backend/north';
import { tokenHolder } from '../../src/backend/signInToken';
import { StoreKeeper } from '../../src/backend/storeKeeper';
import { northStandIn, jwt, type ChatBody } from './northStandIn';
import { nodeAi } from '../../src/backend/ai';
import { memRepo } from '../adapters/memRepo';
import { Mem } from './reviewKit';

const TIERS = { fast: 'model-fast', standard: 'model-standard', thorough: 'model-thorough' };
const text = (s: string) => new TextEncoder().encode(s);
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function setUp(o: Parameters<typeof northStandIn>[0] = {}, token = 'good-token') {
  const north = await northStandIn(o); close = north.close;
  const holder = tokenHolder({ waitMs: 2000, token });
  const svc = northService({ address: north.address, token: holder, models: TIERS, sleep: async () => {}, pollMs: 1 });
  return { north, holder, svc };
}

describe('who and which models', () => {
  it('whoami names the person North has signed in, and every call carries the bearer token under /api', async () => {
    const { north, svc } = await setUp();
    expect(await svc.whoami()).toEqual({ name: 'jdoe' });
    expect(north.seen[0]).toMatchObject({ method: 'GET', path: '/v1/users/me', auth: 'Bearer good-token' });
  });
  it('models: every page of /v2/models, by name, with the tiers from the control file', async () => {
    const { svc } = await setUp({ pageSize: 1 });
    const m = await svc.models();
    expect(m.models).toEqual([
      { id: 'model-fast', name: 'Model Fast' },
      { id: 'model-standard', name: 'Model Standard' },
      { id: 'model-thorough', name: 'Model Thorough' },
      { id: 'command-a', name: 'Command A' },
    ]);
    expect(m).toMatchObject({ default: TIERS.standard, ...TIERS });
  });
  it('a tier North does not offer is named, so the control file can be put right', async () => {
    const north = await northStandIn(); close = north.close;
    const svc = northService({ address: north.address, token: tokenHolder({ waitMs: 100, token: 'good-token' }), models: { ...TIERS, thorough: 'claude-opus-9' }, sleep: async () => {} });
    await expect(svc.models()).rejects.toThrow(/claude-opus-9 \(the thorough model/);
  });
  it('an older North without /v2/models is read from /v1/models', async () => {
    const { north, svc } = await setUp();
    north.faults.push({ path: '/v2/models', status: 404 });
    expect((await svc.models()).models.map((m) => m.id)).toContain('model-thorough');
  });
});

describe('asking', () => {
  it('sends stream false, the model for the tier, the system and user messages and the file ids, with no agent or tools', async () => {
    const { north, svc } = await setUp({ answer: (_b, files) => `{"read": ${JSON.stringify(files.map((f) => f.filename))}}` });
    const id = await svc.upload({ name: 'doc_000000000000000000000001__Facility.pdf', bytes: text('%PDF-1.7') });
    expect(await svc.complete({ model: 'fast', system: 'JSON only', prompt: 'What ratio?', files: [id] })).toBe('{"read": ["doc_000000000000000000000001__Facility.pdf"]}');
    const b = north.chats[0] as ChatBody & Record<string, unknown>;
    expect(b).toEqual({
      stream: false,
      model: 'model-fast',
      max_tokens: 16000,
      messages: [
        { role: 'system', content: 'JSON only' },
        { role: 'user', content: 'What ratio?' },
      ],
      file_ids: [id],
    });
  });
  it('a model named by its own id is sent as it is', async () => {
    const { north, svc } = await setUp();
    await svc.complete({ model: 'command-a', prompt: 'q' }); expect(north.chats[0].model).toBe('command-a');
  });
  it('chat carries a conversation on by its North id; a one-off call names none', async () => {
    const { north, svc } = await setUp();
    const first = await svc.chat({ model: 'standard', prompt: 'hello' });
    const next = await svc.chat({ model: 'standard', prompt: 'and then?', conversation: first.conversation });
    expect(next.conversation).toBe(first.conversation);
    expect(north.chats[0].conversation).toBeUndefined(); expect(north.chats[1].conversation).toEqual({ id: first.conversation });
  });
  it('converse: the first turn starts a conversation with its system message, later turns send only what is new, and the size comes back', async () => {
    const { north, svc } = await setUp();
    const first = await svc.converse!({ model: 'standard', system: 'Rules', prompt: 'hello' });
    const next = await svc.converse!({ model: 'standard', system: 'Rules', prompt: 'and then?', conversation: first.conversation });
    expect(next.conversation).toBe(first.conversation); expect(first.tokens).toBe(14);
    expect(north.chats.map((c) => c.messages)).toEqual([[{ role: 'system', content: 'Rules' }, { role: 'user', content: 'hello' }], [{ role: 'user', content: 'and then?' }]]);
  });
  it('converse: a conversation North no longer has is "gone", so the app can start another; a missing file is not', async () => {
    const { svc } = await setUp();
    await expect(svc.converse!({ model: 'standard', prompt: 'q', conversation: 'conv_lost' })).rejects.toMatchObject({ code: 'gone' });
    const r = await svc.converse!({ model: 'standard', prompt: 'q' });
    await expect(svc.converse!({ model: 'standard', prompt: 'q', files: ['file_missing'], conversation: r.conversation })).rejects.not.toMatchObject({ code: 'gone' });
  });
  it('converse with tools: the tools go as functions with a tool required, the calls come back with their arguments, and their results go back as tool messages', async () => {
    const replies: ({ calls: { name: string; arguments: string }[] } | string)[] = [{ calls: [{ name: 'search', arguments: '{"query":"lock-up","what":"documents"}' }] }, 'done'];
    const { north, svc } = await setUp({ answer: () => replies.shift()! });
    const tools = [{ name: 'search', description: 'Search the documents.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
    const first = await svc.converse!({ model: 'standard', system: 'Rules', prompt: 'What is the lock-up?', tools });
    expect(north.chats[0].tools).toEqual([{ type: 'function', function: tools[0] }]); expect((north.chats[0] as { tool_choice?: string }).tool_choice).toBe('REQUIRED');
    expect(first.calls).toEqual([{ id: 'call_1_0', name: 'search', args: { query: 'lock-up', what: 'documents' } }]); expect(first.text).toBe('');
    const next = await svc.converse!({ model: 'standard', prompt: 'Turn 2.', tools, results: [{ id: 'call_1_0', text: 'Found on p. 3.' }], conversation: first.conversation });
    expect(north.chats[1].messages).toEqual([{ role: 'tool', tool_call_id: 'call_1_0', content: 'Found on p. 3.' }, { role: 'user', content: 'Turn 2.' }]); expect(next.text).toBe('done'); expect(next.calls).toBeUndefined();
  });
  it('a North that fails a role:tool result with a 500 fails that turn, as neither unreachable nor gone', async () => {
    const { svc } = await setUp({ rejectToolResults: true, answer: () => ({ calls: [{ name: 'search', arguments: '{}' }] }) });
    const tools = [{ name: 'search', description: 'Search.', parameters: { type: 'object' } }];
    const first = await svc.converse!({ model: 'standard', prompt: 'q', tools });
    const err = await svc.converse!({ model: 'standard', prompt: 'turn 2', tools, results: [{ id: first.calls![0].id, text: 'found' }], conversation: first.conversation }).catch((e) => e);
    expect(err).toBeInstanceOf(Error); expect(err.status).toBe(500); expect(err.code).not.toBe('unreachable'); expect(err.code).not.toBe('gone');
    expect((await svc.converse!({ model: 'standard', prompt: 'found\n\nturn 2', tools, conversation: first.conversation })).calls).toHaveLength(1);   // the same result as a message is taken
  });
  it('North\'s own tools go with the function tools, and the ones its agents use can be listed', async () => {
    const north = await northStandIn({ answer: () => 'ok' }); close = north.close;
    const svc = northService({ address: north.address, token: tokenHolder({ waitMs: 2000, token: 'good-token' }), models: TIERS, sleep: async () => {}, pollMs: 1, hostedTools: ['file_reader'] });
    await svc.converse!({ model: 'standard', prompt: 'q', tools: [{ name: 'search', description: 'Search.', parameters: { type: 'object' } }] }); await svc.complete({ model: 'standard', prompt: 'one-off' });
    expect(north.chats[0].tools).toEqual([{ type: 'function', function: { name: 'search', description: 'Search.', parameters: { type: 'object' } } }, { type: 'north_tool', north_tool: { name: 'file_reader' } }]);
    expect(north.chats[1].tools).toBeUndefined();                                                                                             // a one-off call names no tools, so North's default ones read its files
    expect(await svc.agentTools()).toEqual(['file_reader', 'web_search']);
  });

  /** the chat agent on the stand-in North, which fails a role:tool result with a 500 and reads files on a call with tools only through its file tool */
  async function agentOnNorth(mode: 'inline' | 'hybrid' | 'native', hostedTools: string[]) {
    const said = (b: ChatBody) => String([...(b.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '');
    const read = (files: { bytes: Uint8Array }[]) => files.map((f) => new TextDecoder().decode(f.bytes)).join(' ');
    let got = '';                                                                                    // what the model read: the conversation keeps its files, so it is read on the turn they come with
    const reply = (b: ChatBody, files: { bytes: Uint8Array }[]) => { got ||= read(files); return said(b).includes('You searched documents for “ratio”') ? { text: `Read: ${got || 'nothing'}`, sources: [] } : { tool: 'search', what: 'documents', query: 'ratio' }; };
    const north = await northStandIn({ rejectToolResults: true, fileTool: 'file_reader', answer: (b, files) => {
      if (!(b.messages ?? []).some((m) => m.role === 'system' && String(m.content).includes('You work in turns')) && !b.conversation) return '{"text": "", "sources": []}';   // the search helper
      const r = reply(b, files); if (!b.tools) return JSON.stringify(r);
      const { tool, ...args } = r as Record<string, unknown>; return { calls: [{ name: typeof tool === 'string' ? tool : 'answer', arguments: JSON.stringify(args) }] };
    } }); close = north.close;
    const svc = northService({ address: north.address, token: tokenHolder({ waitMs: 2000, token: 'good-token' }), models: TIERS, sleep: async () => {}, pollMs: 1, hostedTools });
    const clock = () => '2026-11-15T09:00:00.000Z'; const DOC = { docId: 'doc_1', hash: 'h', name: 'Credit Agreement.pdf', folder: 'vdr', rel: 'Credit Agreement.pdf', size: 1, pages: 3 };
    const ai = nodeAi({ service: svc, docs: { records: () => [DOC], wanted: async () => [{ docId: 'doc_1', name: DOC.name, read: () => text('The lock-up ratio is 1.25x.') }] }, keeper: new StoreKeeper(svc, new Mem(), { recheckMs: 0, clock }), repo: memRepo(clock), clock, toolCalls: mode });
    const r = await ai.answer({ dealId: 'd1', message: 'What is the lock-up ratio?', history: [], model: 'standard', attachments: [{ doc: DOC.name, docId: 'doc_1' }] });
    return { north, r, turns: north.chats.filter((b) => b.conversation || (b.messages ?? []).some((m) => m.role === 'system' && String(m.content).includes('call one tool'))) };
  }
  it('every way of calling tools answers on the stand-in North, reading the attached file, with North\'s file tool named', async () => {
    for (const mode of ['inline', 'hybrid', 'native'] as const) {
      const { north, r, turns } = await agentOnNorth(mode, ['file_reader']);
      expect(r.ok && r.value.text).toBe('Read: The lock-up ratio is 1.25x.');
      expect(turns.every((b) => mode === 'inline' ? !b.tools : (b.tools as { type: string }[]).some((t) => t.type === 'north_tool'))).toBe(true);
      if (mode === 'native') expect(north.seen.filter((x) => x.path === '/v1/chat').length).toBe(north.chats.length + 1);   // the role:tool result failed with a 500, and went again in the message
      await north.close(); close = undefined;
    }
  });
  it('without North\'s file tool named, a call with tools does not read the attached file: what the setting is for', async () => {
    const { r } = await agentOnNorth('hybrid', []); expect(r.ok && r.value.text).toBe('Read: nothing');
  });
  it('a request that stalls past the timeout counts as unreachable, so a check carries on later', async () => {
    const stalled = (async (_u: unknown, i?: RequestInit) => new Promise<Response>((_, no) => i?.signal?.addEventListener('abort', () => no(i.signal!.reason)))) as typeof fetch;
    const svc = northService({ address: 'https://north.example.com', token: tokenHolder({ waitMs: 2000, token: 'good-token' }), models: TIERS, fetch: stalled, sleep: async () => {}, timeoutMs: 20 });
    await expect(svc.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
  });
  it('a cut-off or unfinished reply is a failure, not an answer', async () => {
    const replies = [{ text: '{"cut', finish: 'MAX_TOKENS' }, { finish: 'TIMEOUT' }];
    const { svc } = await setUp({ answer: () => replies.shift()! });
    await expect(svc.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/cut off/);
    await expect(svc.complete({ model: 'fast', prompt: 'q' })).rejects.toThrow(/TIMEOUT/);
  });
  it('asks for no more than the model allows: the control file\'s limits, or a model\'s own max_tokens and context_length from /v2/models', async () => {
    const replies = [{ text: '{"cut', finish: 'MAX_TOKENS' }];
    const { north, svc } = await setUp({ answer: () => replies.shift() ?? 'ok' });
    expect([svc.outputLimit!('fast'), svc.inputLimit!('fast')]).toEqual([16000, 180000]);         // nothing listed yet: the control file's
    await expect(svc.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'cutoff' });
    await svc.models();
    expect([svc.outputLimit!('command-a'), svc.inputLimit!('command-a')]).toEqual([4000, 124000]);   // its context less room for the reply
    expect([svc.outputLimit!('fast'), svc.inputLimit!('fast')]).toEqual([16000, 180000]);           // a model that lists no limits
    await svc.complete({ model: 'command-a', prompt: 'q' });
    expect((north.chats.at(-1) as Record<string, unknown>).max_tokens).toBe(4000);
    // a request refused as too long says so, whatever North calls it
    north.faults.push({ path: '/v1/chat', status: 400, code: 'INVALID_REQUEST', message: 'The prompt is too long for this model: 190000 tokens > 128000 maximum context length.' });
    await expect(svc.complete({ model: 'command-a', prompt: 'q' })).rejects.toMatchObject({ code: 'toolong' });
  });
});

describe('failures', () => {
  it('no connection is "unreachable"; an error from North fails that call with its code and message', async () => {
    const { north, svc } = await setUp();
    north.faults.push({ path: '/v1/chat', drop: true }, { path: '/v1/chat', status: 400, code: 'BAD_MODEL' });   // a chat that dropped after it was sent is not sent again: it may be answered, and paid for, twice
    await expect(svc.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
    const e = await svc.complete({ model: 'fast', prompt: 'q' }).catch((x) => x);
    expect(e.message).toMatch(/400 BAD_MODEL: A fault the test asked for/); expect(e.code).toBeUndefined();
  });
  it('a read that dropped, or a connection that could not be made, is tried again a couple of times before it counts as unreachable (decisions: Retries)', async () => {
    const north = await northStandIn(); close = north.close; const waits: number[] = [];
    const svc = northService({ address: north.address, token: tokenHolder({ waitMs: 100, token: 'good-token' }), models: TIERS, sleep: async (ms) => { waits.push(ms); } });
    north.faults.push({ path: '/v1/users/me', drop: true }, { path: '/v1/users/me', drop: true });
    expect((await svc.whoami()).name).toBeTruthy(); expect(waits).toEqual([1000, 2000]);
    let n = 0; const refused = (async () => { n++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;
    const off = northService({ address: 'https://north.example.com', token: tokenHolder({ waitMs: 100, token: 'good-token' }), models: TIERS, fetch: refused, sleep: async () => {} });
    await expect(off.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' }); expect(n).toBe(3);   // never sent, so a chat is tried again too
  });
  it('busy (429, 503) is waited out as North asks, then tried again', async () => {
    const north = await northStandIn(); close = north.close; const waits: number[] = [];
    const svc = northService({ address: north.address, token: tokenHolder({ waitMs: 100, token: 'good-token' }), models: TIERS, sleep: async (ms) => { waits.push(ms); } });
    north.faults.push({ path: '/v1/chat', status: 429, retryAfter: 7 }, { path: '/v1/chat', status: 503 });
    expect(await svc.complete({ model: 'fast', prompt: 'q' })).toBe('ok');
    expect(waits).toEqual([7000, 4000]);
  });
  it('busy for too long counts as unreachable, so the check carries on later', async () => {
    const { north, svc } = await setUp();
    for (const status of [429, 503, 429, 503]) north.faults.push({ path: '/v1/chat', status });
    await expect(svc.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
    expect(north.seen.filter((s) => s.path === '/v1/chat')).toHaveLength(3);   // one try and two retries (#1110)
  });
  it('an expired token pauses the call; after a new sign-in it carries on', async () => {
    const live = jwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    const { north, holder, svc } = await setUp({ tokens: [live] }, 'stale-token');
    const answer = svc.complete({ model: 'fast', prompt: 'q' });
    await new Promise((r) => setTimeout(r, 50)); expect(holder.signedIn()).toBe(false);
    holder.set(live);
    expect(await answer).toBe('ok');
    expect(north.seen.map((s) => s.auth)).toEqual(['Bearer stale-token', `Bearer ${live}`]);
  });
  it('nobody signing in for too long fails as unreachable, and nothing is sent without a token', async () => {
    const north = await northStandIn(); close = north.close;
    const svc = northService({ address: north.address, token: tokenHolder({ waitMs: 30 }), models: TIERS });
    await expect(svc.whoami()).rejects.toMatchObject({ code: 'unreachable' }); expect(north.seen).toHaveLength(0);
  });
});

describe('the file store', () => {
  it('upload waits until North has processed the file, so it can be read at once', async () => {
    const { north, svc } = await setUp({ processAfter: 3 });
    const id = await svc.upload({ name: 'doc_000000000000000000000002__Model.xlsx', bytes: text('PK') });
    expect(north.seen.filter((s) => s.path === `/v1/files/${id}`)).toHaveLength(3);
    await expect(svc.complete({ model: 'fast', prompt: 'q', files: [id] })).resolves.toBe('ok');
  });
  it('a file North cannot read fails the upload and is taken out of the store', async () => {
    const { north, svc } = await setUp({ failFile: /Broken/ });
    await expect(svc.upload({ name: 'doc_000000000000000000000003__Broken.pdf', bytes: text('x') })).rejects.toThrow(/could not read .*Broken.pdf: The file could not be parsed/);
    expect(north.files.size).toBe(0);
  });
  it('names outside the Latin alphabet are spelled in it, keeping the document id at the front', async () => {
    expect(latinName('doc_000000000000000000000004__Société Lucérne – 契約.pdf')).toBe('doc_000000000000000000000004__Societe Lucerne _ __.pdf');
    const { north, svc } = await setUp();
    await svc.upload({ name: 'doc_000000000000000000000004__Société – 契約.pdf', bytes: text('%PDF') });
    expect([...north.files.values()][0].filename).toBe('doc_000000000000000000000004__Societe _ __.pdf');
  });
  it('list reads every page; remove takes a file out, and one already gone is not an error', async () => {
    const { svc } = await setUp({ pageSize: 2 });
    const ids: string[] = []; for (let i = 0; i < 5; i++) ids.push(await svc.upload({ name: `f${i}.txt`, bytes: text('t') }));
    expect((await svc.list()).map((f) => f.id)).toEqual(ids);
    await svc.remove(ids[0]); await svc.remove(ids[0]);
    expect(await svc.list()).toHaveLength(4);
  });
  it('the store keeper runs on it unchanged: documents go up once and are named in calls by file id', async () => {
    const { north, svc } = await setUp();
    const mem = new Map<string, string>(); const local = { read: (k: string) => mem.get(k) ?? null, write: (k: string, v: string) => { mem.set(k, v); } };
    const keeper = new StoreKeeper(svc, local as never, { limit: 10 });
    const doc = { docId: 'doc_000000000000000000000005', name: 'Credit Agreement.pdf', read: () => text('%PDF') };
    const a = await keeper.ensure([doc]); const b = await keeper.ensure([doc]);
    expect(a).toEqual(b); expect(north.files.size).toBe(1);
  });
});
