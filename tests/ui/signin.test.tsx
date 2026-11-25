// @vitest-environment jsdom
// Intelligence sign-in, in Settings and on the first-setup page: only the ways the control file turns on; a pasted key signs
// in once the service takes it, and a refused one stays in the field with the reason; Change… once signed in.
import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { SignInRow, SignInPage } from '../../src/ui/signin';
import { SignInConnection, startupConnection } from '../../src/app/connection';
import { ok } from '../../src/domain/result';
import type { AiSignIn } from '../../src/ports';

const settle = (ms = 20) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
function fake(o: { sso: boolean; apiKey: boolean; good?: string; problem?: string; signedIn?: boolean; away?: boolean }) {
  let signedIn = !!o.signedIn; const asked: string[] = [];
  const s: AiSignIn = {
    status: async () => ({ ok: true, value: { signedIn, sso: o.sso, apiKey: o.apiKey, ...(o.problem ? { problem: o.problem } : {}) } }),
    signIn: async () => { asked.push('sso'); return { ok: true, value: undefined }; },
    paste: async (k) => { asked.push(k); if (o.away) return { ok: false, error: { kind: 'unreachable', message: 'Intelligence can’t be reached.' } }; if (k !== (o.good ?? 'good-key')) return { ok: false, error: { kind: 'invalid', message: 'Intelligence didn’t accept that key.' } }; signedIn = true; return { ok: true, value: undefined }; },
  };
  return { s, asked };
}
async function mount(signin: AiSignIn) {
  const root = document.createElement('div');
  document.body.append(root);
  const form = new SignInConnection(signin);
  await act(() => { render(<SignInRow form={form} />, root); });
  await settle();
  return root;
}
const type = async (root: HTMLElement, v: string) => { const f = root.querySelector<HTMLInputElement>('#s-key')!; f.value = v; await act(() => { f.dispatchEvent(new Event('input', { bubbles: true })); }); };

describe('Intelligence sign-in', () => {
  it('offers only the ways that are turned on, and never names the provider', async () => {
    for (const [sso, apiKey] of [[true, true], [true, false], [false, true]] as const) {
      const root = await mount(fake({ sso, apiKey }).s);
      expect(!!root.querySelector('#s-sso')).toBe(sso); expect(!!root.querySelector('#s-key-open')).toBe(apiKey);
      expect(root.textContent).toContain('Intelligence Sign-In');
        expect(root.textContent).not.toMatch(/North|Claude|Cohere|Anthropic/);
      root.remove();
    }
  });
  it('when single sign-on gave up, the row says so and still offers the API key and another try', async () => {
    const root = await mount(fake({ sso: true, apiKey: true, problem: 'Single sign-on did not work. Use an API key.' }).s);
    expect(root.querySelector('#s-signin-error')?.textContent).toBe('Single sign-on did not work. Use an API key.');
    expect(root.querySelector('#s-key-open')).toBeTruthy(); expect(root.querySelector('#s-sso')).toBeTruthy();
    root.remove();
  });
  it('single sign-on opens the sign-in window', async () => {
    const f = fake({ sso: true, apiKey: true }); const root = await mount(f.s);
    await act(() => { root.querySelector<HTMLButtonElement>('#s-sso')!.click(); }); expect(f.asked).toEqual(['sso']);
  });
  it('a refused key stays in the field with the reason; a taken one signs in', async () => {
    const f = fake({ sso: false, apiKey: true }); const root = await mount(f.s);
    await act(() => { root.querySelector<HTMLButtonElement>('#s-key-open')!.click(); });
    expect(document.activeElement?.id).toBe('s-key'); expect(root.querySelector<HTMLButtonElement>('#s-key-use')!.disabled).toBe(true);
    expect(root.querySelector('#s-key-use')?.textContent).toBe('Sign In');
    await type(root, 'bad-key'); await act(() => { root.querySelector<HTMLButtonElement>('#s-key-use')!.click(); }); await settle();
    expect(root.querySelector('#s-signin-error')?.textContent).toBe('Intelligence didn’t accept that key.');
    expect(document.activeElement?.id).toBe('s-key');                                       // the field has the focus again
    expect(root.querySelector<HTMLInputElement>('#s-key')?.value).toBe('bad-key');            // nothing pasted is lost
    await type(root, 'good-key'); expect(root.querySelector('#s-signin-error')).toBeNull();   // typing again clears the reason
    await act(() => { root.querySelector<HTMLInputElement>('#s-key')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }); await settle();
    expect(root.querySelector('#s-signin-now')?.textContent).toBe('Signed in'); expect(root.querySelector('#s-key-open')).toBeNull();
    expect(f.asked).toEqual(['bad-key', 'good-key']);
    root.remove();
  });
  it('Cancel closes the field and keeps the key typed, for when it opens again', async () => {
    const f = fake({ sso: false, apiKey: true }); const root = await mount(f.s);
    await act(() => { root.querySelector<HTMLButtonElement>('#s-key-open')!.click(); }); await type(root, 'half-typed');
    await act(() => { root.querySelector<HTMLButtonElement>('#s-key-cancel')!.click(); });
    expect(root.querySelector('#s-key')).toBeNull(); expect(document.activeElement?.id).toBe('s-key-open');
    await act(() => { root.querySelector<HTMLButtonElement>('#s-key-open')!.click(); });
    expect(root.querySelector<HTMLInputElement>('#s-key')?.value).toBe('half-typed'); expect(f.asked).toEqual([]);
    root.remove();
  });
  it('signed in, Change… offers the ways again with Cancel, and the key in use stays until a new one is taken', async () => {
    const f = fake({ sso: true, apiKey: true, signedIn: true }); const root = await mount(f.s);
    expect(root.querySelector('#s-key-open')).toBeNull(); expect(root.querySelector('#s-sso')).toBeNull();
    await act(() => { root.querySelector<HTMLButtonElement>('#s-signin-change')!.click(); });
    expect(root.querySelector('#s-key-open')).toBeTruthy(); expect(root.querySelector('#s-sso')).toBeTruthy(); expect(root.querySelector('#s-signin-now')?.textContent).toBe('Signed in');
    await act(() => { root.querySelector<HTMLButtonElement>('#s-ways-cancel')!.click(); });
    expect(root.querySelector('#s-signin-change')).toBeTruthy(); expect(f.asked).toEqual([]);
    root.remove();
  });
});

async function page(signin: AiSignIn) {
  const root = document.createElement('div');
  document.body.append(root);
  let done = 0;
  const form = new SignInConnection(signin, () => { done++; });
  await act(() => { render(<SignInPage form={form} />, root); });
  await settle();
  return { root, done: () => done };
}

describe('the first-setup sign-in page', () => {
  it('keeps the original focus when the first-run page offers both ways', async () => {
    const signin: AiSignIn = {
      ...fake({ sso: true, apiKey: true }).s,
      status: async () => ok({ signedIn: false, sso: true, apiKey: true, firstSetup: true }),
    };
    const startup = await startupConnection({ signin }, true, () => undefined);
    if (startup.stage !== 'signin') throw new Error('Expected the sign-in stage before the shared folder');

    const root = document.createElement('div');
    document.body.append(root);
    await act(() => { render(<SignInPage form={startup.form} />, root); });
    await settle();
    expect(root.querySelector('#si-sso')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    await act(() => { root.querySelector<HTMLButtonElement>('#si-key-open')!.click(); });
    expect(document.activeElement?.id).toBe('si-key');
    await act(() => { root.querySelector<HTMLButtonElement>('#si-key-cancel')!.click(); });
    expect(document.activeElement?.id).toBe('si-sso');
    await act(() => { render(null, root); });
    root.remove();
  });

  it('offers both ways when both are on, and the key field straight away when only the key is', async () => {
    const both = await page(fake({ sso: true, apiKey: true }).s);
    expect(both.root.querySelector('h1')?.textContent).toBe('Sign In to Intelligence');
    expect(both.root.querySelector('#si-sso')).toBeTruthy(); expect(both.root.querySelector('#si-key-open')).toBeTruthy(); expect(both.root.querySelector('#si-key')).toBeNull();
    expect(both.root.textContent).not.toMatch(/North|Claude|Cohere|Anthropic/);
    both.root.remove();
    const key = await page(fake({ sso: false, apiKey: true }).s);
    expect(key.root.querySelector('#si-key')).toBeTruthy(); expect(key.root.querySelector('#si-key-cancel')).toBeNull(); expect(key.root.querySelector('#si-sso')).toBeNull();
    key.root.remove();
    const sso = await page(fake({ sso: true, apiKey: false }).s);
    expect(sso.root.querySelector('#si-sso')).toBeTruthy(); expect(sso.root.querySelector('#si-key-open')).toBeNull();
    sso.root.remove();
  });
  it('a refused key stays, with the reason in a line whose room is always kept; a taken one lets the app go on', async () => {
    const f = fake({ sso: true, apiKey: true }); const p = await page(f.s);
    expect(p.root.querySelector('#si-error')?.className).toContain('hold');
    await act(() => { p.root.querySelector<HTMLButtonElement>('#si-key-open')!.click(); });
    const f1 = p.root.querySelector<HTMLInputElement>('#si-key')!; f1.value = 'bad-key'; await act(() => { f1.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { p.root.querySelector<HTMLButtonElement>('#si-key-use')!.click(); }); await settle();
    expect(p.root.querySelector('#si-error')?.textContent).toBe('Intelligence didn’t accept that key.'); expect(p.root.querySelector<HTMLInputElement>('#si-key')?.value).toBe('bad-key');
    expect(document.activeElement?.id).toBe('si-key');
    // Cancel goes back to the two ways; the key typed is kept for when the field opens again
    await act(() => { p.root.querySelector<HTMLButtonElement>('#si-key-cancel')!.click(); });
    await act(() => { p.root.querySelector<HTMLButtonElement>('#si-key-open')!.click(); });
    expect(p.root.querySelector<HTMLInputElement>('#si-key')?.value).toBe('bad-key');
    const f2 = p.root.querySelector<HTMLInputElement>('#si-key')!; f2.value = 'good-key'; await act(() => { f2.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { p.root.querySelector<HTMLButtonElement>('#si-key-use')!.click(); }); await settle();
    expect(p.done()).toBe(1);
    p.root.remove();
  });
  it('no answer from the service: says so with Retry, and the key stays', async () => {
    const f = fake({ sso: false, apiKey: true, away: true }); const p = await page(f.s);
    const fl = p.root.querySelector<HTMLInputElement>('#si-key')!; fl.value = 'some-key'; await act(() => { fl.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(() => { p.root.querySelector<HTMLButtonElement>('#si-key-use')!.click(); }); await settle();
    expect(p.root.querySelector('#si-error')?.textContent).toContain('Intelligence can’t be reached.'); expect(p.root.querySelector('#si-retry')).toBeTruthy();
    await act(() => { p.root.querySelector<HTMLButtonElement>('#si-retry')!.click(); }); await settle();
    expect(f.asked).toEqual(['some-key', 'some-key']); expect(p.root.querySelector<HTMLInputElement>('#si-key')?.value).toBe('some-key');
    p.root.remove();
  });
});
