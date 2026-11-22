/**
 * Intelligence's token on this PC, without Electron: which SSO cookie may be taken as the token, and how the token is kept.
 * The sign-in window that uses these is src/desktop/signin.ts.
 *
 * Decisions ("Intelligence sign-in"): an SSO cookie is taken only if it is from the exact SSO site (control: north.ssoSite),
 * shaped like a JWT and not expired. The token is kept encrypted on the PC (Electron's safeStorage, which uses Windows
 * DPAPI for the signed-in Windows user), never logged and never in the shared folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isJwt, jwtExpiry } from '../backend/signInToken';

/** a cookie as Electron's session.cookies.get gives it */
export interface Cookie { name: string; value: string; domain?: string; expirationDate?: number }

/**
 * The token among these cookies, or null: a cookie set by the SSO site's own host (not a parent domain), whose value is a
 * JWT that has not expired, and whose cookie has not expired either. With several, the one that lasts longest.
 */
export function pickSsoToken(cookies: Cookie[], ssoSite: string, now = Date.now()): string | null {
  const host = new URL(ssoSite).hostname.toLowerCase();
  let best: { value: string; until: number } | null = null;
  for (const c of cookies) {
    const domain = (c.domain ?? '').toLowerCase().replace(/^\./, '');
    if (domain !== host || !isJwt(c.value)) continue;
    if (c.expirationDate !== undefined && c.expirationDate * 1000 <= now) continue;
    const until = jwtExpiry(c.value);
    if (until === null || until <= now) continue;                // a token that never says when it ends is not taken
    if (!best || until > best.until) best = { value: c.value, until };
  }
  return best?.value ?? null;
}

/** single sign-on stops opening by itself once this many of its tokens are refused soon after they were taken */
export const SSO_TRIES = 3;
/** a refusal this soon after the token was taken counts as single sign-on not working; a later one is an ordinary sign-out */
const SOON_MS = 5 * 60_000;

/**
 * Keeps a provider that refuses the SSO cookie from sending the sign-in window into a loop (open, take the cookie, refused,
 * open again). A refused SSO token is never taken again, and after SSO_TRIES quick refusals the window no longer opens by
 * itself: the person signs in with an API key, or presses Single sign-on to try again.
 */
export function ssoTries() {
  const refused = new Set<string>();
  let last = '', at = 0, quick = 0;
  let expiresAt: number | undefined;
  return {
    /** a token taken from the SSO cookie */
    took(token: string, now = Date.now(), expiry?: number) { last = token; at = now; expiresAt = expiry; },
    /** the person pasted a key, or pressed Single sign-on: what follows is not counted against single sign-on */
    reset() { last = ''; quick = 0; },
    /** may this cookie's token be taken? not once it has been refused */
    usable: (token: string) => !refused.has(token),
    /**
     * Nobody is signed in now. An SSO token that has not run out was refused, so it is never taken again. Returns whether the
     * window may open by itself.
     */
    signedOut(now = Date.now()): boolean {
      const exp = last ? expiresAt ?? jwtExpiry(last) : null;
      if (last && (exp === null || exp > now)) { refused.add(last); if (now - at < SOON_MS) quick++; }
      last = '';
      return quick < SSO_TRIES;
    },
    gaveUp: () => quick >= SSO_TRIES,
  };
}

/** what encrypts the token for this Windows user (Electron's safeStorage in the app; a stand-in in tests) */
export interface Crypt { available(): boolean; encrypt(text: string): Buffer; decrypt(bytes: Buffer): string }

/** The token kept in one file on this PC, encrypted. Without encryption it is kept in memory only, never in the clear. */
export function tokenFile(dir: string, crypt: Crypt, name: string) {
  const file = path.join(dir, name);
  return {
    read(): string { try { return crypt.available() && fs.existsSync(file) ? crypt.decrypt(fs.readFileSync(file)) : ''; } catch { return ''; } },
    write(token: string) {
      try {
        if (!token) { fs.rmSync(file, { force: true }); return; }
        if (crypt.available()) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, crypt.encrypt(token)); }
      } catch { /* not kept: the person signs in again at the next start */ }
    },
  };
}
