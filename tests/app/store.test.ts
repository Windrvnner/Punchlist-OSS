import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Store, STALE_MS } from '../../src/app/store';
import { memRepo, disk, refuse, quota, toAQuestion, type MemRepo } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment } from '../../src/app/commands/findings';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import type { Repository } from '../../src/ports';

export const COMMANDS = [CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment];
for (const c of COMMANDS) registry.set(c.name, c);

let t = 0;
const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0, t++)).toISOString() };
let seq = 0;
const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0').replace(/[^0-9A-HJKMNP-TV-Z]/g, '0')}` };

function makeStore(kv = disk(), repo?: Repository, local = new MemoryLocal()) {
  const r = repo ?? memRepo(clock.now, kv);
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo: r, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local, clock, ids }, COMMANDS);
  return { store, kv, repo: r };
}

/** Repository wrapper that delays the Nth transaction. */
function delaying(repo: Repository, pick: (n: number) => number): Repository {
  let n = 0;
  return { get: (k, i) => repo.get(k, i), list: (k, d) => repo.list(k, d), audit: (r) => repo.audit(r), watch: (f) => repo.watch(f), transaction: async (tx) => { const ms = pick(++n); if (ms) await new Promise((r) => setTimeout(r, ms)); return repo.transaction(tx); } };
}

describe('Store', () => {
  beforeEach(() => { seq = 0; });

  it('boots, creates a deal and a question, edits, persists, reloads', async () => {
    const { store, kv } = makeStore();
    await store.boot();
    expect(store.get().boot.stage).toBe('ready');
    const d = await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    expect(d.ok).toBe(true);
    const dealId = Object.keys(store.get().deals)[0];
    expect(store.get().deals[dealId].name).toBe('Project Datum');
    const q = await store.dispatch(CreateQuestion, { dealId, text: 'First?' });
    expect(q.ok).toBe(true);
    const qid = Object.keys(store.get().questions)[0];
    const e = await store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'First line\nSecond line' });
    expect(e.ok).toBe(true);
    // a fresh store over the same storage sees everything
    const { store: s2 } = makeStore(kv);
    await s2.boot(); await s2.loadDeal(dealId);
    expect(s2.get().questions[qid].text).toBe('First line\nSecond line');
    expect(s2.get().questions[qid].rev).toBe(2);
  });

  it('state does not change when storage rejects the write; retry succeeds', async () => {
    const { store, kv } = makeStore();
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const dealId = Object.keys(store.get().deals)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'x' });
    const qid = Object.keys(store.get().questions)[0];
    // fail the data write (the journal write succeeds first)
    refuse(kv.local, toAQuestion, quota, 1);
    const r = await store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'changed' });
    expect(!r.ok && r.error.kind).toBe('storageFull');
    expect(store.get().questions[qid].text).toBe('x');
    const op = Object.values(store.get().ops).find((o) => o.command === 'EditQuestionField')!;
    expect(op.state).toBe('failed');
    expect(store.get().ui.toasts.some((t) => /storage is full/.test(t.text))).toBe(true);
    const r2 = await store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'changed' });
    expect(r2.ok).toBe(true);
    expect(store.get().questions[qid].text).toBe('changed');
  });

  it('a delete the shared folder cannot take is said to have failed, with a Retry that deletes once the folder is back', async () => {
    const { store, kv } = makeStore();
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const dealId = Object.keys(store.get().deals)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'x' });
    const qid = Object.keys(store.get().questions)[0];
    const back = refuse(kv.shared, toAQuestion, () => new Error('The network path was not found'));
    const r = await store.dispatch(DeleteQuestion, { dealId, questionId: qid });
    expect(!r.ok && r.error.kind).toBe('unreachable');
    expect(store.get().questions[qid]).toBeDefined();
    expect(store.get().net.down).toBe(true);                               // the bar says the backend is out of reach
    const said = store.get().ui.toasts.find((t) => t.text === 'Couldn’t save ·');   // and the delete is said not to have happened, as any other failed action is
    expect(said?.action?.label).toBe('Retry');
    back();
    said!.action!.run!();
    await new Promise((res) => setTimeout(res, 20));
    expect(store.get().questions[qid]).toBeUndefined();
    expect(store.get().tombstones[qid]).toBeDefined();
  });

  it('undo reverses an edit and a delete, and refuses after a later change', async () => {
    const { store } = makeStore();
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const dealId = Object.keys(store.get().deals)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'orig' });
    const qid = Object.keys(store.get().questions)[0];
    const e = await store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'edited' });
    await store.undo((e as any).value.opId);
    expect(store.get().questions[qid].text).toBe('orig');
    const del = await store.dispatch(DeleteQuestion, { dealId, questionId: qid });
    expect(store.get().questions[qid]).toBeUndefined();
    expect(store.get().tombstones[qid]).toBeDefined();
    await store.undo((del as any).value.opId);
    expect(store.get().questions[qid].text).toBe('orig');
    expect(store.get().tombstones[qid]).toBeUndefined();
    // undo refused once the record moved on
    const e2 = await store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'a' });
    await store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'b' });
    const u = await store.undo((e2 as any).value.opId);
    expect(!u.ok && u.error.message).toMatch(/Changed since/);
    expect(store.get().questions[qid].text).toBe('b');
  });

  it('a delayed save never lands after its own undo (per-record sequencing)', async () => {
    const kv = disk();
    const base = memRepo(clock.now, kv);
    // delay the 6th transaction (the status change's data write) by 200 ms
    const repo = delaying(base, (n) => (n === 6 ? 200 : 0));
    const { store } = makeStore(kv, repo);
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const dealId = Object.keys(store.get().deals)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'x' });
    const qid = Object.keys(store.get().questions)[0];
    const p1 = store.dispatch(SetQuestionStatus, { dealId, questionId: qid, status: 'closed' });
    // user "undoes" while the close is still in flight: undo must wait for it, then reverse it
    await new Promise((r) => setTimeout(r, 20));
    const opId = Object.values(store.get().ops).find((o) => o.command === 'SetQuestionStatus')!.id;
    const p2 = store.undo(opId);
    await Promise.all([p1, p2]);
    expect(store.get().questions[qid].status).toBe('open');
    const { store: s2 } = makeStore(kv); await s2.boot(); await s2.loadDeal(dealId);
    expect(s2.get().questions[qid].status).toBe('open');
  });

  it('drops a duplicate submission while the first is pending', async () => {
    const kv = disk();
    const repo = delaying(memRepo(clock.now, kv), (n) => (n <= 6 ? 50 : 0));
    const { store } = makeStore(kv, repo);
    await store.boot();
    const a = store.dispatch(CreateDeal, { name: 'Double', folders: [] }, { idempotencyKey: 'nd-create' });
    const b = store.dispatch(CreateDeal, { name: 'Double', folders: [] }, { idempotencyKey: 'nd-create' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok).toBe(true);
    expect(!rb.ok && rb.error.message).toMatch(/Already in progress/);
    expect(Object.keys(store.get().deals).length).toBe(1);
  });

  it('a question added while the deal is still loading takes the next number, not one already held', async () => {
    const kv = disk();
    const { store } = makeStore(kv); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Loading', folders: [] }); const dealId = Object.keys(store.get().deals)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'First?' });
    // a fresh start whose question list arrives slowly: Add question is pressed before it does
    const base = memRepo(clock.now, kv);
    const slow: Repository = { get: (k, i) => base.get(k, i), audit: (r) => base.audit(r), watch: (f) => base.watch(f), transaction: (tx) => base.transaction(tx), list: async (k, d) => { if (k === 'question') await new Promise((r) => setTimeout(r, 50)); return base.list(k, d); } };
    const { store: s2 } = makeStore(kv, slow); await s2.boot();
    const r = await s2.dispatch(CreateQuestion, { dealId, text: 'Second?' });
    expect(r.ok).toBe(true);
    expect(Object.values(s2.get().questions).map((q) => `${q.n} ${q.text}`).sort()).toEqual(['1 First?', '2 Second?']);
  });

  it('marks operations left pending by a crash as interrupted on the next start', async () => {
    const kv = disk();
    const repo = memRepo(clock.now, kv);
    // write a pending journal entry as if the app died mid-operation
    await repo.transaction({ writes: [{ kind: 'op', id: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', data: { id: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', command: 'EditQuestionField', input: {}, targets: [], state: 'pending', startedAt: clock.now() }, expectedRev: null }] });
    const { store } = makeStore(kv);
    await store.boot();
    expect(store.get().ops['op_01HZZZZZZZZZZZZZZZZZZZZZZZ'].state).toBe('interrupted');
  });

  it('opening a second window leaves a save still running in the first alone', async () => {
    const kv = disk(); const local = new MemoryLocal(); const base = memRepo(clock.now, kv);         // two windows of one PC share both stores
    const { store: a } = makeStore(kv, delaying(base, (n) => (n === 6 ? 100 : 0)), local); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Slow', folders: [] }); const dealId = Object.keys(a.get().deals)[0];
    await a.dispatch(CreateQuestion, { dealId, text: 'Confirm the ratio.' }); const qid = Object.keys(a.get().questions)[0];
    const saving = a.dispatch(SetResponse, { dealId, questionId: qid, response: 'Slow answer' });   // its data write (the 6th transaction) is slow
    await new Promise((r) => setTimeout(r, 20));
    const { store: b } = makeStore(kv, base, local); await b.boot();                            // window B opens meanwhile
    expect(b.interruptedOps()).toEqual([]);                                                          // nothing of A's shows as interrupted in B
    const r = await saving;
    expect(r.ok).toBe(true);
    expect(a.get().questions[qid].response).toBe('Slow answer');
    const stored = await memRepo(clock.now, kv).get('op', (r as any).value.opId);               // as kept on this PC
    expect(stored.ok && (stored.value?.envelope.data as { state?: string } | undefined)?.state).toBe('succeeded');
  });

  it('opening the deal on another PC leaves a draft still running alone, until it is long abandoned', async () => {
    const kv = disk(); const { store: a } = makeStore(kv); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Drafting', folders: [] }); const dealId = Object.keys(a.get().deals)[0];
    await a.dispatch(CreateQuestion, { dealId, text: 'Confirm the ratio.' }); const qid = Object.keys(a.get().questions)[0];
    let answer!: () => void; (a.services.ai as any).draft = () => new Promise((r) => { answer = () => r({ ok: false, error: { kind: 'failed', message: 'stopped' } }); });
    await a.dispatch(RequestDraft, { dealId, questionId: qid });
    try {
      const other = () => makeStore(kv, memRepo(clock.now, { shared: kv.shared })).store;           // another PC on the same shared folder
      const b = other(); await b.boot(); await b.loadDeal(dealId);
      expect(b.get().questions[qid].draft?.status).toBe('pending');
      t += 16 * 60_000;                                                                               // a quarter of an hour on, nothing came back
      const c = other(); await c.boot(); await c.loadDeal(dealId);
      expect(c.get().questions[qid].draft?.status).toBe('failed');
    } finally { answer(); }
  });

  it('a draft started in a window of this PC that has closed is given up when the deal opens', async () => {
    const kv = disk(); const local = new MemoryLocal(); const { store: a } = makeStore(kv, undefined, local); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Closed', folders: [] }); const dealId = Object.keys(a.get().deals)[0];
    await a.dispatch(CreateQuestion, { dealId, text: 'Confirm the ratio.' }); const qid = Object.keys(a.get().questions)[0];
    let answer!: () => void; (a.services.ai as any).draft = () => new Promise((r) => { answer = () => r({ ok: false, error: { kind: 'failed', message: 'stopped' } }); });
    await a.dispatch(RequestDraft, { dealId, questionId: qid });
    try {
      const { store: b } = makeStore(kv, undefined, local); await b.boot(); await b.loadDeal(dealId);  // window A still open: left alone
      expect(b.get().questions[qid].draft?.status).toBe('pending');
      local.write('alive', {});                                                                       // window A has closed
      const { store: c } = makeStore(kv, undefined, local); await c.boot(); await c.loadDeal(dealId);
      expect(c.get().questions[qid].draft?.status).toBe('failed');
    } finally { answer(); }
  });

  it('another window’s pending work is interrupted only once that window is gone', async () => {
    const kv = disk(); const repo = memRepo(clock.now, kv); const local = new MemoryLocal();
    const pending = (id: string, window: string) => repo.transaction({ writes: [{ kind: 'op', id, data: { id, command: 'EditQuestionField', input: {}, targets: [], state: 'pending', window, startedAt: clock.now() }, expectedRev: null }] });
    const quiet = 'op_01HZZZZZZZZZZZZZZZZZZZZZZA', live = 'op_01HZZZZZZZZZZZZZZZZZZZZZZB';
    await pending(quiet, 'w-closed'); await pending(live, 'w-open');
    local.write('alive', { 'w-open': clock.now() });                    // only w-open was heard from lately
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const { store } = makeStore(kv, repo, local); const booting = store.boot(); await vi.advanceTimersByTimeAsync(50); await booting;
      expect(store.get().ops[quiet].state).toBe('interrupted');
      expect(store.get().ops[live].state).toBe('pending');
      local.write('alive', { 'w-open': '2026-01-01T00:00:00.000Z' });   // that window has stopped answering
      await vi.advanceTimersByTimeAsync(STALE_MS);
      expect(store.get().ops[live].state).toBe('interrupted');
      const stored = await repo.get('op', live);
      expect(stored.ok && (stored.value?.envelope.data as { state?: string } | undefined)?.state).toBe('interrupted');
    } finally { vi.useRealTimers(); }
  });

  it('Retry on an interrupted action is refused when what it would write has changed since, so newer work stands', async () => {
    const kv = disk(); const repo = memRepo(clock.now, kv);
    const { store: a } = makeStore(kv, repo); await a.boot();
    await a.dispatch(CreateDeal, { name: 'Retry', folders: [] }); const dealId = Object.keys(a.get().deals)[0];
    await a.dispatch(CreateQuestion, { dealId, text: 'Confirm the ratio.' }); const qid = Object.keys(a.get().questions)[0]; const rev = a.get().questions[qid].rev;
    // the window closed while this response was saving: its journal entry was left pending
    await repo.transaction({ writes: [{ kind: 'op', id: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', data: { id: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', command: 'SetResponse', input: { dealId, questionId: qid, response: 'My old answer' }, targets: [qid], baseRevs: { [qid]: rev }, dealId, state: 'pending', startedAt: clock.now() }, expectedRev: null }] });
    await a.dispatch(SetResponse, { dealId, questionId: qid, response: 'A colleague’s newer answer' });                // meanwhile
    const { store: b } = makeStore(kv, repo); await b.boot(); await b.loadDeal(dealId);
    expect(b.get().ops['op_01HZZZZZZZZZZZZZZZZZZZZZZZ'].state).toBe('interrupted');
    await b.retryOp('op_01HZZZZZZZZZZZZZZZZZZZZZZZ');
    expect(b.get().questions[qid].response).toBe('A colleague’s newer answer');
    expect(b.get().ui.toasts.at(-1)?.text).toMatch(/would write over newer work/);
  });

  it('a response on a linked question marks the finding in the same transaction and undo clears both', async () => {
    const { store, repo } = makeStore();
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const dealId = Object.keys(store.get().deals)[0];
    // seed a finding directly (the Finding commands arrive in the next migration step)
    const fid = 'f_01HZZZZZZZZZZZZZZZZZZZZZZZ';
    await repo.transaction({ writes: [{ kind: 'finding', id: fid, data: { id: fid, dealId, rev: 0, createdAt: clock.now(), updatedAt: clock.now(), title: 'T', workstream: 'Legal', raisedAt: clock.now(), origin: 'human', sources: [] }, expectedRev: null }], index: { dealId, add: [{ kind: 'finding', id: fid }] } });
    await store.dispatch(CreateQuestion, { dealId, text: 'linked' });
    const qid = Object.keys(store.get().questions)[0];
    await repo.transaction({ writes: [{ kind: 'question', id: qid, data: { ...store.get().questions[qid], linkedFinding: fid }, expectedRev: 1 }] });
    await store.retryDeal(dealId);
    const r = await store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Here you go' });
    expect(r.ok).toBe(true);
    expect(store.get().findings[fid].updated).toBe(true);
    await store.undo((r as any).value.opId);
    expect(store.get().questions[qid].response).toBe('');
    expect(store.get().findings[fid].updated).toBe(false);
    const au = await repo.audit(fid);
    expect(au.ok && au.value.map((a) => a.kind)).toEqual(['response', 'undone']);
  });

  it('reloads a record another tab or PC changed', async () => {
    const kv = disk();
    const { store } = makeStore(kv);
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
    const dealId = Object.keys(store.get().deals)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'mine' });
    const qid = Object.keys(store.get().questions)[0];
    const other = memRepo(clock.now, { shared: kv.shared });                          // another tab of the demo is another PC
    await other.transaction({ writes: [{ kind: 'question', id: qid, data: { ...store.get().questions[qid], text: 'theirs' }, expectedRev: 1 }] });
    await (store.services.repo as MemRepo).sync();                                    // this PC looks at the shared folder (in the demo, when the storage event arrives)
    await new Promise((r) => setTimeout(r, 5));
    expect(store.get().questions[qid].text).toBe('theirs');
    expect(store.get().questions[qid].rev).toBe(2);
  });
  it('a command that throws tells the person and returns a failure; nothing is written and later commands still run', async () => {
    const { store, repo } = makeStore(); await store.boot();
    const made = await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] } as any); expect(made.ok).toBe(true);
    const dealId = Object.keys(store.get().deals)[0];
    const Broken = { ...CreateQuestion, name: 'Broken', plan: () => { throw new Error('boom'); } } as any;
    const before = (await repo.list('question', dealId)); const opsBefore = Object.keys(store.get().ops).length;
    const r = await store.dispatch(Broken, { dealId, text: 'Will not be saved', workstream: 'Legal' });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.kind).toBe('failed');
    expect(store.get().ui.toasts.map((t) => t.text)).toContain('That didn’t work. Nothing was changed.');
    expect((await repo.list('question', dealId))).toEqual(before); expect(Object.keys(store.get().ops).length).toBe(opsBefore);
    const next = await store.dispatch(CreateQuestion, { dealId, text: 'Saved after the fault', workstream: 'Legal' });   // the queue on this deal is not left stuck
    expect(next.ok).toBe(true);
  });

  it('a repository that throws mid-write is reported as unfinished with Reload, and the journal entry is marked failed', async () => {
    const kv = disk(); const real = memRepo(clock.now, kv); let n = 0; let armed = false;
    const repo: Repository = { get: (k, i) => real.get(k, i), list: (k, d) => real.list(k, d), audit: (r) => real.audit(r), watch: (f) => real.watch(f), transaction: async (tx) => { if (armed && ++n === 2) throw new Error('disk went away'); return real.transaction(tx); } };
    const { store } = makeStore(kv, repo); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] } as any); const dealId = Object.keys(store.get().deals)[0];
    armed = true;                                                    // the journal entry is written, then the record write throws
    const r = await store.dispatch(CreateQuestion, { dealId, text: 'Half written', workstream: 'Legal' });
    expect(r.ok).toBe(false);
    const t = store.get().ui.toasts.find((x) => x.text === 'That didn’t finish ·'); expect(t?.action?.label).toBe('Reload');
    const op = Object.values(store.get().ops).find((o) => o.command === 'CreateQuestion')!; expect(op.state).toBe('failed'); expect(op.error).toBe('disk went away');
    expect(Object.values(store.get().questions).length).toBe(0);
  });

  it('two questions added at once get different numbers', async () => {
    const { store } = makeStore(); await store.boot();
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const dealId = Object.keys(store.get().deals)[0];
    const rs = await Promise.all([store.dispatch(CreateQuestion, { dealId, text: 'One?' }), store.dispatch(CreateQuestion, { dealId, text: 'Two?' }), store.dispatch(CreateQuestion, { dealId, text: 'Three?' })]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(Object.values(store.get().questions).map((q) => q.n).sort()).toEqual([1, 2, 3]);
  });
});
