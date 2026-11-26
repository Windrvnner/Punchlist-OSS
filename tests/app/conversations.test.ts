import { describe, it, expect, onTestFinished, vi } from 'vitest';
import { Store, NOT_THESE_KEEP } from '../../src/app/store';
import { memRepo, disk, type Disk, type MemRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { mockAi, mockDocuments, mockSession, mockFirstPass , mockAttachedId } from '../../src/adapters/mocks';
import { CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, UseAsResponse } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding } from '../../src/app/commands/findings';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import {
  ask, retry, convKey, conversationDocs, docIndex, suggestions, useAnswer, answerText, askVerdict, type Scope,
} from '../../src/app/conversations';
import { MAX_ATTACHED, attachFiles, addToSources } from '../../src/app/attachments';
import { checkedOffer, runOffer } from '../../src/app/answerOffer';
import { SetDealMember } from '../../src/app/commands/members';
import { dealFindings } from '../../src/app/state';
import type { AiService, DocumentService, LocalStore } from '../../src/ports';
import { ok, fail } from '../../src/domain/result';

const COMMANDS = [
  CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus,
  SetResponse, DeleteQuestion, RestoreQuestion, UseAsResponse, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft,
  AcceptDraft, RestoreQuestionSnapshot, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding,
  RestoreFindingSnapshot, Reassess, ApplyReassessment, AttachDocumentToFinding, SetDealMember,
];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(over: { ai?: Partial<AiService>; docs?: Partial<DocumentService>; kv?: Disk; local?: LocalStore; repo?: MemRepo } = {}) {
  const opts = { latency: [0, 0] as [number, number] }; const kv = over.kv ?? disk(); const local = over.local ?? new MemoryLocal();
  const repo = over.repo ?? memRepo(clock.now, kv);                     // a second window of the same PC shares its store
  const store = new Store({ repo, ai: { ...mockAi(opts, repo), ...over.ai }, docs: { ...mockDocuments(opts), ...over.docs }, fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local, clock, ids }, COMMANDS);
  return { store, kv, repo, local };
}
async function deal(store: Store, name = 'Datum') { await store.boot(); await store.dispatch(CreateDeal, { name, folders: [] }); const id = Object.values(store.get().deals).find((d) => d.name === `Project ${name}`)!.id; await store.loadDeal(id); return id; }

describe('conversations', () => {
  it('asked before the models have loaded (just after a sign-in, say), the question goes to the person’s default or the standard tier, never with no model', async () => {
    const models: string[] = [];
    const { store } = make({ ai: { answer: async (i) => { models.push(i.model); return ok({ text: 'It is 1.25x.', sources: [] }); } } });
    const dealId = await deal(store);
    (store as unknown as { set: (x: unknown) => void }).set({ ...store.get(), models: [], model: '' });   // as after a start with nobody signed in
    await ask(store, { kind: 'deal', dealId }, 'lock-up');
    (store as unknown as { set: (x: unknown) => void }).set({ ...store.get(), prefs: { ...store.get().prefs, model: 'thorough' } });   // a default the person chose is kept
    await ask(store, { kind: 'deal', dealId }, 'and the test date?');
    expect(models).toEqual(['standard', 'thorough']);
  });
  it('follows the chat agent’s steps while it works, and keeps them with the answer, also across a restart', async () => {
    const local = new MemoryLocal(); const kv = disk(); let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const steps = { steps: [{ kind: 'search' as const, text: 'Searched documents, findings and Q&A for “lock-up”', result: '', done: false }], ms: 900 };
    const asked: string[] = [];
    const ai: Partial<AiService> = {
      answer: async (i) => { await gate; return ok({ text: 'It is 1.25x.', sources: [], research: { steps: [{ ...steps.steps[0], done: true, result: '3 listed · 1 opened · 0 passages' }], ms: 1800 } }); },
      research: async (runId) => { asked.push(runId); return ok(steps); },
    };
    const { store } = make({ kv, local, ai }); const dealId = await deal(store); const scope: Scope = { kind: 'deal', dealId };
    // the poll's 700 ms waits run on a test clock: only setTimeout is faked, from here to the end of the case (#101)
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    onTestFinished(() => { vi.useRealTimers(); });
    const p = ask(store, scope, 'lock-up'); await vi.advanceTimersByTimeAsync(800);
    const pending = store.get().threads[convKey(scope)][1]; expect(pending.state).toBe('pending');
    expect(asked[0]).toBe(pending.id); expect(store.get().ui.researching[pending.id]).toEqual(steps);   // asked by the pending message's id, and shown
    release(); await p;
    const done = store.get().threads[convKey(scope)][1]; expect(done.research?.steps[0]).toMatchObject({ done: true, result: '3 listed · 1 opened · 0 passages' }); expect(store.get().ui.researching).toEqual({});
    // and no longer asked once answered
    const n = asked.length; await vi.advanceTimersByTimeAsync(800); expect(asked.length).toBe(n);
    // the restart runs on real time
    vi.useRealTimers();
    const again = make({ kv, local }); await again.store.boot(); expect(again.store.get().threads[convKey(scope)][1].research?.ms).toBe(1800);
  });

  it('carries on the model service’s conversation: the last answer’s goes with the next question, and the new one is kept, also across a restart', async () => {
    const local = new MemoryLocal(); const kv = disk(); const given: unknown[] = []; let n = 0;
    const ai: Partial<AiService> = { answer: async (i) => { given.push(i.thread); n++; return ok({ text: `Answer ${n}`, sources: [], thread: { id: 'conv_1', model: i.model, tokens: 100 * n, tags: [{ tag: 'D1', dealId: 'd', docId: 'x' }] } }); } };
    const { store } = make({ kv, local, ai }); const dealId = await deal(store); const scope: Scope = { kind: 'deal', dealId };
    await ask(store, scope, 'first'); await ask(store, scope, 'second');
    expect(given[0]).toBeUndefined(); expect(given[1]).toMatchObject({ id: 'conv_1', tokens: 100 });
    const again = make({ kv, local }); await again.store.boot(); expect(again.store.get().threads[convKey(scope)][3].thread).toMatchObject({ id: 'conv_1', tokens: 200 });
  });

  it('asks, shows pending, then the answer; the thread is saved locally and survives a restart', async () => {
    const local = new MemoryLocal(); const kv = disk();
    const { store, repo } = make({ kv, local }); const dealId = await deal(store);
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20);
    const scope: Scope = { kind: 'deal', dealId };
    const p = ask(store, scope, 'What are the three biggest issues?');
    expect(store.get().threads[convKey(scope)].map((m) => m.state)).toEqual(['done', 'pending']);
    await p;
    const th = store.get().threads[convKey(scope)];
    expect(th[1].state).toBe('done'); expect(th[1].text).toMatch(/\{[^|]+\|f_/);
    const { store: s2 } = make({ kv, local }); await s2.boot();
    expect(s2.get().threads[convKey(scope)].length).toBe(2);
  });

  it('two windows asking in one conversation keep both questions and both answers', async () => {
    const local = new MemoryLocal(); const kv = disk();
    let release: (() => void)[] = []; const slow: Partial<AiService> = { answer: (i) => new Promise((r) => release.push(() => r({ ok: true, value: { text: `Answer to: ${i.message}`, sources: [] } } as any))) };
    const { store: a, repo } = make({ kv, local, ai: slow }); const dealId = await deal(a); await mockFirstPass(repo, dealId, 'Project Datum');
    const { store: b } = make({ kv, local, ai: slow, repo }); await b.boot();
    const scope: Scope = { kind: 'deal', dealId, conv: 'c1' };
    const pa = ask(a, scope, 'Asked in window A'); const pb = ask(b, scope, 'Asked in window B');      // both while the model is slow
    while (release.length < 2) await sleep(5);
    release[0](); await pa; release[1](); await pb; await sleep(5);
    const { store: c } = make({ kv, local }); await c.boot();
    const th = c.get().threads[convKey(scope)].map((m) => `${m.role}:${m.state}:${m.text}`);
    expect(th).toEqual(['me:done:Asked in window A', 'ai:done:Answer to: Asked in window A', 'me:done:Asked in window B', 'ai:done:Answer to: Asked in window B']);
  });

  it('the deal is the boundary: an answer on one deal never cites another deal’s documents', async () => {
    const { store, repo } = make(); const a = await deal(store, 'Datum');
    await store.dispatch(CreateDeal, { name: 'Empty', folders: [] }); const b = Object.values(store.get().deals).find((d) => d.name === 'Project Empty')!.id;
    await mockFirstPass(repo, a, 'Project Datum'); await sleep(20);
    await ask(store, { kind: 'deal', dealId: b }, 'What supports the lock-up ratio?');
    const m = store.get().threads[convKey({ kind: 'deal', dealId: b })][1];
    expect(m.sources ?? []).toEqual([]); expect(m.text).toMatch(/Nothing in the documents/);
  });

  it('a late answer is applied only to the message it was asked for; a failed one can be retried', async () => {
    let n = 0; let release: ((v: any) => void) | null = null;
    const ai: Partial<AiService> = { answer: () => new Promise((res) => { n++; if (n === 1) release = res; else res(fail({ kind: 'failed', message: 'x' })); }) };
    const { store } = make({ ai }); const dealId = await deal(store); const scope: Scope = { kind: 'deal', dealId };
    const p1 = ask(store, scope, 'first');
    // the person clears the thread while the first answer is in flight
    store.setThread(convKey(scope), []);
    release!(ok({ text: 'LATE', sources: [] })); await p1;
    expect(store.get().threads[convKey(scope)]).toEqual([]);
    await ask(store, scope, 'second');
    const failed = store.get().threads[convKey(scope)][1];
    expect(failed.state).toBe('failed');
    (store.services.ai as any).answer = async () => ok({ text: 'now fine', sources: [] });
    await retry(store, scope, failed.id);
    expect(store.get().threads[convKey(scope)][1]).toMatchObject({ state: 'done', text: 'now fine' });
  });

  it('an answer pending when the session ended is shown as failed on the next start', async () => {
    const local = new MemoryLocal(); const kv = disk();
    const { store } = make({ kv, local, ai: { answer: () => new Promise(() => {}) } }); const dealId = await deal(store);
    void ask(store, { kind: 'deal', dealId }, 'never answered'); await sleep(5);
    const { store: s2 } = make({ kv, local }); await s2.boot();
    expect(s2.get().threads[convKey({ kind: 'deal', dealId })][1].state).toBe('failed');
  });

  it('lists the documents a conversation refers to, one entry per page, and finds a source in it', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20);
    const f = dealFindings(store.get(), dealId).find((x) => /Lock-up/.test(x.title))!;
    const scope: Scope = { kind: 'finding', dealId, findingId: f.id };
    await ask(store, scope, 'Why does this matter?');
    const docs = conversationDocs(store.get(), scope);
    expect(docs.map((d) => d.doc)).toEqual(['Credit agreement (draft 1).pdf', 'Term sheet (signed).pdf']); // the answer cites the same pages: no duplicates
    expect(docIndex(docs, f.sources[1])).toBe(1);                                             // found by the document's id
    expect(docIndex(docs, { doc: 'Term sheet (signed).pdf', loc: 'p. 6', docId: 'doc_another_file_with_that_name' })).toBe(0); // a different file with the same name is not this one
  });

  it('use as response records the text with chat provenance and leaves the status for a person ' +
    '', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm.' }); const q = Object.values(store.get().questions)[0];
    const r = await store.dispatch(UseAsResponse, { dealId, questionId: q.id, text: 'Confirmed in the IM.', sources: [{ doc: 'IM.pdf', loc: 'p. 2', docId: 'doc_im' }] });
    expect(r.ok).toBe(true);
    expect(store.get().questions[q.id]).toMatchObject({ response: 'Confirmed in the IM.', status: 'open' });
    expect(store.get().questions[q.id].provenance?.origin).toBe('chat');
    await store.undo((r as any).value.opId);
    expect(store.get().questions[q.id].response).toBe('');
  });
  it('a typed response leaves the status for a person too, with no responder or date filled in ' +
    '', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm.' }); const q = Object.values(store.get().questions)[0];
    expect((await store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Confirmed.' })).ok).toBe(true);
    expect(store.get().questions[q.id]).toMatchObject({ response: 'Confirmed.', status: 'open', respondedBy: '', responded: '' });
  });
  it('suggests an open question under the newest answer that may address it, and only a person uses it', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20); await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: 'Confirm the operating assumption in the base case, and whether the technical advisor and the information memorandum agree.' });
    await store.dispatch(CreateQuestion, { dealId, text: 'Provide the insurance certificates.' });
    const q = Object.values(store.get().questions).find((x) => x.n === 1)!;
    const scope: Scope = { kind: 'deal', dealId };
    await ask(store, scope, 'What are the three biggest issues?'); await ask(store, scope, 'Which of these would hold up financial close?');
    const [, first, , second] = store.get().threads[convKey(scope)];
    expect([...suggestions(store.get(), scope)]).toEqual([[second.id, q.id]]);   // not under the first answer as well
    expect(suggestions(store.get(), { kind: 'question', dealId, questionId: q.id }).size).toBe(0);
    store.ui({ notThese: [`${second.id}|${q.id}`] });
    expect(suggestions(store.get(), scope).size).toBe(0);                          // "not this one" does not move it to the first answer
    store.ui({ notThese: [] });
    expect(store.get().questions[q.id].response).toBe('');                         // suggesting changes nothing
    await useAnswer(store, dealId, q.id, second);
    expect(store.get().questions[q.id]).toMatchObject({ response: answerText(second), status: 'open' });
    expect(suggestions(store.get(), scope).size).toBe(0);                          // nor under the earlier answer, now that it has this one
    expect(first.text).toMatch(/\{[^|}]+\|f_/);                                   // the first answer names findings: links leave as words
    expect(answerText(first)).not.toMatch(/[{}|]|f_[0-9A-Z]{26}/);
  });
  it('a person can ask the model whether an answer addresses the suggested question; its verdict is shown and changes nothing', async () => {
    let asked: { question: string; answer: string } | null = null;
    const { store, repo } = make({ ai: { addresses: async (i) => { asked = i; await sleep(5); return ok({ verdict: 'partly' as const, why: 'It gives the figure, not its source.' }); } } }); const dealId = await deal(store);
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20); await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: 'Confirm the operating assumption in the base case, and whether the technical advisor and the information memorandum agree.' });
    const q = Object.values(store.get().questions)[0]; const scope: Scope = { kind: 'deal', dealId };
    await ask(store, scope, 'Which of these would hold up financial close?'); const answer = store.get().threads[convKey(scope)][1];
    const p = askVerdict(store, dealId, q.id, answer); const key = `${answer.id}|${q.id}`;
    expect(store.get().ui.verdicts[key]).toBe('asking'); await p;
    expect(store.get().ui.verdicts[key]).toEqual({ verdict: 'partly', why: 'It gives the figure, not its source.' });
    expect(asked).toEqual({ dealId, question: q.text, answer: answerText(answer) });
    expect(store.get().questions[q.id]).toMatchObject({ response: '', status: 'open' });
    const failing = make({ ai: { addresses: async () => fail({ kind: 'failed' as const, message: 'no' }) } }); const d2 = await deal(failing.store, 'Margie');
    await failing.store.dispatch(CreateQuestion, { dealId: d2, text: 'Anything?' }); const q2 = Object.values(failing.store.get().questions)[0];
    await askVerdict(failing.store, d2, q2.id, answer); expect(failing.store.get().ui.verdicts[`${answer.id}|${q2.id}`]).toBe('failed');
  });
  it('the stand-in model says yes, partly or no by how much of the question the answer speaks to', async () => {
    const ai = mockAi({ latency: [0, 0] }); const question = 'Which lock-up ratio was agreed in the credit agreement?';
    expect((await ai.addresses!({ dealId: 'd', question, answer: 'The credit agreement sets the lock-up ratio at 1.25x, as agreed.' }) as any).value.verdict).toBe('yes');
    expect((await ai.addresses!({ dealId: 'd', question, answer: 'The lock-up ratio is 1.25x.' }) as any).value).toEqual({ verdict: 'partly', why: 'It gives some of what the question asks for, not all of it.' });
    expect((await ai.addresses!({ dealId: 'd', question, answer: 'Insurance is in place.' }) as any).value.verdict).toBe('no');
  });
  it('a question about the open questions is asked of the model like any other (#1054)', async () => {
    const asked: string[] = [];
    const { store, repo } = make({ ai: { answer: async (i) => {
      asked.push(i.message);
      return ok({ text: `Answered: ${i.message}`, sources: [] });
    } } });
    const dealId = await deal(store);
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20); await store.loadDeal(dealId);
    const scope: Scope = { kind: 'deal', dealId };
    await ask(store, scope, 'Which of these would hold up financial close?');
    await ask(store, scope, 'Does this answer any of our open questions?');
    const list = store.get().threads[convKey(scope)];
    const second = 'Does this answer any of our open questions?';
    expect(asked).toEqual(['Which of these would hold up financial close?', second]);
    expect(list[3]).toMatchObject({ role: 'ai', state: 'done', text: `Answered: ${second}` });
  });
  it('"Not this one" is remembered on this PC across a reload, by answer and question, ' +
    'and changes no record', async () => {
    const local = new MemoryLocal(); const kv = disk();
    const { store, repo } = make({ kv, local }); const dealId = await deal(store);
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20); await store.loadDeal(dealId);
    await store.dispatch(CreateQuestion, { dealId, text: 'Confirm the operating assumption in the base case, and whether the technical advisor and the information memorandum agree.' });
    const q = Object.values(store.get().questions)[0]; const scope: Scope = { kind: 'deal', dealId };
    await ask(store, scope, 'Which of these would hold up financial close?'); const answer = store.get().threads[convKey(scope)][1];
    expect([...suggestions(store.get(), scope)]).toEqual([[answer.id, q.id]]);
    store.putAway(answer.id, q.id); store.putAway(answer.id, q.id);              // pressed twice, kept once
    expect(local.read('notThese')).toEqual([`${answer.id}|${q.id}`]); expect(suggestions(store.get(), scope).size).toBe(0);
    const { store: again } = make({ kv, local }); await again.boot(); await again.loadDeal(dealId);      // the app opened again on this PC
    expect(again.get().ui.notThese).toEqual([`${answer.id}|${q.id}`]); expect(suggestions(again.get(), scope).size).toBe(0);
    expect(again.get().questions[q.id]).toMatchObject({ response: '', status: 'open' });
    const { store: elsewhere } = make({ kv: { ...disk(), shared: kv.shared } }); await elsewhere.boot(); expect(elsewhere.get().ui.notThese).toEqual([]);   // another PC has its own
    // **Undo** on the notice is the way back (#1054)
    again.putAway(answer.id, q.id); const undo = again.get().ui.toasts.at(-1)!;
    expect(undo).toMatchObject({ text: 'Suggestion hidden', action: { label: 'Undo' } });
    undo.action!.run!();
    expect(local.read('notThese')).toEqual([]); expect(suggestions(again.get(), scope).size).toBe(1);
  });
  it('another window of the same person follows what is put away, and adds to it rather than writing over it', async () => {
    // a local store two windows share, telling each of the other's writes, as the browser's storage event does
    const shared = new MemoryLocal(); const heard: ((key: string) => void)[] = [];
    const local: LocalStore = { read: (k) => shared.read(k), write: (k, v) => { const r = shared.write(k, v); for (const f of heard) f(k); return r; }, watch: (f) => { heard.push(f); return () => {}; } };
    const { store: a } = make({ local }); await a.boot();
    const { store: b } = make({ local }); await b.boot();
    a.putAway('m1', 'q1'); expect(b.get().ui.notThese).toEqual(['m1|q1']);
    b.putAway('m2', 'q2'); expect(a.get().ui.notThese).toEqual(['m1|q1', 'm2|q2']); expect(shared.read('notThese')).toEqual(['m1|q1', 'm2|q2']);
  });
  it('what is put away is kept within a limit, the oldest let go first, and a damaged copy reads as nothing put away', async () => {
    const local = new MemoryLocal(); local.write('notThese', Array.from({ length: NOT_THESE_KEEP }, (_, i) => `m${i}|q`));
    const { store } = make({ local }); await store.boot(); store.putAway('new', 'q');
    const kept = local.read('notThese') as string[]; expect(kept).toHaveLength(NOT_THESE_KEEP); expect(kept[0]).toBe('m1|q'); expect(kept.at(-1)).toBe('new|q');
    const bad = new MemoryLocal(); bad.write('notThese', { not: 'a list' }); const { store: s2 } = make({ local: bad }); await s2.boot(); expect(s2.get().ui.notThese).toEqual([]);
  });
});

describe('attachments', () => {
  it('attaching on a finding changes nothing on the finding; it joins the sources only when the person says so, with Undo', async () => {
    const { store } = make(); const a = await deal(store, 'Datum');
    await store.dispatch(CreateFinding, { dealId: a, title: 'x', workstream: 'Legal' }); const f = dealFindings(store.get(), a)[0];
    const conv = convKey({ kind: 'finding', dealId: a, findingId: f.id });
    await attachFiles(store, { dealId: a, findingId: f.id, conv }, [new File(['x'], 'side-letter.pdf')]); await sleep(30);
    const att = store.get().ui.attachments[0];
    expect(att).toMatchObject({ dealId: a, conv, state: 'done', doc: 'side-letter.pdf' });
    expect(store.get().findings[f.id]).toEqual(f);                       // not a field touched
    const r = await addToSources(store, a, f.id, { doc: att.doc!, docId: att.docId! });
    const after = store.get().findings[f.id];
    expect(after.sources).toEqual([{ doc: 'side-letter.pdf', loc: '', docId: att.docId }]);   // no page is guessed
    expect(store.get().ui.toasts.at(-1)).toMatchObject({ text: 'side-letter.pdf added to the finding’s sources', action: { label: 'Undo' } });
    await addToSources(store, a, f.id, { doc: att.doc!, docId: att.docId! });                  // twice is once
    expect(store.get().findings[f.id].sources).toHaveLength(1);
    await store.undo((r as any).value.opId);
    expect(store.get().findings[f.id].sources).toEqual([]);
  });

  it('an attachment belongs to one conversation: another finding and the deal chat do not see or send it; the message records it', async () => {
    const seen: any[] = [];
    const { store } = make({ ai: { answer: async (i) => { seen.push(i.attachments); return ok({ text: 'ok', sources: [] }); } } });
    const a = await deal(store, 'Datum');
    await store.dispatch(CreateFinding, { dealId: a, title: 'one', workstream: 'Legal' }); await store.dispatch(CreateFinding, { dealId: a, title: 'two', workstream: 'Legal' });
    const [f1, f2] = dealFindings(store.get(), a);
    const s1 = { kind: 'finding' as const, dealId: a, findingId: f1.id }, s2 = { kind: 'finding' as const, dealId: a, findingId: f2.id }, sd = { kind: 'deal' as const, dealId: a };
    await attachFiles(store, { dealId: a, findingId: f1.id, conv: convKey(s1) }, [new File(['x'], 'one.pdf')]); await sleep(30);
    await ask(store, s2, 'other finding'); await ask(store, sd, 'deal chat');
    expect(seen).toEqual([[], []]);
    expect(store.get().ui.attachments.map((x) => x.name)).toEqual(['one.pdf']);
    await ask(store, s1, 'this one');
    expect(seen[2]).toEqual([{ doc: 'one.pdf', docId: mockAttachedId(a, 'one.pdf', new TextEncoder().encode('x')) }]);
    expect(store.get().ui.attachments).toEqual([]);
    expect(store.get().threads[convKey(s1)][0].attached).toEqual([{ doc: 'one.pdf', docId: mockAttachedId(a, 'one.pdf', new TextEncoder().encode('x')) }]);
    expect(store.get().threads[convKey(sd)][0].attached).toBeUndefined();
  });

  it('a failed attach retries against the original deal even after the person has moved on', async () => {
    let failOnce = true; const calls: string[] = [];
    const docs: Partial<DocumentService> = { attach: async (dealId, file) => { calls.push(dealId); if (failOnce) { failOnce = false; return fail({ kind: 'failed', message: 'x' }); } return ok({ doc: file.name, docId: 'doc_test' }); } };
    const { store } = make({ docs }); const a = await deal(store, 'Datum');
    await attachFiles(store, { dealId: a, conv: convKey({ kind: 'deal', dealId: a }) }, [new File(['x'], 'proseware-confidential.pdf')]); await sleep(20);
    const toast = store.get().ui.toasts.find((t) => /Couldn’t attach/.test(t.text))!;
    expect(toast.text).toMatch(/Project Datum/);
    store.ui({ route: { name: 'home' } });                // the person navigates away
    toast.action!.run!(); await sleep(20);
    expect(calls).toEqual([a, a]);
    expect(store.get().ui.attachments[0].dealId).toBe(a);
  });

  it('sending takes only the attachments of that deal and leaves others in place', async () => {
    const seen: any[] = [];
    const { store } = make({ ai: { answer: async (i) => { seen.push(i.attachments); return ok({ text: 'ok', sources: [] }); } } });
    const a = await deal(store, 'Datum'); await store.dispatch(CreateDeal, { name: 'Other', folders: [] }); const b = Object.values(store.get().deals).find((d) => d.name === 'Project Other')!.id;
    await attachFiles(store, { dealId: a, conv: convKey({ kind: 'deal', dealId: a }) }, [new File(['x'], 'a.pdf')]); await attachFiles(store, { dealId: b, conv: convKey({ kind: 'deal', dealId: b }) }, [new File(['x'], 'b.pdf')]); await sleep(30);
    await ask(store, { kind: 'deal', dealId: a }, 'with file');
    expect(seen[0]).toEqual([{ doc: 'a.pdf', docId: mockAttachedId(a, 'a.pdf', new TextEncoder().encode('x')) }]);
    expect(store.get().ui.attachments.map((x) => x.name)).toEqual(['b.pdf']);
  });
  it('Retry asks only with every file the question had: one gone is named and nothing is asked (#671)', async () => {
    const seen: { docId: string }[][] = []; let answers = 0; let gone: string[] = [];
    const answer: AiService['answer'] = async (i) => {
      seen.push(i.attachments ?? []);
      return answers++ ? ok({ text: 'ok', sources: [] }) : fail({ kind: 'failed', message: 'down' });
    };
    const unsendable = async (_dealId: string, ids: string[]) => ok(ids.filter((id) => gone.includes(id)));
    const { store } = make({ ai: { answer }, docs: { unsendable } });
    const a = await deal(store, 'Datum'); const scope: Scope = { kind: 'deal', dealId: a };
    const files = Array.from({ length: MAX_ATTACHED }, (_x, i) => new File([`${i}`], `Consent ${i + 1}.pdf`));
    await attachFiles(store, { dealId: a, conv: convKey(scope) }, files); await sleep(30);
    await ask(store, scope, 'Do the consents cover the change of control?');
    const failed = store.get().threads[convKey(scope)].at(-1)!; expect(failed.state).toBe('failed');
    gone = [seen[0][0].docId];
    await retry(store, scope, failed.id);
    expect(seen).toHaveLength(1); expect(store.get().threads[convKey(scope)].at(-1)!.state).toBe('failed');
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Couldn’t find Consent 1.pdf — attach it again');
    gone = [];
    await Promise.all([retry(store, scope, failed.id), retry(store, scope, failed.id)]);   // pressed twice: asked once
    expect(seen.map((x) => x.length)).toEqual([MAX_ATTACHED, MAX_ATTACHED]);
    expect(store.get().threads[convKey(scope)].at(-1)!.state).toBe('done');
  });
  it('no more files are attached to one message than one call takes; the rest are not attached, and the person is told', async () => {
    const { store } = make(); const a = await deal(store, 'Datum'); const conv = convKey({ kind: 'deal', dealId: a });
    const files = (n: number, from = 0) => Array.from({ length: n }, (_x, i) => new File(['x'], `f${from + i}.pdf`));
    await attachFiles(store, { dealId: a, conv }, files(6)); await attachFiles(store, { dealId: a, conv }, files(4, 6)); await sleep(30);
    expect(store.get().ui.attachments.filter((x) => x.conv === conv).length).toBe(MAX_ATTACHED); expect(MAX_ATTACHED).toBe(8);
    expect(store.get().ui.toasts.at(-1)!.text).toBe('2 not attached: 8 files is the most for one message');
  });
});

describe('actions the model offers under its answer (#1054)', () => {
  const answering = (offer: unknown) => ({ answer: async () => ok({ text: 'Here it is.', sources: [], offer }) });
  it('keeps only an offer that checks out against the deals and the conversation', async () => {
    const { store } = make(); const dealId = await deal(store, 'Kestrel');
    const deals: Scope = { kind: 'deal', dealId }; const home: Scope = { kind: 'all' };
    const finding: Scope = { kind: 'finding', dealId, findingId: 'f_1' };
    const check = (raw: unknown, scope: Scope = deals) => checkedOffer(store.get(), scope, raw);
    expect(check({ action: 'new deal' }, home)).toEqual({ kind: 'newDeal' });
    expect(check({ action: 'open page', page: 'qa' })).toEqual({ kind: 'page', dealId, page: 'qa' });
    expect(check({ action: 'open page', deal: 'Project Kestrel', page: 'findings' }, home))
      .toEqual({ kind: 'page', dealId, page: 'findings' });
    expect(check({ action: 'add unresolved' })).toEqual({ kind: 'unresolved', dealId });
    expect(check({ action: 'log question', question: 'Is the permit final?' }))
      .toEqual({ kind: 'question', text: 'Is the permit final?' });
    for (const [raw, scope] of [
      [{ action: 'open page', page: 'qa' }, home], [{ action: 'open page', deal: 'Osprey', page: 'qa' }, deals],
      [{ action: 'open page', page: 'memo' }, deals], [{ action: 'add unresolved' }, home],
      [{ action: 'add unresolved' }, finding], [{ action: 'log question', question: '  ' }, deals],
      [{ action: 'log question' }, deals], [{ action: 'delete deal' }, deals], ['new deal', deals], [null, deals],
    ] as [unknown, Scope][]) expect(check(raw, scope)).toBeUndefined();
  });
  it('an answer keeps its checked offer across a reload; a malformed one is dropped and the answer kept', async () => {
    const kv = disk(); const local = new MemoryLocal();
    const { store } = make({ kv, local, ai: answering({ action: 'open page', page: 'checklist' }) });
    const dealId = await deal(store, 'Kestrel'); const scope: Scope = { kind: 'deal', dealId };
    await ask(store, scope, 'Take me to the checklist');
    expect(store.get().threads[convKey(scope)][1].offer).toEqual({ kind: 'page', dealId, page: 'checklist' });
    const { store: again } = make({ kv, local }); await again.boot();
    expect(again.get().threads[convKey(scope)][1].offer).toEqual({ kind: 'page', dealId, page: 'checklist' });
    const { store: odd } = make({ ai: answering({ action: 'open page', page: 42 }) });
    const oddDeal = await deal(odd, 'Osprey'); const oddScope: Scope = { kind: 'deal', dealId: oddDeal };
    await ask(odd, oddScope, 'Take me to the checklist');
    expect(odd.get().threads[convKey(oddScope)][1]).toMatchObject({ text: 'Here it is.', state: 'done' });
    expect(odd.get().threads[convKey(oddScope)][1].offer).toBeUndefined();
  });
  it('runs only when pressed, checks the deal again then, and runs nothing read-only', async () => {
    const { store } = make(); const dealId = await deal(store, 'Kestrel'); const navigate = vi.fn();
    runOffer(store, { kind: 'newDeal' }, navigate);
    expect(store.get().ui.newDeal).toMatchObject({ name: '', folders: [] });
    runOffer(store, { kind: 'page', dealId, page: 'qa' }, navigate);
    expect(navigate).toHaveBeenCalledWith(`qa-${dealId}`);
    runOffer(store, { kind: 'unresolved', dealId }, navigate);
    expect(store.get().ui.dialog).toEqual({ kind: 'addUnresolved', dealId });
    runOffer(store, { kind: 'page', dealId: 'd_gone', page: 'qa' }, navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(store.get().ui.toasts.at(-1)!.text).toBe('That deal is no longer in your list');
    // a deal taken off the person's list keeps its conversations, and their offers run as its slash commands do
    await store.dispatch(SetDealMember, { dealId, on: false });
    store.ui({ dialog: null });
    runOffer(store, { kind: 'unresolved', dealId }, navigate);
    expect(store.get().ui.dialog).toEqual({ kind: 'addUnresolved', dealId });
    runOffer(store, { kind: 'page', dealId, page: 'qa' }, navigate);
    expect(navigate).toHaveBeenCalledTimes(2);
    vi.spyOn(store, 'readOnly').mockReturnValue('Read-only');
    store.ui({ newDeal: null });
    runOffer(store, { kind: 'newDeal' }, navigate);
    expect(store.get().ui.newDeal).toBeNull();
  });
});
