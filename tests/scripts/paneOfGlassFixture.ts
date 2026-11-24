import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect } from 'vitest';

const script = path.resolve('scripts/check-pane-of-glass.mjs');
export const baselineFile = 'scripts/pane-of-glass-baseline.json';
const directories: string[] = [];
type Baseline = Record<string, Partial<Record<'import' | 'storage' | 'services' | 'repo', number>>>;

export function check(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

export function fixture(baseline: Baseline = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-of-glass-'));
  directories.push(dir);
  function write(file: string, source: string) {
    const destination = path.join(dir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  const setBaseline = (counts: Baseline) => write(baselineFile, JSON.stringify(counts));
  setBaseline(baseline);
  const baselineText = () => readFileSync(path.join(dir, baselineFile), 'utf8');
  return { dir, write, setBaseline, baselineText, run: (...args: string[]) => check(dir, ...args) };
}

export function loadCompiledFixture(repo: ReturnType<typeof fixture>, file: string, loader: string) {
  repo.write('package.json', '{"type":"module"}');
  repo.write('build/checklist.mjs', "export const caption = 'Checklist'");
  const compiler = path.resolve('node_modules/typescript/bin/tsc');
  const args = [compiler, '--ignoreConfig', '--strict', '--isolatedModules', '--target', 'ES2022',
    '--module', 'ESNext', '--moduleResolution', 'bundler', '--jsx', 'react', '--jsxFactory', 'h',
    '--skipLibCheck', '--outDir', 'build', file];
  const options = { cwd: repo.dir, encoding: 'utf8' } as const;
  const emit = spawnSync(process.execPath, args, options);
  expect(emit.status, emit.stdout + emit.stderr).toBe(0);
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', loader], options);
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.trim();
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
