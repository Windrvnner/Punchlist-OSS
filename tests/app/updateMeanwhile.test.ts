/**
 * "Update from documents" while a person works on the same finding. The update's call to the model is held open,
 * the person acts, and then the reply lands: nothing they did may be dropped. Run on a deal of realistic size.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { CreateFinding, EditFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding } from '../../src/app/commands/findings';
import { reassess } from '../../src/app/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { MemoryLocal } from '../../src/adapters/local';
import { ok } from '../../src/domain/result';
import type { Source } from '../../src/domain/model';

const COMMANDS = [CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot, CreateFinding, EditFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding, ImportQuestions, RevertImport];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 16, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };

const rowsFrom = (csv: string) => { const t = readCsv(new TextEncoder().encode(csv)); if (!t.ok) throw new Error('csv'); return prepareImport(t.value.rows, suggestMapping(t.value.columns)).rows; };
const EPC: Source = { doc: 'EPC contract.pdf', loc: 'p. 80', docId: 'doc_epc' };
const QUESTIONS = 2000, FINDINGS = 120;

/** A deal of 2,000 questions and 120 findings. The finding under test cites the EPC contract and has two questions asked about it. */
async function world(reply: { body: string[]; sources: Source[] }) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
  // the update's call is held open until the test lets it answer, as the backend does: new words and the sources they cite
  let answer!: () => void; let asked!: () => void; const calling = new Promise<void>((r) => { asked = r; }); const held = new Promise<void>((r) => { answer = r; });
  const ai = { ...mockAi(opts, repo), reassess: async () => { asked(); await held; return ok(reply); } };
  const store = new Store({ repo, ai, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
  const dealId = Object.values(store.get().deals)[0].id; await store.loadDeal(dealId);
  for (let i = 0; i < FINDINGS; i++) await store.dispatch(CreateFinding, { dealId, title: `Finding ${i}`, workstream: 'Legal', body: [`Detail of finding ${i}. [1]`], sources: [EPC], origin: 'chat' }, { quiet: true });
  const findingId = Object.values(store.get().findings).find((f) => f.title === `Finding ${FINDINGS >> 1}`)!.id;
  // the Q&A log comes in as one import; the two questions asked about the finding are added by hand
  const rows = rowsFrom(['No.,Question', ...Array.from({ length: QUESTIONS - 2 }, (_, i) => `${i + 1},"Question ${i + 1}: what is the position on item ${i * 7919 % 10007}?"`)].join('\n'));
  expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows }, { quiet: true })).ok).toBe(true);
  for (const text of ['What is the liability cap under the EPC contract?', 'Has the cap been amended?']) await store.dispatch(CreateQuestion, { dealId, text, linkedFinding: findingId }, { quiet: true });
  const linked = Object.values(store.get().questions).filter((q) => q.linkedFinding === findingId);
  expect(Object.keys(store.get().questions).length).toBe(QUESTIONS); expect(linked.length).toBe(2);
  // a response on the first of them marks the finding, so the update is offered
  await store.dispatch(SetResponse, { dealId, questionId: linked[0].id, response: 'The cap is 20% of the contract price.' });
  const f = () => store.get().findings[findingId];
  expect(f().updated).toBe(true);
  /** press Update from documents, and return once the model has been asked; `done` settles when the reply has landed (wrapped, so awaiting press does not wait for it) */
  const press = async () => { const done = reassess(store, dealId, findingId); await calling; return { done }; };
  const last = (command: string) => Object.values(store.get().ops).filter((o) => o.command === command).at(-1)!;
  return { store, dealId, findingId, linked, f, press, answer, last };
}
const NEW = { body: ['The liability cap is 20% of the contract price. [1]'], sources: [{ doc: 'EPC contract.pdf', loc: 'p. 82', docId: 'doc_epc' }] };

describe('Update from documents while a person works on the finding', () => {
  it('keeps a source added while it ran, after the sources the new words cite, and leaves the mark so the next update reads it', async () => {
    const w = await world(NEW); const { done } = await w.press();
    await w.store.dispatch(AttachDocumentToFinding, { dealId: w.dealId, findingId: w.findingId, doc: 'EPC amendment 3.pdf', docId: 'doc_am3' });
    expect(w.f().updatedWhy).toBe('EPC amendment 3.pdf attached');
    w.answer(); await done;
    expect(w.f().body).toEqual(NEW.body);                                         // the update still lands
    expect(w.f().sources.map((x) => x.doc)).toEqual(['EPC contract.pdf', 'EPC amendment 3.pdf']);
    expect(w.f().sources[0].loc).toBe('p. 82');                                   // [1] in the new words still points at the place the reply cited
    expect(w.f()).toMatchObject({ updated: true, updatedWhy: 'EPC amendment 3.pdf attached' });
    // Undo of the update gives up only the new words: the source and the mark stay
    expect((await w.store.undo(w.last('ApplyReassessment').id)).ok).toBe(true);
    expect(w.f().body).toEqual([`Detail of finding ${FINDINGS >> 1}. [1]`]);
    expect(w.f().sources.map((x) => x.doc)).toEqual(['EPC contract.pdf', 'EPC amendment 3.pdf']); expect(w.f().updated).toBe(true);
  }, 120000);

  it('keeps the added source and the mark when the reply cites no sources; a source the reply cites too is listed once', async () => {
    const w = await world({ body: ['Nothing in the documents changes this.'], sources: [] }); const { done } = await w.press();
    await w.store.dispatch(AttachDocumentToFinding, { dealId: w.dealId, findingId: w.findingId, doc: 'EPC amendment 3.pdf', docId: 'doc_am3' });
    w.answer(); await done;
    expect(w.f().sources.map((x) => x.doc)).toEqual(['EPC contract.pdf', 'EPC amendment 3.pdf']);
    expect(w.f()).toMatchObject({ updated: true, updatedWhy: 'EPC amendment 3.pdf attached' });
    // the reply read the added document after all and cites it: it is not listed a second time
    const both = await world({ body: ['Amendment 3 lifts the cap. [1]'], sources: [{ doc: 'EPC amendment 3.pdf', loc: 'p. 2', docId: 'doc_am3' }] }); const { done: d2 } = await both.press();
    await both.store.dispatch(AttachDocumentToFinding, { dealId: both.dealId, findingId: both.findingId, doc: 'EPC amendment 3.pdf', docId: 'doc_am3' });
    both.answer(); await d2;
    expect(both.f().sources).toEqual([{ doc: 'EPC amendment 3.pdf', loc: 'p. 2', docId: 'doc_am3' }]);
    expect(both.f()).toMatchObject({ updated: false, updatedWhy: '' });           // it has read it, so nothing is left to read
  }, 240000);

  it('leaves the mark when a response arrives, or is reworded, on one of the finding’s questions while it ran', async () => {
    const w = await world(NEW); const { done } = await w.press();
    await w.store.dispatch(SetResponse, { dealId: w.dealId, questionId: w.linked[1].id, response: 'Amendment 3 raises it to 25%.' });   // another question answers
    w.answer(); await done;
    expect(w.f().body).toEqual(NEW.body);
    expect(w.f().updated).toBe(true); expect(w.f().updatedOn?.questions).toEqual(w.linked.map((q) => q.id));
    // a response that was already named by the mark is reworded: the mark does not change, and still must not be cleared
    const r = await world(NEW); const { done: d2 } = await r.press(); const mark = JSON.stringify([r.f().updatedWhy, r.f().updatedOn]);
    await r.store.dispatch(SetResponse, { dealId: r.dealId, questionId: r.linked[0].id, response: 'The cap is 25% of the contract price.' });
    expect(JSON.stringify([r.f().updatedWhy, r.f().updatedOn])).toBe(mark);
    r.answer(); await d2;
    expect(r.f().body).toEqual(NEW.body); expect(r.f().updated).toBe(true);
  }, 240000);

  it('replaces nothing on a finding closed while it ran, and the Undo on "Finding closed" still works', async () => {
    const w = await world(NEW); const { done } = await w.press();
    await w.store.dispatch(SetFindingStatus, { dealId: w.dealId, findingId: w.findingId, status: 'closed', note: 'Settled with the sponsor' });
    const closed = w.f(); const close = w.last('SetFindingStatus');
    w.answer(); await done;
    expect(w.f()).toEqual(closed);                                                // the closed finding is exactly as the person left it
    expect(w.store.get().ui.toasts.at(-1)!.text).toMatch(/^Not updated: the finding was closed meanwhile$/);
    expect((await w.store.undo(close.id)).ok).toBe(true);
    expect(w.f()).toMatchObject({ status: 'open', note: '', body: [`Detail of finding ${FINDINGS >> 1}. [1]`] });
  }, 120000);

  it('says so when it replaced nothing because the words were changed while it ran, rather than ending without a word', async () => {
    const w = await world(NEW); const { done } = await w.press();
    await w.store.dispatch(EditFinding, { dealId: w.dealId, findingId: w.findingId, title: w.f().title,
      workstream: 'Legal', body: ['A person’s own words.'] });
    w.answer(); await done;
    expect(w.f().body).toEqual(['A person’s own words.']); expect(w.f().updated).toBe(true);
    expect(w.store.get().ui.toasts.at(-1)!.text).toBe('Not updated: the finding was changed meanwhile');
  }, 120000);

  it('clears the mark when nothing arrived while it ran, whatever else a person changed (title, a new question)',
    async () => {
    const w = await world(NEW); const { done } = await w.press();
    await w.store.dispatch(CreateQuestion, { dealId: w.dealId, text: 'Is amendment 3 signed?', linkedFinding: w.findingId });
    await w.store.dispatch(EditFinding, { dealId: w.dealId, findingId: w.findingId, title: 'Liability cap',
      workstream: 'Legal', body: w.f().body });
    w.answer(); await done;
    expect(w.f()).toMatchObject({ title: 'Liability cap', body: NEW.body, updated: false, updatedWhy: '' });
    expect(w.f().updatedOn).toBeUndefined(); expect(w.f().sources).toEqual(NEW.sources);
  }, 120000);
});
