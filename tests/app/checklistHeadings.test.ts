// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { MemoryKeptImports } from '../../src/adapters/keptImports';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { ChecklistImportSession } from '../../src/app/checklistImportSession';
import { initializeKeptImports, keptImportsReady } from '../../src/app/keptImports';
import { loadChecklistSource, readChecklistColumns } from '../../src/app/listRead';
import { readImportBytes } from '../../src/app/transfer';
import { listId } from '../../src/domain/checklist';
import { tableLines } from '../../src/domain/listRead';
import { fail, ok } from '../../src/domain/result';
import { tableFrom } from '../../src/domain/sheets';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp } from './recoveryKit';

const titles = [
  ['Renewable portfolio diligence'],
  ['Lender requests for the acquisition'],
  ['Scope includes operating and construction assets'],
  ['Provide signed records wherever available'],
  ['Prepared for the investment review'],
];
const sections = ['Contracts', 'Permits and land', 'Operations', 'Financing'];
const items = portfolioQuestions().slice(0, 2_000).map((text, at) => [sections[Math.floor(at / 500)], text]);
const grid = (heading: string) => [...titles, ['Section', heading], ...items];

beforeEach(async () => {
  initializeKeptImports(new MemoryKeptImports());
  await keptImportsReady;
});

it.each(['Requirement', 'Description', 'Diligence item', 'Item'])(
  'finds row 6 with Section and %s, and brings in every item',
  async (heading) => {
    const app = recoveryApp();
    await app.store.boot();
    const readList = vi.fn(async () => fail({ kind: 'failed', message: 'Reading unavailable' }));
    app.store.services.ai.readList = readList;
    const session = new ChecklistImportSession(app.store, {});
    void session.start();
    try {
      const csv = await csvCodec.write('Sheet1', grid(heading));
      if (!csv.ok) throw new Error(csv.error.message);
      await session.load(new File([csv.value.bytes.slice().buffer], 'Portfolio diligence.csv'));
      expect(session.view.source.table?.headerRow).toBe(1);
      const [first, ...rest] = grid(heading).map(([left, right = '']) => [left, right]);
      expect(readList).toHaveBeenCalledExactlyOnceWith({ lines: tableLines(first, rest) });
      expect(session.view.source.readFailed).toBe('failed');

      await session.chooseColumns();
      expect(session.view.source.table).toMatchObject({
        columns: ['Section', heading], headerRow: 6, lastRow: 2_006, rows: items,
      });
      expect(session.view.source.mapping).toMatchObject({ item: 1, section: 0 });
      expect(session.view.canNext).toBe(true);
      session.setAskReword(false);
      session.setAskSame(false);
      await session.next();
      await session.bringIn();
      expect(app.store.get().firmList[listId('broad', '')]?.items).toEqual(
        items.map(([section, text]) => ({ section, text })),
      );
    } finally {
      session.dispose();
      app.store.closing();
      await app.repo.close();
    }
  },
);

it('chooses sheets by the import’s own headings and respects explicit sheet and row picks', async () => {
  const app = recoveryApp();
  const workbook = [
    { name: 'Lender Q&A', grid: [['For the lenders'], ['Query', 'Response'], ['Who holds the permits?', 'The SPV']] },
    { name: 'Diligence', grid: grid('Requirement') },
    { name: 'Supplement', grid: grid('Diligence item') },
  ];
  app.store.services.sheets = {
    ...csvCodec, read: async (_bytes, _name, options) => ok(tableFrom(workbook, options)!),
  };
  try {
    const file = new File(['Workbook fixture'], 'Combined workbook.xlsx');
    const loaded = await loadChecklistSource(app.store, file);
    if (!loaded.ok || !('table' in loaded.value)) throw new Error('Expected checklist workbook');
    const model = loaded.value.table;
    expect(model).toMatchObject({ sheet: 'Diligence', headerRow: 1, columns: [titles[0][0], ''] });
    expect(model.rows).toEqual([...titles.slice(1).map(([text]) => [text, '']), ['Section', 'Requirement'], ...items]);

    const manual = await readChecklistColumns(app.store, model, {}, true);
    expect(manual).toMatchObject({
      ok: true, value: { table: { sheet: 'Diligence', headerRow: 6, rows: items }, mapping: { item: 1, section: 0 } },
    });
    const picked = await readChecklistColumns(app.store, model, { sheet: 'Supplement' }, true);
    expect(picked).toMatchObject({
      ok: true, value: { table: { sheet: 'Supplement', headerRow: 6, rows: items }, mapping: { item: 1, section: 0 } },
    });
    const explicit = await readChecklistColumns(app.store, model, { sheet: 'Supplement', headerRow: 1 }, true);
    expect(explicit).toMatchObject({ ok: true, value: { table: { sheet: 'Supplement', headerRow: 1 } } });

    const qa = await readImportBytes(app.store, file.name, new Uint8Array());
    expect(qa).toMatchObject({
      ok: true, value: { sheet: 'Lender Q&A', headerRow: 2, columns: ['Query', 'Response'] },
    });
  } finally {
    await app.repo.close();
  }
});
