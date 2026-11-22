/** IAM Identity Center device authorization followed by an exchange for temporary AWS role credentials. */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Credential } from '../backend/signInToken';
import type { BrowserSignIn } from './oauth';

interface BedrockSignInOptions {
  ssoRegion: string;
  startUrl: string;
  account: string;
  role: string;
}

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
type Registration = { clientId: string; clientSecret: string };
type Device = { deviceCode: string; verificationUriComplete: string; expiresIn: number; interval: number };

export async function bedrockSignIn(o: BedrockSignInOptions, io: BrowserSignIn): Promise<Credential> {
  const suffix = o.ssoRegion.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com';
  const oidc = `https://oidc.${o.ssoRegion}.${suffix}`;
  const go = io.fetch ?? fetch;
  const post = (path: string, payload: object) => go(oidc + path, {
    method: 'POST', body: JSON.stringify(payload), headers: { 'content-type': 'application/json' },
    signal: io.signal, redirect: 'error',
  });
  const registration = await post('/client/register', {
    clientName: 'Punchlist', clientType: 'public', scopes: ['sso:account:access'],
  });
  const { clientId, clientSecret } = await accepted<Registration>(registration);
  const client = { clientId, clientSecret };
  const device = await accepted<Device>(await post('/device_authorization', { ...client, startUrl: o.startUrl }));
  const verification = new URL(device.verificationUriComplete);
  if (verification.protocol !== 'https:') throw new Error('IAM Identity Center returned an invalid verification URL.');
  const until = Date.now() + device.expiresIn * 1000;
  await io.openBrowser(verification.href);
  const poll = () => post('/token', { ...client, deviceCode: device.deviceCode, grantType: DEVICE_GRANT });
  const accessToken = await waitForApproval(poll, device.interval, until, io.signal);
  const roles = new URL(`https://portal.sso.${o.ssoRegion}.${suffix}/federation/credentials`);
  roles.search = new URLSearchParams({ account_id: o.account, role_name: o.role }).toString();
  const role = await accepted<{ roleCredentials?: {
    accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: number;
  } }>(await go(roles, {
    headers: { 'x-amz-sso_bearer_token': accessToken }, signal: io.signal, redirect: 'error',
  }));
  const credentials = role.roleCredentials;
  if (!credentials?.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken
    || !Number.isFinite(credentials.expiration) || credentials.expiration <= Date.now()) {
    throw new Error('IAM Identity Center did not return usable role credentials.');
  }
  return {
    token: JSON.stringify({
      accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    }),
    kind: 'sso', expiresAt: credentials.expiration,
  };
}

async function accepted<T>(reply: Response): Promise<T> {
  if (!reply.ok) throw new Error('IAM Identity Center refused sign-in.');
  return await reply.json() as T;
}

async function waitForApproval(poll: () => Promise<Response>, seconds: number, until: number, signal: AbortSignal) {
  let interval = (seconds > 0 ? seconds : 5) * 1000;
  while (until - Date.now() > interval) {
    await sleep(interval, undefined, { signal });
    const reply = await poll();
    const body = await reply.json() as { accessToken?: string; error?: string };
    if (reply.ok && body.accessToken) return body.accessToken;
    if (body.error === 'slow_down') interval += 5000;
    else if (body.error !== 'authorization_pending') throw new Error('IAM Identity Center did not approve sign-in.');
  }
  throw new Error('IAM Identity Center sign-in timed out.');
}
