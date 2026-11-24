// Mirror source filenames and only the package metadata Vite needs to resolve a named glob member.
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { privatePath } from './pane-of-glass-project-links.mjs';
import { packageName } from './pane-of-glass-globs.mjs';

// Recursive readdir may traverse directory symlinks. Descend only into directory entries themselves.
export function* treeEntries(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* treeEntries(file);
    else yield { file, entry };
  }
}

function writeStub(file, contents = '') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

function mirrorPackage(scratch, importer, name) {
  const locations = createRequire(path.resolve(importer)).resolve.paths(name) ?? [];
  const directories = locations.map((location) => path.join(location, name));
  const source = directories.find((directory) => existsSync(path.join(directory, 'package.json')));
  if (!source) return;
  const location = path.relative(path.parse(process.cwd()).root, source);
  if (path.isAbsolute(location) || location.split(path.sep)[0] === '..') return;
  const destination = path.join(scratch, location);
  for (const { file, entry } of treeEntries(source)) {
    if (!entry.isFile()) continue;
    const copy = path.join(destination, path.relative(source, file));
    writeStub(copy, entry.name === 'package.json' ? readFileSync(file) : '');
  }
}

// Resolve each component before following .., as a filesystem does. Cycles and paths outside the repo have no target.
function follow(alias, link, linkAt, visiting) {
  if (visiting.has(alias)) return;
  const raw = path.isAbsolute(link) ? path.relative(process.cwd(), link) : path.posix.dirname(alias) + '/' + link;
  if (path.isAbsolute(raw)) return;
  return canonicalSource(raw.split(path.sep).join('/'), linkAt, new Set([...visiting, alias]));
}

function canonicalSource(file, linkAt, visiting = new Set()) {
  const parts = [];
  for (const part of file.split('/').filter((name) => name && name !== '.')) {
    if (part === '..') {
      if (!parts.pop()) return;
      continue;
    }
    parts.push(part);
    const alias = parts.join('/');
    if (privatePath(alias)) return;
    const link = linkAt(alias);
    if (link === undefined) continue;
    const target = follow(alias, link, linkAt, visiting);
    if (target === undefined) return;
    parts.splice(0, parts.length, ...target.split('/').filter(Boolean));
  }
  return parts.join('/');
}

export function writeSnapshot(root, scratch, importer, inventory, globs) {
  const links = inventory.liveLinks?.() ?? inventory.links;
  const linkAt = inventory.linkAt ?? ((file) => links.get(file));
  const { files } = inventory;
  for (const file of files) writeStub(path.join(root, file), file.endsWith('.json') ? '{}' : '');
  // A directory containing only aliases can itself be the target of an earlier alias.
  for (const alias of links.keys()) mkdirSync(path.join(root, path.dirname(alias)), { recursive: true });
  for (const alias of links.keys()) {
    const target = canonicalSource(alias, linkAt);
    if (target === undefined) continue;
    const copy = path.join(root, target);
    if (!existsSync(copy)) continue;
    const directory = path.join(root, path.dirname(alias));
    symlinkSync(path.relative(directory, copy), path.join(root, alias), statSync(copy).isDirectory() ? 'dir' : 'file');
  }
  const packages = globs.flatMap(({ patterns }) => patterns.map(({ value }) => packageName(value)));
  for (const name of new Set(packages.filter(Boolean))) mirrorPackage(scratch, importer, name);
}
