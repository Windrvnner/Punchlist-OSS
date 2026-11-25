// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SignInConnection, startupConnection,
} from '../../src/app/connection';
import { fail, ok, type Result } from '../../src/domain/result';
import type { AiSignIn, SharedFolderStatus, SharedPlace, SignInStatus } from '../../src/ports';

const signedOut: SignInStatus = { signedIn: false, sso: true, apiKey: true, firstSetup: true };
const signedIn: SignInStatus = { ...signedOut, signedIn: true, firstSetup: false };
const team = String.raw`C:\Users\Avery\OneDrive - Alder Lane\Punchlist`;
const searching: SharedFolderStatus = { path: null, found: [], suggested: team };

function signInPort() {
  return {
    status: vi.fn<AiSignIn['status']>().mockResolvedValue(ok(signedOut)),
    signIn: vi.fn<AiSignIn['signIn']>().mockResolvedValue(ok(undefined)),
    paste: vi.fn<AiSignIn['paste']>().mockResolvedValue(ok(undefined)),
  };
}

function folderPort() {
  return {
    get: vi.fn<SharedPlace['get']>().mockResolvedValue(ok(searching)),
    pick: vi.fn<SharedPlace['pick']>().mockResolvedValue(ok(null)),
    use: vi.fn<SharedPlace['use']>().mockResolvedValue(ok(undefined)),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('desktop startup', () => {
  it('shows first sign-in before the folder and reaches normal startup after both are ready', async () => {
    const signin = signInPort();
    const place = folderPort();
    const onSignedIn = vi.fn();
    const services = { signin, place };
    expect((await startupConnection(services, false, onSignedIn)).stage).toBe('signin');
    expect(place.get).not.toHaveBeenCalled();

    signin.status.mockResolvedValue(ok(signedIn));
    expect((await startupConnection(services, false, onSignedIn)).stage).toBe('connect');
    expect((await startupConnection(services, true, onSignedIn)).stage).toBe('ready');
  });

  it('keeps the normal startup route for a later sign-out or an unreachable sign-in status', async () => {
    const signin = signInPort();
    const place = folderPort();
    const onSignedIn = vi.fn();
    signin.status.mockResolvedValueOnce(ok({ ...signedOut, firstSetup: false }));
    expect((await startupConnection({ signin, place }, true, onSignedIn)).stage).toBe('ready');
    signin.status.mockRejectedValueOnce(new Error('The application bridge is unavailable'));
    expect((await startupConnection({ signin, place }, false, onSignedIn)).stage).toBe('connect');
    expect((await startupConnection({}, false, onSignedIn)).stage).toBe('ready');
  });
});

describe('sign-in connection', () => {
  it('keeps the key on a failure and checks the new status immediately after accepting a retry', async () => {
    const signin = signInPort();
    const onSignedIn = vi.fn();
    const form = new SignInConnection(signin, onSignedIn);
    const stop = form.start();
    await vi.advanceTimersByTimeAsync(0);
    const key = 'Alder Lane acceptance stand-in';
    form.setKey(key);
    signin.paste.mockResolvedValueOnce(fail({ kind: 'unreachable', message: 'Intelligence can’t be reached.' }));
    await form.useKey();
    expect(form.get()).toMatchObject({ key, busy: false, error: { away: true } });
    form.cancel();
    expect(form.get().key).toBe(key);
    signin.status.mockResolvedValue(ok(signedIn));
    await form.useKey();
    expect(signin.paste.mock.calls).toEqual([[key], [key]]);
    expect(form.get()).toMatchObject({ key: '', busy: false, error: null, status: signedIn });
    expect(onSignedIn).toHaveBeenCalledOnce();
    stop();
  });

  it('starts single sign-on, skips overlapping status checks and stops polling when the PC is signed in', async () => {
    const signin = signInPort();
    let finish!: (value: Result<SignInStatus>) => void;
    const slowStatus = new Promise<Result<SignInStatus>>((resolve) => { finish = resolve; });
    signin.status.mockResolvedValueOnce(ok(signedOut)).mockReturnValueOnce(slowStatus);
    const onSignedIn = vi.fn();
    const form = new SignInConnection(signin, onSignedIn);
    const stop = form.start();
    await vi.advanceTimersByTimeAsync(0);
    await form.signIn();
    expect(signin.signIn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(6000);
    expect(signin.status).toHaveBeenCalledTimes(2);
    expect(onSignedIn).not.toHaveBeenCalled();
    finish(ok(signedIn));
    await vi.advanceTimersByTimeAsync(6000);
    expect(form.get().status).toEqual(signedIn);
    expect(onSignedIn).toHaveBeenCalledOnce();
    expect(signin.status).toHaveBeenCalledTimes(2);
    stop();
  });
});
