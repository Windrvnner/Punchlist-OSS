// A PC on an older build of the app, beside one on a newer build.
import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion } from '../../src/app/commands/questions';
import { CreateFinding, EditFinding } from '../../src/app/commands/findings';
import { RestoreQuestionSnapshot } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { dealQuestions, dealFindings } from '../../src/app/state';
import { Question, Finding, Deal, Tombstone, CURRENT_SCHEMA } from '../../src/domain/model';
import '../ui/keptTextSession';
import { visibleDeletedNotes as deletedOf } from '../../src/app/deletedView';

const COMMANDS = [CreateDeal, CreateQuestion, EditQuestionField, SetQuestionStatus, SetResponse, DeleteQuestion, RestoreQuestion, CreateFinding, EditFinding, RestoreQuestionSnapshot];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 12, 9, 0, 0, t++)).toISOString() };
let n = 0; const ids = { next: (p: string) => `${p}_01HFWDXXXXXXXXXXXXV${String(n++).padStart(7, '0')}` };
function make(kv = disk()) {
  const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, kv);
  const store = new Store({ repo, ai: mockAi(opts, repo) as any, docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, repo, kv };
}
/** what a newer build on another PC put on a record: fields this build does not know, in an ordinary change to it */
async function newer(m: ReturnType<typeof make>, kind: 'question' | 'finding', id: string, extra: object, schema = CURRENT_SCHEMA) {
  const cur = await m.repo.get(kind, id); if (!cur.ok || !cur.value) throw new Error('no such record');
  m.repo.peer.change(kind, id, { ...(cur.value.envelope.data as object), ...extra }, { by: 'sroe', from: 'PC B', at: clock.now() }, schema);
}
/** a record as stored now */
const stored = async (m: ReturnType<typeof make>, kind: 'question' | 'finding', id: string) => { const r = await m.repo.get(kind, id); return r.ok ? r.value?.envelope.data : undefined; };
const EXTRA = { linkedItem: { id: 'k-17', text: 'Decommissioning security is in place' }, futureNote: 'kept' };

describe('fields this build does not know', () => {
  it('are kept when a record is read and written again: an edit, a status, a response, a delete and its restore', async () => {
    expect((Question.parse as any)({ id: 'q_01HFWDXXXXXXXXXXXXXXXXXXXX', dealId: 'd_01HFWDXXXXXXXXXXXXXXXXXXXX', n: 1, text: 'x', rev: 1, createdAt: clock.now(), updatedAt: clock.now(), ...EXTRA })).toMatchObject(EXTRA);
    const m = make(); await m.store.boot(); await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const d = Object.keys(m.store.get().deals)[0];
    await m.store.dispatch(CreateQuestion, { dealId: d, text: 'Is there a decommissioning bond?' }); const q = dealQuestions(m.store.get(), d)[0].id;
    await m.store.dispatch(CreateFinding, { dealId: d, title: 'No bond', workstream: 'Legal' }); const f = dealFindings(m.store.get(), d)[0].id;
    await newer(m, 'question', q, EXTRA); await newer(m, 'finding', f, EXTRA);
    const again = make(m.kv); await again.store.boot(); await again.store.loadDeal(d);
    for (const [cmd, input] of [[EditQuestionField, { field: 'priority', value: 'High' }], [SetQuestionStatus, { status: 'closed' }], [SetResponse, { response: 'Yes.' }]] as const) {
      expect((await again.store.dispatch(cmd as any, { dealId: d, questionId: q, ...input })).ok).toBe(true); expect(await stored(again, 'question', q)).toMatchObject(EXTRA);
    }
    expect((await again.store.dispatch(EditFinding, { dealId: d, findingId: f, title: 'No bond in place',
      workstream: 'Legal', body: [] } as any)).ok).toBe(true); expect(await stored(again, 'finding',
      f)).toMatchObject(EXTRA);
    await again.store.dispatch(DeleteQuestion, { dealId: d, questionId: q }); await again.store.dispatch(RestoreQuestion, { dealId: d, questionId: q });
    expect(await stored(again, 'question', q)).toMatchObject(EXTRA);
    expect(Deal.safeParse).toBeTruthy(); expect((Finding.parse as any)({ ...again.store.get().findings[f] })).toMatchObject(EXTRA);
  });

  it('a record written by a newer build than this one can be read here but not changed, and says why; other records are not affected', async () => {
    const m = make(); await m.store.boot(); await m.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); const d = Object.keys(m.store.get().deals)[0];
    for (const text of ['Is there a decommissioning bond?', 'Provide the EPC contract.']) await m.store.dispatch(CreateQuestion, { dealId: d, text });
    const [q1, q2] = dealQuestions(m.store.get(), d).map((x) => x.id);
    await newer(m, 'question', q1, EXTRA, CURRENT_SCHEMA + 1);
    const old = make(m.kv); await old.store.boot(); await old.store.loadDeal(d);
    expect(old.store.get().questions[q1].text).toBe('Is there a decommissioning bond?');                         // shown
    const r = await old.store.dispatch(SetQuestionStatus, { dealId: d, questionId: q1, status: 'closed' });
    expect(!r.ok && r.error.message).toBe('Q1 was last changed on a newer version of Punchlist. Update this PC to change it.');
    expect(await stored(old, 'question', q1)).toMatchObject({ ...EXTRA, status: 'open' });
    expect((await old.store.dispatch(DeleteQuestion, { dealId: d, questionId: q1 })).ok).toBe(false);
    expect((await old.store.dispatch(SetQuestionStatus, { dealId: d, questionId: q2, status: 'closed' })).ok).toBe(true);
  });

  it('fields this build does not know inside a response\'s origin, a draft, a review and a mark are kept too; a note of a deletion of a kind this build does not know is read and not listed', () => {
    const at = clock.now();
    const q = Question.parse({ id: 'q_01HFWDXXXXXXXXXXXXXXXXXXXX', dealId: 'd_01HFWDXXXXXXXXXXXXXXXXXXXX', n: 1, text: 'x', rev: 1, createdAt: at, updatedAt: at,
      provenance: { origin: 'human', sources: [], actor: 'A', at, future: 1 }, draft: { status: 'found', text: 't', sources: [], forWording: 'h', future: 2 } }) as any;
    expect([q.provenance.future, q.draft.future]).toEqual([1, 2]);
    const f = Finding.parse({ id: 'f_01HFWDXXXXXXXXXXXXXXXXXXXX', dealId: q.dealId, title: 't', workstream: 'Legal', raisedAt: at, origin: 'human', rev: 1, createdAt: at, updatedAt: at, reviewed: { by: 'A', at, future: 3 }, updatedOn: { questions: [], future: 4 } }) as any;
    expect([f.reviewed.future, f.updatedOn.future]).toEqual([3, 4]);
    const t = Tombstone.parse({ kind: 'decision', dealId: q.dealId, id: 'g_1', title: '', at, actor: 'A', snapshot: {} });
    expect(deletedOf({ tombstones: { g_1: t } }, q.dealId)).toEqual([]);
  });
});
