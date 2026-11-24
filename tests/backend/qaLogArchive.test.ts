// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLog, keptEdits, saveLog, settleKept, sha256 } from '../../src/backend/qaLogFolder';

const FILE = 'Lender A Q&A.xlsx';
const at = new Date(2026, 10, 15, 16, 12);
const roots: string[] = [];
const bytes = (text: string) => Buffer.from(text);
const list = (dir: string) => fs.readdirSync(dir).sort();
const read = (dir: string, name = FILE) => fs.readFileSync(path.join(dir, name), 'utf8');

function folder(archive?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-qalog-'));
  roots.push(dir);
  if (archive) fs.mkdirSync(path.join(dir, archive));
  return dir;
}

function withLog(text: string): string {
  const dir = folder('Archive');
  fs.writeFileSync(path.join(dir, FILE), text);
  return dir;
}

function save(dir: string, text: string) {
  return saveLog({ folder: dir, file: FILE, bytes: bytes(text), was: sha256(bytes(read(dir))), at });
}

function ageMovedAsideLog(): void {
  const stat = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: never) => {
    const result = stat(file, options) as fs.Stats;
    if (!String(file).endsWith('.tmp')) return result;
    return Object.assign(result, { ctimeMs: result.ctimeMs + 120_000 });
  }) as typeof fs.statSync);
}

/** Interrupt a shared write after its name was reserved. */
function interruptPublication(dir: string, final: string): void {
  const open = fs.openSync;
  const write = fs.writeFileSync;
  let handle: number | undefined;
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    const opened = open(file, flags, mode);
    if (flags === 'wx' && typeof file === 'string' && path.dirname(file) === dir) {
      if (file === final || /^~[0-9a-f]{12}\.tmp$/.test(path.basename(file))) handle = opened;
    }
    return opened;
  });
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
    if (file !== handle && file !== final) return write(file, data, options);
    write(file, 'Unfinished line', options);
    throw Object.assign(new Error('Interrupted shared write'), { code: 'EIO' });
  });
}

describe('publishing and recovering Q&A archives', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of roots.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
  });

  it('does not publish an incomplete dated archive after a shared write fails (#21)', () => {
    const d = withLog('The facility agent approved the waiver.');
    const dir = path.join(d, 'Archive');
    const archive = path.join(dir, 'Lender A Q&A 2026-11-15 1612.xlsx');
    interruptPublication(dir, archive);

    expect(() => save(d, 'ours')).toThrow('Interrupted shared write');
    vi.restoreAllMocks();
    expect(list(dir)).toEqual([]);
    expect(read(d)).toBe('The facility agent approved the waiver.');
  });

  it('restores the moved-aside copy if the archive changes during removal (#21)', () => {
    const original = 'Please provide the amendments covering the reserve requirement.';
    const d = withLog(original);
    const archive = path.join(d, 'Archive', 'Lender A Q&A 2026-11-15 1612.xlsx');
    const rm = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (String(file).endsWith('.old')) fs.writeFileSync(archive, 'The reserve is in the updated schedule.');
      return rm(file, options);
    });

    expect(save(d, 'ours').status).toBe('written');
    vi.restoreAllMocks();
    expect(list(d).filter((file) => file.endsWith('.old')).map((file) => read(d, file))).toEqual([original]);
    expect(fs.readFileSync(archive, 'utf8')).toBe('The reserve is in the updated schedule.');
  });

  it('keeps a later change to an aside when settling the earlier edit (#21)', () => {
    const d = withLog('theirs');
    const edit = 'The consent deadline was extended to the next business day.';
    const revised = 'The consent deadline was extended by two business days.';
    const name = '~Lender A Q&A 0123abcd.old';
    const aside = path.join(d, name);
    const archive = path.join(d, 'Archive', 'Lender A Q&A 2026-11-15 1612.xlsx');
    fs.writeFileSync(aside, edit);
    fs.writeFileSync(archive, edit);
    const realRead = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor, options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      const result = options === undefined ? realRead(file) : realRead(file, options);
      if (file === archive) fs.writeFileSync(aside, revised);
      return result;
    }) as typeof fs.readFileSync);

    expect(settleKept(d, FILE, [{ name, hash: sha256(bytes(edit)) }])).toEqual([]);
    vi.restoreAllMocks();
    expect(read(d, name)).toBe(revised);
  });
});
