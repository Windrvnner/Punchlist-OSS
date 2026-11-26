// Content from a file or the model passes through the commands as given, edge spaces and tabs included.
import { describe, it, expect } from 'vitest';
import { make, deal, rowsFrom } from './importKit';
import { CreateQuestion, SetResponse, UseAsResponse } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding, typedParagraphs } from '../../src/app/commands/findings';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { previewImport } from '../../src/app/transfer';
import { answerWasUsed } from '../../src/app/conversations';
import type { Message } from '../../src/app/state';
import type { Question } from '../../src/domain/model';

describe('commands keep content as given', () => {
  it('a finding edited by its title keeps the edge spaces of a paragraph the model wrote', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const body = [' a paragraph with edges\t'];
    const made = await store.dispatch(CreateFinding, { dealId, title: 'Curtailment', workstream: 'Technical', body });
    if (!made.ok) throw new Error('not created');
    const findingId = Object.keys(store.get().findings)[0];
    await store.dispatch(EditFinding, { dealId, findingId, title: 'Curtailment risk', workstream: 'Technical', body });
    expect(store.get().findings[findingId].body).toEqual(body);
  });

  it('a paragraph a person types is trimmed, and the model\'s paragraphs beside it stay as written', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const body = [' model paragraph\t', ' second model paragraph '];
    await store.dispatch(CreateFinding, { dealId, title: 'Curtailment', workstream: 'Technical', body });
    const findingId = Object.keys(store.get().findings)[0];
    const typed = [' model paragraph\t', '  my own words\t  '];
    const base = { title: 'Curtailment', workstream: 'Technical', body };
    await store.dispatch(EditFinding, { dealId, findingId, title: 'Curtailment', workstream: 'Technical', body: typed, base });
    expect(store.get().findings[findingId].body).toEqual([' model paragraph\t', 'my own words']);
  });

  it('a paragraph typed into a finding with no model text before it is trimmed, and a blank one is dropped', () => {
    expect(typedParagraphs([' typed\t', '   ', 'more '], [])).toEqual(['typed', 'more']);
    expect(typedParagraphs(['same', 'same'], [' same ', 'other'])).toEqual([' same ', 'same']);
  });

  it('a model answer used as a response is stored as the answer has it', async () => {
    const { store } = make();
    const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm.' });
    const questionId = Object.keys(store.get().questions)[0];
    await store.dispatch(UseAsResponse, { dealId, questionId, text: ' Confirmed.\t', sources: [] });
    expect(store.get().questions[questionId].response).toBe(' Confirmed.\t');
  });

  it('an answer is the question\'s response only when they match character for character', () => {
    const answer = { text: 'Confirmed.', sources: [] } as unknown as Message;
    const question = (response: string) => ({ response }) as Question;
    expect(answerWasUsed(question('Confirmed.'), answer)).toBe(true);
    expect(answerWasUsed(question('Confirmed. '), answer)).toBe(false);
  });

  it('re-importing a cell with a trailing space shows the change it then makes, and the counts agree', async () => {
    const { store } = make();
    const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'One' });
    const questionId = Object.keys(store.get().questions)[0];
    await store.dispatch(SetResponse, { dealId, questionId, response: 'Yes.' });
    const rows = rowsFrom('Number,Question,Response\n1,One,"Yes. "\n');
    const preview = previewImport(store, dealId, 'merge', rows);
    const change = { field: 'Response', from: 'Yes.', to: 'Yes. ' };
    expect(preview).toMatchObject({ ok: true, value: { updated: 1, changes: [change] } });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows });
    expect(store.get().questions[questionId].response).toBe('Yes. ');
    expect(previewImport(store, dealId, 'merge', rows)).toMatchObject({ ok: true, value: { updated: 0, changes: [] } });
  });
});
