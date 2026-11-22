import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession, mockFirstPass } from '../../src/adapters/mocks';
import { CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { CreateFinding, EditFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment } from '../../src/app/commands/findings';
import { reassess } from '../../src/app/findings';
import { registry } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { dealFindings } from '../../src/app/state';

const COMMANDS = [CreateDeal, AddFolders, DeleteDeal, RecordIndexingProgress, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, RequestDraft, ApplyDraft, RecoverDrafts, DiscardDraft, AcceptDraft, RestoreQuestionSnapshot, CreateFinding, SetFindingStatus, ReviewFinding, DeleteFinding, RestoreFinding, RestoreFindingSnapshot, Reassess, ApplyReassessment];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 10, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function make(kv = disk()) {
  const opts = { latency: [0, 0] as [number, number] };
  const repo = memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, kv, repo };
}
async function deal(store: Store, name = 'Datum') { await store.boot(); await store.dispatch(CreateDeal, { name, folders: [] }); const id = Object.values(store.get().deals).find((d) => d.name === `Project ${name}`)!.id; await store.loadDeal(id); return id; }

describe('findings', () => {
  it('a detail a person rewrites is their own words, not cited by every source', async () => {
    const { store } = make(); const dealId = await deal(store);
    const sources = [{ doc: 'Technical advisor report.pdf', loc: 'p. 41', docId: 'doc_ta' }];
    await store.dispatch(CreateFinding, { dealId, title: 'Availability is optimistic', workstream: 'Technical', body: ['The advisor assumes 98%. [1]'], sources, origin: 'chat' });
    const f = dealFindings(store.get(), dealId)[0]; expect(f.ownWords).toBeUndefined();
    await store.dispatch(EditFinding, { dealId, findingId: f.id, title: f.title, workstream: f.workstream,
      body: ['The advisor assumes 98%. I think that is too high.'] });
    expect(store.get().findings[f.id].ownWords).toBe(true);
    await store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'Availability looks high',
      workstream: f.workstream, body: store.get().findings[f.id].body });
    expect(store.get().findings[f.id].ownWords).toBe(true);                    // a change to the title alone keeps it
  });

  it('an update from the documents never replaces words or a review changed while it ran', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'Lock-up is loose', workstream: 'Legal', body: ['Original detail.'] }); const f0 = dealFindings(store.get(), dealId)[0];
    const from = { body: f0.body, reviewed: null, sources: f0.sources, mark: JSON.stringify([false, '', null]), responses: '' };
    // B, while A's update runs
    await store.dispatch(EditFinding, { dealId, findingId: f0.id, title: f0.title, workstream: f0.workstream,
      body: ['B rewrote this.'] });
    const ctx = { at: clock.now(), actor: 'adoe', firm: '', opId: 'op_y', ids };
    const r = ApplyReassessment.plan(store.get(), { dealId, findingId: f0.id, requestOpId: 'op_x', from, result: { body: ['The model’s new wording.'], sources: [] } }, ctx as any);
    expect(r.ok).toBe(false); expect((r as any).error.message).toMatch(/^Not updated: the finding was changed meanwhile$/);
    const unchanged = ApplyReassessment.plan(store.get(), { dealId, findingId: f0.id, requestOpId: 'op_x', from: { ...from, body: ['B rewrote this.'] }, result: { body: ['The model’s new wording.'], sources: [] } }, ctx as any);
    expect(unchanged.ok).toBe(true);
  });

  it('saving an edit writes only what this person changed, never undoing a change made elsewhere meanwhile', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'Lock-up is loose', workstream: 'Legal', body: ['Detail.'] }); const f = dealFindings(store.get(), dealId)[0];
    // what A's edit card opened with
    const base = { title: f.title, workstream: f.workstream, body: f.body };
    // B changes the workstream
    await store.dispatch(EditFinding, { dealId, findingId: f.id, ...base, workstream: 'Financial' });
    const r = await store.dispatch(EditFinding, { dealId, findingId: f.id, ...base, title: 'Lock-up test is loose', base });   // A changes only the title
    expect(r.ok).toBe(true);
    expect(store.get().findings[f.id]).toMatchObject({ title: 'Lock-up test is loose', workstream: 'Financial' });
    // both changed the same field: refused, with the reason, rather than one silently winning
    const clash = { dealId, findingId: f.id, ...base, workstream: 'Tax', base };
    const both = await store.dispatch(EditFinding, clash, { quiet: true });
    expect(both.ok).toBe(false); expect((both as any).error.message).toMatch(/changed elsewhere/i);
  });

  it('a title has one limit for making and editing, and a title already longer can still be edited', async () => {
    const { store } = make(); const dealId = await deal(store);
    const long = 'L'.repeat(301);
    const made = await store.dispatch(CreateFinding, { dealId, title: long, workstream: 'Legal' }, { quiet: true });
    expect(made.ok).toBe(false); expect((made as any).error.fields?.title ?? (made as any).error.message).toMatch(/under 300/);
    // a finding written before the limit (or by the model) with a 400-character title: still editable, but may not grow
    await store.dispatch(CreateFinding, { dealId, title: 'Short for now', workstream: 'Legal' }); const f = dealFindings(store.get(), dealId)[0];
    const s = store.get(); const state = { ...s, findings: { ...s.findings, [f.id]: { ...f, title: 'T'.repeat(400) } } };
    const ctx = { at: clock.now(), actor: 'adoe', firm: '', opId: 'op_x', ids };
    const edit = (title: string) => EditFinding.plan(state, { dealId, findingId: f.id, title, workstream: 'Legal',
      body: [] }, ctx as any);
    expect(edit('T'.repeat(399)).ok).toBe(true); expect(edit('T'.repeat(400) + ' more').ok).toBe(false); expect(edit('T'.repeat(300)).ok).toBe(true);
  });

  it('a person creates a finding with no sources; it has no code, and can be deleted and restored', async () => {
    const { store } = make(); const dealId = await deal(store);
    const r = await store.dispatch(CreateFinding, { dealId, title: 'Step-in period is short', workstream: 'Legal' });
    expect(r.ok).toBe(true);
    const f = dealFindings(store.get(), dealId)[0];
    expect('code' in f).toBe(false); expect(f.origin).toBe('human'); expect(f.raisedBy).toBe('jdoe'); expect(f.sources.length).toBe(0);
    const del = await store.dispatch(DeleteFinding, { dealId, findingId: f.id });
    expect(dealFindings(store.get(), dealId).length).toBe(0);
    expect(store.get().tombstones[f.id].kind).toBe('finding');
    await store.undo((del as any).value.opId);
    expect(dealFindings(store.get(), dealId)[0].id).toBe(f.id);
  });

  it('ids are unique across deals, and deleting a finding in one deal leaves the other alone', async () => {
    const { store } = make(); const a = await deal(store, 'Datum'); await store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const b = Object.values(store.get().deals).find((d) => d.name === 'Project Proseware')!.id; await store.loadDeal(b);
    await store.dispatch(CreateFinding, { dealId: a, title: 'one', workstream: 'Legal' });
    await store.dispatch(CreateFinding, { dealId: b, title: 'other deal', workstream: 'Legal' });
    const fa = dealFindings(store.get(), a)[0]; const fb = dealFindings(store.get(), b)[0];
    expect(fa.id).not.toBe(fb.id);
    await store.dispatch(DeleteFinding, { dealId: a, findingId: fa.id });
    expect(dealFindings(store.get(), b).length).toBe(1);               // deleting in one deal leaves the other alone
    await store.dispatch(CreateFinding, { dealId: a, title: 'two', workstream: 'Legal' });
    expect(dealFindings(store.get(), a).map((f) => f.title)).toEqual(['two']);
  });

  it('closing with a note is one operation; undo restores status and note together', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'x', workstream: 'Legal' });
    const f = dealFindings(store.get(), dealId)[0];
    const r = await store.dispatch(SetFindingStatus, { dealId, findingId: f.id, status: 'closed', note: 'Confirmed with counsel' });
    expect(store.get().findings[f.id]).toMatchObject({ status: 'closed', note: 'Confirmed with counsel' });
    await store.undo((r as any).value.opId);
    expect(store.get().findings[f.id]).toMatchObject({ status: 'open', note: '' });
    const au = await repo.audit(f.id);
    expect(au.ok && au.value.map((a) => a.kind)).toEqual(['created', 'status', 'note', 'undone']);
  });

  it('review is set and cleared only by ReviewFinding and records who', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'x', workstream: 'Legal' });
    const f = dealFindings(store.get(), dealId)[0];
    await store.dispatch(ReviewFinding, { dealId, findingId: f.id, reviewed: true });
    expect(store.get().findings[f.id].reviewed?.by).toBe('jdoe');
    await store.dispatch(ReviewFinding, { dealId, findingId: f.id, reviewed: false });
    expect(store.get().findings[f.id].reviewed).toBeNull();
  });

  it('a response on a linked question offers reassessment; reassess replaces the body, clears the mark, keeps the previous assessment in the audit, and can be undone', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'x', workstream: 'Legal', body: ['Original view.'] });
    const f = dealFindings(store.get(), dealId)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm.', linkedFinding: f.id });
    const q = Object.values(store.get().questions)[0];
    expect(q.linkedFinding).toBe(f.id);
    await store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Confirmed.' });
    expect(store.get().findings[f.id].updated).toBe(true); expect(store.get().findings[f.id].updatedWhy).toBe(`Response received on Q${q.n}`);
    await reassess(store, dealId, f.id);
    const f2 = store.get().findings[f.id];
    expect(f2.body).toEqual(['Reassessed.']); expect(f2.updated).toBe(false); expect(f2.updatedWhy).toBe('');                 // the reason goes with the mark
    const au = await repo.audit(f.id);
    const re = au.ok ? au.value.find((a) => a.kind === 'reassessed') : null;
    expect(re?.from).toEqual(['Original view.']);
    const op = Object.values(store.get().ops).find((o) => o.command === 'ApplyReassessment')!;
    await store.undo(op.id);
    expect(store.get().findings[f.id].body).toEqual(['Original view.']);
    expect(store.get().findings[f.id].updated).toBe(true);
  });

  it('a draft used in place of a linked question\'s response marks the finding, and Undo takes that mark back off', async () => {
    const { store } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'x', workstream: 'Legal', body: ['Original view.'] });
    const f = dealFindings(store.get(), dealId)[0];
    await store.dispatch(CreateQuestion, { dealId, text: 'Please confirm.', linkedFinding: f.id });
    const q = Object.values(store.get().questions)[0];
    await store.dispatch(SetResponse, { dealId, questionId: q.id, response: 'Confirmed.' });
    await reassess(store, dealId, f.id); expect(store.get().findings[f.id].updated).toBe(false);
    await store.dispatch(RequestDraft, { dealId, questionId: q.id });
    const opId = store.get().questions[q.id].draft!.opId!;
    await store.dispatch(ApplyDraft, { dealId, questionId: q.id, requestOpId: opId, result: { status: 'found', text: 'Confirmed. The documents agree.', sources: [] } });
    const used = await store.dispatch(AcceptDraft, { dealId, questionId: q.id, replace: true });
    expect(used.ok).toBe(true); expect(store.get().findings[f.id].updated).toBe(true);
    await store.undo((used as any).value.opId);
    expect(store.get().questions[q.id].response).toBe('Confirmed.'); expect(store.get().findings[f.id].updated).toBe(false);
  });

  it('an update that replaces the words clears the review given to the old ones, says so, keeps who gave it, and Undo puts both back; an update that changes no word leaves the review', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    await store.dispatch(CreateFinding, { dealId, title: 'x', workstream: 'Legal', body: ['Original view.'] });
    const f = dealFindings(store.get(), dealId)[0];
    await store.dispatch(ReviewFinding, { dealId, findingId: f.id, reviewed: true });
    const given = store.get().findings[f.id].reviewed!; expect(given.by).toBe('jdoe');
    await reassess(store, dealId, f.id);
    expect(store.get().findings[f.id].body).toEqual(['Reassessed.']); expect(store.get().findings[f.id].reviewed).toBeNull();
    expect(store.get().ui.toasts.at(-1)!.text).toBe('Finding updated · review cleared');
    const au = await repo.audit(f.id); const op = Object.values(store.get().ops).find((o) => o.command === 'ApplyReassessment')!;
    const un = au.ok ? au.value.find((a) => a.kind === 'unreviewed' && a.opId === op.id) : null;
    expect(un?.from).toEqual(given);                                             // the cleared review stays on the record of the update that cleared it
    await store.undo(op.id);
    expect(store.get().findings[f.id].body).toEqual(['Original view.']); expect(store.get().findings[f.id].reviewed).toEqual(given);
    // the same words again: nothing a person read has changed, so the review stands
    await store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'x', workstream: 'Legal',
      body: ['Reassessed.'] });
    await store.dispatch(ReviewFinding, { dealId, findingId: f.id, reviewed: false });
    await store.dispatch(ReviewFinding, { dealId, findingId: f.id, reviewed: true });
    await reassess(store, dealId, f.id);
    expect(store.get().findings[f.id].body).toEqual(['Reassessed.']); expect(store.get().findings[f.id].reviewed?.by).toBe('jdoe');
    expect(store.get().ui.toasts.at(-1)!.text).toBe('Finding updated');
  });

  it('the first pass writes through the repository; the app hears through the change feed and never re-raises a deleted finding', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20);
    const fs = dealFindings(store.get(), dealId);
    expect(fs.length).toBe(3); expect(fs.every((f) => f.origin === 'ai' && f.sources.length >= 1)).toBe(true);
    await store.dispatch(DeleteFinding, { dealId, findingId: fs[0].id });
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(20);
    expect(dealFindings(store.get(), dealId).length).toBe(2);
    expect(dealFindings(store.get(), dealId).some((f) => f.title === fs[0].title)).toBe(false);
  });

  it('a deal opened by several callers at once asks for its gaps and unread responses once', async () => {
    const { store } = make(); const dealId = await deal(store);
    let gaps = 0, responses = 0; const g = store.services.ai.gaps; store.services.ai.gaps = (id) => { gaps++; return g(id); };
    const r = store.services.ai.responses; store.services.ai.responses = (id) => { responses++; return r ? r(id) : Promise.resolve({ ok: true, value: undefined }) as any; };
    (store as any).gapsAsked.clear();                                             // as when the deal is opened again in a new session
    await Promise.all([store.loadDeal(dealId), store.loadDeal(dealId), store.loadDeal(dealId)]); await store.loadDeal(dealId); await sleep(20);
    expect([gaps, responses]).toEqual([1, 1]);
  });

  it('the gaps are refreshed when findings change, and no summary is asked for (Overview has none)', async () => {
    const { store, repo } = make(); const dealId = await deal(store);
    let briefs = 0; const brief = store.services.ai.dealBrief; store.services.ai.dealBrief = (id) => { briefs++; return brief(id); };
    let gaps = 0; const g = store.services.ai.gaps; store.services.ai.gaps = (id) => { gaps++; return g(id); };
    await mockFirstPass(repo, dealId, 'Project Datum'); await sleep(40);
    const before = gaps; const fs = dealFindings(store.get(), dealId);
    await store.dispatch(SetFindingStatus, { dealId, findingId: fs[0].id, status: 'closed' }); await sleep(40);
    expect(gaps).toBeGreaterThan(before); expect(store.get().gaps[dealId]).toBeDefined(); expect(briefs).toBe(0);
  });
});
