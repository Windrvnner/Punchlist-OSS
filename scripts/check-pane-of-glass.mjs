// Keep "The frontend is a pane of glass" in CLAUDE.md true: every access the check finds in a screen is listed line
// by line in scripts/pane-of-glass-baseline.json, with the issue that removes it or the decision that keeps it.
//
// It catches only the syntax forms that scripts/pane-of-glass-rules.mjs and pane-of-glass-matches.mjs list. Any other
// method, property or construct is review's job (docs/development.md).
//
// `--lower` lowers each entry's count to its matches and removes unmatched entries; it never adds an entry.
// `--list` prints the groups not yet listed, as entries without an issue or decision.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { allowanceProblems, decisionEntries, entryProblems, lowerAllowance, unlistedMatches } from './allowance.mjs';
import { slashPath } from './pane-of-glass-matches.mjs';
import { scanUi } from './ui-scan.mjs';

const baselinePath = 'scripts/pane-of-glass-baseline.json';
const read = (file) => readFileSync(file, 'utf8');
const openIssuesNotice = 'Issues named in the allowances are checked as open by CI (scripts/check-open-issues.mjs).';
const limits = [
  'Only the syntax forms listed in docs/development.md are caught. Any other method, property or construct is',
  "review's job: for example .map, .flatMap, .includes, .join, .concat, .at, .replace without a regex, .split,",
  '.trim, .startsWith, .pop, .shift, Array.from, new Set, a bare .length read, Math.min, Math.max, a method name held',
  'in a variable, Function.prototype.call, destructured length or Date.parse, performance.now, queueMicrotask, plain',
  'if logic on state, references that are not called, and named constants.',
  'See "The frontend is a pane of glass" in CLAUDE.md.',
  openIssuesNotice,
];

function decisionLists() {
  return {
    decisions: decisionEntries(read('docs/decisions.md')),
    verified: JSON.parse(read('scripts/verified-decisions.json')),
  };
}

function fail(problems) {
  console.error([...problems, ...limits].join('\n'));
  process.exitCode = 1;
}

// --lower first refuses a malformed entry, so none is dropped unseen; then it lowers and checks again.
function lowerAndWrite(allowance) {
  const { decisions, verified } = decisionLists();
  const malformed = entryProblems(allowance, decisions, verified);
  const next = lowerAllowance(found, allowance);
  const problems = malformed.length ? malformed : allowanceProblems(found, next, { decisions, verified });
  if (problems.length) fail(problems);
  else writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
}

function readAllowance() {
  try {
    return JSON.parse(read(baselinePath));
  } catch (error) {
    return `${baselinePath} is not valid JSON: ${error.message}`;
  }
}

// A symbolic link to a file is scanned as the file it points to.
const isFileOrLinkToOne = (entry) =>
  entry.isFile() || (entry.isSymbolicLink() && statSync(path.join(entry.parentPath, entry.name)).isFile());
const files = readdirSync('src/ui', { recursive: true, withFileTypes: true })
  .filter(isFileOrLinkToOne)
  .map((entry) => slashPath(entry.parentPath, entry.name))
  .sort();
const found = scanUi(files, read);
const allowance = readAllowance();
if (typeof allowance === 'string') {
  fail([allowance]);
} else if (!Array.isArray(allowance)) {
  fail([`${baselinePath} must be a JSON array of entries.`]);
} else if (process.argv.includes('--list')) {
  const missing = unlistedMatches(found, allowance);
  const entries = missing.map(({ file, kind, line, missing: count }) => ({ file, kind, line, count }));
  console.log(JSON.stringify(entries, null, 2));
  console.error(openIssuesNotice);
  if (missing.length) process.exitCode = 1;
} else {
  if (process.argv.includes('--lower')) {
    lowerAndWrite(allowance);
  } else {
    const problems = allowanceProblems(found, allowance, { ...decisionLists(), scope: () => true });
    if (problems.length) fail(problems);
  }
  if (!process.exitCode) console.log(openIssuesNotice);
}
