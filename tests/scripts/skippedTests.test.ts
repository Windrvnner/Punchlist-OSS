// @vitest-environment node
// A test the diff skips counts as the regression it hides (docs/review-prompt.md), so lint refuses `.skip` in a test
// file. A test skipped on a stated condition (`skipIf`) is allowed.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const biome = path.resolve('node_modules/@biomejs/biome/bin/biome');
const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Lints the given test files with the repository's Biome settings, at the error level the checks use. */
function lint(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'skipped-tests-'));
  directories.push(dir);
  copyFileSync('biome.json', path.join(dir, 'biome.json'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), source);
  }
  const args = [biome, 'lint', '--diagnostic-level=error', 'tests'];
  return spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
}

const header = "import { describe, it } from 'vitest';\n";

describe('skipped tests', () => {
  it.each([
    ['tests/app/a.test.ts', `${header}it.skip('keeps the draft', () => {});\n`],
    ['tests/ui/b.test.tsx', `${header}describe.skip('the form', () => { it('keeps the draft', () => {}); });\n`],
  ])('refuses a skipped test in %s', (file, source) => {
    const result = lint({ [file]: source });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('noSkippedTests');
  });

  it('allows a test skipped on a stated condition', () => {
    const result = lint({ 'tests/app/c.test.ts': `${header}it.skipIf(!process.env.HOME)('reads home', () => {});\n` });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
