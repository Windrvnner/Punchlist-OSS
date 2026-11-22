// @vitest-environment node
// Undo checks each record it wrote or removed by kind and id: a tombstone shares its record's id.
import { describe, it, expect } from 'vitest';
import { LogRepository, type Folder } from '../../src/backend/logRepository';
import { Combined, type Line } from '../../src/backend/changeLog';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, UseAsResponse } from '../../src/app/commands/questions';
import { RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { registry, Undo } from '../../src/app/commands/undo';
import { dealQuestions } from '../../src/app/state';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
function carry(...fs: Mem[]) { for (const a of fs) for (const b of fs) if (a !== b) for (const [n, t] of a.files) { const have = b.files.get(n) ?? ''; if (t.length > have.length) b.files.set(n, t); } }
const COMMANDS: any[] = [CreateDeal, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RestoreQuestionSnapshot, UseAsResponse, ResolveConflict, ReopenConflict, Undo];
for (const c of COMMANDS) registry.set(c.name, c);
let idn = 0;
function pc(label: string, user: string, skewMs = 0) {
  const shared = new Mem(), local = new Mem(); let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 12, 9, 0, 0, 0) + skewMs + (tick++) * 1000).toISOString();
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


async function oneQuestion(A: PC) {
  await A.store.boot(); await A.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(A.store.get().deals)[0]; await A.store.loadDeal(dealId, { gaps: false });
  await A.store.dispatch(CreateQuestion, { dealId, text: 'Is there a decommissioning bond?' }); return { dealId, qid: dealQuestions(A.store.get(), dealId)[0].id };
}

describe('Undo across a record and its tombstone', () => {
  it('refuses to undo an older delete after another person restored the question, answered it and deleted it again', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    const { dealId, qid } = await oneQuestion(A);
    const del1 = await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid }); expect(del1.ok).toBe(true); const op1 = (del1 as any).value.opId;
    carry(A.shared, B.shared); await B.store.boot(); await B.store.loadDeal(dealId, { gaps: false }); await settle();
    expect((await B.store.dispatch(RestoreQuestion, { dealId, questionId: qid })).ok).toBe(true);
    expect((await B.store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Bond issued March 3.' })).ok).toBe(true);
    expect((await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid })).ok).toBe(true);
    await syncAll(A, B);
    expect(A.store.get().questions[qid]).toBeUndefined();
    const u = await A.store.dispatch(Undo, { opId: op1 });
    expect(u.ok).toBe(false);
    expect(!u.ok && u.error.message).toBe('Changed since — undo refused');
    expect(A.store.get().questions[qid]).toBeUndefined();                      // sroe's later delete stands
  });

  it('refuses to undo a delete after the question was restored elsewhere, and still undoes a delete nobody has touched', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    const { dealId, qid } = await oneQuestion(A);
    await A.store.dispatch(CreateQuestion, { dealId, text: 'Provide the executed EPC contract.' });
    const q2 = dealQuestions(A.store.get(), dealId).find((q) => q.id !== qid)!.id;
    const del1 = await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid }); const op1 = (del1 as any).value.opId;
    const del2 = await A.store.dispatch(DeleteQuestion, { dealId, questionId: q2 }); const op2 = (del2 as any).value.opId;
    carry(A.shared, B.shared); await B.store.boot(); await B.store.loadDeal(dealId, { gaps: false }); await settle();
    expect((await B.store.dispatch(RestoreQuestion, { dealId, questionId: qid })).ok).toBe(true);
    await syncAll(A, B);
    expect(A.store.get().questions[qid]).toBeDefined();
    const u1 = await A.store.dispatch(Undo, { opId: op1 });
    expect(!u1.ok && u1.error.message).toBe('Changed since — undo refused');     // already back: undoing the delete again would fail or double up
    const u2 = await A.store.dispatch(Undo, { opId: op2 });
    expect(u2.ok).toBe(true); expect(A.store.get().questions[q2]).toBeDefined();
  });

  it('refuses to undo a restore after the question was deleted again elsewhere', async () => {
    const A = pc('PC A', 'adoe'), B = pc('PC B', 'sroe');
    const { dealId, qid } = await oneQuestion(A);
    await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid });
    const back = await A.store.dispatch(RestoreQuestion, { dealId, questionId: qid }); const op = (back as any).value.opId;
    carry(A.shared, B.shared); await B.store.boot(); await B.store.loadDeal(dealId, { gaps: false }); await settle();
    expect((await B.store.dispatch(DeleteQuestion, { dealId, questionId: qid })).ok).toBe(true);
    await syncAll(A, B);
    const u = await A.store.dispatch(Undo, { opId: op });
    expect(!u.ok && u.error.message).toBe('Changed since — undo refused');
  });

  it('still undoes a delete after the deal is read again from the shared folder', async () => {
    const A = pc('PC A', 'adoe');
    const { dealId, qid } = await oneQuestion(A);
    const del = await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid }); const op = (del as any).value.opId;
    await A.repo.sync(); await A.store.loadDeal(dealId, { gaps: false }); await settle();
    const u = await A.store.dispatch(Undo, { opId: op });
    expect(u.ok).toBe(true); expect(A.store.get().questions[qid]).toBeDefined();
  });

  it('refuses an Undo whose operation wrote a kind this build does not keep, rather than undo it unchecked', async () => {
    const A = pc('PC A', 'adoe');
    const { dealId, qid } = await oneQuestion(A);
    const del = await A.store.dispatch(DeleteQuestion, { dealId, questionId: qid }); const op = (del as any).value.opId;
    const o = A.store.get().ops[op]; (A.store as any).state = { ...A.store.get(), ops: { ...A.store.get().ops, [op]: { ...o, results: { ...o.results, [`decision/g_${qid}`]: { rev: 1, at: '2026-11-12T09:00:00.000Z' } } } } };
    const u = await A.store.dispatch(Undo, { opId: op });
    expect(!u.ok && u.error.message).toBe('This action cannot be undone on this version of Punchlist');
  });
});
