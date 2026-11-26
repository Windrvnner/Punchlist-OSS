// @vitest-environment node
// The model's layout proposal yields to the person's own changes to the Q&A import (#380, #741).
import { afterEach, describe, expect, it } from 'vitest';
import { readImportBytes, type ImportTable } from '../../src/app/transfer';
import { QaImportLayout } from '../../src/app/qaImportLayout';
import { SERVICE } from '../../src/control';
import { fail, ok, type Result } from '../../src/domain/result';
import { tableFrom } from '../../src/domain/sheets';
import { portfolioQuestions } from '../fixtures/portfolioQuestions';
import { recoveryApp, type RecoveryApp } from './recoveryKit';

const NAME = 'Portfolio lender requests.xlsx';
type Proposal = { sheet: string; headerRow: number; fields: Record<string, string> };

/** A 2,000-question log: Initial review has its question in column 1, Updated review in column 2. */
function book() {
  const questions = portfolioQuestions().slice(0, 2_000);
  return [
    { name: 'Initial review', grid: [
      ['Number', 'Question', 'Response'], ...questions.map((text, at) => [String(at + 1), text, `Reply ${at + 1}`]),
    ] },
    { name: 'Updated review', grid: [
      ['Number', 'Owner', 'Question', 'Response'],
      ...questions.map((text, at) => [String(at + 1), 'Sponsor', text, `Reply ${at + 1}`]),
    ] },
  ];
}

const apps: RecoveryApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    app.store.closing();
    await app.repo.close();
  }
});

/** The layout on the Initial review sheet, with the model's answer and each sheet read held until released. */
async function heldLayout() {
  const app = recoveryApp();
  apps.push(app);
  const sheets = book();
  const reads: (() => void)[] = [];
  let holdReads = false;
  app.store.services.sheets.read = async (_bytes, _name, location) => {
    if (holdReads) await new Promise<void>((resolve) => reads.push(resolve));
    return ok(tableFrom(sheets, location)!);
  };
  let answer: (value: Result<Proposal>) => void = () => {};
  app.store.services.ai.layout = () => new Promise((resolve) => { answer = resolve; });
  const first = await readImportBytes(app.store, NAME, new Uint8Array(4), { sheet: 'Initial review' });
  if (!first.ok) throw new Error(first.error.message);
  const layout = new QaImportLayout(app.store, first.value, first.value.mapping, () => {});
  return {
    layout, table: first.value as ImportTable,
    answer: (value: Result<Proposal>) => answer(value),
    holdReads: () => { holdReads = true; },
    releaseRead: () => reads.shift()?.(),
  };
}

const updated = ok({ sheet: 'Updated review', headerRow: 0, fields: { text: 'Question', response: 'Response' } });

describe('a layout proposal', () => {
  it('lands and clears the error while nothing overtook it', async () => {
    const held = await heldLayout();
    const asked = held.layout.ask(held.table);
    expect(held.layout.view.asking).toBe(true);
    held.answer(updated);
    expect(await asked).toBe('');
    expect(held.layout.view).toMatchObject({ asking: false, mapping: { text: 2, response: 3 } });
    expect(held.layout.view.table?.sheet).toBe('Updated review');
  });

  it.each(['reread', 'replace', 'cancel', 'cancelAsk'] as const)('changes nothing once overtaken by %s', async (by) => {
    const held = await heldLayout();
    const asked = held.layout.ask(held.table);
    if (by === 'reread') await held.layout.reread({ sheet: 'Initial review', headerRow: 0 });
    if (by === 'replace') held.layout.replace(held.table);
    if (by === 'cancel') held.layout.cancel();
    if (by === 'cancelAsk') held.layout.cancelAsk();
    expect(held.layout.view.asking).toBe(false);
    held.answer(updated);
    expect(await asked).toBeUndefined();
    expect(held.layout.view.table?.sheet).toBe('Initial review');
    expect(held.layout.view.mapping).toMatchObject({ text: 1 });
  });

  it('keeps a column picked while it is awaited, and keeps asking until it lands (#741)', async () => {
    const held = await heldLayout();
    const sameSheet = ok({ sheet: 'Initial review', headerRow: 0, fields: { text: 'Question' } });
    const asked = held.layout.ask(held.table);
    held.layout.pick('response', 0);
    expect(held.layout.view).toMatchObject({ asking: true, mapping: { response: 0 } });
    held.answer(sameSheet);
    expect(await asked).toBe('');
    expect(held.layout.view).toMatchObject({ asking: false, mapping: { text: 1, response: 0 } });
  });

  it('says there was no better proposal only when the file had a question column', async () => {
    const held = await heldLayout();
    const refused = fail({ kind: 'invalid' as const, message: 'No proposal' });
    const asked = held.layout.ask(held.table);
    held.answer(refused);
    expect(await asked).toBe(`${SERVICE} had no better proposal`);
    expect(held.layout.view.asking).toBe(false);
    const noQuestion = { ...held.table, mapping: { ...held.table.mapping, text: null } };
    const again = held.layout.ask(noQuestion);
    held.answer(refused);
    expect(await again).toBeUndefined();
  });
});

describe('cancelling an ask', () => {
  it('leaves a sheet read in flight to land when no ask is pending', async () => {
    const held = await heldLayout();
    held.holdReads();
    const switching = held.layout.reread({ sheet: 'Updated review' });
    held.layout.cancelAsk();
    held.releaseRead();
    await switching;
    expect(held.layout.view).toMatchObject({ reading: false, mapping: { text: 2 } });
    expect(held.layout.view.table?.sheet).toBe('Updated review');
  });
});
