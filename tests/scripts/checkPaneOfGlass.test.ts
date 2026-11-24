// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeModuleCases, runtimeMutationSource } from './paneOfGlassRuntimeFixtures';

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

  it('checks fixed local import paths in their declaring scope', () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    repo.write(file, [
      "const moduleName = 'node:path'",
      'export const loadPath = () => import(moduleName)',
      "const directory = '../backend/'",
      "const reader = `${directory}lenient.ts` as const",
      "export function load() { const directory = './'; return import(reader) }",
      "export function local() { const moduleName = './table'; return import(moduleName) }",
      'export const supplied = (moduleName: string) => import(moduleName)',
      "export const late = () => import(adapter)",
      "const adapter = useShared ? '../adapters/shared' : './local'",
      "const help = 'node:fs'",
      "let changing = './table'",
      'changing = suppliedName',
      'export const open = () => import(changing)',
      "const first = second + ''",
      'const second = first',
      'export const loop = () => import(first)',
    ].join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 2, 5, 8): 3 exceeds`);
  });

  it('resolves value bindings when a type shares the name and when literals are destructured', () => {
    const repo = fixture();
    const file = 'src/ui/modules.ts';
    repo.write(file, [
      "type ModuleName = 'node:path'",
      "const ModuleName: ModuleName = 'node:path'",
      'export const builtIn = () => import(ModuleName)',
      '',
      "const { entry } = { entry: 'node:path' } as const",
      'export const fromObject = () => import(entry)',
      "const { ports: [reader] } = { ports: ['../backend/lenient'] }",
      'export const nested = () => import(reader)',
      "const { log: local } = { log: './table' }",
      'export const page = () => import(local)',
      'function child() {',
      "  const ModuleName = './table'",
      '  return import(ModuleName)',
      '}',
      'function supplied({ entry }: { entry: string }) { return import(entry) }',
      "const { target } = { target: 'node:fs', ...runtimeOptions }",
      'export const unknown = () => import(target)',
      "const { plugin: source } = { ...runtimeOptions, plugin: 'node:fs' }",
      'export const overridden = () => import(source)',
      "const { route = '../backend/lenient' } = {}",
      'export const withDefault = () => import(route)',
      'interface PageName { url: string }',
      "const PageName = './table'",
      'export const localPage = () => import(PageName)',
    ].join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 3, 6, 8, 19, 21): 5 exceeds`);
  });

  it('follows named literal containers and applies defaults only to missing or undefined values', () => {
    const repo = fixture();
    const file = 'src/ui/modulePaths.ts';
    const source = [
      "const paths = { entry: 'node:path' } as const",
      'const { entry } = paths',
      'export const loadConfiguredPath = () => import(entry)',
      '',
      "const { fallback = 'node:path' } = { fallback: undefined }",
      'export const loadDefaultPath = () => import(fallback)',
      "const modules = ['node:path'] as const",
      'const alias = modules',
      'const [fromArray] = alias',
      'export const loadArrayPath = () => import(fromArray)',
    ].join('\n');
    repo.write(file, source);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 3, 6, 10): 3 exceeds`);

    repo.write(file, [
      source.replaceAll('node:path', './table'),
      'function supplied(undefined: string) {',
      "  const { target = 'node:path' } = { target: undefined }",
      '  return import(target)',
      '}',
      "const changing = { target: 'node:path' }",
      "Object.assign(changing, { target: './table' })",
      'const { target } = changing',
      'export const changed = () => import(target)',
      'const cycle = other',
      'const other = cycle',
      'const { unknown } = cycle',
      'export const unresolved = () => import(unknown)',
    ].join('\n'));
    expect(repo.run().status).toBe(0);
  });

  it('keeps a captured import path when the UI reads a sibling property', () => {
    const repo = fixture();
    const file = 'src/ui/checklistReader.ts';
    repo.write('src/ui/checklist.ts', "export const title = 'Checklist'");
    repo.write('src/ui/findings.ts', "export const title = 'Open findings'");
    const source = [
      "const paths = { entry: 'node:path', title: 'Checklist' } as const",
      'const { entry } = paths',
      'export const load = () => import(entry)',
      'export const title = paths.title',
      "const headings = ['../backend/lenient', 'Open findings'] as const",
      'export const heading = headings[1]',
      'const [reader] = headings',
      'export const open = () => import(reader)',
      "const details = { module: 'node:path', heading: currentHeading() }",
      'export const label = details.heading',
      'const detailPages = details',
      'const { module: page } = detailPages',
      'export const show = () => import(page)',
      'export const direct = () => import(paths.entry)',
    ].join('\n');
    repo.write(file, source);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 3, 8, 13, 14): 4 exceeds`);

    repo.write(file, [
      source.replaceAll('node:path', './checklist').replace('../backend/lenient', './findings'),
      "const editable = { entry: 'node:path', title: 'Checklist' }",
      'const editableAlias = editable',
      "editable.entry = './checklist'",
      'const { entry: changed } = editableAlias',
      'export const changedPage = () => import(changed)',
      "const shared = { page: 'node:path', caption: 'Checklist' }",
      'const writer = shared',
      'const pageReader = shared',
      "writer.page = './checklist'",
      'const { page: currentPage } = pageReader',
      'export const current = () => import(currentPage)',
      "function supplied(page: 'node:path') { return import(page) }",
      "const annotated = runtimePage as 'node:path'",
      'export const fromState = () => import(annotated)',
    ].join('\n'));
    expect(repo.run().status).toBe(0);
  });

  it('uses the runtime branch and inherited property before applying a default import', () => {
    const repo = fixture();
    const file = 'src/ui/checklistPages.ts';
    const source = [
      'const useChecklist = true',
      "const page = useChecklist ? './checklist' : 'node:path'",
      'export const load = () => import(page)',
      "const defaultPage = './checklist' || 'node:path'",
      'export const open = () => import(defaultPage)',
      "const { reader = 'node:path' } = { __proto__: { reader: './checklist' } }",
      'export const show = () => import(reader)',
    ].join('\n');
    repo.write(file, source);
    expect(repo.run().status).toBe(0);
    repo.write(file, source.replaceAll('./checklist', '../backend/lenient'));
    expect(repo.run().stderr).toContain(`${file} import (lines 3, 5, 7): 3 exceeds`);
  });

  it('checks the primitive captured before a later write or sibling destructuring', () => {
    const repo = fixture();
    const file = 'src/ui/checklistEntry.ts';
    const source = [
      "const caption = () => 'Checklist'",
      "const manifest = { target: 'node:path', label: caption() }",
      'const { label } = manifest',
      'const { target } = manifest',
      "manifest.target = './checklist.mjs'",
      'export const load = () => import(target)',
      "const paths = { target: 'node:path', caption: caption() }",
      "paths.caption = 'Open findings'",
      'const before = paths.target',
      'updatePaths(paths)',
      'export const open = () => import(before)',
      "const panel = { entry: 'node:path' }",
      'const { entry } = panel',
      "function change() { panel.entry = './checklist.mjs' }",
      'change()',
      'export const original = () => import(entry)',
    ].join('\n');
    repo.write('src/ui/checklist.mjs', "export const title = 'Checklist'");
    repo.write(file, source);
    expect(repo.run().stderr).toContain(`${file} import (lines 6, 11, 16): 3 exceeds`);
    repo.write(file, [
      source.replaceAll('node:path', './checklist.mjs'),
      "const current = { target: 'node:path' }",
      'function pick() { return current.target }',
      "current.target = './checklist.mjs'",
      'const { target: afterWrite } = current',
      'export const after = () => import(afterWrite)',
      'export const deferred = () => import(pick())',
    ].join('\n'));
    expect(repo.run().status).toBe(0);
  });

  it('resolves fixed keys, rest bindings and spreads from the values present at a lookup', () => {
    const repo = fixture();
    const file = 'src/ui/readerEntries.ts';
    const source = [
      "const key = 'target'",
      "const { [key]: byName } = { target: 'node:path' }",
      'export const computed = () => import(byName)',
      "const { heading, ...rest } = { heading: 'Checklist', target: 'node:path' }",
      'export const remainder = () => import(rest.target)',
      "const localPages = ['./checklist.mjs']",
      "const [, second] = [...localPages, 'node:path']",
      'export const spread = () => import(second)',
      "const [, ...tail] = [...localPages, 'node:path']",
      'export const arrayTail = () => import(tail[0])',
      "const registry = { [key]: 'node:path' }",
      'export const member = () => import(registry[key])',
      "const prefix = 'tar'",
      "const { [`${prefix}get`]: fromTemplate } = { ['tar' + 'get']: 'node:path' }",
      'export const templated = () => import(fromTemplate)',
    ].join('\n');
    repo.write('src/ui/checklist.mjs', "export const title = 'Checklist'");
    repo.write(file, source);
    expect(repo.run().stderr).toContain(`${file} import (lines 3, 5, 8, 10, 12, 15): 6 exceeds`);
    repo.write(file, [
      source.replaceAll('node:path', './checklist.mjs'),
      "const { [key]: removed, ...remaining } = { target: 'node:path', page: './checklist.mjs' }",
      "export const local = () => import(remaining.target ?? './checklist.mjs')",
      "const [, unknown] = [...getRuntimePages(), 'node:path']",
      'export const selected = () => import(unknown)',
    ].join('\n'));
    expect(repo.run().status).toBe(0);
  });

  it('selects fixed conditional and logical branches inside an import template', () => {
    const repo = fixture();
    const file = 'src/ui/checklistEntry.ts';
    const source = [
      'const local = true',
      "const page = `${local ? './' : 'node:'}checklist.mjs`",
      'export const load = () => import(page)',
      "const base = './'",
      "export const open = () => import((base || 'node:') + 'checklist.mjs')",
    ].join('\n');
    repo.write('src/ui/checklist.mjs', "export const title = 'Checklist'");
    repo.write(file, source);
    expect(repo.run().status).toBe(0);
    repo.write(file, source.replace('= true', '= false').replace("base = './'", "base = ''"));
    expect(repo.run().stderr).toContain(`${file} import (lines 3, 5): 2 exceeds`);
  });

  it.each(runtimeModuleCases)('agrees with the runtime module for %s', (_name, setup) => {
    const repo = fixture();
    const file = 'src/ui/checklistEntry.ts';
    repo.write('src/ui/checklist.mjs', "export const caption = 'Checklist'");
    const runLoader = [
      "import { load } from './src/ui/fixture.mts'",
      'const loaded = await load()',
      "console.log(loaded === await import('node:path') ? 'node:path' : loaded.caption)",
    ].join('\n');
    for (const chosen of ['node:path', './checklist.mjs']) {
      const forbidden = chosen === 'node:path';
      const lines = [...setup, 'export const load = () => import(target)'];
      const other = forbidden ? './checklist.mjs' : 'node:path';
      const source = lines.join('\n').replaceAll('CHOSEN', chosen).replaceAll('OTHER', other);
      repo.write(file, source);
      repo.write('src/ui/fixture.mts', source);
      const args = ['--experimental-strip-types', '--input-type=module', '-e', runLoader];
      const runtime = spawnSync(process.execPath, args, { cwd: repo.dir, encoding: 'utf8' });
      expect(runtime.status, runtime.stderr).toBe(0);
      expect(runtime.stdout.trim()).toBe(forbidden ? 'node:path' : 'Checklist');
      const result = repo.run();
      expect(result.status, result.stderr).toBe(forbidden ? 1 : 0);
      if (forbidden) expect(result.stderr).toContain(`${file} import (lines ${lines.length}): 1 exceeds`);
    }
  });

  it('leaves paths selected by a getter or runtime resize to the application', () => {
    const repo = fixture();
    repo.write('src/ui/checklist.mjs', "export const caption = 'Checklist'");
    repo.write('src/ui/checklistEntry.ts', runtimeMutationSource);
    repo.write('src/ui/fixture.mjs', runtimeMutationSource);
    const loader = [
      "import { open } from './src/ui/fixture.mjs'",
      "console.log((await open()).map(page => page.caption).join(','))",
    ].join('\n');
    const args = ['--input-type=module', '-e', loader];
    const runtime = spawnSync(process.execPath, args, { cwd: repo.dir, encoding: 'utf8' });
    expect(runtime.status, runtime.stderr).toBe(0);
    expect(runtime.stdout.trim()).toBe('Checklist,Checklist');
    const result = repo.run();
    expect(result.status, result.stderr).toBe(0);
  });

  it('resolves imports in TypeScript classes with decorators and auto-accessors', () => {
    const repo = fixture();
    const file = 'src/ui/picker.ts';
    const screen = [
      'function recordClass(_target: object) {}',
      '@recordClass',
      'export class Picker { accessor label = "Checklist"; }',
      "const page = './hooks'",
      'export const load = () => import(page)',
    ].join('\n');
    repo.write(file, screen);
    expect(repo.run().status).toBe(0);
    repo.write(file, screen.replace('./hooks', '../backend/lenient'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 5): 1 exceeds`);
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
