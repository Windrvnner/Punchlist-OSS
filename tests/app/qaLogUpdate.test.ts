// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { RecordQaLogExport } from '../../src/app/commands/qaLogs';
import { SetResponse } from '../../src/app/commands/questions';
import {
  exportQaLog, keepImportedLog, keptRowTaken, logOf, markQaLogSeen, updateQaLog, type QaLogUpdateOutcome,
} from '../../src/app/qaLog';
import { dealQuestions, qaChanged } from '../../src/app/state';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { cell, type KeptAsk } from '../../src/domain/keptMerge';
import { ok } from '../../src/domain/result';
import type { QaLogFiles } from '../../src/ports';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp, recoveryDeal, type RecoveryApp } from './recoveryKit';

const NAME = 'Portfolio lender requests.csv';
const COLUMNS = ['Number', 'Question', 'Response', 'Submitted by'];
const MAPPING = suggestMapping(COLUMNS);
const QUESTIONS = portfolioQuestions();
const WRITTEN = ok({ status: 'written' as const, archive: 'Portfolio lender requests 2026-11-19.csv' });
const BUSY = ok({ status: 'later' as const, by: 'lender.team' });
const apps: RecoveryApp[] = [];

async function fixture(size = 216) {
  const app = recoveryApp();
  apps.push(app);
  const dealId = await recoveryDeal(app);
  const { store } = app;
  const rows = QUESTIONS.slice(0, size).map((question, index) => [String(index + 1), question, '', 'Lender A']);
  const table = { columns: COLUMNS, cols: [0, 1, 2, 3], lines: rows.map((_, index) => index + 2),
    lastRow: rows.length + 1, rows, stamp: 'first-read' };
  const read = vi.fn<QaLogFiles['read']>().mockResolvedValue(ok(table));
  const save = vi.fn<QaLogFiles['save']>().mockResolvedValue(WRITTEN);
  store.services.qaLogs = { ...store.services.qaLogs!, read, save };
  const imported = prepareImport(rows, MAPPING);
  expect(await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: imported.rows }, { quiet: true }))
    .toMatchObject({ ok: true });
  expect(await keepImportedLog(store, dealId, {
    path: `X:\\Deals\\Portfolio\\${NAME}`, sheet: 'Log', headerRow: 1, mapping: MAPPING, make: true, rows,
  })).toMatchObject({ ok: true });
  const questions = dealQuestions(store.get(), dealId);
  expect(questions).toHaveLength(size);
  const response = 'The executed EPC contract is in the Construction folder.';
  expect(await store.dispatch(SetResponse, { dealId, questionId: questions[0].id, response }, { quiet: true }))
    .toMatchObject({ ok: true });
  return { store, dealId, read, save, table, questions, response };
}

afterEach(async () => {
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  for (const { store, repo } of apps.splice(0)) {
    store.closing();
    await repo.close();
  }
});

it('writes the change and records what the log holds for a full portfolio', async () => {
  const { store, dealId, save, questions, response } = await fixture(QUESTIONS.length);
  const outcome = await updateQaLog(store, dealId);
  expect(outcome).toMatchObject({ kind: 'updated', counts: { answered: 1, added: 0, changed: 0 }, versions: 0 });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ file: NAME, steps: [cell(1, 2, response)] }));
  expect(logOf(store, dealId)?.last).toMatchObject({ sent: { [questions[0].id]: { response } } });
});

it('retries at 30-second intervals and reports that the third attempt saved', async () => {
  const { store, dealId, save } = await fixture();
  const dismiss = vi.fn();
  const announce = vi.fn((outcome: QaLogUpdateOutcome) => outcome.kind === 'retrying' ? dismiss : undefined);
  save.mockResolvedValueOnce(BUSY).mockResolvedValueOnce(ok({ status: 'later' }));
  vi.useFakeTimers();
  expect(await updateQaLog(store, dealId, { announce })).toMatchObject({ kind: 'retrying', by: 'lender.team' });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(save).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledTimes(2);
  expect(announce).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'retrying', by: undefined }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(save).toHaveBeenCalledTimes(3);
  expect(dismiss).toHaveBeenCalledTimes(2);
  expect(announce).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'updated' }));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(save).toHaveBeenCalledTimes(3);
});

it('stops after 40 retries and offers a fresh manual attempt', async () => {
  const { store, dealId, save } = await fixture();
  const announce = vi.fn((_outcome: QaLogUpdateOutcome) => undefined);
  save.mockResolvedValue(BUSY);
  vi.useFakeTimers();
  await updateQaLog(store, dealId, { announce });
  await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
  expect(save).toHaveBeenCalledTimes(40);
  expect(announce.mock.lastCall?.[0].kind).toBe('retrying');
  await vi.advanceTimersByTimeAsync(1);
  expect(save).toHaveBeenCalledTimes(41);
  const stopped = announce.mock.lastCall?.[0];
  expect(stopped?.kind).toBe('retryLimit');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(save).toHaveBeenCalledTimes(41);
  save.mockResolvedValueOnce(WRITTEN);
  if (stopped?.kind !== 'retryLimit') throw new Error('Expected a manual retry after the automatic limit');
  expect(await stopped.retry()).toMatchObject({ kind: 'updated' });
  expect(save).toHaveBeenCalledTimes(42);
});

it('replaces a waiting timer when Retry Now succeeds', async () => {
  const { store, dealId, save } = await fixture();
  save.mockResolvedValueOnce(BUSY);
  vi.useFakeTimers();
  const waiting = await updateQaLog(store, dealId);
  if (waiting.kind !== 'retrying') throw new Error('Expected a retry for the busy log');
  expect(await waiting.retry()).toMatchObject({ kind: 'updated' });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(save).toHaveBeenCalledTimes(2);
});

it('refuses a second update for the same deal while the file save is pending', async () => {
  const { store, dealId, read, save } = await fixture();
  let enter!: () => void;
  let finish!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const paused = new Promise<void>((resolve) => { finish = resolve; });
  save.mockImplementationOnce(async () => {
    enter();
    await paused;
    return WRITTEN;
  });
  const first = updateQaLog(store, dealId);
  await entered;
  try {
    expect(await updateQaLog(store, dealId)).toEqual({ kind: 'busy' });
    expect(await exportQaLog(store, dealId)).toMatchObject({ ok: false, error: { kind: 'rejected' } });
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    finish();
  }
  expect(await first).toMatchObject({ kind: 'updated' });
  expect(save).toHaveBeenCalledTimes(1);
});

it('retains current seen marks and prunes older and missing ones when a change is seen', async () => {
  const { store, dealId, questions } = await fixture(QUESTIONS.length);
  const [first, current, stale, unopened] = questions;
  const log = logOf(store, dealId)!;
  const last = log.last!;
  const at = store.services.clock.now();
  const changed: Record<string, Record<string, string>> = {
    [first.id]: { response: '' }, [unopened.id]: { status: 'Open' },
  };
  expect(await store.dispatch(RecordQaLogExport, { dealId, name: log.name, last: { ...last, at, changed } },
    { quiet: true })).toMatchObject({ ok: true });
  store.setPrefs({ qaSeen: { [current.id]: at, [stale.id]: last.at, removed: at } });
  expect(qaChanged(store.get(), first)).toEqual(['response']);
  markQaLogSeen(store, first.id);
  const seen = { [current.id]: at, [first.id]: at };
  expect(store.get().prefs.qaSeen).toEqual(seen);
  expect(store.services.local.read('prefs')).toMatchObject({ qaSeen: seen });
  expect(qaChanged(store.get(), first)).toEqual([]);
  expect(qaChanged(store.get(), unopened)).toEqual(['status']);
});

it('refuses two kept edits aimed at the same log row before writing or filing either', async () => {
  const { store, dealId, read, save, table } = await fixture();
  const file = '~Portfolio a1b2c3d4.old';
  const candidate = (row: number, text: string) => ({
    row, line: row + 2, steps: [cell(row + 1, 2, text)], clash: false,
  });
  const ask: (KeptAsk & { file: string })[] = [
    { file, question: QUESTIONS[20], cells: [], rows: [candidate(20, 'EPC assignment accepted')], add: [] },
    { file, question: QUESTIONS[21], cells: [], rows: [candidate(21, 'Permit issued'), candidate(20, 'Permit issued')],
      add: [] },
  ];
  const settle = vi.fn<NonNullable<QaLogFiles['settle']>>().mockResolvedValue(ok({ gone: [file] }));
  store.services.qaLogs!.settle = settle;
  const kept = { files: [{ name: file, hash: 'saved-edit' }], steps: [], clashes: [], ask };
  read.mockResolvedValue(ok({ ...table, kept }));
  expect(keptRowTaken(ask, [0, undefined], 1, 1)).toBe(true);
  expect(keptRowTaken(ask, [0, undefined], 1, 0)).toBe(false);
  expect(await updateQaLog(store, dealId, { place: async () => [0, 1] }))
    .toMatchObject({ kind: 'failed', error: { kind: 'invalid' } });
  expect(save).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(await updateQaLog(store, dealId, { place: async () => [0, 0] })).toMatchObject({ kind: 'updated' });
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ steps: expect.arrayContaining([
    cell(21, 2, 'EPC assignment accepted'), cell(22, 2, 'Permit issued'),
  ]) }));
  expect(settle).toHaveBeenCalledTimes(1);
});
