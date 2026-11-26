/**
 * Reported data-integrity bugs. Each test sets up its situation with the app's own commands and says how in its
 * first comment.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuse, quota, toAQuestion, type Disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { readCsv } from '../../src/domain/sheets';
import { MemoryLocal } from '../../src/adapters/local';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { dealQuestions, dealFindings } from '../../src/app/state';
import type { AiService, Repository } from '../../src/ports';
import { ok } from '../../src/domain/result';

const COMMANDS = [CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, ImportQuestions, RevertImport];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 10, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const foundDraft: AiService['draft'] = async (i) => ok({ status: 'found', text: `The documents bear on this: ${i.questionText}`, sources: [{ doc: 'Information memorandum.pdf', loc: 'p. 22', docId: 'doc_im' }] });

/**
 * One window of the app. Windows given the same `kv` share storage: a restart opens the same install again, and a second
 * `tab` is another install on the same shared folder, as the browser demo runs each tab.
 */
function windowOn(kv = disk(), wrap: (r: Repository) => Repository = (r) => r, tab = false) {
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo: wrap(memRepo(clock.now, tab ? { shared: kv.shared } : kv)), ai: { ...mockAi(opts), draft: foundDraft }, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, kv };
}
/** The app started again on the same storage, with a deal's records loaded. */
async function restarted(kv: Disk, ...dealIds: string[]) { const { store } = windowOn(kv); await store.boot(); for (const d of dealIds) await store.loadDeal(d); return store; }
async function newDeal(store: Store, name: string) { const before = new Set(Object.keys(store.get().deals)); const r = await store.dispatch(CreateDeal, { name, folders: [] }); expect(r.ok).toBe(true); return Object.keys(store.get().deals).find((k) => !before.has(k))!; }
const rowsFrom = (csv: string) => { const tb = readCsv(new TextEncoder().encode(csv)); if (!tb.ok) throw new Error('csv'); return prepareImport(tb.value.rows, suggestMapping(tb.value.columns)).rows; };
const opOf = (r: { ok: boolean; value?: { opId: string } }) => { expect(r.ok).toBe(true); return r.value!.opId; };
const drafted = async (store: Store, qid: string) => { for (let i = 0; i < 80; i++) { if (store.get().questions[qid]?.draft?.status === 'found') return; await sleep(10); } throw new Error('no draft'); };
/** Every write to storage takes `ms` while `slow.on` is set: the reports used a console wrapper to delay one backend call. */
function slowRepo(slow: { on: boolean }, ms: number) { return (repo: Repository): Repository => ({ get: (k, i) => repo.get(k, i), list: (k, d) => repo.list(k, d), audit: (r) => repo.audit(r), watch: (f) => repo.watch(f), transaction: async (tx) => { if (slow.on) await sleep(ms); return repo.transaction(tx); } }); }

describe('data integrity', () => {
  it('deleting a finding does not delete a finding in another deal', async () => {
    // Mockup: a finding in a new deal "Datum QA" shared Proseware's id, and deleting one removed both after reload. (Findings no longer have codes.)
    const { store, kv } = windowOn(); await store.boot();
    const proseware = await newDeal(store, 'Proseware'), datum = await newDeal(store, 'Datum');
    await store.dispatch(CreateFinding, { dealId: proseware, title: 'Proseware’s finding', workstream: 'Legal' });
    await store.dispatch(CreateFinding, { dealId: datum, title: 'Datum’s finding', workstream: 'Legal' });
    const a = dealFindings(store.get(), proseware)[0], b = dealFindings(store.get(), datum)[0];
    expect(a.id).not.toBe(b.id);
    expect((await store.dispatch(DeleteFinding, { dealId: datum, findingId: b.id })).ok).toBe(true);
    expect(dealFindings(store.get(), proseware).map((f) => f.title)).toEqual(['Proseware’s finding']);
    const again = await restarted(kv, proseware, datum);
    expect(dealFindings(again.get(), proseware).map((f) => f.title)).toEqual(['Proseware’s finding']);
    expect(dealFindings(again.get(), datum)).toEqual([]);
  });

  it('a save in a second window does not discard an unrelated edit made in the first', async () => {
    // Mockup: each tab wrote its whole snapshot, so tab B's save put tab A's question back as it was.
    const kv = disk(); const A = windowOn(kv).store; await A.boot();
    const dealId = await newDeal(A, 'Proseware');
    await A.dispatch(CreateQuestion, { dealId, text: 'First question' }); await A.dispatch(CreateQuestion, { dealId, text: 'Second question' });
    const [q1, q2] = dealQuestions(A.get(), dealId).map((q) => q.id);
    const B = windowOn(kv, undefined, true).store; await B.boot(); await B.loadDeal(dealId);                            // the second window opens before either edit
    expect((await A.dispatch(EditQuestionField, { dealId, questionId: q1, field: 'text', value: 'QA TAB A independent saved edit' })).ok).toBe(true);
    expect((await B.dispatch(EditQuestionField, { dealId, questionId: q2, field: 'text', value: 'QA TAB B different saved edit' })).ok).toBe(true);
    const again = await restarted(kv, dealId);
    expect(dealQuestions(again.get(), dealId).map((q) => q.text)).toEqual(['QA TAB A independent saved edit', 'QA TAB B different saved edit']);
  });

  it('a slow save of Closed cannot land after the Undo that followed it', async () => {
    // Mockup: saveFinding was delayed 900ms for Closed; Undo ran first and the late Closed save then won, surviving reload.
    const slow = { on: false }; const { store, kv } = windowOn(disk(), slowRepo(slow, 40)); await store.boot();
    const dealId = await newDeal(store, 'Proseware'); await store.dispatch(CreateFinding, { dealId, title: 'Cycling assumption', workstream: 'Technical' });
    const f = dealFindings(store.get(), dealId)[0];
    slow.on = true;
    const closing = store.dispatch(SetFindingStatus, { dealId, findingId: f.id, status: 'closed' });   // still being saved…
    const reopening = store.dispatch(SetFindingStatus, { dealId, findingId: f.id, status: 'open' });   // …when the person goes back on it
    expect((await closing).ok).toBe(true); expect((await reopening).ok).toBe(true);
    expect(store.get().findings[f.id].status).toBe('open');
    // and the Undo of a close that has been saved, issued while storage is slow
    const op = opOf(await store.dispatch(SetFindingStatus, { dealId, findingId: f.id, status: 'closed' }));
    expect((await store.undo(op)).ok).toBe(true);
    slow.on = false; await sleep(120);                                                                  // anything late has had its chance
    expect(store.get().findings[f.id].status).toBe('open');
    expect((await restarted(kv, dealId)).get().findings[f.id].status).toBe('open');
  });

  it('undoing a draft action after moving to another deal is saved to the question it belongs to', async () => {
    // Mockup: Undo saved with the deal on screen, so after moving to Trey the Proseware question stayed Closed on reload. (Now a draft is used as the response, and the question is Answered.)
    const { store, kv } = windowOn(); await store.boot();
    const proseware = await newDeal(store, 'Proseware'), trey = await newDeal(store, 'Trey');
    const text = 'Please reconcile the operating case with Schedule 4.';
    await store.dispatch(CreateQuestion, { dealId: proseware, text });
    const q = dealQuestions(store.get(), proseware)[0];
    await store.dispatch(RequestDraft, { dealId: proseware, questionId: q.id }); await drafted(store, q.id);
    // was Close internally; there is now one way to use a draft
    const op = opOf(await store.dispatch(AcceptDraft, { dealId: proseware, questionId: q.id }));
    expect(store.get().questions[q.id].status).toBe('answered');
    // the person is now on another deal
    store.ui({ route: { name: 'qa', dealId: trey } });
    expect((await store.undo(op)).ok).toBe(true);
    const saved = (await restarted(kv, proseware)).get().questions[q.id];
    expect(saved.status).toBe('open'); expect(saved.response).toBe('');
  });

  it('undoing a response also takes back what it did to the linked finding', async () => {
    // Mockup: Undo emptied the question's response but the finding still said "Response received" and offered Reassess.
    const { store, kv } = windowOn(); await store.boot();
    const dealId = await newDeal(store, 'Proseware'); await store.dispatch(CreateFinding, { dealId, title: 'Operating case differs', workstream: 'Technical' });
    const f = dealFindings(store.get(), dealId)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'Please reconcile the operating case.', linkedFinding: f.id });
    const q = dealQuestions(store.get(), dealId)[0];
    // "Response received" entries in the finding's stored history that have not been undone: what its page counts as standing
    const marks = async () => { const r = await memRepo(clock.now, kv).audit(f.id); if (!r.ok) throw new Error('history'); const undone = new Set(r.value.map((a) => a.undoes).filter(Boolean)); return r.value.filter((a) => a.kind === 'response' && !undone.has(a.opId)).length; };
    // by import
    const imp = opOf(await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom(`Number,Question,Response\n${q.n},Please reconcile the operating case.,QA response to undo\n`) }));
    expect(store.get().questions[q.id].response).toBe('QA response to undo'); expect(store.get().findings[f.id].updated).toBe(true); expect(await marks()).toBe(1);
    expect((await store.undo(imp)).ok).toBe(true);
    expect(store.get().questions[q.id].response).toBe(''); expect(store.get().findings[f.id].updated).toBeFalsy(); expect(await marks()).toBe(0);
    // by using a draft as the response
    await store.dispatch(RequestDraft, { dealId, questionId: q.id }); await drafted(store, q.id);
    const close = opOf(await store.dispatch(AcceptDraft, { dealId, questionId: q.id }));
    expect(store.get().findings[f.id].updated).toBe(true); expect(await marks()).toBe(1);
    expect((await store.undo(close)).ok).toBe(true);
    expect(store.get().questions[q.id].status).toBe('open'); expect(store.get().findings[f.id].updated).toBeFalsy(); expect(await marks()).toBe(0);
    const again = await restarted(kv, dealId);
    expect(again.get().findings[f.id].updated).toBeFalsy(); expect(again.get().questions[q.id].response).toBe('');
  });

  it('undoing a merge that named one number twice restores the row as it was before the import', async () => {
    // Mockup: Undo left "First update", the state between the two rows, instead of the original.
    const { store, kv } = windowOn(); await store.boot(); const dealId = await newDeal(store, 'Tailspin');
    await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question,Response\n1,Original question,Original response\n') });
    const op = opOf(await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question,Response\n1,Original question,First response\n1,Second update,Second response\n') }));
    // the second row with the same number is a second question, not a change to the first
    expect(dealQuestions(store.get(), dealId).map((q) => [q.text, q.response]).sort()).toEqual([['Original question', 'First response'], ['Second update', 'Second response']]);
    expect((await store.undo(op)).ok).toBe(true);
    expect(dealQuestions(store.get(), dealId).map((q) => [q.text, q.response])).toEqual([['Original question', 'Original response']]);
    expect(dealQuestions((await restarted(kv, dealId)).get(), dealId).map((q) => [q.text, q.response])).toEqual([['Original question', 'Original response']]);
  });

  it('when storage refuses a write the person is told, and nothing is reported as saved', async () => {
    // Mockup: with localStorage full the save was swallowed, no message appeared, and reload showed the old text.
    const { store, kv } = windowOn(); await store.boot(); const dealId = await newDeal(store, 'Proseware');
    await store.dispatch(CreateQuestion, { dealId, text: 'As first saved' }); const q = dealQuestions(store.get(), dealId)[0];
    const room = refuse(kv.local, toAQuestion, quota);
    const r = await store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'QA real browser quota failure' });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.kind).toBe('storageFull');
    expect(store.get().ui.toasts.some((x) => /storage is full/.test(x.text) && x.sticky)).toBe(true);   // said, and it stays until dealt with
    expect(store.get().questions[q.id].text).toBe('As first saved');                                    // the record does not claim the edit
    room();
    expect((await restarted(kv, dealId)).get().questions[q.id].text).toBe('As first saved');
  });
});
