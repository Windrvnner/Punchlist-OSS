// Readability hints for the code a branch changes (CLAUDE.md, "Readable code"). Lists the changed lines over
// 120 characters and the new functions Biome finds too complex. It only reports: it never fails the check,
// whatever goes wrong, and code the branch did not touch is never listed. It also lists the added lines in `src/`
// that name a guess (CLAUDE.md, "Do the simplest thing"), so a reviewer asks what decision asks for each.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LINE = 120;
const MAX_LISTED = 40; // a long list helps nobody; the first ones show where to look
const COMPLEXITY_RULE = 'complexity/noExcessiveCognitiveComplexity';
// Words that mark a guess: a threshold, a fallback, a similarity, a normalization or a repair of text.
const GUESS_WORDS = /overlap|similar|fuzzy|normali[sz]|guess|heuristic|threshold|fallback|repair/i;
const CODE_FILE = /\.(ts|tsx|mjs|js)$/;
// Code Biome lints: src, tests and scripts, and files at the top of the repo, but not the test fixtures.
const LINTED = /^(src\/|tests\/|scripts\/|[^/]+$)/;
const NOT_LINTED = /^tests\/fixtures\//;
// A large cleanup's diff runs to many megabytes; Node's default of 1 MB would cut it off.
const OUTPUT_LIMIT = 512 * 1024 * 1024;

function run(command, args) {
  const options = { encoding: 'utf8', maxBuffer: OUTPUT_LIMIT, stdio: ['ignore', 'pipe', 'ignore'] };
  return execFileSync(command, args, options);
}

// Fixed prefixes and unquoted names, whatever the person's own git settings say.
function git(...args) {
  return run('git', ['-c', 'core.quotePath=false', ...args]);
}

/** Where this branch left main, or null when there is no main to compare with (a fresh clone, say). */
function branchBase() {
  for (const main of ['origin/main', 'main']) {
    try {
      return git('merge-base', 'HEAD', main).trim();
    } catch {
      // try the next name
    }
  }
  return null;
}

function isCheckedCode(path) {
  return CODE_FILE.test(path) && LINTED.test(path) && !NOT_LINTED.test(path);
}

/** The path a diff's `+++ b/…` line names, or null for a deleted file. Git ends a name holding a space with a tab. */
function newPath(header) {
  const path = header.slice(4).replace(/\t$/, '');
  return path.startsWith('b/') ? path.slice(2) : null;
}

/** The numbers of the lines a hunk header (`@@ -a,b +c,d @@`) says were added or changed. */
function hunkLines(header) {
  const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!hunk) return [];
  const first = Number(hunk[1]);
  const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
  return Array.from({ length: count }, (_, i) => first + i);
}

/** For each changed code file, the numbers of the lines added or changed since `base`, uncommitted work included. */
function changedLines(base) {
  const diff = git('diff', '-U0', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', base);
  const changed = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const path = newPath(line);
      file = path && isCheckedCode(path) ? path : null;
    } else if (file && line.startsWith('@@ ')) {
      addLines(changed, file, hunkLines(line));
    }
  }
  return changed;
}

function addLines(changed, file, numbers) {
  if (!changed.has(file)) changed.set(file, new Set());
  for (const n of numbers) changed.get(file).add(n);
}

/** Files nobody has added to git yet: every line of them is new. */
function addUntracked(changed) {
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(isCheckedCode);
  for (const file of untracked) {
    const count = readLines(file).length;
    addLines(changed, file, Array.from({ length: count }, (_, i) => i + 1));
  }
}

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return []; // deleted since the diff was taken
  }
}

/** Added lines in `src/` that name a guess. A list for the reviewer to question, not a verdict. */
function guessLines(changed) {
  const found = [];
  for (const [file, lines] of changed) {
    if (!file.startsWith('src/')) continue;
    const text = readLines(file);
    for (const n of lines) {
      if (GUESS_WORDS.test(text[n - 1] ?? '')) found.push(`${file}:${n}  ${text[n - 1].trim().slice(0, 80)}`);
    }
  }
  return found;
}

function longLines(changed) {
  const found = [];
  for (const [file, lines] of changed) {
    const text = readLines(file);
    for (const n of lines) {
      const length = text[n - 1]?.length ?? 0;
      if (length > MAX_LINE) found.push(`${file}:${n}  ${length} characters`);
    }
  }
  return found;
}

/** Biome's complexity findings for the given files, as JSON diagnostics. Biome is run with Node, as on Windows. */
function complexityDiagnostics(files) {
  const biome = join('node_modules', '@biomejs', 'biome', 'bin', 'biome');
  const args = [biome, 'lint', `--only=${COMPLEXITY_RULE}`, '--reporter=json', '--max-diagnostics=none', ...files];
  let report;
  try {
    report = run(process.execPath, args);
  } catch (e) {
    report = e.stdout ?? ''; // Biome exits non-zero when it has findings
  }
  return JSON.parse(report).diagnostics ?? [];
}

/** New functions that are too complex: those whose name line the branch added or changed. */
function complexFunctions(changed) {
  const files = [...changed.keys()];
  if (files.length === 0) return [];
  let diagnostics;
  try {
    diagnostics = complexityDiagnostics(files);
  } catch {
    return ['(Biome could not be asked about complexity)'];
  }
  return diagnostics
    .filter((d) => d.category === `lint/${COMPLEXITY_RULE}`)
    .map((d) => ({ file: d.location.path.replaceAll('\\', '/'), line: d.location.start.line, message: d.message }))
    .filter((d) => changed.get(d.file)?.has(d.line))
    .map((d) => `${d.file}:${d.line}  ${d.message}`);
}

function list(title, items) {
  if (items.length === 0) return;
  console.log(`\n${title} (${items.length})`);
  for (const item of items.slice(0, MAX_LISTED)) console.log(`  ${item}`);
  if (items.length > MAX_LISTED) console.log(`  and ${items.length - MAX_LISTED} more`);
}

function main() {
  process.chdir(git('rev-parse', '--show-toplevel').trim());
  const base = branchBase();
  if (!base) return;
  const changed = changedLines(base);
  addUntracked(changed);
  list(`Readability: changed lines over ${MAX_LINE} characters`, longLines(changed));
  list('Readability: new functions that are too complex', complexFunctions(changed));
  list('Simplicity: added lines naming a guess, to match to a decision', guessLines(changed));
}

try {
  main();
} catch (e) {
  console.log(`\nReadability hints skipped: ${e.message.split('\n')[0]}`);
}
