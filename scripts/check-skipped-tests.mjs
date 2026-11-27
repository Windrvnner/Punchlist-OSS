// Fails CI on a test that skipped and is not listed in scripts/skipped-tests-allowance.json, and on a test file that
// Vitest never runs.
//   node scripts/check-skipped-tests.mjs [<vitest.json>] [--scope never|desktop|platform]
//   node scripts/check-skipped-tests.mjs --files
// The report is the one a run writes to PUNCHLIST_GATE_DIR (default: that folder's vitest.json). A skipped test is
// listed with its file, name, platform and a reason. The scope says which listed entries this run could have seen, so
// an entry that no longer matches is reported only then: "never" for a shard of the unit tests, "desktop" for the
// Windows run of tests/desktop, "platform" for a whole run on this machine. An entry with `root: true` counts only in a
// run as root.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { allowanceProblems, decisionEntries, entryProblems, groupMatches } from './allowance.mjs';
import { vitestResults } from './gate-compare.mjs';
import { insideGate } from './gate-dir.mjs';
import { liveExclude } from './vitest-files.mjs';

const allowancePath = 'scripts/skipped-tests-allowance.json';
const notRun = new Set(['skipped', 'pending', 'todo']);

// Each test the report shows as skipped, pending or todo, with the platform of the run.
export function skippedMatches(report, platform) {
  return vitestResults(report)
    .filter(({ status }) => notRun.has(status))
    .map(({ file, fullName }) => ({ file, kind: 'skipped', line: fullName, platform }));
}

// An entry with `root: true` stands for a skip that happens only when the run is root (#1242). It excuses a skip, and
// can go stale, only in a run as root; in any other run only its shape is checked.
export function skippedProblems(matches, allowance, { decisions, verified, scope, root }) {
  const active = allowance.filter((entry) => root || entry.root !== true);
  const rootOnly = allowance.filter((entry) => !active.includes(entry));
  return [
    ...entryProblems(rootOnly, decisions, verified),
    ...allowanceProblems(groupMatches(matches), active, { decisions, verified, scope }),
  ];
}

// The test files, among `files`, that Vitest does not list in `runFiles`. A plain run leaves out the live tests and
// the AI check (scripts/vitest-files.mjs), so they are not reported; any other exclusion is.
export function unrunTestFiles(files, runFiles) {
  const leftOutOnPurpose = (file) => liveExclude({}).some((pattern) => path.matchesGlob(file, pattern));
  return files
    .filter((file) => !runFiles.includes(file) && !leftOutOnPurpose(file))
    .map((file) => `${file} is never run by Vitest`);
}

// The files Vitest itself would run, from its configuration's include and exclude, as paths from the repository root.
// The live switches are cleared so the list is the one a plain run uses.
export function vitestRunFiles(args = []) {
  const vitest = path.resolve('node_modules/vitest/vitest.mjs');
  const env = { ...process.env, PUNCHLIST_LIVE: '', PUNCHLIST_AI_CHECK: '' };
  const listed = execFileSync(process.execPath, [vitest, 'list', '--filesOnly', '--json', ...args], { env });
  const fromRoot = (file) => path.relative(process.cwd(), file).split(path.sep).join('/');
  return JSON.parse(listed.toString('utf8')).map(({ file }) => fromRoot(file));
}

const scopes = {
  never: () => false,
  desktop: (entry) => entry.platform === 'win32' && entry.file.startsWith('tests/desktop/'),
  platform: (entry) => entry.platform === process.platform,
};

function readReport(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (Array.isArray(report.testResults) && report.testResults.length > 0) return report;
  } catch {
    // an unreadable report is reported below, as a missing one is
  }
  throw new Error(`No Vitest report at ${reportPath}`);
}

// Every shape of test file Vitest could run (its default include is *.{test,spec}, ours only .test). The .spec.mjs
// files are not among them: CI runs those with node (.github/workflows/ci.yml).
export const isTestFile = (file) => /^tests\/.*(?:\.test\.[mc]?[jt]sx?|\.spec\.tsx?)$/.test(file);

function trackedTestFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z', 'tests'], { encoding: 'utf8' }).split('\0');
  return tracked.filter(isTestFile);
}

function reportProblems(args) {
  const flag = args.indexOf('--scope');
  const scopeName = flag === -1 ? 'never' : args[flag + 1];
  if (!(scopeName in scopes)) throw new Error('--scope is never, desktop or platform');
  const named = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--scope');
  const gateReport = insideGate(process.env.PUNCHLIST_GATE_DIR);
  const reportPath = named ?? (gateReport && path.join(gateReport, 'vitest.json'));
  const report = readReport(reportPath ?? 'PUNCHLIST_GATE_DIR/vitest.json');
  const allowance = JSON.parse(readFileSync(allowancePath, 'utf8'));
  const decisions = decisionEntries(readFileSync('docs/decisions.md', 'utf8'));
  const verified = JSON.parse(readFileSync('scripts/verified-decisions.json', 'utf8'));
  const matches = skippedMatches(report, process.platform);
  // The check runs in the same job as Vitest, so this process is root exactly when the tests ran as root.
  const root = process.getuid?.() === 0;
  return skippedProblems(matches, allowance, { decisions, verified, scope: scopes[scopeName], root });
}

function main() {
  const args = process.argv.slice(2);
  try {
    const problems = args.includes('--files') ? unrunTestFiles(trackedTestFiles(), vitestRunFiles()) : reportProblems(args);
    for (const problem of problems) console.error(problem);
    if (problems.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
