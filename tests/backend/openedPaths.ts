import fs from 'node:fs';
import { vi } from 'vitest';

/**
 * Tells which file a write is for. A new file's bytes go through the handle that claimed its name, so a stand-in
 * for a share that fails a write maps the handle back to the path it was opened from. Restored by `vi.restoreAllMocks()`.
 */
export const trackPaths = () => {
  const opened = new Map<number, string>();
  const real = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation(((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
    const fd = real(p, flags, mode);
    opened.set(fd, String(p));
    return fd;
  }) as typeof fs.openSync);
  return (p: fs.PathOrFileDescriptor) => (typeof p === 'number' ? (opened.get(p) ?? '') : String(p));
};
