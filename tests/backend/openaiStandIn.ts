// An OpenAI-compatible server in memory, for the connector's tests (tests/backend/openai.test.ts) and the AI check on
// a stand-in (tests/e2e/ai-check.test.ts). No network and no key.

/** a scripted reply: an error status, a dropped connection, a cut-off or filtered finish, a refusal, text, or a tool call */
export type Reply = { status?: number; error?: { message: string; code?: string }; finish?: 'length' | 'content_filter'; text?: string; refusal?: string; down?: boolean; call?: { name: string; args: Record<string, unknown> } };
/** what a reply is chosen from: the whole conversation as text (system, user turns and tool results), its files' text, whether tools were offered */
export type Seen = { system: string; said: string; files: string; tools: boolean };
type Item = Record<string, any>;

/**
 * An OpenAI-compatible server in memory, as far as the connector uses it: a file store that pages (purpose kept), the
 * Responses API with stored responses (previous_response_id, GET by id) and chat completions. Like the real ones, it
 * refuses a turn that leaves a tool call of the turn before unanswered, and an unknown previous response.
 */
export function fakeServer(o: { replies?: Reply[]; answer?: (s: Seen) => Reply; page?: number; noTools?: boolean; noStore?: boolean } = {}) {
  const files = new Map<string, { name: string; type: string; purpose: string; text: string }>();
  const responses = new Map<string, { history: Item[]; calls: string[] }>();
  const sent: { path: string; body: Item }[] = []; const keys: string[] = []; const gets: string[] = []; let n = 0;
  const page = o.page ?? 2;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const bad = (message: string, param: string | null = null) => json({ error: { message, type: 'invalid_request_error', param, code: null } }, 400);
  const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '');
  const fileIds = (c: unknown): string[] => (Array.isArray(c) ? c.flatMap((p) => (p.file_id ? [p.file_id] : p.file?.file_id ? [p.file.file_id] : [])) : []);
  const pick = (s: Seen): Reply => o.answer?.(s) ?? o.replies?.shift() ?? {};
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init); const u = new URL(req.url); const p = u.pathname; keys.push(req.headers.get('authorization') ?? '');
    if (p === '/v1/responses' && req.method === 'POST') {
      const b = await req.json(); if (o.replies?.[0]?.down) { o.replies.shift(); throw new TypeError('fetch failed'); }
      sent.push({ path: p, body: b });
      const prev = b.previous_response_id ? responses.get(b.previous_response_id) : { history: [], calls: [] };
      if (!prev) return bad(`Previous response with id '${b.previous_response_id}' not found.`, 'previous_response_id');
      const answered = (b.input as Item[]).filter((i) => i.type === 'function_call_output').map((i) => i.call_id);
      const open = prev.calls.find((id) => !answered.includes(id)); if (open) return bad(`No tool output found for function call ${open}.`, 'input');
      if (b.tools && o.noTools) return bad('This model does not support tools.', 'tools');
      if (b.tools?.some((t: Item) => t.strict !== false)) return bad('strict function schemas need additionalProperties: false', 'tools');
      const history = [...prev.history, ...b.input];
      const system = [b.instructions ?? '', ...history.filter((i) => i.role === 'system').map((i) => textOf(i.content))].join('\n');
      const said = history.map((i) => (i.role === 'user' ? textOf(i.content) : i.type === 'function_call_output' ? i.output : '')).filter(Boolean).join('\n');
      const r = pick({ system, said, files: history.flatMap((i) => fileIds(i.content)).map((id) => files.get(id)?.text ?? '').join(' '), tools: !!b.tools });
      if (r.status) return json({ error: r.error ?? { message: 'no' } }, r.status);
      const id = `resp_${++n}`; const call = r.call ? { type: 'function_call', call_id: `call_${++n}`, name: r.call.name, arguments: JSON.stringify(r.call.args) } : null;
      const output = call ? [call] : [{ type: 'message', role: 'assistant', content: r.refusal ? [{ type: 'refusal', refusal: r.refusal }] : [{ type: 'output_text', text: r.text ?? 'ok' }] }];
      if (b.store) responses.set(id, { history: [...history, ...output], calls: call ? [call.call_id] : [] });
      return json({ id, object: 'response', status: r.finish ? 'incomplete' : 'completed', incomplete_details: r.finish ? { reason: r.finish === 'length' ? 'max_output_tokens' : 'content_filter' } : null, output, usage: { input_tokens: Math.round(JSON.stringify(history).length / 4), output_tokens: 10 } });
    }
    const got = /^\/v1\/responses\/(.+)$/.exec(p);
    if (got) { gets.push(got[1]); const r = responses.get(decodeURIComponent(got[1])); return r ? json({ id: got[1], output: r.history.filter((i) => i.type === 'function_call' || i.type === 'message').slice(-1) }) : json({ error: { message: 'No response found' } }, 404); }
    if (p === '/v1/chat/completions') {
      const b = await req.json(); if (o.replies?.[0]?.down) { o.replies.shift(); throw new TypeError('fetch failed'); }
      sent.push({ path: p, body: b });
      const m = b.messages as Item[];
      for (const [i, x] of m.entries()) for (const c of x.tool_calls ?? []) if (!m.slice(i + 1).some((y) => y.role === 'tool' && y.tool_call_id === c.id)) return bad(`An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'. Missing: ${c.id}`, 'messages');
      if (b.tools && o.noTools) return bad('This model does not support tools.', 'tools');
      const said = m.map((x) => (x.role === 'user' || x.role === 'tool' ? textOf(x.content) : '')).filter(Boolean).join('\n');
      const r = pick({ system: m.filter((x) => x.role === 'system').map((x) => textOf(x.content)).join('\n'), said, files: m.flatMap((x) => fileIds(x.content)).map((id) => files.get(id)?.text ?? '').join(' '), tools: !!b.tools });
      if (r.status) return json({ error: r.error ?? { message: 'no' } }, r.status);
      const tool_calls = r.call ? [{ id: `call_${++n}`, type: 'function', function: { name: r.call.name, arguments: JSON.stringify(r.call.args) } }] : undefined;
      return json({ id: `c${++n}`, choices: [{ index: 0, message: { role: 'assistant', content: r.call ? null : r.text ?? 'ok', refusal: r.refusal ?? null, ...(tool_calls ? { tool_calls } : {}) }, finish_reason: r.finish ?? (r.call ? 'tool_calls' : 'stop') }], usage: { prompt_tokens: Math.round(JSON.stringify(m).length / 4), completion_tokens: 10 } });
    }
    if (o.noStore && p.startsWith('/v1/files')) return json({ error: { message: 'Not Found' } }, 404);
    if (p === '/v1/files' && req.method === 'POST') { const f = await req.formData(); const file = f.get('file') as File; const id = `file-${++n}`; files.set(id, { name: file.name, type: file.type, purpose: String(f.get('purpose')), text: await file.text() }); return json({ id, object: 'file', filename: file.name, purpose: String(f.get('purpose')) }); }
    if (p === '/v1/files') {
      // like OpenAI, it lists every purpose unless asked for one; a server that ignores `purpose` is what the connector's own filter is for
      const all = [...files.keys()]; const after = u.searchParams.get('after'); const from = after ? all.indexOf(after) + 1 : 0;
      const data = all.slice(from, from + page).map((id) => ({ id, object: 'file', filename: files.get(id)!.name, purpose: files.get(id)!.purpose }));
      return json({ object: 'list', data, has_more: from + page < all.length });
    }
    const del = /^\/v1\/files\/(.+)$/.exec(p);
    if (del && req.method === 'DELETE') return files.delete(decodeURIComponent(del[1])) ? json({ id: del[1], deleted: true }) : json({ error: { message: 'No such file' } }, 404);
    return json({ error: { message: p } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, files, responses, sent, keys, gets };
}
