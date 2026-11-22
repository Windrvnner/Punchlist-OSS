// @vitest-environment jsdom
// The names on screen and in exports come from the control file (names.service, names.aiContent), never written in.
import { describe, it, expect, vi } from 'vitest';
import { render } from 'preact';
import { act } from 'preact/test-utils';

vi.mock('../../src/control', async (real) => ({ ...(await real<typeof import('../../src/control')>()), SERVICE: 'Lamna Brain', AI_LABEL: 'Model' }));
const { SignInRow } = await import('../../src/ui/signin');
const { findingsSheet } = await import('../../src/domain/importExport');
const { signedOut } = await import('../../src/backend/signInToken');
const { connection } = await import('../../src/app/connection');

describe('names from the control file', () => {
  it('the sign-in row, a sign-in wait and an export use them', async () => {
    const root = document.createElement('div'); document.body.append(root);
    const signin = { status: async () => ({ ok: true as const, value: { signedIn: false, sso: true, apiKey: true } }), signIn: async () => ({ ok: true as const, value: undefined }), paste: async () => ({ ok: true as const, value: undefined }) };
    await act(() => { render(<SignInRow signin={signin} />, root); }); await act(() => new Promise<void>((r) => setTimeout(r, 20)));
    expect(root.textContent).toContain('Lamna Brain Sign-In'); expect(root.textContent).not.toContain('Intelligence');
    expect(signedOut().message).toBe('Waiting for someone to sign in to Lamna Brain.');
    const sheet = findingsSheet([{ title: 't', body: ['b'], workstream: '', status: 'open', raisedAt: '', origin: 'ai', sources: [] } as never]);
    expect(sheet[1][5]).toBe('Model');
    expect(connection({ sync: null, net: { model: true } } as never, true, 0).rows.map((r) => r.name)).toEqual(['Network', 'OneDrive', 'Lamna Brain', 'Sync']);
    root.remove();
  });
});
