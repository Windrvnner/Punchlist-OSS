// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { aiSignIn, type SignInOptions } from '../../src/desktop/signin';

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  shell: { openExternal: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text).reverse(),
    decryptString: (bytes: Buffer) => Buffer.from(bytes).reverse().toString(),
  },
}));

it('resumes waiting calls with a fresh cloud credential and restores its kind and lifetime after restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-cloud-auth-'));
  const expiresAt = Date.now() + 600_000;
  const firstToken = { token: 'opaque-original', kind: 'sso', expiresAt } as const;
  const nextToken = { token: 'opaque-replacement', kind: 'sso', expiresAt } as const;
  const browserSignIn = vi.fn<NonNullable<SignInOptions['browserSignIn']>>()
    .mockResolvedValueOnce(firstToken).mockResolvedValueOnce(nextToken);
  const options: SignInOptions = {
    provider: 'vertex', address: '', ssoSite: '', sso: true, apiKey: true,
    binding: 'deployment-1', browserSignIn, parent: () => null, dir,
  };

  const signIn = aiSignIn(options);
  let restarted: ReturnType<typeof aiSignIn> | undefined;
  try {
    const waiting = signIn.holder.credential(1000);
    expect(browserSignIn).not.toHaveBeenCalled();
    expect(await signIn.service.signIn()).toMatchObject({ ok: true });
    await expect(waiting).resolves.toEqual(firstToken);
    const file = path.join(dir, 'vertex-token.bin');
    expect(fs.readFileSync(file).includes(firstToken.token)).toBe(false);
    signIn.close();

    restarted = aiSignIn(options);
    restarted.start();
    await expect(restarted.holder.credential(1000)).resolves.toEqual(firstToken);
    restarted.holder.refused(firstToken.token);
    await expect(restarted.holder.credential(1000)).resolves.toEqual(nextToken);
    expect(browserSignIn).toHaveBeenCalledTimes(2);

    const unrelated = aiSignIn({ ...options, binding: 'deployment-2' });
    expect(unrelated.holder.signedIn()).toBe(false);
    unrelated.close();
  } finally {
    restarted?.close();
    signIn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('reads an existing pasted key even if the key begins with a brace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-legacy-auth-'));
  const key = '{"legacy":"key"}';
  fs.writeFileSync(path.join(dir, 'openai-token.bin'), Buffer.from(key).reverse());
  const signIn = aiSignIn({
    provider: 'openai', address: '', ssoSite: '', sso: false, apiKey: true, dir, parent: () => null,
  });
  try {
    await expect(signIn.holder.get(1000)).resolves.toBe(key);
  } finally {
    signIn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('reopens the browser on manual retry and ignores completion of the superseded attempt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-cloud-retry-'));
  type BrowserSignIn = NonNullable<SignInOptions['browserSignIn']>;
  const browserSignIn = vi.fn<BrowserSignIn>();
  let finishFirst!: (credential: Awaited<ReturnType<BrowserSignIn>>) => void;
  const first = new Promise<Awaited<ReturnType<BrowserSignIn>>>((resolve) => { finishFirst = resolve; });
  browserSignIn.mockReturnValueOnce(first).mockResolvedValueOnce({ token: 'fresh', kind: 'sso' });
  const signIn = aiSignIn({
    provider: 'azure', address: '', ssoSite: '', sso: true, apiKey: true, dir, parent: () => null, browserSignIn,
  });
  try {
    await signIn.service.signIn();
    const { signal } = browserSignIn.mock.calls[0][0];
    await signIn.service.signIn();
    expect(signal.aborted).toBe(true);
    expect(browserSignIn).toHaveBeenCalledTimes(2);
    await expect(signIn.holder.get(1000)).resolves.toBe('fresh');
    finishFirst({ token: 'superseded', kind: 'sso' });
    await first;
    await expect(signIn.holder.get(1000)).resolves.toBe('fresh');
  } finally {
    signIn.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps completed setup across a restart after a refused credential', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-cloud-restart-'));
  const browserSignIn = vi.fn<NonNullable<SignInOptions['browserSignIn']>>()
    .mockResolvedValueOnce({ token: 'refused', kind: 'sso' });
  browserSignIn.mockImplementation(() => new Promise(() => {}));
  const options: SignInOptions = {
    provider: 'azure', address: '', ssoSite: '', sso: true, apiKey: true,
    dir, parent: () => null, binding: 'deployment', browserSignIn,
  };
  const signIn = aiSignIn(options);
  let restarted: ReturnType<typeof aiSignIn> | undefined;
  try {
    await signIn.service.signIn();
    await expect(signIn.holder.get(1000)).resolves.toBe('refused');
    signIn.holder.refused('refused');
    signIn.close();
    restarted = aiSignIn(options);
    expect(await restarted.service.status()).toMatchObject({
      ok: true, value: { signedIn: false, firstSetup: false },
    });
    restarted.start();
    expect(browserSignIn).toHaveBeenCalledTimes(3);
  } finally {
    signIn.close();
    restarted?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it.each([{ sso: false }, { binding: 'new-deployment' }])(
  'preserves read-only access after saved sign-in becomes ineligible with %j',
  async (change) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-cloud-settings-'));
    const browserSignIn = vi.fn<NonNullable<SignInOptions['browserSignIn']>>()
      .mockResolvedValueOnce({ token: 'previous', kind: 'sso' });
    const options: SignInOptions = {
      provider: 'azure', address: '', ssoSite: '', sso: true, apiKey: true,
      dir, parent: () => null, binding: 'deployment', browserSignIn,
    };
    const signIn = aiSignIn(options);
    try {
      await signIn.service.signIn();
      await expect(signIn.holder.get(1000)).resolves.toBe('previous');
      signIn.close();
      const restarted = aiSignIn({ ...options, ...change });
      try {
        expect(await restarted.service.status()).toMatchObject({
          ok: true, value: { signedIn: false, firstSetup: false },
        });
      } finally {
        restarted.close();
      }
    } finally {
      signIn.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
