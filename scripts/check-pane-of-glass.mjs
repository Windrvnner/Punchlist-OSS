// Keep the remaining exceptions to "The frontend is a pane of glass" in CLAUDE.md from growing.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { forbiddenSource, matchesIn } from './pane-of-glass-matches.mjs';

const baselinePath = 'scripts/pane-of-glass-baseline.json';
const lower = process.argv.includes('--lower');
const lowerCommand = 'node scripts/check-pane-of-glass.mjs --lower';
const read = (file) => readFileSync(file, 'utf8');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

function uiSource(file) {
  return file.startsWith('src/ui/') && /\.tsx?$/.test(file) && !basename(file).includes('.test.');
}

function scan(files, contents) {
  const found = {};
  const forbiddenFiles = files.filter(forbiddenSource);
  for (const file of files.filter(uiSource).sort()) {
    const lines = matchesIn(file, contents(file), forbiddenFiles);
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

function committedCounts(ref) {
  if (!git('ls-tree', '--name-only', ref, '--', baselinePath).trim()) return null;
  return JSON.parse(git('show', `${ref}:${baselinePath}`));
}

// Comparing the proposed baseline with main catches an edit that raises both the count and its allowance.
function committedBaseline() {
  for (const ref of ['origin/main', 'main']) {
    const base = spawnSync('git', ['merge-base', 'HEAD', ref], { encoding: 'utf8' });
    if (base.status !== 0) continue;
    const at = base.stdout.trim();
    const counts = committedCounts(at);
    if (counts) return counts;
    // On the branch introducing the check, main's source is the record of its existing exceptions.
    const files = git('ls-tree', '-r', '-z', '--name-only', at, '--', 'src').split('\0');
    return countsFor(scan(files, (file) => git('show', `${at}:${file}`)));
  }
  // Exported sources have no history. In a Git checkout, HEAD alone cannot prove a committed allowance is valid.
  if (spawnSync('git', ['rev-parse', '--show-toplevel']).status !== 0) return null;
  const shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true';
  const fetch = `git fetch ${shallow ? '--unshallow ' : ''}origin +refs/heads/main:refs/remotes/origin/main`;
  throw new Error(`Cannot compare the UI baseline with main. Run ${fetch} and retry.`);
}

function countProblem(count, entry, limit) {
  if (entry !== undefined && (!Number.isSafeInteger(entry) || entry <= 0)) return 'invalid baseline entry';
  const allowed = entry ?? 0;
  if (limit !== null && allowed > limit) return `the baseline cannot rise above the committed count of ${limit}`;
  if (count > allowed) return `${count} exceeds the baseline of ${allowed}`;
  if (count < allowed && !lower) return `lower the baseline in this pull request with ${lowerCommand}`;
  return null;
}

function compareFile(file, lines, baseline, committed) {
  const problems = [];
  for (const kind of new Set([...Object.keys(lines), ...Object.keys(baseline)])) {
    const matches = lines[kind] ?? [];
    const limit = committed ? (committed[kind] ?? 0) : null;
    const problem = countProblem(matches.length, baseline[kind], limit);
    if (problem) {
      const where = matches.length ? `lines ${matches.join(', ')}` : 'no matching lines';
      problems.push(`${file} ${kind} (${where}): ${problem}`);
    }
  }
  return problems;
}

const files = readdirSync('src', { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => `${entry.parentPath.replaceAll('\\', '/')}/${entry.name}`);
const found = scan(files, read);
const baseline = JSON.parse(read(baselinePath));
const committed = committedBaseline();
const problems = [];
for (const file of new Set([...Object.keys(found), ...Object.keys(baseline)])) {
  const ceiling = committed ? (committed[file] ?? {}) : null;
  problems.push(...compareFile(file, found[file] ?? {}, baseline[file] ?? {}, ceiling));
}
if (problems.length) {
  console.error(problems.join('\n'));
  console.error('See "The frontend is a pane of glass" in CLAUDE.md.');
  process.exitCode = 1;
} else if (lower) {
  writeFileSync(baselinePath, `${JSON.stringify(countsFor(found), null, 2)}\n`);
}
