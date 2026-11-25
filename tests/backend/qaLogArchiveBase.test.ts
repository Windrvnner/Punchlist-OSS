// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveLog, sha256 } from '../../src/backend/qaLogFolder';
import { trackPaths } from './openedPaths';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { libreOfficeConverter } from '../../src/backend/convert';
import { xlsxOf } from './miniXlsx';
import { hasOffice as has, soffice } from './officePrerequisites';

const at = new Date(2026, 10, 15, 16, 12);
const scope = 'Environmental permits and commercial approval conditions for project financing ';
const stem = scope.repeat(3).slice(0, 228).trimEnd().padEnd(228, 'A');
const file = `${stem}.xlsx`;
const foreign = `${stem}環.xlsx`;
const draft = 'No amendment recorded in the working draft';
const final = 'Signed amendment filed in the final document set';
const currentAnswer = 'The updated filing confirms compliance';
const keptAnswer = 'The updated filing remains outstanding';
const addedAnswer = 'The executed amendment is in the interconnection records';
const folders: string[] = [];
const lo = libreOfficeConverter({ soffice, profile: fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-base-test-lo-')) });

function logBytes(answer: (index: number) => string): Uint8Array {
  const facilities = ['battery installation', 'wind installation', 'solar array', 'interconnector'];
  const topics = ['interconnection agreement', 'discharge permit', 'completion bond', 'access easement',
    'energy purchase agreement', 'equipment warranty', 'habitat assessment', 'insurance policy',
    'construction schedule', 'tax equity contribution'];
  const requests = ['When was approval received under the', 'Please identify the renewal requirements of the',
    'Where is the current version of the', 'Which assignments require consent under the',
    'How does the lender verify compliance under the'];
  const rows = Array.from({ length: 2100 }, (_, index) => {
    const phase = 1 + Math.floor(index / 200);
    const location = facilities[index % facilities.length];
    const topic = topics[Math.floor(index / 4) % topics.length];
    const request = requests[Math.floor(index / 40) % requests.length];
    return [String(index + 1), `${request} ${topic} for phase ${phase} of the ${location}?`, answer(index)];
  });
  return xlsxOf([['No.', 'Question', 'Response'], ...rows]);
}

function saveWithArchiveCollision(folder: string, foreignHoldsEdit: boolean) {
  const original = path.join(folder, file);
  const base = logBytes((index) => index < 120 ? draft : '');
  const current = logBytes((index) => index < 120 ? final : index < 240 ? currentAnswer : '');
  const kept = logBytes((index) => index < 120 ? draft : index < 240 ? keptAnswer : index === 240 ? addedAnswer : '');
  const foreignBase = foreignHoldsEdit ? kept : logBytes((index) => index < 120 ? final : '');
  fs.writeFileSync(original, base);
  fs.writeFileSync(path.join(folder, foreign), foreignBase);
  const rename = fs.renameSync;
  const write = fs.writeFileSync;
  let aside = '';
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (from !== original) return rename(from, to);
    const update = saveLog({ folder, file: foreign, bytes: foreignBase, was: sha256(foreignBase), at });
    expect(update.status).toBe('written');
    write(original, kept);
    rename(from, to);
    aside = String(to);
    write(original, current);
  });
  const where = trackPaths();
  vi.spyOn(fs, 'writeFileSync').mockImplementation((target, bytes, options) => {
    if (where(target).includes(' saved meanwhile')) throw new Error('Archive copy is unavailable');
    write(target, bytes, options);
  });
  expect(() => saveLog({ folder, file, bytes: base, was: sha256(base), at })).toThrow('Archive copy is unavailable');
  vi.restoreAllMocks();

  const expectedBase = path.join(folder, '01. Archive', `${stem} 2026-11-15 1612.xlsx`);
  const competingBase = path.join(folder, '01. Archive', `${stem} 2026-11-15 1612 (2).xlsx`);
  expect(sha256(fs.readFileSync(expectedBase))).toBe(sha256(base));
  expect(sha256(fs.readFileSync(competingBase))).toBe(sha256(foreignBase));
  const stat = fs.statSync;
  vi.spyOn(fs, 'statSync').mockImplementation(((name: fs.PathLike, options?: never) => {
    const result = stat(name, options) as fs.Stats;
    if (name === expectedBase) result.ctimeMs -= 135_000;
    if (name === competingBase) result.ctimeMs -= 130_000;
    if (name === aside) result.ctimeMs -= 125_000;
    return result;
  }) as typeof fs.statSync);
  return { expectedBase, competingBase, kept };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const cases = [
  'unchanged', 'changed before read', 'changed during copy', 'removed during copy', 'copied by another log',
];

it.skipIf(!has).each(cases)('uses a verified base (%s)', async (change) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-log-base-'));
  folders.push(folder);
  const foreignHoldsEdit = change === 'copied by another log';
  const { expectedBase, competingBase, kept } = saveWithArchiveCollision(folder, foreignHoldsEdit);
  const changed = change !== 'unchanged' && !foreignHoldsEdit;
  const copy = fs.copyFileSync;
  if (change === 'changed before read') copy(competingBase, expectedBase);
  if (change === 'changed during copy' || change === 'removed during copy') {
    vi.spyOn(fs, 'copyFileSync').mockImplementation((from, to, mode) => {
      if (from === expectedBase && change === 'changed during copy') copy(competingBase, expectedBase);
      if (from === expectedBase && change === 'removed during copy') fs.rmSync(expectedBase);
      copy(from, to, mode);
    });
  }
  const logs = nodeQaLogs({ convert: lo });
  const opts = { sheet: 'Sheet1', headerRow: 1 };
  const read = await logs.read({ folder, file }, { ...opts, kept: { n: 0, text: 1 } });
  if (!read.ok || !read.value.kept) throw new Error('The kept log was not read');
  const { steps, files, clashes } = read.value.kept;
  expect(clashes).toHaveLength(changed ? 0 : 120);
  expect(steps).toEqual(changed ? [] : [{ kind: 'cell', col: 2, row: 241, value: addedAnswer }]);
  const result = await logs.save({ folder, file, sheet: opts.sheet, steps, stamp: read.value.stamp });
  expect(result.ok && result.value.status).toBe('written');
  const settled = await logs.settle!({ folder, file, kept: files });
  expect(settled.ok && settled.value.gone).toHaveLength(1);
  expect(files[0]).toMatchObject(changed ? { left: true } : { clashes: expect.any(Array) });
  const saved = await logs.read({ folder, file }, opts);
  if (!saved.ok) throw new Error(saved.error.message);
  expect(saved.value.rows).toHaveLength(2100);
  expect(saved.value.rows.slice(0, 120).every((row) => row[2] === final)).toBe(true);
  expect(saved.value.rows.slice(120, 240).every((row) => row[2] === currentAnswer)).toBe(true);
  expect(saved.value.rows[240][2]).toBe(changed ? '' : addedAnswer);
  const archive = path.join(folder, '01. Archive');
  const filed = fs.readdirSync(archive).find((name) => name.includes(' saved meanwhile'));
  expect(filed && sha256(fs.readFileSync(path.join(archive, filed)))).toBe(sha256(kept));
});
