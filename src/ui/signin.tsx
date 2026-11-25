/**
 * Intelligence sign-in in the desktop app (decisions: "Intelligence sign-in"). Two places, one way of
 * working: `SignInPage` is all the window shows at first setup, until this PC has signed in once; `SignInRow` is its row
 * in Settings. Both show only the ways the control file turns on (signIn.sso, signIn.apiKey) and never name the provider.
 * Single sign-on opens the provider's page. A pasted key is checked with the service before it
 * is taken; a refused one stays in the field with the reason, so nothing pasted is lost, and the key in use, if
 * any, stays until a new one is taken.
 */
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { canUseSignInKey, type SignInConnection } from '../app/connection';
import { SERVICE } from '../control';
import { useConnectionForm } from './hooks';
import { Icon } from './icons';

const SSO_TIP = 'Sign in with your firm account';

function onKeyInput(
  event: KeyboardEvent,
  form: SignInConnection,
  cancelAction: 'disabled' | 'cancel' | 'cancelInSettings',
) {
  if (event.key === 'Enter') {
    event.preventDefault();
    void form.useKey();
  } else if (event.key === 'Escape' && cancelAction !== 'disabled') {
    event.preventDefault();
    if (cancelAction === 'cancelInSettings') event.stopPropagation();
    form.cancel();
  }
}

/** First setup: nothing else until this PC has signed in. */
export function SignInPage({ form }: { form: SignInConnection }) {
  const state = useConnectionForm(form);
  const { status: now, mode, key, busy, error } = state;
  const typing = mode === 'key';
  const field = useRef<HTMLInputElement>(null);
  const onlyKey = !!now && now.apiKey && !now.sso;
  const open = typing || onlyKey;
  useLayoutEffect(() => {
    if (open) field.current?.focus();
    else if (!typing && now) document.getElementById('si-sso')?.focus();
  }, [open]);
  useEffect(() => {
    if (error) field.current?.focus();
  }, [error]);
  if (!now || now.signedIn) return null;
  // one line under the row, its room kept even when empty, so nothing moves when it shows
  const line = error?.message ?? now.problem ?? '';
  return (
    <div class="home firstrun" id="signin"><div class="center">
      <span class="mark si-mark" aria-hidden="true"><Icon name="mark" size={30} /></span>
      <h1 class="ttl">Sign In to {SERVICE}</h1>
      {open
        ? <div class="cf-row si-key">
            <input ref={field} class="field si-field" id="si-key" type="password" aria-label="API key"
              placeholder="API key" autocomplete="off" spellcheck={false} value={key}
              onInput={(e) => form.setKey(e.currentTarget.value)}
              onKeyDown={(e) => onKeyInput(e, form, onlyKey ? 'disabled' : 'cancel')} />
            <button type="button" class="btn pri fr-new" id="si-key-use" disabled={!canUseSignInKey(state)}
              onClick={() => void form.useKey()}>Sign In</button>
            {!onlyKey && <button type="button" class="btn fr-new" id="si-key-cancel" disabled={busy}
              onClick={form.cancel}>Cancel</button>}
          </div>
        : <Ways sso={now.sso ? form.signIn : undefined} apiKey={now.apiKey ? form.openKey : undefined} />}
      <p class={`cf-warn si-line ${line ? '' : 'hold'}`} id="si-error" role={line ? 'alert' : undefined}>
        {line || ' '}{error?.away && <> <button type="button" class="linkb" id="si-retry" disabled={busy}
          onClick={() => void form.useKey()}>Retry</button></>}
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
export function SignInRow({ form }: { form: SignInConnection }) {
  const state = useConnectionForm(form);
  const { status: now, mode, key, busy, error } = state;
  const field = useRef<HTMLInputElement>(null);
  // the field takes the focus when it opens, and gives it back to what opened it when it closes
  const was = useRef(mode);
  useLayoutEffect(() => {
    if (mode === 'key') field.current?.focus();
    else if (was.current === 'key') document.getElementById(now?.signedIn ? 's-signin-change' : 's-key-open')?.focus();
    was.current = mode;
  }, [mode]);
  useEffect(() => {
    if (error) field.current?.focus();
  }, [error]);
  if (!now) return null;
  const offer = !now.signedIn || mode === 'ways';
  const problem = error?.message ?? (now.signedIn ? undefined : now.problem);
  return (
    <div class="srow top" id="s-signin"><div class="k">{SERVICE} Sign-In</div><div class="cf-set">
      {mode === 'key'
        ? <div class="cf-line">
            <input ref={field} class="field sm" id="s-key" type="password" aria-label="API key" placeholder="API key"
              autocomplete="off" spellcheck={false} value={key} style="flex:1;min-width:0"
              onInput={(e) => form.setKey(e.currentTarget.value)}
              onKeyDown={(e) => onKeyInput(e, form, 'cancelInSettings')} />
            <button type="button" class="btn sm pri" id="s-key-use" disabled={!canUseSignInKey(state)}
              onClick={() => void form.useKey()}>Sign In</button>
            <button type="button" class="btn sm" id="s-key-cancel" disabled={busy} onClick={form.cancel}>Cancel</button>
          </div>
        : <div class="cf-line">
            <span class="cf-now" id="s-signin-now" title={now.signedIn ? undefined : 'Nothing can be changed until someone signs in'}>{now.signedIn ? 'Signed in' : 'Not signed in'}</span>
            {offer && now.apiKey && <button type="button" class="linkb" id="s-key-open" title="Sign in with an API Key"
              onClick={form.openKey}>API Key</button>}
            {offer && now.sso && <button type="button" class="btn sm pri" id="s-sso" title={SSO_TIP}
              onClick={() => void form.signIn()}>Single Sign-On</button>}
            {now.signedIn && mode === 'ways' && <button type="button" class="btn sm" id="s-ways-cancel"
              onClick={form.cancel}>Cancel</button>}
            {now.signedIn && mode === 'idle' && <button type="button" class="btn sm" id="s-signin-change"
              onClick={form.openWays}>Change…</button>}
          </div>}
      {problem && <p class="cf-note warn" id="s-signin-error" role="alert">{problem}</p>}
    </div></div>
  );
}
