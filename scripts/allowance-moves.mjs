// An edit to a listed screen line changes the line's text, and so its key. The entry may move to the new text when
// the edit is plain in the diff with main: the same file, kind and reason, the old text gone from the file, and the
// old line removed and the new line added in one hunk. The moved entries together take at most the old count.
import { existsSync, readFileSync } from 'node:fs';
import { git, keyOf } from './allowance.mjs';
import { splitLines } from './pane-of-glass-matches.mjs';

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

// Main's screens carry no reason, so an entry of that ceiling may keep any reason; otherwise the reason is kept.
function sameReason(entry, old) {
  if (old.issue === undefined && old.decision === undefined) return true;
  return entry.issue === old.issue && entry.decision === old.decision;
}

function trimmedLines(file) {
  return existsSync(file) ? splitLines(readFileSync(file, 'utf8')).map((row) => row.trim()) : [];
}

function isEditOf(entry, old, hunks, lines) {
  if (old.file !== entry.file || old.kind !== entry.kind || !sameReason(entry, old)) return false;
  if (lines.includes(old.line)) return false;
  return hunks.some((hunk) => hunk.removed.includes(old.line) && hunk.added.includes(entry.line));
}

// Returns, for an entry main does not list, the count it may have as a moved entry, and takes that count from the
// old entry so that no old entry is moved beyond its count.
export function movedLines(ceiling, at) {
  const left = new Map(ceiling.map((old) => [keyOf(old), old.count]));
  return (entry) => {
    const hunks = changedHunks(entry.file, at);
    const lines = trimmedLines(entry.file);
    const olds = ceiling.filter((old) => isEditOf(entry, old, hunks, lines));
    const fits = olds.find((old) => left.get(keyOf(old)) >= entry.count);
    if (!fits) return Math.max(0, ...olds.map((old) => left.get(keyOf(old))));
    left.set(keyOf(fits), left.get(keyOf(fits)) - entry.count);
    return entry.count;
  };
}
