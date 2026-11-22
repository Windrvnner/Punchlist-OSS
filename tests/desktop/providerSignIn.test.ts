// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { control, type Control } from '../../src/control';
import { providerSignIn } from '../../src/desktop/providerSignIn';

const GATEWAY = {
  ...control.gateway,
  authorize: 'https://identity.example.test/authorize', token: 'https://identity.example.test/token',
  clientId: 'public-client', scope: 'models',
};
const AZURE = { ...control.azure, tenant: 'test-tenant', clientId: 'azure-client' };
const VERTEX = { ...control.vertex, clientId: 'google-client' };

const OAUTH = {
  gateway: [GATEWAY.authorize, GATEWAY.token, GATEWAY.scope, GATEWAY.clientId],
  azure: [
    'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/authorize',
    'https://login.microsoftonline.com/test-tenant/oauth2/v2.0/token',
    'https://cognitiveservices.azure.com/.default', 'azure-client',
  ],
  vertex: [
    'https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token',
    'https://www.googleapis.com/auth/cloud-platform', 'google-client',
  ],
} as const;

describe.each(['gateway', 'azure', 'vertex'] as const)('%s OAuth', (service) => {
  it('exchanges only the state-matched loopback code and records its lifetime', async () => {
    const c: Control = {
      ...control, models: { ...control.models, service }, gateway: GATEWAY, azure: AZURE, vertex: VERTEX,
    };
    const [authorize, token, scope, clientId] = OAUTH[service];
    let challenge: string | null = null;
    const openBrowser = async (address: string) => {
      const url = new URL(address);
      expect(url.origin + url.pathname).toBe(authorize);
      expect(url.searchParams.get('scope')).toBe(scope);
      expect(url.searchParams.get('client_id')).toBe(clientId);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      challenge = url.searchParams.get('code_challenge');
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe(service === 'azure' ? 'localhost' : '127.0.0.1');
      callback.search = 'state=wrong-state&code=unexpected-code';
      expect((await fetch(callback)).status).toBe(400);
      callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'good-code' }).toString();
      expect(await (await fetch(callback)).text()).toContain('Return to Punchlist');
    };
    const exchange = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe(token);
      expect(init?.redirect).toBe('error');
      const fields = new URLSearchParams(init?.body as URLSearchParams);
      expect(fields.get('grant_type')).toBe('authorization_code');
      expect(fields.get('code')).toBe('good-code');
      const actual = createHash('sha256').update(fields.get('code_verifier')!).digest('base64url');
      expect(actual).toBe(challenge);
      const expiresIn = service === 'azure' ? '3600' : 3600;
      return Response.json({ access_token: 'short-lived-token', token_type: 'Bearer', expires_in: expiresIn });
    });
    const start = Date.now();
    const signIn = providerSignIn(c)!;
    const result = await signIn({ openBrowser, fetch: exchange, signal: AbortSignal.timeout(4000) });
    expect(exchange).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ token: 'short-lived-token', kind: 'sso' });
    expect(result.expiresAt).toBeGreaterThanOrEqual(start + 3_600_000);
  });
});

it.each([
  { name: 'zero', expiresIn: '0' },
  { name: 'hexadecimal', expiresIn: '0x10' },
  { name: 'scientific notation', expiresIn: '1e8' },
  { name: 'blank', expiresIn: ' ' },
  { name: 'overflowing', expiresIn: '9'.repeat(310) },
])('rejects a $name OAuth lifetime string', async ({ expiresIn }) => {
  const c: Control = { ...control, models: { ...control.models, service: 'azure' }, azure: AZURE };
  const openBrowser = async (address: string) => {
    const url = new URL(address);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'good-code' }).toString();
    await fetch(callback);
  };
  const exchange = async () => Response.json({
    access_token: 'test-token', token_type: 'Bearer', expires_in: expiresIn,
  });
  const signIn = providerSignIn(c)!;
  await expect(signIn({ openBrowser, fetch: exchange, signal: AbortSignal.timeout(4000) }))
    .rejects.toThrow('The identity provider did not return a usable access token.');
});

it('exchanges AWS device approval for the configured account and role', async () => {
  const service = 'bedrock';
  const c: Control = {
    ...control, models: { ...control.models, service },
    bedrock: {
      ...control.bedrock, ssoRegion: 'us-east-1', startUrl: 'https://example.awsapps.com/start',
      account: '000000000001', role: 'ModelUser',
    },
  };
  const expiry = Date.now() + 900_000;
  const role = { accessKeyId: 'role-id', secretAccessKey: 'role-secret', sessionToken: 'role-session' };
  const verify = 'https://device.sso.us-east-1.amazonaws.com/?user_code=example';
  const openBrowser = vi.fn(async (_url: string) => {});
  let polls = 0;
  const standIn: typeof fetch = async (address, init) => {
    const url = new URL(String(address));
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (url.pathname === '/client/register') {
      expect(url.host).toBe('oidc.us-east-1.amazonaws.com');
      expect(body.scopes).toEqual(['sso:account:access']);
      return Response.json({ clientId: 'device-client', clientSecret: 'device-client-secret' });
    }
    if (url.pathname === '/device_authorization') {
      expect(body.startUrl).toBe(c.bedrock.startUrl);
      return Response.json({
        deviceCode: 'device-code', verificationUriComplete: verify, expiresIn: 60, interval: 0.01,
      });
    }
    if (url.pathname === '/token') {
      expect(openBrowser).toHaveBeenCalledWith(verify);
      expect(body.deviceCode).toBe('device-code');
      if (++polls === 1) return Response.json({ error: 'authorization_pending' }, { status: 400 });
      return Response.json({ accessToken: 'portal-token' });
    }
    expect(url.origin + url.pathname).toBe('https://portal.sso.us-east-1.amazonaws.com/federation/credentials');
    expect(url.searchParams.get('account_id')).toBe(c.bedrock.account);
    expect(url.searchParams.get('role_name')).toBe(c.bedrock.role);
    expect(new Headers(init?.headers).get('x-amz-sso_bearer_token')).toBe('portal-token');
    return Response.json({ roleCredentials: { ...role, expiration: expiry } });
  };
  const result = await providerSignIn(c)!({ fetch: standIn, openBrowser, signal: AbortSignal.timeout(4000) });
  expect(result).toEqual({ token: JSON.stringify(role), kind: 'sso', expiresAt: expiry });
});
