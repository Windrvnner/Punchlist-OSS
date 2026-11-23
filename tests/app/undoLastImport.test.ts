// "Undo last import" in the Q&A ⋯ menu: the last import on this PC is taken back at any time after, as far as it
// still can. Everything here at deal scale: a 2,000-question log, imported again by Append or by Merge from the wrong file.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuse, quota, type Disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, DeleteDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse, DeleteQuestion, RestoreQuestion, EditQuestionField, SetQuestionStatus } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding, AttachDocumentToFinding } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport, UndoLastImport, lastImport } from '../../src/app/commands/importQuestions';
import { registry, Undo } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { deletedOf } from '../../src/ui/deleted';

const COMMANDS = [CreateDeal, DeleteDeal, CreateQuestion, SetResponse, DeleteQuestion, RestoreQuestion, EditQuestionField, SetQuestionStatus, CreateFinding, EditFinding, AttachDocumentToFinding, ImportQuestions, RevertImport, UndoLastImport, Undo];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0) + (t++) * 1000).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZY${String(seq++).padStart(7, '0')}` };
function make(d: Disk = disk()) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, d);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, d };
}
const PARTIES = ['Lender counsel', 'Bidder 1', 'Bidder 2', 'Sponsor'];
const TOPICS = ['revenue by customer', 'EBITDA adjustments', 'change of control clauses', 'pending litigation', 'pension deficit', 'capex plan', 'working capital peg', 'key employee retention'];
/** a deal's question list as a file: n rows, each its own wording, number and party; every fifth row answered */
const rows = (n: number, answer = (i: number) => (i % 5 === 0 ? `See data room folder 3.${i}` : '')) => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `Please provide ${TOPICS[i % TOPICS.length]} for entity ${Math.floor(i / TOPICS.length) + 1}, item ${i + 1}.`, askedBy: PARTIES[i % PARTIES.length],
  received: '2026-11-02', workstream: i % 2 ? 'Legal' : 'Financial', priority: '' as const, response: answer(i), respondedBy: answer(i) ? 'Target' : '', responded: '', status: '' as const }));
const run = async (store: Store, cmd: any, input: any) => { const r = await store.dispatch(cmd, input); expect(r.ok, JSON.stringify(!r.ok && r.error)).toBe(true); return r as any; };
async function deal2000(d?: Disk) {
  const { store } = make(d); await store.boot(); await run(store, CreateDeal, { name: 'Proseware', folders: [] });
  const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId, { gaps: false });
  await run(store, ImportQuestions, { dealId, mode: 'merge', rows: rows(2000) });
  return { store, dealId };
}
const qs = (store: Store, dealId: string) => dealQuestions(store.get(), dealId);
const byN = (store: Store, dealId: string, n: number) => qs(store, dealId).find((q) => q.n === n)!;
const lastToast = (store: Store) => store.get().ui.toasts.at(-1)?.text ?? '';

describe('Undo last import', () => {
  it('a wrong Append of 2,000 rows is taken back long after its notice: the 2,000 copies go to Deleted, the log is as it was', async () => {
    const { store, dealId } = await deal2000();
    const before = qs(store, dealId).map((q) => JSON.stringify(q));
    await run(store, ImportQuestions, { dealId, mode: 'append', rows: rows(2000) });
    expect(qs(store, dealId)).toHaveLength(4000);
    store.ui({ toasts: [] });                                                   // the notice and its Undo are long gone
    await run(store, UndoLastImport, { dealId });
    expect(qs(store, dealId).map((q) => JSON.stringify(q))).toEqual(before);
    expect(deletedOf(store.get(), dealId, 'question')).toHaveLength(2000);
    expect(lastToast(store)).toBe('Import undone · 2000 to Deleted');
    // only the last import: the first one is not offered next
    expect(lastImport(store.get(), dealId)).toBeUndefined();
    const again = await store.dispatch(UndoLastImport, { dealId }); expect(!again.ok && again.error.message).toBe('No import to undo');
    expect(qs(store, dealId)).toHaveLength(2000);
  }, 120_000);

  it('a Merge from the wrong file that overwrote 500 responses puts them back; questions changed since are left and named', async () => {
    const { store, dealId } = await deal2000();
    const was = Object.fromEntries(qs(store, dealId).map((q) => [q.n, q.response]));
    const wrong = rows(2000, (i) => (i < 500 ? `Superseded answer from the other deal, ${i}` : i % 5 === 0 ? `See data room folder 3.${i}` : ''));
    const imp = await run(store, ImportQuestions, { dealId, mode: 'merge', rows: [...wrong, ...rows(30).map((r, i) => ({ ...r, n: 3000 + i, text: `Confirm the escrow release mechanics, point ${i + 1}.` }))] });
    expect(lastToast(store)).toBe('Imported · 30 new · 500 updated');
    // since: a response typed over one the import wrote, a status set on another, and one of the import's new questions reworded
    await run(store, SetResponse, { dealId, questionId: byN(store, dealId, 3).id, response: 'Typed by the deal team' });
    await run(store, SetQuestionStatus, { dealId, questionId: byN(store, dealId, 250).id, status: 'answered' });
    await run(store, EditQuestionField, { dealId, questionId: byN(store, dealId, 3004).id, field: 'text', value: 'Confirm the escrow release mechanics and timing.' });
    // the notice's Undo refuses, as before: something changed since
    const u = await store.undo(imp.value.opId); expect(!u.ok && u.error.message).toMatch(/Changed since/);
    await run(store, UndoLastImport, { dealId });
    expect(lastToast(store)).toBe('Import undone, except 3 changed since: Q3, Q250, Q3004');
    const actual = qs(store, dealId);
    const byNumber = new Map(actual.map((q) => [q.n, q]));
    expect(byNumber.size).toBe(actual.length);
    for (let n = 1; n <= 2000; n++) {
      if (n !== 3 && n !== 250) expect(byNumber.get(n)!.response).toBe(was[n]);
    }
    expect(byN(store, dealId, 3).response).toBe('Typed by the deal team');
    expect(byN(store, dealId, 250)).toMatchObject({ response: 'Superseded answer from the other deal, 249', status: 'answered' });
    expect(byN(store, dealId, 3004).text).toBe('Confirm the escrow release mechanics and timing.');
    expect(qs(store, dealId)).toHaveLength(2001);
    expect(deletedOf(store.get(), dealId, 'question')).toHaveLength(29);
    expect(lastImport(store.get(), dealId)).toBeUndefined();
  }, 120_000);

  it('a Merge with nothing changed since is taken back whole: its new questions deleted, the 500 it updated put back', async () => {
    const { store, dealId } = await deal2000();
    const before = qs(store, dealId).map((q) => JSON.stringify({ ...q, rev: 0, updatedAt: '' }));
    const wrong = rows(2000, (i) => (i < 500 ? `Superseded answer from the other deal, ${i}` : i % 5 === 0 ? `See data room folder 3.${i}` : ''));
    await run(store, ImportQuestions, { dealId, mode: 'merge', rows: [...wrong, ...rows(30).map((r, i) => ({ ...r, n: 3000 + i, text: `Confirm the escrow release mechanics, point ${i + 1}.` }))] });
    await run(store, UndoLastImport, { dealId });
    expect(lastToast(store)).toBe('Import undone · 30 to Deleted · 500 back as they were');
    expect(qs(store, dealId).map((q) => JSON.stringify({ ...q, rev: 0, updatedAt: '' }))).toEqual(before);
  }, 120_000);

  it('names at most 50 changed questions, then how many more; a new question deleted since is already gone and not named', async () => {
    const { store, dealId } = await deal2000();
    await run(store, ImportQuestions, { dealId, mode: 'append', rows: rows(2000) });
    const edited = Array.from({ length: 60 }, (_, i) => 2001 + i * 33);
    for (const n of edited) await run(store, EditQuestionField, { dealId, questionId: byN(store, dealId, n).id, field: 'workstream', value: 'Tax' });
    await run(store, DeleteQuestion, { dealId, questionId: byN(store, dealId, 2010).id });
    await run(store, UndoLastImport, { dealId });
    expect(lastToast(store)).toBe(`Import undone, except 60 changed since: ${edited.slice(0, 50).map((n) => `Q${n}`).join(', ')} and 10 more`);
    expect(qs(store, dealId)).toHaveLength(2060);
    expect(deletedOf(store.get(), dealId, 'question')).toHaveLength(1940);
  }, 120_000);

  it('when everything the import wrote has changed since, nothing is written and the import stays offered', async () => {
    const { store, dealId } = await deal2000();
    await run(store, ImportQuestions, { dealId, mode: 'merge', rows: rows(2).map((r) => ({ ...r, response: 'From the wrong file' })) });
    for (const n of [1, 2]) await run(store, SetResponse, { dealId, questionId: byN(store, dealId, n).id, response: `Typed ${n}` });
    const r = await store.dispatch(UndoLastImport, { dealId });
    expect(!r.ok && r.error.message).toBe('Nothing to undo: all of the import changed since');
    expect(byN(store, dealId, 1).response).toBe('Typed 1');
    expect(lastImport(store.get(), dealId)).toBeDefined();
  }, 120_000);

  it('a deleted question the import brought back is deleted again, and one it brought back that was edited since stays', async () => {
    const { store, dealId } = await deal2000();
    for (const n of [7, 8]) await run(store, DeleteQuestion, { dealId, questionId: byN(store, dealId, n).id });
    await run(store, ImportQuestions, { dealId, mode: 'merge', rows: rows(2000) });
    expect(lastToast(store)).toBe('Imported · 0 new · 0 updated · 2 restored');
    await run(store, EditQuestionField, { dealId, questionId: byN(store, dealId, 8).id, field: 'workstream', value: 'Tax' });
    await run(store, UndoLastImport, { dealId });
    expect(lastToast(store)).toBe('Import undone, except 1 changed since: Q8');
    expect(byN(store, dealId, 7)).toBeUndefined(); expect(byN(store, dealId, 8).workstream).toBe('Tax');
    expect(deletedOf(store.get(), dealId, 'question').map((t) => (t.snapshot as { n: number }).n)).toEqual([7]);
  }, 120_000);

  it('a response whose finding changed since is left with it, so the question and the finding still agree', async () => {
    const { store, dealId } = await deal2000();
    await run(store, CreateFinding, { dealId, title: 'Change of control in the main supply contract', workstream: 'Legal' });
    const f = dealFindings(store.get(), dealId)[0];
    await run(store, CreateQuestion, { dealId, text: 'Does the supply contract allow assignment on a change of control?', linkedFinding: f.id });   // Q2001
    await run(store, ImportQuestions, { dealId, mode: 'merge', rows: [{ ...rows(1)[0], n: 2001, askedBy: '', /* the reply names no party: the question is the firm's own */ text: 'Does the supply contract allow assignment on a change of control?', response: 'Consent needed from the supplier' }, { ...rows(2)[1], response: 'Wrong file' }] });
    expect(store.get().findings[f.id].updated).toBe(true);
    const ff = store.get().findings[f.id];
    await run(store, EditFinding, { dealId, findingId: f.id, title: 'Change of control: supplier consent', workstream: ff.workstream, body: ff.body, next: ff.next });
    await run(store, UndoLastImport, { dealId });
    expect(lastToast(store)).toBe('Import undone, except 1 changed since: Q2001');
    expect(byN(store, dealId, 2001).response).toBe('Consent needed from the supplier'); expect(store.get().findings[f.id].updated).toBe(true);
    expect(byN(store, dealId, 2).response).toBe('');
  }, 120_000);

  it.each(['notice Undo', 'Undo last import'])('a finding the import left alone keeps later edits on %s (#50)', async (how) => {
    const { store, dealId } = await deal2000();
    await run(store, CreateFinding, { dealId, title: 'Change of control in the main supply contract', workstream: 'Legal' });
    const f = dealFindings(store.get(), dealId)[0];
    const text = 'Does the supply contract allow assignment on a change of control?';
    await run(store, CreateQuestion, { dealId, text, linkedFinding: f.id });                                // Q2001
    // a document attached marks the finding already, so a response on its question leaves it as it is
    await run(store, AttachDocumentToFinding, { dealId, findingId: f.id, doc: 'Supply contract.pdf', docId: 'doc-1' });
    const before = qs(store, dealId).map((q) => q.response);
    const linkedRow = { ...rows(1)[0], n: 2001, askedBy: '', text, response: 'Consent needed from the supplier' };
    const imp = await run(store, ImportQuestions, { dealId, mode: 'merge', rows: [linkedRow, ...rows(500, () => 'Changed')] });
    const ff = store.get().findings[f.id];
    const edited = { title: 'Change of control: supplier consent', body: ['Consent is needed from the supplier.'] };
    await run(store, EditFinding, { dealId, findingId: f.id, workstream: ff.workstream, ...edited });
    if (how === 'notice Undo') expect((await store.undo(imp.value.opId)).ok).toBe(true);
    else await run(store, UndoLastImport, { dealId });
    const after = store.get().findings[f.id];
    expect([after.title, after.body, after.updated]).toEqual([edited.title, edited.body, true]);
    expect(qs(store, dealId).map((q) => q.response)).toEqual(before);
  }, 120_000);

  it('stays on offer after a restart and after 300 later actions, which prune the journal', async () => {
    const d = disk(); const { store, dealId } = await deal2000(d);
    await run(store, ImportQuestions, { dealId, mode: 'append', rows: rows(2000) });
    const imp = lastImport(store.get(), dealId)!.id;
    expect(store.get().ops[imp].input).toEqual({ dealId, mode: 'append' });      // kept without the file's 2,000 rows
    for (let i = 0; i < 300; i++) await run(store, EditQuestionField, { dealId, questionId: byN(store, dealId, 1 + (i % 50)).id, field: 'workstream', value: i % 2 ? 'Tax' : 'Legal' });
    expect(Object.keys(store.get().ops).length).toBeLessThanOrEqual(260);       // the journal was pruned
    expect(lastImport(store.get(), dealId)?.id).toBe(imp);
    const again = make(d).store; await again.boot(); await again.loadDeal(dealId, { gaps: false });
    expect(lastImport(again.get(), dealId)?.id).toBe(imp);
    await run(again, UndoLastImport, { dealId });
    expect(qs(again, dealId)).toHaveLength(2000);
  }, 240_000);

  it('a deleted deal\'s last import is let go when the journal is pruned', async () => {
    const { store, dealId } = await deal2000();
    const imp = lastImport(store.get(), dealId)!.id;
    await run(store, CreateDeal, { name: 'Wingtip', folders: [] });
    const other = Object.keys(store.get().deals).find((d) => d !== dealId)!; await store.loadDeal(other, { gaps: false });
    await run(store, DeleteDeal, { dealId, typedName: store.get().deals[dealId].name });
    await run(store, CreateQuestion, { dealId: other, text: 'Provide the monthly financial statements for the last 24 months.' });
    const q = qs(store, other)[0];
    for (let i = 0; i < 300; i++) await run(store, EditQuestionField, { dealId: other, questionId: q.id, field: 'workstream', value: i % 2 ? 'Tax' : 'Legal' });
    expect(store.get().ops[imp]).toBeUndefined();
  }, 240_000);

  it('an import refused as storage full keeps its rows, also after a restart, and Retry brings it in whole', async () => {
    const d = disk(); const { store } = make(d); await store.boot(); await run(store, CreateDeal, { name: 'Proseware', folders: [] });
    const dealId = Object.keys(store.get().deals)[0]; await store.loadDeal(dealId, { gaps: false });
    const back = refuse(d.shared, (x) => x.includes('"kind":"question"'), quota, 1);
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rows(2000) })).ok).toBe(false);
    back();
    const failed = Object.values(store.get().ops).find((o) => o.command === 'ImportQuestions')!;
    expect((failed.input as { rows: unknown[] }).rows).toHaveLength(2000);
    const again = make(d).store; await again.boot(); await again.loadDeal(dealId, { gaps: false });
    expect((again.get().ops[failed.id].input as { rows: unknown[] }).rows).toHaveLength(2000);
    await again.retryOp(failed.id);
    expect(qs(again, dealId)).toHaveLength(2000);
    expect(lastImport(again.get(), dealId)?.input).toEqual({ dealId, mode: 'merge' });
  }, 120_000);

  it('the last import stays in the journal while a newer one is still being written', async () => {
    const { store, dealId } = await deal2000();
    const imp = lastImport(store.get(), dealId)!.id;
    const s = store.get(); const pend = { id: 'op_01HZZZZZZZZZZZZZZZZPENDING0', command: 'ImportQuestions', input: { dealId, mode: 'append', rows: rows(5) }, targets: [], baseRevs: {}, dealId, state: 'pending' as const, window: 'w', startedAt: clock.now() };
    (store as unknown as { set(s: unknown): void }).set({ ...s, ops: { ...s.ops, [pend.id]: pend } });
    for (let i = 0; i < 300; i++) await run(store, EditQuestionField, { dealId, questionId: byN(store, dealId, 1 + (i % 50)).id, field: 'workstream', value: i % 2 ? 'Tax' : 'Legal' });
    expect(store.get().ops[imp]).toBeDefined();
  }, 240_000);
});
