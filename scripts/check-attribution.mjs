// Fails when a tracked text file or a commit message of this branch holds AI-tool attribution: a trailer, a header,
// or a link to an AI chat session (aiAttribution.mjs lists them), or person attribution: a decision credited to a
// person or an email address (personAttribution.mjs). Prints file names and commit ids only.
// Files are read as committed in HEAD. Commits are those the branch adds to main, and so is the text they add, even
// text a later commit removed; on main itself (none added) the messages of the latest 200. Without main it fails.
import { execFileSync } from 'node:child_process';
import { git } from './allowance.mjs';
import { aiAttributionIn } from './aiAttribution.mjs';
import { addedText, branchRange } from './branch-commits.mjs';
import { personAttributionIn } from './personAttribution.mjs';

const cwd = process.cwd();
const foundIn = (text, file) => [...aiAttributionIn(text), ...personAttributionIn(text, file)];

// The committed content of every blob in HEAD, read with one `git cat-file --batch`, not from the working tree.
// A batch answer is "<id> <type> <size>\n", the content, and a newline.
function committedFiles() {
  const entries = git(cwd, 'ls-tree', '-r', '-z', 'HEAD')
    .split('\0')
    .filter(Boolean)
    .map((row) => /^\d+ (\w+) ([0-9a-f]+)\t(.*)$/s.exec(row))
    .filter((entry) => entry[1] === 'blob');
  const input = entries.map((entry) => `${entry[2]}\n`).join('');
  const answer = execFileSync('git', ['cat-file', '--batch'], { cwd, input, maxBuffer: 512 * 1024 * 1024 });
  const files = [];
  let at = 0;
  for (const entry of entries) {
    const lineEnd = answer.indexOf('\n', at);
    const size = Number(answer.subarray(at, lineEnd).toString().split(' ')[2]);
    files.push({ file: entry[3], content: answer.subarray(lineEnd + 1, lineEnd + 1 + size) });
    at = lineEnd + size + 2;
  }
  return files;
}

const isText = (buffer) => !buffer.subarray(0, 8000).includes(0);

function fileProblems() {
  const problems = [];
  for (const { file, content } of committedFiles()) {
    const found = isText(content) ? foundIn(content.toString('utf8'), file) : [];
    if (found.length) problems.push(`${file} holds ${found.join(', ')}`);
  }
  return problems;
}

// What the branch's commits add, even text a later commit removed. A wrapped phrase needs the whole added text.
function addedProblems(range) {
  return addedText(range).flatMap(({ sha, file, text }) => {
    const found = foundIn(text, file);
    return found.length ? [`${file} holds ${found.join(', ')}, added in ${sha.slice(0, 10)}`] : [];
  });
}

// Messages of commits this branch adds to main, or the latest 200 on main itself.
function commitProblems(range) {
  const log = git(cwd, 'log', range ?? '-200', '--format=%H%x00%B%x01');
  const records = log.split('\x01').map((record) => record.replace(/^\n/, '')).filter(Boolean);
  return records.flatMap((record) => {
    const [sha, message] = record.split('\0');
    const found = [...aiAttributionIn(message), ...personAttributionIn(message)];
    return found.length ? [`commit ${sha.slice(0, 10)} holds ${found.join(', ')}`] : [];
  });
}

function allProblems() {
  const range = branchRange(cwd);
  return [...fileProblems(), ...(range ? addedProblems(range) : []), ...commitProblems(range)];
}

let problems;
try {
  problems = allProblems();
} catch (error) {
  // A failed git command carries its own output, which may hold the text found, so only our own messages are printed.
  const ours = error instanceof Error && error.stderr === undefined;
  problems = [ours ? error.message : 'the files or history could not be read to check'];
}
if (problems.length) {
  const refused = 'Refused: no AI-tool trailers, headers, chat-session links, credit to a person, or email addresses.';
  console.error(`${refused}\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
