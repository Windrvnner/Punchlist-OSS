// An edit to a listed screen line changes the line's text, and so its key. An issue entry may move to the new text
// when the edit is a plain swap in the diff with main: the same file, kind and issue; the old line and the new line
// at the same position of one hunk that removes as many lines as it adds; and the old key's matches on the branch
// fallen by at least the moved count. A decision entry never moves. The moved entries together take at most what
// the old entry lost.
import { readFileSync } from 'node:fs';
import { git, keyOf } from './allowance.mjs';
import { splitLines } from './pane-of-glass-matches.mjs';
import { scanUi } from './ui-scan.mjs';

// Each hunk of the file's diff with `at` (no context lines), as its removed and added lines, trimmed.
function changedHunks(file, at) {
  const diff = git(process.cwd(), 'diff', '--unified=0', '--no-color', '--no-ext-diff', at, '--', file);
  const hunks = [];
  for (const row of splitLines(diff)) {
    if (row.startsWith('@@')) hunks.push({ removed: [], added: [] });
    else if (hunks.length && row.startsWith('-')) hunks.at(-1).removed.push(row.slice(1).trim());
    else if (hunks.length && row.startsWith('+')) hunks.at(-1).added.push(row.slice(1).trim());
  }
  return hunks;
}

// The matches of each key in the file as it is now; a file the branch deleted has none.
function branchMatches(file) {
  const read = (name) => {
    try {
      return readFileSync(name, 'utf8');
    } catch {
      return '';
    }
  };
  return new Map(scanUi([file], read).map((match) => [keyOf(match), match.count]));
}

// Main's screens carry no reason, so against them any issue may be kept; otherwise it is main's issue.
function sameIssue(entry, old) {
  if (entry.issue === undefined) return false;
  if (old.issue === undefined && old.decision === undefined) return true;
  return entry.issue === old.issue;
}

// A one-for-one swap: the old line and the new line at the same position of a hunk that adds as many as it removes.
function isSwap(hunk, oldLine, newLine) {
  if (hunk.removed.length !== hunk.added.length) return false;
  return hunk.removed.some((line, index) => line === oldLine && hunk.added[index] === newLine);
}

// Returns, for an entry main does not list, the count it may have as a moved entry, and takes that count from the
// old entry, so no old entry gives away more than its matches fell on the branch.
export function movedLines(ceiling, at) {
  const cache = new Map();
  const fileFacts = (file) => {
    if (!cache.has(file)) cache.set(file, { hunks: changedHunks(file, at), matches: branchMatches(file) });
    return cache.get(file);
  };
  const left = new Map();
  const leftOf = (old) => {
    const fallen = old.count - (fileFacts(old.file).matches.get(keyOf(old)) ?? 0);
    if (!left.has(keyOf(old))) left.set(keyOf(old), Math.max(0, fallen));
    return left.get(keyOf(old));
  };
  return (entry) => {
    const { hunks } = fileFacts(entry.file);
    const olds = ceiling.filter((old) => old.file === entry.file && old.kind === entry.kind && sameIssue(entry, old)
      && hunks.some((hunk) => isSwap(hunk, old.line, entry.line)));
    const fits = olds.find((old) => leftOf(old) >= entry.count);
    if (!fits) return Math.max(0, ...olds.map(leftOf));
    left.set(keyOf(fits), leftOf(fits) - entry.count);
    return entry.count;
  };
}
