// A line-by-line allowance shared by the safeguard checks: each match the check finds must be listed with a reason.
import { execFileSync, spawnSync } from 'node:child_process';

const platforms = ['linux', 'win32'];
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
// A skipped test is listed once for each platform it is skipped on.
const keyOf = ({ file, kind, line, platform }) =>
  JSON.stringify(kind === 'skipped' ? [file, kind, line, platform] : [file, kind, line]);
const describe = ({ file, kind, line }) => `${file} ${kind} "${line}"`;

export function groupMatches(matches) {
  const grouped = new Map();
  for (const { file, kind, line, platform } of matches) {
    const entry = { file, kind, line: line.trim(), count: 0 };
    if (platform !== undefined) entry.platform = platform;
    const known = grouped.get(keyOf(entry)) ?? entry;
    known.count += 1;
    grouped.set(keyOf(entry), known);
  }
  const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...grouped.values()].sort((a, b) => text(a.file, b.file) || text(a.kind, b.kind) || text(a.line, b.line));
}

// Each "- " entry of decisions.md, with its indented continuation lines joined by single spaces.
export function decisionEntries(markdown) {
  const entries = [];
  for (const row of markdown.split(/\r?\n/)) {
    if (row.startsWith('- ')) entries.push(row.slice(2).trim());
    else if (/^\s+\S/.test(row) && entries.length) entries[entries.length - 1] += ` ${row.trim()}`;
  }
  return entries;
}

function shapeProblem(entry) {
  const hasIssue = Number.isSafeInteger(entry.issue) && entry.issue > 0;
  const hasDecision = typeof entry.decision === 'string' && entry.decision !== '';
  if (hasIssue === hasDecision) return 'needs exactly one of issue or decision';
  if (!Number.isSafeInteger(entry.count) || entry.count <= 0) return 'needs a positive count';
  if (entry.kind !== 'skipped') return null;
  if (!platforms.includes(entry.platform)) return `needs a platform of ${platforms.join(' or ')}`;
  if (typeof entry.reason !== 'string' || entry.reason === '') return 'needs a reason';
  return null;
}

function decisionProblem(entry, decisions, verified) {
  if (entry.decision === undefined) return null;
  if (!verified.includes(entry.decision)) return 'decision is not on scripts/verified-decisions.json';
  if (decisions.includes(entry.decision)) return null;
  return 'decision is not word for word in docs/decisions.md';
}

function countProblem(entry, seen) {
  if (seen === 0) return 'no match: remove this entry';
  if (seen < entry.count) return `lower the count to ${seen}`;
  return null;
}

// `scope(entry)` says whether this run could have seen the entry; only then is an unmatched entry a problem.
export function allowanceProblems(found, allowance, { decisions, verified, scope = () => true }) {
  const problems = [];
  const listed = new Set();
  for (const entry of allowance) {
    const duplicate = listed.has(keyOf(entry)) ? 'is listed twice' : null;
    listed.add(keyOf(entry));
    const problem = shapeProblem(entry) ?? duplicate ?? decisionProblem(entry, decisions, verified);
    if (problem) problems.push(`${describe(entry)}: ${problem}`);
  }
  const counts = new Map(found.map((match) => [keyOf(match), match.count]));
  for (const match of found) {
    const allowed = allowance.find((entry) => keyOf(entry) === keyOf(match))?.count ?? 0;
    if (match.count > allowed) problems.push(`${describe(match)}: ${match.count - allowed} not listed`);
  }
  for (const entry of allowance.filter(scope)) {
    const seen = counts.get(keyOf(entry)) ?? 0;
    const problem = seen > entry.count ? null : countProblem(entry, seen);
    if (problem) problems.push(`${describe(entry)}: ${problem}`);
  }
  return problems;
}

// The file at the merge base of HEAD with main, or null when it is absent there or there is no Git checkout.
export function committedJson(path, cwd = process.cwd()) {
  for (const ref of ['origin/main', 'main']) {
    const base = spawnSync('git', ['merge-base', 'HEAD', ref], { cwd, encoding: 'utf8' });
    if (base.status !== 0) continue;
    const at = base.stdout.trim();
    if (!git(cwd, 'ls-tree', '--name-only', at, '--', path).trim()) return null;
    return JSON.parse(git(cwd, 'show', `${at}:${path}`));
  }
  // Exported sources have no history. In a Git checkout, HEAD alone cannot prove an allowance is valid.
  if (spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd }).status !== 0) return null;
  const shallow = git(cwd, 'rev-parse', '--is-shallow-repository').trim() === 'true';
  const fetch = `git fetch ${shallow ? '--unshallow ' : ''}origin +refs/heads/main:refs/remotes/origin/main`;
  throw new Error(`Cannot compare with main. Run ${fetch} and retry.`);
}
