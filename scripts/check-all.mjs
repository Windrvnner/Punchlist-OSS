// Everything CI ran, on this PC, in order, stopping at the first failure: the checks a commit must pass (types, lint,
// secrets, unit, backend and end-to-end tests), the build, the browser suites and the built desktop app end to end.
// CI on GitHub runs the same steps as parallel jobs, and its required checks gate merging; this local run is optional.
// The Windows installer is not built here.
// On Linux with no display, the desktop app runs on a virtual one (xvfb-run).
// It never makes paid model calls: every step runs without the Claude key or the live-run switch, even when the shell
// holds them (npm run e2e:live is the one way to run the live tests).
// Each run writes its stage times and test results to out/gate/<time>/ (gate.json, vitest.json, browser.json,
// smoke.json); `node scripts/gate-compare.mjs <before> <after>` compares two runs.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usableOffice } from './office-check.mjs';

// by any spelling: Windows treats environment names without regard to case
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['PUNCHLIST_AI_KEY', 'PUNCHLIST_LIVE'].includes(k.toUpperCase())));
requireOffice();
const gateDir = path.resolve('out/gate', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(gateDir, { recursive: true });
env.PUNCHLIST_GATE_DIR = gateDir;
const display = process.platform !== 'linux' || !!process.env.DISPLAY;
const desktopSuites = process.platform === 'linux' ? ['smoke', 'signin', 'qaLogRecovery'] : ['smoke', 'signin'];
const steps = [
  ['npm', ['run', 'check']],
  // reads the report the Vitest step above just wrote to PUNCHLIST_GATE_DIR
  ['node', ['scripts/check-skipped-tests.mjs', '--scope', 'platform']],
  ['npm', ['exec', '--', 'vite', 'build']],
  ['npm', ['run', 'browser', '--', '--jobs', '2']],
  ['node', ['scripts/desktop-build.mjs']],
  ...desktopSuites.map((suite) => {
    const script = `tests/desktop/${suite}.spec.mjs`;
    return display ? ['node', [script]] : ['xvfb-run', ['-a', 'node', script]];
  }),
];
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const gate = { commit, cpus: os.cpus().length, started: new Date().toISOString(), steps: [] };
for (const [cmd, args] of steps) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const stepStarted = Date.now();
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  const secs = Math.round((Date.now() - stepStarted) / 100) / 10;
  gate.steps.push({ cmd: `${cmd} ${args.join(' ')}`, secs, status: r.status });
  if (r.status !== 0) {
    finishGate();
    console.error(`\ncheck:all stopped: ${cmd} ${args.join(' ')} failed`);
    process.exit(r.status ?? 1);
  }
}
finishGate();
console.log('\ncheck:all passed');

/** Writes gate.json, also after a failed step, and prints one line per step with its time. */
function finishGate() {
  fs.writeFileSync(path.join(gateDir, 'gate.json'), JSON.stringify(gate, null, 2));
  console.log(`\nStage times (results in ${path.relative(process.cwd(), gateDir)}):`);
  for (const step of gate.steps) {
    console.log(`${String(step.secs).padStart(8)}s  ${step.status === 0 ? 'ok  ' : 'FAIL'}  ${step.cmd}`);
  }
}

/** LibreOffice must convert spreadsheets before the run; the tests that need it then run on it, never skip (#85). */
function requireOffice() {
  try {
    const { soffice, version } = usableOffice();
    console.log(`LibreOffice ${soffice}: ${version}`);
    env.PUNCHLIST_OFFICE = 'required';
  } catch (error) {
    console.error(`check:all stopped: ${error.message}`);
    process.exit(1);
  }
}
