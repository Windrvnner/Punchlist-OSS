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
  git('init', '-q'); git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  const check = () => spawnSync('node', [script], { cwd: dir, encoding: 'utf8' });
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
    for (const k of [pem, `{ "private_key": "${pem.replace('BEGIN', 'BEGIN RSA')}" }`, google]) {
      const r = repo(); r.write('e.json', `${k}\n`); r.git('add', 'e.json');
      const staged = r.check(); expect(staged.status).toBe(1); expect(staged.stderr).toContain('e.json');
      const all = spawnSync('node', [script, '--all'], { cwd: r.dir, encoding: 'utf8' }); expect(all.status).toBe(1);
    }
  });
  it('refuses the project key from .env, whatever its shape, and any .env file', () => {
    const r = repo(); r.write('.env', 'PUNCHLIST_AI_KEY=plain-key-with-no-known-shape-123\n'); r.write('d.md', 'plain-key-with-no-known-shape-123\n'); r.git('add', 'd.md');
    expect(r.check().status).toBe(1);
    const e = repo(); e.write('.env.local', 'X=1\n'); e.git('add', '-f', '.env.local'); expect(e.check().status).toBe(1);
  });
});
