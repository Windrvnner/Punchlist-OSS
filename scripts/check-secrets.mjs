// Refuses a commit that carries an API key, a sign-in token or a .env file. Run by the pre-commit hook on what is
// staged (the content git will commit, not the file on disk, which may differ), and by CI on every tracked file.
// Prints file names only, never what matched.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const all = process.argv.includes('--all');
const git = (...args) => execFileSync('git', args, { maxBuffer: 512 * 1024 * 1024 });
const files = (all ? git('ls-files', '-z') : git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'))
  .toString()
  .split('\0')
  .filter(Boolean);

// Key shapes: Anthropic, OpenAI (including project keys), AWS, GitHub, Slack, and a JWT (North's sign-in token)
const KEY = /\b(sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/;
// and the project's own key, whatever its shape, read from .env on this PC (never printed)
let own = '';
try { own = /^PUNCHLIST_AI_KEY=(.+)$/m.exec(fs.readFileSync('.env', 'utf8'))?.[1].trim() ?? ''; } catch { /* no .env here (CI) */ }

const bad = [];
for (const f of files) {
  if (/(^|\/)\.env($|\.)/.test(f) && !f.endsWith('.env.example')) { bad.push(`${f} (an env file)`); continue; }
  let text;
  try { text = (all ? fs.readFileSync(f) : git('show', `:${f}`)).toString('latin1'); }
  catch { bad.push(`${f} (could not be read to check)`); continue; }
  if (KEY.test(text) || (own.length >= 16 && text.includes(own))) bad.push(`${f} (looks like an API key or token)`);
}
if (bad.length) { console.error(`Refused: secrets must stay in .env, which git ignores.\n  ${bad.join('\n  ')}`); process.exit(1); }
