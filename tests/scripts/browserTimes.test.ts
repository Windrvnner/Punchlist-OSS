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
  const script = path.resolve('scripts/browser-times.mjs');
  const timesFile = 'tests/browser/suite-times.json';

  /** A checkout with suites alpha and beta, kept times, and a check:all run named `run` with these local times. */
  function checkout(kept: string) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-times-'));
    fs.mkdirSync(path.join(repo, 'tests/browser'), { recursive: true });
    for (const name of ['alpha', 'beta']) fs.writeFileSync(path.join(repo, `tests/browser/${name}.spec.mjs`), '');
    fs.writeFileSync(path.join(repo, timesFile), kept);
    return repo;
  }
  function addRun(repo: string, folder: string, alpha: number, beta: number) {
    fs.mkdirSync(path.join(repo, folder), { recursive: true });
    const suites = [entry('alpha', alpha), entry('beta', beta)];
    fs.writeFileSync(path.join(repo, folder, 'browser.json'), JSON.stringify({ suites }));
  }
  const runIn = (repo: string, ...args: string[]) =>
    execFileSync('node', [script, ...args], { cwd: repo, encoding: 'utf8', stdio: 'pipe' });
  const keptIn = (repo: string) => fs.readFileSync(path.join(repo, timesFile), 'utf8');

  it('rewrites the file from the latest run, or from a named one', () => {
    const repo = checkout(JSON.stringify({ alpha: 100, old: 9 }));
    addRun(repo, 'out/gate/2026-01-01T00-00-00-000Z', 25, 99);
    addRun(repo, 'out/gate/2026-01-02T00-00-00-000Z', 50, 30);
    addRun(repo, 'out/gate/zz-not-a-run', 1, 1);
    expect(runIn(repo)).toContain('scaled by 2.00');
    expect(keptIn(repo)).toBe('{\n  "alpha": 100,\n  "beta": 60\n}\n');
    runIn(repo, 'out/gate/2026-01-01T00-00-00-000Z');
    expect(keptIn(repo)).toBe('{\n  "alpha": 100,\n  "beta": 396\n}\n');
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('reads no run outside out/gate/ and leaves the file alone on bad input', () => {
    const kept = JSON.stringify({ alpha: 100, beta: 7 });
    const repo = checkout(kept);
    addRun(repo, 'elsewhere', 50, 30);
    expect(() => runIn(repo, 'elsewhere')).toThrow(/not a run folder inside out\/gate/);
    expect(() => runIn(repo)).toThrow(/No browser.json/);
    fs.mkdirSync(path.join(repo, 'out/gate/2026-01-01T00-00-00-000Z'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'out/gate/2026-01-01T00-00-00-000Z/browser.json'), '{');
    expect(() => runIn(repo)).toThrow(/does not hold a JSON object/);
    addRun(repo, 'out/gate/2026-01-02T00-00-00-000Z', 0, 0);
    expect(() => runIn(repo)).toThrow(/No suite passed/);
    expect(keptIn(repo)).toBe(kept);
    fs.writeFileSync(path.join(repo, timesFile), 'null');
    expect(() => runIn(repo)).toThrow(/does not hold a JSON object/);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});
