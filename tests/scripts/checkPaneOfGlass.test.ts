// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
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

function fixture(baseline: Baseline = {}, prefix = 'pane-of-glass-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
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

async function viteSources(root: string, file: string) {
  const config = { root, configFile: false, envDir: false, logLevel: 'silent' } as const;
  const dev: string[] = [];
  const prod: string[] = [];
  const originalMode = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'development';
    const server = await createServer({ ...config, server: { middlewareMode: true, watch: null, ws: false } });
    try {
      const client = server.environments.client;
      await client.transformRequest('/' + file);
      const entry = await client.moduleGraph.getModuleByUrl('/' + file);
      for (const module of entry!.importedModules) dev.push(module.id!);
    } finally {
      await server.close();
    }
    process.env.NODE_ENV = 'production';
    await build({
      ...config, build: { write: false, lib: { entry: path.join(root, file), formats: ['es'] } },
      plugins: [{
        name: 'record-bundled-modules',
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) if (chunk.type === 'chunk') prod.push(...chunk.moduleIds);
        },
      }],
    });
  } finally {
    if (originalMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalMode;
  }
  const names = (ids: string[]) => ids.map((id) => path.relative(root, id).split(path.sep).join('/'))
    .filter((id) => id.startsWith('src/') && id !== file).map((id) => id.toLowerCase()).sort();
  return { dev: names(dev), prod: names(prod) };
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

  const backend = 'src/backend/part.ts';
  const ui = 'src/ui/part.ts';
  const header = 'src/ui/header.ts';
  const nested = 'src/ui/backend/part.ts';
  const folded = "'../BACKEND/*.ts', { eager: true, caseSensitive: false }";
  it.each([
    { args: "'../[!b]*/part.ts', { eager: true }", dev: [ui], prod: [ui] },
    { args: "'../[!u]*/part.ts', { eager: true }", dev: [backend], prod: [backend] },
    { args: "'../backend/{part}.ts', { eager: true }", dev: [], prod: [backend] },
    { args: "['./header.ts', '../backend/{part}.ts']", dev: [header], prod: [backend, header] },
    { args: "'./{header}.ts'", dev: [], prod: [header] },
    { args: "'../backend/[[:alpha:]]*.ts'", dev: [backend], prod: [] },
    { args: folded, dev: [], prod: [] },
    { args: folded, brackets: true, dev: [], prod: [] },
    { args: "['/src/{backend,ui}/part.ts', '!/src/backend/**']", brackets: true, dev: [ui], prod: [ui] },
    { args: "'../backend/part.ts', ({ base: '/src/ui/nested' } as const)", dev: [nested], prod: [nested] },
    { args: "'./part.ts' as const, { base: ('../backend' as const) } as const", dev: [backend], prod: [backend] },
    { args: "[('../backend/part.ts' as const)] satisfies string[]", dev: [backend], prod: [backend] },
    { args: "'../backend/*.ts'", wrapper: 'Object.keys', dev: [], prod: [] },
    { args: "'../backend/part.ts'", wrapper: '(Object.keys)', dev: [], prod: [] },
    { args: "'../backend/part.ts'", wrapper: '(Object.keys as typeof Object.keys)', dev: [], prod: [] },
    { args: "'../backend/part.ts'", wrapper: '(Object).keys', dev: [], prod: [] },
    { args: "'../backend/part.ts'", wrapper: '(Object as typeof Object).keys', dev: [], prod: [] },
    { args: "'../backend/part.ts'", wrapper: 'Object["keys"]', dev: [backend], prod: [backend] },
    { args: "'../backend/part.ts'", wrapper: 'Object.keys?.', dev: [backend], prod: [backend] },
    { args: "'../backend/[[:alpha:]]*.ts'", wrapper: 'globalThis.Object.keys', dev: [], prod: [] },
    { args: "'../backend/part.ts'", wrapper: '(Object.values)', dev: [backend], prod: [backend] },
    { args: "['preact', '../backend/part.ts']", dev: [backend], prod: [backend] },
    { args: "['preact', './part.ts']", dev: [ui], prod: [ui] },
    { args: "['preact', '../BACKEND/*.ts'], { caseSensitive: false }", dev: [backend], prod: [backend] },
  ])('checks what Vite actually imports for $args', async ({ args, wrapper, brackets, dev, prod }) => {
    const repo = brackets ? fixture({}, 'pane-of-glass [fixture]-') : fixture();
    const file = 'src/ui/readers.ts';
    for (const id of [backend, ui, header, nested]) repo.write(id, `export const source = '${id}'`);
    repo.write('node_modules/preact/package.json', JSON.stringify({ name: 'preact', main: 'index.js' }));
    repo.write('node_modules/preact/index.js', 'export const version = 1');
    const call = `import.meta.glob(${args})`;
    repo.write(file, `export const readers = ${wrapper ? `${wrapper}(${call})` : call}`);
    const selected = await viteSources(repo.dir, file);
    if (args !== folded || (!brackets && !existsSync(path.join(repo.dir, 'src/BACKEND/part.ts')))) {
      expect(selected).toEqual({ dev, prod });
    }
    const forbidden = selected.dev.includes(backend) || selected.prod.includes(backend);
    const result = repo.run();
    expect(result.status).toBe(forbidden ? 1 : 0);
    if (forbidden) expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
  });

  const termGlob = "import.meta.glob('../backend/part.ts', { eager: true })";
  it.each([
    { expression: `Object.keys(${termGlob}['../backend/part.ts'])`, dev: [], prod: [backend] },
    { expression: `Object.keys(${termGlob} || {})`, dev: [], prod: [backend] },
    { expression: "Object.keys(import.meta.glob('../backend/[[:alpha:]]*.ts') || {})", dev: [], prod: [] },
    { expression: "(import.meta.glob)('../backend/part.ts')", dev: [backend], prod: [backend] },
    { expression: "(import.meta.glob<{term: string}>)('../backend/part.ts')", dev: [backend], prod: [backend] },
    { expression: "import.meta.glob?.('../backend/part.ts') ?? {}", dev: [], prod: [] },
    { expression: "import.meta.env.DEV ? import.meta.glob('../backend/{part}.ts') : {}", dev: [], prod: [] },
    { expression: "import.meta.env.PROD ? import.meta.glob('../backend/{part}.ts') : {}", dev: [], prod: [backend] },
  ])('retains the original expression $expression', async ({ expression, dev, prod }) => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    repo.write(backend, 'export const term = true');
    repo.write(file, `export const readers = ${expression}`);
    expect(await viteSources(repo.dir, file)).toEqual({ dev, prod });
    const forbidden = [...dev, ...prod].includes(backend);
    const result = repo.run();
    expect(result.status).toBe(forbidden ? 1 : 0);
    if (forbidden) expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
  });

  it.each(['ui', 'backend'])('retains yield in a generator condition around a %s glob', async (layer) => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const target = `src/${layer}/term.ts`;
    repo.write(target, 'export const term = true');
    const glob = `import.meta.glob('../${layer}/term.ts')`;
    repo.write(file, `export function* steps() { return (yield 'Checklist') ? ${glob} : {} }`);
    expect(await viteSources(repo.dir, file)).toEqual({ dev: [target], prod: [target] });
    const result = repo.run();
    expect(result.status).toBe(layer === 'backend' ? 1 : 0);
    if (layer === 'backend') expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
  });

  it('keeps a glob assignable to a private field when checking a class method', async () => {
    const repo = fixture();
    const file = 'src/ui/reader.ts';
    repo.write(backend, 'export const term = true');
    repo.write(file, [
      'export class Reader {',
      '  #tables = {}',
      "  refresh() { this.#tables = import.meta.glob('../backend/part.ts') }",
      '}',
    ].join('\n'));
    expect(await viteSources(repo.dir, file)).toEqual({ dev: [backend], prod: [backend] });
    expect(repo.run().stderr).toContain(`${file} import (lines 3): 1 exceeds`);
  });

  it('neutralizes unrelated glob options in the same expression', () => {
    const repo = fixture();
    repo.write('src/ui/part.ts', 'export const title = "Checklist"');
    repo.write('src/ui/readers.ts', [
      "export const calls = choose(import.meta.glob('./part.ts'),",
      "  import.meta.glob('./part.ts', { eager: (() => { throw Error('option executed') })() }))",
    ].join('\n'));
    const result = repo.run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('preserves the arity of an asserted keys call in each Vite mode', async () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const target = 'src/backend/part.ts';
    repo.write(target, 'export const read = true');
    repo.write(file, [
      'type Keys = (entry: object, ...rest: unknown[]) => string[]',
      "export const names = (Object.keys as Keys)(import.meta.glob('../backend/part.ts'), true)",
    ].join('\n'));
    expect(await viteSources(repo.dir, file)).toEqual({ dev: [], prod: [target] });
    expect(repo.run().stderr).toContain(`${file} import (lines 2): 1 exceeds`);
  });

  it.each(['ui', 'backend'])('uses the full filename for a %s module containing #', async (layer) => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const target = `src/${layer}/visible#dark.ts`;
    repo.write(target, 'export const title = "Checklist"');
    repo.write(file, `export const readers = import.meta.glob('../${layer}/visible#dark.ts')`);
    expect(await viteSources(repo.dir, file)).toEqual({ dev: [target], prod: [target] });
    const result = repo.run();
    expect(result.status).toBe(layer === 'backend' ? 1 : 0);
    if (layer === 'backend') expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
  });

  it('recognizes the resolved filename when Vite adds the requested query', async () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const target = 'src/backend/visible.ts';
    repo.write(target, 'export const title = "Checklist"');
    repo.write(file, "export const readers = import.meta.glob('../backend/visible.ts', { query: '?raw' })");
    const selected = await viteSources(repo.dir, file);
    expect(selected).toEqual({ dev: [target + '?raw'], prod: [target + '?raw'] });
    const result = repo.run();
    expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
  });

  it.each([['ui', 'ui'], ['ui', 'backend'], ['backend', 'ui']])(
    'follows file and directory aliases from %s to %s', async (alias, layer) => {
      const repo = fixture();
      const file = 'src/ui/readers.ts';
      const target = `src/${layer}/tables/lenient.ts`;
      repo.write(target, 'export const read = true');
      mkdirSync(path.join(repo.dir, 'src', alias), { recursive: true });
      symlinkSync(`../${layer}/tables/lenient.ts`, path.join(repo.dir, 'src', alias, 'read.ts'), 'file');
      symlinkSync(`../${layer}/tables`, path.join(repo.dir, 'src', alias, 'readers'), 'dir');
      repo.write(file, [
        `export const table = import.meta.glob('../${alias}/read.ts')`,
        `export const tables = import.meta.glob('../${alias}/readers/*.ts')`,
      ].join('\n'));
      expect(await viteSources(repo.dir, file)).toEqual({ dev: [target], prod: [target] });
      const result = repo.run();
      expect(result.status).toBe(layer === 'backend' ? 1 : 0);
      if (layer === 'backend') expect(result.stderr).toContain(`${file} import (lines 1, 2): 2 exceeds`);
    });

  it.each(['ui', 'backend'])('resolves a project-root alias to %s in an exported or Git checkout', async (layer) => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const target = `src/${layer}/term.ts`;
    repo.write(target, 'export const term = true');
    repo.write(file, "export const terms = import.meta.glob('/tables/*.ts')");
    symlinkSync(`src/${layer}`, path.join(repo.dir, 'tables'), 'dir');
    const selected = await viteSources(repo.dir, file);
    expect(selected.dev).toContain(target);
    expect(selected.prod).toContain(target);
    for (const gitCheckout of [false, true]) {
      if (gitCheckout) {
        git(repo.dir, 'init', '-q', '-b', 'main');
        git(repo.dir, 'add', 'src');
        git(repo.dir, 'commit', '-qm', 'Record the original sources');
      }
      const result = repo.run();
      expect(result.status).toBe(layer === 'backend' ? 1 : 0);
      if (layer === 'backend') expect(result.stderr).toContain(`${file} import (lines 1): 1 exceeds`);
    }
    git(repo.dir, 'add', 'tables');
    git(repo.dir, 'commit', '-qm', 'Record the table alias');
    if (layer === 'backend') repo.setBaseline({ [file]: { import: 1 } });
    expect(repo.run().status).toBe(0);
  });

  it('leaves private and out-of-repository directory links outside the filename snapshot', () => {
    const repo = fixture();
    const outside = fixture();
    outside.write('src/backend/term.ts', 'throw Error("outside module")');
    repo.write('src/backend/term.ts', 'export const term = true');
    mkdirSync(path.join(repo.dir, '.config'));
    symlinkSync('../src/backend', path.join(repo.dir, '.config/tables'), 'dir');
    symlinkSync(path.join(outside.dir, 'src/backend'), path.join(repo.dir, 'outside'), 'dir');
    repo.write('src/ui/readers.ts', "const readers = import.meta.glob(['/.config/tables/*.ts', '/outside/*.ts'])");
    const result = repo.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('defers the whole call when any option needs expression evaluation', () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    repo.write('src/backend/part.ts', 'export const read = true');
    repo.write(file, [
      "const spread = import.meta.glob('./part.ts', { base: '../backend', ...other })",
      "const joined = import.meta.glob('../backend/part.ts', { base: '../' + 'ui' })",
      "const lookup = import.meta.glob('../backend/part.ts', { base: { checklist: '../ui' }.checklist })",
      "const simple = import.meta.glob('../backend/part.ts', { query: { raw: true }, eager: true })",
    ].join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import (lines 4): 1 exceeds`);
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

  it('keeps the committed ceiling for an import through an internal symlink chain', () => {
    const repo = fixture({ [file]: { import: 1 } });
    repo.write(file, "export const tables = import.meta.glob('./read.ts')");
    repo.write('src/backend/table.ts', 'export const read = true');
    repo.write('src/ui/view.ts', 'export const title = "Checklist"');
    mkdirSync(path.join(repo.dir, 'tables'));
    symlinkSync('../src/backend/table.ts', path.join(repo.dir, 'tables/read.ts'), 'file');
    const alias = path.join(repo.dir, 'src/ui/read.ts');
    symlinkSync('../../tables/read.ts', alias, 'file');
    git(repo.dir, 'init', '-q', '-b', 'main');
    git(repo.dir, 'add', 'src', 'tables');
    git(repo.dir, 'commit', '-qm', 'Record a linked table');
    expect(repo.run().status).toBe(0);
    rmSync(alias);
    symlinkSync('./view.ts', alias, 'file');
    expect(repo.run('--lower').status).toBe(0);
    expect(repo.baselineText()).toBe('{}\n');
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
