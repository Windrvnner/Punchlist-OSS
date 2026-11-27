// @vitest-environment node
// The skipped-test gate: a test that skips in CI is listed with a reason, and a test file Vitest never runs fails.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error the scripts are plain JavaScript
import { skippedMatches, skippedProblems, unrunTestFiles } from '../../scripts/check-skipped-tests.mjs';
// @ts-expect-error the script is plain JavaScript
import { vitestResults } from '../../scripts/gate-compare.mjs';

const script = path.resolve('scripts/check-skipped-tests.mjs');
mkdirSync(path.resolve('out/gate'), { recursive: true });
const gateRoot = mkdtempSync(path.resolve('out/gate/test-'));
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

  it('does not count the live tests the config leaves out', () => {
    const files = ['tests/e2e/live-agent.test.ts', 'tests/e2e/ai-check-live.test.ts', 'tests/e2e/split.test.ts'];
    expect(unrunTestFiles(files)).toEqual([]);
  });

  it('finds none among the tracked test files', () => {
    const tracked = spawnSync('node', [script, '--files'], { encoding: 'utf8' });
    expect(tracked.stderr).toBe('');
    expect(tracked.status).toBe(0);
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
    ['is missing', path.join(gateRoot, 'none.json')],
    ['is not JSON', write('not json')],
    ['has no test results', write('{}')],
  ])('fails when the report %s', (_, reportPath) => {
    const result = run(reportPath);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`No Vitest report at ${reportPath}`);
  });

  it('fails on an unlisted skip and passes a run without one', () => {
    const skipped = run(write(JSON.stringify(report(['skipped']))));
    expect(skipped.status).toBe(1);
    expect(skipped.stderr).toContain('not listed');
    expect(run(write(JSON.stringify(report(['passed'])))).status).toBe(0);
  });
});
