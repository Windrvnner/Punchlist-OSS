// @vitest-environment node
// The pre-commit secrets check: it judges what will be committed (the staged content), not the file on disk.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const script = path.resolve('scripts/check-secrets.mjs');
// built at run time, so this file itself holds nothing that looks like a key
const pem = ['-----BEGIN', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----'].join(' ');
const google = 'AI' + 'za' + 'Q7w'.repeat(11) + 'xy';
const fake = { anthropic: 'sk-' + 'ant-' + 'a1B2'.repeat(6), openaiProject: 'sk-' + 'proj-' + 'Z9y8'.repeat(10), jwt: ['eyJ' + 'h'.repeat(20), 'eyJ' + 'p'.repeat(30), 's'.repeat(30)].join('.') };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secrets-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  git('commit', '-q', '--allow-empty', '-m', 'start');
  const check = (...a: string[]) => spawnSync('node', [script, ...a], { cwd: dir, encoding: 'utf8' });
  return { dir, git, check, write: (f: string, t: string) => fs.writeFileSync(path.join(dir, f), t) };
}

describe('the secrets check', () => {
  it('refuses a key that is staged even when the file on disk no longer has it', () => {
    const r = repo(); r.write('a.ts', `const k = '${fake.anthropic}';\n`); r.git('add', 'a.ts'); r.write('a.ts', 'const k = process.env.KEY;\n');
    const out = r.check(); expect(out.status).toBe(1); expect(out.stderr).toContain('a.ts'); expect(out.stderr).not.toContain(fake.anthropic);
  });
  it('refuses OpenAI project keys and sign-in tokens, and passes clean files', () => {
    for (const k of [fake.openaiProject, fake.jwt]) { const r = repo(); r.write('b.ts', `x = "${k}"\n`); r.git('add', 'b.ts'); expect(r.check().status).toBe(1); }
    const ok = repo(); ok.write('c.ts', 'const k = process.env.KEY;\n'); ok.git('add', 'c.ts'); expect(ok.check().status).toBe(0);
  });
  it('refuses a private key in PEM form and a Google key, staged or tracked', () => {
    const pgp = pem.replaceAll('PRIVATE KEY', 'PGP PRIVATE KEY BLOCK');
    for (const k of [pem, `{ "private_key": "${pem.replace('BEGIN', 'BEGIN RSA')}" }`, pgp, google]) {
      const r = repo();
      r.write('e.json', `${k}\n`);
      r.git('add', 'e.json');
      const staged = r.check();
      expect(staged.status).toBe(1);
      expect(staged.stderr).toContain('e.json');
      expect(r.check('--all').status).toBe(1);
    }
  });
  it('refuses the project key from .env, whatever its shape, and any .env file', () => {
    const r = repo(); r.write('.env', 'PUNCHLIST_AI_KEY=plain-key-with-no-known-shape-123\n'); r.write('d.md', 'plain-key-with-no-known-shape-123\n'); r.git('add', 'd.md');
    expect(r.check().status).toBe(1);
    const e = repo(); e.write('.env.local', 'X=1\n'); e.git('add', '-f', '.env.local'); expect(e.check().status).toBe(1);
  });
});

describe('the secrets check over a branch', () => {
  const commitAll = (r: ReturnType<typeof repo>, message: string) => {
    r.git('add', '-A', '-f');
    r.git('commit', '-q', '-m', message);
  };
  const shortId = (r: ReturnType<typeof repo>) => r.git('rev-parse', '--short', 'HEAD').toString().trim();

  it('passes on main with a clean tip', () => {
    const r = repo();
    r.write('a.ts', 'const k = process.env.KEY;\n');
    commitAll(r, 'clean');
    expect(r.check('--all').status).toBe(0);
  });
  it('refuses a key added in one commit and removed in the next', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'feature');
    r.write('a.ts', `const k = '${fake.anthropic}';\n`);
    commitAll(r, 'add');
    const added = shortId(r);
    r.write('a.ts', 'const k = process.env.KEY;\n');
    commitAll(r, 'remove');
    const out = r.check('--all');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('a.ts');
    expect(out.stderr).toContain(added);
    expect(out.stderr).not.toContain(fake.anthropic);
  });
  it('refuses a key added in a merge resolution', () => {
    const r = repo();
    r.write('a.ts', 'base\n');
    commitAll(r, 'base');
    r.git('checkout', '-q', '-b', 'feature');
    r.write('a.ts', 'feature\n');
    commitAll(r, 'feature');
    r.git('checkout', '-q', 'main');
    r.write('a.ts', 'main\n');
    commitAll(r, 'main');
    r.git('checkout', '-q', 'feature');
    try { r.git('merge', '-q', 'main'); } catch { /* conflict, resolved below */ }
    r.write('a.ts', `const k = '${fake.anthropic}';\n`);
    commitAll(r, 'merge');
    r.write('a.ts', 'const k = process.env.KEY;\n');
    commitAll(r, 'remove');
    const out = r.check('--all');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('a.ts');
    expect(out.stderr).not.toContain(fake.anthropic);
  });
  it('refuses a .env file added in one commit and deleted in the next', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'feature');
    r.write('.env', 'X=1\n');
    commitAll(r, 'add');
    fs.rmSync(path.join(r.dir, '.env'));
    commitAll(r, 'remove');
    const out = r.check('--all');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('.env');
  });
  it('allows a .env.example file added on a branch', () => {
    const r = repo();
    r.git('checkout', '-q', '-b', 'feature');
    r.write('.env.example', 'X=\n');
    commitAll(r, 'add');
    expect(r.check('--all').status).toBe(0);
  });
  it('refuses a committed .env file on main and names it', () => {
    const r = repo();
    r.write('.env', 'X=1\n');
    commitAll(r, 'add');
    const out = r.check('--all');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('.env');
  });
});
