// One zip for a release: app/ (dist, the runnable app, vendor included), source/ (the tree the Electron shell wraps)
// and docs/ (the docs/ folder and the README). Nothing else needs downloading.
// The source and docs come from what git holds at HEAD, not from the disk, so a file git ignores (a stray .env.local, a
// scratch folder) can never ship, and what ships is what the secrets check saw. app/ is the build in dist/.
import { execSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
fs.mkdirSync('out', { recursive: true });
const v = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-pkg-')); const root = path.join(stage, `punchlist-${v}`);
for (const d of ['app', 'source']) fs.mkdirSync(path.join(root, d), { recursive: true });
execSync(`cp -r dist/. "${path.join(root, 'app')}"`);
const fromGit = (paths, to) => execSync(`git archive --format=tar HEAD ${paths.join(' ')} | tar -x -C "${to}"`);
fromGit([
  'src', 'tests', 'scripts', 'public', 'index.html', 'package.json', 'package-lock.json',
  'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'README.md', 'LICENSE',
], path.join(root, 'source'));
fromGit(['docs', 'LICENSE'], root);
fs.copyFileSync(path.join(root, 'source', 'README.md'), path.join(root, 'docs', 'README.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(root, 'docs', 'LICENSE'));
const docs = fs.readdirSync(path.join(root, 'docs')).filter((f) => f !== 'README.md');
const zip = path.resolve(`out/punchlist-${v}.zip`); fs.rmSync(zip, { force: true });
execSync(`cd "${stage}" && zip -qr "${zip}" "punchlist-${v}"`);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`out/punchlist-${v}.zip ${(fs.statSync(zip).size / 1024).toFixed(0)} KB · docs: ${['README.md', ...docs].join(', ')}`);
