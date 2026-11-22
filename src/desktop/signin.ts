/**
 * Signing in to Intelligence in the desktop app (decisions: "Intelligence sign-in"). Which provider, and which ways of
 * signing in are offered, come from the control file: models.service, signIn.sso and signIn.apiKey. On screen it is
 * only ever "Intelligence sign-in", never the vendor's name.
 *
 * Single sign-on on North (with north.ssoSite set): the North instance opens in the app's own sign-in window,
 * on a session of its own, and the person signs in there as they would in a browser. Every second the window's cookies
 * are looked at; the first one from the exact SSO site that is a JWT and not expired (pickSsoToken in ./token.ts)
 * becomes the bearer token, and the window closes. The window opens at launch when no token is held, whenever the
 * provider refuses the token or it runs out (every 8 hours), and when the person asks (Settings). A refused SSO token is
 * never taken again and its cookie is removed, so the SSO page asks for a fresh sign-in; after three quick refusals the
 * window stops opening by itself and Settings says single sign-on did not work (ssoTries in ./token.ts).
 *
 * The API key or developer token is pasted in Settings and checked by the selected provider. The opt-in live tests
 * can supply a key through PUNCHLIST_AI_KEY (envKey in ./model.ts).
 *
 * Calls to the model wait while nobody is signed in and carry on after (src/backend/signInToken.ts). The token is kept
 * encrypted on this PC (./token.ts), one file per provider, never logged and never in the shared folder.
 */
import { type BrowserWindow, safeStorage } from 'electron';
import { ok, fail } from '../domain/result';
import { tokenHolder, jwtExpiry, type Credential, type SignInToken } from '../backend/signInToken';
import type { AiSignIn } from '../ports';
import { SERVICE, type ModelProvider } from '../control';
import type { BrowserSignIn } from './oauth';
import { ssoTries, tokenFile } from './token';
import { browserSignInPrompt, northSignInPrompt } from './signInWindows';

const CREDENTIAL_FILE_PREFIX = 'punchlist-credential-v1\n';

export interface SignInOptions {
  provider: ModelProvider;
  /** Browser-mediated OAuth or IAM Identity Center sign-in, and the deployment it belongs to. */
  browserSignIn?: (io: BrowserSignIn) => Promise<Credential>;
  binding?: string;
  /** North's address and SSO site (control: north.address, north.ssoSite) */
  address: string; ssoSite: string;
  /** which ways of signing in are offered (control: signIn.sso, signIn.apiKey) */
  sso: boolean; apiKey: boolean;
  /** this PC's own folder, where the token is kept */
  dir: string;
  /** a key to use when none has been entered on this PC (the environment's, for testing on Claude) */
  fallback?: string;
  parent: () => BrowserWindow | null;
  /** the model service on a token of its own, to check a pasted key before it is taken (ModelService.checkSignIn) */
  probe?: (token: SignInToken) => { checkSignIn?(): Promise<void> };
}

/**
 * Whether the service takes this key: one call on a token holder of its own, so the key in use is never touched. A
 * refused key ends the call at once (the probe's `get` throws after `refused`) instead of waiting for a sign-in.
 */
export async function checkKey(key: string, probe: SignInOptions['probe'], waitMs = 20_000): Promise<'ok' | 'refused' | 'unreachable' | 'unchecked'> {
  if (!probe) return 'ok';
  let refused = false;
  const token: SignInToken = { async get() { if (refused) throw Object.assign(new Error('refused'), { refusedKey: true }); return key; }, refused() { refused = true; } };
  const svc = probe(token);
  if (!svc.checkSignIn) return 'ok';
  // a check that takes longer than this is as good as no answer: the person is told, with Retry, rather than kept waiting
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => { timer = setTimeout(() => no(Object.assign(new Error('no answer'), { code: 'unreachable' })), waitMs); });
  try { await Promise.race([svc.checkSignIn(), late]); return 'ok'; }
  catch (e) {
    if (refused || (e as { refusedKey?: boolean }).refusedKey) return 'refused';
    // any other answer (a server error, a page that is not the service's) did not confirm the key: it is not taken
    return (e as { code?: string }).code === 'unreachable' ? 'unreachable' : 'unchecked';
  } finally { clearTimeout(timer); }
}

export function aiSignIn(o: SignInOptions) {
  const kept = keptSignIn(o);
  const sso = o.sso && (!!o.browserSignIn || (o.provider === 'north' && !!o.ssoSite && !!o.address));
  let current = kept.saved.credential ?? (o.fallback ? { token: o.fallback, kind: 'apiKey' as const } : undefined);
  let ever = !!current || kept.saved.completed;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const tries = ssoTries();
  const north = northSignInPrompt(o, tries.usable, (token) => {
    tries.took(token);
    use({ token, kind: 'sso' });
  });
  const browser = browserSignInPrompt(o.browserSignIn, (credential) => {
    if (!tries.usable(credential.token)) return false;
    tries.took(credential.token, Date.now(), credential.expiresAt);
    use(credential);
    return true;
  });
  const open = () => { if (sso) (o.browserSignIn ? browser : north).open(); };
  const holder = tokenHolder({ token: current?.token, details: current, needed: () => {
    current = undefined;
    if (ever) kept.clear();
    if (firstSetup()) return;
    if (tries.signedOut()) open();
    else { north.close(); holder.giveUp(); }
  } });
  const firstSetup = () => !ever && !holder.signedIn();

  function use(credential: Credential, persist = true) {
    current = credential;
    if (persist) kept.write(credential);
    ever = true;
    holder.set(credential.token, credential);
    clearTimeout(expiry);
    if (sso) expiry = atExpiry(credential, () => {
      if (current === credential && !holder.signedIn()) holder.refused(credential.token);
    });
  }

  const service: AiSignIn = {
    async status() {
      const signedIn = holder.signedIn();
      const failed = !signedIn && sso && (tries.gaveUp() || browser.failed());
      const problem = o.apiKey ? 'Single sign-on did not work. Use an API key.' : 'Single sign-on did not work.';
      return ok({ signedIn, sso, apiKey: o.apiKey, firstSetup: firstSetup(), ...(failed ? { problem } : {}) });
    },
    async signIn() {
      if (!sso) return fail({ kind: 'failed', message: 'Single sign-on is not set up.' });
      // The system browser cannot tell us when someone closes its tab. An explicit retry supersedes that attempt.
      browser.cancel();
      tries.reset();
      holder.tryAgain();
      open();
      return ok(undefined);
    },
    async paste(token: string) {
      const key = await pastedKey(token, o);
      if (!key.ok) return key;
      browser.cancel();
      north.close();
      tries.reset();
      use({ token: key.value, kind: 'apiKey' });
      return ok(undefined);
    },
  };
  return {
    holder, service, sso,
    start() {
      if (current && holder.signedIn()) use(current, false);
      else if (!firstSetup()) open();
    },
    prompting: () => browser.active() || north.active(),
    close() {
      browser.cancel();
      clearTimeout(expiry);
      north.destroy();
    },
  };
}

function atExpiry(credential: Credential, expire: () => void) {
  const at = credential.expiresAt ?? jwtExpiry(credential.token);
  if (at === null) return undefined;
  // setTimeout accepts at most about 24 days. A later model call also checks the actual credential deadline.
  return setTimeout(expire, Math.min(Math.max(at - Date.now(), 0) + 100, 2 ** 31 - 1));
}

async function pastedKey(token: string, o: SignInOptions) {
  if (!o.apiKey) return fail({ kind: 'failed' as const, message: 'Signing in with an API key is turned off.' });
  const key = typeof token === 'string' ? token.trim() : '';
  if (!key || /[^\x21-\x7e]/.test(key)) return fail({ kind: 'invalid' as const, message: 'That is not an API key.' });
  const said = await checkKey(key, o.probe);
  if (said === 'refused') return fail({ kind: 'invalid' as const, message: `${SERVICE} didn’t accept that key.` });
  if (said === 'unreachable') return fail({ kind: 'unreachable' as const, message: `${SERVICE} can’t be reached.` });
  if (said === 'unchecked') {
    return fail({ kind: 'unreachable' as const, message: `${SERVICE} couldn’t check that key.` });
  }
  return ok(key);
}

function keptSignIn(o: SignInOptions) {
  const kept = tokenFile(o.dir, {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (bytes) => safeStorage.decryptString(bytes),
  }, `${o.provider}-token.bin`);
  return {
    saved: readSignIn(kept.read(), o),
    write(credential: Credential) {
      kept.write(CREDENTIAL_FILE_PREFIX + JSON.stringify({ ...credential, binding: o.binding }));
    },
    clear() {
      kept.write(CREDENTIAL_FILE_PREFIX + JSON.stringify({ binding: o.binding, completed: true }));
    },
  };
}

interface SavedSignIn { completed: boolean; credential?: Credential }

function readSignIn(saved: string, o: SignInOptions): SavedSignIn {
  if (!saved) return { completed: false };
  // Existing installs stored just the token. North used the same format for both sign-in methods.
  if (!saved.startsWith(CREDENTIAL_FILE_PREFIX)) {
    const enabled = !o.binding && (o.apiKey || (o.provider === 'north' && o.sso));
    const credential = enabled ? { token: saved, kind: o.apiKey ? 'apiKey' as const : 'sso' as const } : undefined;
    return { completed: true, credential };
  }
  const record = storedSignIn(saved.slice(CREDENTIAL_FILE_PREFIX.length));
  if (!record) return { completed: false };
  // A settings change can invalidate the credential while the person still needs read-only access to the records.
  if (!('token' in record) || record.binding !== o.binding) return { completed: true };
  const { token, kind, expiresAt } = record;
  const enabled = kind === 'sso' ? o.sso : o.apiKey;
  return { completed: true, credential: enabled ? { token, kind, expiresAt } : undefined };
}

type StoredSignIn = { binding?: string } & (Credential | { completed: true });

function storedSignIn(saved: string): StoredSignIn | undefined {
  try {
    const value = JSON.parse(saved) as Partial<Credential> & { binding?: string; completed?: boolean };
    if (value.completed === true) return { completed: true, binding: value.binding };
    if (typeof value.token !== 'string' || !value.token) return undefined;
    if (value.expiresAt !== undefined && !Number.isFinite(value.expiresAt)) return undefined;
    if (value.kind !== 'sso' && value.kind !== 'apiKey') return undefined;
    return { token: value.token, kind: value.kind, expiresAt: value.expiresAt, binding: value.binding };
  } catch { return undefined; }
}
