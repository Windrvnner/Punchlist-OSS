/**
 * A draft's reply is never dropped without a word. When it cannot be written, because changes from other PCs
 * keep reaching the folder first or the folder cannot be written, it waits and is written as soon as it can be: the draft
 * keeps showing as being written meanwhile, and a restart in between still writes it. Deal of 2,000 questions, three PCs.
 */
import { describe, it, expect, vi } from 'vitest';
import { Store } from '../../src/app/store';
import { FIRM } from '../../src/app/state';
import { memRepo, disk, refuse, toAQuestion, quota, type Disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetQuestionStatus, SetResponse } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, AcceptDraft, RecoverDrafts, DiscardDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { MemoryLocal } from '../../src/adapters/local';
import { draftAll } from '../../src/app/drafting';
import { ok } from '../../src/domain/result';
import type { Question } from '../../src/domain/model';

const COMMANDS = [CreateDeal, CreateQuestion, SetQuestionStatus, SetResponse, RequestDraft, ApplyDraft, AcceptDraft, RecoverDrafts, DiscardDraft, RestoreQuestionSnapshot, ImportQuestions, RevertImport, ResolveConflict, ReopenConflict];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const rowsFrom = (csv: string) => { const r = readCsv(new TextEncoder().encode(csv)); if (!r.ok) throw new Error('csv'); return prepareImport(r.value.rows, suggestMapping(r.value.columns)).rows; };
const settle = () => new Promise((r) => setTimeout(r, 0));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ELSEWHERE_OP = 'op_01HZZZZZZZZZZZZZZZZ9999999';
const TEXT = 'The cap is 20% of the contract price.';
const WS = ['Legal', 'Financial', 'Tax', 'Commercial', 'HR', 'IT'];
const PCS = [{ by: 'tdoe', from: 'Tablet' }, { by: 'sroe', from: 'Desk PC' }];
/** the folder cannot be written, as a network drive that dropped out says so */
const gone = () => Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });

/** A Store on this PC's disk, with every draft held open until the test lets the model answer. */
function open(d: Disk, local = new MemoryLocal(), clk = clock) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clk.now, d);
  let answer!: () => void; const held = new Promise<void>((r) => { answer = r; });
  const ai = { ...mockAi(opts, repo), draft: async () => { await held; return ok({ status: 'found' as const, text: TEXT, sources: [{ doc: 'EPC contract.pdf', loc: 'p. 82', docId: 'doc_epc' }] }); } };
  const fs = { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) };
  const docs = mockDocuments(opts);
  const session = mockSession(opts);
  const store = new Store({ repo, ai, docs, fs, sheets: csvCodec, session, local, clock: clk, ids }, COMMANDS);
  Object.assign(store.replyWait, { first: 20, max: 80 });
  return { store, repo, answer, local };
}

/** A deal of 2,000 questions on this PC; with `open`, only those (by index) are left without a response. */
async function world(openOnes?: (i: number) => boolean, putQuestions = importQuestions) {
  const d = disk(); const pc = open(d);
  await pc.store.boot(); await pc.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
  const dealId = Object.values(pc.store.get().deals)[0].id; await pc.store.loadDeal(dealId);
  const rows = rowsFrom(['No.,Question,Response', ...Array.from({ length: 2000 }, (_, i) => `${i + 1},"Question ${i + 1}: what is the position on item ${i * 7919 % 10007}?",${!openOnes || openOnes(i) ? '' : `"Answered in the data room, ${i}."`}`)].join('\n'));
  await putQuestions(pc.store, dealId, rows);
  const qs = () => Object.values(pc.store.get().questions).filter((q) => q.dealId === dealId).sort((a, b) => a.n - b.n);
  expect(qs().length).toBe(2000);
  const draft = async (q: Question) => { const r = await pc.store.dispatch(RequestDraft, { dealId, questionId: q.id }); expect(r.ok).toBe(true); return r.ok ? r.value.opId : ''; };
  return { ...pc, d, dealId, qs, draft, now: (id: string) => pc.store.get().questions[id] };
}
type World = Awaited<ReturnType<typeof world>>;

async function importQuestions(store: Store, dealId: string, rows: ReturnType<typeof rowsFrom>) {
  expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows }, { quiet: true })).ok).toBe(true);
}

/** Give the draft restart test the same saved questions without a separate import in its journal. */
async function seedQuestions(store: Store, dealId: string, rows: ReturnType<typeof rowsFrom>) {
  const input = ImportQuestions.input.parse({ dealId, mode: 'append', rows });
  const opId = ids.next('op');
  const at = clock.now();
  const actor = store.get().user?.name ?? 'Unknown';
  const planned = ImportQuestions.plan(store.get(), input, { at, actor, firm: FIRM, opId, ids });
  if (!planned.ok) throw new Error(planned.error.message);
  const { upserts, index } = planned.value;
  const seeded = await store.services.repo.transaction({
    writes: upserts.map(({ kind, record, expectedRev }) => ({ kind, id: record.id, data: record, expectedRev })),
    index,
  });
  if (!seeded.ok) throw new Error(seeded.error.message);
  await store.retryDeal(dealId);
}

/** each time this PC reads the question again, one of the two other PCs (having seen everything) changes it first: `n` times */
function crossAtReread(w: World, q: Question, n: number) {
  const get = w.repo.get.bind(w.repo); const fired = { n: 0 };
  w.repo.get = (async (kind: any, id: string) => {
    const r = await get(kind, id);
    if (kind === 'question' && id === q.id && fired.n < n) {
      const i = fired.n++; const cur = w.repo.peek('question', q.id)!.envelope.data as Question;
      w.repo.peer.change('question', q.id, { ...cur, status: 'closed', workstream: WS[i % WS.length], updatedAt: clock.now() }, { ...PCS[i % 2], at: clock.now() });
    }
    return r;
  }) as typeof w.repo.get;
  return fired;
}
/** every line in the shared folder that writes this question with the draft found */
const draftLines = (w: World, id: string) => w.repo.shared.list().flatMap((n) => (w.repo.shared.read(n) ?? '').split('\n')).filter((l) => l.includes(id) && l.includes('"status":"found"'));
/** the draft replies this PC's journal still holds as not written (a try that waits stays pending there) */
const pendingApply = (w: { repo: { local: { read(n: string): string | null } } }) => Object.values(JSON.parse(w.repo.local.read('ops.json') ?? '{}') as Record<string, { data: { command: string; state: string } }>).filter((e) => e.data.command === 'ApplyDraft' && (e.data.state === 'pending' || e.data.state === 'interrupted')).length;
async function until(cond: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!cond() && Date.now() < end) await pause(10); expect(cond()).toBe(true); }

describe('a draft reply that other PCs keep crossing', () => {
  it('fifteen changes from two PCs, one landing each time the question is read again: the reply still lands, once, on their latest version', async () => {
    const w = await world(); const q = w.qs()[1500];
    const opId = await w.draft(q);
    const fired = crossAtReread(w, q, 15);
    w.repo.peer.change('question', q.id, { ...(w.repo.peek('question', q.id)!.envelope.data as Question), status: 'closed', updatedAt: clock.now() }, { ...PCS[0], at: clock.now() });
    w.answer(); await w.store.settled(opId);
    await until(() => w.now(q.id).draft?.status === 'found');
    expect(fired.n).toBe(15);
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', workstream: WS[14 % WS.length], draft: { status: 'found', text: TEXT, opId } });
    expect(draftLines(w, q.id).length).toBe(1);
    await until(() => pendingApply(w) === 0);
    expect(w.store.liveRequests.has(opId)).toBe(false);
  });
});

describe('a draft reply while the folder cannot be written', () => {
  it('waits, still shown as being written, and is written once the folder is back; nothing asks the model again', async () => {
    const w = await world(); const q = w.qs()[77]; let asked = 0;
    const draftFn = w.store.services.ai.draft; w.store.services.ai.draft = (async (i: any) => { asked++; return draftFn(i); }) as any;
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(100);
    expect(w.store.get().net.down).toBe(true);
    expect(w.now(q.id).draft).toMatchObject({ status: 'pending', opId });          // not shown as failed: Retry there would pay for the model again
    expect(w.store.liveRequests.has(opId)).toBe(true);
    expect(pendingApply(w)).toBe(1);                                  // one try waits in the journal, not one per try
    expect(draftLines(w, q.id).length).toBe(0);
    back(); await w.store.probeOnce();
    await until(() => w.now(q.id).draft?.status === 'found');
    expect(w.store.get().net.down).toBe(false);
    expect(draftLines(w, q.id).length).toBe(1);
    await until(() => pendingApply(w) === 0);
    expect(asked).toBe(1);
  });

  it('a full disk: the reply waits and is written once there is room', async () => {
    const w = await world(); const q = w.qs()[1999];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, quota);
    w.answer(); await w.store.settled(opId); await pause(100);
    expect(w.now(q.id).draft?.status).toBe('pending');
    back();
    await until(() => w.now(q.id).draft?.status === 'found');
    expect(draftLines(w, q.id).length).toBe(1);
  });

  it('the app is closed while the reply waits: the next start writes it, and the draft is not given up on', async () => {
    const w = await world(); const q = w.qs()[500];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    expect(pendingApply(w)).toBe(1);
    // the app is closed: this window writes nothing more
    w.store.services.repo.transaction = (async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } })) as any;
    w.store.closing(); back();
    // the next start, on the same disk, with the folder back
    const again = open(w.d, w.local); Object.assign(again.store.replyWait, { first: 20, max: 80 });
    await again.store.boot(); await again.store.loadDeal(w.dealId);
    await until(() => again.store.get().questions[q.id]?.draft?.status === 'found');
    expect(again.store.get().questions[q.id].draft).toMatchObject({ text: TEXT, opId });
    await until(() => pendingApply(again) === 0);
    expect(Object.values(again.store.get().ops).filter((o) => o.state === 'interrupted')).toEqual([]);
  });

  it('another PC asks for the draft again while the reply waits: the old reply has nothing left to write, and stops waiting', async () => {
    const w = await world(); const q = w.qs()[901];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    back();
    const cur = w.repo.peek('question', q.id)!.envelope.data as Question;
    w.repo.peer.change('question', q.id, { ...cur, draft: { ...cur.draft!, opId: ELSEWHERE_OP, status: 'pending' }, updatedAt: clock.now() }, { ...PCS[1], at: clock.now() });
    await w.store.probeOnce();
    await until(() => !w.store.liveRequests.has(opId));
    expect(w.now(q.id).draft).toMatchObject({ status: 'pending', opId: ELSEWHERE_OP });
    expect(draftLines(w, q.id).length).toBe(0);
    expect(pendingApply(w)).toBe(0);
  });

  it('a failed model call is not kept: it shows as failed with Retry, as before', async () => {
    const w = await world(); const q = w.qs()[42];
    w.store.services.ai.draft = (async () => ({ ok: false, error: { kind: 'failed', message: 'The model did not answer' } })) as any;
    const opId = await w.draft(q);
    refuse(w.repo.shared, toAQuestion, gone);
    await w.store.settled(opId); await settle();
    expect(w.now(q.id).draft?.status).toBe('failed');
    expect(w.store.liveRequests.has(opId)).toBe(false);
    expect(pendingApply(w)).toBe(0);
  });
});

describe('at scale: 2,000 questions, three PCs', () => {
  it('Draft all with the folder out of reach does not stall; all 150 replies are written once it is back, crossed by the other PCs', async () => {
    // Draft all works on every question without a response: 150 of the 2,000
    const w = await world((i) => i % 13 === 5 && i < 13 * 150);
    const picked = w.qs().filter((q) => !q.response); expect(picked.length).toBe(150);
    // the folder drops out for the replies: each request is written, and its reply is not
    const stop = refuse(w.repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'), gone);
    w.answer(); await draftAll(w.store, w.dealId);                                  // ends, with the replies still waiting
    expect(picked.filter((q) => w.now(q.id).draft?.status === 'pending').length).toBe(150);
    expect(pendingApply(w)).toBe(150);
    // the other two PCs change half of them meanwhile
    for (const [i, q] of picked.entries()) if (i % 2) { const cur = w.repo.peek('question', q.id)!.envelope.data as Question; w.repo.peer.change('question', q.id, { ...cur, workstream: WS[i % WS.length], updatedAt: clock.now() }, { ...PCS[i % 2 ? 1 : 0], at: clock.now() }); }
    stop(); await w.store.probeOnce();
    await until(() => picked.every((q) => w.now(q.id).draft?.status === 'found'), 20000);
    expect(Object.keys(w.store.get().conflicts).length).toBe(0);
    for (const [i, q] of picked.entries()) { if (i % 2) expect(w.now(q.id).workstream).toBe(WS[i % WS.length]); expect(draftLines(w, q.id).length).toBe(1); }
    await until(() => pendingApply(w) === 0);
  }, 120000);
});

// Edge cases: each reproduced, then fixed.
describe('what waiting replies must not do', () => {
  const toastLog = (s: Store) => { const log: string[] = []; const orig = s.toast.bind(s); (s as any).toast = (text: string, a?: any, sticky?: boolean) => { log.push(text); return orig(text, a, sticky); }; return log; };

  it('the folder out while the model service answers: the offline bar does not come and go, and "Connected again" is said once', async () => {
    const w = await world(); const q = w.qs()[10]; const log = toastLog(w.store);
    const opId = await w.draft(q);
    refuse(w.repo.shared, () => true, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    for (let i = 0; i < 4; i++) { await w.store.probeOnce(); await pause(50); }
    expect(log.filter((t) => t === 'Connected again').length).toBeLessThanOrEqual(1);
    expect(w.store.liveRequests.has(opId) || w.store.hasKeptReply(opId)).toBe(true);   // still waiting, or kept for Retry
  });

  it('storage full: the notice says the draft is saved once there is room, and does not come back once dismissed', async () => {
    const w = await world(); const q = w.qs()[11];
    const opId = await w.draft(q);
    refuse(w.repo.shared, toAQuestion, quota);
    w.answer(); await w.store.settled(opId); await pause(30);
    const sticky = () => w.store.get().ui.toasts.filter((t) => t.sticky);
    expect(sticky().map((t) => [t.text, t.action?.label])).toEqual([['Draft not saved: storage is full ·',
      'Retry Now']]);
    for (let i = 0; i < 3; i++) { for (const t of sticky()) w.store.dismissToast(t.id); await pause(120); expect(sticky()).toEqual([]); }
  });

  it('a restart where the question cannot be read at first: the reply is not taken for one with nothing to write', async () => {
    const w = await world(); const q = w.qs()[14];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    w.store.services.repo.transaction = (async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } })) as any;
    w.store.closing(); back();
    const again = open(w.d, w.local);
    const get = again.repo.get.bind(again.repo); let once = true;
    again.repo.get = (async (k: any, id: string) => { if (once && k === 'question' && id === q.id) { once = false; return { ok: false, error: { kind: 'unreachable', message: 'x' } }; } return get(k, id); }) as any;
    await again.store.boot(); await pause(80); await again.store.loadDeal(w.dealId);
    await until(() => again.store.get().questions[q.id]?.draft?.status === 'found');
    expect(draftLines(again as any, q.id).length).toBe(1);
  });

  it('a failed model call crossed by another PC is still saved as failed, so other PCs offer Retry', async () => {
    const w = await world(); const q = w.qs()[19];
    w.store.services.ai.draft = (async () => { await pause(20); return { ok: false, error: { kind: 'failed', message: 'The model did not answer' } }; }) as any;
    const opId = await w.draft(q);
    const cur = w.repo.peek('question', q.id)!.envelope.data as Question;
    w.repo.peer.change('question', q.id, { ...cur, status: 'closed', updatedAt: clock.now() }, { ...PCS[0], at: clock.now() });
    await w.store.settled(opId); await pause(30);
    expect((w.repo.peek('question', q.id)!.envelope.data as Question).draft?.status).toBe('failed');
  });

  it('two windows of this PC: the one that waits on the reply closes, and the one still open writes it', async () => {
    const w = await world(); const q = w.qs()[18];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    const b = new Store({ ...w.store.services }, [...(w.store as any).commands.values()]);
    Object.assign(b.replyWait, { first: 20, max: 80 });
    await b.boot(); await b.loadDeal(w.dealId);
    await pause(300);                                                              // window A tries again meanwhile, each try in place of the last
    const A: any = w.store; A.tryReply = async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } }); A.stamp = () => undefined;
    w.store.closing(); back();
    await until(() => b.get().questions[q.id]?.draft?.status === 'found', 30_000);
    expect(draftLines(w, q.id).length).toBe(1);
    await until(() => pendingApply(w) === 0);
  }, 45_000);
});

// Edge cases: each reproduced, then fixed.
describe('waiting replies across restarts and windows', () => {
  const throwingWriteCase = 'a try whose write throws while the reply waits, then the app closes: '
    + 'the next start still writes it';
  it(throwingWriteCase, async ({ onTestFinished, signal }) => {
    const w = await world(undefined, seedQuestions);
    signal.throwIfAborted();
    const q = w.qs()[600];
    let restoreFolder: (() => void) | undefined;
    let closed = false;
    const closeWindow = () => {
      if (closed) return;
      closed = true;
      w.repo.transaction = async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } });
      w.store.closing();
      vi.useRealTimers();
      restoreFolder?.();
    };
    // The test timeout cannot stop a pending retry or run this body's finally block.
    onTestFinished(closeWindow);
    // The request starts the old window's heartbeat. Close must discard it along with the retry timer.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      const opId = await w.draft(q);
      signal.throwIfAborted();
      restoreFolder = refuse(w.repo.shared, toAQuestion, gone);
      w.answer();
      await w.store.settled(opId);
      signal.throwIfAborted();
      expect(pendingApply(w)).toBe(1);
      const write = w.repo.transaction.bind(w.repo);
      const fault = vi.fn(() => {
        throw new Error('adapter fault');
      });
      w.repo.transaction = async (transaction) =>
        transaction.writes.some(({ kind }) => kind === 'question') ? fault() : write(transaction);
      await vi.advanceTimersByTimeAsync(w.store.replyWait.first);
      signal.throwIfAborted();
      expect(fault).toHaveBeenCalledOnce();
    } finally {
      closeWindow();
    }
    const again = open(w.d, w.local);
    await again.store.boot();
    await again.store.loadDeal(w.dealId);
    await until(() => again.store.get().questions[q.id]?.draft?.status === 'found');
  });

  it('two journal entries for one waiting reply at a restart: one try, the draft still shown as being written, both settled once it is written', async () => {
    const w = await world(); const q = w.qs()[700];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    // duplicate the pending entry, as the moment between the new try's entry and the old one's settling leaves it
    const ops = JSON.parse(w.repo.local.read('ops.json')!);
    const [k, e] = Object.entries(ops).find(([, v]: any) => v.data.command === 'ApplyDraft' && v.data.state === 'pending') as any;
    const dupId = 'op_01HZZZZZZZZZZZZZZZZ8888888';
    w.store.services.repo.transaction = (async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } })) as any;
    w.store.closing();
    const dupKey = k.replace(e.data.id, dupId);
    ops[dupKey] = JSON.parse(JSON.stringify(e).split(e.data.id).join(dupId));
    w.repo.local.write('ops.json', JSON.stringify(ops));
    expect(pendingApply(w)).toBe(2);
    // the folder is still out at the restart
    const again = open(w.d, w.local); Object.assign(again.store.replyWait, { first: 20, max: 80 });
    await again.store.boot(); await again.store.loadDeal(w.dealId); await pause(200);
    expect(again.store.get().questions[q.id].draft?.status).toBe('pending');
    expect(again.store.liveRequests.has(opId)).toBe(true);
    back(); await again.store.probeOnce();
    await until(() => again.store.get().questions[q.id]?.draft?.status === 'found');
    expect(draftLines(again as any, q.id).length).toBe(1);
    await until(() => pendingApply(again) === 0);
  });

  it('a restart where the question cannot be read yet: the reply is not offered as an interrupted action, and is written once it can be read', async () => {
    const w = await world(); const q = w.qs()[800];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    w.store.services.repo.transaction = (async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } })) as any;
    w.store.closing(); back();
    const again = open(w.d, w.local); Object.assign(again.store.replyWait, { first: 20, max: 80 });
    const get = again.repo.get.bind(again.repo); let down = true;
    again.repo.get = (async (k: any, id: string) => { if (down && k === 'question' && id === q.id) return { ok: false, error: { kind: 'unreachable', message: 'x' } }; return get(k, id); }) as any;
    await again.store.boot(); await pause(150);
    expect(Object.values(again.store.get().ops).filter((o) => o.state === 'interrupted')).toEqual([]);
    down = false; await again.store.loadDeal(w.dealId);
    await until(() => (again.repo.peek('question', q.id)!.envelope.data as Question).draft?.status === 'found');
  });

  it('the folder out, then back but full: the full disk is still said', async () => {
    const w = await world(); const q = w.qs()[900];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    expect(w.store.get().net.down).toBe(true);
    back(); refuse(w.repo.shared, toAQuestion, quota);
    await w.store.probeOnce(); await pause(300);
    const toasts = w.store.get().ui.toasts.map((t) => t.text);
    expect(toasts.some((t) => /storage is full/.test(t))).toBe(true);
  });

  it('a second window opened before the draft was asked for: the first closes while its reply waits, and the open one writes it', async () => {
    const w = await world(); const q = w.qs()[1200];
    const b = new Store({ ...w.store.services }, [...(w.store as any).commands.values()]);
    Object.assign(b.replyWait, { first: 20, max: 80 });
    await b.boot(); await b.loadDeal(w.dealId);
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, gone);
    w.answer(); await w.store.settled(opId); await pause(50);
    const A: any = w.store; A.tryReply = async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } }); A.stamp = () => undefined;
    w.store.closing(); back(); await b.probeOnce();
    t += 16 * 60_000;                                                   // a quarter of an hour on
    await b.retryDeal(w.dealId);
    await until(() => (w.repo.peek('question', q.id)!.envelope.data as Question).draft?.status === 'found');
  }, 30_000);
});

// Edge cases: each reproduced, then fixed.
describe('waiting replies stay cheap and end when they cannot be written', () => {
  it('300 replies wait while the folder is out: a round costs one refused try, and the journal does not grow', async () => {
    const w = await world((i) => i < 300);
    const stop = refuse(w.repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'), gone);
    Object.assign(w.store.replyWait, { first: 60_000, max: 60_000 });              // rounds only when the test asks for them
    w.answer(); await draftAll(w.store, w.dealId);
    expect(pendingApply(w)).toBe(300);
    const entries = () => Object.keys(JSON.parse(w.repo.local.read('ops.json') ?? '{}')).length;
    const before = entries(); let writes = 0; const wr = w.repo.local.write.bind(w.repo.local);
    w.repo.local.write = (n: string, t: string) => { if (n === 'ops.json') writes++; wr(n, t); };
    for (let c = 0; c < 3; c++) await (w.store as any).tryWaiting();
    expect(entries()).toBe(before);
    expect(writes).toBeLessThanOrEqual(3 * 4);
    expect(pendingApply(w)).toBe(300);
    stop(); await w.store.probeOnce();
    await until(() => w.qs().filter((q) => !q.response).every((q) => w.now(q.id).draft?.status === 'found'), 20_000);
    await until(() => pendingApply(w) === 0);
  }, 120_000);

  it('a write that keeps failing for another reason stops after a few tries: the draft shows as failed with Retry, and the next start tries once more', async () => {
    const w = await world(); const q = w.qs()[300];
    const opId = await w.draft(q);
    const back = refuse(w.repo.local, (text) => text.includes('"kind":"question"') && text.includes('"status":"found"'), () => new Error('EPERM: operation not permitted'));
    w.answer(); await w.store.settled(opId);
    await until(() => !w.store.liveRequests.has(opId));
    expect(w.now(q.id).draft?.status).toBe('failed');
    expect(pendingApply(w)).toBe(1);
    w.store.services.repo.transaction = (async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } })) as any;
    w.store.closing(); back();
    const again = open(w.d, w.local); await again.store.boot(); await again.store.loadDeal(w.dealId);
    await until(() => again.store.get().questions[q.id]?.draft?.status === 'found');
  });

  it('this PC\'s journal refuses the reply\'s entry for a while (a scanner holding it): the tries run out, and Retry writes the kept text', async () => {
    const w = await world(); const q = w.qs()[301];
    const opId = await w.draft(q);
    const wr = w.repo.local.write.bind(w.repo.local); let block = true;
    w.repo.local.write = (n: string, t: string) => { if (block && n === 'ops.json' && t.includes('"command":"ApplyDraft"')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); wr(n, t); };
    w.answer(); await w.store.settled(opId);
    await until(() => !w.store.liveRequests.has(opId));
    expect(w.now(q.id).draft?.status).toBe('failed');
    expect(w.store.hasKeptReply(opId)).toBe(true);
    block = false;
    w.store.retryKeptReply(opId);
    expect(w.now(q.id).draft?.status).not.toBe('failed');
    await until(() => w.now(q.id).draft?.status === 'found');
    expect(draftLines(w, q.id).length).toBe(1);
  });

  it('a folder out longer than the five tries: the draft shows failed, Retry writes the kept text without asking the model, and so does the folder coming back', async () => {
    const w = await world(); let asked = 0;
    const draftFn = w.store.services.ai.draft; w.store.services.ai.draft = (async (i: any) => { asked++; return draftFn(i); }) as any;
    const [q1, q2] = [w.qs()[1100], w.qs()[1101]];
    const op1 = await w.draft(q1); const op2 = await w.draft(q2);
    const back = refuse(w.repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'), gone);
    w.answer(); await w.store.settled(op1); await w.store.settled(op2);
    await until(() => !w.store.liveRequests.has(op1) && !w.store.liveRequests.has(op2));
    expect([w.now(q1.id).draft?.status, w.now(q2.id).draft?.status]).toEqual(['failed', 'failed']);
    expect(pendingApply(w)).toBe(2);                                                // kept for the next start too
    back();
    w.store.retryKeptReply(op1);                                                    // the person presses Retry on Q1
    await until(() => w.now(q1.id).draft?.status === 'found');
    expect(w.now(q2.id).draft?.status).toBe('failed');
    await w.store.probeOnce();                                                      // the folder is back: Q2's kept text is written too
    await until(() => w.now(q2.id).draft?.status === 'found');
    expect(asked).toBe(2);
    expect([draftLines(w, q1.id).length, draftLines(w, q2.id).length]).toEqual([1, 1]);
    await until(() => pendingApply(w) === 0);
  });

  it('Draft all over drafts whose tries ran out writes their kept text and asks the model for none of them', async () => {
    const w = await world((i) => i >= 600 && i < 640); let asked = 0;
    const draftFn = w.store.services.ai.draft; w.store.services.ai.draft = (async (i: any) => { asked++; return draftFn(i); }) as any;
    const back = refuse(w.repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'), gone);
    w.answer(); await draftAll(w.store, w.dealId);
    const picked = w.qs().filter((q) => !q.response); expect(picked.length).toBe(40);
    await until(() => picked.every((q) => w.now(q.id).draft?.status === 'failed'));
    expect(asked).toBe(40);
    back(); await draftAll(w.store, w.dealId);
    await until(() => picked.every((q) => w.now(q.id).draft?.status === 'found'), 10_000);
    expect(asked).toBe(40);
  }, 60_000);


  // Edge cases: each reproduced, then fixed.
  it('a stopped reply\'s journal entry outlives journal pruning, so the next start writes it', async () => {
    const w = await world(); const q = w.qs()[1100];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'), gone);
    w.answer(); await w.store.settled(opId);
    await until(() => w.store.hasKeptReply(opId));
    expect(pendingApply(w)).toBe(1);
    // a person keeps working: 300 small changes on other questions
    const others = w.qs().slice(0, 300);
    for (const o of others) await w.store.dispatch(SetQuestionStatus, { dealId: w.dealId, questionId: o.id, status: 'closed' } as any, { quiet: true });
    await pause(100);
    expect(pendingApply(w)).toBe(1);
    // restart with the folder back
    w.store.services.repo.transaction = (async () => ({ ok: false, error: { kind: 'unreachable', message: 'closed' } })) as any;
    w.store.closing(); back();
    const again = open(w.d, w.local); Object.assign(again.store.replyWait, { first: 20, max: 80 });
    await again.store.boot(); await again.store.loadDeal(w.dealId);
    await until(() => again.store.get().questions[q.id]?.draft?.status === 'found');
  }, 60_000);

  it('storage full until the tries run out: the notice\'s Retry now writes the kept text once there is room', async () => {
    const w = await world(); const q = w.qs()[11];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, toAQuestion, quota);
    w.answer(); await w.store.settled(opId);
    await until(() => w.store.hasKeptReply(opId));
    const sticky = w.store.get().ui.toasts.filter((t) => t.sticky);
    back(); for (const t of sticky) t.action?.run?.();
    await until(() => w.now(q.id).draft?.status === 'found');
  });

  it('another window writes a stopped reply once this one stops stamping, and Retry here does not write it a second time', async () => {
    const w = await world(); const q = w.qs()[1200];
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'), gone);
    w.answer(); await w.store.settled(opId);
    await until(() => w.store.hasKeptReply(opId));
    back();
    t += 16 * 60_000;
    const b = new Store({ ...w.store.services }, [...(w.store as any).commands.values()]);
    Object.assign(b.replyWait, { first: 20, max: 80 });
    await b.boot(); await b.loadDeal(w.dealId);
    await until(() => (w.repo.peek('question', q.id)!.envelope.data as Question).draft?.status === 'found');
    w.store.retryKeptReply(opId); await pause(300);
    expect(draftLines(w, q.id).length).toBe(1);
  }, 30_000);
});

// Edge cases: each reproduced, then fixed.
describe('every reply gets its own five tries, start-up waits its turn, and two versions keep the text', () => {
  it('a reply that starts waiting while another has waited a while still gets five tries, the first after the shortest gap', async () => {
    const w = await world(); const [q1, q2] = [w.qs()[100], w.qs()[101]];
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const attempts: number[] = [];
      const append = w.repo.shared.append.bind(w.repo.shared);
      w.repo.shared.append = (file: string, text: string) => {
        if (text.includes('"status":"found"')) {
          if (text.includes(q2.id)) attempts.push(Date.now());
          throw gone();
        }
        append(file, text);
      };
      const op1 = await w.draft(q1);
      w.answer();
      await w.store.settled(op1);
      await vi.advanceTimersByTimeAsync(150);

      const op2 = await w.draft(q2);
      await w.store.settled(op2);
      await vi.advanceTimersByTimeAsync(220);
      expect(w.store.hasKeptReply(op2)).toBe(true);
      expect(attempts.map((at) => at - attempts[0])).toEqual([0, 20, 60, 140, 220]);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it('500 stopped replies and a restart with the disk still full: one refused write and a few journal writes, not one each', async () => {
    const w = await world((i) => i < 500);
    const stop = refuse(w.repo.shared, (text) => toAQuestion(text) && text.includes('"status":"found"'), quota);
    w.answer(); await draftAll(w.store, w.dealId);
    const picked = w.qs().filter((q) => !q.response);
    await until(() => picked.every((q) => w.store.hasKeptReply(q.draft!.opId!)), 30_000);
    expect(pendingApply(w)).toBe(500);
    w.store.closing();
    let refused = 0, opsWrites = 0; const ap = w.d.shared.append.bind(w.d.shared);
    w.d.shared.append = (f: string, t: string) => { if (t.includes('"status":"found"')) refused++; ap(f, t); };
    const wr = w.d.local.write.bind(w.d.local); w.d.local.write = (n: string, t: string) => { if (n === 'ops.json') opsWrites++; wr(n, t); };
    const again = open(w.d, w.local); Object.assign(again.store.replyWait, { first: 60_000, max: 60_000 });
    await again.store.boot(); await again.store.loadDeal(w.dealId); await pause(1000);
    expect(refused).toBeLessThanOrEqual(1);
    expect(opsWrites).toBeLessThan(20);
    expect(pendingApply(again)).toBe(500);
    stop(); await again.store.probeOnce();
    await until(() => picked.every((q) => again.store.get().questions[q.id]?.draft?.status === 'found'), 30_000);
    await until(() => pendingApply(again) === 0, 10_000);
  }, 180_000);

  it('the question gets two versions while the reply waits: the text is kept, and once a version is chosen Retry writes it without asking the model (#22)', async () => {
    const w = await world(); const q = w.qs()[300]; let asked = 0;
    const draftFn = w.store.services.ai.draft; w.store.services.ai.draft = (async (i: any) => { asked++; return draftFn(i); }) as any;
    const opId = await w.draft(q);
    const back = refuse(w.repo.shared, (t) => toAQuestion(t) && t.includes('"status":"found"'), quota);
    w.answer(); await w.store.settled(opId); await pause(10);
    // this PC types a response, and another PC closes the question without having seen it: two versions
    const base = w.repo.peek('question', q.id)!.envelope.data as Question;
    expect((await w.store.dispatch(SetResponse, { dealId: w.dealId, questionId: q.id, response: 'Typed here' } as any, { quiet: true })).ok).toBe(true);
    expect(w.repo.peer.edit('question', q.id, { ...base, status: 'closed', updatedAt: clock.now() }, { ...PCS[0], at: clock.now() })).toBe('conflict');
    await w.store.loadDeal(w.dealId); await (w.store as any).reloadTargets([q.id]);
    back();
    await until(() => !w.store.liveRequests.has(opId), 5000);
    expect(w.now(q.id).draft?.status).toBe('failed');
    expect(w.store.hasKeptReply(opId)).toBe(true);
    expect(pendingApply(w)).toBe(1);                                               // kept for the next start too
    await until(() => w.store.get().ui.toasts.some((t) => t.text === `Draft not saved: Q${q.n} has versions to choose between`));
    const c = w.store.get().conflicts[q.id]; const mine = c.versions.find((v) => (v.data as Question | null)?.response === 'Typed here')!;
    expect((await w.store.dispatch(ResolveConflict, { dealId: w.dealId, recordId: q.id, keep: mine.id })).ok).toBe(true);
    w.store.retryKeptReply(opId);
    await until(() => w.now(q.id).draft?.status === 'found');
    expect(asked).toBe(1);
    expect(w.now(q.id).response).toBe('Typed here');
    await until(() => pendingApply(w) === 0);
  }, 30_000);
});

// More edge cases.
describe('held drafts are said once, by count', () => {
  it('120 questions get two versions while their drafts wait: one notice with the count, none from Retry now, and Retry on three updates it in place', async () => {
    const w = await world((i) => i < 120); let asked = 0;
    const draftFn = w.store.services.ai.draft; w.store.services.ai.draft = (async (i: any) => { asked++; return draftFn(i); }) as any;
    const back = refuse(w.repo.shared, (t) => toAQuestion(t) && t.includes('"status":"found"'), quota);
    w.answer(); await draftAll(w.store, w.dealId);
    const picked = w.qs().filter((q) => !q.response); expect(picked.length).toBe(120);
    for (const q of picked) {                                                       // this PC types a response, and another PC closes the question unseen
      const base = w.repo.peek('question', q.id)!.envelope.data as Question;
      expect((await w.store.dispatch(SetResponse, { dealId: w.dealId, questionId: q.id, response: 'Typed here' } as any, { quiet: true })).ok).toBe(true);
      w.repo.peer.edit('question', q.id, { ...base, status: 'closed', updatedAt: clock.now() }, { ...PCS[0], at: clock.now() });
    }
    await (w.store as any).reloadTargets(picked.map((q) => q.id));
    const said: string[] = []; const toast = w.store.toast.bind(w.store);
    (w.store as any).toast = (text: string, ...rest: any[]) => { said.push(text); return toast(text, ...rest); };
    back(); await w.store.probeOnce();
    await until(() => picked.every((q) => w.store.hasKeptReply(q.draft!.opId!)), 20_000);
    await pause(400);
    const held = () => said.filter((t) => t.includes('versions to choose between'));
    expect(held()).toEqual(['Draft not saved: 120 questions have versions to choose between']);
    (w.store as any).retryNow.run(); await pause(400);
    expect(held().length).toBe(1);                                                  // Retry now leaves held drafts: only choosing a version helps
    for (const q of picked.slice(0, 3)) w.store.retryKeptReply(q.draft!.opId!);    // the person presses Retry on three of them
    await pause(400);
    // the three are counted in the notice still showing, which already counts them: no new notice
    expect(held()).toEqual(['Draft not saved: 120 questions have versions to choose between']);
    expect(w.store.get().ui.toasts.filter((t) => t.text.includes('versions to choose between')).length).toBe(1);
    expect(asked).toBe(120);
    expect(picked.every((q) => w.store.hasKeptReply(q.draft!.opId!))).toBe(true);
  }, 120_000);
});

describe('held drafts answered one after another', () => {
  it('six drafts held 400 ms apart share one notice, its count updated, and an Undo on screen stays', async () => {
    const w = await world((i) => i >= 40 && i < 46);
    const gates: (() => void)[] = []; const draftFn = w.store.services.ai.draft;
    w.store.services.ai.draft = (async (i: any) => { await new Promise<void>((r) => gates.push(r)); return draftFn(i); }) as any;
    w.answer();
    const picked = w.qs().filter((q) => !q.response); expect(picked.length).toBe(6);
    const reqs: string[] = []; for (const q of picked) reqs.push(await w.draft(q));
    await until(() => gates.length === 6);
    for (const q of picked) {                                                       // this PC types a response, and another PC closes the question unseen
      const base = w.repo.peek('question', q.id)!.envelope.data as Question;
      expect((await w.store.dispatch(SetResponse, { dealId: w.dealId, questionId: q.id, response: 'Typed here' } as any, { quiet: true })).ok).toBe(true);
      w.repo.peer.edit('question', q.id, { ...base, status: 'closed', updatedAt: clock.now() }, { ...PCS[0], at: clock.now() });
    }
    await (w.store as any).reloadTargets(picked.map((q) => q.id));
    w.store.toast('Q501 marked closed', { label: 'Undo', opId: 'op_01HZZZZZZZZZZZZZZZZ8888888' });
    w.store.holdToasts();                                                           // the pointer rests on the notices: none times out meanwhile
    for (const open of gates) { open(); await pause(400); }
    await until(() => reqs.every((r) => w.store.hasKeptReply(r)), 10_000);
    await pause(400);
    const shown = w.store.get().ui.toasts.map((t) => t.text);
    expect(shown.filter((t) => t.includes('versions to choose between'))).toEqual(['Draft not saved: 6 questions have versions to choose between']);
    expect(shown).toContain('Q501 marked closed');
  }, 60_000);
});

describe('the held notice counts only drafts still held, and changes in place', () => {
  it('three held, one saved by Retry, then one more held: the notice reads 2, then 3, and stays where it was, ahead of the Undo', async () => {
    const w = await world((i) => i >= 60 && i < 64);
    const gates: (() => void)[] = []; const draftFn = w.store.services.ai.draft;
    w.store.services.ai.draft = (async (i: any) => { await new Promise<void>((r) => gates.push(r)); return draftFn(i); }) as any;
    w.answer();
    const picked = w.qs().filter((q) => !q.response); expect(picked.length).toBe(4);
    const reqs: string[] = []; for (const q of picked) reqs.push(await w.draft(q));
    await until(() => gates.length === 4);
    for (const q of picked) {                                                       // this PC types a response, and another PC closes the question unseen
      const base = w.repo.peek('question', q.id)!.envelope.data as Question;
      expect((await w.store.dispatch(SetResponse, { dealId: w.dealId, questionId: q.id, response: 'Typed here' } as any, { quiet: true })).ok).toBe(true);
      w.repo.peer.edit('question', q.id, { ...base, status: 'closed', updatedAt: clock.now() }, { ...PCS[0], at: clock.now() });
    }
    await (w.store as any).reloadTargets(picked.map((q) => q.id));
    w.store.holdToasts();
    for (const open of gates.slice(0, 3)) open();
    await until(() => reqs.slice(0, 3).every((r) => w.store.hasKeptReply(r)), 10_000);
    await pause(400);
    const held = () => w.store.get().ui.toasts.filter((t) => t.text.includes('versions to choose between'));
    expect(held().map((t) => t.text)).toEqual(['Draft not saved: 3 questions have versions to choose between']);
    const id = held()[0].id;
    w.store.toast('Q501 marked closed', { label: 'Undo', opId: 'op_01HZZZZZZZZZZZZZZZZ8888888' });
    // in place: the same notice, still ahead of the Undo (choosing a version says so in a notice of its own, which may push the oldest out)
    const inPlace = () => { const ids = w.store.get().ui.toasts.map((t) => t.id); const undo = w.store.get().ui.toasts.findIndex((t) => t.text === 'Q501 marked closed'); return undo > 0 && ids.indexOf(id) === undo - 1; };
    // a version is chosen for the first, and its Retry saves the kept text: the notice counts two, in place
    const c = w.store.get().conflicts[picked[0].id]; const mine = c.versions.find((v) => (v.data as Question | null)?.response === 'Typed here')!;
    expect((await w.store.dispatch(ResolveConflict, { dealId: w.dealId, recordId: picked[0].id, keep: mine.id })).ok).toBe(true);
    w.store.retryKeptReply(reqs[0]);
    await until(() => w.now(picked[0].id).draft?.status === 'found');
    await until(() => held()[0]?.text === 'Draft not saved: 2 questions have versions to choose between');
    expect(inPlace()).toBe(true);
    // one more is held: three, not four, and still in place
    gates[3]();
    await until(() => w.store.hasKeptReply(reqs[3]), 10_000); await pause(400);
    expect(held().map((t) => [t.id, t.text])).toEqual([[id, 'Draft not saved: 3 questions have versions to choose between']]);
    expect(inPlace()).toBe(true);
  }, 60_000);
});

describe('the held notice with a slow journal, and a held draft discarded', () => {
  /** four open questions with drafts in flight, the model held per draft; each question then in two versions */
  async function heldWorld() {
    const w = await world((i) => i >= 80 && i < 84);
    const gates: (() => void)[] = []; const draftFn = w.store.services.ai.draft;
    w.store.services.ai.draft = (async (i: any) => { await new Promise<void>((r) => gates.push(r)); return draftFn(i); }) as any;
    w.answer();
    const picked = w.qs().filter((q) => !q.response); expect(picked.length).toBe(4);
    const reqs: string[] = []; for (const q of picked) reqs.push(await w.draft(q));
    await until(() => gates.length === 4);
    for (const q of picked) {
      const base = w.repo.peek('question', q.id)!.envelope.data as Question;
      expect((await w.store.dispatch(SetResponse, { dealId: w.dealId, questionId: q.id, response: 'Typed here' } as any, { quiet: true })).ok).toBe(true);
      w.repo.peer.edit('question', q.id, { ...base, status: 'closed', updatedAt: clock.now() }, { ...PCS[0], at: clock.now() });
    }
    await (w.store as any).reloadTargets(picked.map((q) => q.id));
    w.store.holdToasts();
    const held = () => w.store.get().ui.toasts.filter((t) => t.text.includes('versions to choose between')).map((t) => t.text);
    return { w, gates, picked, reqs, held };
  }

  it('this PC\'s journal takes 600 ms to write a held draft\'s entry: the notice still counts it, alone and as a fourth', async () => {
    const { w, gates, picked, reqs, held } = await heldWorld();
    const tx = w.store.services.repo.transaction.bind(w.store.services.repo);
    w.store.services.repo.transaction = (async (t: any) => { if (t.writes?.some((x: any) => x.kind === 'op' && x.data?.command === 'ApplyDraft')) await pause(600); return tx(t); }) as any;
    gates[0]();
    await until(() => w.store.hasKeptReply(reqs[0]), 10_000); await pause(400);
    expect(held()).toEqual([`Draft not saved: Q${picked[0].n} has versions to choose between`]);
    gates[1](); gates[2]();
    await until(() => w.store.hasKeptReply(reqs[1]) && w.store.hasKeptReply(reqs[2]), 10_000); await pause(400);
    expect(held()).toEqual(['Draft not saved: 3 questions have versions to choose between']);
    gates[3]();
    await until(() => w.store.hasKeptReply(reqs[3]), 10_000); await pause(400);
    expect(held()).toEqual(['Draft not saved: 4 questions have versions to choose between']);
  }, 60_000);

  it('a held draft discarded once its version is chosen is no longer counted', async () => {
    const { w, gates, picked, reqs, held } = await heldWorld();
    for (const open of gates.slice(0, 3)) open();
    await until(() => reqs.slice(0, 3).every((r) => w.store.hasKeptReply(r)), 10_000); await pause(400);
    expect(held()).toEqual(['Draft not saved: 3 questions have versions to choose between']);
    const c = w.store.get().conflicts[picked[0].id]; const mine = c.versions.find((v) => (v.data as Question | null)?.response === 'Typed here')!;
    expect((await w.store.dispatch(ResolveConflict, { dealId: w.dealId, recordId: picked[0].id, keep: mine.id })).ok).toBe(true);
    expect((await w.store.dispatch(DiscardDraft, { dealId: w.dealId, questionId: picked[0].id })).ok).toBe(true);
    expect(held()).toEqual(['Draft not saved: 2 questions have versions to choose between']);
    expect(w.now(picked[0].id).response).toBe('Typed here');
  }, 60_000);
});

describe('a PC whose clock differs from the drafting PC\'s (#24)', () => {
  /** a clock `ahead` minutes ahead of this test's own, which can be moved on */
  const clockAhead = (ahead: number) => {
    const at = { offset: ahead * 60_000 };
    const shifted = { now: () => new Date(Date.parse(clock.now()) + at.offset).toISOString() };
    return { ...shifted, moveOn: (minutes: number) => { at.offset += minutes * 60_000; } };
  };
  /** another PC on the same shared folder, with its own disk, local store, and clock */
  const otherPc = async (w: World, local: MemoryLocal, clk: ReturnType<typeof clockAhead>, own = disk()) => {
    const pc = open({ shared: w.d.shared, local: own.local }, local, clk);
    await pc.store.boot(); await pc.store.loadDeal(w.dealId);
    return { ...pc, own };
  };

  for (const ahead of [20, 60]) {
    it(`a clock ${ahead} minutes ahead leaves a draft still being written alone, on 2,000 questions`, async () => {
      const w = await world(); const q = w.qs()[1499];
      const opId = await w.draft(q);
      const localB = new MemoryLocal(); const clockB = clockAhead(ahead);
      const b = await otherPc(w, localB, clockB);
      expect(b.store.get().questions[q.id].draft).toMatchObject({ status: 'pending', opId });
      w.answer(); await w.store.settled(opId);
      expect(w.now(q.id).draft).toMatchObject({ status: 'found', text: TEXT });
      await b.repo.sync(); await settle();
      expect(b.store.get().questions[q.id].draft).toMatchObject({ status: 'found', text: TEXT });
    });
  }

  it('B stays open: the draft is given up 15 minutes after B first saw it, with one look set', async () => {
    const w = await world(); const q = w.qs()[1499];
    await w.draft(q);
    const clockB = clockAhead(20);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const opening = otherPc(w, new MemoryLocal(), clockB); await vi.advanceTimersByTimeAsync(50);
      const b = await opening;
      const timers = vi.getTimerCount();
      const look = () => (b.store as any).recoverDrafts(w.dealId) as Promise<void>;
      await look(); await look();                                    // looked at again: no second look is set
      expect(vi.getTimerCount()).toBe(timers);
      clockB.moveOn(14); await vi.advanceTimersByTimeAsync(14 * 60_000);
      expect(b.store.get().questions[q.id].draft?.status).toBe('pending');
      clockB.moveOn(2); await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(b.store.get().questions[q.id].draft?.status).toBe('failed');
    } finally { vi.useRealTimers(); w.answer(); }
  });

  it('B restarts halfway, then gives the draft up once it has seen it for 15 minutes by its own clock', async () => {
    const w = await world(); const q = w.qs()[1499];
    const opId = await w.draft(q);
    const localB = new MemoryLocal(); const clockB = clockAhead(20);
    const first = await otherPc(w, localB, clockB);
    clockB.moveOn(10);                                                               // B restarts 10 minutes on
    const again = await otherPc(w, localB, clockB, first.own);
    expect(again.store.get().questions[q.id].draft?.status).toBe('pending');
    clockB.moveOn(6);                                                                // 16 minutes after B first saw it
    const later = await otherPc(w, localB, clockB, first.own);
    expect(later.store.get().questions[q.id].draft?.status).toBe('failed');
    w.answer(); await w.store.settled(opId);                                         // the reply still lands
    expect(w.now(q.id).draft).toMatchObject({ status: 'found', text: TEXT });
  });
});
