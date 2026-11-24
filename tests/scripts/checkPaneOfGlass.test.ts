// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, createServer } from 'vite';
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

async function bundledSources(root: string, file: string) {
  const modules: string[] = [];
  await build({
    root, configFile: false, envDir: false, logLevel: 'silent',
    build: { write: false, lib: { entry: path.join(root, file), formats: ['es'] } },
    plugins: [{
      name: 'record-bundled-modules',
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === 'chunk') modules.push(...chunk.moduleIds);
        }
      },
    }],
  });
  return modules.map((id) => path.relative(root, id).split(path.sep).join('/'));
}

async function developmentSources(root: string, file: string) {
  const server = await createServer({
    root, configFile: false, envDir: false, logLevel: 'silent',
    server: { middlewareMode: true, watch: null, ws: false },
  });
  try {
    const client = server.environments.client;
    await client.transformRequest('/' + file);
    const entry = await client.moduleGraph.getModuleByUrl('/' + file);
    return [...entry!.importedModules].map((module) => path.relative(root, module.id!).split(path.sep).join('/'));
  } finally {
    await server.close();
  }
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

  it('checks eager and lazy Vite glob imports against the included files', () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    for (const layer of ['backend', 'adapters', 'desktop', 'shell', 'ui']) {
      repo.write(`src/${layer}/lenient.ts`, 'export const available = true');
    }
    repo.write('src/backend/.hidden.ts', 'export const hidden = true');
    repo.write(file, [
      "export const eager = import.meta.glob('../backend/lenient.ts', { eager: true })",
      "export const views = import.meta.glob('../{ui,adapters}/**/*.ts')",
      "export const shell = import.meta.glob(['/src/*/lenient.ts', '!/src/backend/**'])",
      "export const desktop = import.meta.glob('./lenient.ts', { base: '../desktop' })",
      "export const local = import.meta.glob('./*.ts')",
      "export const clean = import.meta.glob(['../{ui,backend}/*.ts', '!../backend/**'])",
      "export const missing = import.meta.glob('../backend/missing*.ts')",
      `export const quoted = "import.meta.glob('../backend/lenient.ts')"`,
      "export const other = index.glob('../backend/lenient.ts')",
      "export const caseFold = import.meta.glob('../backend/*.TS', { caseSensitive: false })",
      "export const visible = import.meta.glob(['../backend/*.ts', '!../backend/lenient.ts'])",
      "const hidden = import.meta.glob(['./*.ts', '!./lenient.ts'], { base: '/src/backend', exhaustive: true })",
    ].join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 1, 2, 3, 4, 10, 12): 6 exceeds`);
  });

  it('agrees with Vite on a UI-only glob whose base is asserted as const', async () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    repo.write('src/backend/lenient.ts', 'export const read = true');
    repo.write('src/ui/backend/lenient.ts', 'export const preview = true');
    const options = "{ eager: true, base: '/src/ui/nested' } as const";
    const local = `export const pages = import.meta.glob('../backend/lenient.ts', (${options}))`;
    repo.write(file, local);
    const sources = await bundledSources(repo.dir, file);
    expect(sources).toContain('src/ui/backend/lenient.ts');
    expect(sources).not.toContain('src/backend/lenient.ts');
    repo.write(file, [
      local,
      "const readers = import.meta.glob('./lenient.ts' as const, { base: ('../backend' as const) } as const)",
      "const patterns = import.meta.glob([('../backend/lenient.ts' as const)] satisfies string[])",
    ].join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 2, 3): 2 exceeds`);
  });

  it.each([
    { pattern: '../[!b]*/part.ts', selected: 'ui', status: 0 },
    { pattern: '../[!u]*/part.ts', selected: 'backend', status: 1 },
  ])('agrees with Vite on the negated character class in $pattern', async ({ pattern, selected, status }) => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    repo.write('src/ui/part.ts', "export const title = 'Checklist'");
    repo.write('src/backend/part.ts', "export const title = 'Folder reader'");
    repo.write(file, `export const parts = import.meta.glob('${pattern}', { eager: true })`);
    const sources = await bundledSources(repo.dir, file);
    expect(sources.filter((id) => id.endsWith('/part.ts'))).toEqual([`src/${selected}/part.ts`]);
    const result = repo.run();
    expect(result.status).toBe(status);
    if (status) expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
  });

  it.each([
    { patterns: "'../backend/{lenient}.ts'", buildImportsBackend: true },
    { patterns: "['./header.ts', '../backend/{lenient}.ts']", buildImportsBackend: true },
    { patterns: "'./{header}.ts'", buildImportsBackend: false },
    { patterns: "'../backend/[[:alpha:]]*.ts'", buildImportsBackend: false, devImportsBackend: true },
    { patterns: "'../BACKEND/*.ts'", buildImportsBackend: false },
  ])('checks the files that either Vite mode imports for $patterns', async (example) => {
    const { patterns, buildImportsBackend, devImportsBackend = false } = example;
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const backend = 'src/backend/lenient.ts';
    repo.write(backend, 'export const read = true');
    repo.write('src/ui/header.ts', 'export const title = "Checklist"');
    const foldCase = patterns.includes('BACKEND');
    const options = JSON.stringify({ eager: true, caseSensitive: !foldCase });
    repo.write(file, `export const readers = import.meta.glob(${patterns}, ${options})`);
    const dev = await developmentSources(repo.dir, file);
    const prod = await bundledSources(repo.dir, file);
    const caseAlias = foldCase && existsSync(path.join(repo.dir, 'src/BACKEND/lenient.ts'));
    const devImports = dev.some((id) => id.toLowerCase() === backend);
    const prodImports = prod.some((id) => id.toLowerCase() === backend);
    if (!caseAlias) {
      expect(devImports).toBe(devImportsBackend);
      expect(prodImports).toBe(buildImportsBackend);
    }
    const forbidden = devImports || prodImports;
    const result = repo.run();
    expect(result.status).toBe(forbidden ? 1 : 0);
    if (forbidden) expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
  });

  it('allows glob keys that both modes enumerate without importing a module', async () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const backend = 'src/backend/lenient.ts';
    repo.write(backend, 'export const read = true');
    repo.write(file, "export const names = Object.keys(import.meta.glob('../backend/*.ts'))");
    expect(await developmentSources(repo.dir, file)).not.toContain(backend);
    expect(await bundledSources(repo.dir, file)).not.toContain(backend);
    expect(repo.run().status).toBe(0);
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

  it('uses committed filenames to check the original ceiling for a glob import', () => {
    const repo = fixture();
    repo.write('vite.config.mjs', "throw new Error('The guard loaded the application config')");
    repo.write(file, "export const readers = import.meta.glob('../backend/{part}.ts')");
    git(repo.dir, 'init', '-q', '-b', 'main');
    git(repo.dir, 'add', 'src');
    git(repo.dir, 'commit', '-qm', 'Record the original files');
    repo.write('src/backend/part.ts', 'export const read = true');
    repo.setBaseline({ [file]: { import: 1 } });
    const result = repo.run();
    expect(result.status).toBe(1);
    const diagnostic = `${file} import (lines 1): the baseline cannot rise above the committed count of 0`;
    expect(result.stderr).toContain(diagnostic);
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
    cpSync('src', path.join(repo.dir, 'src'), { recursive: true });
    copyFileSync(baselineFile, path.join(repo.dir, baselineFile));
    const result = repo.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
