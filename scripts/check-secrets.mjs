// Refuses a commit that carries an API key, a sign-in token or a .env file. Run by the pre-commit hook on what is
// staged (the content git will commit, not the file on disk, which may differ), and by CI on every tracked file and on
// everything the branch's commits add, even what a later commit removed. Prints file names and short commit ids only,
// never what matched.
import { git, gitBytes } from './allowance.mjs';
import fs from 'node:fs';
import { addedFiles, addedText, branchRange } from './branch-commits.mjs';

const all = process.argv.includes('--all');
const cwd = process.cwd();
const listFiles = all
  ? ['ls-files', '-z']
  : ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'];
const files = git(cwd, ...listFiles)
  .split('\0')
  .filter(Boolean);

// Key shapes: Anthropic, OpenAI (including project keys), AWS, GitHub, Slack, Google, and a JWT (North's sign-in token)
const KEY_SHAPES = [
  'sk-ant-[A-Za-z0-9_-]{16,}',
  'sk-(?:proj-)?[A-Za-z0-9_-]{32,}',
  'AKIA[0-9A-Z]{16}',
  'gh[pousr]_[A-Za-z0-9]{30,}',
  'xox[baprs]-[A-Za-z0-9-]{10,}',
  'AIza[0-9A-Za-z_-]{35}',
  'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
];
const KEY = new RegExp(`\\b(${KEY_SHAPES.join('|')})`);
// and a private key in PEM form (a cloud service account) or PGP armor. It starts with dashes, where \b cannot match.
const PRIVATE_KEY = /-----BEGIN ([A-Z]+ )*PRIVATE KEY( BLOCK)?-----/;
// and the project's own key, whatever its shape, read from .env on this PC (never printed)
let own = '';
try { own = /^PUNCHLIST_AI_KEY=(.+)$/m.exec(fs.readFileSync('.env', 'utf8'))?.[1].trim() ?? ''; } catch { /* no .env here (CI) */ }

const isEnvFile = (name) => {
  return /(^|\/)\.env($|\.)/.test(name) && !name.endsWith('.env.example');
};
const looksLikeSecret = (text) => KEY.test(text) || PRIVATE_KEY.test(text) || (own.length >= 16 && text.includes(own));

const bad = [];
for (const f of files) {
  if (isEnvFile(f)) { bad.push(`${f} (an env file)`); continue; }
  let text;
  try { text = (all ? fs.readFileSync(f) : gitBytes(cwd, 'show', `:${f}`)).toString('latin1'); }
  catch { bad.push(`${f} (could not be read to check)`); continue; }
  if (looksLikeSecret(text)) bad.push(`${f} (looks like an API key or token)`);
}
// A secret a branch commit added is in the history even when a later commit removed it.
function historyProblems() {
  const range = all ? branchRange() : null;
  if (!range) return [];
  const problems = [];
  for (const { sha, file } of addedFiles(range)) {
    if (isEnvFile(file)) problems.push(`${file} (an env file, added in ${sha.slice(0, 8)})`);
  }
  for (const { sha, file, text } of addedText(range)) {
    if (looksLikeSecret(text)) problems.push(`${file} (looks like an API key or token, added in ${sha.slice(0, 8)})`);
  }
  return problems;
}
try {
  bad.push(...historyProblems());
} catch (error) {
  // A failed git command carries its own output, which may hold the secret, so only our own messages are printed.
  const ours = error instanceof Error && error.stderr === undefined;
  bad.push(ours ? error.message : 'the branch history could not be read to check');
}
if (bad.length) { console.error(`Refused: secrets must stay in .env, which git ignores.\n  ${bad.join('\n  ')}`); process.exit(1); }
