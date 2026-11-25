// Import matching works like an XLOOKUP on the question as written: a row is the question with the same number and exact
// text, failing that the one with the exact text alone; a row that matches neither is a new question. A deleted question
// a row matches is brought back, not copied. Nothing is matched by similar words.
import { describe, it, expect } from 'vitest';
import type { Store } from '../../src/app/store';
import { CreateQuestion, DeleteQuestion, EditQuestionField, RestoreQuestion } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { dealQuestions } from '../../src/app/state';
import { previewImport } from '../../src/app/transfer';
import { make, deal, rowsFrom, sheet, mapping } from './importKit';

const lines = (store: Store, dealId: string) => dealQuestions(store.get(), dealId).map((q) => `${q.n}: ${q.text} | ${q.response}`);

describe('a merge matches each row to its question exactly', () => {
  it('by number and exact text first, so a list numbered its own way still finds each question by its text', async () => {
    const { store } = make(); const dealId = await deal(store);
    for (const text of ['What is the DSCR?', 'Who is the EPC contractor?', 'Is the O&M contract signed?']) await store.dispatch(CreateQuestion, { dealId, text });
    const ids = dealQuestions(store.get(), dealId).map((q) => q.id);
    const csv = 'No.,Question,Response\n7,Who is the EPC contractor?,Fabrikam\n8,What is the DSCR?,1.20x\n9,Is the O&M contract signed?,Yes\n';
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom(csv) })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: What is the DSCR? | 1.20x', '2: Who is the EPC contractor? | Fabrikam', '3: Is the O&M contract signed? | Yes']);
    expect(dealQuestions(store.get(), dealId).map((q) => q.id)).toEqual(ids);
  });
  it('of two questions with the same text, the one with the row\'s number', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Same words' }); await store.dispatch(CreateQuestion, { dealId, text: 'Same words' });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('No.,Question,Response\n2,Same words,To two\n') })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Same words | ', '2: Same words | To two']);
  });
  it('never by the number alone: the same number with other words is a question of its own', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'What is the DSCR for the base case?' });
    const csv = 'No.,Question,Response\n1,What is the DSCR in the base case?,1.20x\n';
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom(csv) })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: What is the DSCR for the base case? | ', '2: What is the DSCR in the base case? | 1.20x']);
  });
  it('never by similar words: a changed letter, space or case is another question', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Is the O&M contract signed?' });
    const csv = 'No.,Question,Response\n1,ls the O&M contract signed?,a\n2,Is the O&M  contract signed?,b\n3,is the O&M contract signed?,c\n';
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom(csv) })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Is the O&M contract signed? | ', '2: Is the O&M  contract signed? | b', '3: is the O&M contract signed? | c', '4: ls the O&M contract signed? | a']);
  });
  it('by exact text when the number differs, whichever party submitted it', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Who is the EPC contractor?' });
    const csv = 'No.,Question,Response\n40,Who is the EPC contractor?,Fabrikam\n';
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom(csv) })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Who is the EPC contractor? | Fabrikam']);
  });
  it('takes each question once: a second row of the same text is a new question', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Same words' });
    const csv = 'No.,Question,Response\n5,Same words,first\n6,Same words,second\n';
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom(csv) })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Same words | first', '6: Same words | second']);
  });
});

describe('a row that matches a deleted question', () => {
  it('brings it back with the file\'s values, says so in the preview, and Undo deletes it again', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'What is the DSCR?' }); await store.dispatch(CreateQuestion, { dealId, text: 'Who is the EPC contractor?' });
    const gone = dealQuestions(store.get(), dealId)[1];
    await store.dispatch(EditQuestionField, { dealId, questionId: gone.id, field: 'workstream', value: 'Technical' });
    await store.dispatch(DeleteQuestion, { dealId, questionId: gone.id });
    const rows = rowsFrom('No.,Question,Response\n7,Who is the EPC contractor?,Fabrikam\n');
    expect(previewImport(store, dealId, 'merge', rows)).toEqual({ ok: true, value: { created: 0, updated: 0, restored: 1, changes: [] } });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows }); if (!r.ok) throw new Error(r.error.message);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Imported · 0 new · 0 updated · 1 restored');
    expect(store.get().questions[gone.id]).toMatchObject({
      n: 2,
      text: 'Who is the EPC contractor?',
      response: 'Fabrikam',
      workstream: 'Technical',
    });
    expect(store.get().tombstones[gone.id]).toBeUndefined(); expect(dealQuestions(store.get(), dealId).length).toBe(2);
    await store.undo(r.value.opId);
    expect(store.get().questions[gone.id]).toBeUndefined(); expect(store.get().tombstones[gone.id]).toMatchObject({ kind: 'question' });
    expect((await store.dispatch(RestoreQuestion, { dealId, questionId: gone.id })).ok).toBe(true);   // and can still be restored from Deleted
    expect(store.get().questions[gone.id]).toMatchObject({ response: '', workstream: 'Technical' });
  });
  it('keeps its own number: an import before it gave that number to no other question', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Old question one' }); const gone = dealQuestions(store.get(), dealId)[0];
    await store.dispatch(DeleteQuestion, { dealId, questionId: gone.id });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('No.,Question\n1,A different question\n') });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('No.,Question\n1,Old question one\n') })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Old question one | ', '2: A different question | ']); expect(store.get().questions[gone.id]?.n).toBe(1);
  });
  it('is not brought back by Append, which always adds', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Kept deleted' }); const gone = dealQuestions(store.get(), dealId)[0];
    await store.dispatch(DeleteQuestion, { dealId, questionId: gone.id });
    await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('No.,Question\n1,Kept deleted\n') });
    expect(store.get().tombstones[gone.id]).toBeTruthy(); expect(lines(store, dealId)).toEqual(['2: Kept deleted | ']);
  });
});

// Deals run to 2,000 questions. Importing the log of a deal that size, half of it changed, is quick.
