// The import's preview finds each row's question exactly as the import does (#1080), so what it says the import will
// do is what the import does, at deal scale.
import { describe, it, expect } from 'vitest';
import { CreateQuestion, DeleteQuestion } from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { dealQuestions } from '../../src/app/state';
import { previewImport } from '../../src/app/transfer';
import { make, deal, rowsFrom } from './importKit';

const csvOf = (lines: string[]) => `No.,Question,Response\n${lines.join('\n')}\n`;
const quoted = (text: string) => `"${text.replace(/"/g, '""')}"`;

describe('the preview of a merge', () => {
  it('counts what a 2,000-row merge adds, changes and brings back, as the import then does', async () => {
    const { store } = make(); const dealId = await deal(store);
    // questions whose text holds a CR LF line break
    const first = rowsFrom(csvOf(Array.from({ length: 2000 }, (_, k) => `${k + 1},Question ${k}|Part two,`)))
      .map((row) => ({ ...row, text: row.text.replace('|', '\r\n') }));
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: first })).ok).toBe(true);
    const made = dealQuestions(store.get(), dealId);
    expect(made[0].text).toBe('Question 0\r\nPart two');
    for (const q of made.slice(1900)) await store.dispatch(DeleteQuestion, { dealId, questionId: q.id });
    // the file keeps each line break as one "\n"; 1,500 rows answered, 100 bring back a deleted question, 400 new
    const second = [
      ...made.slice(0, 1500).map((q) => `${q.n},${quoted(q.text.replace(/\r\n/g, '\n'))},Answer ${q.n}`),
      ...made.slice(1900).map((q) => `${q.n},${quoted(q.text.replace(/\r\n/g, '\n'))},Back ${q.n}`),
      ...Array.from({ length: 400 }, (_, k) => `${5000 + k},New question ${k},`),
    ];
    const rows = rowsFrom(csvOf(second));
    const preview = previewImport(store, dealId, 'merge', rows);
    const counts = preview.ok && [preview.value.created, preview.value.updated, preview.value.restored];
    expect(counts).toEqual([400, 1500, 100]);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
    const after = dealQuestions(store.get(), dealId);
    expect(after).toHaveLength(1900 + 100 + 400);
    expect(after.filter((q) => q.response.startsWith('Answer '))).toHaveLength(1500);
    expect(after.filter((q) => q.response.startsWith('Back '))).toHaveLength(100);
  });
  it('suggests nothing for a row that brings back a deleted question', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Provide the model.' });
    await store.dispatch(CreateQuestion, { dealId, text: 'provide the model' });
    const gone = dealQuestions(store.get(), dealId)[0];
    await store.dispatch(DeleteQuestion, { dealId, questionId: gone.id });
    const preview = previewImport(store, dealId, 'merge', rowsFrom(csvOf(['7,Provide the model.,Yes'])));
    expect(preview.ok && [preview.value.restored, preview.value.suggestions]).toEqual([1, []]);
  });
});
