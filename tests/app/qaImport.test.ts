// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { csvCodec } from '../../src/adapters/spreadsheet';
import {
  importKey, initializeKeptImports, keptImport, keptImportsReady,
} from '../../src/app/keptImports';
import {
  keptQaImport, loadQaImport, prepareQaImport, qaImportMakesLog, submitQaImport, summarizeQaImport, type QaChoices,
} from '../../src/app/qaImport';
import { previewImport, proposeLayout, readImportBytes, type ImportTable } from '../../src/app/transfer';
import { QaImportLayout } from '../../src/app/qaImportLayout';
import { SetResponse } from '../../src/app/commands/questions';
import { TakeFromQaLog } from '../../src/app/commands/qaLogs';
import { logOf, updateQaLog } from '../../src/app/qaLog';
import { dealQuestions, qaChanged, qaKept, qaVersions } from '../../src/app/state';
import { ok } from '../../src/domain/result';
import { tableFrom } from '../../src/domain/sheets';
import { suggestMapping } from '../../src/domain/importExport';
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
    const layout = new QaImportLayout(app.store, before.value, before.value.mapping, () => {});
    const updated = layout.reread({ sheet: 'Updated review' });
    expect(layout.view.reading).toBe(true);
    layout.pick('response', 1);
    await updated;
    expect(layout.view).toMatchObject({ mapping: { text: 0, response: 2 }, reading: false, warning: '' });
    await layout.reread({ sheet: 'Alternative review' });
    expect(layout.view).toMatchObject({
      mapping: { text: 0, response: null }, warning: 'Column choice not applied for Response.',
    });
    layout.pick('priority', null);
    expect(layout.view.unapplied).toEqual(['response']);
    const { table, mapping } = layout.view;
    const reopened = new QaImportLayout(app.store, table, mapping, () => {});
    expect(reopened.view.warning).toBe('Column choice not applied for Response.');
    reopened.pick('response', null);
    expect(reopened.view).toMatchObject({ mapping: { response: null, priority: null }, warning: '' });
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
    const plan = summarizeQaImport(importKey.qa(dealId), prepared, dry);
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

it('previews a control-only question from the file and imports it exactly as given', async () => {
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
    expect(prepared.skipped).toBe(0);
    expect(prepared.rows.map((row) => row.text)).toEqual(['\u007f', question]);
    const submitted = await submitQaImport(app.store, dealId, { table, choices }, prepared.rows);
    expect(submitted).toEqual(ok(undefined));
    expect(dealQuestions(app.store.get(), dealId).map((row) => row.text)).toEqual(['\u007f', question]);
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

/** A 2,000-question lender log whose Updated sheet has no "Reviewed reply" column, and a proposal that moves it. */
function twoSheetLog(questions: string[]) {
  const header = ['Number', 'Question', 'Reviewed reply', 'Response'];
  const rows = questions.map((text, at) => [String(at + 1), text, `Reviewed ${at + 1}`, `Reply ${at + 1}`]);
  return [
    { name: 'Initial review', grid: [header, ...rows] },
    { name: 'Updated review', grid: [
      ['Number', 'Question', 'Response'], ...rows.map((row) => [row[0], row[1], row[3]]),
    ] },
  ];
}

it('keeps a column chosen during a layout proposal and refuses an unapplied one (#741)', async () => {
  await useKeptPort();
  const app = recoveryApp();
  const sheets = app.store.services.sheets;
  const read = sheets.read;
  const questions = portfolioQuestions().slice(0, 2_000);
  const book = twoSheetLog(questions);
  sheets.read = async (_bytes, _filename, location) => ok(tableFrom(book, location)!);
  try {
    const dealId = await recoveryDeal(app);
    const initial = await readImportBytes(app.store, NAME, new Uint8Array(), { sheet: 'Initial review' });
    if (!initial.ok) throw new Error(initial.error.message);
    const layout = new QaImportLayout(app.store, initial.value, initial.value.mapping, () => {});
    layout.pick('response', 2);
    const proposal = { ...initial.value, mapping: { ...initial.value.mapping, response: 3 } };
    layout.propose(proposal);
    expect(layout.view).toMatchObject({ mapping: { text: 1, response: 2 }, warning: '' });
    await layout.reread({ sheet: 'Updated review' });
    const { table, mapping } = layout.view;
    expect(layout.view.warning).toBe('Column choice not applied for Response.');
    if (!table || !mapping) throw new Error('no layout');
    const { prepared } = prepareQaImport(table, mapping);
    expect(prepared.rows).toHaveLength(2_000);
    const choices = { ...choicesFor(table, null), mapping };
    const refused = await submitQaImport(app.store, dealId, { table, choices }, prepared.rows);
    expect(refused).toMatchObject({ ok: false, error: { kind: 'rejected' } });
    expect(dealQuestions(app.store.get(), dealId)).toHaveLength(0);
    layout.pick('response', null);
    const next = layout.view;
    const resolved = { ...choicesFor(next.table!, null), mapping: next.mapping! };
    const sent = await submitQaImport(app.store, dealId, { table: next.table!, choices: resolved }, prepared.rows);
    expect(sent).toEqual(ok(undefined));
    expect(dealQuestions(app.store.get(), dealId)).toHaveLength(2_000);
  } finally {
    sheets.read = read;
    app.store.closing();
    await app.repo.close();
  }
});

/** A 2,000-row table whose Submitted by column (2) names the given parties in turn. */
function partiesTable(parties: string[]) {
  const questions = portfolioQuestions().slice(0, 2_000);
  const grid = questions.map((text, at) => [String(at + 1), text, parties[at % parties.length]]);
  const headings = ['Number', 'Question', 'Submitted by'];
  const table = tableFrom([{ name: 'Sheet1', grid: [headings, ...grid] }])!;
  return { table: table as unknown as ImportTable, mapping: { ...suggestMapping(headings), askedBy: 2 } };
}

it('makes a consolidated log the deal\'s Q&A log unless the person chose otherwise', () => {
  const untouched = { makeLog: false, touched: false };
  const two = partiesTable(['Lender A', ' lender a ', 'Sponsor']);
  const one = partiesTable(['Lender A', ' LENDER A', 'lender a ']);
  expect(qaImportMakesLog(two.table, two.mapping, untouched)).toBe(true);
  expect(qaImportMakesLog(one.table, one.mapping, untouched)).toBe(false);
  expect(qaImportMakesLog(two.table, { ...two.mapping, askedBy: null }, untouched)).toBe(false);
  expect(qaImportMakesLog(null, null, untouched)).toBe(false);
  expect(qaImportMakesLog(two.table, two.mapping, { makeLog: false, touched: true })).toBe(false);
  expect(qaImportMakesLog(one.table, one.mapping, { makeLog: true, touched: true })).toBe(true);
});

const logHeadings = ['No.', 'Question', 'Submitted by', 'Response'];

async function importPortfolioLog(app: ReturnType<typeof recoveryApp>, dealId: string, rows: string[][]) {
  app.store.services.fs.pathFor = () => PATH;
  const picked = await loadQaImport(app.store, dealId, await csvFile([logHeadings, ...rows]));
  if (!picked.ok) throw new Error(picked.error.message);
  const { table, path } = picked.value;
  const choices = choicesFor(table, path, true);
  const { prepared } = prepareQaImport(table, choices.mapping);
  expect(await submitQaImport(app.store, dealId, { table, choices }, prepared.rows)).toEqual(ok(undefined));
}

function portfolioLogRows(response: (at: number) => string) {
  return portfolioQuestions().map((text, at) => [
    String(at + 1), text, at % 2 ? 'Contoso' : 'Fabrikam', response(at),
  ]);
}

function mockLogUpdate(app: ReturnType<typeof recoveryApp>, rows: string[][]) {
  const table = tableFrom([{ name: 'Sheet1', grid: [logHeadings, ...rows] }])!;
  app.store.services.qaLogs!.read = async () => ok({ ...table, stamp: 'edited' });
  const save = vi.spyOn(app.store.services.qaLogs!, 'save');
  return save;
}

it('takes all 25 first responses typed only in a 2,376-question log (#1392)', async () => {
  await useKeptPort();
  const app = recoveryApp(undefined, [TakeFromQaLog]);
  try {
    const dealId = await recoveryDeal(app);
    const rows = portfolioLogRows(() => '');
    await importPortfolioLog(app, dealId, rows);
    const questions = dealQuestions(app.store.get(), dealId);
    expect(questions).toHaveLength(2_376);
    expect(questions.every((question) => question.response === '')).toBe(true);

    const responses = new Map(Array.from({ length: 25 }, (_, at) => [
      1 + at * 97, at === 0 ? ' \t ' : `  See counsel’s note (section ${at + 1}).\nSigned copy enclosed.  `,
    ]));
    const edited = rows.map((row, at) => [...row.slice(0, 3), responses.get(at + 1) ?? '']);
    const save = mockLogUpdate(app, edited);
    expect(await updateQaLog(app.store, dealId)).toMatchObject({
      kind: 'updated', counts: { changed: 25, added: 0, answered: 0, updated: 0 }, versions: 0,
    });
    expect(save).not.toHaveBeenCalled();

    const state = app.store.get();
    const last = logOf(app.store, dealId)!.last!;
    for (const { id, n } of questions) {
      const response = responses.get(n);
      const question = state.questions[id];
      expect(question.response, `response for Q${n}`).toBe(response ?? '');
      expect(qaChanged(state, question), `Changed fields for Q${n}`).toEqual(response ? ['response'] : []);
      expect(last.changed[id]).toEqual(response ? { response: '' } : undefined);
      expect(last.sent[id].response).toBe(response);
    }
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});

it('keeps both exact responses in 120 conflicts on a 2,376-question log', async () => {
  await useKeptPort();
  const app = recoveryApp(undefined, [TakeFromQaLog]);
  try {
    const dealId = await recoveryDeal(app);
    const original = 'The data room holds the draft.';
    const rows = portfolioLogRows((at) => at < 120 ? original : '');
    await importPortfolioLog(app, dealId, rows);

    const conflicts = dealQuestions(app.store.get(), dealId).filter(({ n }) => n <= 120);
    expect(conflicts).toHaveLength(120);
    const appResponse = 'Counsel is reviewing the draft.';
    const logResponse = 'The signed copy supersedes the draft.';
    for (const { id } of conflicts) {
      expect((await app.store.dispatch(SetResponse, { dealId, questionId: id, response: appResponse })).ok).toBe(true);
    }
    const edited = rows.map((row, at) => at < 120 ? [...row.slice(0, 3), logResponse] : row);
    const save = mockLogUpdate(app, edited);
    expect(await updateQaLog(app.store, dealId)).toMatchObject({
      kind: 'updated', counts: { changed: 0, added: 0, answered: 0, updated: 0 }, versions: 120,
    });
    expect(save).not.toHaveBeenCalled();

    const state = app.store.get();
    const last = logOf(app.store, dealId)!.last!;
    for (const { id } of conflicts) {
      const question = state.questions[id];
      expect(question.response).toBe(appResponse);
      expect(qaVersions(state, question)).toBe('Two versions');
      expect(qaKept(state, question)).toEqual({ response: logResponse });
      expect(last.sent[id].response).toBe(original);
    }
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});
