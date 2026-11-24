// Keep the remaining exceptions to "The frontend is a pane of glass" in CLAUDE.md from growing.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { matchesIn } from './pane-of-glass-matches.mjs';

const baselinePath = 'scripts/pane-of-glass-baseline.json';
const lower = process.argv.includes('--lower');
const lowerCommand = 'node scripts/check-pane-of-glass.mjs --lower';
const read = (file) => readFileSync(file, 'utf8');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

function uiSource(file) {
  return /\.tsx?$/.test(file) && !basename(file).includes('.test.');
}

function scan(files, contents) {
  const found = {};
  for (const file of files.filter(uiSource).sort()) {
    const lines = matchesIn(file, contents(file));
    if (Object.keys(lines).length) found[file] = lines;
  }
  return found;
}

function countsFor(found) {
  const counts = {};
  for (const [file, kinds] of Object.entries(found)) {
    counts[file] = Object.fromEntries(Object.entries(kinds).map(([kind, lines]) => [kind, lines.length]));
  }
  return counts;
}

// Comparing the proposed baseline with main catches an edit that raises both the count and its allowance.
function mainBaseline() {
  for (const ref of ['origin/main', 'main']) {
    const base = spawnSync('git', ['merge-base', 'HEAD', ref], { encoding: 'utf8' });
    if (base.status !== 0) continue;
    const at = base.stdout.trim();
    const contents = (file) => git('show', `${at}:${file}`);
    if (git('ls-tree', '--name-only', at, '--', baselinePath).trim()) return JSON.parse(contents(baselinePath));
    // On the branch introducing the check, main's source is the record of its existing exceptions.
    const files = git('ls-tree', '-r', '-z', '--name-only', at, '--', 'src/ui').split('\0');
    return countsFor(scan(files, contents));
  }
  return null;
}

function compareFile(file, lines, baseline, main) {
  const problems = [];
  for (const kind of new Set([...Object.keys(lines), ...Object.keys(baseline)])) {
    const matches = lines[kind] ?? [];
    const allowed = baseline[kind] ?? 0;
    const where = matches.length ? `lines ${matches.join(', ')}` : 'no matching lines';
    const details = `${file} ${kind} (${where})`;
    if (kind in baseline && (!Number.isSafeInteger(allowed) || allowed <= 0)) {
      problems.push(`${details}: invalid baseline entry`);
    } else if (main && allowed > (main[kind] ?? 0)) {
      problems.push(`${details}: the baseline cannot rise above main's count of ${main[kind] ?? 0}`);
    } else if (matches.length > allowed) {
      problems.push(`${details}: ${matches.length} exceeds the baseline of ${allowed}`);
    } else if (matches.length < allowed && !lower) {
      problems.push(`${details}: lower the baseline in this pull request with ${lowerCommand}`);
    }
  }
  return problems;
}

const files = readdirSync('src/ui', { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`);
const found = scan(files, read);
const baseline = JSON.parse(read(baselinePath));
const main = mainBaseline();
const problems = [];
for (const file of new Set([...Object.keys(found), ...Object.keys(baseline)])) {
  problems.push(...compareFile(file, found[file] ?? {}, baseline[file] ?? {}, main ? (main[file] ?? {}) : null));
}
if (problems.length) {
  console.error(problems.join('\n'));
  console.error('See "The frontend is a pane of glass" in CLAUDE.md.');
  process.exitCode = 1;
} else if (lower) {
  writeFileSync(baselinePath, `${JSON.stringify(countsFor(found), null, 2)}\n`);
}
