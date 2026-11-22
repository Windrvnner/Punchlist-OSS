// A save that could not be written is not lost: it is offered after a restart, and one that failed only because the
// Punchlist folder was out of reach is made by the app once the folder is back. Stand-in folders, at a deal's size.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk, refuse, Mem, ELSEWHERE, type Disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { CreateFinding } from '../../src/app/commands/findings';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, CreateFinding, ImportQuestions];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
/** the app on a PC's two folders: again on the same `kv`, the same install started again */
function start(kv: Disk = disk(), local = new MemoryLocal(), shared?: ReturnType<typeof memRepo>) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = shared ?? memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local, clock, ids }, COMMANDS);
  return { store, kv, repo, local };
}
const N = 2000;
/** a deal of 2,000 questions (deals run to that) */
async function deal(store: Store, size = N) {
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const id = Object.keys(store.get().deals)[0]; await store.loadDeal(id);
  const csv = ['No.,Question,Response', ...Array.from({ length: size }, (_, k) => `${k + 1},"Question ${k + 1}: please confirm item ${k + 1}.",`)].join('\n');
  const tbl = readCsv(new TextEncoder().encode(csv)); if (!tbl.ok) throw new Error('csv');
  const r = await store.dispatch(ImportQuestions, { dealId: id, mode: 'merge', rows: prepareImport(tbl.value.rows, suggestMapping(tbl.value.columns)).rows }, { quiet: true }); expect(r.ok).toBe(true);
  return id;
}
const q = (store: Store, dealId: string, n: number) => dealQuestions(store.get(), dealId).find((x) => String(x.n) === String(n))!;
const away = (kv: Disk) => refuse(kv.shared, () => true, () => Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' }));
/** what the journal on disk says of each entry */
const onDisk = (kv: Disk) => Object.values(JSON.parse((kv.local as Mem).files.get('ops.json') ?? '{}')).map((e: any) => e.data as { id: string; state: string; command: string });
const restart = async (kv: Disk, dealId: string) => { const again = start(kv); await again.store.boot(); await again.store.loadDeal(dealId); return again.store; };
const edit = (store: Store, dealId: string, n: number, value: string, field: 'text' | 'askedBy' = 'text') => store.dispatch(EditQuestionField, { dealId, questionId: q(store, dealId, n).id, field, value }, { quiet: true });   // as a field sends it

describe('a save the Punchlist folder could not take', () => {
  it('is offered as interrupted after a restart, with Retry that makes it (the journal said succeeded, and nothing was offered)', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    const r = await edit(store, dealId, 5, 'Typed while the folder was away');
    expect(!r.ok && r.error.kind).toBe('unreachable'); expect(store.interruptedOps().map((o) => o.state)).toEqual(['failed']);
    expect(onDisk(kv).filter((o) => o.command === 'EditQuestionField').map((o) => o.state)).toEqual(['pending']);      // not "succeeded": nothing was written
    back();
    const next = await restart(kv, dealId);
    const offered = next.interruptedOps(); expect(offered.map((o) => [o.command, o.state])).toEqual([['EditQuestionField', 'interrupted']]);
    expect(q(next, dealId, 5).text).toBe('Question 5: please confirm item 5.');
    const done = await next.retryOp(offered[0].id); expect(done?.ok).toBe(true);
    expect(q(next, dealId, 5).text).toBe('Typed while the folder was away'); expect(next.interruptedOps()).toEqual([]);
    expect((await restart(kv, dealId)).interruptedOps()).toEqual([]);
  });

  it('is not made by the app behind the person’s back, and nothing piles up while the folder stays away', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await store.dispatch(CreateQuestion, { dealId, text: 'Added while away' });
    for (let i = 0; i < 5; i++) await store.probeOnce();
    expect(store.interruptedOps()).toHaveLength(1); expect(onDisk(kv).filter((o) => o.command === 'CreateQuestion' && o.state !== 'succeeded')).toHaveLength(1);
    back(); await store.probeOnce();
    expect(store.get().net.down).toBe(false); expect(dealQuestions(store.get(), dealId).filter((x) => x.text === 'Added while away')).toHaveLength(0);
    expect(store.interruptedOps()).toHaveLength(1);                                       // still the person's to retry or discard
  });

  it('its notice’s Retry makes it once, however often it is pressed, and settles the entry that failed', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await store.dispatch(CreateQuestion, { dealId, text: 'Added while away' });
    const said = store.get().ui.toasts.find((x) => x.text === 'Couldn’t save ·')!; expect(said.action?.label).toBe('Retry');
    back(); said.action!.run!(); said.action!.run!(); await new Promise((r) => setTimeout(r, 50));
    expect(dealQuestions(store.get(), dealId).filter((x) => x.text === 'Added while away')).toHaveLength(1);
    expect(onDisk(kv).filter((o) => o.state === 'pending')).toEqual([]);
    expect((await restart(kv, dealId)).interruptedOps().filter((o) => o.state === 'interrupted')).toEqual([]);
  });

  it('two of the same action made while away are two actions: both are offered, neither is dropped', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await store.dispatch(CreateQuestion, { dealId }); await store.dispatch(CreateQuestion, { dealId });
    back(); const next = await restart(kv, dealId);
    expect(next.interruptedOps().map((o) => o.command)).toEqual(['CreateQuestion', 'CreateQuestion']);
  });

  it('a field’s later save that goes through settles its earlier ones: older text is not offered after a restart, nor written over newer', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await edit(store, dealId, 5, 'A: typed while away'); await edit(store, dealId, 5, 'A2: typed while away'); await edit(store, dealId, 5, 'Banker A', 'askedBy');
    back();
    expect((await edit(store, dealId, 5, 'B: typed after, saved')).ok).toBe(true);
    await store.probeOnce();
    expect(q(store, dealId, 5).text).toBe('B: typed after, saved');
    const next = await restart(kv, dealId);
    expect(next.interruptedOps().map((o) => [o.command, (o.input as any).field])).toEqual([['EditQuestionField', 'askedBy']]);      // the other field's save still waits for the person
  });

  it('a field’s save left from an earlier run is settled when the field saves again', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv); await edit(store, dealId, 5, 'Typed while away'); back();
    const next = await restart(kv, dealId); expect(next.interruptedOps()).toHaveLength(1);
    expect((await edit(next, dealId, 5, 'Typed while away')).ok).toBe(true);               // the field's kept text, sent again
    expect(next.interruptedOps()).toEqual([]); expect((await restart(kv, dealId)).interruptedOps()).toEqual([]);
  });

  it('the same action sent again from where its caller kept it (the same key and input) settles the one it repeats; another action under that key does not', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm the ratio' }, { idempotencyKey: 'ck-q-1' });
    back();
    expect((await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm the ratio' }, { idempotencyKey: 'ck-q-1' })).ok).toBe(true);
    expect(store.interruptedOps()).toEqual([]); expect((await restart(kv, dealId)).interruptedOps()).toEqual([]);
    // the key is the caller's, shared by its actions: another action under it is another action, and the first still waits
    const away2 = away(kv); await store.dispatch(CreateQuestion, { dealId, text: 'First card' }, { idempotencyKey: 'ck-q-1' }); away2();
    expect((await store.dispatch(CreateQuestion, { dealId, text: 'Second card' }, { idempotencyKey: 'ck-q-1' })).ok).toBe(true);
    expect(store.interruptedOps().map((o) => (o.input as any).text)).toEqual(['First card']);
  });

  it('is kept when the journal is pruned, however many actions follow', async () => {
    const { store, kv } = start(); const dealId = await deal(store, 300);
    const stop = refuse(kv.local, (x) => x.includes('Typed, own copy busy'), () => Object.assign(new Error('EBUSY'), { code: 'EBUSY' }), 1);
    const r = await edit(store, dealId, 5, 'Typed, own copy busy'); expect(!r.ok && r.error.kind).toBe('failed'); stop();
    for (let n = 10; n < 290; n++) await store.dispatch(SetResponse, { dealId, questionId: q(store, dealId, n).id, response: `Answer ${n}` }, { quiet: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(onDisk(kv).filter((o) => o.state === 'pending')).toHaveLength(1);
    expect((await restart(kv, dealId)).interruptedOps()).toHaveLength(1);
  });

  it('is left to the window that made it: another window started meanwhile does not offer it', async () => {
    const a = start(); const dealId = await deal(a.store);
    away(a.kv); await a.store.dispatch(CreateQuestion, { dealId, text: 'Added while away' });
    expect((a.store as any).beat).not.toBeNull();                                         // the window keeps saying it is alive while a save of its waits
    t += 30_000; (a.store as any).stamp();                                                // 30 seconds on: the first window's heartbeat has gone on meanwhile
    const b = start(a.kv, a.local, a.repo); await b.store.boot();
    expect(b.store.interruptedOps()).toEqual([]);
  });

  it('a caller that deals with the failure itself keeps doing so: its action is not made behind its back, nor offered after a restart', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    const r = await store.dispatch(CreateFinding, { dealId, title: 'From a chat card', workstream: 'Legal', body: ['x'], sources: [], origin: 'chat' }, { quiet: true });
    expect(!r.ok && r.error.kind).toBe('unreachable');
    expect(onDisk(kv).filter((o) => o.command === 'CreateFinding').map((o) => o.state)).toEqual(['failed']);
    back(); await store.probeOnce();
    expect(dealFindings(store.get(), dealId)).toEqual([]); expect(store.get().net.down).toBe(false);
    expect((await restart(kv, dealId)).interruptedOps().filter((o) => o.state === 'interrupted')).toEqual([]);
  });

  it('a save the folder refused for good (a clash) is settled as failed in the journal, not left as done', async () => {
    const { store, kv, repo } = start(); const dealId = await deal(store); const five = q(store, dealId, 5);
    repo.peer.change('question', five.id, { ...five, text: 'Theirs' }, ELSEWHERE);       // arrives as the save is made
    const r = await edit(store, dealId, 5, 'Mine'); expect(!r.ok && r.error.kind).toBe('conflict');
    expect(onDisk(kv).filter((o) => o.command === 'EditQuestionField').map((o) => o.state)).toEqual(['failed']);
  });
});

describe('a save cut off by the PC stopping', () => {
  it('with half its line written is offered as interrupted at the next start', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const append = kv.local.append.bind(kv.local);
    kv.local.append = (n, x) => { append(n, x.slice(0, Math.floor(x.length / 2))); throw new Error('power lost'); };
    void edit(store, dealId, 5, 'Typed as the power went'); await new Promise((r) => setTimeout(r, 30));
    kv.local.append = append;
    // the window is gone with the PC: what is on disk is all the next start has (the failed mark was never written)
    const disk2 = { shared: kv.shared, local: Object.assign(new Mem(), { files: new Map([...(kv.local as Mem).files].map(([k, v]) => [k, k === 'ops.json' ? v.replace('"state":"failed"', '"state":"pending"') : v])) }) };
    const next = await restart(disk2, dealId);
    expect(next.interruptedOps().map((o) => [o.command, o.state])).toEqual([['EditQuestionField', 'interrupted']]); expect(q(next, dealId, 5).text).toBe('Question 5: please confirm item 5.');
    expect((await next.retryOp(next.interruptedOps()[0].id))?.ok).toBe(true); expect(q(next, dealId, 5).text).toBe('Typed as the power went');
  });

  it('an Undo cut off after its line is written is known to be done too: its line names the Undo’s own entry, not the one it undoes', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const r = await store.dispatch(SetQuestionStatus, { dealId, questionId: q(store, dealId, 5).id, status: 'closed' });
    const append = kv.local.append.bind(kv.local), write = kv.local.write.bind(kv.local); let cut = false;
    kv.local.append = (n, x) => { append(n, x); cut = true; };
    kv.local.write = (n, x) => { if (n === 'ops.json' && cut) throw new Error('power lost'); write(n, x); };
    await store.undo((r as { value: { opId: string } }).value.opId);
    kv.local.append = append; kv.local.write = write;
    const next = await restart(kv, dealId);
    expect(next.interruptedOps()).toEqual([]); expect(q(next, dealId, 5).status).not.toBe('closed');
  });

  it('with its line written and its journal entry not yet settled is known to be done: nothing is offered, so it is not made twice', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const write = kv.local.write.bind(kv.local); let seen = 0;                             // the journal takes the pending entry, and nothing after it
    kv.local.write = (n, x) => { if (n === 'ops.json' && x.includes('Typed as the power went') && ++seen > 1) throw new Error('power lost'); write(n, x); };
    await edit(store, dealId, 5, 'Typed as the power went');
    kv.local.write = write; expect(onDisk(kv).filter((o) => o.state === 'pending')).toHaveLength(1);
    const next = await restart(kv, dealId);
    expect(next.interruptedOps()).toEqual([]); expect(q(next, dealId, 5).text).toBe('Typed as the power went'); expect(onDisk(kv).filter((o) => o.state === 'pending')).toEqual([]);
  });
});
