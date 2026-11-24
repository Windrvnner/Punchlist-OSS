// Discover project aliases from directory entries without reading regular files or following directory links.
import { spawnSync } from 'node:child_process';
import { readdirSync, readlinkSync } from 'node:fs';
import { posix } from 'node:path';

export function privatePath(file) {
  return file.split('/').some((part) => part === '.git' || part === '.config' ||
    part.startsWith('.pane-of-glass-') || /^\.env(?:\.|$)/.test(part));
}

function publicPaths() {
  const result = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return;
  const paths = new Set();
  for (let file of result.stdout.split('\0').filter(Boolean)) {
    while (file !== '.' && !paths.has(file)) {
      paths.add(file);
      file = posix.dirname(file);
    }
  }
  return paths;
}

function directoryEntries(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'EACCES' || error.code === 'EPERM') return [];
    throw error;
  }
}

function discover(directory, paths, links) {
  for (const entry of directoryEntries(directory)) {
    const file = posix.join(directory, entry.name);
    if (file === 'src' || entry.name === 'node_modules' || privatePath(file)) continue;
    if (paths ? !paths.has(file) : entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) links.set(file, readlinkSync(file));
    else if (entry.isDirectory()) discover(file, paths, links);
  }
}

export function projectLinks(links) {
  discover('.', publicPaths(), links);
  return links;
}
