/** A folder on disk. An append is forced to the disk before it returns, so a line the app was told is saved is saved. */
import fs from 'node:fs'; import path from 'node:path';
import type { Folder } from './logRepository';
import type { FileStamp } from './ownFile';

/**
 * A file another program holds for a moment (a sync client uploading the line just written, a virus scanner on the journal)
 * refuses to be opened or replaced: Windows answers EBUSY, EPERM or EACCES. The write is tried again after each of these
 * waits, a second or so in all, before it is reported as failed.
 */
export const BUSY_WAITS = [25, 50, 100, 200, 300, 400];
const busy = (e: any) => e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES';
/** wait without giving up the thread: the folder's calls return their result, they do not promise it */
const pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
/**
 * A file that refused for the whole wait may be read-only for good, which Windows also answers with EPERM or EACCES. The
 * wait holds the process, so after one such refusal that file's writes are tried once each for this long, then waited
 * for again: a file that stays refused costs one wait every 10 seconds, not one per write. Other files are waited for as usual.
 */
const REST_MS = 10_000;

/**
 * Write all of `text`: a nearly full disk may take only part of one write without an error, and the rest is written
 * after it. A write that takes nothing throws, so a short write is never reported as saved (#126).
 */
function writeAll(fd: number, text: string) {
  const bytes = Buffer.from(text, 'utf8');
  for (let done = 0; done < bytes.length;) {
    const written = fs.writeSync(fd, bytes, done, bytes.length - done);
    if (written <= 0) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    done += written;
  }
}

export function nodeFolder(dir: string, waits = BUSY_WAITS): Folder & FileStamp {
  fs.mkdirSync(dir, { recursive: true });
  const resting = new Map<string, number>();                                // file name → until when it is tried once per write
  /** The waits one write may use: its steps share them, so a write holds the process for one wait in all, not one per step. */
  const budget = (name: string) => (Date.now() < (resting.get(name) ?? 0) ? [] : [...waits]);
  /** Do `step` on file `name`, using up `left`; `step` must have changed nothing when it throws. A busy file is tried again after each wait. */
  const whenFree = <T,>(name: string, left: number[], step: () => T): T => {
    for (;;) {
      try { const r = step(); resting.delete(name); return r; }
      catch (e) {
        if (!busy(e)) throw e;
        const ms = left.shift();
        if (ms === undefined) { if (Date.now() >= (resting.get(name) ?? 0) && waits.length) resting.set(name, Date.now() + REST_MS); throw e; }   // the rest starts after a full wait, not again during it
        pause(ms);
      }
    }
  };
  const at = (name: string) => path.join(dir, name);

  /** Remove this write's working file when it cannot be put in place (#213). */
  const replaceWorkingFile = (name: string, temporary: string, left: number[]) => {
    try {
      whenFree(name, left, () => fs.renameSync(temporary, at(name)));
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch { /* The working file can stay if it is held too. Report the original failure. */ }
      throw error;
    }
  };
  return {
    list: () => fs.readdirSync(dir),
    size: (name) => { try { return fs.statSync(at(name)).size; } catch { return -1; } },
    fileStamp: (name) => {
      try {
        const { size, ino, mtimeNs, ctimeNs } = fs.statSync(at(name), { bigint: true });
        return `${size}:${ino}:${mtimeNs}:${ctimeNs}`;
      } catch { return undefined; }
    },
    read: (name) => { try { return fs.readFileSync(at(name), 'utf8'); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; } },
    // only the opening is tried again: a write that fails part way may have left part of the line, which the caller deals with
    append: (name, text) => {
      const fd = whenFree(name, budget(name), () => fs.openSync(at(name), 'a'));
      try {
        writeAll(fd, text);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    // written beside the file, forced to the disk, and moved over it, so a crash or a power cut leaves the old file or the
    // new one, never half of one: without the flush, Windows may put the move on disk before the new text
    write: (name, text) => {
      const temporary = at(name + '.tmp');
      const left = budget(name);
      whenFree(name, left, () => fs.writeFileSync(temporary, text, { flush: true }));
      replaceWorkingFile(name, temporary, left);
    },
  };
}
