/**
 * A question closed while its draft is being written. A coworker's close never throws drafting
 * work away. The draft still arrives, and taking it fills the response and leaves the status the person set.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetQuestionStatus, SetResponse } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { readCsv } from '../../src/domain/sheets';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { MemoryLocal } from '../../src/adapters/local';
import { ok } from '../../src/domain/result';

const COMMANDS = [CreateDeal, CreateQuestion, SetQuestionStatus, SetResponse, RequestDraft, ApplyDraft, AcceptDraft, RestoreQuestionSnapshot, ImportQuestions, RevertImport];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const rowsFrom = (csv: string) => { const r = readCsv(new TextEncoder().encode(csv)); if (!r.ok) throw new Error('csv'); return prepareImport(r.value.rows, suggestMapping(r.value.columns)).rows; };

/** A deal of 2,000 questions; the draft for the last one is held open until the test lets it answer. */
async function world() {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
  let answer!: () => void; const held = new Promise<void>((r) => { answer = r; });
  const ai = { ...mockAi(opts, repo), draft: async () => { await held; return ok({ status: 'found' as const, text: 'The cap is 20% of the contract price.', sources: [{ doc: 'EPC contract.pdf', loc: 'p. 82', docId: 'doc_epc' }] }); } };
  const store = new Store({ repo, ai, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
  const dealId = Object.values(store.get().deals)[0].id; await store.loadDeal(dealId);
  const rows = rowsFrom(['No.,Question', ...Array.from({ length: 1999 }, (_, i) => `${i + 1},"Question ${i + 1}: what is the position on item ${i * 7919 % 10007}?"`)].join('\n'));
  expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows }, { quiet: true })).ok).toBe(true);
  await store.dispatch(CreateQuestion, { dealId, text: 'What is the liability cap under the EPC contract?' });
  const q = Object.values(store.get().questions).find((x) => x.text.startsWith('What is the liability cap'))!;
  expect(Object.keys(store.get().questions).length).toBe(2000);
  return { store, dealId, q, answer, now: () => store.get().questions[q.id] };
}

describe('a question closed while its draft is being written', () => {
  it('still gets the draft, and Use as response fills the response and leaves it Closed; Undo puts it back', async () => {
    const w = await world();
    const r = await w.store.dispatch(RequestDraft, { dealId: w.dealId, questionId: w.q.id }); expect(r.ok).toBe(true);
    await w.store.dispatch(SetQuestionStatus, { dealId: w.dealId, questionId: w.q.id, status: 'closed' });     // a coworker closes it meanwhile
    w.answer(); await w.store.settled(r.ok ? r.value.opId : '');
    expect(w.now()).toMatchObject({ status: 'closed', draft: { status: 'found', text: 'The cap is 20% of the contract price.' } });
    const before = w.now();
    const a = await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: w.q.id }); expect(a.ok).toBe(true);
    expect(w.now()).toMatchObject({ status: 'closed', response: 'The cap is 20% of the contract price.', provenance: { origin: 'ai' } });
    expect(w.now().draft).toBeUndefined();
    expect(w.store.get().ui.toasts.at(-1)!.text).toBe(`Response recorded on Q${w.q.n}`);
    expect((await w.store.undo(a.ok ? a.value.opId : '')).ok).toBe(true);
    expect(w.now()).toMatchObject({ status: 'closed', response: '', draft: before.draft });
  }, 120000);

  it('an open question is still marked Answered when its draft is used', async () => {
    const w = await world();
    const r = await w.store.dispatch(RequestDraft, { dealId: w.dealId, questionId: w.q.id }); w.answer(); await w.store.settled(r.ok ? r.value.opId : '');
    expect((await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: w.q.id })).ok).toBe(true);
    expect(w.now()).toMatchObject({ status: 'answered', response: 'The cap is 20% of the contract price.' });
  }, 120000);
});
