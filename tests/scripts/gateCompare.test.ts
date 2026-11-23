// @vitest-environment node
// The check:all comparison: a faster run passes only if every test, check and stage that passed before still passes.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/gate-compare.mjs');
// the comparison reads only folders under out/gate/, as check:all writes them
fs.mkdirSync(path.resolve('out/gate'), { recursive: true });
const gateRoot = fs.mkdtempSync(path.resolve('out/gate/test-'));
afterAll(() => fs.rmSync(gateRoot, { recursive: true, force: true }));
const vitestTests = ['keeps the draft', 'saves the log', 'reopens the deal'];

const suite = (name: string, checks: number, secs: number) =>
  ({ name, passed: checks, total: checks, secs, rerun: false, firstFails: [], lines: [] });

/** A run's result files as check:all writes them, with each part changeable by the case. */
function run(change: (files: Record<string, any>) => void = () => {}, secs = 100) {
  const files: Record<string, any> = {
    'gate.json': { commit: 'abc', cpus: 4, started: '', steps: [{ cmd: 'npm run check', secs, status: 0 }] },
    'vitest.json': { testResults: [{ name: '/checkout/a/tests/app/drafts.test.ts',
      assertionResults: vitestTests.map((fullName) => ({ fullName, status: 'passed', failureMessages: [] })) }] },
    'browser.json': { jobs: 2, secs, suites: [suite('drafts', 12, secs), suite('keyboard', 9, secs)] },
    'smoke.json': { checks: [{ id: 'boots', ok: true }, { id: 'folder-recovers', ok: true }] },
  };
  change(files);
  const dir = fs.mkdtempSync(path.join(gateRoot, 'run-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  return dir;
}
const compare = (before: string, after: string) => spawnSync('node', [script, before, after], { encoding: 'utf8' });

describe('the check:all comparison', () => {
  it('passes two runs with the same tests, and shows a faster stage as a negative difference', () => {
    const result = compare(run(), run(undefined, 60));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/100s\s+60s\s+-40\.0\s+npm run check/);
  });

  it('fails when a Vitest test that passed before is skipped after, and names it', () => {
    const after = run((files) => { files['vitest.json'].testResults[0].assertionResults[1].status = 'skipped'; });
    const result = compare(run(), after);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Vitest test skipped: tests/app/drafts.test.ts > saves the log');
  });

  it('fails when a browser suite has one check fewer, and names the suite', () => {
    const after = run((files) => { files['browser.json'].suites[0] = suite('drafts', 11, 100); });
    const result = compare(run(), after);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Browser suite drafts: 11 checks, was 12');
  });

  it('fails when a browser suite is missing after', () => {
    const after = run((files) => { files['browser.json'].suites.pop(); });
    const result = compare(run(), after);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Browser suite keyboard missing');
  });

  it('fails when a smoke check is missing after, and names it', () => {
    const after = run((files) => { files['smoke.json'].checks.pop(); });
    const result = compare(run(), after);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Smoke check missing: folder-recovers');
  });

  it('fails when a stage that passed before stopped the run after, leaving later results unwritten', () => {
    const after = run((files) => {
      files['gate.json'].steps[0].status = 1;
      delete files['smoke.json'];
    });
    const result = compare(run(), after);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stage failed: npm run check');
    expect(result.stderr).toContain('Smoke check missing: boots');
  });

  it('lists a browser check whose line is gone, even when the suite keeps its count', () => {
    const withLine = (line: string) => run((files) => { files['browser.json'].suites[0].lines = [line]; });
    const result = compare(withLine('PASS the draft is kept'), withLine('PASS another check'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('drafts: PASS the draft is kept');
  });

  it('refuses a folder outside out/gate/, even one holding a run', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    fs.cpSync(run(), outside, { recursive: true });
    const result = compare(outside, run());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No run recorded');
  });

  it('refuses a folder with no recorded run rather than reporting the same coverage', () => {
    const empty = fs.mkdtempSync(path.join(gateRoot, 'run-'));
    const result = compare(empty, run());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('No run recorded');
  });
});
