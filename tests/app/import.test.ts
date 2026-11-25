import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse, DeleteQuestion, RestoreQuestion, EditQuestionField, SetQuestionStatus } from '../../src/app/commands/questions';
import { CreateFinding, DeleteFinding, RestoreFindingSnapshot } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, CreateQuestion, SetResponse, DeleteQuestion, RestoreQuestion, EditQuestionField, SetQuestionStatus, CreateFinding, DeleteFinding, RestoreFindingSnapshot, ImportQuestions, RevertImport, RestoreQuestionSnapshot];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
function make() {
  const opts = { latency: [0, 0] as [number, number] }; const kv = disk(); const repo = memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, kv, repo };
}
async function deal(store: Store) { await store.boot(); await store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const id = Object.keys(store.get().deals)[0]; await store.loadDeal(id); return id; }
const rowsFrom = (csv: string) => { const t = readCsv(new TextEncoder().encode(csv)); if (!t.ok) throw new Error('csv'); return prepareImport(t.value.rows, suggestMapping(t.value.columns)).rows; };
const byN = (store: Store, dealId: string) => Object.fromEntries(dealQuestions(store.get(), dealId).map((q) => [q.n, q]));

describe('ImportQuestions', () => {
  it('an imported response is recorded as written by the responder the file names; a row that names nobody claims no author', async () => {
    const { store } = make(); const dealId = await deal(store);
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question,Response,Responded by,Date\n1,What is the lock-up?,1.30x,Northwind Sponsor LP,2026-11-02\n2,Who holds the land?,The project company,,\n3,No response yet,,,\n') });
    expect(r.ok).toBe(true);
    const [q1, q2, q3] = dealQuestions(store.get(), dealId); const me = store.get().user!.name;
    expect(q1.respondedBy).toBe('Northwind Sponsor LP'); expect(q1.provenance).toMatchObject({ origin: 'human', actor: 'Northwind Sponsor LP' }); expect(q1.responded).toBe('2026-11-02');
    expect(q2.respondedBy).toBe(''); expect(q2.provenance?.actor).toBe(''); expect(q2.provenance?.actor).not.toBe(me);
    expect(q3.provenance).toBeUndefined();
    // merge: a later file naming a different responder for a changed response moves the authorship with it
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question,Response,Responded by\n1,What is the lock-up?,1.25x from close,Lender counsel\n') });
    const again = dealQuestions(store.get(), dealId)[0];
    expect(again.response).toBe('1.25x from close'); expect(again.respondedBy).toBe('Lender counsel'); expect(again.provenance?.actor).toBe('Lender counsel');
  });

  it('append gives every row a unique number, keeps free ones, and takes status only from the Status column', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'existing' });               // Q1
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question,Response,Status\n2,Lamna,,Closed\n,Coho,Has a response,\n2,Trey,,\n1,Margie,,\n') });
    expect(r.ok).toBe(true);
    const qs = dealQuestions(store.get(), dealId);
    expect(qs.map((q) => q.n)).toEqual([1, 2, 3, 4, 5]); expect(new Set(qs.map((q) => q.id)).size).toBe(5);
    const m = byN(store, dealId);
    expect(m[2]).toMatchObject({ text: 'Lamna', status: 'closed' });
    expect(qs.find((q) => q.text === 'Coho')).toMatchObject({ response: 'Has a response', status: 'open' });   // a response alone does not answer it
  });

  it('merge: a row with no number never takes a number a later row of the file gives, so neither question is lost', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'existing one' }); await store.dispatch(CreateQuestion, { dealId, text: 'existing two' });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question\n,A question with no number\n3,The file\'s own question 3\n') });
    expect(r.ok).toBe(true);
    const m = byN(store, dealId); const texts = dealQuestions(store.get(), dealId).map((q) => q.text);
    expect(texts).toContain('A question with no number'); expect(m[3]?.text).toBe("The file's own question 3"); expect(texts.length).toBe(4);
  });

  it('merge updates only non-empty incoming fields; a second row with the same number is a second question; undo restores all', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question,Response,Workstream\n900,Original question,Original response,Legal\n') });
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question,Response,Workstream\n900,Original question,First response,\n900,Second update,Second response,\n') });
    expect(r.ok).toBe(true);
    const all = dealQuestions(store.get(), dealId);
    expect(all.map((q) => [q.n, q.text, q.response, q.workstream])).toEqual([[900, 'Original question', 'First response', 'Legal'], [900, 'Second update', 'Second response', '']]);
    await store.undo((r as any).value.opId);
    expect(byN(store, dealId)[900]).toMatchObject({ text: 'Original question', response: 'Original response', workstream: 'Legal' });
    expect(dealQuestions(store.get(), dealId).length).toBe(1);
  });

  it('is all-or-nothing: a row that breaks a rule fails the whole file and names the row', async () => {
    const { store } = make(); const dealId = await deal(store);
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question,Status\n1,Fine,Open\n2,Not fine,Answered\n') });
    expect(!r.ok && r.error.message).toMatch(/Row 3: .*response/);
    expect(dealQuestions(store.get(), dealId).length).toBe(0);
  });

  it('a response imported onto a linked question marks the finding, and undoing the import unmarks it and removes created rows', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'x', workstream: 'Legal' }); const f = dealFindings(store.get(), dealId)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'Linked?', linkedFinding: f.id });   // Q1
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question,Response\n1,Linked?,QA response to undo\n5,Brand new,\n') });
    expect(r.ok).toBe(true);
    expect(store.get().findings[f.id].updated).toBe(true);
    expect(dealQuestions(store.get(), dealId).length).toBe(2);
    await store.undo((r as any).value.opId);
    expect(store.get().findings[f.id].updated).toBe(false);
    expect(dealQuestions(store.get(), dealId).map((q) => [q.n, q.response])).toEqual([[1, '']]);
    const au = await repo.audit(f.id);
    expect(au.ok && au.value.filter((a) => a.kind === 'response').length).toBe(1);   // the entry stands in the log, marked undone by the later one
    expect(au.ok && au.value.some((a) => a.kind === 'undone' || a.undoes)).toBe(true);
  });

  it('undo is refused if an imported row was edited afterwards', async () => {
    const { store } = make(); const dealId = await deal(store);
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question\n1,One\n') });
    const q = dealQuestions(store.get(), dealId)[0];
    await store.dispatch(EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'One, edited' });
    const u = await store.undo((r as any).value.opId);
    expect(!u.ok && u.error.message).toMatch(/Changed since/);
    expect(dealQuestions(store.get(), dealId)[0].text).toBe('One, edited');
  });
  it('merge: a cell of only spaces is as good as empty and overwrites nothing; text with spaces around it is another question, as written', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question,Submitted by,Response\n1,One,Lender A,Yes\n') });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question,Submitted by,Response\n1,"   "," ","  "\n2,"   ",,\n') });
    expect(byN(store, dealId)[1]).toMatchObject({ text: 'One', askedBy: 'Lender A', response: 'Yes' });
    expect(byN(store, dealId)[2]).toMatchObject({ text: '   ', response: '' });
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question\n1,"  One\n"\n') });
    expect(byN(store, dealId)[1].text).toBe('One');
    expect(dealQuestions(store.get(), dealId).map((q) => q.text)).toContain('  One\n');
  });
  it('a file that changes nothing writes nothing and leaves nothing to undo', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows: rowsFrom('Number,Question\n1,One\n') });
    const ops = Object.keys(store.get().ops).length;
    const r = await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rowsFrom('Number,Question\n1,One\n') });
    expect(r.ok).toBe(true);
    expect(Object.keys(store.get().ops).length).toBe(ops);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Nothing in the file differs from the log');
  });
});
