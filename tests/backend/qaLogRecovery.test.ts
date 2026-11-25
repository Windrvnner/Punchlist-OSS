// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keptEdits, restoreAside, saveLog, settleKept, sha256 } from '../../src/backend/qaLogFolder';

const folder = () => fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-log-recovery-'));
const at = new Date(2026, 10, 15, 16, 12);

function interruptAfterMove(dir: string, file: string, original: Uint8Array): string {
  const source = path.join(dir, file);
  fs.writeFileSync(source, original);
  const rename = fs.renameSync;
  let aside = '';
  const move = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(from) === source) {
      rename(from, to);
      aside = String(to);
    }
    throw new Error('Save interrupted after moving the original');
  });
  try {
    expect(() => saveLog({ folder: dir, file, bytes: Buffer.from('unused update'), was: sha256(original), at }))
      .toThrow('Save interrupted after moving the original');
  } finally {
    move.mockRestore();
  }
  expect(fs.existsSync(source)).toBe(false);
  expect(fs.readFileSync(aside)).toEqual(Buffer.from(original));
  return aside;
}

function ageAsideFiles(older: string, newer: string): void {
  const stat = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: never) => {
    const record = stat(file, options) as fs.Stats;
    if (file === older) record.ctimeMs -= 180_000;
    if (file === newer) record.ctimeMs -= 120_000;
    return record;
  }) as typeof fs.statSync);
}

describe('recovering interrupted saves (#278)', () => {
  afterEach(() => vi.restoreAllMocks());
  const csv = Buffer.from('Question,Response\nList the outstanding permits.,The schedule is attached.\n');
  const workbook = fs.readFileSync(path.resolve('tests/fixtures/excel-1900.xlsx'));
  const prefix = 'Environmental permits and approval conditions '.repeat(5);

  it.each([
    ['same stem with two formats', 'Lender log.csv', 'Lender log.xlsx', csv, workbook],
    ['same long prefix with one format', `${prefix}Water.xlsx`, `${prefix}Access.xlsx`, workbook,
      fs.readFileSync(path.resolve('tests/fixtures/excel-1904.xlsx'))],
  ])('restores each original when both paths are missing: %s', (_, fileA, fileB, dataA, dataB) => {
    const dir = folder();
    try {
      const first = interruptAfterMove(dir, fileA, dataA);
      const second = interruptAfterMove(dir, fileB, dataB);
      ageAsideFiles(first, second);
      expect(restoreAside(dir, fileA)).toBe(true);
      expect(sha256(fs.readFileSync(path.join(dir, fileA)))).toBe(sha256(dataA));
      expect(sha256(fs.readFileSync(second))).toBe(sha256(dataB));
      expect(restoreAside(dir, fileB)).toBe(true);
      expect(sha256(fs.readFileSync(path.join(dir, fileB)))).toBe(sha256(dataB));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a log with a multibyte filename near the byte limit', () => {
    const dir = folder();
    const file = `${'環境許認可の条件及び期限'.repeat(6)} Certification schedule v2.csv`;
    try {
      const aside = interruptAfterMove(dir, file, csv);
      expect(Buffer.byteLength(path.basename(aside))).toBeLessThanOrEqual(255);
      ageAsideFiles(aside, '');
      expect(restoreAside(dir, file)).toBe(true);
      expect(fs.readFileSync(path.join(dir, file))).toEqual(csv);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recovers a log under the other spelling of its name, as the app treats them as one log', () => {
    const dir = folder();
    try {
      const aside = interruptAfterMove(dir, 'Lender log.csv', csv);
      ageAsideFiles(aside, '');
      expect(restoreAside(dir, 'Lender log.CSV')).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'Lender log.CSV'))).toEqual(csv);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves an old working file whose original filename is unknown', () => {
    const dir = folder();
    try {
      const ambiguous = path.join(dir, '~Lender log 0a1b2c3d.old');
      fs.writeFileSync(ambiguous, workbook);
      ageAsideFiles(ambiguous, '');
      expect(restoreAside(dir, 'Lender log.csv')).toBe(false);
      expect(restoreAside(dir, 'Lender log.xlsx')).toBe(false);
      const file = 'Lender log.xlsx';
      const hash = sha256(workbook);
      fs.writeFileSync(path.join(dir, file), workbook);
      expect(keptEdits(dir, file)).toEqual([]);
      expect(settleKept(dir, file, [{ name: path.basename(ambiguous), hash }])).toEqual([]);
      const result = saveLog({ folder: dir, file, bytes: workbook, was: hash, at });
      expect(result.status).toBe('written');
      expect(fs.readFileSync(ambiguous)).toEqual(workbook);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
