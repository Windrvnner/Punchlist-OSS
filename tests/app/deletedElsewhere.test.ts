// @vitest-environment node
// A deal deleted on one PC while another has changes to it that have not arrived (choice A): the
// delete stands, and the other PC keeps everything it had as "<name> (recovered)", with a notice that stays until it is
// closed, saying who deleted the original. Two Stores on two LogRepository installs, the change files carried across by
// hand, at deal scale (2,000 questions, 120 findings, the firm's checklist).
import { describe, it, expect } from 'vitest';
import { LogRepository, DEAL_GONE, DEAL_DELETED, type Folder } from '../../src/backend/logRepository';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal, DeleteDeal } from '../../src/app/commands/deals';
import { AddDealItems } from '../../src/app/commands/checklist';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { CreateQuestion, EditQuestionField, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding } from '../../src/app/commands/findings';
import { ResolveConflict } from '../../src/app/commands/conflicts';
import { registry, Undo } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { recoveredName, recoveredNotice } from '../../src/app/recovered';
import { remap, recoveredId } from '../../src/domain/recovered';
import { DEAL_NAME_MAX, EditDeal } from '../../src/app/commands/deals';
import type { Source } from '../../src/domain/model';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
/** OneDrive between the PCs given: each file goes to the others, the longer copy winning (files only grow) */
function carry(...fs: Mem[]) { for (const a of fs) for (const b of fs) if (a !== b) for (const [n, t] of a.files) { const have = b.files.get(n) ?? ''; if (t.length > have.length) b.files.set(n, t); } }
const COMMANDS: any[] = [CreateDeal, DeleteDeal, AddDealItems, ImportQuestions, CreateQuestion, EditQuestionField, SetResponse, DeleteQuestion, RestoreQuestion, CreateFinding, EditFinding, ResolveConflict, Undo, EditDeal];
for (const c of COMMANDS) registry.set(c.name, c);
let idn = 0;
function pc(label: string, user: string, startMin = 0, disk?: { shared: Mem; local: Mem; id: string; win?: MemoryLocal }) {
  const shared = disk?.shared ?? new Mem(), local = disk?.local ?? new Mem(), win = disk?.win ?? new MemoryLocal(); let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 17, 9, startMin, 0, 0) + (tick++) * 1000).toISOString();
  const id = disk?.id ?? label.replace(/\W/g, '').toLowerCase();
  const repo = new LogRepository({ shared, local, label, user: () => user, clock: now, newId: () => id });
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec,
    session: {
      load: async () => ({ ok: true as const, value: {
        user: { name: user, initials: 'XX' }, lastSeen: now(), models: [{ id: 'm', name: 'M' }], defaultModel: 'm',
      } }),
    },
    local: win,
    clock: { now }, ids: { next: (p: string) => `${p}_01HPRBFXXXXXXXXXXXT${String(idn++).padStart(7, '0')}` } } as any, COMMANDS);
  return { repo, shared, local, win, store, label, id, user };
}
type PC = ReturnType<typeof pc>;
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };
async function syncAll(...ps: PC[]) { carry(...ps.map((p) => p.shared)); for (const p of ps) await p.repo.sync(); await settle(); }
/** wait until `ok` holds (the copy is made in the background, after the sync state is read) */
async function until(ok: () => boolean, what: string) { for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5)); expect(ok(), what).toBe(true); }
const run = async (p: PC, cmd: any, input: any) => { const r = await p.store.dispatch(cmd, input, { quiet: true }); expect(r.ok, JSON.stringify(!r.ok && r.error)).toBe(true); await p.store.settled((r as any).value.opId); return r as any; };
const PARTIES = ['Lender A', 'Lender B', 'Bidder 1', 'Bidder 2'];
const TOPICS = ['revenue by customer', 'EBITDA adjustments', 'change of control clauses', 'pending litigation', 'pension deficit', 'capex plan', 'working capital peg', 'key employee retention'];
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i + 1, text: `Please provide ${TOPICS[i % TOPICS.length]} for entity ${Math.floor(i / TOPICS.length) + 1}, item ${i + 1}.`, askedBy: PARTIES[i % PARTIES.length],
  received: '2026-11-02', workstream: i % 2 ? 'Legal' : 'Financial', priority: '' as const, response: i % 5 === 0 ? `See data room folder 3.${i}` : '', respondedBy: i % 5 === 0 ? 'Target' : '', responded: '', status: '' as const }));
const EPC: Source = { doc: 'EPC contract.pdf', loc: 'p. 80', docId: 'doc_epc' };
const ITEMS = ['Interconnection agreement signed', 'Land lease term covers the asset life', 'EPC liability cap at least 20% of contract price', 'O&M contract in place', 'Insurance program reviewed by advisor'];

/** Two PCs with one deal of `questions` imported questions, `findings` findings and the checklist items, synced. B is the PC that goes offline. */
async function world(o: { questions?: number; findings?: number } = {}) {
  const A = pc('PC A', 'adoe'), B = pc('PC B', 'bdoe', 7); await A.store.boot(); await B.store.boot();
  const r = await run(A, CreateDeal, { name: 'Proseware', folders: [{ path: 'X:\\Deals\\Proseware\\VDR', label: 'Data room', files: 412, size: '1.2 GB' }] });
  const dealId = A.store.get().ops[r.value.opId].targets[0] ?? Object.values(A.store.get().deals)[0].id;
  await A.store.loadDeal(dealId, { gaps: false });
  await run(A, AddDealItems, { dealId, items: ITEMS.map((text) => ({ text, from: [{ layer: 'broad', value: '' }] })) });
  if (o.questions) await run(A, ImportQuestions, { dealId, mode: 'append', rows: rows(o.questions) });
  for (let i = 0; i < (o.findings ?? 0); i++) await run(A, CreateFinding, { dealId, title: `${TOPICS[i % TOPICS.length]} ${i + 1}`, workstream: 'Legal', body: [`The ${TOPICS[i % TOPICS.length]} needs a closer look. [1]`], sources: [EPC], origin: 'chat' });
  await syncAll(A, B); await A.store.loadDeal(dealId, { gaps: false }); await B.store.loadDeal(dealId, { gaps: false });
  return { A, B, dealId };
}
const copyOf = (p: PC) => Object.values(p.store.get().deals).find((d) => d.name.endsWith('(recovered)'));

describe('a deal deleted on one PC while another has changes to it that have not arrived', () => {
  it('the other PC keeps everything it had as "<name> (recovered)", says who deleted the original, and the delete stands everywhere else', async () => {
    const { A, B, dealId } = await world({ questions: 30, findings: 6 });
    // B works offline: 50 new questions and a response; none of it reaches A
    for (let i = 0; i < 50; i++) await run(B, CreateQuestion, { dealId, text: `Offline question ${i + 1}: confirm the ${TOPICS[i % TOPICS.length]} position.` });
    const first = dealQuestions(B.store.get(), dealId)[0];
    await run(B, SetResponse, { dealId, questionId: first.id, response: 'Typed on the laptop on the train.' });
    const finding = dealFindings(B.store.get(), dealId)[0];
    await run(B, EditFinding, { dealId, findingId: finding.id, title: finding.title, workstream: finding.workstream,
      body: ['Checked with counsel on Tuesday.'] });
    // A deletes the deal (both pop-ups), then the files sync
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B);
    await until(() => !!copyOf(B), 'B has the copy');
    const copy = copyOf(B)!;
    expect(copy.name).toBe('Project Proseware (recovered)'); expect(copy.id).not.toBe(dealId);
    expect(B.store.get().deals[dealId]).toBeUndefined();                          // the original is deleted here too
    await B.store.loadDeal(copy.id, { gaps: false });
    const qs = dealQuestions(B.store.get(), copy.id);
    expect(qs).toHaveLength(80);                                                   // the 30 imported and the 50 made offline
    expect(qs.find((q) => q.n === first.n)!.response).toBe('Typed on the laptop on the train.');
    expect(new Set(qs.map((q) => q.n)).size).toBe(80);                             // numbers kept as they were
    const fs = dealFindings(B.store.get(), copy.id); expect(fs).toHaveLength(6);
    expect(fs.find((f) => f.title === finding.title)!.body).toEqual(['Checked with counsel on Tuesday.']);
    expect(Object.values(B.store.get().items).filter((i) => i.dealId === copy.id).map((i) => i.text).sort()).toEqual([...ITEMS].sort());
    // the copy is in B's person's list, and its folders are kept, to be indexed again
    expect(B.store.get().members[`m_${copy.id}_bdoe`]?.on).toBe(true);
    expect(copy.folders.map((f) => [f.path, f.indexed])).toEqual([['X:\\Deals\\Proseware\\VDR', 0]]);
    // the notice names who deleted it and where the work is; it stays until closed, even past later changes
    const note = B.store.get().ui.toasts.find((t) => t.text.startsWith('adoe deleted Project Proseware'))!;
    expect(note.text).toBe('adoe deleted Project Proseware · a copy is kept here'); expect(note.action).toBeUndefined();
    expect(note.sticky && note.stays).toBe(true);
    await run(B, CreateQuestion, { dealId: copy.id, text: 'A question on the copy' });
    expect(B.store.get().ui.toasts.some((t) => t.id === note.id)).toBe(true);
    B.store.dismissToast(note.id); expect(B.store.get().ui.toasts.some((t) => t.id === note.id)).toBe(false);
    // A: the original stays deleted; the copy reaches it as a deal of its own, which is B's person's to keep or delete
    await syncAll(A, B);
    expect(A.store.get().deals[dealId]).toBeUndefined();
    expect(A.store.get().deals[copy.id]?.name).toBe('Project Proseware (recovered)');
    expect(copyOf(A)).toBeDefined(); expect(A.store.get().ui.toasts.some((t) => t.text.includes('a copy is kept here'))).toBe(false);   // nothing is kept or said on A
    // B's person deletes the copy: it is gone for good, and not made again
    await run(B, DeleteDeal, { dealId: copy.id, typedName: 'Project Proseware (recovered)' });
    await syncAll(A, B); await settle();
    expect(copyOf(B)).toBeUndefined(); expect(copyOf(A)).toBeUndefined();
  });

  it('nothing is kept when the deleting PC had seen every change: the delete is final, as decided', async () => {
    const { A, B, dealId } = await world({ questions: 20 });
    await run(B, CreateQuestion, { dealId, text: 'Asked on the laptop before the sync' });
    await syncAll(A, B);                                                           // A has it before it deletes
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await settle(); await new Promise((r) => setTimeout(r, 50));
    expect(B.store.get().deals[dealId]).toBeUndefined(); expect(copyOf(B)).toBeUndefined();
    expect(B.store.get().sync?.unseen).toBeUndefined();
  });

  it('adding the deal to a list is not work on it, and the PC that deleted it never keeps a copy', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await new Promise((r) => setTimeout(r, 50));
    expect(copyOf(A)).toBeUndefined(); expect(copyOf(B)).toBeUndefined();
  });

  it('a change saved here just as the delete arrives is kept in the copy, and so is one saved after the copy is made', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    const q = dealQuestions(B.store.get(), dealId)[0];
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared); await B.repo.sync();                                // the delete is here; the window may not have caught up
    const r = await B.repo.transaction({ writes: [{ kind: 'question', id: q.id, data: { ...q, response: 'Typed as the delete arrived' }, expectedRev: q.rev }] });
    expect(r.ok).toBe(true);
    await B.repo.sync(); await until(() => !!copyOf(B), 'B has the copy');
    await B.store.loadDeal(copyOf(B)!.id, { gaps: false });
    expect(dealQuestions(B.store.get(), copyOf(B)!.id).find((x) => x.n === q.n)!.response).toBe('Typed as the delete arrived');
    // a save still on its way to the deleted deal goes to the copy: only what it changed
    const late = await B.repo.transaction({ writes: [{ kind: 'question', id: q.id, data: { ...q, response: 'Typed after the copy' }, expectedRev: q.rev }] });
    expect(late.ok).toBe(true);
    const inCopy = await B.repo.get(
      'question',
      ((await B.repo.recover(dealId, { name: 'x', person: 'bdoe' })) as any).value.ids[q.id],
    );
    expect((inCopy as any).value.envelope.data).toMatchObject({ response: 'Typed after the copy', dealId: copyOf(B)!.id });
    // and on the PC that deleted it, nothing more is written to the deal
    const there = await A.repo.transaction({ writes: [{ kind: 'question', id: q.id, data: { ...q, response: 'After my own delete' }, expectedRev: null }] });
    expect(!there.ok && there.error.message).toBe(DEAL_GONE);
  });

  it('a version brought back beside the record, landing after the copy is made, is refused and leaves the copy as it was', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    const q = dealQuestions(B.store.get(), dealId)[0];
    await run(B, SetResponse, { dealId, questionId: q.id, response: 'Current words in B' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared); await B.repo.sync(); await until(() => !!copyOf(B), 'B has the copy');
    const had = dealQuestions(B.store.get(), dealId).find((x) => x.id === q.id) ?? q;
    const late = await B.repo.transaction({ writes: [{ kind: 'question', id: q.id, data: { ...had, response: 'Restored old words' }, expectedRev: 'any', beside: true }] });
    expect(!late.ok && late.error.message).toBe(DEAL_DELETED);
    const inCopy = await B.repo.get(
      'question',
      ((await B.repo.recover(dealId, { name: 'x', person: 'bdoe' })) as any).value.ids[q.id],
    );
    expect((inCopy as any).value.envelope.data.response).toBe('Current words in B');
  });

  it('two saves in a row as the delete arrives, the copy made between them: both are in the copy', async () => {
    const { A, B, dealId } = await world({ questions: 50, findings: 5 });
    await run(B, CreateQuestion, { dealId, text: 'Unseen at the office' });
    const q = dealQuestions(B.store.get(), dealId)[3];
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared);                                                     // in the folder; the window has not caught up
    const [r1, r2] = await Promise.all([B.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'first' }, { quiet: true }),
      B.store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'first and second' }, { quiet: true })]);
    expect([r1.ok, r2.ok]).toEqual([true, true]);
    await until(() => !!copyOf(B), 'B has the copy'); await settle();
    const copy = copyOf(B)!; await B.store.loadDeal(copy.id, { gaps: false });
    expect(dealQuestions(B.store.get(), copy.id).find((x) => x.n === q.n)!.response).toBe('first and second');
  });

  it('a change that reaches the deleting PC while its delete is being asked, unseen there, is kept', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    const q = dealQuestions(B.store.get(), dealId)[1];
    await run(B, SetResponse, { dealId, questionId: q.id, response: 'Typed on the laptop' });
    carry(A.shared, B.shared);                                                     // in A's folder; A has not looked yet
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy');
    await B.store.loadDeal(copyOf(B)!.id, { gaps: false });
    expect(dealQuestions(B.store.get(), copyOf(B)!.id).find((x) => x.n === q.n)!.response).toBe('Typed on the laptop');
  });

  it('at deal scale, work that the deleting PC takes in by itself while its person confirms the delete is kept', async () => {
    const { A, B, dealId } = await world({ questions: 2000, findings: 120 });
    const qs = dealQuestions(B.store.get(), dealId);
    // the person on A opens the first pop-up: what A has taken in now is what they had in front of them
    A.store.ui({ deleteDeal: { dealId, typed: '', error: '', seen: (await A.repo.seen() as any).value } });
    await run(B, SetResponse, { dealId, questionId: qs[10].id, response: 'Arrived by the background look' });
    carry(A.shared, B.shared); await A.repo.sync(); await settle();               // A's look at the folder takes it in, and its window shows it
    expect(A.store.get().questions[qs[10].id].response).toBe('Arrived by the background look');
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware', seen: A.store.get().ui.deleteDeal!.seen });
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy');
    const copy = copyOf(B)!; await B.store.loadDeal(copy.id, { gaps: false });
    const cq = dealQuestions(B.store.get(), copy.id); expect(cq).toHaveLength(2000);
    expect(cq.find((x) => x.n === qs[10].n)!.response).toBe('Arrived by the background look');
    expect(dealFindings(B.store.get(), copy.id)).toHaveLength(120);
    expect(copyOf(A)).toBeUndefined(); expect(A.store.get().deals[dealId]).toBeUndefined();
  }, 120000);

  it('work the deleting PC had taken in before its person began deleting is seen: nothing is kept', async () => {
    const { A, B, dealId } = await world({ questions: 20 });
    await run(B, SetResponse, { dealId, questionId: dealQuestions(B.store.get(), dealId)[2].id, response: 'Seen at the office' });
    await syncAll(A, B);
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware', seen: (await A.repo.seen() as any).value });
    await syncAll(A, B); await settle();
    expect(copyOf(B)).toBeUndefined();
  });

  it('the notice is back after the app is started again, until the person closes it', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    await run(B, CreateQuestion, { dealId, text: 'Unseen at the office' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy');
    const notice = 'adoe deleted Project Proseware · a copy is kept here';
    expect(B.store.get().ui.toasts.map((t) => t.text)).toContain(notice);
    const again = async () => { const p = pc(B.label, B.user, 7, { shared: B.shared, local: B.local, id: B.id, win: B.win }); await p.store.boot(); await settle(); return p; };
    const B2 = await again();
    const shown = B2.store.get().ui.toasts.find((t) => t.text === notice)!;
    expect(shown.stays).toBe(true);
    B2.store.dismissToast(shown.id);
    expect((await again()).store.get().ui.toasts.map((t) => t.text)).not.toContain(notice);
  });

  it('while nobody is signed in on the other PC, its copy is still made there, with the notice, and nothing new can be changed', async () => {
    const { A, B, dealId } = await world({ questions: 20 });
    const q = dealQuestions(B.store.get(), dealId)[4];
    await run(B, SetResponse, { dealId, questionId: q.id, response: 'Typed before signing out' });
    (B.store as any).set({ ...B.store.get(), signin: { out: true, sso: true, apiKey: false } });   // read-only from here
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy while signed out');
    expect(B.store.get().ui.toasts.map((t) => t.text)).toContain('adoe deleted Project Proseware · a copy is kept here');
    const copy = copyOf(B)!; await B.store.loadDeal(copy.id, { gaps: false });
    expect(dealQuestions(B.store.get(), copy.id).find((x) => x.n === q.n)!.response).toBe('Typed before signing out');
    const r = await B.store.dispatch(DeleteDeal, { dealId: copy.id, typedName: copy.name }, { quiet: true });
    expect(r.ok).toBe(false);                                                      // Delete waits for sign-in, as every change does
  });

  it('a save still on its way does not bring back a question deleted in the copy', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    await run(B, CreateQuestion, { dealId, text: 'Unseen at the office' });
    const q = dealQuestions(B.store.get(), dealId)[0];
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy');
    const copy = copyOf(B)!; await B.store.loadDeal(copy.id, { gaps: false });
    const cq = dealQuestions(B.store.get(), copy.id).find((x) => x.n === q.n)!;
    await run(B, DeleteQuestion, { dealId: copy.id, questionId: cq.id });
    const late = await B.repo.transaction({ writes: [{ kind: 'question', id: q.id, data: { ...q, response: 'Late' }, expectedRev: q.rev }] });
    expect(late.ok).toBe(false);
    expect(dealQuestions(B.store.get(), copy.id).find((x) => x.n === q.n)).toBeUndefined();
  });

  it('an edit to the deal itself as the delete arrives is kept in the copy', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared);
    const r = await B.store.dispatch(EditDeal, { dealId, counterparty: 'Typed counterparty' }, { quiet: true });
    expect(r.ok).toBe(true);
    await B.repo.sync(); await until(() => !!copyOf(B), 'B has the copy');
    expect(copyOf(B)!.counterparty).toBe('Typed counterparty');
    // the deal stays deleted where it was deleted
    await syncAll(A, B); expect(A.store.get().deals[dealId]).toBeUndefined();
  });

  it('two versions of the deal nobody had chosen between both come to the copy, as a choice', async () => {
    const { A, B, dealId } = await world({ questions: 5 });
    const C = pc('Second desktop', 'cdoe', 40);
    await C.store.boot();
    await syncAll(A, B, C);
    await C.store.loadDeal(dealId, { gaps: false });
    await run(B, EditDeal, { dealId, counterparty: 'B counterparty' });
    await run(C, EditDeal, { dealId, counterparty: 'C counterparty' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared, C.shared); await B.repo.sync(); await C.repo.sync();
    await until(() => !!copyOf(B), 'B has the copy');
    const got = await B.repo.get('deal', copyOf(B)!.id);
    expect(((got as any).value.conflict ?? []).map((v: any) => v.data.counterparty).sort()).toEqual(['B counterparty', 'C counterparty']);
  });

  it('a delete beside an edit stays a choice in the copy, never undone by it', async () => {
    const { A, B, dealId } = await world({ questions: 10 });
    const q = dealQuestions(B.store.get(), dealId)[4];
    await run(A, EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'Edited at the office' });
    await run(B, DeleteQuestion, { dealId, questionId: q.id });
    await syncAll(A, B); expect(B.store.get().conflicts[q.id]).toBeDefined();
    await run(B, CreateQuestion, { dealId, text: 'Offline question' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy');
    const copy = copyOf(B)!; await B.store.loadDeal(copy.id, { gaps: false });
    const clash = Object.values(B.store.get().conflicts).find((c) => c.dealId === copy.id)!;
    expect(clash.versions.map((v) => (v.deleted ? 'deleted' : (v.data as { text: string }).text)).sort()).toEqual(['Edited at the office', 'deleted']);
  });

  it('a question with two versions nobody had chosen between keeps both in the copy', async () => {
    const { A, B, dealId } = await world({ questions: 10 });
    const q = dealQuestions(B.store.get(), dealId)[3];
    await run(A, EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'Reworded at the office' });
    await run(B, EditQuestionField, { dealId, questionId: q.id, field: 'text', value: 'Reworded on the laptop' });
    await syncAll(A, B); expect(B.store.get().conflicts[q.id]).toBeDefined();
    await run(B, SetResponse, { dealId, questionId: dealQuestions(B.store.get(), dealId)[0].id, response: 'Offline answer' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy');
    const copy = copyOf(B)!; await B.store.loadDeal(copy.id, { gaps: false });
    const clash = Object.values(B.store.get().conflicts).find((c) => c.dealId === copy.id)!;
    expect(clash.versions.map((v) => (v.data as { text: string }).text).sort()).toEqual(['Reworded at the office', 'Reworded on the laptop']);
  });

  it('three PCs: each with changes the deleting PC had not seen keeps its own copy; the deal is never made twice on one PC, also after a restart', async () => {
    const { A, B, dealId } = await world({ questions: 10 });
    const C = pc('Second desktop', 'cdoe', 3);
    await C.store.boot();
    await syncAll(A, B, C);
    await C.store.loadDeal(dealId, { gaps: false });
    await run(B, CreateQuestion, { dealId, text: 'From the laptop' });
    await run(C, CreateQuestion, { dealId, text: 'From the second desktop' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared); carry(A.shared, C.shared); await B.repo.sync(); await C.repo.sync();
    await until(() => !!copyOf(B) && !!copyOf(C), 'both keep a copy');
    expect(copyOf(B)!.id).not.toBe(copyOf(C)!.id);
    // B starts again on the same disk: the copy is not made again
    const B2 = pc('PC B', 'bdoe', 30, { shared: B.shared, local: B.local, id: B.id });
    await B2.store.boot();
    await B2.repo.sync();
    await settle();
    await new Promise((r) => setTimeout(r, 50));
    expect(Object.values(B2.store.get().deals).filter((d) => d.name.endsWith('(recovered)'))).toHaveLength(1);
    expect(B2.store.get().ui.toasts).toEqual([]);
  });

  it('a copy cut off between its two writes is finished at the next try, without a second set of records', async () => {
    const { A, B, dealId } = await world({ questions: 40 });
    await run(B, CreateQuestion, { dealId, text: 'From the laptop' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared);
    // the write of the copy itself fails (the drive dropped); its records were written
    const append = B.shared.append.bind(B.shared); let refused = 0;
    B.shared.append = (n, t) => { if (/"kind":"deal","id":"d_/.test(t) && t.includes('(recovered)')) { refused++; throw new Error('EIO'); } append(n, t); };
    const first = await B.repo.recover(dealId, { name: 'Project Proseware (recovered)', person: 'bdoe' });
    expect(first.ok).toBe(false); expect(refused).toBe(1);
    B.shared.append = append;
    const again = await B.repo.recover(dealId, { name: 'Project Proseware (recovered)', person: 'bdoe' });
    expect(again.ok).toBe(true);
    const lines = [...B.shared.files].filter(([n]) => n.startsWith('changes-pcb-')).flatMap(([, t]) => t.split('\n').filter(Boolean));
    expect(lines.filter((l) => l.includes('"index":{"dealId":"' + recoveredId(dealId, 'pcb'))).length).toBe(1);   // the records once
    await B.repo.sync(); await settle();
    const copy = await B.repo.list('question', recoveredId(dealId, 'pcb'));
    expect(copy.ok && copy.value.length).toBe(41);
  });

  it('a change saved between a cut-off copy and its next try is in the copy', async () => {
    const { A, B, dealId } = await world({ questions: 40 });
    await run(B, CreateQuestion, { dealId, text: 'From the laptop' });
    const q = dealQuestions(B.store.get(), dealId)[5];
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    carry(A.shared, B.shared);
    const append = B.shared.append.bind(B.shared);
    B.shared.append = (n, t) => { if (t.includes('(recovered)')) throw new Error('EIO'); append(n, t); };
    expect((await B.repo.recover(dealId, { name: 'Project Proseware (recovered)', person: 'bdoe' })).ok).toBe(false);
    const w = await B.repo.transaction({ writes: [{ kind: 'question', id: q.id, data: { ...q, response: 'Typed between the tries' }, expectedRev: q.rev }] });
    expect(w.ok).toBe(true);
    B.shared.append = append;
    const again = await B.repo.recover(dealId, { name: 'Project Proseware (recovered)', person: 'bdoe' }); expect(again.ok).toBe(true);
    const got = await B.repo.get('question', (again as any).value.ids[q.id]);
    expect((got as any).value.envelope.data.response).toBe('Typed between the tries');
  });

  it('a copy cut off between its two writes, with the app started again before the next try, is finished then', async () => {
    const { A, B, dealId } = await world({ questions: 40 });
    await run(B, CreateQuestion, { dealId, text: 'From the laptop' });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    const append = B.shared.append.bind(B.shared);
    B.shared.append = (n, t) => { if (/"kind":"deal","id":"d_/.test(t) && t.includes('(recovered)')) throw new Error('EIO'); append(n, t); };
    carry(A.shared, B.shared); await B.repo.sync(); await new Promise((r) => setTimeout(r, 100));
    expect(copyOf(B)).toBeUndefined(); B.shared.append = append; await B.repo.close();
    const B2 = pc('PC B', 'bdoe', 30, { shared: B.shared, local: B.local, id: B.id });
    await B2.store.boot();
    await B2.repo.sync();
    await until(() => !!copyOf(B2), 'the copy is finished after the restart');
    await B2.store.loadDeal(copyOf(B2)!.id, { gaps: false });
    expect(dealQuestions(B2.store.get(), copyOf(B2)!.id)).toHaveLength(41);
    expect(B2.store.get().ui.toasts.map((t) => t.text)).toEqual(['adoe deleted Project Proseware · a copy is kept here']);
  });

  it('at deal scale: 2,000 questions, 120 findings and the checklist are all kept, in seconds', async () => {
    const { A, B, dealId } = await world({ questions: 2000, findings: 120 });
    const q = dealQuestions(B.store.get(), dealId)[1500];
    await run(B, SetResponse, { dealId, questionId: q.id, response: 'Answered offline' });
    await run(B, DeleteQuestion, { dealId, questionId: dealQuestions(B.store.get(), dealId)[7].id });
    await run(A, DeleteDeal, { dealId, typedName: 'Project Proseware' });
    const started = Date.now();
    await syncAll(A, B); await until(() => !!copyOf(B), 'B has the copy');
    const copy = copyOf(B)!; await B.store.loadDeal(copy.id, { gaps: false });
    const took = Date.now() - started;
    const qs = dealQuestions(B.store.get(), copy.id);
    expect(qs).toHaveLength(1999); expect(dealFindings(B.store.get(), copy.id)).toHaveLength(120);
    expect(qs.find((x) => x.n === q.n)!.response).toBe('Answered offline');
    // the question deleted offline is in the copy's Recently deleted, and can be restored there
    const gone = Object.values(B.store.get().tombstones).filter((t) => t.dealId === copy.id);
    expect(gone).toHaveLength(1);
    await run(B, RestoreQuestion, { dealId: copy.id, questionId: gone[0].id });
    expect(dealQuestions(B.store.get(), copy.id)).toHaveLength(2000);
    // and its history came with it
    const h = await B.repo.audit(qs.find((x) => x.n === q.n)!.id);
    expect(h.ok && h.value.some((e) => e.kind === 'response' && e.dealId === copy.id)).toBe(true);
    expect(took).toBeLessThan(15000);
  }, 120000);
});

describe('the copy, worked out', () => {
  it('every old id in a record, however deep, is changed to the new one, and nothing else is', () => {
    const ids = new Map([['d_OLD', 'd_NEW'], ['q_1', 'q_2']]);
    expect(remap({ dealId: 'd_OLD', snapshot: { id: 'q_1', text: 'q_1 in words stays' }, list: ['q_1', 'x'] }, ids)).toEqual({ dealId: 'd_NEW', snapshot: { id: 'q_2', text: 'q_1 in words stays' }, list: ['q_2', 'x'] });
    // and keys: a Q&A log's record of the cells it sent, by question
    expect(remap({ qaLogs: [{ last: { sent: { q_1: { response: 'Yes' } } } }] }, ids)).toEqual({ qaLogs: [{ last: { sent: { q_2: { response: 'Yes' } } } }] });
  });
  it('the name fits in a deal name, and the notice says who deleted it, or where, when it was the same person', () => {
    expect(recoveredName('Project Proseware')).toBe('Project Proseware (recovered)');
    const long = recoveredName(`Project ${'W'.repeat(200)}`); expect(long.length).toBeLessThanOrEqual(DEAL_NAME_MAX); expect(long.endsWith(' (recovered)')).toBe(true);
    expect(recoveredNotice({ name: 'Project Proseware', by: 'adoe', from: 'PC A' }, 'bdoe')).toBe('adoe deleted Project Proseware · a copy is kept here');
    expect(recoveredNotice({ name: 'Project Proseware', by: 'bdoe', from: 'PC A' }, 'bdoe')).toBe('Project Proseware was deleted on PC A · a copy is kept here');
  });
});
