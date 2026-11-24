// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve('scripts/check-pane-of-glass.mjs');
const baselineFile = 'scripts/pane-of-glass-baseline.json';
const directories: string[] = [];
type Baseline = Record<string, Partial<Record<'import' | 'storage' | 'services' | 'repo', number>>>;

function git(dir: string, ...args: string[]) {
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com'];
  return execFileSync('git', [...identity, ...args], { cwd: dir, encoding: 'utf8' });
}

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
  it('runs the guard after readability in the static check', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'));
    const commands = scripts['check:static'].split(' && ');
    const readability = commands.indexOf('node scripts/check-readability.mjs');
    expect(readability).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('node scripts/check-pane-of-glass.mjs')).toBeGreaterThan(readability);
  });

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
        'const table = import(`../../backend/${tableName}.ts`)',
        "const table = import('../../backend/' + tableName)",
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

  it('resolves a relative layer name from the importing file', () => {
    const repo = fixture();
    repo.write('src/ui/components/shell.ts', 'export const title = "Settings"');
    repo.write('src/ui/components/topBar.ts', "export * from './shell'");
    expect(repo.run().status).toBe(0);
    repo.write('src/ui/page.ts', "import '../backend/x'");
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/ui/page.ts import (lines 1)');
    expect(result.stderr).not.toContain('topBar.ts');
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

describe('the remaining UI exceptions', () => {
  const file = 'src/ui/checklist.ts';
  const oldFile = 'src/ui/old.ts';

  it('lowers counts in sorted order and removes the entries for deleted files', () => {
    const repo = fixture({ [oldFile]: { storage: 2 }, [file]: { services: 2, repo: 1 } });
    repo.write(file, 'store.services.repo.list()');
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} services (lines 1): lower the baseline`);
    expect(result.stderr).toContain(`${oldFile} storage (no matching lines): lower the baseline`);
    expect(repo.run('--lower').status).toBe(0);
    const expected = { [file]: { repo: 1, services: 1 } };
    expect(repo.baselineText()).toBe(JSON.stringify(expected, null, 2) + '\n');
    expect(repo.run().status).toBe(0);
  });

  it('refuses to raise a count even when another entry could be lowered', () => {
    const repo = fixture({ [oldFile]: { storage: 1 }, [file]: { services: 1 } });
    repo.write(file, 'store.services.ai\nstore.services.ids');
    const before = repo.baselineText();
    for (const result of [repo.run(), repo.run('--lower')]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${file} services (lines 1, 2): 2 exceeds the baseline of 1`);
      expect(repo.baselineText()).toBe(before);
    }
  });

  it.each([true, false])('rejects a manual increase when main has a baseline (%s)', (hasBaseline) => {
    const repo = fixture({ [file]: { services: 1 } });
    repo.write(file, 'store.services.ai');
    git(repo.dir, 'init', '-q', '-b', 'main');
    git(repo.dir, 'add', 'src');
    if (hasBaseline) git(repo.dir, 'add', baselineFile);
    git(repo.dir, 'commit', '-qm', 'Record existing UI');
    repo.write(file, 'store.services.ai\nstore.services.ids');
    repo.setBaseline({ [file]: { services: 2 } });
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} services (lines 1, 2): the baseline cannot rise`);
    expect(result.stderr).toContain('above the committed count of 1');
  });

  it('compares local edits in a shallow single-branch clone with its committed allowance', () => {
    const repo = fixture({ [file]: { services: 1 } });
    repo.write(file, 'store.services.ai');
    git(repo.dir, 'init', '-q', '-b', 'topic');
    git(repo.dir, 'add', 'src', baselineFile);
    git(repo.dir, 'commit', '-qm', 'Record existing UI');
    const clone = path.join(repo.dir, 'shallow');
    git(repo.dir, 'clone', '-q', '--depth=1', '--single-branch', pathToFileURL(repo.dir).href, clone);
    expect(git(clone, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');
    expect(check(clone).status).toBe(0);
    writeFileSync(path.join(clone, file), 'store.services.ai\nstore.services.ids');
    writeFileSync(path.join(clone, baselineFile), JSON.stringify({ [file]: { services: 2 } }));
    const result = check(clone);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the baseline cannot rise above the committed count of 1');
  });

  it('names the missing reference when a repository has no committed baseline or main', () => {
    const repo = fixture();
    repo.write(file, 'export const title = "Checklist"');
    git(repo.dir, 'init', '-q', '-b', 'topic');
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Fetch origin/main');
  });

  it('passes the committed baseline on the repository sources', () => {
    const result = check(process.cwd());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
