import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuseNext, refuse, quota, toAQuestion, ELSEWHERE, type MemRepo } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment } from '../../src/app/commands/findings';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { isDraftStale } from '../../src/domain/transitions';
import { draftAll, typingIn, eligibleForDraft } from '../../src/app/drafting';
import type { AiService } from '../../src/ports';
import { ok, fail } from '../../src/domain/result';

const COMMANDS = [CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// These tests are about what the app does with a draft, so the draft itself is a fixed stand-in: found, with two sources.
const foundDraft: AiService['draft'] = async (i) => ok({ status: 'found', text: `The documents bear on this: ${i.questionText}`, sources: [{ doc: 'Information memorandum.pdf', loc: 'p. 22', docId: 'doc_im' }, { doc: 'Credit agreement (draft 1).pdf', loc: 'p. 142', docId: 'doc_fa' }] });
function make(ai?: Partial<AiService>, kv = disk()) {
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo: memRepo(clock.now, kv), ai: { ...mockAi(opts), draft: foundDraft, ...ai }, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, kv };
}
async function dealWithQuestion(store: Store, text = 'Please confirm the lock-up test.') {
  await store.boot();
  await store.dispatch(CreateDeal, { name: 'Datum', folders: [] });
  const dealId = Object.keys(store.get().deals)[0];
  await store.dispatch(CreateQuestion, { dealId, text });
  const qid = Object.keys(store.get().questions)[0];
  return { dealId, qid };
}
const settle = async (store: Store, qid: string, status: string, tries = 50) => { for (let i = 0; i < tries; i++) { if (store.get().questions[qid]?.draft?.status === status) return; await sleep(10); } };

describe('drafts', () => {
  it('request → pending → found, then accept records response, provenance, responder, date and status in one operation; undo reverses all of it', async () => {
    const { store } = make();
    const { dealId, qid } = await dealWithQuestion(store);
    const r = await store.dispatch(RequestDraft, { dealId, questionId: qid });
    expect(r.ok).toBe(true);
    expect(store.get().questions[qid].draft?.status).toBe('pending');
    await settle(store, qid, 'found');
    const q1 = store.get().questions[qid];
    expect(q1.draft?.status).toBe('found'); expect(q1.draft?.sources.length).toBe(2);
    const a = await store.dispatch(AcceptDraft, { dealId, questionId: qid });
    expect(a.ok).toBe(true);
    const q2 = store.get().questions[qid];
    expect(q2.status).toBe('answered'); expect(q2.response).toBe(q1.draft!.text); expect(q2.provenance?.origin).toBe('ai'); expect(q2.respondedBy).toBe('[firm name]'); expect(q2.responded).toBe('2026-11-09'); expect(q2.draft).toBeUndefined();
    await store.undo((a as any).value.opId);
    const q3 = store.get().questions[qid];
    expect(q3.status).toBe('open'); expect(q3.response).toBe(''); expect(q3.draft?.status).toBe('found'); expect(q3.respondedBy).toBe('');
  });

  it('a used draft is the person\'s once its words change: the AI origin and its sources go, and Undo brings them back', async () => {
    const { store } = make();
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(RequestDraft, { dealId, questionId: qid }); await settle(store, qid, 'found');
    await store.dispatch(AcceptDraft, { dealId, questionId: qid });
    const used = store.get().questions[qid];
    // spacing alone is not a change of words
    await store.dispatch(SetResponse, { dealId, questionId: qid, response: used.response + '  ' }, { quiet: true });
    expect(store.get().questions[qid].provenance).toMatchObject({ origin: 'ai' });
    const r = await store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Held by the project company; expires 2041.' }, { quiet: true });
    const mine = store.get().questions[qid];
    expect(mine.provenance).toMatchObject({ origin: 'human', sources: [] }); expect(mine.status).toBe('answered');
    await store.undo((r as any).value.opId);
    const back = store.get().questions[qid];
    expect(back.provenance?.origin).toBe('ai'); expect(back.provenance?.sources.length).toBe(2);
  });

  it('a draft answers the wording it was asked for: editing the question makes it stale and acceptance is refused', async () => {
    const { store } = make();
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(RequestDraft, { dealId, questionId: qid });
    await settle(store, qid, 'found');
    await store.dispatch(EditQuestionField, { dealId, questionId: qid, field: 'text', value: 'Please confirm the tax indemnity cap.' });
    expect(isDraftStale(store.get().questions[qid])).toBe(true);
    const a = await store.dispatch(AcceptDraft, { dealId, questionId: qid });
    expect(!a.ok && a.error.message).toMatch(/changed since/);
  });

  it('a late response from a superseded request never lands', async () => {
    let resolveFirst: ((v: any) => void) | null = null; let calls = 0;
    const ai: Partial<AiService> = { draft: () => new Promise((res) => { if (++calls === 1) resolveFirst = res; else res(ok({ status: 'found', text: 'second', sources: [] })); }) };
    const { store } = make(ai);
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(RequestDraft, { dealId, questionId: qid });
    await store.dispatch(DiscardDraft, { dealId, questionId: qid });
    await store.dispatch(RequestDraft, { dealId, questionId: qid });
    await settle(store, qid, 'found');
    expect(store.get().questions[qid].draft?.text).toBe('second');
    resolveFirst!(ok({ status: 'found', text: 'FIRST (late)', sources: [] }));
    await sleep(30);
    expect(store.get().questions[qid].draft?.text).toBe('second');
  });

  it('a failed AI call becomes a retryable Failed draft, not a stuck one', async () => {
    const ai: Partial<AiService> = { draft: async () => ({ ok: false, error: { kind: 'failed', message: 'model down' } }) };
    const { store } = make(ai);
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(RequestDraft, { dealId, questionId: qid });
    await settle(store, qid, 'failed');
    expect(store.get().questions[qid].draft?.status).toBe('failed');
  });

  it('drafts left pending by a crashed session are marked failed when the deal loads', async () => {
    const kv = disk();
    const ai: Partial<AiService> = { draft: () => new Promise(() => {}) }; // never answers
    const { store } = make(ai, kv);
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(RequestDraft, { dealId, questionId: qid });
    expect(store.get().questions[qid].draft?.status).toBe('pending');
    const { store: s2 } = make(undefined, kv);
    await s2.boot(); await s2.loadDeal(dealId);
    expect(s2.get().questions[qid].draft?.status).toBe('failed');
  });

  it('using a draft as the response answers the question, with AI provenance and the firm as responder; ' +
    'there is no separate internal close', async () => {
    const { store } = make();
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(RequestDraft, { dealId, questionId: qid });
    await settle(store, qid, 'found');
    const r = await store.dispatch(AcceptDraft, { dealId, questionId: qid });
    expect(r.ok).toBe(true);
    const q = store.get().questions[qid];
    expect(q.status).toBe('answered'); expect(q.provenance?.origin).toBe('ai'); expect('internal' in (q.provenance ?? {})).toBe(false); expect(q.respondedBy).toBe('[firm name]');
    expect(store.get().ui.toasts.at(-1)!.text).toBe(`Response recorded on Q${q.n}`);
  });

  it('a question with part of a response can be drafted: the draft waits beside the response, ' +
    'and replaces it only when asked; Undo brings the words back', async () => {
    const { store } = make();
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(SetResponse, { dealId, questionId: qid, response: 'The sponsor confirms' });
    const r = await store.dispatch(RequestDraft, { dealId, questionId: qid });
    expect(r.ok).toBe(true);
    await settle(store, qid, 'found');
    expect(store.get().questions[qid].response).toBe('The sponsor confirms');
    const no = await store.dispatch(AcceptDraft, { dealId, questionId: qid });
    expect(no.ok).toBe(false); expect(store.get().questions[qid].response).toBe('The sponsor confirms');
    const draft = store.get().questions[qid].draft!.text;
    const yes = await store.dispatch(AcceptDraft, { dealId, questionId: qid, replace: true });
    expect(yes.ok).toBe(true);
    const q = store.get().questions[qid];
    expect(q.response).toBe(draft); expect(q.status).toBe('answered'); expect(q.provenance?.origin).toBe('ai'); expect(q.draft).toBeUndefined();
    await store.undo((yes as any).value.opId);
    const back = store.get().questions[qid];
    expect(back.response).toBe('The sponsor confirms'); expect(back.status).toBe('open'); expect(back.draft?.status).toBe('found');
  });

  it('a replace names the response it replaces: one changed since (a coworker\'s, synced in) is left as it is', async () => {
    const { store } = make();
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Mine more' });
    await store.dispatch(RequestDraft, { dealId, questionId: qid });
    await settle(store, qid, 'found');
    await store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Coworker answer' });   // as if synced in after the save
    const r = await store.dispatch(AcceptDraft, { dealId, questionId: qid, replace: true, over: 'Mine more' }, { quiet: true });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.message).toBe('Changed elsewhere');
    expect(store.get().questions[qid].response).toBe('Coworker answer'); expect(store.get().questions[qid].draft?.status).toBe('found');
    const yes = await store.dispatch(AcceptDraft, { dealId, questionId: qid, replace: true, over: 'Coworker answer' }, { quiet: true });
    expect(yes.ok).toBe(true); expect(store.get().ui.toasts.at(-1)!.text).toMatch(/replaced/);   // said, with its Undo, though asked quietly
  });

  it('Draft all\'s request is for a question with no response: one saved while it waited is left alone', async () => {
    const { store } = make();
    const { dealId, qid } = await dealWithQuestion(store);
    await store.dispatch(SetResponse, { dealId, questionId: qid, response: 'Typed meanwhile' });
    const r = await store.dispatch(RequestDraft, { dealId, questionId: qid, empty: true }, { quiet: true });
    expect(r.ok).toBe(false); expect(store.get().questions[qid].draft).toBeUndefined();
  });
});

// A draft is never left spinning with nothing running: when the question it was for comes back after the request ended, it
// shows as failed with Retry. A result that cannot be saved yet waits to be saved.
describe('a draft whose request has ended is never left pending', () => {
  /** an AI that answers only when told to, so the cause can be set up while the draft is out */
  const gated = () => { let open!: () => void; const gate = new Promise<void>((r) => { open = r; }); const ai: Partial<AiService> = { draft: async (i) => { await gate; return foundDraft(i); } }; return { ai, open }; };

  // A reply that cannot be saved is not thrown away: it waits, the draft still shown as being written, and is saved once it
  // can be, with no second request to the model.
  it('storage full when the result comes back: the reply waits and is saved once there is room', async () => {
    let asked = 0; const { ai, open } = gated(); const draft = ai.draft!; ai.draft = (i) => { asked++; return draft(i); };
    const { store, kv } = make(ai); Object.assign(store.replyWait, { first: 10, max: 40 });
    const { dealId, qid } = await dealWithQuestion(store);
    const r = await store.dispatch(RequestDraft, { dealId, questionId: qid });
    refuseNext(kv.local); open(); await store.settled((r as any).value.opId);
    expect(store.get().questions[qid].draft?.status).toBe('pending');
    await settle(store, qid, 'found');
    expect(store.get().questions[qid].draft?.status).toBe('found'); expect(asked).toBe(1);
  });

  it('the draft cannot be written when it comes back: the reply waits and is written once it can be', async () => {
    let asked = 0; const { ai, open } = gated(); const draft = ai.draft!; ai.draft = (i) => { asked++; return draft(i); };
    const { store } = make(ai); Object.assign(store.replyWait, { first: 10, max: 40 });
    const { dealId, qid } = await dealWithQuestion(store);
    const repo = store.services.repo as MemRepo;
    const r = await store.dispatch(RequestDraft, { dealId, questionId: qid });
    const back = refuse(repo.shared, toAQuestion, quota);                            // the shared folder takes no question changes just now
    open(); await store.settled((r as any).value.opId);
    expect(store.get().questions[qid].draft?.status).toBe('pending');
    back();
    await settle(store, qid, 'found');
    expect(store.get().questions[qid].draft?.status).toBe('found'); expect(asked).toBe(1);
  });

  it('a change from another PC held back mid-batch stops nothing: every draft of Draft all lands, none is left drafting', async () => {
    const { store } = make({ draft: async (i) => { await sleep(20); return foundDraft(i); } });
    const { dealId } = await dealWithQuestion(store);
    for (const t of ['Provide the capacity agreement.', 'Which ratio was agreed?', 'Confirm the grid date.', 'Send the insurance schedule.', 'Who is the EPC contractor?']) await store.dispatch(CreateQuestion, { dealId, text: t });
    const repo = store.services.repo as MemRepo;
    const run = draftAll(store, dealId); await sleep(5);
    repo.peer.hold(dealId, ELSEWHERE); await store.refreshSync();                       // a change from another PC that waits on one that has not arrived
    expect(store.get().sync?.waiting.length).toBe(1);
    await run;
    const qs = Object.values(store.get().questions).filter((q) => q.dealId === dealId);
    expect(qs.map((q) => q.draft?.status)).toEqual(qs.map(() => 'found'));
  });

  it('delete at once, then Undo after the request ended: the question comes back with a failed draft, not the dots', async () => {
    const { ai, open } = gated(); const { store } = make(ai);
    const { dealId, qid } = await dealWithQuestion(store);
    const r = await store.dispatch(RequestDraft, { dealId, questionId: qid });
    const del = await store.dispatch(DeleteQuestion, { dealId, questionId: qid }); expect(del.ok).toBe(true);
    open(); await store.settled((r as any).value.opId);
    await store.undo((del as any).value.opId);
    expect(store.get().questions[qid].draft?.status).toBe('failed');
    expect(eligibleForDraft(store.get().questions[qid])).toBe(true);
  });

  it('Undo while the request is still running: the draft stays pending and its result lands', async () => {
    const { ai, open } = gated(); const { store } = make(ai);
    const { dealId, qid } = await dealWithQuestion(store);
    const r = await store.dispatch(RequestDraft, { dealId, questionId: qid });
    const del = await store.dispatch(DeleteQuestion, { dealId, questionId: qid });
    await store.undo((del as any).value.opId);
    expect(store.get().questions[qid].draft?.status).toBe('pending');
    open(); await store.settled((r as any).value.opId);
    expect(store.get().questions[qid].draft?.status).toBe('found');
  });
});

describe('the firm name', () => {
  it('comes from the control file, and stamps what we ask and answer (no Firm input in Settings)', async () => {
    const { store } = make(); const { dealId, qid } = await dealWithQuestion(store);
    expect(store.get().questions[qid].askedBy).toBe('[firm name]');
    await store.dispatch(RequestDraft, { dealId, questionId: qid }); await settle(store, qid, 'found');
    expect((await store.dispatch(AcceptDraft, { dealId, questionId: qid })).ok).toBe(true); expect(store.get().questions[qid].respondedBy).toBe('[firm name]');
  });
  it('preferences saved with a firm name from before load without it', async () => {
    const local = new MemoryLocal(); local.write('prefs', { theme: 'dark', model: null, firm: 'Old Name' });
    const store = new Store({ repo: memRepo(clock.now), ai: mockAi({ latency: [0, 0] }), docs: mockDocuments({ latency: [0, 0] }), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession({ latency: [0, 0] }), local, clock, ids }, COMMANDS);
    await store.boot(); expect(store.get().prefs.theme).toBe('dark'); expect('firm' in store.get().prefs).toBe(false);
  });

  it('Draft all counts a draft that failed as failed, not as "without an answer"', async () => {
    const { store } = make({ draft: async () => fail({ kind: 'unreachable', message: 'The AI provider can’t be reached' }) });
    const { dealId } = await dealWithQuestion(store, 'Please confirm the lock-up test.');
    await store.dispatch(CreateQuestion, { dealId, text: 'Provide the operating budget.' });
    await draftAll(store, dealId);
    expect(Object.values(store.get().questions).map((q) => q.draft?.status)).toEqual(['failed', 'failed']);
    expect(store.get().ui.toasts.at(-1)!.text).toBe('0 drafted · 2 failed');
  });

  it('Draft all leaves alone a question whose response is being typed, or was given one after the batch began', async () => {
    const { store } = make(); const { dealId, qid } = await dealWithQuestion(store, 'Please confirm the lock-up test.');
    await store.dispatch(CreateQuestion, { dealId, text: 'Provide the operating budget.' }); await store.dispatch(CreateQuestion, { dealId, text: 'Send the insurance report.' });
    const [, q2, q3] = Object.keys(store.get().questions);
    typingIn.add(qid);                                                                                   // the person is typing in Q1's response
    const run = draftAll(store, dealId); await store.dispatch(SetResponse, { dealId, questionId: q2, response: 'Sent on Nov 2.' });   // and Q2 got a response meanwhile
    await run; typingIn.delete(qid);
    const qs = store.get().questions;
    expect(qs[qid].draft, 'Q1, being typed in').toBeUndefined(); expect(qs[q3].draft?.status).toBe('found');
    expect(qs[q2].response, 'Q2, answered while its draft was out: the response stands').toBe('Sent on Nov 2.');
    // a question answered before its turn in a long batch (four are drafted at a time) is not drafted at all
    const more: string[] = []; for (const t of ['A?', 'B?', 'C?', 'D?', 'E?']) { await store.dispatch(CreateQuestion, { dealId, text: t }); more.push(Object.keys(store.get().questions).at(-1)!); }
    const run2 = draftAll(store, dealId); await store.dispatch(SetResponse, { dealId, questionId: more[4], response: 'Answered by hand.' }); await run2;
    expect(store.get().questions[more[4]].draft, 'answered before its turn').toBeUndefined();
  });
});

describe('a check asked for while this PC was out of sync', () => {
  it('starts once the PC is back in sync, as asked, rather than saying it did not start', async () => {
    const asked: { deep?: boolean; only?: string }[] = []; let told = 0;
    const { store } = make({
      checked: async () => ok({ at: null, offerDeep: null, ...(told++ ? {} : { ended: { restart: 'deep' as const } }) }),   // told once, as the backend does
      checkAll: async (i) => { asked.push({ deep: i.deep, ...(i.only ? { only: i.only } : {}) }); return ok({ at: '2026-11-15T10:00:00.000Z', items: 1, findings: 0, toReassess: 0, newFindings: 0, offerDeep: false } as any); },
    });
    await store.boot(); await store.dispatch(CreateDeal, { name: 'Datum', folders: [] }); const dealId = Object.keys(store.get().deals)[0];
    await store.refreshChecked(dealId); await sleep(10);
    expect(asked).toEqual([{ deep: true }]);
  });
});

