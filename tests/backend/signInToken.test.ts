// @vitest-environment node
// The sign-in token: which tokens count as JWTs, and how calls wait for a sign-in and carry on after it.
import { describe, it, expect, vi } from 'vitest';
import { isJwt, jwtExpiry, tokenHolder, withSignInCap } from '../../src/backend/signInToken';
import { jwt } from './northStandIn';

describe('JWT shape', () => {
  it('knows a JWT and reads its expiry', () => {
    const t = jwt({ sub: 'u1', exp: 2_000_000_000 });
    expect(isJwt(t)).toBe(true); expect(jwtExpiry(t)).toBe(2_000_000_000_000);
    expect(jwtExpiry(jwt({ sub: 'u1' }))).toBeNull();
  });
  it('anything else is not a JWT', () => {
    for (const t of ['', 'abc', 'a.b.c', 'session=1', `${Buffer.from('{"x":1}').toString('base64url')}.e30.sig`, 'a b.c.d']) expect(isJwt(t)).toBe(false);
  });
});

describe('the token holder', () => {
  it('hands out the token it holds', async () => {
    const h = tokenHolder({ waitMs: 1000, token: 'pasted-token' });
    expect(await h.get()).toBe('pasted-token'); expect(h.signedIn()).toBe(true);
  });
  it('a call waits while nobody is signed in, asks for a sign-in once, and carries on with the new token', async () => {
    const needed = vi.fn(); const h = tokenHolder({ waitMs: 10_000, needed });
    const a = h.get(); const b = h.get();
    await Promise.resolve(); expect(needed).toHaveBeenCalledTimes(1);
    h.set('new-token');
    expect(await Promise.all([a, b])).toEqual(['new-token', 'new-token']);
  });
  it('with no cap, a call waits for the sign-in however long it takes, and carries on', async () => {
    vi.useFakeTimers();
    try {
      const h = tokenHolder({}); let got = ''; void h.get().then((t) => { got = t; });
      await vi.advanceTimersByTimeAsync(8 * 60 * 60_000); expect(got).toBe('');                  // a working day, still waiting
      h.set('signed-in'); await vi.advanceTimersByTimeAsync(0); expect(got).toBe('signed-in');
    } finally { vi.useRealTimers(); }
  });
  it('a capped wait fails as unreachable, as the stand-ins in tests use it', async () => {
    const h = tokenHolder({ waitMs: 20 });
    await expect(h.get()).rejects.toMatchObject({ code: 'unreachable', signedOut: true });
  });
  it("a check round's wait is capped, so a PC signed out mid-check lets go of its pieces; a person's own call still waits", async () => {
    const h = tokenHolder({});
    await expect(withSignInCap(20, () => h.get())).rejects.toMatchObject({ code: 'unreachable', signedOut: true });
    let got = ''; const own = h.get().then((t) => { got = t; });
    await new Promise((r) => setTimeout(r, 40)); expect(got).toBe('');
    h.set('later'); await own; expect(got).toBe('later');
  });
  it('when the sign-in gives up, waiting calls and new ones fail as unreachable until a person signs in again', async () => {
    const h = tokenHolder({}); const a = h.get();
    h.giveUp(); await expect(a).rejects.toMatchObject({ code: 'unreachable', signedOut: true });
    await expect(h.get()).rejects.toMatchObject({ signedOut: true });
    h.tryAgain(); const b = h.get(); h.set('pasted'); expect(await b).toBe('pasted');
  });
  it('a refused token is dropped and a sign-in asked for; a refusal of an older token is ignored', async () => {
    const needed = vi.fn(); const h = tokenHolder({ waitMs: 20, needed, token: 'old' });
    h.set('newer'); h.refused('old'); expect(h.signedIn()).toBe(true); expect(needed).not.toHaveBeenCalled();
    h.refused('newer'); expect(h.signedIn()).toBe(false); expect(needed).toHaveBeenCalledTimes(1);
  });
  it('a JWT past its expiry is never sent', async () => {
    let now = 1_000_000; const needed = vi.fn();
    const h = tokenHolder({ waitMs: 20, now: () => now, needed, token: jwt({ exp: 1100 }) });
    expect(h.signedIn()).toBe(true);
    now = 1_100_001; expect(h.signedIn()).toBe(false);
    await expect(h.get()).rejects.toMatchObject({ signedOut: true }); expect(needed).toHaveBeenCalledTimes(1);
  });
});
