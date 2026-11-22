import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession, mockFirstPass, type MockOptions } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateQuestion, SetResponse } from '../../src/app/commands/questions';
import { RequestDraft, ApplyDraft, RecoverDrafts } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { ask, conversationDocs, findDoc, convKey } from '../../src/app/conversations';
import { dealFindings, dealQuestions } from '../../src/app/state';
import { menuSections } from '../../src/ui/docMenu';

const COMMANDS = [CreateDeal, CreateQuestion, SetResponse, RequestDraft, ApplyDraft, RecoverDrafts];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 14, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZX${String(seq++).padStart(7, '0')}` };
function make() {
  const opts: MockOptions = { latency: [0, 0] }; const repo = memRepo(clock.now);
  const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, repo, opts };
}
async function deal(m: ReturnType<typeof make>, name: string) {
  if (m.store.get().boot.stage !== 'ready') await m.store.boot();
  await m.store.dispatch(CreateDeal, { name, folders: [] });
  const d = Object.values(m.store.get().deals).find((x) => x.name === `Project ${name}`)!;
  await mockFirstPass(m.repo, d.id, d.name, m.opts); await m.store.loadDeal(d.id);
  return d.id;
}

describe('what the reading list covers', () => {
  it('on a finding it is the finding’s own sources, however many follow-up questions are asked', async () => {
    const m = make(); const dealId = await deal(m, 'Datum');
    const f = dealFindings(m.store.get(), dealId).find((x) => /Lock-up/.test(x.title))!; const other = dealFindings(m.store.get(), dealId).find((x) => x.id !== f.id)!;
    const scope = { kind: 'finding' as const, dealId, findingId: f.id };
    const before = conversationDocs(m.store.get(), scope).map((d) => [d.docId, d.loc]);
    expect(before).toEqual(f.sources.map((x) => [x.docId, x.loc]));
    // a follow-up answer that cites documents from elsewhere
    m.store.setThread(convKey(scope), [{ id: 'm1', role: 'me', text: 'What about the other point?', state: 'done', at: clock.now() }, { id: 'm2', role: 'ai', text: 'See these.', sources: other.sources, state: 'done', at: clock.now() }]);
    expect(conversationDocs(m.store.get(), scope).map((d) => [d.docId, d.loc])).toEqual(before);
    expect(findDoc(conversationDocs(m.store.get(), scope), other.sources[0])).toBe(-1);       // so it opens on its own
    expect(findDoc(conversationDocs(m.store.get(), scope), f.sources[1])).toBe(1);
  });

  it('on a question it is the draft’s sources, then the response’s once there is one', async () => {
    const m = make(); const dealId = await deal(m, 'Datum');
    await m.store.dispatch(CreateQuestion, { dealId, text: 'Please confirm the lock-up ratio in the credit agreement.' });
    const q = dealQuestions(m.store.get(), dealId)[0]; const scope = { kind: 'question' as const, dealId, questionId: q.id };
    expect(conversationDocs(m.store.get(), scope)).toEqual([]);
    const r = await m.store.dispatch(RequestDraft, { dealId, questionId: q.id }); await m.store.settled((r as any).value.opId);
    const drafted = m.store.get().questions[q.id].draft!;
    expect(drafted.status).toBe('found');
    expect(conversationDocs(m.store.get(), scope).map((d) => [d.from, d.docId])).toEqual(drafted.sources.map((x) => ['From the draft', x.docId]));
  });

  it('on a deal, where nothing is under review, it is what the answers cited, with the question that led to each', async () => {
    const m = make(); const dealId = await deal(m, 'Datum'); const scope = { kind: 'deal' as const, dealId };
    await ask(m.store, scope, 'Is the capacity contracted?');
    const docs = conversationDocs(m.store.get(), scope);
    expect(docs.length).toBeGreaterThan(0); expect(docs.every((d) => d.ask === 'Is the capacity contracted?')).toBe(true);
  });

  it('across deals an answer cites, and each citation says which deal its document is in', async () => {
    const m = make(); const a = await deal(m, 'Datum'); const b = await deal(m, 'Margie');
    await ask(m.store, { kind: 'all' }, 'What needs attention?');
    const last = m.store.get().threads['all'].at(-1)!;
    expect(last.state).toBe('done'); expect(last.text).toMatch(/6 open findings across 2 deals/);
    expect(last.sources!.length).toBe(2); expect(last.sources!.every((s) => s.dealId === a || s.dealId === b)).toBe(true);
    expect(conversationDocs(m.store.get(), { kind: 'all' }).every((d) => !!d.dealId)).toBe(true);
  });
});

describe('the list as shown', () => {
  const ref = (doc: string, loc: string, from = 'From the finding', ask?: string) => ({ doc, docId: 'id_' + doc, loc, from, ask });
  it('one row per document with its pages in page order; no heading when there is one group', () => {
    const secs = menuSections([ref('Agreement.pdf', 'p. 142'), ref('Term sheet.pdf', 'p. 6'), ref('Agreement.pdf', 'p. 27')], null);
    expect(secs.length).toBe(1);
    expect(secs[0].groups.map((g) => [g.ref.doc, g.items.map((i) => i.x.loc)])).toEqual([['Agreement.pdf', ['p. 142', 'p. 27']], ['Term sheet.pdf', ['p. 6']]]);
  });
  it('a document opened from a follow-up answer gets its own group, headed by the question asked', () => {
    const secs = menuSections([ref('Agreement.pdf', 'p. 142')], ref('Model.xlsx', 'Covenants!F31', 'From the conversation', 'What does the model assume?'));
    expect(secs.map((s) => s.title)).toEqual(['The finding', 'What does the model assume?']);
    expect(secs[1].groups[0].items[0].i).toBe(-1);
  });
  it('a deal conversation is grouped by question', () => {
    const secs = menuSections([ref('A.pdf', 'p. 1', 'From answer 1', 'First question?'), ref('B.pdf', 'p. 2', 'From answer 2', 'Second question?'), ref('A.pdf', 'p. 9', 'From answer 2', 'Second question?')], null);
    expect(secs.map((s) => [s.title, s.groups.map((g) => g.ref.doc)])).toEqual([['First question?', ['A.pdf']], ['Second question?', ['B.pdf', 'A.pdf']]]);
  });
});
