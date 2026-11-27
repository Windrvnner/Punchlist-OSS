// Compares two check:all runs (out/gate/<time>/ folders) to prove a speed-up kept every test:
//   node scripts/gate-compare.mjs <before-dir> <after-dir>
// Prints each stage's time and the difference, then exits 1 if anything that passed before is missing, skipped or
// failing after: a Vitest test, a desktop smoke check, a whole stage, or a browser suite or its count of checks. A
// browser check's line holds its ID and often a note that changes between runs, so the PASS lines seen only before are
// listed for a person to read rather than counted as lost. Exits 2 when a folder holds no run or is outside out/gate/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { insideGate } from './gate-dir.mjs';

/** One run's files; a file a run did not write (its stage never ran), or a folder outside out/gate/, reads as null. */
export function readGate(dir) {
  const root = insideGate(dir);
  const read = (name) => {
    if (!root) return null;
    const file = path.join(root, name);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  };
  const gate = read('gate.json');
  return { gate, vitest: read('vitest.json'), browser: read('browser.json'), smoke: read('smoke.json') };
}

/** Each Vitest assertion with its file taken from tests/ on, with / separators, so two checkouts compare equal. */
export function vitestResults(vitest) {
  return (vitest?.testResults ?? []).flatMap((file) => {
    const name = file.name.replace(/\\/g, '/').replace(/^.*?(?=tests\/)/, '');
    return (file.assertionResults ?? []).map((test) => ({ file: name, fullName: test.fullName, status: test.status }));
  });
}

/** Vitest results by "file > full name". */
function vitestStatuses(vitest) {
  return new Map(vitestResults(vitest).map(({ file, fullName, status }) => [`${file} > ${fullName}`, status]));
}

/** Problems with the tests: each passing before and not passing after, or a browser suite that lost checks. */
function lostCoverage(before, after) {
  const problems = [];
  const vitestAfter = vitestStatuses(after.vitest);
  for (const [id, status] of vitestStatuses(before.vitest)) {
    if (status !== 'passed') continue;
    const now = vitestAfter.get(id);
    if (now !== 'passed') problems.push(`Vitest test ${now ? now : 'missing'}: ${id}`);
  }
  const smokeAfter = new Map((after.smoke?.checks ?? []).map((check) => [check.id, check.ok]));
  for (const check of before.smoke?.checks ?? []) {
    if (!check.ok) continue;
    if (!smokeAfter.has(check.id)) problems.push(`Smoke check missing: ${check.id}`);
    else if (!smokeAfter.get(check.id)) problems.push(`Smoke check failing: ${check.id}`);
  }
  const suitesAfter = new Map((after.browser?.suites ?? []).map((suite) => [suite.name, suite]));
  for (const suite of before.browser?.suites ?? []) {
    const now = suitesAfter.get(suite.name);
    const label = `Browser suite ${suite.name}`;
    if (!now) problems.push(`${label} missing`);
    else if (now.total < suite.total) problems.push(`${label}: ${now.total} checks, was ${suite.total}`);
    else if (now.passed < suite.passed) problems.push(`${label}: ${now.passed} passed, was ${suite.passed}`);
  }
  return problems;
}

/** The PASS lines of each browser suite seen before and not after: a renamed or dropped check, or only a new note. */
function browserLinesGone(before, after) {
  const linesAfter = new Set((after.browser?.suites ?? []).flatMap((suite) => suite.lines ?? []));
  return (before.browser?.suites ?? []).flatMap((suite) => (suite.lines ?? [])
    .filter((line) => line.startsWith('PASS ') && !linesAfter.has(line))
    .map((line) => `${suite.name}: ${line.slice(0, 160)}`));
}

/** Each stage's seconds before and after, and the stages that passed before and failed or never ran after. */
function stageTimes(before, after) {
  const lines = [];
  const problems = [];
  const stepsAfter = new Map((after.gate?.steps ?? []).map((step) => [step.cmd, step]));
  for (const step of before.gate?.steps ?? []) {
    const now = stepsAfter.get(step.cmd);
    const delta = now ? (now.secs - step.secs).toFixed(1) : 'n/a';
    const columns = [`${step.secs}s`, `${now?.secs ?? '-'}s`, delta].map((cell) => cell.padStart(9));
    lines.push(`${columns.join('')}  ${step.cmd}`);
    if (step.status === 0 && now?.status !== 0) problems.push(`Stage ${now ? 'failed' : 'did not run'}: ${step.cmd}`);
  }
  return { lines, problems };
}

/** Counts of re-run browser suites and of failed Vitest tests whose message says they timed out. */
function retriesAndTimeouts(run) {
  const reruns = (run.browser?.suites ?? []).filter((suite) => suite.rerun).length;
  const timeouts = (run.vitest?.testResults ?? []).flatMap((file) => file.assertionResults ?? [])
    .filter((test) => (test.failureMessages ?? []).some((message) => /timed out/i.test(message))).length;
  return `${reruns} browser re-runs, ${timeouts} Vitest timeouts`;
}

/** The report lines and the problems found between two runs. */
export function compareGates(before, after) {
  const stages = stageTimes(before, after);
  const gone = browserLinesGone(before, after);
  const lines = ['   before    after     diff  stage', ...stages.lines,
    `Before: ${retriesAndTimeouts(before)}. After: ${retriesAndTimeouts(after)}.`];
  if (gone.length) {
    lines.push('Browser PASS lines seen only before (check the IDs):', ...gone.map((line) => `  ${line}`));
  }
  return { lines, problems: [...stages.problems, ...lostCoverage(before, after)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [beforeDir, afterDir] = process.argv.slice(2);
  if (!beforeDir || !afterDir) {
    console.error('Usage: node scripts/gate-compare.mjs <before-dir> <after-dir>');
    process.exit(2);
  }
  const runs = [beforeDir, afterDir].map(readGate);
  const empty = [beforeDir, afterDir].filter((dir, i) => !runs[i].gate);
  if (empty.length) {
    console.error(`No run recorded (no gate.json under out/gate/) in: ${empty.join(', ')}`);
    process.exit(2);
  }
  const { lines, problems } = compareGates(runs[0], runs[1]);
  console.log(lines.join('\n'));
  for (const problem of problems) console.error(`LOST ${problem}`);
  console.log(problems.length ? `\n${problems.length} problems: coverage or stages were lost` : '\nSame coverage');
  process.exit(problems.length ? 1 : 0);
}
