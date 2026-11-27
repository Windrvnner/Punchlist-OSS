// @vitest-environment node
// The skipped-test gate: a test that skips in CI is listed with a reason, and a test file Vitest never runs fails.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error the scripts are plain JavaScript
import { isTestFile, skippedMatches, skippedProblems, unrunTestFiles } from '../../scripts/check-skipped-tests.mjs';
import { isAiCheck, isLive, liveExclude } from '../../scripts/vitest-files.mjs';
// @ts-expect-error the script is plain JavaScript
import { vitestResults } from '../../scripts/gate-compare.mjs';

const script = path.resolve('scripts/check-skipped-tests.mjs');
// the report fixtures live under out/gate/, made when the tests run
let gateRoot = '';
beforeAll(() => {
  mkdirSync(path.resolve('out/gate'), { recursive: true });
  gateRoot = mkdtempSync(path.resolve('out/gate/test-'));
});
afterAll(() => rmSync(gateRoot, { recursive: true, force: true }));

const file = 'tests/app/a.test.ts';
const report = (statuses: string[], name = `/checkout/${file}`) => ({
  testResults: [{ name, assertionResults: statuses.map((status, i) => ({ fullName: `test ${i}`, status })) }],
});
const listed = (extra: object = {}) => ({
  file, kind: 'skipped', line: 'test 0', count: 1, issue: 7, platform: 'linux', reason: 'needs a display', ...extra,
});
const problems = (found: object, allowance: object[] = [], scope?: (entry: object) => boolean) =>
  skippedProblems(found, allowance, { decisions: [], verified: [], scope }) as string[];

describe('skipped tests in a Vitest report', () => {
  it('refuses a todo, a ctx.skip() and a skipIf that skipped', () => {
    const found = skippedMatches(report(['passed', 'todo', 'pending', 'skipped']), 'linux');
    expect(problems(found).join('\n')).toMatch(/test 1.*not listed[\s\S]*test 2.*not listed[\s\S]*test 3.*not listed/);
  });

  it('allows a listed skip', () => {
    const found = skippedMatches(report(['skipped']), 'linux');
    expect(problems(found, [listed()])).toEqual([]);
  });

  it('lists the same skip separately for each platform', () => {
    const found = skippedMatches(report(['skipped']), 'win32');
    expect(problems(found, [listed()]).join('\n')).toContain('not listed');
  });

  it('reports an entry with no skip only when the run covered it', () => {
    const found = skippedMatches(report(['passed']), 'linux');
    expect(problems(found, [listed()], () => false)).toEqual([]);
    expect(problems(found, [listed()], () => true).join('\n')).toContain('no match: remove this entry');
  });

  describe('a root-only entry', () => {
    const rootOnly = listed({ root: true });
    const platformScope = (entry: { platform?: string }) => entry.platform === 'linux';
    const run = (statuses: string[], root: boolean) =>
      skippedProblems(skippedMatches(report(statuses), 'linux'), [rootOnly], {
        decisions: [], verified: [], scope: platformScope, root,
      }) as string[];

    it('is out of scope in a run that is not root and where the test passed', () => {
      expect(run(['passed'], false)).toEqual([]);
    });

    it('does not excuse a skip in a run that is not root', () => {
      expect(run(['skipped'], false).join('\n')).toContain('not listed');
    });

    it('excuses a skip in a run as root', () => {
      expect(run(['skipped'], true)).toEqual([]);
    });

    it('is reported as stale in a run as root where the test passed', () => {
      expect(run(['passed'], true).join('\n')).toContain('no match: remove this entry');
    });
  });

  it('reads the file from tests/ on, with forward slashes', () => {
    const results = vitestResults(report(['skipped'], 'C:\\work\\Punchlist\\tests\\desktop\\folder.test.ts'));
    expect(results).toEqual([{ file: 'tests/desktop/folder.test.ts', fullName: 'test 0', status: 'skipped' }]);
  });
});

describe('test files Vitest never runs', () => {
  it('refuses a test file outside the include list', () => {
    const problems = unrunTestFiles(['tests/ui/a.test.ts', 'tests/ui/b.test.tsx']);
    expect(problems).toEqual(['tests/ui/a.test.ts is never run by Vitest']);
  });

  it('refuses a test file of any shape Vitest could run, outside the include list', () => {
    const problems = unrunTestFiles(['tests/ui/a.test.mjs', 'tests/ui/b.test.jsx', 'tests/ui/c.test.cts']);
    expect(problems).toHaveLength(3);
    expect(['a.test.mjs', 'b.test.tsx', 'c.test.cjs'].every((name) => isTestFile(`tests/x/${name}`))).toBe(true);
    expect(isTestFile('tests/desktop/smoke.spec.mjs')).toBe(false);
  });

  it('finds none among the tracked test files', () => {
    const tracked = spawnSync('node', [script, '--files'], { encoding: 'utf8' });
    expect(tracked.stderr).toBe('');
    expect(tracked.status).toBe(0);
  });
});

describe('the live switches', () => {
  it('reads the live run and the AI check from the environment', () => {
    expect([isLive({}), isLive({ PUNCHLIST_LIVE: '1' })]).toEqual([false, true]);
    expect([isAiCheck({}), isAiCheck({ PUNCHLIST_AI_CHECK: 'north' })]).toEqual([false, true]);
    expect(liveExclude({ PUNCHLIST_LIVE: '1', PUNCHLIST_AI_CHECK: 'openai' })).toEqual([]);
  });
});

describe('the command', () => {
  const run = (...args: string[]) => spawnSync('node', [script, ...args], { encoding: 'utf8' });
  const write = (content: string) => {
    const reportPath = path.join(gateRoot, `report-${Math.random()}.json`);
    writeFileSync(reportPath, content);
    return reportPath;
  };

  it.each([
    ['is missing', null],
    ['is not JSON', 'not json'],
    ['has no test results', '{}'],
  ])('fails when the report %s', (_, content) => {
    const reportPath = content === null ? path.join(gateRoot, 'none.json') : write(content);
    const result = run(reportPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`No Vitest report at ${reportPath}`);
  });

  it.each([[undefined], ['/tmp/elsewhere'], ['out/gate']])(
    'fails with no path when PUNCHLIST_GATE_DIR is %s, as it is outside out/gate/',
    (dir) => {
      const env = { ...process.env, PUNCHLIST_GATE_DIR: dir };
      if (dir === undefined) delete env.PUNCHLIST_GATE_DIR;
      const result = spawnSync('node', [script], { encoding: 'utf8', env });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No Vitest report at');
    },
  );

  it('fails on an unlisted skip and passes a run without one', () => {
    const skipped = run(write(JSON.stringify(report(['skipped']))));
    expect(skipped.status).toBe(1);
    expect(skipped.stderr).toContain('not listed');
    expect(run(write(JSON.stringify(report(['passed'])))).status).toBe(0);
  });
});
