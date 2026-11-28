import { expect, it } from 'vitest';
import { DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { ChooseQaVersion, KeepQaLog, RecordQaLogExport } from '../../src/app/commands/qaLogs';
import { submitQaImport } from '../../src/app/qaImport';
import { chooseVersion } from '../../src/app/qaLog';
import { qaKept } from '../../src/app/state';
import { readImportBytes } from '../../src/app/transfer';
import { prepareImport } from '../../src/domain/importExport';
import { failRecoveryWrite, operationWrite, recoveryApp, recoveryDeal } from './recoveryKit';

it.each([false, true])('keeps a newer conflict resolution after log retry (restored: %s)', async (restoreQuestion) => {
  const app = recoveryApp(undefined, [ChooseQaVersion, DeleteQuestion, RestoreQuestion]);
  const dealId = await recoveryDeal(app);
  try {
    const file = 'Lender Q&A.csv';
    const folder = '/synthetic';
    const bytes = Uint8Array.from(new TextEncoder().encode('Question,Submitted by\nConfirm waiver,Contoso'));
    const read = await readImportBytes(app.store, file, bytes);
    if (!read.ok) throw new Error(read.error.message);
    const table = read.value;
    const { mapping, sheet, headerRow } = table;
    const { rows } = prepareImport(table.rows, mapping);
    const initialRows = [{ ...rows[0], response: 'Initial response' }];
    expect((await app.store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: initialRows })).ok).toBe(true);
    const question = Object.values(app.store.get().questions)[0];
    const name = 'Lender Q&A';
    const log = { name, file, folder, sheet, headerRow, mapping };
    expect((await app.store.dispatch(KeepQaLog, { dealId, log })).ok).toBe(true);
    const last = {
      archive: '', at: '2026-11-27T16:20:00.000Z', by: 'Peer',
      sent: { [question.id]: { response: 'Initial response' } },
      kept: { [question.id]: { response: 'From file' } }, changed: {},
    };
    expect((await app.store.dispatch(RecordQaLogExport, { dealId, name, last })).ok).toBe(true);
    const choices = { mapping, path: folder + '/' + file, mode: 'merge' as const, answered: false, makeLog: true };
    const newerFile = Uint8Array.from(new TextEncoder().encode('Question,Submitted by\nReview insurance,Contoso'));
    const other = await readImportBytes(app.store, file, newerFile);
    if (!other.ok) throw new Error(other.error.message);
    const importTable = restoreQuestion ? other.value : table;
    const importRows = prepareImport(importTable.rows, mapping).rows;
    const submit = () => submitQaImport(app.store, dealId, {
      table: importTable, choices: { ...choices, touched: true },
    }, importRows);
    const target = { dealId, questionId: question.id };
    if (restoreQuestion) expect((await app.store.dispatch(DeleteQuestion, target)).ok).toBe(true);
    const restore = failRecoveryWrite(app, (tx) => operationWrite(tx, 'RecordQaLogExport', 'succeeded'), 'Log busy');
    expect(await submit()).toMatchObject({ ok: false, error: { message: expect.stringContaining('Log busy') } });
    restore();

    if (restoreQuestion) expect((await app.store.dispatch(RestoreQuestion, target)).ok).toBe(true);
    const conflict = () => qaKept(app.store.get(), app.store.get().questions[question.id]);
    expect(conflict()).toEqual({ response: 'From file' });
    const revision = app.store.get().deals[dealId].rev;
    expect((await chooseVersion(app.store, dealId, question.id, 'app')).ok).toBe(true);
    expect(app.store.get().deals[dealId].rev).toBe(revision);
    expect(conflict()).toEqual({});

    const retried = await submit();
    expect(conflict()).toEqual({});
    expect(retried).toMatchObject({ ok: false, error: { message: expect.stringMatching(/changed/i) } });
  } finally {
    app.store.closing();
    await app.repo.close();
  }
});
