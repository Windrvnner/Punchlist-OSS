// Fails when an allowance file grows relative to main: an issue entry may only be kept, lowered or removed, and a
// decision must already be on main's scripts/verified-decisions.json. Needs full history (CI's static job has it).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ALLOWANCE_FILES, committedJson, keyOf, mergeBase } from './allowance.mjs';
import { scanUi } from './ui-scan.mjs';

const paneOfGlassFile = ALLOWANCE_FILES[0];
const verifiedFile = 'scripts/verified-decisions.json';
const describe = ({ file, kind, line }) => `${file} ${kind} "${line}"`;

// On the branch introducing an allowance, main's own screens are the record of the exceptions that already exist.
function mainScreenMatches(at) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const files = git('ls-tree', '-r', '-z', '--name-only', at, '--', 'src/ui').split('\0').filter(Boolean);
  return scanUi(files, (file) => git('show', `${at}:${file}`));
}

// Main's entries for the file, or null when main has no list and nothing limits the file.
function ceilingFor(file, at) {
  const committed = committedJson(file);
  if (Array.isArray(committed)) return committed;
  return file === paneOfGlassFile ? mainScreenMatches(at) : null;
}

function growthProblems(entries, ceiling) {
  const problems = [];
  for (const entry of entries.filter((each) => each.issue !== undefined)) {
    const allowed = ceiling.find((each) => keyOf(each) === keyOf(entry))?.count ?? 0;
    if (entry.count > allowed) problems.push(`${describe(entry)}: count ${entry.count} is above main's ${allowed}`);
  }
  return problems;
}

function decisionProblems(entries, verifiedOnMain) {
  return entries
    .filter((entry) => entry.decision !== undefined && !verifiedOnMain.includes(entry.decision))
    .map((entry) => `${describe(entry)}: decision is not on main's ${verifiedFile}`);
}

function historyProblems(at) {
  const verifiedOnMain = committedJson(verifiedFile) ?? [];
  const problems = [];
  for (const file of ALLOWANCE_FILES.filter(existsSync)) {
    const entries = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(entries)) continue;
    const ceiling = ceilingFor(file, at);
    if (ceiling) problems.push(...growthProblems(entries, ceiling));
    problems.push(...decisionProblems(entries, verifiedOnMain));
  }
  return problems;
}

try {
  const at = mergeBase();
  const problems = at === null ? [] : historyProblems(at);
  if (problems.length) console.error(problems.join('\n'));
  if (problems.length) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
