/**
 * A coworker's change on another PC that crosses a draft in progress: they close the question before the pending
 * draft has reached their PC. A coworker's close never throws drafting work away. The question does
 * not split into two versions; the draft still arrives, and Use as response fills the response and leaves it Closed.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetQuestionStatus, SetResponse } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { ResolveConflict, ReopenConflict } from '../../src/app/commands/conflicts';
import { ImportQuestions, RevertImport } from '../../src/app/commands/importQuestions';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { readCsv } from '../../src/domain/sheets';
import { prepareImport, suggestMapping } from '../../src/domain/importExport';
import { MemoryLocal } from '../../src/adapters/local';
import { ok } from '../../src/domain/result';
import { CURRENT_SCHEMA, type Question } from '../../src/domain/model';
import { Combined, isLine, type Line } from '../../src/backend/changeLog';
import type { Folder } from '../../src/backend/logRepository';

const COMMANDS = [
  CreateDeal, CreateQuestion, SetQuestionStatus, SetResponse, RequestDraft, ApplyDraft, AcceptDraft,
  RestoreQuestionSnapshot, ImportQuestions, RevertImport, ResolveConflict, ReopenConflict,
];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 17, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const rowsFrom = (csv: string) => { const r = readCsv(new TextEncoder().encode(csv)); if (!r.ok) throw new Error('csv'); return prepareImport(r.value.rows, suggestMapping(r.value.columns)).rows; };
const settle = () => new Promise((r) => setTimeout(r, 0));
const THEM = { by: 'sroe', from: 'PC B', at: '2026-11-17T10:30:00.000Z' };
const TEXT = 'The cap is 20% of the contract price.';

/** A deal of 2,000 questions. Every draft is held open until the test lets the model answer. */
async function world() {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
  let answer!: () => void; const held = new Promise<void>((r) => { answer = r; });
  const calls = { draft: 0 };
  const sources = [{ doc: 'EPC contract.pdf', loc: 'p. 82', docId: 'doc_epc' }];
  const reply = ok({ status: 'found' as const, text: TEXT, sources });
  const ai = { ...mockAi(opts, repo), draft: async () => { calls.draft++; await held; return reply; } };
  const store = new Store({ repo, ai, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  await store.boot(); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] });
  const dealId = Object.values(store.get().deals)[0].id; await store.loadDeal(dealId);
  const rows = rowsFrom(['No.,Question', ...Array.from({ length: 2000 }, (_, i) => `${i + 1},"Question ${i + 1}: what is the position on item ${i * 7919 % 10007}?"`)].join('\n'));
  expect((await store.dispatch(ImportQuestions, { dealId, mode: 'append', rows }, { quiet: true })).ok).toBe(true);
  const qs = () => Object.values(store.get().questions).filter((q) => q.dealId === dealId).sort((a, b) => a.n - b.n);
  expect(qs().length).toBe(2000);
  /** The coworker's PC changes the question as it stood before the draft was asked for: the pending draft has not reached it. */
  const theyChange = async (before: Question, patch: Partial<Question>, sawMarker = false) => {
    const { draft: _d, ...rest } = before; const was = sawMarker ? before : rest;
    repo.peer.edit('question', before.id, { ...was, ...patch, updatedAt: THEM.at }, THEM); await repo.sync(); await settle(); await settle();
  };
  const draft = async (q: Question) => { const r = await store.dispatch(RequestDraft, { dealId, questionId: q.id }); expect(r.ok).toBe(true); return r.ok ? r.value.opId : ''; };
  Object.assign(store.replyWait, { first: 20, max: 80 });                    // a held reply's tries go by quickly
  return { store, repo, dealId, qs, answer, theyChange, draft, calls, now: (id: string) => store.get().questions[id] };
}

/** what the shared folder holds, read as any PC reads it */
function folderView(shared: Folder) {
  const c = new Combined();
  for (const n of shared.list()) if (/^changes-.+\.jsonl$/.test(n)) for (const raw of (shared.read(n) ?? '').split('\n')) { try { const x = JSON.parse(raw); if (isLine(x)) c.add(x); } catch { /* not a whole line */ } }
  return c;
}
/** A PC of its own, on its own clock, writing a question onto exactly the version `base` of it. */
function pcWriting(shared: Folder, who: { by: string; from: string }) {
  const pc = `pc-${who.from.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`; let seq = 0;
  return (q: Question, base: string, data: Question, at: string) => {
    seq++; const line: Line = { v: 1, schema: CURRENT_SCHEMA, pc, seq, at, by: who.by, from: who.from, recs: [{ kind: 'question', id: q.id, ver: `${pc}.${seq}.0`, base: [base], data, schema: CURRENT_SCHEMA }] };
    shared.append(`changes-${pc}-${q.dealId}-0001.jsonl`, JSON.stringify(line) + '\n');
  };
}
/** PC B's clock runs a day behind; PC A's a day ahead. */
const HOME = { by: 'sroe', from: 'PC B', at: '2026-11-16T09:00:00.000Z' };
const OFFICE = { by: 'pdoe', from: 'PC A', at: '2026-11-18T11:00:00.000Z' };

describe('a coworker on another PC changes a question while its draft is being written', () => {
  it('a close that crosses the pending draft: one version, the draft arrives, and Use as response keeps it Closed; Undo puts it back', async () => {
    const w = await world(); const q = w.qs()[1499];
    const opId = await w.draft(q);
    await w.theyChange(q, { status: 'closed' });
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', draft: { status: 'pending', opId } });
    w.answer(); await w.store.settled(opId);
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', draft: { status: 'found', text: TEXT } });
    const before = w.now(q.id);
    const a = await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: q.id }); expect(a.ok).toBe(true);
    expect(w.now(q.id)).toMatchObject({ status: 'closed', response: TEXT, provenance: { origin: 'ai' } });
    expect((await w.store.undo(a.ok ? a.value.opId : '')).ok).toBe(true);
    expect(w.now(q.id)).toMatchObject({ status: 'closed', response: '', draft: before.draft });
  }, 120000);

  it('a close made after the pending marker reached the coworker, crossing the draft that replaced it: one version, and the draft is there to use', async () => {
    const w = await world(); const q = w.qs()[7];
    const opId = await w.draft(q); const seenThere = w.now(q.id); w.answer(); await w.store.settled(opId);
    expect(w.now(q.id).draft?.status).toBe('found');
    await w.theyChange(seenThere, { status: 'closed' }, true);
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', draft: { status: 'found', text: TEXT } });
    expect((await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: q.id })).ok).toBe(true);
    expect(w.now(q.id)).toMatchObject({ status: 'closed', response: TEXT });
  }, 120000);

  it('a response the coworker typed stays, and the draft beside it is kept, not taken over it', async () => {
    const w = await world(); const q = w.qs()[42];
    const opId = await w.draft(q);
    await w.theyChange(q, { response: 'Per the signed EPC, 15%.', respondedBy: 'Sponsor' });
    w.answer(); await w.store.settled(opId);
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ response: 'Per the signed EPC, 15%.', respondedBy: 'Sponsor', draft: { status: 'found', text: TEXT } });
    expect((await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: q.id }, { quiet: true })).ok).toBe(false);   // asks first: it has a response
    expect(w.now(q.id).response).toBe('Per the signed EPC, 15%.');
  }, 120000);

  it('a rewording that crosses the draft keeps the new words; the draft arrives marked as for the old words', async () => {
    const w = await world(); const q = w.qs()[900];
    const opId = await w.draft(q);
    await w.theyChange(q, { text: 'What is the aggregate liability cap?' });
    w.answer(); await w.store.settled(opId);
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ text: 'What is the aggregate liability cap?', draft: { status: 'found' } });
    expect((await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: q.id }, { quiet: true })).ok).toBe(false);   // stale: draft it again
  }, 120000);

  it('a workstream changed on the other PC while the draft was written: one version, both kept', async () => {
    const w = await world(); const q = w.qs()[1200];
    const opId = await w.draft(q);
    await w.theyChange(q, { workstream: 'Legal' });
    w.answer(); await w.store.settled(opId);
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ workstream: 'Legal', draft: { status: 'found', text: TEXT } });
  }, 120000);

  it('a close that reaches the folder just before the reply, unseen by this window yet: the reply still lands on it', async () => {
    const w = await world(); const q = w.qs()[1499];
    const opId = await w.draft(q);
    const { draft: _d, ...was } = q;
    w.repo.peer.edit('question', q.id, { ...was, status: 'closed', updatedAt: THEM.at }, THEM);        // in the folder; this window has not looked
    w.answer(); await w.store.settled(opId); await settle();
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', draft: { status: 'found', text: TEXT } });
  }, 120000);

  it('another change that arrives while the reply is planned again does not lose it either', async () => {
    const w = await world(); const q = w.qs()[1500];
    const opId = await w.draft(q); const pendingDraft = w.now(q.id).draft;
    const { draft: _d, ...was } = q;
    w.repo.peer.edit('question', q.id, { ...was, status: 'closed', updatedAt: THEM.at }, THEM);
    // the moment the window reads the question again, a third PC's change lands in the folder
    const get = w.repo.get.bind(w.repo); let once = true;
    w.repo.get = (async (kind: any, id: string) => {
      const r = await get(kind, id);
      if (once && kind === 'question' && id === q.id) { once = false; w.repo.peer.change('question', q.id, { ...was, status: 'closed', workstream: 'Legal', draft: pendingDraft, updatedAt: THEM.at }, { ...THEM, from: 'Tablet' }); }
      return r;
    }) as typeof w.repo.get;
    w.answer(); await w.store.settled(opId); await w.repo.sync(); await settle(); await settle();
    expect(once).toBe(false); expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', workstream: 'Legal', draft: { status: 'found', text: TEXT } });
  }, 120000);

  it('at deal scale: 150 drafts crossed by 150 closes leave no second versions and every draft usable', async () => {
    const w = await world(); const picked = w.qs().filter((_, i) => i % 13 === 0).slice(0, 150); expect(picked.length).toBe(150);
    const ops: string[] = []; for (const q of picked) ops.push(await w.draft(q));
    for (const q of picked) { const { draft: _d, ...was } = q; w.repo.peer.edit('question', q.id, { ...was, status: 'closed', updatedAt: THEM.at }, THEM); }
    await w.repo.sync(); await settle(); await settle();
    w.answer(); for (const o of ops) await w.store.settled(o);
    expect(Object.keys(w.store.get().conflicts)).toEqual([]);
    expect(picked.every((q) => w.now(q.id).status === 'closed' && w.now(q.id).draft?.status === 'found')).toBe(true);
    for (const q of picked.slice(0, 20)) expect((await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: q.id }, { quiet: true })).ok).toBe(true);
    expect(picked.slice(0, 20).every((q) => w.now(q.id).status === 'closed' && w.now(q.id).response === TEXT)).toBe(true);
  }, 240000);
});

describe('two coworkers close a question while it is being drafted, one before the pending draft reached them and one after', () => {
  /** B closes the question as it was before the draft was asked for; C closes it as it stood with the pending draft. */
  const bothClose = (w: Awaited<ReturnType<typeof world>>, q: Question, home: ReturnType<typeof pcWriting>, office: ReturnType<typeof pcWriting>) => {
    const v = folderView(w.repo.shared); const marker = v.state('question', q.id).tips[0]; const asked = v.version(marker)!;
    const was = v.version(asked.base[0])!.data as Question; const pending = asked.data as Question;
    home(q, asked.base[0], { ...was, status: 'closed', updatedAt: HOME.at }, HOME.at);
    office(q, marker, { ...pending, status: 'closed', updatedAt: OFFICE.at }, OFFICE.at);
  };

  it('three PCs, clocks a day apart: one version, Closed, the reply lands on it and Use as response keeps it Closed', async () => {
    const w = await world(); const q = w.qs()[1499];
    const home = pcWriting(w.repo.shared, HOME), office = pcWriting(w.repo.shared, OFFICE);
    const opId = await w.draft(q); await w.repo.sync();
    bothClose(w, q, home, office); await w.repo.sync(); await settle(); await settle();
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', draft: { status: 'pending', opId } });
    w.answer(); await w.store.settled(opId); await settle();
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', draft: { status: 'found', text: TEXT } });
    expect((await w.store.dispatch(AcceptDraft, { dealId: w.dealId, questionId: q.id })).ok).toBe(true);
    expect(w.now(q.id)).toMatchObject({ status: 'closed', response: TEXT });
  }, 120000);

  it('the two closes reach the folder just before the reply, unseen by this window: the reply still lands', async () => {
    const w = await world(); const q = w.qs()[3];
    const home = pcWriting(w.repo.shared, HOME), office = pcWriting(w.repo.shared, OFFICE);
    const opId = await w.draft(q); await w.repo.sync();
    bothClose(w, q, home, office);                                                            // in the folder; this window has not looked
    w.answer(); await w.store.settled(opId); await settle();
    expect(w.store.get().conflicts[q.id]).toBeUndefined();
    expect(w.now(q.id)).toMatchObject({ status: 'closed', draft: { status: 'found', text: TEXT } });
  }, 120000);

  it('at deal scale: 120 drafts, each closed by two coworkers on either side of its marker, leave no second versions and every reply landed', async () => {
    const w = await world(); const picked = w.qs().filter((_, i) => i % 16 === 5).slice(0, 120); expect(picked.length).toBe(120);
    const home = pcWriting(w.repo.shared, HOME), office = pcWriting(w.repo.shared, OFFICE);
    const ops: string[] = []; for (const q of picked) ops.push(await w.draft(q));
    await w.repo.sync();
    for (const q of picked) bothClose(w, q, home, office);
    await w.repo.sync(); await settle(); await settle();
    w.answer(); for (const o of ops) await w.store.settled(o);
    expect(Object.keys(w.store.get().conflicts)).toEqual([]);
    expect(picked.every((q) => w.now(q.id).status === 'closed' && w.now(q.id).draft?.status === 'found')).toBe(true);
  }, 240000);
});

describe('a reply held while its question has two versions (#22)', () => {
  const until = async (done: () => boolean) => {
    for (let n = 0; n < 400 && !done(); n++) await new Promise((r) => setTimeout(r, 10));
    expect(done()).toBe(true);
  };
  type World = Awaited<ReturnType<typeof world>>;
  /** the version of the question's choice written on this PC (`here`), or the coworker's */
  const versionOf = (w: World, id: string, here: boolean) =>
    w.store.get().conflicts[id].versions.find((v) => !!v.here === here)!;
  const keep = (w: World, recordId: string, version: string) =>
    w.store.dispatch(ResolveConflict, { dealId: w.dealId, recordId, keep: version }, { quiet: true });
  const type = (w: World, q: Question) =>
    w.store.dispatch(SetResponse, { dealId: w.dealId, questionId: q.id, response: 'Typed here' });
  /** the newest version of each question, in the shared folder, that holds no draft: what a coworker had before it */
  const beforeDrafts = async (w: World, picked: Question[]) => {
    await w.repo.sync(); const v = folderView(w.repo.shared);
    return new Map(picked.map((q) => {
      let ver = v.state('question', q.id).tips[0];
      while ((v.version(ver)!.data as Question).draft) ver = v.version(ver)!.base[0];
      return [q.id, { ver, data: v.version(ver)!.data as Question }];
    }));
  };
  /** A coworker changes each question as it stood before its draft was asked for: no draft reached them. */
  const theyChangeUnseen = async (w: World, picked: Question[], patch: (i: number) => Partial<Question>) => {
    const before = await beforeDrafts(w, picked); const coworker = pcWriting(w.repo.shared, THEM);
    for (const [i, q] of picked.entries()) {
      const was = before.get(q.id)!;
      coworker(q, was.ver, { ...was.data, ...patch(i), updatedAt: THEM.at }, THEM.at);
    }
    await w.repo.sync(); await settle(); await settle();
  };
  /**
   * The coworker closes each question with its draft request pending, then their PC gives the request up (marked
   * failed); meanwhile the reply was written here and a response typed. Q50 is closed with the coworker's own words.
   */
  const theyCloseAndGiveUp = async (w: World, picked: Question[], markers: Map<string, string>) => {
    const coworker = pcWriting(w.repo.shared, THEM); const v = folderView(w.repo.shared);
    for (const [i, q] of picked.entries()) {
      const pending = v.version(markers.get(q.id)!)!.data as Question;
      const closed = { ...pending, status: 'closed' as const, ...(i === 49 ? { response: 'Their words' } : {}) };
      coworker(q, markers.get(q.id)!, { ...closed, updatedAt: THEM.at }, THEM.at);
      const gaveUp = { ...closed, draft: { ...pending.draft!, status: 'failed' as const }, updatedAt: THEM.at };
      const tip = folderView(w.repo.shared).state('question', q.id).tips.find((t) => t.startsWith('pc-pc-b'))!;
      coworker(q, tip, gaveUp, THEM.at);
    }
    await w.repo.sync(); await settle(); await settle();
  };

  it('a written draft goes with whichever version is kept: 100 of 2,000 questions, one model call each', async () => {
    const w = await world(); const picked = w.qs().slice(0, 100);
    const ops = new Map<string, string>();
    for (const q of picked) ops.set(q.id, await w.draft(q));
    await w.repo.sync(); const v = folderView(w.repo.shared);
    const markers = new Map(picked.map((q) => [q.id, v.state('question', q.id).tips[0]]));
    w.answer(); for (const q of picked) await w.store.settled(ops.get(q.id)!);
    for (const q of picked) expect((await type(w, q)).ok).toBe(true);
    await theyCloseAndGiveUp(w, picked, markers);
    expect(picked.every((q) => w.store.get().conflicts[q.id])).toBe(true);
    // Q100 keeps the typed version; the rest keep the coworker's close
    for (const [i, q] of picked.entries()) expect((await keep(w, q.id, versionOf(w, q.id, i === 99).id)).ok).toBe(true);
    const written = (q: Question) => w.now(q.id).draft?.status === 'found' && w.now(q.id).draft?.text === TEXT;
    expect(picked.every((q) => written(q) && w.now(q.id).draft?.opId === ops.get(q.id))).toBe(true);
    expect(w.calls.draft).toBe(100);
    const closedAs = (i: number) => ({ status: 'closed', response: i === 49 ? 'Their words' : '' });
    const typedAs = { status: 'open', response: 'Typed here' };
    for (const [i, q] of picked.entries()) expect(w.now(q.id)).toMatchObject(i === 99 ? typedAs : closedAs(i));
    // the typed version not kept is listed under Deleted
    const typedAside = Object.values(w.store.get().tombstones)
      .filter((t) => (t.snapshot as Question | undefined)?.response === 'Typed here');
    expect(typedAside.length).toBe(99);
  }, 240000);

  it('Undo of the choice brings both versions back as they were', async () => {
    const w = await world(); const q = w.qs()[10];
    const opId = await w.draft(q);
    await type(w, q);
    await theyChangeUnseen(w, [q], () => ({ status: 'closed' }));
    w.answer(); await until(() => w.store.hasKeptReply(opId));
    const shown = () => w.store.get().conflicts[q.id].versions.map((v) => {
      const { rev: _r, ...data } = v.data as Question; return { by: v.by, from: v.from, data };
    });
    const before = shown();
    const r = await keep(w, q.id, versionOf(w, q.id, false).id);
    expect(r.ok).toBe(true);
    expect(w.now(q.id).draft?.opId).toBe(opId);
    expect((await w.store.undo(r.ok ? r.value.opId : '')).ok).toBe(true);
    expect(shown()).toEqual(before);
  }, 120000);

  it('a draft the coworker used is not brought back, even when the choice is undone and made again', async () => {
    const w = await world(); const q = w.qs()[30];
    const opId = await w.draft(q); w.answer(); await w.store.settled(opId);
    await w.repo.sync(); const v = folderView(w.repo.shared); const found = v.state('question', q.id).tips[0];
    await type(w, q);
    // the coworker's PC uses the written draft as the response, without seeing the response typed here
    const foundThere = v.version(found)!.data as Question;
    const theirs = { ...foundThere, response: TEXT, status: 'answered' as const, draft: undefined };
    pcWriting(w.repo.shared, THEM)(q, found, { ...theirs, updatedAt: THEM.at }, THEM.at);
    await w.repo.sync(); await settle(); await settle();
    const r = await keep(w, q.id, versionOf(w, q.id, false).id);
    expect(r.ok).toBe(true);
    expect(w.now(q.id)).toMatchObject({ status: theirs.status, response: theirs.response });
    expect(w.now(q.id).draft).toBeUndefined();
    expect((await w.store.undo(r.ok ? r.value.opId : '')).ok).toBe(true);
    expect((await keep(w, q.id, versionOf(w, q.id, false).id)).ok).toBe(true);
    expect(w.now(q.id).draft).toBeUndefined();
  }, 120000);

  it('a coworker\'s close kept beside a delete by a third PC takes the held draft with it', async () => {
    const w = await world(); const q = w.qs()[60];
    const opId = await w.draft(q); await type(w, q);
    const before = (await beforeDrafts(w, [q])).get(q.id)!;
    pcWriting(w.repo.shared, THEM)(q, before.ver, { ...before.data, status: 'closed', updatedAt: THEM.at }, THEM.at);
    w.repo.peer.remove('question', q.id, { ...THEM, from: 'PC C' });
    await w.repo.sync(); await settle(); await settle();
    expect(w.store.get().conflicts[q.id]?.versions.length).toBe(3);
    w.answer(); await until(() => w.store.hasKeptReply(opId));
    const versions = w.store.get().conflicts[q.id].versions;
    const closed = versions.find((v) => (v.data as Question | null)?.status === 'closed')!;
    expect((await keep(w, q.id, closed.id)).ok).toBe(true);
    expect(w.now(q.id).draft?.opId).toBe(opId);
    w.store.retryKeptReply(opId);
    await until(() => w.now(q.id).draft?.status === 'found');
    expect(w.now(q.id)).toMatchObject({ status: 'closed', response: '', draft: { text: TEXT } });
    expect(w.calls.draft).toBe(1);
  }, 120000);

  it('two crossing drafts are never merged: keeping a version without a draft carries neither', async () => {
    const w = await world(); const q = w.qs()[20];
    await w.draft(q); await w.repo.sync(); const forWording = w.now(q.id).draft!.forWording;
    const v = folderView(w.repo.shared); const base = v.version(v.state('question', q.id).tips[0])!.base[0];
    const was = v.version(base)!.data as Question;
    const opId = 'op_01HZZZZZZZZZZZZZZZZ9999999';
    const theirs = { status: 'pending' as const, text: '', sources: [], forWording, opId, at: HOME.at };
    // one coworker asks for a draft of their own, and another closes it, both on the version before this PC's draft
    pcWriting(w.repo.shared, HOME)(q, base, { ...was, draft: theirs, updatedAt: HOME.at }, HOME.at);
    pcWriting(w.repo.shared, OFFICE)(q, base, { ...was, status: 'closed', updatedAt: OFFICE.at }, OFFICE.at);
    await w.repo.sync(); await settle(); await settle();
    const versions = w.store.get().conflicts[q.id]?.versions ?? [];
    expect(new Set(versions.map((x) => (x.data as Question | null)?.draft?.opId)).size).toBe(3);   // two drafts, none
    const bare = versions.find((x) => x.data && !(x.data as Question).draft)!;
    expect((await keep(w, q.id, bare.id)).ok).toBe(true);
    expect(w.now(q.id)).toMatchObject({ status: 'closed' });
    expect(w.now(q.id).draft).toBeUndefined();
  }, 120000);
});
