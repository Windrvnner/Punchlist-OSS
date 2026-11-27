// @vitest-environment node
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error the script is plain JavaScript
import { slashPath } from '../../scripts/pane-of-glass-matches.mjs';

const script = path.resolve('scripts/check-pane-of-glass.mjs');
const baselineFile = 'scripts/pane-of-glass-baseline.json';
const directories: string[] = [];
type Entry = { file: string; kind: string; line: string; count: number; issue?: number; decision?: string };

function check(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

const listed = (file: string, kind: string, line: string, count = 1): Entry =>
  ({ file, kind, line, count, issue: 7 });

function fixture(allowance: Entry[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pane-of-glass-'));
  directories.push(dir);
  function write(file: string, source: string) {
    const destination = path.join(dir, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  const setAllowance = (entries: Entry[]) => write(baselineFile, JSON.stringify(entries));
  setAllowance(allowance);
  write('scripts/verified-decisions.json', '[]');
  write('docs/decisions.md', '- A decision.\n');
  const baselineText = () => readFileSync(path.join(dir, baselineFile), 'utf8');
  return { dir, write, setAllowance, baselineText, run: (...args: string[]) => check(dir, ...args) };
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
      storage: [
        'localStorage.getItem(key)', 'indexedDB.open(key)', 'window.sessionStorage.length',
        'document.cookie = `draft=${text}`', "caches.open('drafts')",
      ],
      network: [
        "fetch('https://api.example.com/v1/messages', { method: 'POST' })", 'window.fetch(url)',
        'new XMLHttpRequest()', 'new WebSocket(url)', 'new EventSource(url)', 'navigator.sendBeacon(url, body)',
      ],
      services: ['store.services.ai.phrase(point)', 'const { services: ports } = store', 'store?.services'],
      repo: ['ports.repo.audit(id)', 'ports.repo?.seen?.()'],
    };
    const expected: string[] = [];
    for (const [kind, snippets] of Object.entries(sources)) {
      for (const [index, source] of snippets.entries()) {
        const file = `src/ui/nested/${kind}-${index}.ts`;
        repo.write(file, `\n${source}`);
        expected.push(`${file} ${kind} "${source}"`);
      }
    }
    const result = repo.run();
    expect(result.status).toBe(1);
    for (const diagnostic of expected) expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).toContain('"The frontend is a pane of glass" in CLAUDE.md');
  });

  // Decision: a UI module names what it loads with a plain string and reads import.meta only as import.meta.env
  // (#848). A path the check would have to work out is refused even when it names a UI module.
  it.each(['./checklist.mjs', 'node:path'])('refuses a dynamic import of a path held in a constant (%s)', (name) => {
    const repo = fixture();
    const file = 'src/ui/checklistReader.ts';
    repo.write(file, [`const moduleName = '${name}'`, 'export const loadPath = () => import(moduleName)'].join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} import "export const loadPath = () => import(moduleName)": 1 not listed`);
  });

  it('refuses every computed module path and every import.meta read but env', () => {
    const repo = fixture();
    const file = 'src/ui/readers.ts';
    const lines = [
      "const paths = { reader: '../backend/reader' }",
      'export const fromObject = () => import(paths.reader)',
      'const { reader } = paths',
      'export const destructured = () => import(reader)',
      "export const either = (local: boolean) => import(local ? './reader' : './other')",
      'export const built = (name: string) => import(`./${name}`)',
      "export const joined = (name: string) => import('./' + name)",
      'export const required = (name: string) => require(name)',
      "export const globbed = import.meta.glob('../backend/*.ts')",
      "export const bracketed = import.meta['glob']('../backend/*.ts')",
      'const meta = import.meta',
      'export const env = import.meta.env.DEV',
      "export const viaCall = require.call(null, '../backend/reader')",
      "export const wrapped = (require as (name: string) => unknown)('../backend/reader')",
      "export const fromModule = module.require('../backend/reader')",
      "export const created = createRequire('/app')('../backend/reader')",
      'export const parenthesized = (import.meta).env.MODE',
    ];
    repo.write(file, lines.join('\n'));
    const result = repo.run();
    expect(result.status).toBe(1);
    const flagged = [2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16];
    for (const number of flagged) expect(result.stderr).toContain(`import "${lines[number - 1]}": 1 not listed`);
    for (const number of [1, 3, 12]) expect(result.stderr).not.toContain(`import "${lines[number - 1]}"`);
  });

  it('allows modules named with a plain string', () => {
    const repo = fixture();
    repo.write('src/ui/reader.ts', 'export const caption = "Checklist"');
    repo.write('src/ui/pages.ts', [
      "export const reader = () => import('./reader')",
      "export const pdf = () => import('pdfjs-dist/legacy/build/pdf.mjs')",
      'export const template = () => import(`./reader`)',
      "export const required = () => require('./reader')",
      'export const mode = import.meta.env.MODE',
    ].join('\n'));
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
    const flagged = { services: [1, 3, 6, 7, 10], storage: [2, 4, 8, 9], repo: [5, 7] };
    const expected = Object.entries(flagged)
      .flatMap(([kind, numbers]) => numbers.map((number) => `${kind} "${lines[number - 1]}"`));
    const reported = [...result.stderr.matchAll(/^\S+ (\w+ ".*"): \d+ not listed/gm)].map((found) => found[1]);
    expect(reported.sort()).toEqual(expected.sort());
  });

  it('resolves a relative layer name from the importing file', () => {
    const repo = fixture();
    repo.write('src/ui/components/shell.ts', 'export const title = "Settings"');
    repo.write('src/ui/components/topBar.ts', "export * from './shell'");
    expect(repo.run().status).toBe(0);
    repo.write('src/ui/page.ts', "import '../backend/x'");
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/ui/page.ts import "import \'../backend/x\'": 1 not listed');
    expect(result.stderr).not.toContain('topBar.ts');
  });

  it('ignores test files, comments and literal text and checks expressions in templates and JSX', () => {
    // The regex literal below is itself a pattern match, which the allowance lists.
    const repo = fixture([listed('src/ui/view.tsx', 'pattern', 'const pattern = /localStorage/')]);
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
      "const table = import('../app/table')",
      'const cookie = draft.label',
    ].join('\n');
    repo.write('src/ui/view.test.tsx', examples);
    repo.write('src/ui/nested/view.test.ts', examples);
    repo.write(page, clean);
    expect(repo.run().status).toBe(0);
    repo.write(page, clean + '\nconst value = <b>{`${store.services}`}</b>');
    expect(repo.run().stderr).toContain(`${page} services "${'const value = <b>{`${store.services}`}</b>'}"`);
  });
});

describe('the line-by-line allowance', () => {
  const file = 'src/ui/checklist.ts';
  const oldFile = 'src/ui/old.ts';
  const serviceLine = 'store.services.ai';

  it('passes when every match is listed and tells how the allowance is kept', () => {
    const repo = fixture([listed(file, 'services', serviceLine)]);
    repo.write(file, serviceLine);
    const result = repo.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Issues named in the allowances are checked as open by CI');
    expect(result.stdout).toContain('scripts/check-open-issues.mjs');
  });

  it('refuses a new timer in a screen', () => {
    const repo = fixture();
    repo.write('src/ui/toast.tsx', 'export const hide = () => setTimeout(close, 3000)');
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/ui/toast.tsx timer "export const hide = () => setTimeout(close, 3000)"');
  });

  it('refuses a touched line on a listed multi-kind line', () => {
    const before = 'const shown = rows.slice(0, 3).length > 3';
    const repo = fixture([listed(file, 'list', before), listed(file, 'limit', before)]);
    repo.write(file, before);
    expect(repo.run().status).toBe(0);
    const after = 'const shown = rows.slice(0, 4).length > 3';
    repo.write(file, after);
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file} list "${after}": 1 not listed`);
    expect(result.stderr).toContain(`${file} limit "${after}": 1 not listed`);
  });

  it('writes / in entries for files read with \\ separators', () => {
    expect(slashPath('src\\ui\\nested', 'view.tsx')).toBe('src/ui/nested/view.tsx');
    expect(slashPath('src/ui', 'view.tsx')).toBe('src/ui/view.tsx');
  });

  it('states that only the listed forms are caught when it fails', () => {
    const repo = fixture();
    repo.write(file, serviceLine);
    const { stderr } = repo.run();
    expect(stderr).toContain('Only the syntax forms listed in docs/development.md are caught');
    expect(stderr).toContain("review's job");
    expect(stderr).toContain('references that are not called');
    expect(stderr).toContain('"The frontend is a pane of glass" in CLAUDE.md');
  });

  it('tells how the allowances are kept on a failing run, a --list run and a malformed baseline', () => {
    const notice = 'checked as open by CI (scripts/check-open-issues.mjs)';
    const repo = fixture();
    repo.write(file, serviceLine);
    expect(repo.run().stderr).toContain(notice);
    expect(repo.run('--list').stderr).toContain(notice);
    repo.write(baselineFile, '[{');
    expect(repo.run().stderr).toContain(notice);
  });

  it('reports a stale entry and an unlisted match, without changing the file', () => {
    const repo = fixture([listed(oldFile, 'storage', 'localStorage.clear()')]);
    repo.write(file, serviceLine);
    const before = repo.baselineText();
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${oldFile} storage "localStorage.clear()": no match: remove this entry`);
    expect(result.stderr).toContain(`${file} services "${serviceLine}": 1 not listed`);
    expect(repo.baselineText()).toBe(before);
  });

  it('--list prints the unlisted groups as entries without an issue and exits 1', () => {
    const repo = fixture();
    repo.write(file, `${serviceLine}\n${serviceLine}`);
    const result = repo.run('--list');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([{ file, kind: 'services', line: serviceLine, count: 2 }]);
  });

  it('--lower lowers a count to its matches', () => {
    const repo = fixture([listed(file, 'services', serviceLine, 3)]);
    repo.write(file, `${serviceLine}\n${serviceLine}`);
    expect(repo.run().stderr).toContain('lower the count to 2');
    expect(repo.run('--lower').status).toBe(0);
    expect(JSON.parse(repo.baselineText())).toEqual([listed(file, 'services', serviceLine, 2)]);
    expect(repo.run().status).toBe(0);
  });

  it('--lower removes an entry whose line was fixed', () => {
    const repo = fixture([listed(oldFile, 'storage', 'localStorage.clear()'), listed(file, 'services', serviceLine)]);
    repo.write(file, serviceLine);
    expect(repo.run().status).toBe(1);
    expect(repo.run('--lower').status).toBe(0);
    expect(JSON.parse(repo.baselineText())).toEqual([listed(file, 'services', serviceLine)]);
    expect(repo.run().status).toBe(0);
  });

  it('--lower refuses, leaving the file unchanged, when a match is unlisted beside a lowerable entry', () => {
    const repo = fixture([listed(file, 'services', serviceLine, 3)]);
    repo.write(file, `${serviceLine}\nstore.services.ids`);
    const before = repo.baselineText();
    const result = repo.run('--lower');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('store.services.ids": 1 not listed');
    expect(repo.baselineText()).toBe(before);
  });

  it('--lower does not drop a malformed entry', () => {
    const repo = fixture([{ ...listed(file, 'services', serviceLine), count: 0 }]);
    repo.write(file, serviceLine);
    const before = repo.baselineText();
    const result = repo.run('--lower');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('needs a positive count');
    expect(repo.baselineText()).toBe(before);
  });

  it('--list prints only the shortfall of a partly listed group', () => {
    const repo = fixture([listed(file, 'services', serviceLine, 1)]);
    repo.write(file, `${serviceLine}\n${serviceLine}\n${serviceLine}`);
    const result = repo.run('--list');
    expect(JSON.parse(result.stdout)).toEqual([{ file, kind: 'services', line: serviceLine, count: 2 }]);
  });

  it('names the lines of an unlisted match', () => {
    const repo = fixture();
    repo.write(file, `\n${serviceLine}\n${serviceLine}`);
    expect(repo.run().stderr).toContain(`"${serviceLine}": 2 not listed (lines 2, 3)`);
  });

  it.each(['js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'])('checks a .%s screen too', (extension) => {
    const repo = fixture();
    repo.write(`src/ui/helper.${extension}`, 'localStorage.clear()');
    repo.write(`src/ui/helper.test.${extension}`, 'localStorage.clear()');
    const result = repo.run();
    expect(result.stderr).toContain(`src/ui/helper.${extension} storage "localStorage.clear()"`);
    expect(result.stderr).not.toContain('helper.test');
  });

  it('fails with a message, not a stack trace, on a baseline with a syntax error', () => {
    const repo = fixture();
    repo.write('src/ui/title.ts', 'export const title = "Checklist"');
    repo.write(baselineFile, '[{');
    const result = repo.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${baselineFile} is not valid JSON`);
    expect(result.stderr).not.toContain('node:internal');
  });

  it('--lower never adds an entry', () => {
    const repo = fixture();
    repo.write(file, serviceLine);
    const before = repo.baselineText();
    expect(repo.run('--lower').status).toBe(1);
    expect(repo.baselineText()).toBe(before);
  });

  it('passes the committed allowance on the repository sources', () => {
    const repo = fixture();
    cpSync('src/ui', path.join(repo.dir, 'src/ui'), { recursive: true });
    for (const name of [baselineFile, 'scripts/verified-decisions.json', 'docs/decisions.md']) {
      copyFileSync(name, path.join(repo.dir, name));
    }
    const result = repo.run();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
