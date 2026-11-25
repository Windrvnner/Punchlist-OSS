// @vitest-environment node
// The readability hints (CLAUDE.md, "Readable code"): a too-complex function the branch changes anywhere, a new
// function over 60 lines, and a file over 500 lines the branch makes longer are listed. The check never fails.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-readability.mjs');

/** A repository whose main holds `before`, checked out on a branch that deletes `removed` and writes `after`. */
function branch(before: Record<string, string>, after: Record<string, string>, removed: string[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'readability-'));
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
  const git = (...args: string[]) => execFileSync('git', [...identity, ...args], { cwd: dir });
  const write = (files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), text);
    }
  };
  symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'junction');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  git('init', '-q', '-b', 'main');
  write(before);
  git('add', '.');
  git('commit', '-qm', 'Before');
  git('checkout', '-qb', 'topic');
  if (removed.length) git('rm', '-q', ...removed);
  write(after);
  git('add', '.');
  git('commit', '-qm', 'After');
  return spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
}

/** A function with `branches` nested decisions, well past Biome's complexity limit of 15. */
function complex(branches: number) {
  const body = Array.from({ length: branches }, (_, i) => `  if (x > ${i}) { if (x < ${i * 2}) { x += ${i}; } }`);
  return ['export function decide(x: number): number {', ...body, '  return x;', '}', ''].join('\n');
}

/** A function of `lines` plain statements, plus its first line, its return and its closing brace. */
function flat(name: string, lines: number) {
  const body = Array(lines).fill('  x += 1;');
  return [`export function ${name}(x: number): number {`, ...body, '  return x;', '}', ''].join('\n');
}

describe('the readability hints', () => {
  it('list a too-complex function the branch grew without touching its first line', () => {
    const result = branch({ 'src/a.ts': complex(8) }, { 'src/a.ts': complex(12) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('changed functions that are too complex');
    expect(result.stdout).toContain('src/a.ts:1');
  });

  it('list a new function over 60 lines, and not one of 60', () => {
    const result = branch({ 'src/b.ts': '' }, { 'src/b.ts': `${flat('long', 70)}${flat('fits', 57)}` });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('src/b.ts:1  73 lines');
    expect(result.stdout).not.toContain('src/b.ts:74');
  });

  it('list no test suite callback, however long', () => {
    const suite = `describe('many', () => {\n${"  it('adds', () => {});\n".repeat(70)}});\n`;
    const result = branch({}, { 'tests/c.test.ts': `import { describe, it } from 'vitest';\n${suite}` });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('tests/c.test.ts');
  });

  it('list a file over 500 lines the branch made longer, and not one it made shorter or renamed shorter', () => {
    // each line ends with a newline, as an editor saves it
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};\n`).join('');
    const result = branch(
      { 'src/grown.ts': lines(520), 'src/cut.ts': lines(560), 'src/full.ts': lines(490), 'src/old.ts': lines(600) },
      { 'src/grown.ts': lines(530), 'src/cut.ts': lines(540), 'src/full.ts': lines(500), 'src/new.ts': lines(590) },
      ['src/old.ts'],
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('src/grown.ts  530 lines');
    expect(result.stdout).not.toContain('src/cut.ts');
    expect(result.stdout).not.toContain('src/full.ts');
    expect(result.stdout).not.toContain('src/new.ts');
  });
});
