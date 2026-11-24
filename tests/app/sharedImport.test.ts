// @vitest-environment node
// The same question list imported on two PCs before they have each other's import: one set of questions, not two.
// Two Stores on two LogRepository installs, the change files carried across by hand, at deal scale (2,000 rows).
import { describe, it, expect } from 'vitest';
import { LogRepository, type Folder } from '../../src/backend/logRepository';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal } from '../../src/app/commands/deals';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { EditQuestionField, RenumberQuestion, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { registry, Undo } from '../../src/app/commands/undo';
import { dealQuestions } from '../../src/app/state';
import '../ui/keptTextSession';
import { deletedOf } from '../../src/ui/deleted';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
function carry(...fs: Mem[]) { for (const a of fs) for (const b of fs) if (a !== b) for (const [n, t] of a.files) { const have = b.files.get(n) ?? ''; if (t.length > have.length) b.files.set(n, t); } }
const COMMANDS: any[] = [CreateDeal, ImportQuestions, RevertImport, EditQuestionField, RenumberQuestion, SetResponse, DeleteQuestion, RestoreQuestion, ResolveConflict, ReopenConflict, Undo];
for (const c of COMMANDS) registry.set(c.name, c);
let idn = 0;
function pc(label: string, user: string, startMin = 0) {
  const shared = new Mem(), local = new Mem(); let tick = 0;
  // each PC's own clock, so the two imports are stamped at different times, as they would be
  const now = () => new Date(Date.UTC(2026, 10, 14, 9, startMin, 0, 0) + (tick++) * 1000).toISOString();
  const repo = new LogRepository({ shared, local, label, user: () => user, clock: now, newId: () => label.replace(/\W/g, '').toLowerCase() });
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec,
    session: {
      load: async () => ({ ok: true as const, value: {
        user: { name: user, initials: 'XX' }, lastSeen: now(), models: [{ id: 'm', name: 'M' }], defaultModel: 'm',
      } }),
    },
    local: new MemoryLocal(),
    clock: { now }, ids: { next: (p: string) => `${p}_01HPRBFXXXXXXXXXXXT${String(idn++).padStart(7, '0')}` } } as any, COMMANDS);
  return { repo, shared, local, store, label };
}
type PC = ReturnType<typeof pc>;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
async function syncAll(...ps: PC[]) { carry(...ps.map((p) => p.shared)); for (const p of ps) await p.repo.sync(); await settle(); }
const PARTIES = ['Lender A', 'Lender B', 'Bidder 1', 'Bidder 2'];
const TOPICS = ['revenue by customer', 'EBITDA adjustments', 'change of control clauses', 'pending litigation', 'pension deficit', 'capex plan', 'working capital peg', 'key employee retention'];
/** a deal-scale list: n rows, each its own wording, number and party; every fifth row with a response */
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `Please provide ${TOPICS[i % TOPICS.length]} for entity ${Math.floor(i / TOPICS.length) + 1}, item ${i + 1}.`, askedBy: PARTIES[i % PARTIES.length],
  received: '2026-11-02', workstream: i % 2 ? 'Legal' : 'Financial', priority: '' as const, response: i % 5 === 0 ? `See data room folder 3.${i}` : '', respondedBy: i % 5 === 0 ? 'Target' : '', responded: '', status: '' as const }));
async function twoPCs() {
  const A = pc('PC A', 'adoe'), B = pc('Laptop', 'bdoe', 7); await A.store.boot(); await B.store.boot();
  const r = await A.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); expect(r.ok).toBe(true); await A.store.settled((r as any).value.opId);
  const dealId = Object.values(A.store.get().deals)[0].id;
  await syncAll(A, B); await A.store.loadDeal(dealId, { gaps: false }); await B.store.loadDeal(dealId, { gaps: false });
  return { A, B, dealId };
}
const run = async (p: PC, cmd: any, input: any) => { const r = await p.store.dispatch(cmd, input); expect(r.ok, JSON.stringify(!r.ok && r.error)).toBe(true); await p.store.settled((r as any).value.opId); return r as any; };
const qs = (p: PC, dealId: string) => dealQuestions(p.store.get(), dealId);
const clashes = (p: PC) => Object.keys(p.store.get().conflicts).length;

describe('the same list imported on two PCs before they sync', () => {
  it('2,000 rows imported on both PCs are 2,000 questions after the files sync, each in one version', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(2000);
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file });
    await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(2000); expect(clashes(p)).toBe(0); expect(new Set(qs(p, dealId).map((q) => q.n)).size).toBe(2000); }
  }, 120_000);

  it('an edit and a renumbering made on one PC after its import stand, with no second version, when the other PC imports the same list', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(2000); file[9] = { ...file[9], n: 9 };     // two rows numbered 9, so one is renumbered
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file });
    const q7 = qs(A, dealId).find((q) => q.n === 7)!, q9 = qs(A, dealId).find((q) => q.n === 9 && q.text === file[9].text)!, q11 = qs(A, dealId).find((q) => q.n === 11)!;
    await run(A, EditQuestionField, { dealId, questionId: q7.id, field: 'text', value: 'Reworded on A' });
    await run(A, RenumberQuestion, { dealId, questionId: q9.id });
    await run(A, SetResponse, { dealId, questionId: q11.id, response: 'Typed on A' });
    await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file });
    await syncAll(A, B);
    for (const p of [A, B]) {
      expect(qs(p, dealId)).toHaveLength(2000); expect(clashes(p)).toBe(0);
      expect(p.store.get().questions[q7.id].text).toBe('Reworded on A');
      expect(p.store.get().questions[q9.id].n).toBe(A.store.get().questions[q9.id].n);
      expect(p.store.get().questions[q11.id].response).toBe('Typed on A');
    }
  }, 120_000);

  it('a change made on each PC to its own copy of the same question is two versions for a person to choose between', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(200);
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file }); await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file });
    const id = qs(A, dealId).find((q) => q.n === 3)!.id; expect(B.store.get().questions[id]).toBeDefined();
    await run(A, EditQuestionField, { dealId, questionId: id, field: 'text', value: 'A’s words' });
    await run(B, EditQuestionField, { dealId, questionId: id, field: 'text', value: 'B’s words' });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(200); expect(Object.keys(p.store.get().conflicts)).toEqual([id]); }
  }, 60_000);

  it('real duplicates within one list stay separate questions, on one PC and after two PCs import it', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(300);
    const dup = { ...file[10] }; const twice = [...file, dup, { ...file[20], n: null }, { ...file[20], n: null }];
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: twice });
    expect(qs(A, dealId)).toHaveLength(303);
    await run(B, ImportQuestions, { dealId, mode: 'merge', rows: twice });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(303); expect(clashes(p)).toBe(0); expect(qs(p, dealId).filter((q) => q.text === dup.text)).toHaveLength(2); }
  }, 60_000);

  it('the same party asking the same words under another number, or another party under the same number, is its own question', async () => {
    const { A, B, dealId } = await twoPCs(); const base = rows(1)[0];
    const file = [base, { ...base, n: 2 }, { ...base, askedBy: 'Lender B' }];
    await run(A, ImportQuestions, { dealId, mode: 'append', rows: file }); await run(B, ImportQuestions, { dealId, mode: 'append', rows: file });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(3); expect(clashes(p)).toBe(0); }
  }, 60_000);

  it('Append on one PC adds every row again, as it always has', async () => {
    const { A, dealId } = await twoPCs(); const file = rows(500);
    await run(A, ImportQuestions, { dealId, mode: 'append', rows: file });
    await run(A, ImportQuestions, { dealId, mode: 'append', rows: file });
    expect(qs(A, dealId)).toHaveLength(1000);
  }, 60_000);

  it('a question deleted on one PC after its import, and brought in again by the other PC unaware, stays deleted and can be restored', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(400);
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file });
    const gone = qs(A, dealId).find((q) => q.n === 5)!;
    await run(A, DeleteQuestion, { dealId, questionId: gone.id });
    await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(399); expect(clashes(p)).toBe(0); expect(p.store.get().tombstones[gone.id]).toBeDefined(); }
    await run(B, RestoreQuestion, { dealId, questionId: gone.id });
    await syncAll(A, B);
    for (const p of [A, B]) expect(qs(p, dealId)).toHaveLength(400);
  }, 60_000);

  it('Undo of an import on one PC takes back only its own copies: the other PC’s import of the same list stands, and the undone ones wait in Recently deleted', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(400);
    const r = await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file });
    await run(B, Undo, { opId: r.value.opId });
    expect(qs(B, dealId)).toHaveLength(0); expect(deletedOf(B.store.get(), dealId)).toHaveLength(400);
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(400); expect(clashes(p)).toBe(0); expect(deletedOf(p.store.get(), dealId)).toHaveLength(0); }
  }, 60_000);

  it('Undo of an import on both PCs leaves no questions, every one restorable', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(300);
    const a = await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file }); const b = await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file });
    await run(A, Undo, { opId: a.value.opId }); await run(B, Undo, { opId: b.value.opId });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(0); expect(clashes(p)).toBe(0); expect(deletedOf(p.store.get(), dealId)).toHaveLength(300); }
    const one = deletedOf(A.store.get(), dealId)[0];
    await run(A, RestoreQuestion, { dealId, questionId: one.id }); await syncAll(A, B);
    for (const p of [A, B]) expect(qs(p, dealId)).toHaveLength(1);
  }, 60_000);

  it('the same list saved with other capitals and final periods makes no choices', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(500);
    const resaved = file.map((r, i) => ({ ...r, text: i % 2 ? r.text.toUpperCase() : r.text.replace(/\.$/, ''), askedBy: i % 3 ? r.askedBy : r.askedBy.toLowerCase() }));
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file }); await run(B, ImportQuestions, { dealId, mode: 'merge', rows: resaved });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(500); expect(clashes(p)).toBe(0); }
    expect(qs(A, dealId).map((q) => q.text).sort()).toEqual(qs(B, dealId).map((q) => q.text).sort());
  }, 60_000);

  it('two PCs that number the same imported rows differently end with one question each, not a choice per row', async () => {
    const { A, B, dealId } = await twoPCs();
    const lenderA = rows(200).map((r) => ({ ...r, askedBy: 'Lender A' }));
    const lenderB = rows(200).map((r) => ({ ...r, askedBy: 'Lender B', text: `Confirm whether lease ${r.n} at site ${r.n * 7} renews automatically.` }));   // wording unlike Lender A's, so merge never reads it as theirs
    const loose = rows(50).map((r) => ({ ...r, n: null, askedBy: 'Bidder 1', text: `Unnumbered: ${r.text}` }));
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: lenderA });         // only A has Lender A's list: its numbers 1-200 are taken there
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: lenderB }); await run(B, ImportQuestions, { dealId, mode: 'merge', rows: lenderB });
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: loose }); await run(B, ImportQuestions, { dealId, mode: 'merge', rows: loose });
    const edited = qs(B, dealId).find((q) => q.text === lenderB[4].text)!;
    await run(B, EditQuestionField, { dealId, questionId: edited.id, field: 'workstream', value: 'Typed on B' });
    await syncAll(A, B);
    for (const p of [A, B]) {
      expect(qs(p, dealId)).toHaveLength(450); expect(clashes(p)).toBe(0);
      // the higher numbers stood, so no unchanged question holds a number twice; the one B edited keeps B's number (5), which
      // Lender A's question 5 also holds: marked "Same number" for a person to renumber, as any shared number is
      const held = qs(p, dealId).filter((q) => q.n === p.store.get().questions[edited.id].n);
      expect(new Set(qs(p, dealId).map((q) => q.n)).size).toBe(449); expect(held.map((q) => q.askedBy).sort()).toEqual(['Lender A', 'Lender B']);
      expect(p.store.get().questions[edited.id].workstream).toBe('Typed on B');
    }
    expect(qs(A, dealId).map((q) => [q.id, q.n]).sort()).toEqual(qs(B, dealId).map((q) => [q.id, q.n]).sort());
  }, 120_000);

  it('Undo of an import on one PC leaves the other PC’s import whole, its typed responses included, at deal scale', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(2000);
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file });
    const typed = qs(A, dealId).slice(0, 20);
    for (const q of typed) await run(A, SetResponse, { dealId, questionId: q.id, response: `Typed on A for Q${q.n}` });
    const r = await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file }); await run(B, Undo, { opId: r.value.opId });
    await syncAll(A, B);
    for (const p of [A, B]) {
      expect([qs(p, dealId).length, clashes(p), deletedOf(p.store.get(), dealId).length]).toEqual([2000, 0, 0]);
      for (const q of typed) expect(p.store.get().questions[q.id].response).toBe(`Typed on A for Q${q.n}`);
    }
  }, 120_000);

  it('after an Undo the other PC’s import outlives, the questions carry no deletion: they can be deleted, and a re-import calls none restored', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(50);
    await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file });
    const r = await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file }); await run(B, Undo, { opId: r.value.opId });
    await syncAll(A, B);
    for (const p of [A, B]) expect(Object.keys(p.store.get().tombstones)).toHaveLength(0);
    const id = qs(A, dealId)[0].id; await run(A, DeleteQuestion, { dealId, questionId: id }); await run(B, DeleteQuestion, { dealId, questionId: qs(B, dealId)[1].id });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(qs(p, dealId)).toHaveLength(48); expect(deletedOf(p.store.get(), dealId)).toHaveLength(2); expect(clashes(p)).toBe(0); }
    const again = await run(A, ImportQuestions, { dealId, mode: 'merge', rows: [{ ...file[5], workstream: 'Tax' }] });
    expect(A.store.get().questions[qs(A, dealId).find((q) => q.text === file[5].text)!.id].workstream).toBe('Tax'); expect(again.value).toBeDefined();
  }, 60_000);

  it('a person’s deletion of a copy they typed into stands over the other PC’s import Undo, so what they typed can be restored', async () => {
    const { A, B, dealId } = await twoPCs(); const file = rows(300);
    await run(B, ImportQuestions, { dealId, mode: 'merge', rows: file });
    const q4 = qs(B, dealId).find((q) => q.n === 4)!;
    await run(B, SetResponse, { dealId, questionId: q4.id, response: 'Typed on B' }); await run(B, DeleteQuestion, { dealId, questionId: q4.id });
    const r = await run(A, ImportQuestions, { dealId, mode: 'merge', rows: file }); await run(A, Undo, { opId: r.value.opId });
    await syncAll(A, B);
    for (const p of [A, B]) { expect(clashes(p)).toBe(0); expect(deletedOf(p.store.get(), dealId).find((t) => t.id === q4.id)).toBeDefined(); }
    await run(A, RestoreQuestion, { dealId, questionId: q4.id }); await syncAll(A, B);
    for (const p of [A, B]) expect(p.store.get().questions[q4.id].response).toBe('Typed on B');
  }, 60_000);
});
