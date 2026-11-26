// @vitest-environment node
// The cloud Claude connector's busy-service retries: one try and two retries, like every other connector (#1110).
import { describe, it, expect } from 'vitest';
import { cloudClaudeService } from '../../src/backend/cloudClaude';
import { tokenHolder } from '../../src/backend/signInToken';

const MODELS = { fast: 'fast-model', standard: 'standard-model', thorough: 'thorough-model' };

describe('the cloud Claude connector when the service stays busy', () => {
  it.each([{ provider: 'bedrock', region: 'us-east-1' } as const, { provider: 'vertex' } as const])(
    'makes 3 requests ($provider), then reports the service unreachable', async (route) => {
      let requests = 0;
      const busy = (async () => {
        requests++;
        return new Response(null, { status: 429, headers: { 'retry-after': '0' } });
      }) as typeof fetch;
      const service = cloudClaudeService({
        route, address: 'https://cloud.example/models', key: tokenHolder({ waitMs: 100, token: 'a-key' }),
        models: MODELS, fetch: busy, retryMs: 1,
      });
      await expect(service.complete({ model: 'fast', prompt: 'q' })).rejects.toMatchObject({ code: 'unreachable' });
      expect(requests).toBe(3);
    });
});
