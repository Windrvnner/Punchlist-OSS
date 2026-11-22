import { describe, it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo } from '../adapters/memRepo';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { mockAi, mockDocuments, mockSession, mockFirstPass, mockDocId, type MockOptions } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, AttachDocumentToFinding, RestoreFindingSnapshot } from '../../src/app/commands/findings';
import { RecoverDrafts } from '../../src/app/commands/drafts';
import { registry } from '../../src/app/commands/undo';
import { ask, conversationDocs, docIndex, loadPage, pageKeyFor, convKey } from '../../src/app/conversations';
import { search } from '../../src/app/search';
import { dealFindings } from '../../src/app/state';
import type { AiService, DocumentService } from '../../src/ports';
import { ok } from '../../src/domain/result';

const COMMANDS = [CreateDeal, CreateFinding, AttachDocumentToFinding, RestoreFindingSnapshot, RecoverDrafts];
for (const c of COMMANDS) registry.set(c.name, c);
let t = 0; const clock = { now: () => new Date(Date.UTC(2026, 10, 9, 12, 0, 0, t++)).toISOString() };
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZY${String(seq++).padStart(7, '0')}` };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function make(over: { opts?: Partial<MockOptions>; ai?: Partial<AiService>; docs?: Partial<DocumentService> } = {}) {
  const opts: MockOptions = { latency: [0, 0], ...over.opts }; const repo = memRepo(clock.now);
  const store = new Store({ repo, ai: { ...mockAi(opts, repo), ...over.ai }, docs: { ...mockDocuments(opts), ...over.docs }, fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, COMMANDS);
  return { store, repo, opts };
}
async function dealWithFindings(m: ReturnType<typeof make>, name = 'Datum') {
  await m.store.boot(); await m.store.dispatch(CreateDeal, { name, folders: [] });
  const d = Object.values(m.store.get().deals).find((x) => x.name === `Project ${name}`)!;
  await mockFirstPass(m.repo, d.id, d.name, m.opts);
  await m.store.loadDeal(d.id); await m.store.refreshCached();
  return d.id;
}

describe('which documents are loaded', () => {
  it('every citation carries a document id, and the documents the first pass read are reported as loaded', async () => {
    const m = make(); const dealId = await dealWithFindings(m);
    const sources = dealFindings(m.store.get(), dealId).flatMap((f) => f.sources);
    expect(sources.length).toBe(6); expect(sources.every((s) => s.docId === mockDocId(dealId, s.doc))).toBe(true);
    expect(Object.keys(m.store.get().cached).sort()).toEqual([...new Set(sources.map((s) => s.docId!))].sort());
  });

  it('the store rotates: past its limit the oldest documents drop out, and the app only reports what the backend says', async () => {
    const m = make({ opts: { cacheLimit: 2 } }); const dealId = await dealWithFindings(m);
    const all = dealFindings(m.store.get(), dealId).flatMap((f) => f.sources);
    expect(Object.keys(m.store.get().cached).length).toBe(2);
    const out = all.find((s) => !m.store.get().cached[s.docId!])!;
    // opening a document that has rotated out is never refused: it loads, and is then reported as loaded
    await loadPage(m.store, dealId, { doc: out.doc, docId: out.docId, loc: out.loc }); await m.store.refreshCached();
    expect(m.store.get().pages[pageKeyFor(dealId, { ...out })]).toMatchObject({ kind: /pdf|sheet/ });
    expect(m.store.get().cached[out.docId!]).toBe(true); expect(Object.keys(m.store.get().cached).length).toBe(2);
  });

  it('chat is not limited to loaded documents: the request names the deal and nothing about what is loaded', async () => {
    const seen: any[] = [];
    const m = make({ opts: { cacheLimit: 1 }, ai: { answer: async (i) => { seen.push(i); return ok({ text: 'From a document that had rotated out.', sources: [{ doc: 'Credit agreement (draft 1).pdf', loc: 'p. 142', docId: 'doc_rotated_out' }] }); } } });
    const dealId = await dealWithFindings(m);
    expect(m.store.get().cached['doc_rotated_out']).toBeUndefined();
    await ask(m.store, { kind: 'deal', dealId }, 'What is the lock-up ratio?');
    expect(Object.keys(seen[0]).sort()).toEqual(['attachments', 'conversation', 'dealId', 'findingId', 'history', 'message', 'model', 'questionId', 'runId']);
    const last = m.store.get().threads[convKey({ kind: 'deal', dealId })].at(-1)!;
    expect(last).toMatchObject({ state: 'done', sources: [{ docId: 'doc_rotated_out', loc: 'p. 142' }] });
  });

  it('a failed or late answer about what is loaded never replaces newer knowledge', async () => {
    let n = 0; const gates: ((v: string[]) => void)[] = [];
    const m = make({ docs: { cached: () => new Promise((res) => { const i = n++; if (i === 0) res(ok(['doc_a'])); else gates.push((v) => res(ok(v))); }) } });
    await m.store.boot(); await m.store.refreshCached();
    const first = m.store.refreshCached(); const second = m.store.refreshCached();
    gates[1](['doc_new']); await second; gates[0](['doc_stale']); await first;
    expect(Object.keys(m.store.get().cached)).toEqual(['doc_new']);
    const f = make({ docs: { cached: async () => ({ ok: false as const, error: { kind: 'unreachable' as const, message: 'x' } }) } });
    await f.store.boot(); (f.store as any).state = { ...f.store.get(), cached: { doc_known: true } }; await f.store.refreshCached();
    expect(f.store.get().cached).toEqual({ doc_known: true });
  });
});

describe('documents are told apart by id, not name', () => {
  it('two files with the same name are separate in reading mode, in search and when attached to a finding', async () => {
    const m = make(); await m.store.boot(); await m.store.dispatch(CreateDeal, { name: 'Twin', folders: [] });
    const dealId = Object.keys(m.store.get().deals)[0]; await m.store.loadDeal(dealId);
    await m.store.dispatch(CreateFinding, { dealId, title: 'Two drafts', workstream: 'Legal' }); const f = dealFindings(m.store.get(), dealId)[0];
    for (const docId of ['doc_one', 'doc_two', 'doc_two']) await m.store.dispatch(AttachDocumentToFinding, { dealId, findingId: f.id, doc: 'Agreement.pdf', docId });
    const srcs = m.store.get().findings[f.id].sources;
    expect(srcs.map((s) => s.docId)).toEqual(['doc_one', 'doc_two']);                       // the repeat of doc_two is not added twice
    const docs = conversationDocs(m.store.get(), { kind: 'finding', dealId, findingId: f.id });
    expect(docs.map((d) => d.docId)).toEqual(['doc_one', 'doc_two']);
    expect(docIndex(docs, srcs[1])).toBe(1);
    expect(pageKeyFor(dealId, docs[0])).not.toBe(pageKeyFor(dealId, docs[1]));
    const hits = search(m.store.get(), 'agreement.pdf');
    expect(hits.map((h) => h.doc?.docId)).toEqual(['doc_one', 'doc_two']); expect(hits.map((h) => h.ui?.doc)).toEqual([0, 1]);
  });

  it('the page request carries the id, and a file the backend cannot find is reported with its message', async () => {
    const calls: any[] = [];
    const m = make({ docs: { page: async (dealId, ref, loc) => { calls.push([ref, loc]); return { ok: false as const, error: { kind: 'notFound' as const, message: 'Agreement.pdf could not be found in the deal’s folders' } }; } } });
    await m.store.boot();
    const ref = { doc: 'Agreement.pdf', docId: 'doc_one', loc: 'p. 3 · p. 3' };
    await loadPage(m.store, 'd_x', ref);
    expect(calls).toEqual([[{ doc: 'Agreement.pdf', docId: 'doc_one' }, 'p. 3']]);
    expect(m.store.get().pages[pageKeyFor('d_x', ref)]).toEqual({ kind: 'missing', message: 'Agreement.pdf could not be found in the deal’s folders' });
    await sleep(200);
  });
  it("a document's drafts are read once, and again after the deal's indexing finishes, when a newer draft may have come", async () => {
    let calls = 0; const m = make({ docs: { drafts: async () => { calls++; return ok(calls === 1 ? [] : [{ doc: 'SPA.pdf', docId: 'b', date: '2026-04-15', folder: 'vdr/2026-04-15' }, { doc: 'SPA.pdf', docId: 'a', date: '2026-03-01', folder: 'vdr/2026-03-01' }]); } } });
    await m.store.loadDrafts('d1', 'a'); await m.store.loadDrafts('d1', 'a'); expect(calls).toBe(1); expect(m.store.get().drafts['d1|a']).toEqual([]);
    m.store.forgetDrafts('d2'); await m.store.loadDrafts('d1', 'a'); expect(calls).toBe(1);                 // another deal's indexing leaves it be
    m.store.forgetDrafts('d1'); await m.store.loadDrafts('d1', 'a'); expect(calls).toBe(2); expect(m.store.get().drafts['d1|a']?.length).toBe(2);
  });
});
