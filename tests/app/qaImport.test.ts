// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { csvCodec } from '../../src/adapters/spreadsheet';
import {
  importKey, initializeKeptImports, keptImport, keptImportsReady,
} from '../../src/app/keptImports';
import {
  keptQaImport, loadQaImport, prepareQaImport, submitQaImport, summarizeQaImport, type QaChoices,
} from '../../src/app/qaImport';
import {
  previewImport, proposeLayout, readImportBytes, rereadImportTable, type ImportTable,
} from '../../src/app/transfer';
import { dealQuestions } from '../../src/app/state';
import { ok } from '../../src/domain/result';
import { tableFrom } from '../../src/domain/sheets';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { copyRecoveryDisk, holdRecoveryWrite, operationWrite, recoveryApp, recoveryDeal } from './recoveryKit';

const NAME = 'Portfolio lender requests.csv';
const PATH = `/synthetic/${NAME}`;

async function useKeptPort(port = new MemoryKeptImports()) {
  initializeKeptImports(port);
  await keptImportsReady;
  return port;
}

async function csvFile(rows: string[][]) {
  const encoded = await csvCodec.write('Sheet1', rows);
  if (!encoded.ok) throw new Error(encoded.error.message);
  return new File([encoded.value.bytes.slice().buffer], NAME);
}

function choicesFor(table: ImportTable, path: string | null, makeLog = false): QaChoices {
  return { mapping: table.mapping, path, mode: 'append', answered: true, makeLog, touched: true };
}

function questionsGrid(questions: string[]) {
  const dates = ['30/09/2026', '01/10/2026', '15/10/2026', '31/31/2026'];
  return questions.map((text, at) => [
    String(at + 1), text, at % 2 ? 'Contoso' : 'Fabrikam', dates[at] ?? '2026-10-15',
    'The signed project documents have been added to the data room.',
  ]);
}

it('carries a column to another sheet only when its heading identifies it (#741)', async () => {
  const app = recoveryApp();
  const sheets = app.store.services.sheets;
  const read = sheets.read;
  sheets.read = async (_bytes, _filename, location) => ok(tableFrom([
    { name: 'Initial review', grid: [
      ['Question', 'Reviewed reply', 'Response'],
      ['Provide the debt repayment schedule', 'Monthly installments', 'Schedule pending'],
    ] },
    { name: 'Updated review', grid: [
      ['Question', 'Response', 'Reviewed reply'],
      ['Confirm the repayment dates', 'Awaiting confirmation', 'Due on each payment date'],
    ] },
    { name: 'Alternative review', grid: [
      ['Question', 'Reviewed reply', 'Reviewed reply', 'Response'],
      ['Confirm the amortization frequency', 'Monthly', 'Quarterly', 'Awaiting confirmation'],
    ] },
  ], location)!);
  try {
    const before = await readImportBytes(app.store, NAME, new Uint8Array(), { sheet: 'Initial review' });
    if (!before.ok) throw new Error(before.error.message);
    const chosen = new Map([['response' as const, 1]]);
    const updated = await rereadImportTable(app.store, before.value, { sheet: 'Updated review' }, chosen);
    expect(updated).toMatchObject({ ok: true, value: { mapping: { text: 0, response: 2 }, error: '' } });
    const ambiguous = await rereadImportTable(app.store, before.value, { sheet: 'Alternative review' }, chosen);
    expect(ambiguous).toMatchObject({
      ok: true, value: { mapping: { text: 0, response: null }, error: 'Column choice not applied for Response.' },
    });
  } finally {
    sheets.read = read;
    app.store.closing();
    await app.repo.close();
  }
});

it('finds the proposed layout, shares the prepared rows with the preview, and imports 2,000 questions', async () => {
  await useKeptPort();
  const app = recoveryApp();
  try {
    const dealId = await recoveryDeal(app);
    const questions = portfolioQuestions().slice(0, 2_000);
    const grid = questionsGrid(questions);
    const file = await csvFile([
      ['Renewable portfolio', 'Lender requests'],
      ['Number', 'Lender inquiry', 'Submitted by', 'Received', 'Sponsor reply'],
      ['0', '', 'Contoso', '', 'Response carried over from a prior table'],
      ...grid,
    ]);
    app.store.services.fs.pathFor = vi.fn(() => PATH);
    const model = vi.fn(async () => ok({
      sheet: 'Sheet1', headerRow: 2, fields: { text: 'Lender inquiry', response: 'Sponsor reply' },
    }));
    app.store.services.ai.layout = model;
    const picked = await loadQaImport(app.store, dealId, file);
    if (!picked.ok) throw new Error(picked.error.message);
    expect(picked.value).toMatchObject({ path: PATH, askForLayout: true });
    const layout = await proposeLayout(app.store, picked.value.table);
    if (!layout.ok) throw new Error(layout.error.message);
    expect(model).toHaveBeenCalledWith(expect.objectContaining({ fileName: NAME }));
    expect(layout.value).toMatchObject({
      headerRow: 2, proposedByAi: true, mapping: { text: 1, response: 4, received: 3 },
    });
    const choices = choicesFor(layout.value, picked.value.path);
    const { prepared, previewRows } = prepareQaImport(layout.value, choices.mapping);
    expect(prepared).toMatchObject({ skipped: 1, badDates: 1 });
    expect(prepared.rows.map((row) => row.text)).toEqual(questions);
    expect(previewRows.map((row) => row.cells)).toEqual(grid.slice(0, 5));
    expect(previewRows.map((row) => row.dates.received))
      .toEqual(['2026-09-30', '2026-10-01', '2026-10-15', '', '2026-10-15']);
    const dry = previewImport(app.store, dealId, choices.mode, prepared.rows, choices.answered);
    const plan = summarizeQaImport(app.store.get(), dealId, importKey.qa(dealId), choices.mode, prepared, dry);
    expect(plan).toMatchObject({ total: 2_000, preview: { created: 2_000 } });
    const submitted = await submitQaImport(app.store, dealId, { table: layout.value, choices }, prepared.rows);
    expect(submitted).toEqual(ok(undefined));
    const written = dealQuestions(app.store.get(), dealId);
    expect(written.map((row) => row.text)).toEqual(questions);
    expect(written[1]).toMatchObject({ received: '2026-10-01', status: 'answered' });
    expect(keptImport(importKey.qa(dealId))).toBeUndefined();
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('reopens the kept choices after a committed Append loses its reply, without appending twice', async () => {
  const port = await useKeptPort();
  const app = recoveryApp();
  const dealId = await recoveryDeal(app);
  const key = importKey.qa(dealId);
  const questions = portfolioQuestions().slice(0, 2);
  const headers = ['Number', 'Question', 'Submitted by', 'Received', 'Response'];
  const file = await csvFile([headers, ...questionsGrid(questions)]);
  app.store.services.fs.pathFor = () => PATH;
  const picked = await loadQaImport(app.store, dealId, file);
  if (!picked.ok) throw new Error(picked.error.message);
  const { table, path } = picked.value;
  const choices = choicesFor(table, path, true);
  const { prepared } = prepareQaImport(table, choices.mapping);
  const hold = holdRecoveryWrite(app, (transaction) =>
    transaction.writes.some((write) => write.kind === 'question')
      && operationWrite(transaction, 'ImportQuestions', 'succeeded'), true);
  const submitting = submitQaImport(app.store, dealId, { table, choices }, prepared.rows);
  await hold.entered;
  const crashed = copyRecoveryDisk(app.saved);
  const resumedPort = new MemoryKeptImports();
  try {
    await resumedPort.write(await port.read());
    expect(keptImport(key)?.submission).toMatchObject({ choices, rows: prepared.rows });
    const repeated = await submitQaImport(app.store, dealId, { table, choices }, prepared.rows);
    expect(repeated).toMatchObject({
      ok: false, error: { message: 'This import is still running. Retry after it finishes.' },
    });
  } finally {
    hold.release();
    await submitting;
    app.store.closing();
    await app.repo.close();
  }

  const reopened = recoveryApp(crashed);
  try {
    await useKeptPort(resumedPort);
    await reopened.store.boot();
    await reopened.store.loadDeal(dealId, { gaps: false });
    const saved = keptQaImport(key);
    expect(saved?.choices).toEqual(choices);
    if (!saved) throw new Error('The import was not restored');
    const rows = prepareQaImport(saved.table, saved.choices.mapping).prepared.rows;
    expect(await submitQaImport(reopened.store, dealId, saved, rows)).toEqual(ok(undefined));
    expect(dealQuestions(reopened.store.get(), dealId).map((row) => row.text)).toEqual(questions);
    const [log] = reopened.store.get().deals[dealId].qaLogs;
    expect(log).toMatchObject({ file: NAME, headerRow: 1, mapping: { text: 1, response: 4 } });
    expect(Object.keys(log.last!.sent)).toHaveLength(2);
    expect(reopened.store.interruptedOps()).toEqual([]);
    expect(keptQaImport(key)).toBeNull();
  } finally {
    reopened.store.closing();
    await reopened.repo.close();
  }
});

it('previews a control-only question from the file and submits only the sanitized rows', async () => {
  await useKeptPort();
  const app = recoveryApp();
  try {
    const dealId = await recoveryDeal(app);
    const question = 'Confirm the interconnection agreement remains in force.';
    const shown = ['1', '\u007f', 'Lender counsel accepted the covenant', '2026-09-30'];
    const file = await csvFile([
      ['Number', 'Question', 'Response', 'Received'], shown, ['2', question, '', '2026-10-01'],
    ]);
    const picked = await loadQaImport(app.store, dealId, file);
    if (!picked.ok) throw new Error(picked.error.message);
    const { table, path } = picked.value;
    const choices = choicesFor(table, path);
    const { prepared, previewRows } = prepareQaImport(table, choices.mapping);
    expect(previewRows).toHaveLength(2);
    expect(previewRows[0]).toMatchObject({ cells: shown, dates: { received: '2026-09-30' } });
    expect(prepared.skipped).toBe(1);
    expect(prepared.rows.map((row) => row.text)).toEqual([question]);
    const submitted = await submitQaImport(app.store, dealId, { table, choices }, prepared.rows);
    expect(submitted).toEqual(ok(undefined));
    expect(dealQuestions(app.store.get(), dealId).map((row) => row.text)).toEqual([question]);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});
