// Import matching: a file row is the question with its wording first, then its number; a deleted
// question a row matches is brought back, not copied.
import { describe, it, expect } from 'vitest';
import type { Store } from '../../src/app/store';
import { CreateQuestion, SetResponse, DeleteQuestion, RestoreQuestion, EditQuestionField }
  from '../../src/app/commands/questions';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { dealQuestions } from '../../src/app/state';
import { previewImport } from '../../src/app/transfer';
import { identifierSig, matchRows, misreadKey } from '../../src/domain/logWrite';
import { PORTFOLIO_ASSETS, portfolioQuestions } from '../fixtures/portfolioQuestions';
import { make, deal, rowsFrom, sheet, mapping, fileRow } from './importKit';

const byN = (store: Store, dealId: string) => Object.fromEntries(dealQuestions(store.get(), dealId).map((q) => [q.n, q]));

const lines = (store: Store, dealId: string) => dealQuestions(store.get(), dealId).map((q) => `${q.n}: ${q.text} | ${q.response}`);

describe('a merge matches each row to its question', () => {
  it('by wording first: a list numbered its own way lines up with the log, and a misread letter is still the same question (its wording shows under Will overwrite)', async () => {
    const { store } = make(); const dealId = await deal(store);
    for (const text of ['What is the DSCR?', 'Who is the EPC contractor?', 'Is the O&M contract signed?']) await store.dispatch(CreateQuestion, { dealId, text });
    const ids = dealQuestions(store.get(), dealId).map((q) => q.id);
    const r = await store.dispatch(ImportQuestions, {
      dealId,
      mode: 'merge',
      rows: rowsFrom(
        'No.,Question,Response\n1,"Who is the EPC  contractor ' +
          '?",Fabrikam\n2,What is the DSCR?,1.20x\n3,"ls the O&M contract signed ?",Yes\n',
      ),
    });
    expect(r.ok).toBe(true);
    expect(lines(store, dealId)).toEqual([
      '1: What is the DSCR? | 1.20x',
      '2: Who is the EPC  contractor ? | Fabrikam',
      '3: ls the O&M contract signed ? | Yes',
    ]);
    expect(dealQuestions(store.get(), dealId).map((q) => q.id)).toEqual(ids);       // the same three questions, none added
  });
  it('then by number, but only when the row reads mostly as that question: another party\'s own question 1 is a question of its own', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'What is the DSCR for the base case?' }); await store.dispatch(CreateQuestion, { dealId, text: 'Who is the EPC contractor?' });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('No.,Question,Response\n1,What is the DSCR in the base case?,1.20x\n2,Is there a tax equity investor?,\n') });
    expect(r.ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: What is the DSCR in the base case? | 1.20x', '2: Who is the EPC contractor? | ', '3: Is there a tax equity investor? | ']);
  });
  it('of two questions that read the same, the one with the row\'s number', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Same words' }); await store.dispatch(CreateQuestion, { dealId, text: 'Same words' });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('No.,Question,Response\n2,Same words,To two\n') })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Same words | ', '2: Same words | To two']);
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
describe('a merge at the size of a real deal', () => {
  it('matches 2,000 rows to 2,000 questions, renumbered and reworded a little, in a few seconds', async () => {
    const { store } = make(); const dealId = await deal(store);
    const text = (i: number) => `Question ${i}: what is the position on item ${i * 7919 % 10007} of the ${['tax', 'legal', 'technical', 'commercial'][i % 4]} review?`;
    const csv = (rows: string[][]) => rowsFrom(['No.,Question,Response', ...rows.map((r) => r.map((v) => `"${v}"`).join(','))].join('\n'));
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: csv(Array.from({ length: 2000 }, (_, k) => [String(k + 1), text(k + 1), ''])) })).ok).toBe(true);
    const at = Date.now();   // the counterparty's copy: numbered from 5001, spaced differently, half answered
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: csv(Array.from({ length: 2000 }, (_, k) => [String(k + 5001), text(k + 1).replace(' ', '  '), k % 2 ? `Answer ${k + 1}` : ''])) });
    const ms = Date.now() - at; console.log('2,000-row merge, ms:', ms);
    expect(r.ok).toBe(true); expect(dealQuestions(store.get(), dealId)).toHaveLength(2000); expect(ms).toBeLessThan(10_000);
    expect(byN(store, dealId)[2].response).toBe('Answer 2');
  }, 60_000);
});


const parties = (store: Store, dealId: string) => dealQuestions(store.get(), dealId).map((q) => `${q.n} ${q.askedBy}: ${q.text} | ${q.response}`);

describe('a row from another party', () => {
  it('with the same words is a question of its own: the other party\'s question and its response stay theirs', async () => {
    const { store } = make(); const dealId = await deal(store);
    const ask = 'Provide the audited financial statements for FY2023 to FY2025.';
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', [['1', ask, 'Lender A', 'Uploaded to 3.1.2']]) });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', [['1', ask, 'Lender B', '']]) });
    expect(r.ok).toBe(true);
    expect(parties(store, dealId)).toEqual([`1 Lender A: ${ask} | Uploaded to 3.1.2`, `2 Lender B: ${ask} | `]);
  });
  it('under the same number and much the same words is a question of its own too', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by', [['4', 'What is the DSCR for the base case?', 'Lender A']]) });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by', [['4', 'What is the DSCR in the base case?', 'Lender B']]) });
    expect(parties(store, dealId)).toEqual(['4 Lender A: What is the DSCR for the base case? | ', '5 Lender B: What is the DSCR in the base case? | ']);
  });
  it('is the same question when the party differs only in capitals, spaces or a final period, or when either names no one', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by', [['1', 'Who is the EPC contractor?', 'Lender A'], ['2', 'Is the O&M contract signed?', '']]) });
    const r = await store.dispatch(ImportQuestions, {
      dealId,
      mode: 'merge',
      rows: sheet('No.,Question,Submitted by,Response', [
        ['1', 'Who is the EPC contractor?', ' lender a.', 'Fabrikam'],
        ['2', 'Is the O&M contract signed?', 'Lender B', 'Yes'],
      ]),
    });
    expect(r.ok).toBe(true);
    expect(dealQuestions(store.get(), dealId).map((q) => `${q.n} ${q.response}`)).toEqual(['1 Fabrikam', '2 Yes']);
  });
});

describe('of two questions that read the same', () => {
  it('a row with one\'s number gets that one, even after a row of the same words with no number', async () => {
    const { store } = make(); const dealId = await deal(store);
    for (const text of ['Same words', 'Other', 'Same words']) await store.dispatch(CreateQuestion, { dealId, text });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Response', [['', 'Same words', 'unnumbered'], ['1', 'Same words', 'to one']]) })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Same words | to one', '2: Other | ', '3: Same words | unnumbered']);
  });
  it('and of two deleted ones, the same', async () => {
    const { store } = make(); const dealId = await deal(store);
    for (const text of ['Same words', 'Same words']) await store.dispatch(CreateQuestion, { dealId, text });
    for (const q of dealQuestions(store.get(), dealId)) await store.dispatch(DeleteQuestion, { dealId, questionId: q.id });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Response', [['', 'Same words', 'unnumbered'], ['2', 'Same words', 'to two']]) })).ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Same words | unnumbered', '2: Same words | to two']);
  });
});

describe('a row is matched on everything it gives', () => {
  it('of two questions that read the same, the one of the row\'s party', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by', [['1', 'Provide the cap table.', 'Lender A'], ['2', 'Provide the cap table.', 'Lender B']]) });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('Question,Submitted by,Response', [['Provide the cap table.', 'Lender B', 'Tab 2']]) })).ok).toBe(true);
    expect(parties(store, dealId)).toEqual(['1 Lender A: Provide the cap table. | ', '2 Lender B: Provide the cap table. | Tab 2']);
  });
  it('and of its workstream and received date, even when a vaguer row of the same words comes first', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Workstream,Received', [['1', 'Provide the cap table.', 'Legal', '2026-11-02'], ['2', 'Provide the cap table.', 'Financial', '2026-11-05']]) });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('Question,Workstream,Received,Response', [['Provide the cap table.', '', '', 'vague'], ['Provide the cap table.', 'Legal', '2026-11-02', 'to the legal one']]) });
    expect(r.ok).toBe(true);
    expect(lines(store, dealId)).toEqual(['1: Provide the cap table. | to the legal one', '2: Provide the cap table. | vague']);
  });
});

describe('a row numbered as a deleted question of the same words as a live one', () => {
  it('brings the deleted one back and leaves the live one as it was', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', [['4', 'Provide the model.', 'Lender A', 'A4'], ['7', 'Provide the model.', 'Lender A', 'A7']]) });
    await store.dispatch(DeleteQuestion, { dealId, questionId: byN(store, dealId)[7].id });
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', [['7', 'Provide the model.', 'Lender A', 'new for 7']]) })).ok).toBe(true);
    expect(parties(store, dealId)).toEqual(['4 Lender A: Provide the model. | A4', '7 Lender A: Provide the model. | new for 7']);
  });
});

describe('of two rows that fit equally well', () => {
  it('a row only one question fits chooses first, so a vaguer row never takes it', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Workstream,Received', [['1', 'Provide the model.', 'Lender A', 'Legal', '2026-11-02'], ['2', 'Provide the model.', 'Lender A', 'Legal', '2026-11-05']]) });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('Question,Submitted by,Workstream,Received,Response', [['Provide the model.', 'Lender A', 'Legal', '', 'vague'], ['Provide the model.', 'Lender A', '', '2026-11-02', 'dated']]) });
    expect(r.ok).toBe(true);
    expect(dealQuestions(store.get(), dealId).map((q) => `${q.n} ${q.received} ${q.response}`)).toEqual(['1 2026-11-02 dated', '2 2026-11-05 vague']);
  });
  it('a Submitted by of only a period names no one: it never takes over a party\'s question as a party of its own', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', [['1', 'Provide the model.', 'Lender B', 'B resp']]) });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', [['1', 'Provide the model.', '.', 'dot']]) });
    expect(parties(store, dealId)).toEqual(['1 Lender B: Provide the model. | dot']);
  });
});

describe('4,000 rows into 4,000 questions all in the same words', () => {
  it('matches each, quickly, and Undo puts every one back', async () => {
    const { store } = make(); const dealId = await deal(store);
    const W = ['Legal', 'Financial', 'Technical', ''];
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Workstream', Array.from({ length: 4000 }, (_, k) => [String(k + 1), 'Provide the model.', W[k % 4]])) });
    const before = dealQuestions(store.get(), dealId).map((q) => ({ ...q }));
    const at = Date.now();
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('Question,Workstream,Response', Array.from({ length: 4000 }, (_, k) => ['Provide the model.', W[(k + 1) % 4], `r${k}`])) });
    const ms = Date.now() - at; console.log('4,000 rows all one wording, ms:', ms);
    if (!r.ok) throw new Error(r.error.message); expect(ms).toBeLessThan(5_000);
    const now = dealQuestions(store.get(), dealId); expect(now).toHaveLength(4000);
    // a row with a workstream lands on a question of that workstream
    expect(now.filter((q) => q.response).length).toBe(4000);
    await store.undo(r.value.opId);
    expect(dealQuestions(store.get(), dealId).map((q) => [q.id, q.n, q.response, q.workstream])).toEqual(before.map((q) => [q.id, q.n, q.response, q.workstream]));
  }, 120_000);
});

// A consolidated log at the size of a real deal (2,000+ questions), in the words such logs use, then one
// lender's own list merged into it: numbered its own way, much of it asked by the others too, some of it its own questions
// reworded or answered since, and a few the team had deleted.
describe('a lender\'s list merged into a full log', () => {
  const all = portfolioQuestions();
  const PARTIES = ['Lender A', 'Lender B', 'Bidder C'];

  it('adds the lender\'s new questions, updates only its own, brings back its deleted ones, and leaves every other party\'s question as it was', async () => {
    const { store } = make(); const dealId = await deal(store);
    const log = all.map((text, k) => [String(k + 1), text, PARTIES[k % 3], k % 5 === 0 ? `See data room 4.${k}` : '']);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', log) })).ok).toBe(true);
    expect(dealQuestions(store.get(), dealId)).toHaveLength(all.length);
    const before = new Map(dealQuestions(store.get(), dealId).map((q) => [q.id, { ...q }]));
    // the team deleted 30 of Lender B's questions
    const binned = dealQuestions(store.get(), dealId).filter((q) => q.askedBy === 'Lender B').slice(0, 30);
    for (const q of binned) await store.dispatch(DeleteQuestion, { dealId, questionId: q.id });

    // Lender B's list: its share of the log as exported to it (the log's numbers), sent back with 600 of its questions, one in
    // four reworded a little and half answered; 500 the other parties asked in the same words, under those questions' numbers;
    // the 30 deleted; and 300 new ones under the lender's own numbers, which other questions of the log hold (a number the file
    // gives twice is two questions under one number, marked)
    const ownB = dealQuestions(store.get(), dealId).filter((q) => q.askedBy === 'Lender B').slice(0, 600);
    const others = [...before.values()].filter((q) => q.askedBy !== 'Lender B').slice(0, 500);
    const fresh = Array.from({ length: 300 }, (_, index) => {
      const workstream = ['tax', 'legal', 'technical'][index % 3];
      const asset = PORTFOLIO_ASSETS[index % PORTFOLIO_ASSETS.length];
      return `Provide the ${workstream} memo on item ${index + 1} of the Lender B request list for ${asset}.`;
    });
    const inFile = new Set([...ownB, ...others, ...binned].map((q) => q.n));
    const taken = [...before.values()].map((q) => q.n).filter((n) => !inFile.has(n)).slice(0, 300);
    const reword = (t: string) => t.replace('Provide the', 'Please provide the').replace('Confirm whether', 'Please confirm whether').replace(/\?$/, ', please?');
    const rows = [
      ...ownB.map((q, k) => [String(q.n), k % 4 === 0 ? reword(q.text) : q.text, k % 2 ? `B answer ${k}` : '']),
      ...others.map((q) => [String(q.n), q.text, '']),
      ...binned.map((q) => [String(q.n), q.text, 'Back']),
      ...fresh.map((t, k) => [String(taken[k]), t, '']),
    ].map((r) => [r[0], r[1], 'Lender B', r[2]]);
    const at = Date.now();
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', rows) });
    const ms = Date.now() - at; console.log(`${rows.length}-row lender list into a ${all.length}-question log, ms:`, ms);
    if (!r.ok) throw new Error(r.error.message);
    expect(ms).toBeLessThan(15_000);

    const now = dealQuestions(store.get(), dealId); const byId = new Map(now.map((q) => [q.id, q]));
    // every other party's question is exactly as it was
    for (const q of before.values()) if (q.askedBy !== 'Lender B') expect(byId.get(q.id)).toEqual(q);
    // each of the lender's own questions is updated in place, reworded ones too (by their number), and none is copied
    for (const [k, q] of ownB.entries()) expect(byId.get(q.id)).toMatchObject({ n: q.n, text: rows[k][1], response: k % 2 ? `B answer ${k}` : before.get(q.id)!.response });
    // the 30 deleted are back, under their own numbers, with the file's response
    for (const q of binned) expect(byId.get(q.id)).toMatchObject({ n: q.n, response: 'Back' });
    // the other parties' 500 and the 300 new each became one of Lender B's own questions, under a number of their own
    const added = now.filter((q) => !before.has(q.id));
    expect(added.length).toBe(800); expect(added.every((q) => q.askedBy === 'Lender B' && q.n > all.length)).toBe(true);
    // no number holds two questions
    expect(new Set(now.map((q) => q.n)).size).toBe(now.length);
    // and Undo puts the log back as it was before the import
    await store.undo(r.value.opId);
    expect(dealQuestions(store.get(), dealId).length).toBe(all.length - binned.length);
    for (const q of dealQuestions(store.get(), dealId)) expect(byId.has(q.id) && { ...q, rev: 0, updatedAt: '' }).toEqual({ ...before.get(q.id)!, rev: 0, updatedAt: '' });
  }, 120_000);
});

// One standard ask put by every party, half of a 3,000-question log, matched in a moment and each row to its own party's question.
describe('many questions in the same words', () => {
  it('3,000 rows, half of them one ask from three parties, each matched to its own party\'s question in a few seconds', async () => {
    const { store } = make(); const dealId = await deal(store);
    const P = ['Lender A', 'Lender B', 'Bidder C']; const ask = (k: number) => (k % 2 ? 'Provide the financial model in native format.' : `Provide the board minutes for meeting ${k}.`);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by', Array.from({ length: 3000 }, (_, k) => [String(k + 1), ask(k), P[k % 3]])) });
    const at = Date.now();
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Response', Array.from({ length: 3000 }, (_, k) => [String(k + 9001), ask(k), P[k % 3], `${P[k % 3]} answer`])) });
    const ms = Date.now() - at; console.log('3,000 rows, half one ask, ms:', ms);
    expect(r.ok).toBe(true); expect(ms).toBeLessThan(5_000);
    const qs = dealQuestions(store.get(), dealId); expect(qs).toHaveLength(3000);
    expect(qs.every((q) => q.response === `${q.askedBy} answer`)).toBe(true);
  }, 120_000);
});

// A chain of ties, where each row fits its own question and the one before it, stays quick at deal size.
describe('a chain of tied rows', () => {
  const originalHeader = 'No.,Question,Submitted by,Workstream,Received,Responded by,Response';
  const incomingHeader = 'Question,Submitted by,Workstream,Received,Responded by,Response';
  const priorResponse = 'The previous model used the preliminary assumptions.';
  const responses = [
    'The base case now uses the revised tariff assumptions.',
    'The sensitivity case includes the higher reserve requirement.',
    'The downside case reflects the updated cost estimates.',
  ];

  function originalRows(question: string, start: number) {
    return [
      [String(start), question, 'Lender A', 'Financial', '2026-01-01', 'Credit team', priorResponse],
      [String(start + 1), question, 'Lender A', 'Legal', '2026-02-02', 'Credit team', priorResponse],
      [String(start + 2), question, 'Lender A', 'Technical', '2026-03-03', 'Modeling team', priorResponse],
    ];
  }

  function incomingRows(question: string) {
    return [
      [question, 'Lender A', 'Financial', '2026-02-02', '', responses[0]],
      [question, 'Lender A', 'Legal', '2026-03-03', '', responses[2]],
      [question, 'Lender A', '', '', 'Credit team', responses[1]],
    ];
  }

  it('rechecks a newly unique row before taking the next tied row (#264)', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const question = 'Provide the financial model in native format.';
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: sheet(originalHeader, originalRows(question, 1)),
    })).ok).toBe(true);
    const before = dealQuestions(store.get(), dealId);
    const rows = sheet(incomingHeader, incomingRows(question));
    const preview = previewImport(store, dealId, 'merge', rows);
    const result = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows });
    if (!result.ok) throw new Error(result.error.message);
    const after = dealQuestions(store.get(), dealId);
    expect(after.map((q) => [q.id, q.received, q.workstream, q.respondedBy, q.response])).toEqual([
      [before[0].id, '2026-02-02', 'Financial', 'Credit team', responses[0]],
      [before[1].id, '2026-02-02', 'Legal', 'Credit team', responses[1]],
      [before[2].id, '2026-03-03', 'Legal', 'Modeling team', responses[2]],
    ]);
    expect(preview).toEqual({ ok: true, value: {
      created: 0, restored: 0, updated: 3, changes: [
        { n: 1, field: 'Received', from: '2026-01-01', to: '2026-02-02' },
        { n: 1, field: 'Response', from: priorResponse, to: responses[0] },
        { n: 2, field: 'Response', from: priorResponse, to: responses[1] },
        { n: 3, field: 'Workstream', from: 'Technical', to: 'Legal' },
        { n: 3, field: 'Response', from: priorResponse, to: responses[2] },
      ],
    } });
    expect((await store.undo(result.value.opId)).ok).toBe(true);
    expect(dealQuestions(store.get(), dealId).map(({ rev, updatedAt, ...q }) => q))
      .toEqual(before.map(({ rev, updatedAt, ...q }) => q));
  });

  it('resolves the same chain across 2,100 realistic deal questions', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const wording = [...new Set(portfolioQuestions())].slice(0, 700);
    expect(wording).toHaveLength(700);
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'append',
      rows: sheet(originalHeader, wording.flatMap((text, index) => originalRows(text, index * 3 + 1))),
    })).ok).toBe(true);
    const before = dealQuestions(store.get(), dealId);
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'merge', rows: sheet(incomingHeader, wording.flatMap(incomingRows)),
    })).ok).toBe(true);
    const after = dealQuestions(store.get(), dealId);
    expect(after.map((q) => q.id)).toEqual(before.map((q) => q.id));
    const correctlyPlaced = after.filter((q, index) => q.response === responses[index % 3]);
    expect(correctlyPlaced).toHaveLength(2_100);
  });

  it('keeps row order when the available questions fit equally well', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const question = 'Provide the latest cash flow forecast.';
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: sheet('Question,Submitted by', [[question, 'Lender A'], [question, 'Lender A']]),
    })).ok).toBe(true);
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'merge', rows: sheet('Question,Response', [[question, responses[0]], [question, responses[1]]]),
    })).ok).toBe(true);
    expect(dealQuestions(store.get(), dealId).map((q) => q.response)).toEqual(responses.slice(0, 2));
  });

  it('lets already unique rows choose before newly unique rows at the same score', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const question = 'Provide the updated debt service coverage model.';
    const original = originalRows(question, 1);
    original[1][3] = 'Financial';
    original[1][5] = 'Modeling team';
    original[2][3] = 'Legal';
    original[2][5] = 'Counsel';
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: sheet(originalHeader, original),
    })).ok).toBe(true);
    const before = dealQuestions(store.get(), dealId);
    const rows = sheet(incomingHeader, [
      [question, 'Lender A', 'Financial', '', '', responses[2]],
      [question, 'Lender A', '', '2026-01-01', '', responses[0]],
      [question, 'Lender A', '', '', 'Modeling team', responses[1]],
    ]);
    const preview = previewImport(store, dealId, 'merge', rows);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
    const after = dealQuestions(store.get(), dealId);
    expect(after.map((q) => [q.id, q.respondedBy, q.response])).toEqual([
      [before[0].id, 'Credit team', responses[0]],
      [before[1].id, 'Modeling team', responses[1]],
      [before[2].id, 'Counsel', responses[2]],
    ]);
    expect(preview).toEqual({ ok: true, value: {
      created: 0, restored: 0, updated: 3, changes: [
        { n: 1, field: 'Response', from: priorResponse, to: responses[0] },
        { n: 2, field: 'Response', from: priorResponse, to: responses[1] },
        { n: 3, field: 'Workstream', from: 'Legal', to: 'Financial' },
        { n: 3, field: 'Response', from: priorResponse, to: responses[2] },
      ],
    } });
  });

  it('matches rows made unique by separate choices in file order', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const question = 'Please provide the detailed debt service coverage model.';
    const originals = [
      ['1', question, 'Lender A', 'Financial', '2026-01-01', 'Counsel', priorResponse],
      ['2', question, 'Lender A', 'Legal', '2026-02-02', 'Credit team', priorResponse],
      ['3', question, 'Lender A', 'Financial', '2026-03-03', 'Credit team', priorResponse],
      ['4', question, 'Lender A', 'Technical', '2026-04-04', 'Independent engineer', priorResponse],
    ];
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: sheet(originalHeader, originals),
    })).ok).toBe(true);
    const expected = [...responses, 'The cost forecast includes the latest engineering assessment.'];
    const rows = sheet(incomingHeader, [
      [question, 'Lender A', '', '', 'Credit team', expected[2]],
      [question, 'Lender A', 'Financial', '', '', expected[3]],
      [question, 'Lender A', '', '2026-01-01', '', expected[0]],
      [question, 'Lender A', '', '2026-02-02', '', expected[1]],
    ]);
    const preview = previewImport(store, dealId, 'merge', rows);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
    const questions = dealQuestions(store.get(), dealId);
    expect(questions.map((item) => item.response)).toEqual(expected);
    expect(questions[3].respondedBy).toBe('Independent engineer');
    const previewResponses = preview.ok && preview.value.changes
      .filter((change) => change.field === 'Response').map((change) => change.to);
    expect(previewResponses).toEqual(expected);
  });

  it('quickly previews 4,000 OCR variants that have the same eligible questions', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const text = 'Provide the latest finalized financial model and all loan-level assumptions'
      + ' for the collateral pool in 2026.';
    const count = 4_000;
    const [base] = sheet('Question,Submitted by,Workstream', [[text, 'Lender A', 'Financial']]);
    const rows = Array.from({ length: count }, (_, index) => {
      let bit = 0;
      const wording = text.replace(/l/g, (letter) => index & (1 << bit++) ? 'I' : letter);
      return { ...base, text: wording, response: 'The revised assumptions are in the financial model.' };
    });
    expect(new Set(rows.map((row) => misreadKey(row.text))).size).toBe(1);
    expect(new Set(rows.map((row) => identifierSig(row.text).plain)).size).toBe(count);
    expect((await store.dispatch(ImportQuestions, {
      dealId, mode: 'append', rows: rows.map((_, index) => ({ ...base, n: index + 1 })),
    })).ok).toBe(true);
    const start = performance.now();
    const preview = previewImport(store, dealId, 'merge', rows);
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(preview).toMatchObject({ ok: true, value: { created: 0, updated: count } });
  }, 120_000);

  it('quickly previews equivalent OCR variants with 4,000 different identifier inventories', async () => {
    const { store } = make();
    const dealId = await deal(store);
    const firstWords = 'cash flow debt terms fees tax book cost data rates plans costs'.split(' ');
    const nextWords = 'sums dates uses caps puts bond loan sales pages parts draft chart'.split(' ');
    const prefix = 'Please provide the cash flow and debt terms, fees, tax book, cost data, rates, plans and costs. '
      + 'Break down the sums, dates, uses, caps, puts, bond and loan sales, pages, parts and draft chart, ';
    const suffix = 'along with all collateral-level reconciliation schedules and allocation calculations.';
    const [base] = sheet('Question,Submitted by,Workstream', [[prefix + suffix, 'Lender A', 'Financial']]);
    const count = 4_000;
    const capitalize = (text: string, words: string[], mask: number) => text.replace(/[a-z]+/g, (word) => {
      const index = words.indexOf(word);
      return index >= 0 && (mask & (1 << index)) ? word.toUpperCase() : word;
    });
    const originals = Array.from({ length: count }, (_, index) => ({
      ...base, n: index + 1, text: capitalize(prefix, firstWords, index) + suffix,
    }));
    const allFirstWords = capitalize(prefix, firstWords, -1);
    const incoming = Array.from({ length: count }, (_, index) => {
      let bit = 0;
      const scanned = suffix.replace(/l/g, (letter) => index & (1 << bit++) ? 'I' : letter);
      return {
        ...base, text: capitalize(allFirstWords, nextWords, index) + scanned,
        response: 'The updated model reflects final tariff and reserve assumptions.',
      };
    });
    expect(new Set([...originals, ...incoming].map((row) => misreadKey(row.text))).size).toBe(1);
    expect(new Set(originals.map((row) => identifierSig(row.text).ids.join(','))).size).toBe(count);
    expect(new Set(incoming.map((row) => identifierSig(row.text).ids.join(','))).size).toBe(count);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: originals })).ok).toBe(true);
    const start = performance.now();
    const preview = previewImport(store, dealId, 'merge', incoming);
    expect(performance.now() - start).toBeLessThan(5_000);
    expect(preview).toMatchObject({ ok: true, value: { created: 0, updated: count } });
  }, 120_000);

  it('2,000 rows, each fitting two questions, are matched in a few seconds', async () => {
    const { store } = make(); const dealId = await deal(store);
    const day = (j: number) => new Date(Date.UTC(2025, 0, 1 + j)).toISOString().slice(0, 10);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('No.,Question,Submitted by,Workstream,Received', Array.from({ length: 2000 }, (_, j) => [String(j + 1), 'Provide the model.', 'Lender A', `W${j}`, day(j - 1 + 1000)])) });
    const at = Date.now();
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: sheet('Question,Submitted by,Workstream,Received,Response', Array.from({ length: 2000 }, (_, j) => ['Provide the model.', 'Lender A', `W${j}`, day(j + 1000), `r${j}`])) });
    const ms = Date.now() - at; console.log('2,000-row chain of ties, ms:', ms);
    expect(r.ok).toBe(true); expect(ms).toBeLessThan(5_000); expect(dealQuestions(store.get(), dealId)).toHaveLength(2000);
  }, 120_000);
});


describe('identifiers and combining marks stay distinct during Merge', () => {
  const distinct = [
    ['Please confirm the distribution rights for Class I shares.',
      'Please confirm the distribution rights for Class L shares.'],
    ['What is the commitment under Facility I?', 'What is the commitment under Facility L?'],
    ['Please confirm the meaning of दिन in clause 1.', 'Please confirm the meaning of दीन in clause 1.'],
    ['Please confirm the distribution rights for Class i shares.',
      'Please confirm the distribution rights for Class L shares.'],
    ['Please confirm the distribution rights for Class ii shares.',
      'Please confirm the distribution rights for Class LL shares.'],
    ['Please confirm the distribution rights for Class iv shares.',
      'Please confirm the distribution rights for Class LV shares.'],
  ];
  for (const [before, incoming] of distinct) {
    for (const n of [1, 2]) {
      it(`keeps ${before} separate from incoming number ${n}: ${incoming}`, async () => {
        const { store } = make();
        const dealId = await deal(store);
        expect((await store.dispatch(ImportQuestions, {
          dealId, mode: 'append', rows: fileRow(1, before, 'Original imported answer'),
        })).ok).toBe(true);
        const original = dealQuestions(store.get(), dealId)[0];
        expect((await store.dispatch(SetResponse, {
          dealId, questionId: original.id, response: 'Original typed answer',
        })).ok).toBe(true);
        const saved = structuredClone(store.get().questions[original.id]);
        expect(matchRows({ rows: [[String(n), incoming, 'New answer', 'Lender', 'Finance']] }, mapping, [saved]))
          .toEqual(new Map());
        const rows = fileRow(n, incoming, 'New answer');
        const preview = previewImport(store, dealId, 'merge', rows);
        const result = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows });
        expect(result.ok).toBe(true);
        expect(store.get().questions[original.id]).toEqual(saved);
        expect(preview).toEqual({ ok: true, value: { created: 1, updated: 0, restored: 0, changes: [] } });
        const questions = dealQuestions(store.get(), dealId);
        expect(questions).toHaveLength(2);
        expect(questions.find((q) => q.id !== original.id)).toMatchObject({
          n: 2, text: incoming, response: 'New answer',
        });
        if (!result.ok) throw new Error(result.error.message);
        expect((await store.undo(result.value.opId)).ok).toBe(true);
        expect(dealQuestions(store.get(), dealId)).toEqual([saved]);
      });
    }
  }
});

describe('OCR and genuinely renumbered questions still match', () => {
  for (const [before, incoming] of [
    ['Is the O&M contract signed?', 'ls the O&M contract signed?'],
    ['Please confirm the distribution rights for Class I shares.',
      'Please confirm the distribution rights for Class I shares.'],
    ['IS the O&M contract signed?', 'Is the O&M contract signed?'],
  ]) {
    it(`still matches a genuinely renumbered question: ${incoming}`, async () => {
      const { store } = make();
      const dealId = await deal(store);
      expect((await store.dispatch(ImportQuestions, {
        dealId, mode: 'append', rows: fileRow(1, before, 'Original answer'),
      })).ok).toBe(true);
      const original = dealQuestions(store.get(), dealId)[0];
      expect(matchRows({ rows: [['2', incoming, 'Updated answer', 'Lender', 'Finance']] }, mapping, [original]))
        .toEqual(new Map([[original.id, 0]]));
      const rows = fileRow(2, incoming, 'Updated answer');
      const preview = previewImport(store, dealId, 'merge', rows);
      expect(preview.ok && preview.value).toMatchObject({ created: 0, updated: 1, restored: 0 });
      expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
      expect(dealQuestions(store.get(), dealId)).toHaveLength(1);
      expect(store.get().questions[original.id]).toMatchObject({ n: 1, text: incoming, response: 'Updated answer' });
    });
  }
});

describe('the existing number fallback stays the same', () => {
  for (const [before, incoming, n, matches] of [
    ['Is the O&M contract signed?', 'is the O&M contract signed?', 1, true],
    ['Is the O&M contract signed?', 'is the O&M contract signed?', 2, false],
    ['Please confirm the mail delivery arrangements.', 'Please confirm the mall delivery arrangements.', 1, true],
    ['Please confirm the mail delivery arrangements.', 'Please confirm the mall delivery arrangements.', 2, false],
    ['Please confirm the civil engineering design and project completion schedule.',
      'Please confirm the clvll engineering design and project completion schedule.', 1, true],
    ['Please confirm the civil engineering design and project completion schedule.',
      'Please confirm the clvll engineering design and project completion schedule.', 2, false],
  ] as const) {
    it(`preserves the existing number fallback for ${before} / ${incoming} / ${n}`, async () => {
      const { store } = make();
      const dealId = await deal(store);
      expect((await store.dispatch(ImportQuestions, {
        dealId, mode: 'append', rows: fileRow(1, before, 'Original answer'),
      })).ok).toBe(true);
      const original = dealQuestions(store.get(), dealId)[0];
      const rows = fileRow(n, incoming, 'Updated answer');
      expect(matchRows({ rows: [[String(n), incoming, 'Updated answer', 'Lender', 'Finance']] }, mapping, [original]))
        .toEqual(matches ? new Map([[original.id, 0]]) : new Map());
      const preview = previewImport(store, dealId, 'merge', rows);
      expect(preview.ok && preview.value).toMatchObject({ created: matches ? 0 : 1, updated: matches ? 1 : 0 });
      expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows })).ok).toBe(true);
      expect(dealQuestions(store.get(), dealId)).toHaveLength(matches ? 1 : 2);
      expect(store.get().questions[original.id]).toMatchObject({
        text: matches ? incoming : before, response: matches ? 'Updated answer' : 'Original answer',
      });
    });
  }
});

it('merges a sentence-initial I misread as l into the same question', async () => {
  const { store } = make();
  const dealId = await deal(store);
  const originalText = 'I understand the lender requires the DSCR model; please confirm.';
  const incomingText = 'l understand the lender requires the DSCR model; please confirm.';
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'append', rows: fileRow(1, originalText, 'Original answer'),
  })).ok).toBe(true);
  const original = dealQuestions(store.get(), dealId)[0];
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'merge', rows: fileRow(1, incomingText, 'Updated answer'),
  })).ok).toBe(true);
  const questions = dealQuestions(store.get(), dealId);
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({ id: original.id, n: 1, text: incomingText, response: 'Updated answer' });
});

it('keeps Class I shares and Class L shares as separate questions', async () => {
  const { store } = make();
  const dealId = await deal(store);
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'append', rows: fileRow(1, 'Class I shares', 'Original answer'),
  })).ok).toBe(true);
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'merge', rows: fileRow(1, 'Class L shares', 'New answer'),
  })).ok).toBe(true);
  expect(dealQuestions(store.get(), dealId)).toMatchObject([
    { n: 1, text: 'Class I shares', response: 'Original answer' },
    { n: 2, text: 'Class L shares', response: 'New answer' },
  ]);
});

it.each(['No.', 'Ref.'])('preserves the original answer when an identifier follows %s', async (prefix) => {
  const { store } = make();
  const dealId = await deal(store);
  const originalText = `Facility ${prefix} I requires consent.`;
  const incomingText = `Facility ${prefix} L requires consent.`;
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'append', rows: fileRow(1, originalText, 'Original answer'),
  })).ok).toBe(true);
  const original = dealQuestions(store.get(), dealId)[0];
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'merge', rows: fileRow(1, incomingText, 'New answer'),
  })).ok).toBe(true);
  expect(dealQuestions(store.get(), dealId)).toMatchObject([
    { id: original.id, n: 1, text: originalText, response: 'Original answer' },
    { n: 2, text: incomingText, response: 'New answer' },
  ]);
});

it('matches a renumbered question with a lowercase sentence-initial i', async () => {
  const { store } = make();
  const dealId = await deal(store);
  const originalText = 'I understand the lender requires the DSCR model; please confirm.';
  const incomingText = 'i understand the lender requires the DSCR model; please confirm.';
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'append', rows: fileRow(1, originalText, 'Original answer'),
  })).ok).toBe(true);
  const original = dealQuestions(store.get(), dealId)[0];
  expect((await store.dispatch(ImportQuestions, {
    dealId, mode: 'merge', rows: fileRow(12, incomingText, 'Updated answer'),
  })).ok).toBe(true);
  expect(dealQuestions(store.get(), dealId)).toMatchObject([
    { id: original.id, n: 1, text: incomingText, response: 'Updated answer' },
  ]);
});
