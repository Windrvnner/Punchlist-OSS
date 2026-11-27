// Keep "The frontend is a pane of glass" in CLAUDE.md true: every access the check finds in a screen is listed line
// by line in scripts/pane-of-glass-baseline.json, with the issue that removes it.
//
// What this check cannot see: plain `if` logic on state; Math.min and Math.max; .flatMap, .at and .includes; Intl and
// toLocale...String; requestAnimationFrame; a limit given by a named constant (including changing its value); a swap
// between identical trimmed lines; edits inside a loop body. Review covers them.
//
// `--lower` lowers each entry's count to its matches and removes unmatched entries; it never adds an entry.
// `--list` prints the groups not yet listed, as entries without an issue or decision.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { allowanceProblems, decisionEntries, entryProblems, lowerAllowance, unlistedMatches } from './allowance.mjs';
import { slashPath } from './pane-of-glass-matches.mjs';
import { scanUi } from './ui-scan.mjs';

const baselinePath = 'scripts/pane-of-glass-baseline.json';
const read = (file) => readFileSync(file, 'utf8');
const openIssuesNotice = 'Issues named in the allowances are checked as open by CI (scripts/check-open-issues.mjs).';
const limits = [
  'Rules written as plain if logic on state are not visible to this check; review covers them.',
  'Also not visible: Math.min and Math.max; .flatMap, .at and .includes; Intl and toLocale...String;',
  'requestAnimationFrame; a limit given by a named constant (including changing its value); a swap between',
  'identical trimmed lines; edits inside a loop body; references that are not called (`const f = Date.now`,',
  '`rows.sort` passed as a value).',
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

const files = readdirSync('src/ui', { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
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
