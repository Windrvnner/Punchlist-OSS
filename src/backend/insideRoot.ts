import path from 'node:path';

/**
 * A record in the shared change log names a file by its place inside a folder, and another PC wrote it: the place is
 * used only if it stays under that folder. Anything else ('../x', an absolute path, a sibling whose name starts the
 * same as the folder's) is null, and is treated as a file that is not there (#1156).
 */
export function insideRoot(root: string, rel: string): string | null {
  const base = path.resolve(root);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;     // a drive's top folder already ends in one
  const at = path.resolve(base, rel);
  if (!at.startsWith(prefix)) return null;
  return at;
}
