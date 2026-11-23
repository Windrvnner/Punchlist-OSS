// Everything CI ran, on this PC, in order, stopping at the first failure: the checks a commit must pass (types, lint,
// secrets, unit, backend and end-to-end tests), the build, the browser suites and the built desktop app end to end.
// Run before every merge (`npm run check:all`); CI on GitHub runs only by hand. The Windows installer is not built here.
// On Linux with no display, the desktop app runs on a virtual one (xvfb-run).
// It never makes paid model calls: every step runs without the Claude key or the live-run switch, even when the shell
// holds them (npm run e2e:live is the one way to run the live tests).
import { spawnSync } from 'node:child_process';
import { usableOffice } from './office-check.mjs';

// by any spelling: Windows treats environment names without regard to case
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !['PUNCHLIST_AI_KEY', 'PUNCHLIST_LIVE'].includes(k.toUpperCase())));
requireOffice();
const display = process.platform !== 'linux' || !!process.env.DISPLAY;
const steps = [
  ['npm', ['run', 'check']],
  ['npm', ['exec', '--', 'vite', 'build']],
  ['npm', ['run', 'browser', '--', '--jobs', '2']],
  ['node', ['scripts/desktop-build.mjs']],
  ...['smoke', 'signin'].map((suite) => {
    const script = `tests/desktop/${suite}.spec.mjs`;
    return display ? ['node', [script]] : ['xvfb-run', ['-a', 'node', script]];
  }),
];
for (const [cmd, args] of steps) {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error(`\ncheck:all stopped: ${cmd} ${args.join(' ')} failed`); process.exit(r.status ?? 1); }
}
console.log('\ncheck:all passed');

/** LibreOffice must convert spreadsheets before the run; the tests that need it then run on it, never skip (#85). */
function requireOffice() {
  try {
    const { soffice, version } = usableOffice(env);
    console.log(`LibreOffice ${soffice}: ${version}`);
    env.PUNCHLIST_SOFFICE = soffice;
    env.PUNCHLIST_OFFICE = 'required';
  } catch (error) {
    console.error(`check:all stopped: ${error.message}`);
    process.exit(1);
  }
}
