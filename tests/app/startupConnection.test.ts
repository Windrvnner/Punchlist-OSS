// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SharedFolderConnection, SignInConnection, sharedFolderOffer, startupConnection,
} from '../../src/app/connection';
import { fail, ok, type Result } from '../../src/domain/result';
import type { AiSignIn, SharedFolderStatus, SharedPlace, SignInStatus } from '../../src/ports';

const signedOut: SignInStatus = { signedIn: false, sso: true, apiKey: true, firstSetup: true };
const signedIn: SignInStatus = { ...signedOut, signedIn: true, firstSetup: false };
const team = String.raw`C:\Users\Avery\OneDrive - Alder Lane\Punchlist`;
const otherTeam = String.raw`C:\Users\Avery\OneDrive - Westfield Partners\Punchlist`;
const manual = String.raw`Z:\Alder Lane\Transaction Services\Punchlist`;
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

  it('advances immediately after an accepted key even when an old status poll has stalled', async () => {
    const signin = signInPort();
    let finish!: (value: Result<SignInStatus>) => void;
    const staleStatus = new Promise<Result<SignInStatus>>((resolve) => { finish = resolve; });
    signin.status.mockResolvedValueOnce(ok(signedOut)).mockReturnValueOnce(staleStatus);
    const onSignedIn = vi.fn();
    const form = new SignInConnection(signin, onSignedIn);
    const stop = form.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(signin.status).toHaveBeenCalledTimes(2);

    signin.status.mockResolvedValue(ok(signedIn));
    form.setKey('alder-lane-stand-in');
    const submitted = form.useKey();
    await vi.advanceTimersByTimeAsync(0);
    expect(signin.status).toHaveBeenCalledTimes(3);
    expect(onSignedIn).toHaveBeenCalledOnce();

    finish(ok(signedOut));
    await submitted;
    await vi.advanceTimersByTimeAsync(4000);
    expect(form.get().status).toEqual(signedIn);
    expect(signin.status).toHaveBeenCalledTimes(3);
    expect(onSignedIn).toHaveBeenCalledOnce();
    stop();
  });
});

describe('shared-folder connection', () => {
  it('uses the only local match once and offers a retry when using it fails', async () => {
    const place = folderPort();
    place.get.mockResolvedValue(ok({ ...searching, found: [team] }));
    const message = 'The Punchlist folder could not be reached.';
    place.use.mockResolvedValueOnce(fail({ kind: 'unreachable', message }));
    const form = new SharedFolderConnection(place, true);
    const stop = form.start();
    await vi.advanceTimersByTimeAsync(15000);
    expect(place.use.mock.calls).toEqual([[team]]);
    expect(form.get()).toMatchObject({ busy: false, error: message });
    expect(sharedFolderOffer(form.get())).toMatchObject({ visible: true, offer: { path: team, inOneDrive: true } });
    await form.useFolder(team);
    expect(place.use.mock.calls).toEqual([[team], [team]]);
    expect(form.get()).toMatchObject({ busy: true, error: '' });
    stop();
  });

  it('waits for the person to choose when several matches exist and uses the confirmed folder', async () => {
    const place = folderPort();
    place.get.mockResolvedValue(ok({ ...searching, found: [team, otherTeam] }));
    const form = new SharedFolderConnection(place, true);
    const stop = form.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(place.use).not.toHaveBeenCalled();
    expect(sharedFolderOffer(form.get())).toMatchObject({ choices: [team, otherTeam], offer: { path: team } });
    form.choose(otherTeam);
    expect(place.use).not.toHaveBeenCalled();
    expect(sharedFolderOffer(form.get())).toMatchObject({ offer: { path: otherTeam } });
    await form.useFolder(otherTeam);
    expect(place.use.mock.calls).toEqual([[otherTeam]]);
    stop();
  });

  it('never stacks slow folder discovery calls or auto-uses a result after the connection closes', async () => {
    const place = folderPort();
    let finish!: (value: Result<SharedFolderStatus>) => void;
    const slowScan = new Promise<Result<SharedFolderStatus>>((resolve) => { finish = resolve; });
    place.get.mockReturnValueOnce(slowScan);
    const form = new SharedFolderConnection(place, true);
    const stop = form.start();
    await vi.advanceTimersByTimeAsync(15000);
    expect(place.get).toHaveBeenCalledOnce();
    finish(ok(searching));
    await vi.advanceTimersByTimeAsync(5000);
    expect(place.get).toHaveBeenCalledTimes(2);

    let finishLate!: (value: Result<SharedFolderStatus>) => void;
    place.get.mockReturnValueOnce(new Promise((resolve) => { finishLate = resolve; }));
    await vi.advanceTimersByTimeAsync(5000);
    stop();
    finishLate(ok({ ...searching, found: [team] }));
    await vi.advanceTimersByTimeAsync(10000);
    expect(place.get).toHaveBeenCalledTimes(3);
    expect(place.use).not.toHaveBeenCalled();
  });

  it('keeps the connected folder in Settings until a manually picked folder is confirmed', async () => {
    const place = folderPort();
    place.get.mockResolvedValue(ok({ ...searching, path: team }));
    place.pick.mockResolvedValue(ok({ path: manual, inOneDrive: false }));
    const form = new SharedFolderConnection(place);
    const stop = form.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(place.get).toHaveBeenCalledOnce();
    await form.pick();
    expect(form.get()).toMatchObject({ picked: { path: manual, inOneDrive: false }, status: { path: team } });
    expect(place.use).not.toHaveBeenCalled();
    form.cancel();
    expect(form.get()).toMatchObject({ picked: null, status: { path: team } });
    await form.pick();
    await form.useFolder(manual);
    expect(place.use.mock.calls).toEqual([[manual]]);
    stop();
  });
});
