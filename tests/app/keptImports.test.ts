// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { ok, fail } from '../../src/domain/result';
import type { KeptImportPart } from '../../src/ports';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';

const load = async () => {
  vi.resetModules();
  return import('../../src/app/keptImports');
};

describe('an import kept as it was left', () => {
  it('is ready at once without IndexedDB, and keeps each part as handed over', async () => {
    const k = await load();
    await k.keptImportsReady;
    const table = { rows: portfolioQuestions().map((text) => [text]) };
    k.keepImport('qa:d_1', { table, choices: { mode: 'append' } });
    expect(k.keptImport('qa:d_1')?.table).toBe(table);
    // a later change hands over the whole state again: the table is the same value, and only the choices change
    k.keepImport('qa:d_1', { table, choices: { mode: 'merge' } });
    expect(k.keptImport('qa:d_1')).toEqual({ table, choices: { mode: 'merge' } });
  });

  it('keeps a part left out as it was, so a paste alone does not take the list it came from', async () => {
    const k = await load();
    k.keepImport(k.importKey.checklist(), { paste: 'Insurance is in place', text: { lines: ['a'] } });
    k.keepImport(k.importKey.checklist(), { paste: 'Insurance is in place\nSurvey delivered' });
    expect(k.keptImport(k.importKey.checklist())).toEqual({
      paste: 'Insurance is in place\nSurvey delivered',
      text: { lines: ['a'] },
    });
  });

  it('is per deal, and dropping one lets only that one go', async () => {
    const k = await load();
    k.keepImport(k.importKey.issues('d_1'), { kept: new Set([2]) });
    k.keepImport(k.importKey.issues('d_2'), { kept: new Set([5]) });
    k.dropImport(k.importKey.issues('d_1'));
    expect(k.keptImport(k.importKey.issues('d_1'))).toBeUndefined();
    expect(k.keptImport(k.importKey.issues('d_2'))?.kept).toEqual(new Set([5]));
    k.dropImport('none');   // nothing kept: nothing happens
  });
});

function defer<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const portfolio = () => {
  const rows = portfolioQuestions().map((question) => [question]);
  const bytes = new TextEncoder().encode(rows.map(([question]) => question).join('\n'));
  return { table: { name: 'Portfolio lender requests.csv', rows, bytes }, choices: { mode: 'append' } };
};

async function start(port: MemoryKeptImports) {
  const keeper = await load();
  keeper.initializeKeptImports(port);
  await keeper.keptImportsReady;
  return keeper;
}

describe('port-backed imports without a window', () => {
  it('restores bytes, model results and updated choices part by part without rewriting the file', async () => {
    const port = new MemoryKeptImports();
    const write = vi.spyOn(port, 'write');
    const first = await start(port);
    const key = first.importKey.qa('portfolio');
    const original = portfolio();
    first.keepImport(key, original);
    await Promise.resolve();

    const layout = { questionColumn: 0, name: 'Lender Requests' };
    const checks = new Set([1, 2099]);
    first.keepImport(key, { table: original.table, choices: { mode: 'merge' }, layout, checks });
    await Promise.resolve();
    expect(write.mock.calls.map(([changes]) => changes.map((change) => 'part' in change && change.part))).toEqual([
      ['table', 'choices'], ['choices', 'layout', 'checks'],
    ]);

    const restarted = await start(port);
    expect(restarted.keptImport(key)).toEqual({ ...original, choices: { mode: 'merge' }, layout, checks });
    expect(restarted.keptImport(key)?.table).not.toBe(original.table);
  });

  it('keeps newer choices when an older snapshot finishes loading after a quick reopen', async () => {
    const port = new MemoryKeptImports();
    const read = defer<KeptImportPart[]>();
    vi.spyOn(port, 'read').mockReturnValueOnce(read.promise);
    const first = await load();
    first.initializeKeptImports(port);
    const key = first.importKey.qa('portfolio');
    const other = first.importKey.checklist();
    const newer = portfolio();
    expect(first.areKeptImportsReady()).toBe(false);
    first.keepImport(key, newer);
    read.resolve([
      { key, part: 'choices', value: { mode: 'merge' } },
      { key, part: 'submission', value: { key: 'qa-import:earlier' } },
      { key: other, part: 'paste', value: 'Confirm warranty dates' },
    ]);
    await first.keptImportsReady;
    expect(first.areKeptImportsReady()).toBe(true);
    expect(first.keptImport(key)).toEqual(newer);
    expect(first.keptImport(other)).toEqual({ paste: 'Confirm warranty dates' });
  });

  it('leaves earlier parts readable on a failed batch and retries the whole current snapshot', async () => {
    const port = new MemoryKeptImports();
    const first = await start(port);
    const key = first.importKey.qa('portfolio');
    const original = portfolio();
    expect(await first.saveImport(key, original)).toBe(true);
    const changed = { table: { ...original.table, name: 'Revised lender requests.csv' }, choices: { mode: 'merge' } };
    const write = vi.spyOn(port, 'write').mockResolvedValueOnce(false);
    expect(await first.saveImport(key, changed)).toBe(false);
    expect(first.keptImport(key)).toEqual(changed);
    expect(await port.read()).toEqual([
      { key, part: 'table', value: original.table }, { key, part: 'choices', value: original.choices },
    ]);

    const checks = new Set([20, 1200]);
    first.keepImport(key, { checks });
    await Promise.resolve();
    expect(write.mock.calls[1]?.[0].map((change) => 'part' in change && change.part)).toEqual([
      'table', 'choices', 'checks',
    ]);
    const restarted = await start(port);
    expect(restarted.keptImport(key)).toEqual({ ...changed, checks });
  });

  it('checkpoints the original submission before journal work and through log failure, retry and release', async () => {
    const port = new MemoryKeptImports();
    const first = await start(port);
    const key = first.importKey.qa('portfolio');
    const state = portfolio();
    expect(await first.saveImport(key, state)).toBe(true);
    const submission = { key: 'qa-import:portfolio', rows: state.table.rows };
    const writing = defer<void>();
    const write = port.write.bind(port);
    vi.spyOn(port, 'write').mockImplementationOnce(async (changes) => {
      await writing.promise;
      return write(changes);
    });
    const importRows = vi.fn(async () => {
      expect(await port.read()).toContainEqual({ key, part: 'submission', value: submission });
      return ok(undefined);
    });
    const keepLog = vi.fn(async () => {
      expect(await port.read()).toContainEqual({ key, part: 'submission', value: submission });
      return fail({ kind: 'failed', message: 'Workbook is open on another PC' });
    });
    const release = vi.fn(async () => true);
    const interrupted = first.finishKeptSubmission(key, submission, { importRows, keepLog, release });
    await Promise.resolve();
    expect(importRows).not.toHaveBeenCalled();
    writing.resolve();
    expect(await interrupted).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('Workbook is open') },
    });
    expect(importRows).toHaveBeenCalledWith(submission);
    expect(keepLog).toHaveBeenCalledWith(submission);
    expect(release).not.toHaveBeenCalled();

    const restarted = await start(port);
    expect(restarted.keptImport(key)?.submission).toEqual(submission);
    const completed = await restarted.finishKeptSubmission(key, submission, {
      importRows: async (saved) => {
        expect(saved.key).toBe(submission.key); // Same key lets Store resume the rows already in its journal.
        return ok(undefined);
      },
      keepLog: async (saved) => {
        expect(saved).toEqual(submission);
        return ok(undefined);
      },
      release: async (correlation) => {
        expect(correlation).toBe(submission.key);
        expect(await port.read()).toContainEqual({ key, part: 'submission', value: { ...submission, done: true } });
        return true;
      },
    });
    expect(completed.ok).toBe(true);
    expect((await start(port)).keptImport(key)).toBeUndefined();
  });
});
