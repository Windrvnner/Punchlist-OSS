/**
 * Intelligence's sign-in token, as a connector sees it (src/backend/north.ts, src/backend/claude.ts): one place that
 * holds the current token or API key, hands it to each call, and makes calls wait while nobody is signed in.
 *
 * A person signs in two ways (decisions: "Intelligence sign-in"), each switched on or off in the control file (signIn):
 * by pasting an API key, or by single sign-on, where the desktop shell takes the token from the SSO site's cookie
 * (src/desktop/signin.ts), or gets a short-lived credential through the provider’s browser flow. Either way the shell
 * calls `set`. A refused or expired token is dropped and `needed` is called so the shell can ask for a sign-in
 * (the SSO window
 * opens by itself); calls wait for the next token and carry on.
 *
 * A call waits until someone signs in, however long that takes, or until the app is closed: what a
 * person asked for carries on after sign-in instead of failing. `waitMs`, where given, caps the wait, after which the call
 * fails as "unreachable" (the stand-in services in tests use it). A shared check's work runs under `withSignInCap`: a
 * PC signed out mid-check fails its batch after the cap and lets go of its pieces, so the other PCs finish the check.
 * The token is never logged and never put in an error message.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { SERVICE } from '../control';

/** true for a token shaped like a JWT: three base64url parts, the first two JSON (a header with `alg`, and a payload) */
export function isJwt(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return false;
  try { const head = JSON.parse(b64url(parts[0])); JSON.parse(b64url(parts[1])); return typeof head?.alg === 'string'; } catch { return false; }
}

/** a JWT's expiry in milliseconds since 1970, or null when it has none or is not a JWT */
export function jwtExpiry(token: string): number | null {
  if (!isJwt(token)) return null;
  try { const exp = JSON.parse(b64url(token.split('.')[1])).exp; return typeof exp === 'number' ? exp * 1000 : null; } catch { return null; }
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** the failure a call gets when it has waited for sign-in long enough; the backend retries it like an unreachable service */
export const signedOut = () => Object.assign(new Error(`Waiting for someone to sign in to ${SERVICE}.`), { code: 'unreachable', signedOut: true });

const capped = new AsyncLocalStorage<number>();

/**
 * Runs `fn` with every sign-in wait inside it capped at `ms`. A check round's share runs under it: a call that waits on
 * sign-in with no end would hold the round's claimed pieces while the PC stays live, so no other PC could take them.
 * With the cap, the batch fails as unreachable, its claim is released and the check is tried again after sign-in.
 */
export const withSignInCap = <T,>(ms: number, fn: () => Promise<T>): Promise<T> => capped.run(ms, fn);

export interface Credential {
  readonly token: string;
  readonly kind: 'sso' | 'apiKey';
  readonly expiresAt?: number;
}

export interface SignInToken {
  /** Cloud transports distinguish a pasted key from a sign-in credential. */
  credential?(waitMs?: number): Promise<Credential>;
  /** the token to send, waiting while nobody is signed in: until a sign-in, or up to `waitMs` (the holder's own cap unless given) where there is one */
  get(waitMs?: number): Promise<string>;
  /** the provider refused this token: drop it (unless a newer one has been set meanwhile) and ask for a sign-in */
  refused(token: string): void;
}

export async function credentialFrom(source: string | SignInToken): Promise<Credential> {
  if (typeof source === 'string') return { token: source, kind: 'apiKey' };
  return source.credential ? source.credential() : { token: await source.get(), kind: 'apiKey' };
}

export interface TokenHolder extends SignInToken {
  credential(waitMs?: number): Promise<Credential>;
  /** a new token from a sign-in; calls waiting for one carry on */
  set(token: string, details?: Omit<Credential, 'token'>): void;
  /** sign out: drop the token (calls wait again) */
  clear(): void;
  /** whether a token is held that has not expired */
  signedIn(): boolean;
  /** the sign-in gave up (single sign-on refused every token) with nothing else coming: waiting calls fail as unreachable, and so do new ones until `set` or `tryAgain` */
  giveUp(): void;
  /** a person asked to sign in again: calls wait once more */
  tryAgain(): void;
  /** whether a call is waiting for someone to sign in right now */
  waiting(): boolean;
}

interface TokenHolderOptions {
  waitMs?: number;
  now?: () => number;
  needed?: () => void;
  token?: string;
  details?: Omit<Credential, 'token'>;
}

export function tokenHolder(o: TokenHolderOptions): TokenHolder {
  const now = o.now ?? Date.now;
  let held: Credential = { kind: 'apiKey', ...o.details, token: o.token?.trim() || '' };
  let waiting: { go: () => void; no: () => void }[] = [];
  let stopped = false;                                           // single sign-on gave up and no key was given: nothing will come by itself
  let asked = false;                                             // `needed` is called once per sign-out, not once per call
  const usable = () => {
    if (!held.token) return false;
    const expires = held.expiresAt ?? jwtExpiry(held.token);
    return expires === null || expires > now();
  };
  const ask = () => { if (!asked) { asked = true; o.needed?.(); } };
  const drop = () => { held = { token: '', kind: 'apiKey' }; ask(); };
  return {
    async get(waitMs) { return (await this.credential(waitMs)).token; },
    async credential(waitMs = o.waitMs ?? capped.getStore()) {
      if (usable()) return held;
      if (held.token) drop();                                         // a JWT whose time has run out is not sent at all
      ask();
      if (stopped) throw signedOut();
      await new Promise<void>((resolve, reject) => {
        const w = { go: () => { clearTimeout(timer); resolve(); }, no: () => { clearTimeout(timer); reject(signedOut()); } };
        // no cap: the call waits for the sign-in (a timer of Infinity would fire at once, so none is set)
        const timer = waitMs != null && Number.isFinite(waitMs) ? setTimeout(() => { waiting = waiting.filter((x) => x !== w); w.no(); }, waitMs) : undefined;
        waiting.push(w);
      });
      return this.credential(waitMs);
    },
    refused(t) { if (t === held.token) drop(); },
    set(token, details) {
      held = { kind: 'apiKey', ...details, token: token.trim() };
      if (!held.token) return;
      asked = false;
      stopped = false;
      const ready = waiting;
      waiting = [];
      for (const waiter of ready) waiter.go();
    },
    clear() { held = { token: '', kind: 'apiKey' }; asked = false; },
    giveUp() { stopped = true; const w = waiting; waiting = []; for (const x of w) x.no(); },
    tryAgain() { stopped = false; asked = false; },
    signedIn: usable,
    waiting: () => waiting.length > 0,
  };
}
