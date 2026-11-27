// What the commits of this branch add, for the checks that must also see text a later commit removed.
import { git, mergeBase } from './allowance.mjs';

// The commits this branch adds to main (`<merge-base>..HEAD`), or null when it adds none or this is no Git checkout.
// Without main the check cannot tell what the branch adds, so mergeBase throws with the command that fetches it.
export function branchRange(cwd = process.cwd()) {
  const base = mergeBase(cwd);
  if (base === null || base === git(cwd, 'rev-parse', 'HEAD').trim()) return null;
  return `${base}..HEAD`;
}

// One chunk of `git log` output for each commit; a binary file read as text may hold a NUL, so a chunk that does not
// start with a commit id continues the one before it.
function commitChunks(log) {
  const chunks = [];
  for (const piece of log.split('\0').slice(1)) {
    if (/^[0-9a-f]{40}\n/.test(piece) || chunks.length === 0) chunks.push(piece);
    else chunks[chunks.length - 1] += `\0${piece}`;
  }
  return chunks;
}

// The text each file of one commit adds. A hunk header has one '@' more than the commit has parents, and a line counts
// as added only when it is new against every parent, so a merge shows what its resolution wrote and nothing else.
function addedByFile(chunk) {
  const files = new Map();
  let file = null;
  let columns = 0;
  for (const row of chunk.slice(chunk.indexOf('\n') + 1).split('\n')) {
    const hunk = /^(@{2,}) /.exec(row);
    if (hunk) columns = hunk[1].length - 1;
    else if (row.startsWith('diff ')) columns = 0;
    const header = columns === 0 && /^\+\+\+ b\/(.*)$/.exec(row);
    if (header) file = header[1];
    else if (columns > 0 && !hunk && row.slice(0, columns) === '+'.repeat(columns)) {
      if (!files.has(file)) files.set(file, []);
      files.get(file).push(row.slice(columns));
    }
  }
  return files;
}

// One item for each commit and file in the range: the lines it adds, joined with newlines.
export function addedText(range, cwd = process.cwd()) {
  const log = git(cwd, 'log', '-p', '--cc', '--text', '--no-color', '--no-ext-diff', '--format=%x00%H', range);
  const added = [];
  for (const chunk of commitChunks(log)) {
    const sha = chunk.slice(0, 40);
    for (const [file, lines] of addedByFile(chunk)) added.push({ sha, file, text: lines.join('\n') });
  }
  return added;
}

// The files each commit in the range adds, including those a later commit deletes.
export function addedFiles(range, cwd = process.cwd()) {
  const log = git(cwd, '-c', 'core.quotepath=off', 'log', '--diff-filter=A', '--name-only', '--format=%x00%H', range);
  return commitChunks(log).flatMap((chunk) => {
    const [sha, ...names] = chunk.split('\n');
    return names.filter(Boolean).map((file) => ({ sha, file }));
  });
}
