// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { SetResponse } from '../../src/app/commands/questions';
import { importKey, initializeKeptImports, keptImportsReady } from '../../src/app/keptImports';
import { loadQaImport, submitQaImport } from '../../src/app/qaImport';
import { exportQaLog, logOf } from '../../src/app/qaLog';
import { dealQuestions } from '../../src/app/state';
import { nodeQaLogs } from '../../src/backend/qaLogs';
import { prepareImport, type Mapping } from '../../src/domain/importExport';
import { fail, rejected, type Result } from '../../src/domain/result';
import { parseCsv } from '../../src/domain/sheets';
import type { QaLogFiles, SpreadsheetCodec } from '../../src/ports';
import { asideFixtureName } from '../backend/qaLogWorkingFiles';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp, recoveryDeal } from './recoveryKit';

const folders: string[] = [];
const apps: ReturnType<typeof recoveryApp>[] = [];
const NUMBER = 'Number';
const QUESTION = 'Question';
const RESPONSE = 'Response';
const ORIGINAL = [NUMBER, QUESTION, RESPONSE];

function value<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.store.closing();
    await app.repo.close();
  }
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

async function linkedLog(columns: string[], rows: string[][], selected: Partial<Mapping> = {}) {
  initializeKeptImports(new MemoryKeptImports());
  await keptImportsReady;
  const app = recoveryApp();
  apps.push(app);
  const { store } = app;
  const dealId = await recoveryDeal(app);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-log-columns-'));
  folders.push(folder);
  const name = 'Portfolio lender inquiries.csv';
  const file = path.join(folder, name);
  store.services.fs.pathFor = () => file;
  store.services.qaLogs = nodeQaLogs({});

  async function write(headings: string[], tableRows: string[][]) {
    const { bytes } = value(await store.services.sheets.write('Sheet1', [headings, ...tableRows]));
    fs.writeFileSync(file, bytes);
    return bytes.slice().buffer;
  }

  async function link(headings: string[], tableRows: string[][], picks: Partial<Mapping>) {
    const bytes = await write(headings, tableRows);
    const loaded = value(await loadQaImport(store, dealId, new File([bytes], name)));
    const mapping = { ...loaded.table.mapping, ...picks };
    const choices = {
      mapping, mode: 'merge' as const, path: loaded.path, answered: false, makeLog: true, touched: true,
    };
    const prepared = prepareImport(loaded.table.rows, mapping);
    value(await submitQaImport(store, dealId, { table: loaded.table, choices }, prepared.rows));
  }

  await link(columns, rows, selected);
  const read = () => parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return { store, dealId, folder, file, write, link, read };
}

function portfolio(count: number) {
  return portfolioQuestions().slice(0, count).map((question, index) => [String(index + 1), question, '']);
}

it('follows Response past an inserted Notes column in the linked log', async () => {
  const rows = portfolio(2_000);
  expect(rows).toHaveLength(2_000);
  const { store, dealId, write, read } = await linkedLog(ORIGINAL, rows);
  const pending = dealQuestions(store.get(), dealId).slice(0, 120);
  for (const question of pending) {
    const response = `The signed supporting record is in the diligence folder for item ${question.n}.`;
    value(await store.dispatch(SetResponse, { dealId, questionId: question.id, response }));
  }
  const moved = [NUMBER, QUESTION, 'Notes', RESPONSE];
  const withNotes = rows.map(([n, question], index) => [n, question, index < 120 ? '' : 'Confirm record location', '']);
  await write(moved, withNotes);
  expect(await exportQaLog(store, dealId)).toMatchObject({ ok: true, value: { status: 'written', answered: 120 } });
  const expected = withNotes.map((row, index) => [...row.slice(0, 3),
    index < 120 ? `The signed supporting record is in the diligence folder for item ${index + 1}.` : '',
  ]);
  const written = read();
  const misplaced = written.slice(1, 121).filter((row) => row[2]).length;
  expect(misplaced, 'answers written into Notes').toBe(0);
  expect(written).toEqual([moved, ...expected]);

  const shuffled = [RESPONSE, 'Notes', NUMBER, QUESTION];
  const theirs = expected.map(([n, question, note], index) => [
    index < 120 ? 'The final record is with lender counsel.' : '', note, n, question,
  ]);
  for (const question of pending) {
    const response = 'The signed copy has been filed with the independent engineer.';
    value(await store.dispatch(SetResponse, { dealId, questionId: question.id, response }));
  }
  await write(shuffled, theirs);
  expect(await exportQaLog(store, dealId)).toMatchObject({ ok: true, value: { kept: pending.map(({ n }) => n) } });
  expect(read()).toEqual([shuffled, ...theirs]);
}, 45_000);

it.each(['removed', 'duplicated'] as const)('leaves the file and archive alone when Response is %s', async (change) => {
  const rows = portfolio(2);
  const { store, dealId, file, folder, write } = await linkedLog(ORIGINAL, rows);
  const [question] = dealQuestions(store.get(), dealId);
  value(await store.dispatch(SetResponse, { dealId, questionId: question.id, response: 'Funding confirmed.' }));
  const headers = change === 'removed' ? [NUMBER, QUESTION, 'Notes'] : [...ORIGINAL, RESPONSE];
  await write(headers, rows);
  const original = fs.readFileSync(file);
  const last = logOf(store, dealId)?.last;
  expect(await exportQaLog(store, dealId)).toMatchObject({
    ok: false, error: { kind: 'rejected', message: expect.stringContaining('Import Q&A Log') },
  });
  expect(fs.readFileSync(file)).toEqual(original);
  expect(fs.existsSync(path.join(folder, '01. Archive'))).toBe(false);
  expect(logOf(store, dealId)?.last).toEqual(last);
});

it('uses the new mapping after the same file is imported again', async () => {
  const [number, question] = portfolio(1)[0];
  const { store, dealId, write, link, read } = await linkedLog(ORIGINAL, [[number, question, '']]);
  const headings = [NUMBER, QUESTION, 'Notes', 'Reply from counsel'];
  const rows = [[number, question, 'Check the signed copy', '']];
  await write(headings, rows);
  expect(await exportQaLog(store, dealId)).toMatchObject({ ok: false });
  await link(headings, rows, { response: 3 });
  const item = dealQuestions(store.get(), dealId)[0];
  const response = 'The approved notice has been sent.';
  value(await store.dispatch(SetResponse, { dealId, questionId: item.id, response }));
  value(await exportQaLog(store, dealId));
  expect(read()).toEqual([headings, [number, question, 'Check the signed copy', response]]);
});

it('follows a custom selected heading after it moves and an unused column becomes populated', async () => {
  const [number, question] = portfolio(1)[0];
  const custom = 'Confirmation from transaction counsel';
  const { store, dealId, write, read } = await linkedLog([NUMBER, '', QUESTION, custom], [
    [number, '', question, ''],
  ], { response: 2 });
  const item = dealQuestions(store.get(), dealId)[0];
  const response = 'The lender approved the covenant amendment.';
  value(await store.dispatch(SetResponse, { dealId, questionId: item.id, response }));
  const moved = [custom, '', QUESTION, NUMBER];
  await write(moved, [['', 'Check the latest version', question, number]]);
  value(await exportQaLog(store, dealId));
  expect(read()).toEqual([moved, [response, 'Check the latest version', question, number]]);
});

it('keeps the explicitly selected duplicate heading at its position when an unnamed column gains data', async () => {
  const [number, question] = portfolio(1)[0];
  const headers = [NUMBER, QUESTION, '', RESPONSE, RESPONSE];
  const { store, dealId, write, read } = await linkedLog(headers, [[number, question, '', 'Other reply', '']],
    { response: 3 });
  const item = dealQuestions(store.get(), dealId)[0];
  const response = 'Sponsor supplied the final certificate.';
  value(await store.dispatch(SetResponse, { dealId, questionId: item.id, response }));
  const notes = 'Follow up at diligence meeting';
  await write(headers, [[number, question, notes, 'Other reply', '']]);
  value(await exportQaLog(store, dealId));
  expect(read()).toEqual([headers, [number, question, notes, 'Other reply', response]]);
});

it('can still write to a selected unnamed column after all its values have been cleared', async () => {
  const [first, second] = portfolio(2);
  const headers = [NUMBER, QUESTION, ''];
  const { store, dealId, write, read } = await linkedLog(headers, [
    [first[0], first[1], 'Waiting for confirmation'], second,
  ], { response: 2 });
  const item = dealQuestions(store.get(), dealId)[1];
  const response = 'The contractor executed the amendment.';
  value(await store.dispatch(SetResponse, { dealId, questionId: item.id, response }));
  await write(headers, [first, second]);
  value(await exportQaLog(store, dealId));
  expect(read()).toEqual([headers, first, [second[0], second[1], response]]);
});

async function saveKeptFixture(folder: string, file: string, rows: string[][], sheets: SpreadsheetCodec) {
  const base = fs.readFileSync(file);
  const name = path.basename(file);
  const archive = path.join(folder, '01. Archive');
  fs.mkdirSync(archive);
  fs.writeFileSync(path.join(archive, `${path.basename(name, '.csv')} 2026-11-17 1000.csv`), base);
  const kept = path.join(folder, asideFixtureName(name, { base }));
  const { bytes } = value(await sheets.write('Sheet1', [ORIGINAL, ...rows]));
  fs.writeFileSync(kept, bytes);
  const stat = fs.statSync;
  const age = vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options?: never) => {
    const stats = stat(file, options);
    if (file === kept) stats.ctimeMs -= 120_000;
    return stats;
  }) as typeof fs.statSync);
  return { kept, stopAging: () => age.mockRestore() };
}

it('resolves the columns again when a save with kept edits is refused and the file is reread', async () => {
  const [first, second] = portfolio(2);
  const { store, dealId, folder, file, write, read } = await linkedLog(ORIGINAL, [first, second]);
  const answer = 'The certified plans were delivered.';
  const retained = 'Counsel approved the lease language.';
  const { kept, stopAging } = await saveKeptFixture(folder, file, [[first[0], first[1], retained], second],
    store.services.sheets);
  try {
    const item = dealQuestions(store.get(), dealId)[1];
    value(await store.dispatch(SetResponse, { dealId, questionId: item.id, response: answer }));
    await write([NUMBER, 'Notes', QUESTION, RESPONSE], [first, second].map(([n, q]) => [n, '', q, '']));
    const files = store.services.qaLogs!;
    const saves: Parameters<QaLogFiles['save']>[0][] = [];
    const movedAgain = [RESPONSE, NUMBER, QUESTION, 'Notes'];
    store.services.qaLogs = { ...files, async save(request) {
      saves.push(request);
      if (saves.length !== 1) return files.save(request);
      await write(movedAgain, [first, second].map(([n, q]) => ['', n, q, 'Keep these notes']));
      return fail(rejected('The kept steps were refused'));
    } };
    expect(await exportQaLog(store, dealId)).toMatchObject({ ok: true, value: { unmerged: 1 } });
    expect(saves[0].steps).toEqual(expect.arrayContaining([{ kind: 'cell', row: 1, col: 3, value: retained }]));
    expect(saves[1].steps).toEqual([{ kind: 'cell', row: 2, col: 0, value: answer }]);
    expect(read()).toEqual([movedAgain, ['', first[0], first[1], 'Keep these notes'],
      [answer, second[0], second[1], 'Keep these notes']]);
    expect(fs.existsSync(kept)).toBe(false);
    const archive = path.join(folder, '01. Archive');
    const filed = fs.readdirSync(archive).find((name) => name.includes('saved meanwhile'));
    expect(fs.readFileSync(path.join(archive, filed!), 'utf8')).toContain(retained);
  } finally {
    stopAging();
  }
});
