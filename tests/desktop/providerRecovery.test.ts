// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shell } from 'electron';
import { expect, it, vi } from 'vitest';
import { withSignInCap } from '../../src/backend/signInToken';
import { control, type CloudProvider } from '../../src/control';
import { modelService } from '../../src/desktop/model';
import { providerSignIn } from '../../src/desktop/providerSignIn';
import { aiSignIn } from '../../src/desktop/signin';

vi.mock('electron', () => ({
  shell: { openExternal: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}));

const PDF = Buffer.from('%PDF-1.7\nsource for this answer');
const MODEL = 'https://model.example.test';
const IDENTITY = 'https://sign-in.example.test';
const MODEL_TIERS = { fast: 'fast-model', standard: 'standard-model', thorough: 'thorough-model' };
const INTERACTION_MS = 2000;

function deployment(provider: CloudProvider) {
  return {
    ...control,
    models: { ...control.models, service: provider },
    signIn: { sso: true, apiKey: false },
    gateway: {
      ...control.gateway, ...MODEL_TIERS, address: `${MODEL}/v1`,
      authorize: `${IDENTITY}/authorize`, token: `${IDENTITY}/token`, clientId: 'desktop-app', scope: 'inference',
    },
    azure: {
      ...control.azure, ...MODEL_TIERS, address: `${MODEL}/openai/v1`, tenant: 'tenant', clientId: 'desktop-app',
    },
    bedrock: {
      ...control.bedrock, ...MODEL_TIERS, address: MODEL, region: 'us-east-1', ssoRegion: 'us-east-1',
      startUrl: 'https://example.awsapps.com/start', account: '000000000001', role: 'ModelUser',
    },
    vertex: {
      ...control.vertex, ...MODEL_TIERS, clientId: 'desktop-app',
      address: `${MODEL}/v1/projects/project/locations/global/publishers/anthropic/models`,
    },
  };
}

function identityStandIn(provider: CloudProvider) {
  let issued = 0;
  const identity: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    switch (url.pathname) {
      case '/client/register':
        return Response.json({ clientId: 'desktop-app', clientSecret: 'device-secret' });
      case '/device_authorization':
        return Response.json({
          deviceCode: 'device-code', verificationUriComplete: IDENTITY, expiresIn: 60, interval: 0.01,
        });
      case '/federation/credentials':
        return Response.json({
          roleCredentials: {
            accessKeyId: `credential-${++issued}`, secretAccessKey: 'temporary-secret',
            sessionToken: 'role-session', expiration: Date.now() + 60_000,
          },
        });
      default:
        if (provider === 'bedrock') return Response.json({ accessToken: 'portal-session' });
        expect(new URLSearchParams(String(init?.body)).get('code')).toBe('allowed');
        return Response.json({ access_token: `credential-${++issued}`, expires_in: 60, token_type: 'Bearer' });
    }
  };
  return identity;
}

async function approveInBrowser(authorization: string) {
  const url = new URL(authorization);
  const redirect = url.searchParams.get('redirect_uri');
  if (!redirect) return; // IAM Identity Center reports browser approval at its token endpoint.
  const callback = new URL(redirect);
  expect(['127.0.0.1', 'localhost']).toContain(callback.hostname);
  callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'allowed' }).toString();
  expect((await fetch(callback)).status).toBe(200);
}

function modelReply(provider: CloudProvider) {
  if (provider === 'gateway') return { choices: [{ message: { content: 'Answer' } }] };
  if (provider === 'azure') {
    return { id: 'answer', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }] };
  }
  return { content: [{ type: 'text', text: 'Answer' }], usage: { input_tokens: 10, output_tokens: 1 } };
}

function modelStandIn(provider: CloudProvider) {
  const inferences: { credential: string; body: string }[] = [];
  const model: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    expect(url.origin).toBe(MODEL);
    if (provider === 'gateway' && url.pathname === '/v1/files') {
      const form = init?.body;
      if (!(form instanceof FormData)) throw new Error('The gateway upload expected form data.');
      const file = form.get('file');
      if (!(file instanceof File)) throw new Error('The gateway upload expected a file.');
      expect(Buffer.from(await file.arrayBuffer())).toEqual(PDF);
      return Response.json({ id: 'file-pdf' });
    }
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const credential = provider === 'bedrock'
      ? /Credential=([^/]+)\//.exec(authorization)?.[1] ?? ''
      : authorization.replace(/^Bearer /, '');
    inferences.push({ credential, body: String(init?.body) });
    return inferences.length === 1 ? Response.json({}, { status: 401 }) : Response.json(modelReply(provider));
  };
  return { model, inferences };
}

it.each(['gateway', 'azure', 'bedrock', 'vertex'] as const)(
  '%s SSO-only sign-in resumes the same work after refusal and reauthenticates an expired credential',
  async (provider) => {
    const config = deployment(provider);
    const exchange = providerSignIn(config)!;
    const identity = identityStandIn(provider);
    const { model, inferences } = modelStandIn(provider);
    const browser = vi.mocked(shell.openExternal);
    browser.mockReset();
    browser.mockImplementation(approveInBrowser);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-provider-recovery-'));
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const signIn = aiSignIn({
      provider, address: '', ssoSite: '', ...config.signIn,
      browserSignIn: (io) => exchange({ ...io, fetch: identity }), parent: () => null, dir,
    });
    const service = modelService({ config, fetch: model, token: signIn.holder }).service;
    try {
      expect(await signIn.service.status()).toMatchObject({ value: { sso: true, apiKey: false, signedIn: false } });
      expect(await signIn.service.signIn()).toMatchObject({ ok: true });
      expect(await signIn.holder.credential(INTERACTION_MS)).toMatchObject({ kind: 'sso' });
      const file = await service.upload({ name: 'Original.pdf', bytes: PDF });
      const complete = (prompt: string) => withSignInCap(INTERACTION_MS, () =>
        service.complete({ model: 'fast', prompt, files: [file] }));

      await expect(complete('Keep this prompt')).resolves.toBe('Answer');
      expect(browser).toHaveBeenCalledTimes(2);
      expect(inferences.map((call) => call.credential)).toEqual(['credential-1', 'credential-2']);
      expect(inferences[1].body).toBe(inferences[0].body);
      expect(inferences[0].body).toContain('Keep this prompt');
      expect(inferences[0].body).toContain(provider === 'gateway' ? 'file-pdf' : PDF.toString('base64'));

      now = (await signIn.holder.credential(INTERACTION_MS)).expiresAt!;
      await expect(complete('Follow-up prompt')).resolves.toBe('Answer');
      expect(browser).toHaveBeenCalledTimes(3);
      expect(inferences.map((call) => call.credential)).toEqual(['credential-1', 'credential-2', 'credential-3']);
      expect(inferences[2].body).toContain('Follow-up prompt');
    } finally {
      signIn.close();
      clock.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
