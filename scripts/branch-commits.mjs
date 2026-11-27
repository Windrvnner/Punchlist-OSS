// What the commits of this branch add, for the checks that must also see text a later commit removed.
import { git, mergeBase } from './allowance.mjs';

// The commits this branch adds to main (`<merge-base>..HEAD`), or null when it adds none or this is no Git checkout.
// Without main the check cannot tell what the branch adds, so mergeBase throws with the command that fetches it.
export function branchRange(cwd = process.cwd()) {
  const base = mergeBase(cwd);
  if (base === null || base === git(cwd, 'rev-parse', 'HEAD').trim()) return null;
  return `${base}..HEAD`;
}

// Starts each commit in `git log` output. A binary file read as text could hold a NUL, so a chunk counts as a commit
// only when the marker is followed by a full commit id and a newline.
const COMMIT_MARK = '\0COMMIT\0';
const FORMAT = '--format=%x00COMMIT%x00%H';

function commitChunks(log) {
  const chunks = [];
  for (const piece of log.split(COMMIT_MARK).slice(1)) {
    if (/^[0-9a-f]{40}\n/.test(piece) || chunks.length === 0) chunks.push(piece);
    else chunks[chunks.length - 1] += `${COMMIT_MARK}${piece}`;
  }
  return chunks;
}

const ESCAPES = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '"': '"', '\\': '\\',
};

// A file name as git prints it: plain, or in double quotes with C escapes (quote, tab, newline, octal bytes).
function unquote(name) {
  if (!name.startsWith('"')) return name;
  const bytes = [];
  const body = name.slice(1, -1);
  for (let at = 0; at < body.length; at += 1) {
    const escaped = body[at] === '\\';
    const octal = escaped && /^[0-7]{3}/.exec(body.slice(at + 1));
    if (octal) bytes.push(Number.parseInt(octal[0], 8));
    else bytes.push(...Buffer.from(escaped ? ESCAPES[body[at + 1]] : body[at]));
    if (octal) at += 3;
    else if (escaped) at += 1;
  }
  return Buffer.from(bytes).toString('utf8');
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
    const header = columns === 0 && /^\+\+\+ (b\/[^\t]*|"b\/.*")\t?$/.exec(row);
    if (header) file = unquote(header[1]).replace(/^b\//, '');
    else if (columns > 0 && !hunk && row.slice(0, columns) === '+'.repeat(columns)) {
      if (!files.has(file)) files.set(file, []);
      files.get(file).push(row.slice(columns));
    }
  }
  return files;
}

// One item for each commit and file in the range: the lines it adds, joined with newlines.
export function addedText(range, cwd = process.cwd()) {
  const log = git(cwd, 'log', '-p', '--cc', '--text', '--no-color', '--no-ext-diff', FORMAT, range);
  const added = [];
  for (const chunk of commitChunks(log)) {
    const sha = chunk.slice(0, 40);
    for (const [file, lines] of addedByFile(chunk)) added.push({ sha, file, text: lines.join('\n') });
  }
  return added;
}

// A name-status row that gives a file a name: added, copied or renamed (the new name is last). A merge row has one
// letter for each parent, and counts only when every parent lacks the file.
function newName(row) {
  const [status, ...names] = row.split('\t');
  const letters = status.replace(/\d+/g, '');
  return letters !== '' && /^[ACR]+$/.test(letters) ? unquote(names[names.length - 1]) : null;
}

// The files each commit in the range gives a name, including those a later commit deletes or renames away.
export function addedFiles(range, cwd = process.cwd()) {
  const log = git(cwd, 'log', '--cc', '-M', '-C', '--name-status', FORMAT, range);
  return commitChunks(log).flatMap((chunk) => {
    const [sha, ...rows] = chunk.split('\n');
    return rows.map(newName).filter((file) => file !== null).map((file) => ({ sha, file }));
  });
}
