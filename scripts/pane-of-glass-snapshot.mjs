// Mirror source filenames and only the package metadata Vite needs to resolve a named glob member.
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { privatePath } from './pane-of-glass-project-links.mjs';
import { packageName } from './pane-of-glass-globs.mjs';

// Recursive readdir may traverse directory symlinks. Descend only into directory entries themselves.
export function* treeEntries(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (privatePath(file.split(path.sep).join('/'))) continue;
    if (entry.isDirectory()) yield* treeEntries(file);
    else yield { file, entry };
  }
}

function writeStub(file, contents = '') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents);
}

// Only the package resolver sees these fields. Scripts and implementation modules stay out of the probe.
function resolverManifest(text) {
  const keys = ['name', 'type', 'imports', 'exports', 'browser', 'module', 'main', 'jsnext:main', 'jsnext',
    'sideEffects'];
  const manifest = JSON.parse(text);
  return JSON.stringify(Object.fromEntries(keys.filter((key) => Object.hasOwn(manifest, key))
    .map((key) => [key, manifest[key]])));
}

function linkedPackages(directory, links, scoped = false) {
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const file = path.posix.join(directory, entry.name);
    if (entry.isSymbolicLink() && !links.has(file)) links.set(file, readlinkSync(file));
    else if (!scoped && entry.isDirectory() && entry.name.startsWith('@')) linkedPackages(file, links, true);
  }
}

function physicalDirectory(directory) {
  if (privatePath(directory.split(path.sep).join('/'))) return false;
  const parent = path.dirname(directory);
  if (parent !== directory && !physicalDirectory(parent)) return false;
  return lstatSync(directory, { throwIfNoEntry: false })?.isDirectory();
}

function mirrorPackage(scratch, importer, name) {
  const locations = createRequire(path.resolve(importer)).resolve.paths(name) ?? [];
  const directories = locations.map((location) => path.join(location, name));
  const source = directories.find((directory) => physicalDirectory(path.dirname(directory)) &&
    lstatSync(directory, { throwIfNoEntry: false }));
  if (!source) return;
  // Installed workspace links are already mirrored with their repository identities.
  if (!lstatSync(source).isDirectory()) return;
  if (!lstatSync(path.join(source, 'package.json'), { throwIfNoEntry: false })?.isFile()) return;
  const location = path.relative(path.parse(process.cwd()).root, source);
  if (path.isAbsolute(location) || location.split(path.sep)[0] === '..') return;
  const destination = path.join(scratch, location);
  for (const { file, entry } of treeEntries(source)) {
    if (!entry.isFile()) continue;
    const copy = path.join(destination, path.relative(source, file));
    writeStub(copy, entry.name === 'package.json' ? resolverManifest(readFileSync(file, 'utf8')) : '');
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

function mirrorSourceFiles(root, inventory) {
  const { files } = inventory;
  for (const file of files) writeStub(path.join(root, file), file.endsWith('.json') ? '{}' : '');
  writeStub(path.join(root, 'package.json'), '{}');
  for (const file of ['package.json', ...files.filter((name) => name.endsWith('/package.json'))]) {
    if (privatePath(file)) continue;
    const text = inventory.manifest(file);
    if (text !== undefined) writeStub(path.join(root, file), resolverManifest(text));
  }
}

function mirrorLinks(root, links, linkAt) {
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
}

export function writeSnapshot(root, scratch, importer, inventory, globs) {
  mirrorSourceFiles(root, inventory);
  const links = new Map(inventory.liveLinks?.() ?? inventory.links);
  for (let from = path.posix.dirname(importer); ; from = path.posix.dirname(from)) {
    linkedPackages(path.posix.join(from, 'node_modules'), links);
    if (from === '.') break;
  }
  mirrorLinks(root, links, (file) => links.get(file) ?? inventory.linkAt?.(file));
  const packages = globs.flatMap(({ patterns }) => patterns.map(({ value }) => packageName(value)));
  for (const name of new Set(packages.filter(Boolean))) mirrorPackage(scratch, importer, name);
}
