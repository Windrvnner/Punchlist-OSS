// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-pane-of-glass.mjs');
const baselineFile = 'scripts/pane-of-glass-baseline.json';
const directories: string[] = [];
type Baseline = Record<string, Partial<Record<'import' | 'storage' | 'services' | 'repo', number>>>;

function check(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function fixture(baseline: Baseline = {}) {
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

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('UI dependency checks', () => {
  it('reports the file, kind and line of each forbidden dependency', () => {
    const repo = fixture();
    const sources = {
      import: [
        "import { rows } from '../../backend/checks'",
        "export { colors } from '../../adapters/colors'",
        "import '../../shell/setup'",
        "export * from '../../desktop/features'",
        "import { app } from 'electron'",
        "export * from 'path'",
        "import type { Stats } from 'fs'",
        "type Event = import('node:events').EventEmitter",
        "const fs = import('fs/promises')",
      ],
      storage: ['localStorage.getItem(key)', 'indexedDB.open(key)', 'window.sessionStorage.length'],
      services: ['store.services.ai.phrase(point)', 'const { services: ports } = store', 'store?.services'],
      repo: ['ports.repo.audit(id)', 'ports.repo?.seen?.()'],
    };
    const expected: string[] = [];
    for (const [kind, snippets] of Object.entries(sources)) {
      for (const [index, source] of snippets.entries()) {
        const file = `src/ui/nested/${kind}-${index}.ts`;
        repo.write(file, `\n${source}`);
        expected.push(`${file} ${kind} (lines 2)`);
      }
    }
    const result = repo.run();
    expect(result.status).toBe(1);
    for (const diagnostic of expected) expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).toContain('"The frontend is a pane of glass" in CLAUDE.md');
  });

  it('ignores test files, comments and literal text and checks expressions in templates and JSX', () => {
    const repo = fixture();
    const examples = "import '../backend/table'; localStorage.getItem(key); store.services.repo.read()";
    const page = 'src/ui/view.tsx';
    const clean = [
      `/* ${examples} */`,
      `// ${examples}`,
      `const help = "${examples}"`,
      'const label = `store.services, indexedDB`',
      'const pattern = /localStorage/',
      'const title = <b>store.services.repo and localStorage</b>',
      'const choices = { services: true }',
    ].join('\n');
    repo.write('src/ui/view.test.tsx', examples);
    repo.write('src/ui/nested/view.test.ts', examples);
    repo.write(page, clean);
    expect(repo.run().status).toBe(0);
    repo.write(page, clean + '\nconst value = <b>{`${store.services}`}</b>');
    expect(repo.run().stderr).toContain(`${page} services (lines 8)`);
  });
});
