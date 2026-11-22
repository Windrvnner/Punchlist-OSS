// Read-only while nobody is signed in to Intelligence (decisions: "Intelligence sign-in"): the store watches
// the sign-in, refuses new changes while signed out (the app's own record keeping goes on), and loads the session again
// once someone signs in after the app opened signed out.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft } from '../../src/app/commands/drafts';
import { draftAll } from '../../src/app/drafting';
import { ok } from '../../src/domain/result';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { connection } from '../../src/app/connection';
import { nodeSession } from '../../src/backend/session';
import { nodeFolder } from '../../src/backend/nodeFolder';
import { StandInService } from '../../src/backend/service';
import type { AiSignIn, Session } from '../../src/ports';

const COMMANDS = [CreateDeal, RecordIndexingProgress, CreateQuestion, RequestDraft, ApplyDraft];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function signIn(start: boolean) {
  const st = { signedIn: start };
  const s: AiSignIn = { status: async () => ({ ok: true, value: { signedIn: st.signedIn, sso: true, apiKey: true } }), signIn: async () => ({ ok: true, value: undefined }), paste: async () => ({ ok: true, value: undefined }) };
  return { s, st };
}
const drafted: string[] = [];   // the questions the model was asked to draft, by id
function makeStore(signin: AiSignIn, session?: Session, draftMs = 0) {
  const opts = { latency: [0, 0] as [number, number] };
  const ai = { ...mockAi(opts), draft: async (i: { questionId: string }) => { drafted.push(i.questionId); await tick(draftMs); return ok({ status: 'found' as const, text: 'Provided in the data room, folder 2.2.', sources: [] }); } };
  return new Store({ repo: memRepo(clock.now, disk()), ai, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: session ?? mockSession(opts), local: new MemoryLocal(), clock, ids, signin }, COMMANDS);
}

describe('read-only while nobody is signed in', () => {
  it('a new change is refused with the reason; the app\'s own record keeping goes on; signed in again, changes go through', async () => {
    const si = signIn(true); const store = makeStore(si.s); await store.boot();
    const stop = store.watchSignIn(10); await tick(20);
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }, { quiet: true });
    const dealId = Object.values(store.get().deals)[0].id;
    expect(store.readOnly()).toBeNull();
    si.st.signedIn = false; await tick(30);
    expect(store.get().signin?.out).toBe(true);
    expect(store.readOnly()).toBe('Sign in to Intelligence to make changes');
    const no = await store.dispatch(CreateQuestion, { dealId, text: 'Is the lease assignable?' }, { quiet: true });
    expect(no.ok).toBe(false); if (!no.ok) expect(no.error.message).toBe('Sign in to Intelligence to make changes');
    expect(Object.values(store.get().questions).length).toBe(0);
    const keeping = await store.dispatch(RecordIndexingProgress, { dealId, folders: [], log: ['Indexed'], done: true }, { quiet: true });
    expect(keeping.ok).toBe(true);
    // the connection card says why, in its Intelligence row
    expect(connection(store.get(), true, Date.now()).rows.find((r) => r.name === 'Intelligence')).toEqual({ name: 'Intelligence', tone: 'high', lines: ['Not signed in'] });
    si.st.signedIn = true; await tick(30);
    expect(store.readOnly()).toBeNull();
    expect((await store.dispatch(CreateQuestion, { dealId, text: 'Is the lease assignable?' }, { quiet: true })).ok).toBe(true);
    stop();
  });
  it('without a sign-in service (the browser demo) nothing is ever read-only', async () => {
    const opts = { latency: [0, 0] as [number, number] };
    const store = new Store({ repo: memRepo(clock.now, disk()), ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
    await store.boot(); store.watchSignIn(10); await tick(20);
    expect(store.readOnly()).toBeNull(); expect(store.get().signin).toBeUndefined();
  });
  it('a start with nobody signed in does not wait: it opens as the person last seen here, and loads the models once someone signs in', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dil-ro-'));
    try {
      const local = nodeFolder(dir); let signed = true; let asked = 0;
      const svc = new StandInService(); const models = svc.models.bind(svc); svc.models = async () => { asked++; return models(); };
      const sess = nodeSession({ service: svc, local, clock: () => '2026-11-17T09:00:00.000Z', signedInNow: () => signed });
      // signed in: the name is kept for later
      const first = await sess.load();
      expect(first.ok && first.value.user.name).toBe('adoe');
      signed = false; asked = 0;
      const again = nodeSession({ service: svc, local, clock: () => '2026-11-17T10:00:00.000Z', signedInNow: () => signed, signedIn: () => 'pc-user' });
      const out = await again.load();
      expect(out.ok && out.value).toMatchObject({
        user: { name: 'adoe', initials: 'A' },
        models: [],
        defaultModel: '',
      });
      expect(asked).toBe(0);
      // in the store: read-only at once, then the models come in after sign-in
      const si = signIn(false); const store = makeStore(si.s, again); await store.boot();
      expect(store.get().boot.stage).toBe('ready'); expect(store.get().models).toEqual([]);
      const stop = store.watchSignIn(10); await tick(20); expect(store.readOnly()).not.toBeNull();
      signed = true; si.st.signedIn = true; await tick(40);
      expect(store.get().models.map((m) => m.name)).toEqual(['Fast', 'Standard', 'Thorough']); expect(store.get().model).toBe('standard');
      stop();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('Retry on an interrupted change while signed out keeps it, to be retried after sign-in', async () => {
    const si = signIn(true); const store = makeStore(si.s); await store.boot();
    const stop = store.watchSignIn(10); await tick(20);
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }, { quiet: true });
    const dealId = Object.values(store.get().deals)[0].id;
    const s = store.get(); const base = Object.values(s.ops)[0];
    const op = {
      ...base, id: ids.next('op'), command: 'CreateQuestion',
      input: { dealId, text: 'Is the lease assignable?' }, state: 'interrupted' as const,
    };
    // Retry reads its durable entry before replacing it; a memory-only action cannot survive a restart.
    expect((await store.services.repo.transaction({ writes: [
      { kind: 'op', id: op.id, data: op, expectedRev: null },
    ] })).ok).toBe(true);
    (store as unknown as { set: (x: unknown) => void }).set({ ...s, ops: { ...s.ops, [op.id]: op } });
    si.st.signedIn = false; await tick(30);
    const r = await store.retryOp(op.id);
    expect(r?.ok).toBe(false); expect(store.get().ops[op.id].state).toBe('interrupted');
    si.st.signedIn = true; await tick(30);
    expect((await store.retryOp(op.id))?.ok).toBe(true);
    expect(Object.values(store.get().questions).map((q) => q.text)).toEqual(['Is the lease assignable?']);
    stop();
  });
  it('a sign-in reload that waits does not hold up read-only: signed out meanwhile, the app turns read-only', async () => {
    const si = signIn(false); let release = () => {};
    const opts = { latency: [0, 0] as [number, number] }; const base = mockSession(opts); let calls = 0;
    const session: Session = { load: async () => { if (calls++ === 0) return base.load().then((r) => (r.ok ? { ...r, value: { ...r.value, models: [], defaultModel: '' } } : r)); await new Promise<void>((res) => { release = res; }); return base.load(); } };
    const store = makeStore(si.s, session); await store.boot();
    const stop = store.watchSignIn(10); await tick(20); expect(store.readOnly()).not.toBeNull();
    si.st.signedIn = true; await tick(30); expect(store.readOnly()).toBeNull();     // the reload is now waiting on the service
    si.st.signedIn = false; await tick(30); expect(store.readOnly()).not.toBeNull();
    release(); await tick(10); stop();
  });
  it('Draft all on a big deal waits while signed out and carries on after sign-in: nothing is counted as failed', async () => {
    const si = signIn(true); const store = makeStore(si.s, undefined, 15); await store.boot();
    const stop = store.watchSignIn(10); await tick(20);
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }, { quiet: true });
    const dealId = Object.values(store.get().deals)[0].id;
    for (let i = 1; i <= 60; i++) await store.dispatch(CreateQuestion, { dealId, text: `Provide the executed copy of contract ${i}.` }, { quiet: true });
    const run = draftAll(store, dealId); await tick(30);
    si.st.signedIn = false; await tick(400);
    const held = store.get().ui.batch; expect(held).not.toBeNull(); expect(held!.done).toBeLessThan(60);
    si.st.signedIn = true; await run;
    expect(store.get().ui.toasts.at(-1)!.text).toBe('60 drafted; review and accept');
    stop();
  });
  it('Draft all looks at each question again after waiting for sign-in: one answered elsewhere meanwhile is left alone', async () => {
    const si = signIn(true); const store = makeStore(si.s, undefined, 15); await store.boot();
    const stop = store.watchSignIn(10); await tick(20);
    await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }, { quiet: true });
    const dealId = Object.values(store.get().deals)[0].id;
    for (let i = 1; i <= 12; i++) await store.dispatch(CreateQuestion, { dealId, text: `Provide the executed copy of contract ${i}.` }, { quiet: true });
    si.st.signedIn = false; await tick(30);                                  // signed out before the batch starts: every worker holds a question
    drafted.length = 0; const run = draftAll(store, dealId); await tick(100);
    expect(drafted).toEqual([]);
    // meanwhile another PC answers every question (as its changes arrive here)
    const s = store.get(); const questions = { ...s.questions };
    for (const q of Object.values(questions)) if (q.dealId === dealId) questions[q.id] = { ...q, response: 'Provided in the data room, folder 2.2.', rev: q.rev + 1 };
    (store as unknown as { set: (x: unknown) => void }).set({ ...s, questions });
    si.st.signedIn = true; await run;
    expect(drafted).toEqual([]);                                              // nothing is drafted over their answers
    expect(store.get().ui.toasts.at(-1)!.text).toBe('0 drafted · 12 skipped');
    stop();
  });
});

