/**
 * Intelligence sign-in (ports `AiSignIn`), in the desktop app (decisions: "Intelligence sign-in"). Two places, one way of
 * working: `SignInPage` is all the window shows at first setup, until this PC has signed in once; `SignInRow` is its row
 * in Settings. Both show only the ways the control file turns on (signIn.sso, signIn.apiKey) and never name the provider.
 * Single sign-on opens the provider's page. A pasted key is checked with the service before it
 * is taken; a refused one stays in the field with the reason, so nothing pasted is lost, and the key in use, if
 * any, stays until a new one is taken.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AiSignIn } from '../ports';
import { SERVICE } from '../control';
import { Icon } from './icons';

type Status = { signedIn: boolean; sso: boolean; apiKey: boolean; firstSetup?: boolean; problem?: string };

/** the sign-in's status, looked at again every 2 seconds while signed out, so a sign-in in the SSO window shows without a click */
function useStatus(signin: AiSignIn) {
  const [now, setNow] = useState<Status | null>(null);
  const look = async () => { const r = await signin.status(); if (r.ok) setNow(r.value); };
  useEffect(() => { void look(); }, []);
  useEffect(() => { if (!now || now.signedIn) return; const t = setInterval(() => void look(), 2000); return () => clearInterval(t); }, [now?.signedIn]);
  return { now, look };
}

/** the key being typed and its answer: kept in the field until the service takes it */
function useKey(signin: AiSignIn, done: () => void) {
  const [key, setKey] = useState(''); const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; away: boolean } | null>(null);
  const use = async () => {
    if (!key.trim() || busy) return;
    setBusy(true); setError(null); const r = await signin.paste(key); setBusy(false);
    if (!r.ok) { setError({ message: r.error.message, away: r.error.kind === 'unreachable' }); return; }   // the key stays in the field
    setKey(''); done();
  };
  return { key, setKey, busy, error, setError, use };
}

const SSO_TIP = 'Sign in with your firm account';

/** First setup: nothing else until this PC has signed in. Signed in, `onDone` lets the app go on. */
export function SignInPage({ signin, onDone }: { signin: AiSignIn; onDone: () => void }) {
  const { now, look } = useStatus(signin);
  const [typing, setTyping] = useState(false);
  const k = useKey(signin, () => void look());
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (now?.signedIn) onDone(); }, [now?.signedIn]);
  const onlyKey = !!now && now.apiKey && !now.sso;
  const open = typing || onlyKey;
  useLayoutEffect(() => { if (open) field.current?.focus(); else if (typing === false && now) document.getElementById('si-sso')?.focus(); }, [open]);
  useEffect(() => { if (k.error) field.current?.focus(); }, [k.error]);   // after a refusal the field has the focus again, to fix the key
  if (!now || now.signedIn) return null;
  const sso = async () => { k.setError(null); const r = await signin.signIn(); if (!r.ok) k.setError({ message: r.error.message, away: false }); };
  const cancel = () => { setTyping(false); k.setError(null); };   // the typed key stays, for when the field opens again
  const openKey = () => {
    k.setError(null);
    setTyping(true);
  };
  // one line under the row, its room kept even when empty, so nothing moves when it shows
  const line = k.error?.message ?? now.problem ?? '';
  return (
    <div class="home firstrun" id="signin"><div class="center">
      <span class="mark si-mark" aria-hidden="true"><Icon name="mark" size={30} /></span>
      <h1 class="ttl">Sign In to {SERVICE}</h1>
      {open
        ? <div class="cf-row si-key">
            <input ref={field} class="field si-field" id="si-key" type="password" aria-label="API key" placeholder="API key" autocomplete="off" spellcheck={false} value={k.key}
              onInput={(e) => { k.setKey((e.currentTarget as HTMLInputElement).value); k.setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void k.use(); } else if (e.key === 'Escape' && !onlyKey) { e.preventDefault(); cancel(); } }} />
            <button type="button" class="btn pri fr-new" id="si-key-use" disabled={!k.key.trim() || k.busy}
              onClick={() => void k.use()}>Sign In</button>
            {!onlyKey && <button type="button" class="btn fr-new" id="si-key-cancel" disabled={k.busy} onClick={cancel}>Cancel</button>}
          </div>
        : <Ways sso={now.sso ? () => void sso() : undefined} apiKey={now.apiKey ? openKey : undefined} />}
      <p class={`cf-warn si-line ${line ? '' : 'hold'}`} id="si-error" role={line ? 'alert' : undefined}>
        {line || ' '}{k.error?.away && <> <button type="button" class="linkb" id="si-retry" disabled={k.busy} onClick={() => void k.use()}>Retry</button></>}
      </p>
    </div></div>
  );
}

/**
 * The ways to sign in on the first-setup page: single sign-on the one filled
 * button, and the API key a link under it, as the Settings row offers it.
 */
function Ways({ sso, apiKey }: { sso?: () => void; apiKey?: () => void }) {
  return (
    <div class="si-ways">
      {sso && (
        <button type="button" class="btn pri fr-new" id="si-sso" data-autofocus title={SSO_TIP} onClick={sso}>
          Single Sign-On
        </button>)}
      {apiKey && <button type="button" class="linkb" id="si-key-open" onClick={apiKey}>Sign In with an API Key</button>}
    </div>
  );
}

/** Settings: the sign-in row. Signed out, the ways to sign in; signed in, "Change…" offers them again. */
export function SignInRow({ signin }: { signin: AiSignIn }) {
  const { now, look } = useStatus(signin);
  const [mode, setMode] = useState<'idle' | 'ways' | 'key'>('idle');
  const k = useKey(signin, () => { setMode('idle'); void look(); });
  const field = useRef<HTMLInputElement>(null);
  // the field takes the focus when it opens, and gives it back to what opened it when it closes
  const was = useRef(mode);
  useLayoutEffect(() => { if (mode === 'key') field.current?.focus(); else if (was.current === 'key') document.getElementById(now?.signedIn ? 's-signin-change' : 's-key-open')?.focus(); was.current = mode; }, [mode]);
  useEffect(() => { if (k.error) field.current?.focus(); }, [k.error]);
  if (!now) return null;
  const sso = async () => { k.setError(null); const r = await signin.signIn(); if (!r.ok) k.setError({ message: r.error.message, away: false }); else setMode('idle'); };
  const cancel = () => { setMode('idle'); k.setError(null); };   // the typed key stays, for when the field opens again
  const offer = !now.signedIn || mode === 'ways';
  const problem = k.error?.message ?? (now.signedIn ? undefined : now.problem);
  return (
    <div class="srow top" id="s-signin"><div class="k">{SERVICE} Sign-In</div><div class="cf-set">
      {mode === 'key'
        ? <div class="cf-line">
            <input ref={field} class="field sm" id="s-key" type="password" aria-label="API key" placeholder="API key" autocomplete="off" spellcheck={false} value={k.key} style="flex:1;min-width:0"
              onInput={(e) => { k.setKey((e.currentTarget as HTMLInputElement).value); k.setError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void k.use(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } }} />
            <button type="button" class="btn sm pri" id="s-key-use" disabled={!k.key.trim() || k.busy}
              onClick={() => void k.use()}>Sign In</button>
            <button type="button" class="btn sm" id="s-key-cancel" disabled={k.busy} onClick={cancel}>Cancel</button>
          </div>
        : <div class="cf-line">
            <span class="cf-now" id="s-signin-now" title={now.signedIn ? undefined : 'Nothing can be changed until someone signs in'}>{now.signedIn ? 'Signed in' : 'Not signed in'}</span>
            {offer && now.apiKey && <button type="button" class="linkb" id="s-key-open" title="Sign in with an API Key"
              onClick={() => { k.setError(null); setMode('key'); }}>API Key</button>}
            {offer && now.sso && <button type="button" class="btn sm pri" id="s-sso" title={SSO_TIP}
              onClick={() => void sso()}>Single Sign-On</button>}
            {now.signedIn && mode === 'ways' && <button type="button" class="btn sm" id="s-ways-cancel" onClick={cancel}>Cancel</button>}
            {now.signedIn && mode === 'idle' && <button type="button" class="btn sm" id="s-signin-change" onClick={() => setMode('ways')}>Change…</button>}
          </div>}
      {problem && <p class="cf-note warn" id="s-signin-error" role="alert">{problem}</p>}
    </div></div>
  );
}
