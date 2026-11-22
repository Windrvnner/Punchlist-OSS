// Edge cases of saves that could not be written. Stand-in folders.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { CONNECTED } from '../../src/app/connection';
import { memRepo, disk, refuse, Mem, type Disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec, readCsv } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding } from '../../src/app/commands/findings';
import { ImportQuestions } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';

const COMMANDS = [CreateDeal, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, CreateFinding, EditFinding, ImportQuestions];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
function start(kv: Disk = disk(), local = new MemoryLocal(), shared?: ReturnType<typeof memRepo>) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = shared ?? memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local, clock, ids }, COMMANDS);
  return { store, kv, repo, local };
}
const rows = (from: number, n: number) => { const csv = ['No.,Question,Response', ...Array.from({ length: n }, (_, k) => `${from + k},"Question ${from + k}.",`)].join('\n'); const tbl = readCsv(new TextEncoder().encode(csv)); if (!tbl.ok) throw new Error('csv'); return prepareImport(tbl.value.rows, suggestMapping(tbl.value.columns)).rows; };
async function deal(store: Store, size = 20) {
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const id = Object.keys(store.get().deals)[0]; await store.loadDeal(id);
  const r = await store.dispatch(ImportQuestions, { dealId: id, mode: 'merge', rows: rows(1, size) }, { quiet: true }); expect(r.ok).toBe(true);
  return id;
}
const q = (store: Store, dealId: string, n: number) => dealQuestions(store.get(), dealId).find((x) => String(x.n) === String(n))!;
const away = (kv: Disk) => refuse(kv.shared, () => true, () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
const onDisk = (kv: Disk) => Object.values(JSON.parse((kv.local as Mem).files.get('ops.json') ?? '{}')).map((e: any) => e.data as { id: string; state: string; command: string; input: any });
const restart = async (kv: Disk, dealId: string) => { const again = start(kv); await again.store.boot(); await again.store.loadDeal(dealId); return again.store; };
const edit = (store: Store, dealId: string, n: number, value: string) => store.dispatch(EditQuestionField, { dealId, questionId: q(store, dealId, n).id, field: 'text', value }, { quiet: true });
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('a save that could not be written, at the edges', () => {
  it('the folder away and the service up: the field tries once, and only one save of it waits however often the app probes', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    away(kv);
    // what a mounted EditField does on CONNECTED (editField.tsx: status failed + unreachable -> flush(draft))
    let tried = false; const field = () => { if (!tried) { tried = true; void edit(store, dealId, 5, 'Typed while the folder was away'); } };   // the field tries once
    window.addEventListener(CONNECTED, field);
    try {
      await edit(store, dealId, 5, 'Typed while the folder was away');
      for (let i = 0; i < 5; i++) { await store.probeOnce(); await tick(); }
    } finally { window.removeEventListener(CONNECTED, field); }
    const pending = onDisk(kv).filter((o) => o.command === 'EditQuestionField' && o.state === 'pending');
    const connected = store.get().ui.toasts.filter((x) => x.text === 'Connected again').length;
    expect({ pending: pending.length, offered: store.interruptedOps().length, connectedToasts: connected }).toEqual({ pending: 1, offered: 1, connectedToasts: connected });
    expect(connected).toBeLessThanOrEqual(2);
  });

  it('another action under the same idempotency key (a second chat card) leaves the first waiting, and its Retry makes it', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await store.dispatch(CreateQuestion, { dealId, text: 'First card: confirm the leverage covenant' }, { idempotencyKey: 'card-q-' + dealId });
    const firstToast = store.get().ui.toasts.find((x) => x.text === 'Couldn’t save ·')!;
    back();
    expect((await store.dispatch(CreateQuestion, { dealId, text: 'Second card: list key customers' }, { idempotencyKey: 'card-q-' + dealId })).ok).toBe(true);
    firstToast.action!.run!(); await tick(50);                                   // the first notice's Retry
    const texts = dealQuestions(store.get(), dealId).map((x) => x.text);
    const offeredAfterRestart = (await restart(kv, dealId)).interruptedOps().map((o) => (o.input as any).text);
    expect({ firstWritten: texts.includes('First card: confirm the leverage covenant'), inBar: store.interruptedOps().length, offeredAfterRestart }).toEqual({ firstWritten: true, inBar: 0, offeredAfterRestart: [] });
  });

  it('a second import into the same deal leaves an import that could not be written waiting', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rows(100, 5) }, { idempotencyKey: 'import-' + dealId });
    back();
    expect((await store.dispatch(ImportQuestions, { dealId, mode: 'merge', rows: rows(200, 5) }, { idempotencyKey: 'import-' + dealId })).ok).toBe(true);
    expect(store.interruptedOps().map((o) => o.command)).toEqual(['ImportQuestions']);
  });

  it('a finding’s later edit of another field leaves its title change that could not be written waiting', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'T0', workstream: 'Legal', body: ['B0'], origin: 'human' });
    const f = dealFindings(store.get(), dealId)[0];
    const base = { title: f.title, workstream: f.workstream, body: f.body };
    const back = away(kv);
    await store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'T1 renamed', workstream: 'Legal', body: ['B0'],
      base }, { idempotencyKey: 'f-edit-' + f.id });
    back();
    // the form was canceled; later the person opens it again (title still T0 on record) and changes only the detail
    const f2 = dealFindings(store.get(), dealId)[0];
    const base2 = { title: f2.title, workstream: f2.workstream, body: f2.body };
    expect((await store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'T0', workstream: 'Legal',
      body: ['B1 new detail'], base: base2 }, { idempotencyKey: 'f-edit-' + f.id })).ok).toBe(true);
    expect({ title: dealFindings(store.get(), dealId)[0].title, offered: store.interruptedOps().map((o) => (o.input as any).title) }).toEqual({ title: 'T0', offered: ['T1 renamed'] });
  });

  it('text taken back in the field after a failed save is not offered after a restart', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const back = away(kv);
    await edit(store, dealId, 5, 'Typed then deleted');
    back();
    // the field: the person types back the saved text, which it sends since a save of it waits (editField.test 'text taken back')
    expect((await edit(store, dealId, 5, 'Question 5: please confirm item 5.')).ok).toBe(true);
    const next = await restart(kv, dealId);
    expect(next.interruptedOps().map((o) => (o.input as any).value)).toEqual([]);
  });

  it('a change written while its journal entry could not be settled is not offered by a second window, so it is not made twice', async () => {
    const a = start(); const dealId = await deal(a.store);
    const write = a.kv.local.write.bind(a.kv.local); let n = 0;
    a.kv.local.write = (name, x) => { if (name === 'ops.json' && x.includes('Only once please') && ++n > 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); write(name, x); };
    expect((await a.store.dispatch(CreateQuestion, { dealId, text: 'Only once please' })).ok).toBe(true);
    a.kv.local.write = write;
    expect((a.store as any).beat).not.toBeNull(); t += 30_000; (a.store as any).stamp();       // the first window's heartbeat goes on meanwhile
    const b = start(a.kv, a.local, a.repo); await b.store.boot(); await b.store.loadDeal(dealId);
    const offered = b.store.interruptedOps();
    if (offered[0]) await b.store.retryOp(offered[0].id);
    expect(dealQuestions(b.store.get(), dealId).filter((x) => x.text === 'Only once please')).toHaveLength(1);
    expect(offered).toEqual([]);
  });
});

describe('the notice’s Retry', () => {
  it('runs the action when the journal refused its entry, once the journal is free', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const write = kv.local.write.bind(kv.local); let busy = true;
    kv.local.write = (name, x) => { if (name === 'ops.json' && busy && x.includes('Asked while the journal was busy')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); write(name, x); };
    const r = await store.dispatch(CreateQuestion, { dealId, text: 'Asked while the journal was busy' });
    expect(!r.ok && r.error.kind).toBe('failed');
    const said = store.get().ui.toasts.find((x) => x.text === 'Couldn’t save ·');
    busy = false;
    said?.action?.run?.(); await tick(50);
    expect({ label: said?.action?.label, written: dealQuestions(store.get(), dealId).some((x) => x.text === 'Asked while the journal was busy') }).toEqual({ label: 'Retry', written: true });
  });
});

describe('a field’s resend on reconnect', () => {
  it('meets a newer edit from another PC not yet seen here as any save does: refused as changed elsewhere, nothing overwritten', async () => {
    const { store, kv, repo } = start(); const dealId = await deal(store); const five = q(store, dealId, 5);
    const back = away(kv); await edit(store, dealId, 5, 'Mine, typed while away'); back();
    repo.peer.change('question', five.id, { ...five, text: 'Theirs, from the other PC' }, { by: 'sroe', from: 'PC B', at: '2026-11-17T10:05:00.000Z' });
    const r = await edit(store, dealId, 5, 'Mine, typed while away');                     // the field's one resend, before this window has seen the other PC's edit
    expect(!r.ok && r.error.kind).toBe('conflict');
    const next = await restart(kv, dealId); expect(q(next, dealId, 5).text).toBe('Theirs, from the other PC');
  });
});

describe('more edge cases', () => {
  it('the notice’s Retry does not write over another PC’s newer change that arrived meanwhile', async () => {
    const { store, kv, repo } = start(); const dealId = await deal(store); const five = q(store, dealId, 5);
    const back = away(kv);
    await store.dispatch(SetQuestionStatus, { dealId, questionId: five.id, status: 'closed' });
    const said = store.get().ui.toasts.find((x) => x.text === 'Couldn’t save ·')!;
    back(); repo.peer.change('question', five.id, { ...five, status: 'answered', text: 'Theirs' }, { by: 'sroe', from: 'PC B', at: '2026-11-17T10:05:00.000Z' });
    await repo.sync(); await (store as any).reloadTargets([five.id]);
    said.action!.run!(); await tick(50);
    expect(q(store, dealId, 5)).toMatchObject({ text: 'Theirs', status: 'answered' });
    expect(store.get().ui.toasts.at(-1)!.text).toMatch(/changed since/);
    expect(store.interruptedOps()).toHaveLength(1);                                       // still the person's to discard
  });

  it('a journal entry the journal refused once is written when the journal takes a write again, and the window stops stamping', async () => {
    const { store, kv } = start(); const dealId = await deal(store);
    const write = kv.local.write.bind(kv.local); let n = 0;
    kv.local.write = (name, x) => { if (name === 'ops.json' && x.includes('Once the journal was busy') && ++n > 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); write(name, x); };
    expect((await store.dispatch(CreateQuestion, { dealId, text: 'Once the journal was busy' })).ok).toBe(true);
    kv.local.write = write;
    expect((store as any).beat).not.toBeNull();
    expect((await edit(store, dealId, 6, 'A later save')).ok).toBe(true);
    expect(onDisk(kv).filter((o) => o.state === 'pending')).toEqual([]); expect((store as any).beat).toBeNull();
  });
});
