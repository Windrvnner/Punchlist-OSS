// @vitest-environment node
// How the kept CI time of each browser suite is rewritten from the times a local check:all recorded.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ciScale, measuredTimes, updatedTimes } from '../../scripts/browser-times.mjs';

const entry = (name: string, secs: number, more: Partial<{ passed: number; total: number; rerun: boolean }> = {}) =>
  ({ name, secs, passed: 5, total: 5, rerun: false, ...more });

describe('the local times taken from a run', () => {
  it('keeps only suites that passed alongside the others', () => {
    const entries = [
      entry('ok', 40),
      entry('failed', 90, { passed: 3 }),
      entry('alone', 20, { rerun: true }),
      entry('unrun', 0, { passed: 0, total: 0 }),
    ];
    expect(measuredTimes(entries)).toEqual({ ok: 40 });
    expect(measuredTimes(undefined)).toEqual({});
  });
});

describe('scaling local times to CI speed', () => {
  it('takes the middle ratio, so one suite that changed speed does not move the rest', () => {
    const kept = { a: 100, b: 200, c: 300, d: 50 };
    const measured = { a: 50, b: 100, c: 150, d: 100 };
    expect(ciScale(kept, measured)).toBe(2);
  });

  it('is 1 when no suite has both times', () => {
    expect(ciScale({ a: 10 }, { b: 5 })).toBe(1);
  });
});

describe('the new CI times', () => {
  const kept = { checklist: 400, keyboard: 180, qapanel: 100, gone: 60 };

  it('scales the measured suites, keeps the rest, guesses a new one and drops a removed one', () => {
    const measured = { checklist: 200, keyboard: 150, qapanel: 50 };
    const { times, scale } = updatedTimes(kept, measured, ['qapanel', 'keyboard', 'checklist', 'newcomer']);
    expect(scale).toBe(2);
    expect(times).toEqual({ checklist: 400, keyboard: 300, newcomer: 300, qapanel: 100 });
    expect(Object.keys(times)).toEqual(['checklist', 'keyboard', 'newcomer', 'qapanel']);
  });

  it('keeps a suite that gave no time this run, and never writes a time below 1', () => {
    const { times } = updatedTimes(kept, { checklist: 200, qapanel: 50, keyboard: 0.2 }, ['checklist', 'keyboard']);
    expect(times).toEqual({ checklist: 400, keyboard: 1 });
    expect(updatedTimes(kept, {}, ['keyboard']).times).toEqual({ keyboard: 180 });
  });
});

describe('the command', () => {
  it('rewrites the file from a named run and refuses a folder outside out/gate/', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-times-'));
    const run = path.join(repo, 'out/gate/2026-01-01T00-00-00-000Z');
    fs.mkdirSync(path.join(repo, 'tests/browser'), { recursive: true });
    fs.mkdirSync(run, { recursive: true });
    for (const name of ['alpha', 'beta']) fs.writeFileSync(path.join(repo, `tests/browser/${name}.spec.mjs`), '');
    fs.writeFileSync(path.join(repo, 'tests/browser/suite-times.json'), JSON.stringify({ alpha: 100, old: 9 }));
    const suites = [entry('alpha', 50), entry('beta', 30)];
    fs.writeFileSync(path.join(run, 'browser.json'), JSON.stringify({ suites }));
    const script = path.resolve('scripts/browser-times.mjs');
    const out = execFileSync('node', [script], { cwd: repo, encoding: 'utf8' });
    expect(out).toContain('scaled by 2.00');
    const written = fs.readFileSync(path.join(repo, 'tests/browser/suite-times.json'), 'utf8');
    expect(written).toBe('{\n  "alpha": 100,\n  "beta": 60\n}\n');
    expect(() => execFileSync('node', [script, os.tmpdir()], { cwd: repo, stdio: 'pipe' })).toThrow();
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
