import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');

export function verifyCopy(file: string, expected: string): Buffer {
  const before = copyVersion(file);
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expected || copyVersion(file) !== before) {
    throw new Error('The Q&A log copy did not match the original');
  }
  return bytes;
}

/** Include identity and write times so a concurrent edit cannot validate an earlier read (#21). */
function copyVersion(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error('The Q&A log copy is not a regular file');
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/** A failed exclusive write cannot prove a shared name is safe to remove (#21). */
export function copyThroughNewHandle(file: string, bytes: Uint8Array): void {
  const handle = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(handle, bytes);
  } finally { fs.closeSync(handle); }
}

/** Prepare a private working name on the destination filesystem before publishing complete bytes (#21). */
function stageForPublication(dir: string, bytes: Uint8Array, expected: string): string | undefined {
  const file = path.join(dir, `~${crypto.randomBytes(6).toString('hex')}.tmp`);
  let handle: number;
  try {
    handle = fs.openSync(file, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENAMETOOLONG') return undefined;
    throw error;
  }
  try {
    try { fs.writeFileSync(handle, bytes); } finally { fs.closeSync(handle); }
    verifyCopy(file, expected);
    return file;
  } catch (error) {
    tidy(file);
    throw error;
  }
}

function publishCopy(staged: string | undefined, file: string, bytes: Uint8Array): void {
  if (staged) {
    try {
      fs.linkSync(staged, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].includes(code)) throw error;
    }
  }
  copyThroughNewHandle(file, bytes);
}

export type StagedArchive = { file: string; bytes: Uint8Array; retained?: boolean };

/** Stage in local scratch, which does not depend on permissions or path length in the archive folder (#21). */
export function stageCopy(name: string, bytes: Uint8Array, expected: string): StagedArchive {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-qalog-Archive-'));
  const file = path.join(scratch, name);
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
    return { file, bytes: verifyCopy(file, expected) };
  } catch (error) {
    tidyStage(file);
    throw error;
  }
}

export function tidyStage(file: string): void {
  tidy(file);
  try { fs.rmdirSync(path.dirname(file)); } catch { /* a held scratch file may remain */ }
}

/** Claim the first free name. Once published, the shared file never belongs to cleanup (#21). */
export function createCopy(dir: string, base: string, ext: string, bytes: Uint8Array): string {
  const expected = sha256(bytes);
  const staged = stageForPublication(dir, bytes, expected);
  try {
    for (let suffix = 1; ; suffix++) {
      const name = `${base}${suffix > 1 ? ` (${suffix})` : ''}${ext}`;
      const file = path.join(dir, name);
      try {
        publishCopy(staged, file, bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && suffix <= 99) continue;
        throw error;
      }
      verifyCopy(file, expected);
      return name;
    }
  } finally { if (staged) tidy(staged); }
}

export function fileArchive(dir: string, base: string, ext: string, bytes: Uint8Array): string {
  const staged = stageCopy(`${base}${ext}`, bytes, sha256(bytes));
  try { return createCopy(dir, base, ext, staged.bytes); } finally { tidyStage(staged.file); }
}

/** Keep recovery bytes until the removal is complete and the archive still holds this version (#21). */
export function removeBackedFile(source: string, archived: string, expected: string): boolean {
  verifyCopy(archived, expected);
  let bytes: Uint8Array;
  try { bytes = verifyCopy(source, expected); } catch { return false; }
  const backup = stageCopy(path.basename(source), bytes, expected);
  try {
    try { verifyCopy(source, expected); } catch { return false; }
    try {
      fs.rmSync(source);
    } catch (error) {
      try { verifyCopy(source, expected); } catch { backup.retained = true; }
      throw error;
    }
    try {
      verifyCopy(archived, expected);
      return true;
    } catch {
      try {
        copyThroughNewHandle(source, backup.bytes);
        verifyCopy(source, expected);
      } catch { backup.retained = true; }
      return false;
    }
  } finally { if (!backup.retained) tidyStage(backup.file); }
}

/** removes a working file, leaving it for the next save's tidyLeftovers when another program holds it: the save itself is done */
export function tidy(file: string): void {
  try { fs.rmSync(file, { force: true }); } catch { /* left for the next save */ }
}
