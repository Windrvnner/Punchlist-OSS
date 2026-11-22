import { describe, expect, it, vi } from 'vitest';
import { control, type CloudProvider, type Control } from '../../src/control';
import { tokenHolder } from '../../src/backend/signInToken';
import { modelService } from '../../src/desktop/model';

const ROUTES: Record<CloudProvider, { root: string; call: string; probe: string }> = {
  gateway: { root: '/v1', call: '/chat/completions', probe: '/models' },
  azure: { root: '/openai/v1', call: '/responses', probe: '/models' },
  bedrock: { root: '', call: '/model/small/invoke', probe: '/model/medium/count-tokens' },
  vertex: {
    root: '/v1/projects/test/locations/global/publishers/anthropic/models',
    call: '/small:rawPredict', probe: '/count-tokens:rawPredict',
  },
};
const REGION = 'us-east-1';
const PDF = Buffer.from('%PDF-1.7\nstand-in document');
const ROLE = JSON.stringify({ accessKeyId: 'test-user', secretAccessKey: 'test-secret', sessionToken: 'test-session' });

function modelReply(provider: CloudProvider) {
  if (provider === 'gateway') return { choices: [{ message: { content: 'Accepted' } }] };
  if (provider === 'azure') {
    return { id: 'reply', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Accepted' }] }] };
  }
  return { content: [{ type: 'text', text: 'Accepted' }], usage: { input_tokens: 11, output_tokens: 2 } };
}

function standIn(provider: CloudProvider) {
  const route = ROUTES[provider];
  const seen: { path: string; headers: Headers; body: string }[] = [];
  let reject = false;
  const address = `https://models.example.test${route.root}`;
  const models = { address, fast: 'small', standard: 'medium', thorough: 'large' };
  const config: Control = {
    ...control, models: { ...control.models, service: provider },
    [provider]: { ...control[provider], ...models, region: REGION },
  };
  const fetch: typeof globalThis.fetch = async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/models\.example\.test/);
    const path = new URL(String(url)).pathname;
    seen.push({ path, headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    if (reject) {
      reject = false;
      if (provider === 'bedrock') {
        return Response.json({}, { status: 400, headers: { 'x-amzn-errortype': 'ExpiredTokenException' } });
      }
      return Response.json({}, { status: 401 });
    }
    if (path === route.root + route.probe) return Response.json({ input_tokens: 1 });
    expect(path).toBe(route.root + route.call);
    return Response.json(modelReply(provider));
  };
  return { config, fetch, seen, rejectNext: () => { reject = true; } };
}

function expectHeaders(provider: CloudProvider, headers: Headers, sso: boolean, token: string) {
  if (provider === 'azure' && !sso) {
    expect(headers.get('api-key')).toBe(token);
    expect(headers.has('authorization')).toBe(false);
  } else if (provider === 'vertex' && !sso) {
    expect(headers.get('x-goog-api-key')).toBe(token);
    expect(headers.has('authorization')).toBe(false);
  } else if (provider === 'bedrock' && sso) {
    expect(headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=test-user\/\d+\/us-east-1\/bedrock/);
    expect(headers.get('x-amz-security-token')).toBe('test-session');
    expect(headers.get('authorization')).not.toContain('test-secret');
  } else {
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
  }
}

describe.each(['gateway', 'azure', 'bedrock', 'vertex'] as const)('%s sign-in', (provider) => {
  it('checks a pasted key and uses that route’s documented header', async () => {
    const fake = standIn(provider);
    const token = tokenHolder({ token: 'pasted-key' });
    const { service } = modelService({ config: fake.config, fetch: fake.fetch, token });
    await service.checkSignIn?.();
    expectHeaders(provider, fake.seen[0].headers, false, 'pasted-key');
    const body = fake.seen[0].body;
    if (provider === 'vertex') expect(JSON.parse(body)).toEqual({
      model: 'medium', messages: [{ role: 'user', content: 'Hello' }],
    });
    if (provider === 'bedrock') {
      const encoded = JSON.parse(body).input.invokeModel.body;
      expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toMatchObject({
        anthropic_version: 'bedrock-2023-05-31', max_tokens: 1,
      });
    }
  });

  it('keeps the same prompt and full PDF when sign-in is required again', async () => {
    const fake = standIn(provider);
    const needed = vi.fn();
    const accessToken = provider === 'bedrock' ? ROLE : 'access-token';
    const token = tokenHolder({ token: accessToken, details: { kind: 'sso' }, needed, waitMs: 3000 });
    const { service } = modelService({ config: fake.config, fetch: fake.fetch, token });
    const files = provider === 'gateway' ? [] : [await service.upload({ name: 'Original.pdf', bytes: PDF })];
    fake.rejectNext();
    const pending = service.complete({ model: 'fast', prompt: 'Keep this prompt', files });
    await vi.waitFor(() => expect(needed).toHaveBeenCalledTimes(1));
    expect(token.waiting()).toBe(true);
    expectHeaders(provider, fake.seen[0].headers, true, accessToken);
    token.set('replacement-key');
    await expect(pending).resolves.toBe('Accepted');
    expectHeaders(provider, fake.seen[1].headers, false, 'replacement-key');
    expect(fake.seen[1].body).toBe(fake.seen[0].body);
    expect(fake.seen[0].body).toContain('Keep this prompt');
    if (files.length) expect(fake.seen[0].body).toContain(PDF.toString('base64'));
  });

  it('does not send an expired opaque credential', async () => {
    const fake = standIn(provider);
    let now = 100;
    const needed = vi.fn();
    const token = tokenHolder({ now: () => now, waitMs: 3000, needed });
    token.set('expired-token', { kind: 'sso', expiresAt: 200 });
    const { service } = modelService({ config: fake.config, fetch: fake.fetch, token });
    now = 200;
    const result = service.complete({ model: 'fast', prompt: 'Hold this' });
    expect(needed).toHaveBeenCalledOnce();
    expect(fake.seen).toHaveLength(0);
    token.set('replacement-key');
    await expect(result).resolves.toBe('Accepted');
  });
});

it.each(['bedrock', 'vertex'] as const)('does not replay a dropped inference POST on %s', async (provider) => {
  const fake = standIn(provider);
  const token = tokenHolder({ token: 'pasted-key' });
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_SOCKET' } });
  });
  const { service } = modelService({ config: fake.config, fetch, token });
  await expect(service.complete({ model: 'fast', prompt: 'Keep this prompt' })).rejects.toMatchObject({
    code: 'unreachable',
  });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each(['bedrock', 'vertex'] as const)('retries %s inference after a failed connection', async (provider) => {
  const fake = standIn(provider);
  const token = tokenHolder({ token: 'pasted-key' });
  const fetch = vi.fn<typeof globalThis.fetch>(fake.fetch).mockRejectedValueOnce(
    new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
  );
  const { service } = modelService({ config: fake.config, fetch, token });
  await expect(service.complete({ model: 'fast', prompt: 'Same prompt' })).resolves.toBe('Accepted');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fake.seen).toHaveLength(1);
});
