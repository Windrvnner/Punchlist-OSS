// Import matching works like an XLOOKUP on the question as written: a row is the question with the same number and
// exact text, failing that the one with the exact text alone; a row that matches neither is a new question. A deleted
// question a row matches is brought back, not copied. Nothing is matched by similar words.
import { describe, it, expect } from 'vitest';
import type { Store } from '../../src/app/store';
import { CreateQuestion, DeleteQuestion, EditQuestionField, RestoreQuestion } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { dealQuestions } from '../../src/app/state';
import { previewImport } from '../../src/app/transfer';
import { make, deal, rowsFrom, sheet, mapping } from './importKit';

const lines = (store: Store, dealId: string) =>
  dealQuestions(store.get(), dealId).map((q) => `${q.n}: ${q.text} | ${q.response}`);
const importCsv = (store: Store, dealId: string, csv: string, mode: 'merge' | 'append' = 'merge') =>
  store.dispatch(ImportQuestions, { dealId, mode, rows: rowsFrom(csv) });

describe('a merge matches each row to its question exactly', () => {
  it('by number and exact text first, so a list numbered its own way still finds each question', async () => {
    const { store } = make(); const dealId = await deal(store);
    const texts = ['What is the DSCR?', 'Who is the EPC contractor?', 'Is the O&M contract signed?'];
    for (const text of texts) await store.dispatch(CreateQuestion, { dealId, text });
    const ids = dealQuestions(store.get(), dealId).map((q) => q.id);
    const csv = 'No.,Question,Response\n7,Who is the EPC contractor?,Fabrikam\n8,What is the DSCR?,1.20x\n'
      + '9,Is the O&M contract signed?,Yes\n';
    expect((await importCsv(store, dealId, csv)).ok).toBe(true);
    expect(lines(store, dealId)).toEqual([
      '1: What is the DSCR? | 1.20x', '2: Who is the EPC contractor? | Fabrikam',
      '3: Is the O&M contract signed? | Yes',
    ]);
    expect(dealQuestions(store.get(), dealId).map((q) => q.id)).toEqual(ids);
  });
  it('of two questions with the same text, the one with the row\'s number', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Same words' });
    await store.dispatch(CreateQuestion, { dealId, text: 'Same words' });
    expect((await importCsv(store, dealId, 'No.,Question,Response\n2,Same words,To two\n')).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Same words | ', '2: Same words | To two']);
  });
  it('never by the number alone: the same number with other words is a question of its own', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'What is the DSCR for the base case?' });
    const csv = 'No.,Question,Response\n1,What is the DSCR in the base case?,1.20x\n';
    expect((await importCsv(store, dealId, csv)).ok).toBe(true);
    expect(lines(store, dealId)).toEqual([
      '1: What is the DSCR for the base case? | ', '2: What is the DSCR in the base case? | 1.20x',
    ]);
  });
  it('never by similar words: a changed letter, space or case is another question', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Is the O&M contract signed?' });
    const csv = 'No.,Question,Response\n1,ls the O&M contract signed?,a\n2,Is the O&M  contract signed?,b\n'
      + '3,is the O&M contract signed?,c\n';
    expect((await importCsv(store, dealId, csv)).ok).toBe(true);
    expect(lines(store, dealId)).toEqual([
      '1: Is the O&M contract signed? | ', '2: Is the O&M  contract signed? | b', '3: is the O&M contract signed? | c',
      '4: ls the O&M contract signed? | a',
    ]);
  });
  it('by exact text when the number differs, whichever party submitted it', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Who is the EPC contractor?' });
    const csv = 'No.,Question,Response\n40,Who is the EPC contractor?,Fabrikam\n';
    expect((await importCsv(store, dealId, csv)).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Who is the EPC contractor? | Fabrikam']);
  });
  it('takes each question once: a second row of the same text is a new question', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Same words' });
    const csv = 'No.,Question,Response\n5,Same words,first\n6,Same words,second\n';
    expect((await importCsv(store, dealId, csv)).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Same words | first', '6: Same words | second']);
  });
});

describe('a merge matches the sender too', () => {
  const csv = (who: string) => `No.,Question,Submitted by,Response\n1,Same words,${who},Reply\n`;
  it('the same question from another sender is a question of its own', async () => {
    const { store } = make(); const dealId = await deal(store);
    await importCsv(store, dealId, csv('Lender A'), 'append');
    expect((await importCsv(store, dealId, csv('Lender B'))).ok).toBe(true);
    const bySender = dealQuestions(store.get(), dealId).map((q) => `${q.askedBy}|${q.response}`);
    expect(bySender).toEqual(['Lender A|Reply', 'Lender B|Reply']);
  });
  it('the same sender, exactly as written, is the same question; a different capital is not', async () => {
    const { store } = make(); const dealId = await deal(store);
    await importCsv(store, dealId, 'No.,Question,Submitted by\n1,Same words,Lender A\n', 'append');
    await importCsv(store, dealId, csv('Lender A'));
    expect(dealQuestions(store.get(), dealId)).toHaveLength(1);
    await importCsv(store, dealId, csv('lender a'));
    expect(dealQuestions(store.get(), dealId)).toHaveLength(2);
  });
  it('a row naming no sender matches any sender; the same sender is taken first', async () => {
    const { store } = make(); const dealId = await deal(store);
    await importCsv(store, dealId, 'No.,Question,Submitted by\n1,Same words,Lender A\n', 'append');
    await importCsv(store, dealId, 'No.,Question,Response\n1,Same words,Reply\n');
    expect(dealQuestions(store.get(), dealId).map((q) => q.response)).toEqual(['Reply']);
  });
});

describe('a row that matches a deleted question', () => {
  it('brings it back with the file\'s values, says so in the preview, and Undo deletes it again', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'What is the DSCR?' });
    await store.dispatch(CreateQuestion, { dealId, text: 'Who is the EPC contractor?' });
    const gone = dealQuestions(store.get(), dealId)[1];
    await store.dispatch(EditQuestionField, { dealId, questionId: gone.id, field: 'workstream', value: 'Technical' });
    await store.dispatch(DeleteQuestion, { dealId, questionId: gone.id });
    const rows = rowsFrom('No.,Question,Response\n7,Who is the EPC contractor?,Fabrikam\n');
    expect(previewImport(store, dealId, 'merge', rows)).toEqual({
      ok: true, value: { created: 0, updated: 0, restored: 1, changes: [], suggestions: [] },
    });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows });
    if (!r.ok) throw new Error(r.error.message);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Imported · 0 new · 0 updated · 1 restored');
    expect(store.get().questions[gone.id]).toMatchObject({
      n: 2,
      text: 'Who is the EPC contractor?',
      response: 'Fabrikam',
      workstream: 'Technical',
    });
    expect(store.get().tombstones[gone.id]).toBeUndefined(); expect(dealQuestions(store.get(), dealId).length).toBe(2);
    await store.undo(r.value.opId);
    expect(store.get().questions[gone.id]).toBeUndefined();
    expect(store.get().tombstones[gone.id]).toMatchObject({ kind: 'question' });
    // and can still be restored from Deleted
    expect((await store.dispatch(RestoreQuestion, { dealId, questionId: gone.id })).ok).toBe(true);
    expect(store.get().questions[gone.id]).toMatchObject({ response: '', workstream: 'Technical' });
  });
  it('keeps its own number: an import before it gave that number to no other question', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Old question one' });
    const gone = dealQuestions(store.get(), dealId)[0];
    await store.dispatch(DeleteQuestion, { dealId, questionId: gone.id });
    await importCsv(store, dealId, 'No.,Question\n1,A different question\n');
    expect((await importCsv(store, dealId, 'No.,Question\n1,Old question one\n')).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Old question one | ', '2: A different question | ']);
    expect(store.get().questions[gone.id]?.n).toBe(1);
  });
  it('is not brought back by Append, which always adds', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Kept deleted' });
    const gone = dealQuestions(store.get(), dealId)[0];
    await store.dispatch(DeleteQuestion, { dealId, questionId: gone.id });
    await importCsv(store, dealId, 'No.,Question\n1,Kept deleted\n', 'append');
    expect(store.get().tombstones[gone.id]).toBeTruthy(); expect(lines(store, dealId)).toEqual(['2: Kept deleted | ']);
  });
});

// Deals run to 2,000 questions. Importing the log of a deal that size, half of it changed, is quick.

describe('a row that matches nothing exactly', () => {
  const setup = async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Who is the EPC contractor?' });
    const rows = rowsFrom('No.,Question,Response\n9,who is the EPC  Contractor,Fabrikam\n');
    return { store, dealId, rows, id: dealQuestions(store.get(), dealId)[0].id };
  };
  it('is suggested the question it could be, and is added as a new question unless the person accepts', async () => {
    const { store, dealId, rows, id } = await setup();
    const preview = previewImport(store, dealId, 'merge', rows);
    expect(preview.ok && preview.value.suggestions).toEqual([{
      line: 2, text: 'who is the EPC  Contractor', questionId: id, n: 1, questionText: 'Who is the EPC contractor?',
    }]);
    expect(preview.ok && preview.value.created).toBe(1);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
    expect(dealQuestions(store.get(), dealId)).toHaveLength(2);
  });
  it('slots in as the suggested question once accepted, and the suggestion is gone', async () => {
    const { store, dealId, rows, id } = await setup();
    const accepted = [{ line: 2, text: 'who is the EPC  Contractor', questionId: id }];
    const preview = previewImport(store, dealId, 'merge', rows, false, accepted);
    expect(preview.ok && [preview.value.suggestions, preview.value.created, preview.value.updated]).toEqual([[], 0, 1]);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows, accepted })).ok).toBe(true);
    const texts = dealQuestions(store.get(), dealId).map((q) => `${q.text}|${q.response}`);
    expect(texts).toEqual(['who is the EPC  Contractor|Fabrikam']);
  });
  it('ignores an accepted choice made for other wording', async () => {
    const { store, dealId, rows, id } = await setup();
    const stale = [{ line: 2, text: 'some earlier wording', questionId: id }];
    const preview = previewImport(store, dealId, 'merge', rows, false, stale);
    expect(preview.ok && [preview.value.created, preview.value.updated]).toEqual([1, 0]);
  });
  it('is not suggested another sender\'s question, nor anything by number or other words', async () => {
    const { store, dealId } = await setup();
    const questionId = dealQuestions(store.get(), dealId)[0].id;
    await store.dispatch(EditQuestionField, { dealId, questionId, field: 'askedBy', value: 'Lender A' });
    const other = rowsFrom(
      'No.,Question,Submitted by\n1,who is the epc contractor,Lender B\n'
        + '1,Who is the contractor for the EPC?,Lender A\n',
    );
    const preview = previewImport(store, dealId, 'merge', other);
    expect(preview.ok && preview.value.suggestions).toEqual([]);
  });
});

describe('a merge keeps the sender, responder and workstream cells as the file gives them', () => {
  const csv = 'No.,Question,Response,Submitted by,Responded by,Workstream\n'
    + '1,Who is the lender?, Yes ," Legal Counsel ","  Seller ", Tax diligence \n';
  it('stores each name and the workstream with its spaces, and a second import matches the question', async () => {
    const { store } = make(); const dealId = await deal(store);
    expect((await importCsv(store, dealId, csv)).ok).toBe(true);
    const [first] = dealQuestions(store.get(), dealId);
    expect(first).toMatchObject({
      askedBy: ' Legal Counsel ', respondedBy: '  Seller ', workstream: ' Tax diligence ',
    });
    expect((await importCsv(store, dealId, csv)).ok).toBe(true);
    const after = dealQuestions(store.get(), dealId);
    expect(after.map((q) => q.id)).toEqual([first!.id]);
  });
});
