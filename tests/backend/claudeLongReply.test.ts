// @vitest-environment node
// The Claude connector does not stream. Without a timeout of its own, the SDK refuses a non-streaming call whose
// max_tokens could take longer than ten minutes (above about 21,333); with the control file's timings.modelCall as the
// client's timeout it sends any limits.outputTokens.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/control', async (orig) => {
  const m = await orig<typeof import('../../src/control')>();
  return { ...m, control: { ...m.control, limits: { ...m.control.limits, outputTokens: 64_000 } } };
});
const { claudeService } = await import('../../src/backend/claude');

describe('a long output limit on the Claude connector', () => {
  it('sends 64,000 as max_tokens rather than being refused for not streaming', async () => {
    const sent: { max_tokens?: number }[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push(await new Request(url, init).json());
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'x', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;
    const s = claudeService({ key: 'test', fetch, maxRetries: 0 });
    await expect(s.complete({ model: 'fast', prompt: 'q' })).resolves.toBe('ok');
    expect(sent.map((b) => b.max_tokens)).toEqual([64_000]);
  });
});
