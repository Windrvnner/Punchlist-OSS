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
import { allowanceProblems, decisionEntries } from './allowance.mjs';
import { slashPath } from './pane-of-glass-matches.mjs';
import { scanUi } from './ui-scan.mjs';

const baselinePath = 'scripts/pane-of-glass-baseline.json';
const read = (file) => readFileSync(file, 'utf8');
const limits = [
  'Rules written as plain if logic on state are not visible to this check; review covers them.',
  'Also not visible: Math.min and Math.max; .flatMap, .at and .includes; Intl and toLocale...String;',
  'requestAnimationFrame; a limit given by a named constant (including changing its value); a swap between',
  'identical trimmed lines; edits inside a loop body.',
  'See "The frontend is a pane of glass" in CLAUDE.md.',
];

function lowered(allowance, found) {
  const seen = new Map(found.map(({ file, kind, line, count }) => [JSON.stringify([file, kind, line]), count]));
  return allowance
    .map((entry) => {
      const matches = seen.get(JSON.stringify([entry.file, entry.kind, entry.line])) ?? 0;
      return { ...entry, count: Math.min(entry.count, matches) };
    })
    .filter((entry) => entry.count > 0);
}

function unlisted(found, allowance) {
  const same = (a, b) => a.file === b.file && a.kind === b.kind && a.line === b.line;
  return found.filter((match) => match.count > (allowance.find((entry) => same(entry, match))?.count ?? 0));
}

function verify(found, allowance) {
  const decisions = decisionEntries(read('docs/decisions.md'));
  const verified = JSON.parse(read('scripts/verified-decisions.json'));
  return allowanceProblems(found, allowance, { decisions, verified, scope: () => true });
}

function fail(problems) {
  console.error([...problems, ...limits].join('\n'));
  process.exitCode = 1;
}

const files = readdirSync('src/ui', { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => slashPath(entry.parentPath, entry.name))
  .sort();
const found = scanUi(files, read);
const allowance = JSON.parse(read(baselinePath));
if (!Array.isArray(allowance)) {
  fail([`${baselinePath} must be a JSON array of entries.`]);
} else if (process.argv.includes('--list')) {
  const missing = unlisted(found, allowance);
  console.log(JSON.stringify(missing.map(({ file, kind, line, count }) => ({ file, kind, line, count })), null, 2));
  if (missing.length) process.exitCode = 1;
} else {
  const lower = process.argv.includes('--lower');
  const next = lower ? lowered(allowance, found) : allowance;
  const problems = verify(found, next);
  if (problems.length) fail(problems);
  else if (lower) writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log('Issues named in the allowances are checked as open by CI (scripts/check-open-issues.mjs).');
}
