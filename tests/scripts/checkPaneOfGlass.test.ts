// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
        "const table = import(available ? './table' : '../../backend/table')",
        "const table = import((available ? '../../backend/' : './') + tableName)",
        "const table = import(`../../${available ? 'backend' : 'ui'}/table`)",
        "const table = import(optionalPath ?? '../../backend/table')",
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

  it('reports the direct dynamic import of a local string constant and allows the UI equivalent', () => {
    const repo = fixture();
    const file = 'src/ui/checklistReader.ts';
    repo.write('src/ui/checklist.mjs', "export const caption = 'Checklist'");
    const load = [
      "import { loadPath } from './src/ui/checklistReader.ts'",
      'const loaded = await loadPath()',
      "console.log(loaded === await import('node:path') ? 'node:path' : loaded.caption)",
    ].join('\n');
    for (const name of ['./checklist.mjs', 'node:path']) {
      const source = [`const moduleName = '${name}'`, 'export const loadPath = () => import(moduleName)'];
      repo.write(file, source.join('\n'));
      const args = ['--experimental-strip-types', '--input-type=module', '-e', load];
      const runtime = spawnSync(process.execPath, args, { cwd: repo.dir, encoding: 'utf8' });
      expect(runtime.status, runtime.stderr).toBe(0);
      const local = name === './checklist.mjs';
      expect(runtime.stdout.trim()).toBe(local ? 'Checklist' : 'node:path');
      const result = repo.run();
      expect(result.status, result.stderr).toBe(local ? 0 : 1);
      if (!local) expect(result.stderr).toContain(`${file} import (lines 2): 1 exceeds`);
    }
  });

  it('follows immutable aliases in their declaring scope and ignores runtime and type-only inputs', () => {
    const repo = fixture();
    const file = 'src/ui/modulePicker.ts';
    repo.write('src/ui/checklist.mjs', "export const caption = 'Checklist'");
    const source = [
      "type page = 'node:path' | './checklist.mjs'",
      "const page: page = 'node:path' as const",
      'const first = page',
      'const selected = (first satisfies string)',
      "export function open() { const page = './checklist.mjs'; return import(selected!) }",
      "export function local() { const page = './checklist.mjs'; return import(page) }",
      "export function supplied(page: 'node:path') { return import(page) }",
      "declare const fromState: 'node:path'",
      'export const runtime = () => import(fromState)',
      "const annotated = chooseModule() as 'node:path'",
      'export const dynamic = () => import(annotated)',
      "let changing = 'node:path'",
      "changing = './checklist.mjs'",
      'export const changed = () => import(changing)',
      'function recordClass(_target: object) {}',
      '@recordClass',
      'export class Picker { accessor label = "Checklist" }',
      "export function sameValue() { type page = './checklist.mjs'; return import(page) }",
      'declare function chooseModule(): string',
    ].join('\n');
    repo.write(file, source);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 5, 18): 2 exceeds`);
    repo.write(file, source.replace("const page: page = 'node:path'", "const page: page = './checklist.mjs'"));
    expect(repo.run().status).toBe(0);
  });

  it('resolves runtime constants across erased TypeScript namespaces', () => {
    const repo = fixture();
    const file = 'src/ui/page.ts';
    const compiler = path.resolve('node_modules/typescript/bin/tsc');
    repo.write('package.json', '{"type":"module"}');
    repo.write('build/checklist.mjs', "export const caption = 'Checklist'");
    const loader = [
      "import { load, Panel, Other } from './build/page.js'",
      "const builtIn = await import('node:path')",
      'const modules = await Promise.all([load(), Panel.load(), Other.load()])',
      "console.log(modules.map(page => page === builtIn ? 'node:path' : page.caption).join(','))",
    ].join('\n');
    for (const name of ['node:path', './checklist.mjs']) {
      const source = [
        `const page = '${name}'`,
        'namespace page { export type Caption = string }',
        'export const load = () => import(page)',
        'export namespace Panel {',
        '  namespace page { export namespace Meta { export interface Caption { text: string } } }',
        '  export const load = () => import(page)',
        '}',
        'export namespace Other {',
        "  namespace page { export function toString() { return './checklist.mjs' } }",
        '  export const load = () => import(page as unknown as string)',
        '}',
      ];
      repo.write(file, source.join('\n'));
      const args = [compiler, '--ignoreConfig', '--isolatedModules', '--target', 'ES2022', '--module', 'ESNext',
        '--moduleResolution', 'bundler', '--skipLibCheck', '--outDir', 'build', file];
      const cwd = repo.dir;
      const emit = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
      expect(emit.status, emit.stdout + emit.stderr).toBe(0);
      const run = spawnSync(process.execPath, ['--input-type=module', '-e', loader], { cwd, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      const local = name === './checklist.mjs';
      expect(run.stdout.trim()).toBe(local ? 'Checklist,Checklist,Checklist' : 'node:path,node:path,Checklist');
      const result = repo.run();
      expect(result.status, result.stderr).toBe(local ? 0 : 1);
      if (!local) expect(result.stderr).toContain(`${file} import (lines 3, 6): 2 exceeds`);
    }
  });

  it('checks computed member and destructuring keys and each read in a dotted JSX tag', () => {
    const repo = fixture();
    const file = 'src/ui/access.tsx';
    const lines = [
      "const model = store[('services' as const)].ai",
      "const saved = window[(('localStorage'))].getItem(key)",
      "const { [('services' satisfies string)]: ports } = store",
      "const { [(`indexedDB` as const)]: database } = window",
      "const audit = ports[('repo' as const)].audit",
      'const slot = <store.services />',
      'const view = <store.services.repo.View></store.services.repo.View>',
      'const value = <sessionStorage.Value />',
      'const id = <window.indexedDB.Id />',
      "const service = store[useModel ? 'services' : 'state']",
      "const title = store[('title' as const)]",
      'const label = <span title="store.services">localStorage</span>',
    ];
    repo.write(file, lines.join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} services (lines 1, 3, 6, 7, 10): 5 exceeds`);
    expect(result.stderr).toContain(`${file} storage (lines 2, 4, 8, 9): 4 exceeds`);
    expect(result.stderr).toContain(`${file} repo (lines 5, 7): 2 exceeds`);
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
      "const table = import(checked ? './table' : '../app/table')",
    ].join('\n');
    repo.write('src/ui/view.test.tsx', examples);
    repo.write('src/ui/nested/view.test.ts', examples);
    repo.write(page, clean);
    expect(repo.run().status).toBe(0);
    repo.write(page, clean + '\nconst value = <b>{`${store.services}`}</b>');
    expect(repo.run().stderr).toContain(`${page} services (lines 9)`);
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

  it('requires main to verify a committed increase in a shallow single-branch clone', () => {
    const repo = fixture({ [file]: { services: 1 } });
    repo.write(file, 'store.services.ai');
    git(repo.dir, 'init', '-q', '-b', 'main');
    git(repo.dir, 'add', 'src', baselineFile);
    git(repo.dir, 'commit', '-qm', 'Record existing UI');
    git(repo.dir, 'switch', '-qc', 'topic');
    repo.write(file, 'store.services.ai\nstore.services.ids');
    repo.setBaseline({ [file]: { services: 2 } });
    git(repo.dir, 'commit', '-qam', 'Raise the allowance with the source count');

    const clone = path.join(repo.dir, 'shallow');
    git(repo.dir, 'clone', '-q', '--depth=1', '--single-branch', pathToFileURL(repo.dir).href, clone);
    const fetch = ['fetch', '--unshallow', 'origin', '+refs/heads/main:refs/remotes/origin/main'];
    const missing = check(clone);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(['git', ...fetch].join(' '));

    git(clone, ...fetch);
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
    expect(result.stderr).toContain('git fetch origin +refs/heads/main:refs/remotes/origin/main');
  });

  it('passes the committed baseline on the repository sources', () => {
    const repo = fixture();
    cpSync('src/ui', path.join(repo.dir, 'src/ui'), { recursive: true });
    copyFileSync(baselineFile, path.join(repo.dir, baselineFile));
    const result = repo.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
