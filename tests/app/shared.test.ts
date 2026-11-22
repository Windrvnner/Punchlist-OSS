// Shared work between PCs: a clash stays on the one record it belongs to, a person chooses, and nothing is lost.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, type MemRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession, type MockOptions } from '../../src/adapters/mocks';
import { CreateDeal, EditDeal, DeleteDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RenumberQuestion } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot } from '../../src/app/commands/findings';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings, sharedNumbers } from '../../src/app/state';
import { watchIndexing, startIndexing, followDeals, pickUpIndexing, retryWait, withProgress, liveFolders, RETRY } from '../../src/app/indexing';
import { sameContent, distinctVersions, differingFields } from '../../src/domain/versions';
import { prepareImport, suggestMapping, questionsSheet } from '../../src/domain/importExport';
import type { DocumentService, Repository, Session } from '../../src/ports';
import { fail } from '../../src/domain/result';
import type { Folder } from '../../src/domain/model';

const COMMANDS = [CreateDeal, EditDeal, DeleteDeal, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RestoreQuestionSnapshot, CreateFinding, EditFinding, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, ImportQuestions, RevertImport, ResolveConflict, ReopenConflict, RenumberQuestion];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 10, 16, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HXXXXXXXXXXXXXXXV${String(seq++).padStart(7, '0')}` };
function make(kv = disk(), docs?: DocumentService, wrap?: (r: MemRepo) => Repository) {
  const opts: MockOptions = { latency: [0, 0] }; const repo = memRepo(clock.now, { ...kv, label: 'PC A' });
  const store = new Store({ repo: wrap ? wrap(repo) : repo, ai: mockAi(opts, repo), docs: docs ?? mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, repo, kv };
}
async function deal(m: ReturnType<typeof make>, name: string, folders: { path: string; label: string; files: number; size: string }[] = []) {
  if (m.store.get().boot.stage !== 'ready') await m.store.boot();
  await m.store.dispatch(CreateDeal, { name, folders });
  const d = Object.values(m.store.get().deals).find((x) => x.name === `Project ${name}`)!;
  await m.store.loadDeal(d.id);
  return d.id;
}
async function question(m: ReturnType<typeof make>, dealId: string, text: string) {
  const r = await m.store.dispatch(CreateQuestion, { dealId, text }); if (!r.ok) throw new Error('create');
  return m.store.get().ops[r.value.opId].targets.find((x) => m.store.get().questions[x])!;
}
const THEM = { by: 'sroe', from: 'PC B', at: '2026-11-10T17:42:00.000Z' };
const settle = () => new Promise((r) => setTimeout(r, 0));
/** a change that arrives from another PC, made without knowledge of what this one holds, once this PC has looked at the shared folder */
async function peer(m: ReturnType<typeof make>, id: string, patch: Record<string, unknown>, who = THEM) {
  const s = m.store.get(); const kind = id.startsWith('q_') ? 'question' : id.startsWith('f_') ? 'finding' : 'deal';
  const cur: any = kind === 'question' ? s.questions[id] : kind === 'finding' ? s.findings[id] : s.deals[id];
  const out = m.repo.peer.edit(kind, id, { ...cur, ...patch }, who); await m.repo.sync(); await settle(); return out;
}
const rowsFrom = (csv: string) => { const tb = readCsv(new TextEncoder().encode(csv)); if (!tb.ok) throw new Error('csv'); return prepareImport(tb.value.rows, suggestMapping(tb.value.columns)).rows; };

describe('what counts as two versions', () => {
  it('the same content is one version, whatever its revision, time stamp or field order', () => {
    expect(sameContent({ id: 'q', text: 'A', rev: 3, updatedAt: 'x' }, { updatedAt: 'y', rev: 9, text: 'A', id: 'q' })).toBe(true);
    expect(sameContent({ id: 'q', text: 'A' }, { id: 'q', text: 'B' })).toBe(false);
    // two people who make the same record on two PCs write it at different times: still one version
    expect(sameContent({ id: 'g', verdict: 'gap', createdAt: '2026-11-12T10:00:00Z', rev: 1 }, { id: 'g', verdict: 'gap', createdAt: '2026-11-12T10:05:00Z', rev: 1 })).toBe(true);
    expect(sameContent({ a: { x: 1, y: [1, 2] } }, { a: { y: [1, 2], x: 1 } })).toBe(true);
    expect(sameContent({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
  });
  it('distinct versions are listed oldest first, each content once, the same way on every PC', () => {
    const v = (id: string, at: string, text: string) => ({ id, at, data: { text, rev: 1 } });
    const a = distinctVersions([v('v3', '2026-11-10T10:00:00Z', 'B'), v('v1', '2026-11-10T09:00:00Z', 'A'), v('v2', '2026-11-10T11:00:00Z', 'A')]);
    const b = distinctVersions([v('v2', '2026-11-10T11:00:00Z', 'A'), v('v3', '2026-11-10T10:00:00Z', 'B'), v('v1', '2026-11-10T09:00:00Z', 'A')]);
    expect(a.map((x) => x.id)).toEqual(['v1', 'v3']); expect(b.map((x) => x.id)).toEqual(['v1', 'v3']);
  });
  it('only the fields that differ are named', () => {
    expect(differingFields([{ text: 'A', status: 'open', response: '' }, { text: 'A', status: 'closed', response: 'x' }], ['text', 'response', 'status'])).toEqual(['response', 'status']);
    expect(differingFields([{ text: 'A' }, null], ['text'])).toEqual([]);
  });
});

describe('a clash belongs to one record', () => {
  it('a change from another PC with the same content is not a clash', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'What is the lock-up ratio?');
    expect(await peer(m, q, {})).toBe('same');
    expect(await peer(m, q, { updatedAt: '2026-11-10T18:00:00.000Z', rev: 99 })).toBe('same');
    expect(m.store.get().conflicts[q]).toBeUndefined();
    expect((await m.store.dispatch(EditQuestionField, { dealId: d, questionId: q, field: 'text', value: 'Still editable' })).ok).toBe(true);
  });

  it('a different change marks that question and no other; the others stay fully editable', async () => {
    const m = make(); const d = await deal(m, 'Proseware');
    const qs: string[] = []; for (let i = 0; i < 12; i++) qs.push(await question(m, d, `Question ${i + 1}`));
    expect(await peer(m, qs[4], { response: 'From the PC B' })).toBe('conflict');
    const s = m.store.get();
    expect(Object.keys(s.conflicts)).toEqual([qs[4]]);
    expect(s.conflicts[qs[4]].versions.map((v) => v.from)).toEqual(['PC A', 'PC B']);
    expect(dealQuestions(s, d)).toHaveLength(12);                          // nothing vanished and nothing was duplicated
    // the one in a clash takes no edit, and says why
    const blocked = await m.store.dispatch(EditQuestionField, { dealId: d, questionId: qs[4], field: 'text', value: 'x' });
    expect(blocked.ok).toBe(false); expect(!blocked.ok && blocked.error.message).toBe('Q5 has two versions. Choose one first');
    expect((await m.store.dispatch(DeleteQuestion, { dealId: d, questionId: qs[4] })).ok).toBe(false);
    expect((await m.store.dispatch(SetQuestionStatus, { dealId: d, questionId: qs[4], status: 'closed' })).ok).toBe(false);
    // every other question still takes edits, status changes and deletes
    for (const id of qs.filter((_, i) => i !== 4)) expect((await m.store.dispatch(EditQuestionField, { dealId: d, questionId: id, field: 'workstream', value: 'Legal' })).ok).toBe(true);
    expect((await m.store.dispatch(SetQuestionStatus, { dealId: d, questionId: qs[0], status: 'closed' })).ok).toBe(true);
    expect((await m.store.dispatch(DeleteQuestion, { dealId: d, questionId: qs[1] })).ok).toBe(true);
    expect((await m.store.dispatch(CreateQuestion, { dealId: d, text: 'A new one' })).ok).toBe(true);
    expect(Object.keys(m.store.get().conflicts)).toEqual([qs[4]]);
  });

  it('an import goes through when it does not change the question in a clash, and names it when it would', async () => {
    const m = make(); const d = await deal(m, 'Proseware');
    const a = await question(m, d, 'First'); const b = await question(m, d, 'Second'); await question(m, d, 'Third');
    await peer(m, b, { text: 'Second, reworded at home' });
    const fine = await m.store.dispatch(ImportQuestions, { dealId: d, mode: 'merge', rows: rowsFrom('#,Question,Response\n1,First,Answered in the file\n2,Second,\n4,A fourth,\n') });
    expect(fine.ok).toBe(true);
    expect(m.store.get().questions[a].response).toBe('Answered in the file');
    expect(dealQuestions(m.store.get(), d)).toHaveLength(4);
    const stopped = await m.store.dispatch(ImportQuestions, { dealId: d, mode: 'merge', rows: rowsFrom('#,Question,Response\n2,Second,Overwritten by the file\n3,Third,Also answered\n') });
    expect(stopped.ok).toBe(false); expect(!stopped.ok && stopped.error.message).toBe('Q2 has two versions. Choose one first');
    expect(dealQuestions(m.store.get(), d).find((q) => q.n === 3)!.response).toBe('');     // all or nothing: the other row did not land either
  });

  it('a clash on a finding leaves the deal, its questions and its other findings alone', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'Unlinked');
    await m.store.dispatch(CreateFinding, { dealId: d, title: 'First finding', workstream: 'Legal' }); await m.store.dispatch(CreateFinding, { dealId: d, title: 'Second finding', workstream: 'Tax' });
    const f1 = dealFindings(m.store.get(), d).find((x) => x.title === 'First finding')!; const f2 = dealFindings(m.store.get(), d).find((x) => x.title === 'Second finding')!;
    await peer(m, f1.id, { title: 'First finding, retitled at home' });
    expect(Object.keys(m.store.get().conflicts)).toEqual([f1.id]);
    expect((await m.store.dispatch(ReviewFinding, { dealId: d, findingId: f1.id, reviewed: true })).ok).toBe(false);
    expect((await m.store.dispatch(ReviewFinding, { dealId: d, findingId: f2.id, reviewed: true })).ok).toBe(true);
    expect((await m.store.dispatch(EditQuestionField, { dealId: d, questionId: q, field: 'text', value: 'Edited' })).ok).toBe(true);
    expect((await m.store.dispatch(EditDeal, { dealId: d, sector: 'Wind' })).ok).toBe(true);
  });

  it('a clash on the deal’s own details stops only changes to those details', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'One');
    await peer(m, d, { counterparty: 'Northwind' });
    expect(m.store.get().conflicts[d].kind).toBe('deal');
    const r = await m.store.dispatch(EditDeal, { dealId: d, sector: 'Wind' });
    expect(r.ok).toBe(false); expect(!r.ok && r.error.message).toBe('Project Proseware has two versions. Choose one first');
    expect((await m.store.dispatch(EditQuestionField, { dealId: d, questionId: q, field: 'text', value: 'Still fine' })).ok).toBe(true);
    expect((await m.store.dispatch(CreateFinding, { dealId: d, title: 'Raised meanwhile', workstream: 'Legal' })).ok).toBe(true);
  });

  it('the repository itself refuses a write to a record in a clash unless it is a choice covering every version', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'One'); const other = await question(m, d, 'Two');
    await peer(m, q, { text: 'One, at home' });
    const cur = (await m.repo.get('question', q)); if (!cur.ok || !cur.value) throw new Error('get');
    const vs = cur.value.conflict!; expect(vs).toHaveLength(2);
    const plain = await m.repo.transaction({ writes: [{ kind: 'question', id: q, data: vs[0].data, expectedRev: cur.value.rev }] });
    expect(plain.ok).toBe(false); expect(!plain.ok && plain.error.kind).toBe('rejected');
    const partial = await m.repo.transaction({ writes: [{ kind: 'question', id: q, data: vs[0].data, expectedRev: cur.value.rev, resolves: [vs[0].id] }] });
    expect(partial.ok).toBe(false); expect(!partial.ok && partial.error.kind).toBe('conflict');
    const del = await m.repo.transaction({ writes: [], deletes: [{ kind: 'question', id: q, expectedRev: null }] });
    expect(del.ok).toBe(false);
    const o = await m.repo.get('question', other); if (!o.ok || !o.value) throw new Error('get');
    expect((await m.repo.transaction({ writes: [{ kind: 'question', id: other, data: o.value.envelope.data, expectedRev: o.value.rev }] })).ok).toBe(true);
    expect((await m.repo.transaction({ writes: [{ kind: 'question', id: q, data: vs[1].data, expectedRev: cur.value.rev, resolves: vs.map((v) => v.id) }] })).ok).toBe(true);
    const after = await m.repo.get('question', q); expect(after.ok && after.value && !after.value.conflict).toBe(true);
  });
});

describe('a person chooses, and nothing is lost', () => {
  it('keeping a version writes it, ends the clash, records the other in the history, and can be undone', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'What is the lock-up ratio?');
    await m.store.dispatch(SetResponse, { dealId: d, questionId: q, response: '1.25x per the draft' });
    await peer(m, q, { response: '1.30x per the term sheet', respondedBy: 'Sponsor' });
    const c = m.store.get().conflicts[q]; const theirs = c.versions.find((v) => v.from === 'PC B')!;
    expect(m.store.get().questions[q].response).toBe('1.25x per the draft');           // shown as the older version until someone chooses
    const r = await m.store.dispatch(ResolveConflict, { dealId: d, recordId: q, keep: theirs.id });
    expect(r.ok).toBe(true); if (!r.ok) return;
    expect(m.store.get().conflicts[q]).toBeUndefined();
    expect(m.store.get().questions[q].response).toBe('1.30x per the term sheet'); expect(m.store.get().questions[q].respondedBy).toBe('Sponsor');
    const hist = await m.repo.audit(q); if (!hist.ok) throw new Error('audit');
    const entry = hist.value.find((a) => a.kind === 'resolved')!;
    expect(entry.text).toBe('Kept the version by sroe from PC B');
    expect((entry.from as any[])[0].data.response).toBe('1.25x per the draft');        // the version set aside is still on record
    expect((await m.store.dispatch(EditQuestionField, { dealId: d, questionId: q, field: 'priority', value: 'High' })).ok).toBe(true);
    // a fresh start over the same storage agrees
    const again = make(m.kv); await again.store.boot(); await again.store.loadDeal(d);
    expect(again.store.get().conflicts[q]).toBeUndefined(); expect(again.store.get().questions[q].response).toBe('1.30x per the term sheet');
  });

  it('Undo of a choice puts both versions back, unchosen', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'Original wording');
    await peer(m, q, { text: 'Reworded at home' });
    const before = m.store.get().conflicts[q]; const mine = before.versions[0];
    const r = await m.store.dispatch(ResolveConflict, { dealId: d, recordId: q, keep: mine.id }); if (!r.ok) throw new Error('resolve');
    const u = await m.store.undo(r.value.opId);
    expect(u.ok).toBe(true);
    const after = m.store.get().conflicts[q];
    expect(after.versions.map((v) => [v.id, v.from, (v.data as any).text])).toEqual(before.versions.map((v) => [v.id, v.from, (v.data as any).text]));
    expect((await m.store.dispatch(EditQuestionField, { dealId: d, questionId: q, field: 'text', value: 'x' })).ok).toBe(false);
    const again = make(m.kv); await again.store.boot(); await again.store.loadDeal(d);
    expect(again.store.get().conflicts[q].versions).toHaveLength(2);
  });

  it('a clash is still there after a restart, on that record only', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const a = await question(m, d, 'One'); const b = await question(m, d, 'Two');
    await peer(m, a, { text: 'One, at home' });
    const again = make(m.kv); await again.store.boot(); await again.store.loadDeal(d);
    expect(Object.keys(again.store.get().conflicts)).toEqual([a]);
    expect((await again.store.dispatch(EditQuestionField, { dealId: d, questionId: b, field: 'text', value: 'Two, edited' })).ok).toBe(true);
  });

  it('a third PC adds a third version to the same record; a choice must cover all three', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'One');
    await peer(m, q, { text: 'At home' }); await peer(m, q, { text: 'On the train' }, { by: 'sroe', from: 'Tablet', at: '2026-11-10T18:10:00.000Z' });
    expect(await peer(m, q, { text: 'On the train' }, { by: 'sroe', from: 'Tablet', at: '2026-11-10T18:20:00.000Z' })).toBe('conflict');   // the same content again adds nothing
    const c = m.store.get().conflicts[q]; expect(c.versions).toHaveLength(3);
    const r = await m.store.dispatch(ResolveConflict, { dealId: d, recordId: q, keep: c.versions[2].id });
    expect(r.ok).toBe(true); expect(m.store.get().questions[q].text).toBe('On the train'); expect(m.store.get().conflicts[q]).toBeUndefined();
  });

  it('a version that cannot be read is kept and shown as such; it cannot be the one chosen, and the other can', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const q = await question(m, d, 'One');
    m.repo.peer.edit('question', q, { id: q, garbage: true }, THEM); await m.repo.sync(); await settle();
    const c = m.store.get().conflicts[q];
    expect(c.versions.map((v) => !!v.data)).toEqual([true, false]); expect((c.versions[1].raw as any).garbage).toBe(true);
    expect(m.store.get().questions[q].text).toBe('One');
    expect((await m.store.dispatch(ResolveConflict, { dealId: d, recordId: q, keep: c.versions[1].id })).ok).toBe(false);
    expect((await m.store.dispatch(ResolveConflict, { dealId: d, recordId: q, keep: c.versions[0].id })).ok).toBe(true);
    const hist = await m.repo.audit(q); expect(hist.ok && (hist.value.find((a) => a.kind === 'resolved')!.from as any[])[0].data.garbage).toBe(true);
  });
});

describe('a change from another PC that waits on one that has not arrived', () => {
  it('stops nothing: the deal takes changes as usual, and the wait shows until the missing change arrives', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    const qa = await question(m, a, 'On Proseware');
    m.repo.peer.seen(THEM); m.repo.peer.hold(a, THEM); await m.repo.sync();          // a change from PC B that depends on one of its own that has not arrived
    await settle(); await settle();
    const waiting = m.store.get().sync?.waiting ?? [];
    expect(waiting.map((w) => [w.label, w.from, w.changes])).toEqual([['PC B', ['PC B'], 1]]);
    expect((await m.store.dispatch(EditQuestionField, { dealId: a, questionId: qa, field: 'text', value: 'Proseware, edited' })).ok).toBe(true);
    expect((await m.store.dispatch(CreateQuestion, { dealId: a, text: 'New' })).ok).toBe(true);
    m.repo.peer.release(a); await m.repo.sync(); await settle(); await settle();     // the change it depends on arrives
    expect(m.store.get().sync?.waiting).toEqual([]);
    expect(m.store.get().questions[qa].text).toBe('Proseware, edited');
  });

  it('the deal is not deleted while it waits, here or at the shared folder, and can be once the change arrives', async () => {
    const m = make(); const a = await deal(m, 'Proseware');
    m.repo.peer.seen(THEM); m.repo.peer.hold(a, THEM); await m.repo.sync(); await settle(); await settle();
    expect(m.store.get().sync?.waiting[0].deals).toEqual([a]);
    const r = await m.store.dispatch(DeleteDeal, { dealId: a, typedName: 'Project Proseware' });
    expect(!r.ok && r.error.message).toBe('Project Proseware can’t be deleted while changes to it from PC B are still arriving'); expect(m.store.get().deals[a]).toBeDefined();
    const direct = await m.repo.transaction({ writes: [], purgeDeal: a }); expect(!direct.ok && direct.error.kind).toBe('rejected');   // the shared store refuses too
    m.repo.peer.release(a); await m.repo.sync(); await settle(); await settle();
    expect((await m.store.dispatch(DeleteDeal, { dealId: a, typedName: 'Project Proseware' })).ok).toBe(true);
  });
});

describe('indexing progress is shown, not saved, until it finishes', () => {
  const folder = (indexed: number, reviewed: number): Folder => ({ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB', indexed, reviewed });
  it('the deal keeps its own folders and labels; the backend supplies the counts', () => {
    const own: Folder[] = [{ ...folder(0, 0), label: 'Renamed by a person' }, { path: 'C:/vdr/legal', label: 'Legal', files: 10, size: '', indexed: 10, reviewed: 10 }];
    const merged = withProgress(own, [folder(25, 0), { path: 'C:/elsewhere', label: 'Not ours', files: 5, size: '', indexed: 5, reviewed: 5 }]);
    expect(merged).toEqual([{ ...folder(25, 0), label: 'Renamed by a person' }, own[1]]);
    expect(liveFolders({ indexing: {} }, { id: 'd', folders: own })).toBe(own);
  });
  it('the waits between tries start at 5 seconds, double each time, and stop growing at 15 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 30].map(retryWait)).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 320000, 640000, 900000, 900000, 900000]);
  });
  it('indexing found not running and not finished is started again without being asked, and tried again until it finishes; the pages are told why it is waiting; nothing is announced', async () => {
    const f = (indexed: number) => ({ path: 'C:/vdr/reports', label: 'reports', files: 40, size: '0.1 GB', indexed, reviewed: 0 });
    const stopped = (n: number) => ({ ok: true as const, value: { folders: [f(n)], log: [], done: false, stopped: true } });
    const running = (n: number) => ({ ok: true as const, value: { folders: [f(n)], log: ['Indexing 1 folder'], done: false } });
    const was = { ...RETRY }; RETRY.first = 20; RETRY.max = 200;
    try {
      // left at 17 of 40 by an earlier session. The folders cannot be opened at first (twice), then it starts, breaks at 25, is started again and finishes
      let st: 'at17' | 'run1' | 'at25' | 'run2' | 'done' = 'at17'; const calls: string[] = []; const when: number[] = [];
      const docs: DocumentService = { ...mockDocuments({ latency: [0, 0] }),
        index: async (_d, folders) => { calls.push(folders.map((x) => `${x.path}:${x.indexed}`).join()); when.push(Date.now());
          if (calls.length === 1) return { ok: false as const, error: { kind: 'notFound' as const, message: 'C:/vdr/reports could not be opened on this PC' } };
          if (calls.length === 2) return { ok: false as const, error: { kind: 'unreachable' as const, message: 'The shared folder could not be reached.' } };
          st = calls.length === 3 ? 'run1' : 'run2'; return { ok: true as const, value: undefined }; },
        poll: async () => { if (st === 'at17') return stopped(17); if (st === 'run1') { st = 'at25'; return running(25); } if (st === 'at25') return { ok: true as const, value: { ...stopped(25).value, why: 'The data room stopped answering.' } }; if (st === 'run2') { st = 'done'; return running(35); } return { ok: true as const, value: { folders: [f(40)], log: ['Indexed 40 files'], done: true } }; } };
      const m = make(disk(), docs);
      const d = await deal(m, 'Proseware', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
      calls.length = 0; when.length = 0; const rev = m.store.get().deals[d].rev; const toasts = m.store.get().ui.toasts.length;
      const said = new Set<string>(); const shown = new Set<number>(); const whys = new Set<string>();
      const off = m.store.subscribe((x) => { whys.add(`${x.indexing[d]?.folders[0]?.indexed}:${x.ui.indexWhy[d] ?? ''}`); const w = x.ui.indexWaiting[d]; if (w) said.add(`${w}:${x.ui.indexStalled.includes(d) ? 'stopped' : 'running'}`); const n = x.indexing[d]?.folders[0]?.indexed; if (n !== undefined) shown.add(n); });
      await watchIndexing(m.store, d); off();
      expect(calls).toEqual(['C:/vdr/reports:17', 'C:/vdr/reports:17', 'C:/vdr/reports:17', 'C:/vdr/reports:25']);   // each time on the folder that had not finished, from where it had got to
      // the tries are spaced: at once, then after the first wait, then after twice that (a wait cannot be shorter than asked; 2 ms are allowed for the clock)
      expect(when[1] - when[0]).toBeGreaterThanOrEqual(18); expect(when[2] - when[1]).toBeGreaterThanOrEqual(38); expect(when[3] - when[2]).toBeGreaterThanOrEqual(18);
      expect([...said].sort()).toEqual(['away:stopped', 'retry:stopped']);   // first waiting for the data room, later between tries; the page shows it as stopped meanwhile
      expect([...shown]).toEqual(expect.arrayContaining([17, 25, 35]));     // where it stopped is shown, with the deal's own label kept
      const end = m.store.get();
      expect(whys.has('25:The data room stopped answering.')).toBe(true); expect([...whys].filter((x) => !x.startsWith('25:')).every((x) => x.endsWith(':'))).toBe(true);   // what stopped it is passed to the page while it is stopped there, and at no other time
      expect(end.ui.indexWaiting[d]).toBeUndefined(); expect(end.ui.indexStalled).not.toContain(d); expect(end.ui.indexWhy[d]).toBeUndefined();
      expect(end.deals[d].stage).toBe('ready'); expect(end.deals[d].folders[0]).toMatchObject({ label: 'Reports', indexed: 40 }); expect(end.deals[d].rev).toBe(rev + 1);   // written once, at the end
      expect(end.ui.toasts.length).toBe(toasts);                            // nobody pressed anything, so nothing is announced

      // a deal the backend on this PC knows nothing about (indexed on another PC, or never started here) is not started from here
      let asked = 0;
      const docs2: DocumentService = { ...mockDocuments({ latency: [0, 0] }), index: async () => { asked++; return { ok: true as const, value: undefined }; }, poll: async () => ({ ok: true as const, value: { folders: [], log: [], done: true } }) };
      const m2 = make(disk(), docs2); const d2 = await deal(m2, 'Wingtip', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
      asked = 0; await watchIndexing(m2.store, d2);
      expect(asked).toBe(0); expect(m2.store.get().ui.indexStalled).toContain(d2); expect(m2.store.get().ui.indexWaiting[d2]).toBeUndefined();

      // a person starts indexing and the start is refused: they are told once, and it is tried again without being asked until it runs
      let n = 0; let go = false; let polls = 0;
      const docs3: DocumentService = { ...mockDocuments({ latency: [0, 0] }),
        index: async () => { n++; if (n < 4) return { ok: false as const, error: { kind: 'failed' as const, message: 'Indexing could not be started.' } }; go = true; return { ok: true as const, value: undefined }; },
        poll: async () => (!go ? { ok: true as const, value: { folders: [], log: [], done: true } } : polls++ === 0 ? running(20) : { ok: true as const, value: { folders: [f(40)], log: ['Indexed 40 files'], done: true } }) };
      const m3 = make(disk(), docs3); const d3 = await deal(m3, 'Trey', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
      n = 0; const t3 = m3.store.get().ui.toasts.length; let retrying = false; const off3 = m3.store.subscribe((x) => { if (x.ui.indexWaiting[d3] === 'retry') retrying = true; });
      await startIndexing(m3.store, d3, m3.store.get().deals[d3].folders);
      expect(n).toBe(1); expect(m3.store.get().ui.toasts.slice(t3).map((t) => t.text)).toEqual(['Couldn’t start indexing']);
      for (let i = 0; i < 400 && m3.store.get().deals[d3].stage !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
      off3();
      expect(m3.store.get().deals[d3].stage).toBe('ready'); expect(n).toBe(4); expect(retrying).toBe(true);
      expect(m3.store.get().ui.toasts.slice(t3).map((t) => t.text)).toEqual(['Couldn’t start indexing']);   // said once, when the person pressed; the tries after that are silent

      // pressed three times while it keeps failing: one notice, offering "Retry now" since the app retries by itself
      const docs4: DocumentService = { ...mockDocuments({ latency: [0, 0] }), index: async () => ({ ok: false as const, error: { kind: 'failed' as const, message: 'Indexing could not be started.' } }), poll: async () => ({ ok: true as const, value: { folders: [], log: [], done: true } }) };
      const m4 = make(disk(), docs4); const d4 = await deal(m4, 'Alpine', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
      for (let i = 0; i < 3; i++) await startIndexing(m4.store, d4, m4.store.get().deals[d4].folders);
      const told = m4.store.get().ui.toasts.filter((t) => t.text === 'Couldn’t start indexing');
      expect(told.length).toBe(1); expect(told[0].action?.label).toBe('Retry Now');
      await m4.store.dispatch(DeleteDeal, { dealId: d4, typedName: 'Project Alpine' });
    } finally { Object.assign(RETRY, was); }
  }, 20000);
  it('a deal deleted while its indexing waits to be tried again is let go of at once: nothing of it is kept for the pages, and a Retry left on screen starts nothing', async () => {
    const f = (indexed: number) => ({ path: 'C:/vdr/reports', label: 'reports', files: 40, size: '0.1 GB', indexed, reviewed: 0 });
    const was = { ...RETRY }; RETRY.first = 60000; RETRY.max = 60000;            // the wait in hand is a minute: nothing below may depend on it ending
    let stop = () => {};
    try {
      // the start is refused once (the data room cannot be opened); the backend remembers it was asked
      let asked = 0; let polls = 0;
      const docs: DocumentService = { ...mockDocuments({ latency: [0, 0] }),
        index: async () => { asked++; return asked === 1 ? { ok: false as const, error: { kind: 'notFound' as const, message: 'C:/vdr/reports could not be opened on this PC' } } : { ok: true as const, value: undefined }; },
        poll: async () => { polls++; return { ok: true as const, value: { folders: [f(0)], log: [], done: false, stopped: true } }; } };
      const m = make(disk(), docs); const d = await deal(m, 'Proseware', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
      stop = followDeals(m.store);
      await startIndexing(m.store, d, m.store.get().deals[d].folders);
      for (let i = 0; i < 100 && m.store.get().ui.indexWaiting[d] !== 'away'; i++) await settle();
      expect(asked).toBe(1); expect(m.store.get().ui.indexWaiting[d]).toBe('away'); expect(m.store.get().ui.indexStalled).toContain(d);
      const retry = m.store.get().ui.toasts.find((x) => x.text === 'Couldn’t start indexing')!;
      // deleted
      expect((await m.store.dispatch(DeleteDeal, { dealId: d, typedName: 'Project Proseware' })).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 20));
      const ui = m.store.get().ui;
      expect(ui.indexWaiting[d]).toBeUndefined(); expect(ui.indexStalled).not.toContain(d); expect(ui.indexWhy[d]).toBeUndefined(); expect(m.store.get().indexing[d]).toBeUndefined();
      const polled = polls; retry.action!.run!(); await new Promise((r) => setTimeout(r, 20));
      expect(asked).toBe(1); expect(polls).toBe(polled); expect(m.store.get().ui.toasts.filter((x) => x.text === 'Couldn’t start indexing').length).toBe(1);   // nothing started and nothing more said for a deal that is not there
      expect(m.store.get().ui.toasts.some((x) => x.text === 'Project Proseware deleted' && !x.action)).toBe(true);   // the deletion is final: its notice offers nothing
    } finally { stop(); Object.assign(RETRY, was); }
  });

  it('a deal whose indexing another PC finishes stops showing where this PC had stopped, without a restart', async () => {
    const f = (indexed: number) => ({ path: 'C:/vdr/reports', label: 'reports', files: 40, size: '0.1 GB', indexed, reviewed: 0 });
    const was = { ...RETRY }; RETRY.first = 40; RETRY.max = 40;                  // this PC's own retries come round quickly, and must not put its stop point back
    let stop = () => {};
    try {
      // this PC's run stopped part-way and waits to be tried again; its backend keeps saying so
      let polls = 0;
      const docs: DocumentService = { ...mockDocuments({ latency: [0, 0] }), index: async () => ({ ok: true as const, value: undefined }),
        poll: async () => { polls++; return { ok: true as const, value: { folders: [f(12)], log: [], done: false, stopped: true } }; } };
      const m = make(disk(), docs); const d = await deal(m, 'Proseware', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
      stop = followDeals(m.store); void watchIndexing(m.store, d);
      for (let i = 0; i < 100 && !m.store.get().ui.indexStalled.includes(d); i++) await settle();
      expect(m.store.get().indexing[d]?.folders[0].indexed).toBe(12); expect(m.store.get().ui.indexStalled).toContain(d);
      // the other PC finishes and records the deal as indexed; here it arrives as a change to the deal
      expect((await m.store.dispatch(RecordIndexingProgress, { dealId: d, folders: [f(40)], log: [], done: true }, { quiet: true })).ok).toBe(true);
      const polled = polls; await new Promise((r) => setTimeout(r, 300));      // several retry waits run out meanwhile
      expect(polls).toBeGreaterThan(polled);                                     // the loop did come round again
      const s = m.store.get();
      expect(s.deals[d].stage).toBe('ready'); expect(s.indexing[d]).toBeUndefined(); expect(s.ui.indexStalled).not.toContain(d); expect(s.ui.indexWaiting[d]).toBeUndefined();
      expect(liveFolders(s, s.deals[d])[0].indexed).toBe(40);
    } finally { stop(); Object.assign(RETRY, was); }
  });
  it('indexing left unfinished is picked up by the start that succeeds, once, when the first start could not connect', async () => {
    const f = (indexed: number) => ({ path: 'C:/vdr/reports', label: 'reports', files: 40, size: '0.1 GB', indexed, reviewed: 0 });
    const kv = disk(); const d = await deal(make(kv), 'Proseware', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
    // the app opens again on the same storage, while the backend cannot be reached; the backend here had got to 17 of 40
    let down = true; let asked = 0; const opts: MockOptions = { latency: [0, 0], unreachable: () => down };
    const docs: DocumentService = { ...mockDocuments({ latency: [0, 0] }),
      index: async () => { asked++; return { ok: true as const, value: undefined }; },
      poll: async () => ({ ok: true as const, value: asked ? { folders: [f(40)], log: ['Indexed 40 files'], done: true } : { folders: [f(17)], log: [], done: false, stopped: true } }) };
    const repo = memRepo(clock.now, { ...kv, label: 'PC A' });
    const store = new Store({ repo, ai: mockAi(opts, repo), docs, fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
    const stop = pickUpIndexing(store);
    try {
      await store.boot();
      expect(store.get().boot.stage).not.toBe('ready'); expect(store.get().net.down).toBe(true); expect(asked).toBe(0);
      down = false; await store.probeOnce();                                // the store's own retry gets through: this start succeeds
      expect(store.get().boot.stage).toBe('ready');
      for (let i = 0; i < 200 && store.get().deals[d].stage !== 'ready'; i++) await new Promise((r) => setTimeout(r, 10));
      expect(asked).toBe(1); expect(store.get().deals[d].stage).toBe('ready'); expect(store.get().deals[d].folders[0].indexed).toBe(40);
      await store.retryBoot(); await new Promise((r) => setTimeout(r, 20));
      expect(asked).toBe(1);                                                // nothing is started twice
    } finally { stop(); }
  });

  it('nobody signed in at start-up shows on the start screen with Retry, not the offline bar, and only Retry asks to open the sign-in window again', async () => {
    const asked: ({ retry?: boolean } | undefined)[] = []; let answer: 'down' | 'signedOut' | 'in' = 'signedOut';
    const real = mockSession({ latency: [0, 0] });
    const session: Session = { load: async (o) => { asked.push(o); return answer === 'in' ? real.load() : fail({ kind: answer === 'down' ? 'unreachable' : 'rejected', message: answer === 'down' ? 'The model service could not be reached.' : 'Nobody is signed in.' }); } };
    const repo = memRepo(clock.now, { ...disk(), label: 'PC A' });
    const store = new Store({ repo, ai: mockAi({ latency: [0, 0] }, repo), docs: mockDocuments({ latency: [0, 0] }), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session, local: new MemoryLocal(), clock, ids }, COMMANDS);
    await store.boot();
    expect(store.get().boot.error).toBe('Nobody is signed in.'); expect(store.get().net.down).toBe(false);
    expect(asked).toEqual([undefined]);                                      // the first start does not reopen anything
    await store.retryBoot();
    expect(asked[1]).toEqual({ retry: true }); expect(store.get().boot.error).toBe('Nobody is signed in.');
    // started while the service was out of reach, then nobody signed in: the offline bar's own retry hands over to the start screen
    answer = 'down'; await store.retryBoot(); expect(store.get().net.down).toBe(true); expect(store.get().boot.error).toBeUndefined();
    answer = 'signedOut'; await store.probeOnce();
    expect(asked[asked.length - 1]).toBeUndefined();                         // the offline bar's retry never reopens the window
    expect(store.get().net.down).toBe(false); expect(store.get().boot.error).toBe('Nobody is signed in.');
    answer = 'in'; await store.retryBoot(); expect(store.get().boot.stage).toBe('ready');
  });
  it('a probe and Retry that wait on the same sign-in start the app once', async () => {
    const real = mockSession({ latency: [0, 0] }); let loads = 0; const held: (() => void)[] = []; let hold = false;
    const session: Session = { load: async () => { const n = ++loads; if (hold) await new Promise<void>((r) => held.push(r)); return n === 1 ? fail({ kind: 'unreachable', message: 'away' }) : real.load(); } };
    let watches = 0; const local = Object.assign(new MemoryLocal(), { watch: (_f: (key: string) => void) => { watches++; return () => {}; } });
    const repo = memRepo(clock.now, { ...disk(), label: 'PC A' }); const stages: string[] = [];
    const store = new Store({ repo, ai: mockAi({ latency: [0, 0] }, repo), docs: mockDocuments({ latency: [0, 0] }), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session, local, clock, ids }, COMMANDS);
    await store.boot(); expect(store.get().net.down).toBe(true);
    hold = true; const off = store.subscribe((s) => { if (stages[stages.length - 1] !== s.boot.stage) stages.push(s.boot.stage); });
    const probe = store.probeOnce(); const retry = store.retryBoot(); await new Promise((r) => setTimeout(r, 10));
    expect(held.length).toBe(2); hold = false; for (const go of held) go(); await Promise.all([probe, retry]); off();
    expect(store.get().boot.stage).toBe('ready'); expect(watches).toBe(2);   // the store's and the conversations' listeners, once each
    expect(stages).toEqual(['session', 'deals', 'journal', 'ready']);
  });
  it('past the session step, the offline bar\'s probe goes to the folder, not the sign-in, and start-up carries on once the folder is back', async () => {
    let answer: 'signedOut' | 'in' = 'in'; let down = false;
    const real = mockSession({ latency: [0, 0] });
    let loads = 0; const session: Session = { load: async () => { loads++; return answer === 'in' ? real.load() : fail({ kind: 'rejected', message: 'Nobody is signed in.' }); } };
    const base = memRepo(clock.now, { ...disk(), label: 'PC A' });
    const repo: Repository = { get: (k, id) => base.get(k, id), audit: (r) => base.audit(r), watch: (f) => base.watch(f), sync: () => base.sync(), transaction: (tx) => base.transaction(tx), list: (k, d) => down ? Promise.resolve(fail({ kind: 'unreachable', message: 'away' })) : base.list(k, d) };
    const store = new Store({ repo, ai: mockAi({ latency: [0, 0] }, repo), docs: mockDocuments({ latency: [0, 0] }), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session, local: new MemoryLocal(), clock, ids }, COMMANDS);
    down = true; await store.boot();
    expect(store.get().boot.stage).toBe('deals'); expect(store.get().net.down).toBe(true);
    answer = 'signedOut'; await store.probeOnce();
    expect(store.get().net.down).toBe(true); expect(store.get().boot.error).toBeUndefined();
    // once the folder is back, start-up carries on without the sign-in, which it no longer needs
    down = false; await store.probeOnce(); expect(store.get().boot.stage).toBe('ready'); expect(store.get().net.down).toBe(false);
    expect(loads).toBe(1);                                                    // the probes went to the folder, not the model service
  });

  it('polling writes nothing to the deal while under way, and writes it once at the end', async () => {
    const steps = [folder(10, 0), folder(40, 12), folder(40, 40)]; let i = 0;
    const docs: DocumentService = { ...mockDocuments({ latency: [0, 0] }), poll: async () => { const f = steps[Math.min(i, steps.length - 1)]; const done = i >= steps.length - 1; i++; return { ok: true as const, value: { folders: [f], log: [done ? 'First pass complete' : 'Indexing 1 folder'], done } }; } };
    const dealWrites: number[] = [];
    const m = make(disk(), docs, (repo) => ({ get: (k, id) => repo.get(k, id), list: (k, d) => repo.list(k, d), audit: (r) => repo.audit(r), watch: (f) => repo.watch(f), sync: () => repo.sync(), transaction: (tx) => { if (tx.writes.some((w) => w.kind === 'deal')) dealWrites.push(i); return repo.transaction(tx); } }));
    const d = await deal(m, 'Proseware', [{ path: 'C:/vdr/reports', label: 'Reports', files: 40, size: '0.1 GB' }]);
    await m.store.dispatch(EditDeal, { dealId: d, folder: { path: 'C:/vdr/reports', label: 'Advisor reports' } });
    const before = dealWrites.length; const rev = m.store.get().deals[d].rev;
    const seen: number[] = []; const off = m.store.subscribe((s) => { const f = s.indexing[d]?.folders[0]; if (f && seen[seen.length - 1] !== f.indexed + f.reviewed) seen.push(f.indexed + f.reviewed); });
    await watchIndexing(m.store, d); off();
    expect(seen).toEqual([10, 52, 80]);                                    // progress was shown at every step
    expect(dealWrites.length - before).toBe(1);                            // and the deal was written once
    const done = m.store.get().deals[d];
    expect(done.rev).toBe(rev + 1); expect(done.stage).toBe('ready'); expect(done.folders[0]).toMatchObject({ indexed: 40, reviewed: 40, label: 'Advisor reports' });
    expect(m.store.get().indexing[d]).toBeUndefined();
  }, 15000);
});

describe('the same number given twice', () => {
  /** a question added on another PC before either saw the other's: a different record with the same number */
  async function twin(m: ReturnType<typeof make>, likeId: string, text: string) {
    const like = m.store.get().questions[likeId]; const id = ids.next('q');
    m.repo.peer.create('question', id, { ...like, id, text, rev: 0 }, like.dealId, THEM); await m.repo.sync(); await settle(); return id;
  }
  it('both questions are kept and marked; a person renumbers one; nothing is renumbered on its own', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const a = await question(m, d, 'One'); const b = await question(m, d, 'Two, added at the office');
    const c = await twin(m, b, 'Two, added at home');
    let s = m.store.get();
    expect(dealQuestions(s, d).map((q) => q.n)).toEqual([1, 2, 2]); expect([...sharedNumbers(s, d)]).toEqual([2]);
    expect(Object.keys(s.conflicts)).toEqual([]);                          // two records, not two versions of one
    // each can still be edited; neither is touched until someone decides
    expect((await m.store.dispatch(EditQuestionField, { dealId: d, questionId: c, field: 'priority', value: 'High' })).ok).toBe(true);
    expect((await m.store.dispatch(RenumberQuestion, { dealId: d, questionId: a })).ok).toBe(false);   // Q1 is not shared
    const r = await m.store.dispatch(RenumberQuestion, { dealId: d, questionId: c }); if (!r.ok) throw new Error('renumber');
    s = m.store.get();
    expect(s.questions[c].n).toBe(3); expect(s.questions[b].n).toBe(2); expect(sharedNumbers(s, d).size).toBe(0);
    expect((await m.store.dispatch(RenumberQuestion, { dealId: d, questionId: b })).ok).toBe(false);   // no longer shared
    await m.store.undo(r.value.opId);
    expect(m.store.get().questions[c].n).toBe(2); expect([...sharedNumbers(m.store.get(), d)]).toEqual([2]);
  });
  it('the next number skips numbers that deleted questions held', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); const a = await question(m, d, 'One'); const b = await question(m, d, 'Two'); const gone = await question(m, d, 'Three');
    await m.store.dispatch(DeleteQuestion, { dealId: d, questionId: gone });
    const c = await twin(m, a, 'One, added at home');
    await m.store.dispatch(RenumberQuestion, { dealId: d, questionId: c });
    expect(m.store.get().questions[c].n).toBe(4); expect(m.store.get().questions[b].n).toBe(2);
  });
  it('an import row on a number two questions hold, with wording that matches neither, is a question of its own; neither is touched', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); await question(m, d, 'One'); const b = await question(m, d, 'Two'); await twin(m, b, 'Two, added at home');
    expect((await m.store.dispatch(ImportQuestions, { dealId: d, mode: 'merge', rows: rowsFrom('#,Question,Response\n1,One,Answered\n2,"Two, reworded",Which of them?\n') })).ok).toBe(true);
    expect(dealQuestions(m.store.get(), d).map((q) => `${q.n}: ${q.text} | ${q.response}`)).toEqual(['1: One | Answered', '2: Two | ', '2: Two, added at home | ', '3: Two, reworded | Which of them?']);
  });
  it('the app\'s own export merges back after two questions came to share a number: each row is matched by its wording', async () => {
    const m = make(); const d = await deal(m, 'Proseware'); await question(m, d, 'One'); const b = await question(m, d, 'Two'); const c = await twin(m, b, 'Two, added at home');
    const file = await csvCodec.write('Q&A log', questionsSheet(dealQuestions(m.store.get(), d))); if (!file.ok) throw new Error('write');
    const t = readCsv(file.value.bytes); if (!t.ok) throw new Error('csv');
    const rows = prepareImport(t.value.rows, suggestMapping(t.value.columns)).rows; expect(rows.map((r) => r.n)).toEqual([1, 2, 2]);
    const before = JSON.stringify(m.store.get().questions);
    expect((await m.store.dispatch(ImportQuestions, { dealId: d, mode: 'merge', rows })).ok).toBe(true);
    expect(JSON.stringify(m.store.get().questions)).toBe(before);                     // nothing in the file differs
    // a response written in the file against one of them lands on that one only
    const edited = rows.map((r) => (r.text === 'Two, added at home' ? { ...r, response: 'From the file' } : r));
    expect((await m.store.dispatch(ImportQuestions, { dealId: d, mode: 'merge', rows: edited })).ok).toBe(true);
    expect([m.store.get().questions[b].response, m.store.get().questions[c].response]).toEqual(['', 'From the file']);
    // two rows that read as the same one of them: the second is another question under that number, as for any repeated number
    expect((await m.store.dispatch(ImportQuestions, { dealId: d, mode: 'merge', rows: [rows[1], { ...rows[1], response: 'Again' }] })).ok).toBe(true);
    expect(dealQuestions(m.store.get(), d).filter((q) => q.n === 2).map((q) => q.response).sort()).toEqual(['', 'Again', 'From the file']);
  });
  it('findings have no code: two made at once on two PCs are simply two findings, ' +
    'with nothing to renumber', async () => {
    const m = make(); const d = await deal(m, 'Proseware');
    await m.store.dispatch(CreateFinding, { dealId: d, title: 'Raised at the office', workstream: 'Legal' });
    const f = dealFindings(m.store.get(), d)[0]; const id = ids.next('f');
    m.repo.peer.create('finding', id, { ...f, id, title: 'Raised at home', rev: 0 }, d, THEM); await m.repo.sync(); await settle();
    expect(dealFindings(m.store.get(), d).map((x) => x.title).sort()).toEqual(['Raised at home', 'Raised at the office']);
    expect(dealFindings(m.store.get(), d).every((x) => !('code' in x))).toBe(true);
  });
});

describe('records with two versions are reported across deals', () => {
  it('the report names them, and start-up loads no deal just for them', async () => {
    const m = make(); const a = await deal(m, 'Proseware'); const b = await deal(m, 'Wingtip'); const c = await deal(m, 'Alpine');
    const qa = await question(m, a, 'On Proseware'); await question(m, b, 'On Wingtip'); await question(m, c, 'On Alpine');
    await peer(m, qa, { text: 'On Proseware, reworded at home' }); await peer(m, c, { sector: 'Wind' });
    const report = await m.repo.sync(); if (!report.ok) throw new Error('sync');
    expect(report.value.clashes!.map((x) => `${x.kind}:${x.id}`).sort()).toEqual([`deal:${c}`, `question:${qa}`].sort());
    const again = make(m.kv); await again.store.boot();
    for (let i = 0; i < 20; i++) await settle();
    const s = again.store.get();
    // Home no longer lists them: each is marked on its own deal once that deal is opened
    expect(s.dealLoad[a]).toBeUndefined(); expect(s.dealLoad[b]).toBeUndefined(); expect(s.questions[qa]).toBeUndefined();
    await again.store.loadDeal(a, { gaps: false });
    expect(Object.keys(again.store.get().conflicts)).toContain(qa);
  });
});
