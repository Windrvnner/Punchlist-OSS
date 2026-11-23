// Fails when a tracked text file or a commit message of this branch holds AI-tool attribution: a trailer, a header,
// or a link to an AI chat session (aiAttribution.mjs lists them). Prints file names and commit ids only.
// Commits are those the branch adds to main; with no main to compare with, or none added (on main itself), the
// latest 200.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { aiAttributionIn } from './aiAttribution.mjs';

const options = { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] };
const git = (...args) => execFileSync('git', args, options);

function isText(buffer) {
  return !buffer.subarray(0, 8000).includes(0);
}

function fileProblems() {
  const problems = [];
  for (const file of git('ls-files', '-z').toString().split('\0').filter(Boolean)) {
    const content = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (!content || !isText(content)) continue;
    const found = aiAttributionIn(content.toString('utf8'));
    if (found.length) problems.push(`${file} holds ${found.join(', ')}`);
  }
  return problems;
}

/** The commits this branch adds to main, or the latest 200 when there is no main here or the branch adds none. */
function commitRange() {
  for (const main of ['origin/main', 'main']) {
    try {
      const range = `${git('merge-base', 'HEAD', main).toString().trim()}..HEAD`;
      if (git('rev-list', '--count', range).toString().trim() !== '0') return [range];
    } catch {
      // try the next name
    }
  }
  return ['-200'];
}

function commitProblems() {
  const log = git('log', ...commitRange(), '--format=%H%x00%B%x01').toString();
  const records = log.split('\x01').map((record) => record.replace(/^\n/, '')).filter(Boolean);
  return records.flatMap((record) => {
    const [sha, message] = record.split('\0');
    const found = aiAttributionIn(message);
    return found.length ? [`commit ${sha.slice(0, 10)} holds ${found.join(', ')}`] : [];
  });
}

const problems = [...fileProblems(), ...commitProblems()];
if (problems.length) {
  console.error(`Refused: no AI-tool trailers, headers, or chat-session links.\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
