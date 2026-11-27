// Fails when an allowance file grows relative to main: every entry, whether it cites an issue or a decision, may only
// be kept, lowered or removed, and a decision must already be on main's scripts/verified-decisions.json.
// A pane-of-glass issue entry may move to the new text of an edited line (scripts/allowance-moves.mjs).
// Needs full history (CI's static job has it).
import { existsSync, readFileSync } from 'node:fs';
import { ALLOWANCE_FILES, committedJson, describe, git, keyOf, mergeBase } from './allowance.mjs';
import { movedLines } from './allowance-moves.mjs';
import { scanUi } from './ui-scan.mjs';

const paneOfGlassFile = ALLOWANCE_FILES[0];
const verifiedFile = 'scripts/verified-decisions.json';

// On the branch introducing an allowance, main's own screens are the record of the exceptions that already exist.
function mainScreenMatches(at) {
  const files = git(process.cwd(), 'ls-tree', '-r', '-z', '--name-only', at, '--', 'src/ui').split('\0');
  return scanUi(files.filter(Boolean), (file) => git(process.cwd(), 'show', `${at}:${file}`));
}

// Main's entries for the file, or null when main has no list and nothing limits the file.
function ceilingFor(file, at) {
  const committed = committedJson(file);
  if (Array.isArray(committed)) return committed;
  return file === paneOfGlassFile ? mainScreenMatches(at) : null;
}

// An entry that main justifies with an issue keeps that issue: moving it to another issue or a decision is a swap.
function swapProblem(entry, onMain) {
  if (onMain?.issue === undefined || entry.issue === onMain.issue) return null;
  const now = entry.issue === undefined ? 'decision' : `issue ${entry.issue}`;
  return `${describe(entry)}: ${now} replaces main's issue ${onMain.issue}`;
}

function growthProblems(entries, ceiling, movedAllowance) {
  const problems = [];
  for (const entry of entries) {
    const onMain = ceiling.find((each) => keyOf(each) === keyOf(entry));
    const allowed = onMain?.count ?? movedAllowance(entry);
    if (entry.count > allowed) {
      problems.push(`${describe(entry)}: count ${entry.count} is above main's ${allowed}`);
    }
    problems.push(...[swapProblem(entry, onMain)].filter(Boolean));
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
    if (!Array.isArray(entries)) {
      problems.push(`${file} must be a JSON array of entries.`);
      continue;
    }
    const ceiling = ceilingFor(file, at);
    const movedAllowance = file === paneOfGlassFile ? movedLines(ceiling, at) : () => 0;
    if (ceiling) problems.push(...growthProblems(entries, ceiling, movedAllowance));
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
