/** Native OAuth uses the system browser and a one-use loopback callback (RFC 8252). */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Credential } from '../backend/signInToken';

export interface BrowserSignIn {
  openBrowser: (url: string) => Promise<void>;
  signal: AbortSignal;
  fetch?: typeof fetch;
}

export interface OAuthOptions {
  authorize: string;
  token: string;
  clientId: string;
  scope: string;
  prompt?: string;
  redirectHost?: 'localhost';
}

const HOST = '127.0.0.1';
const nonce = () => randomBytes(32).toString('base64url');

export async function oauthSignIn(o: OAuthOptions, io: BrowserSignIn): Promise<Credential> {
  const verifier = nonce();
  const state = nonce();
  const { code, redirectUri } = await authorize(o, io, verifier, state);
  const form = new URLSearchParams({
    grant_type: 'authorization_code', client_id: o.clientId, code, code_verifier: verifier, redirect_uri: redirectUri,
  });
  const reply = await (io.fetch ?? fetch)(o.token, {
    method: 'POST', body: form, redirect: 'error', signal: io.signal,
  });
  if (!reply.ok) throw new Error('The identity provider refused the authorization code.');
  const result = await reply.json() as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
  const { access_token: token, token_type: tokenType, expires_in: lifetime } = result;
  // Microsoft Entra can return the lifetime in seconds as a JSON string.
  const seconds = typeof lifetime === 'string' && /^\d+$/.test(lifetime) ? Number(lifetime) : lifetime;
  const expiresAt = typeof seconds === 'number' && seconds >= 1 ? Date.now() + seconds * 1000 : NaN;
  if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)
    || typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer'
    || !Number.isFinite(expiresAt) || expiresAt > Number.MAX_SAFE_INTEGER) {
    throw new Error('The identity provider did not return a usable access token.');
  }
  return { token, kind: 'sso', expiresAt };
}

async function authorize(o: OAuthOptions, io: BrowserSignIn, verifier: string, state: string) {
  io.signal.throwIfAborted();
  let redirectUri = '';
  let deliver!: (code: string) => void;
  let failed!: (reason: unknown) => void;
  const result = new Promise<string>((resolve, reject) => { deliver = resolve; failed = reject; });
  const server = createServer((req, res) => {
    if (!redirectUri || req.method !== 'GET' || req.headers.host !== new URL(redirectUri).host
      || !req.url?.startsWith('/')) { res.writeHead(404).end(); return; }
    const url = new URL(`${redirectUri}${req.url}`);
    if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
      res.writeHead(400).end('This is not the sign-in requested by Punchlist.');
      return;
    }
    const code = url.searchParams.get('code');
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', connection: 'close',
    });
    res.end(code ? 'Return to Punchlist to finish signing in.' : 'Sign-in was declined. Return to Punchlist to retry.');
    if (code) deliver(code);
    else failed(new Error('Sign-in was declined.'));
  });
  const cancel = () => failed(new Error('Sign-in was closed or timed out.'));
  io.signal.addEventListener('abort', cancel, { once: true });
  // The callback or cancellation can arrive while the OS is still opening the browser.
  void result.catch(() => {});
  try {
    server.listen(0, HOST);
    await once(server, 'listening', { signal: io.signal });
    redirectUri = `http://${o.redirectHost ?? HOST}:${(server.address() as AddressInfo).port}`;
    const url = new URL(o.authorize);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const parameters = {
      client_id: o.clientId, redirect_uri: redirectUri, scope: o.scope, response_type: 'code',
      state, code_challenge: challenge, code_challenge_method: 'S256', ...(o.prompt ? { prompt: o.prompt } : {}),
    };
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    void io.openBrowser(url.href).catch(failed);
    return { code: await result, redirectUri };
  } finally {
    io.signal.removeEventListener('abort', cancel);
    server.close();
    if (io.signal.aborted) server.closeAllConnections();
  }
}
