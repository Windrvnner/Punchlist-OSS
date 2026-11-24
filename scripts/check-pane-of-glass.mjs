// Keep the remaining exceptions to "The frontend is a pane of glass" in CLAUDE.md from growing.
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { privatePath, projectLinks } from './pane-of-glass-project-links.mjs';
import { treeEntries } from './pane-of-glass-snapshot.mjs';
import { matchesIn } from './pane-of-glass-matches.mjs';

const baselinePath = 'scripts/pane-of-glass-baseline.json';
const lower = process.argv.includes('--lower');
const lowerCommand = 'node scripts/check-pane-of-glass.mjs --lower';
const read = (file) => readFileSync(file, 'utf8');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

function uiSource(file) {
  return file.startsWith('src/ui/') && /\.tsx?$/.test(file) && !basename(file).includes('.test.');
}

async function scan(inventory, contents) {
  const found = {};
  for (const file of inventory.files.filter(uiSource).sort()) {
    const lines = await matchesIn(file, contents(file), inventory);
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

function committedSources(at) {
  const files = [];
  const links = new Map();
  for (const record of git('ls-tree', '-r', '-z', at).split('\0').filter(Boolean)) {
    const file = record.slice(record.indexOf('\t') + 1);
    if (record.startsWith('120000 ') && !privatePath(file)) links.set(file, git('show', `${at}:${file}`));
    else if (file.startsWith('src/') && record.startsWith('100')) files.push(file);
  }
  return { files, links };
}

// Comparing the proposed baseline with main catches an edit that raises both the count and its allowance.
async function committedBaseline() {
  for (const ref of ['origin/main', 'main']) {
    const base = spawnSync('git', ['merge-base', 'HEAD', ref], { encoding: 'utf8' });
    if (base.status !== 0) continue;
    const at = base.stdout.trim();
    const counts = committedCounts(at);
    if (counts) return counts;
    // On the branch introducing the check, main's source is the record of its existing exceptions.
    return countsFor(await scan(committedSources(at), (file) => git('show', `${at}:${file}`)));
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

const files = [];
const links = new Map();
for (const { file, entry } of treeEntries('src')) {
  const name = file.replaceAll('\\', '/');
  if (entry.isFile()) files.push(name);
  if (entry.isSymbolicLink()) links.set(name, readlinkSync(file));
}
// An internal link can pass through another tracked directory before returning to src.
function linkAt(file) {
  if (privatePath(file)) return;
  if (links.has(file)) return links.get(file);
  if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return readlinkSync(file);
}
let allLinks;
const liveLinks = () => (allLinks ??= projectLinks(links));
const found = await scan({ files, links, linkAt, liveLinks }, read);
const baseline = JSON.parse(read(baselinePath));
const committed = await committedBaseline();
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
