// @vitest-environment node
// The North token on the PC: which SSO cookie is taken, and that it is kept only encrypted.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pickSsoToken, ssoTries, SSO_TRIES, tokenFile, type Crypt } from '../../src/desktop/token';
import { jwt } from '../backend/northStandIn';

const NOW = 1_800_000_000_000;
const live = jwt({ sub: 'u1', exp: NOW / 1000 + 3600 }), later = jwt({ sub: 'u1', exp: NOW / 1000 + 7200 }), old = jwt({ sub: 'u1', exp: NOW / 1000 - 1 });
const SSO = 'https://sso.example.com';

describe('the SSO cookie', () => {
  it('takes a JWT from the exact SSO site, with or without the leading dot', () => {
    expect(pickSsoToken([{ name: 'session', value: live, domain: 'sso.example.com' }], SSO, NOW)).toBe(live);
    expect(pickSsoToken([{ name: 'session', value: live, domain: '.SSO.example.com' }], SSO, NOW)).toBe(live);
  });
  it('takes nothing from another site, a parent domain or a look-alike', () => {
    for (const domain of ['example.com', '.example.com', 'north.example.com', 'sso.example.com.evil.test', 'evilsso.example.com']) expect(pickSsoToken([{ name: 's', value: live, domain }], SSO, NOW)).toBeNull();
  });
  it('takes nothing that is not a JWT, has expired, or never says when it ends', () => {
    expect(pickSsoToken([{ name: 's', value: 'opaque-session-id', domain: 'sso.example.com' }], SSO, NOW)).toBeNull();
    expect(pickSsoToken([{ name: 's', value: old, domain: 'sso.example.com' }], SSO, NOW)).toBeNull();
    expect(pickSsoToken([{ name: 's', value: jwt({ sub: 'u1' }), domain: 'sso.example.com' }], SSO, NOW)).toBeNull();
    expect(pickSsoToken([{ name: 's', value: live, domain: 'sso.example.com', expirationDate: NOW / 1000 - 5 }], SSO, NOW)).toBeNull();
  });
  it('with several, takes the one that lasts longest', () => {
    expect(pickSsoToken([{ name: 'a', value: live, domain: 'sso.example.com' }, { name: 'b', value: later, domain: 'sso.example.com' }], SSO, NOW)).toBe(later);
  });
});

describe('a provider that refuses the SSO token', () => {
  it('a refused token is never taken again; one that ran out is an ordinary sign-out', () => {
    const t = ssoTries();
    t.took(live, NOW); expect(t.signedOut(NOW + 1000)).toBe(true); expect(t.usable(live)).toBe(false);
    t.took(later, NOW); expect(t.signedOut(NOW + 7201_000)).toBe(true); expect(t.usable(later)).toBe(true);
  });
  it(`after ${SSO_TRIES} quick refusals the window stops opening by itself, until the person tries again`, () => {
    const t = ssoTries(); const tokens = [1, 2, 3].map((i) => jwt({ sub: `u${i}`, exp: NOW / 1000 + 3600 }));
    const open = tokens.map((tok) => { t.took(tok, NOW); return t.signedOut(NOW + 1000); });
    expect(open).toEqual([true, true, false]); expect(t.gaveUp()).toBe(true);
    t.reset(); expect(t.gaveUp()).toBe(false);
  });
  it('a refusal long after the token was taken does not count against single sign-on', () => {
    const t = ssoTries();
    for (let i = 0; i < 5; i++) { const tok = jwt({ sub: `u${i}`, exp: NOW / 1000 + 36_000 }); t.took(tok, NOW); expect(t.signedOut(NOW + 3600_000)).toBe(true); }
    expect(t.gaveUp()).toBe(false);
  });
  it('with no SSO token held (a pasted key, or none yet), a sign-out counts for nothing', () => {
    const t = ssoTries(); for (let i = 0; i < 5; i++) expect(t.signedOut(NOW)).toBe(true);
  });
});

describe('keeping the token', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-token-'));
  const rot: Crypt = { available: () => true, encrypt: (t) => Buffer.from(t.split('').reverse().join('')), decrypt: (b) => b.toString().split('').reverse().join('') };
  it('is written encrypted and read back; an empty token removes the file', () => {
    const d = dir(); const f = tokenFile(d, rot, 'north-token.bin');
    f.write('secret-token'); expect(fs.readFileSync(path.join(d, 'north-token.bin'), 'utf8')).not.toContain('secret-token');
    expect(f.read()).toBe('secret-token');
    f.write(''); expect(fs.existsSync(path.join(d, 'north-token.bin'))).toBe(false); expect(f.read()).toBe('');
  });
  it('without encryption on this PC, nothing is written at all', () => {
    const d = dir(); const f = tokenFile(d, { ...rot, available: () => false }, 'north-token.bin');
    f.write('secret-token'); expect(fs.readdirSync(d)).toEqual([]); expect(f.read()).toBe('');
  });
});
