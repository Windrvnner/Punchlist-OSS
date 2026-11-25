// @vitest-environment node
// An issues list imported on two PCs before either has the other's import, on the real record store: each
// point's finding has the same id on both, so the deal holds it once.
import { describe, it, expect } from 'vitest';
import { LogRepository, type Folder } from '../../src/backend/logRepository';
import { Store } from '../../src/app/store';
import { mockAi, mockDocuments } from '../../src/adapters/mocks';
import { MemoryLocal } from '../../src/adapters/local';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, EditFinding, SetFindingStatus, DeleteFinding, RestoreFinding } from '../../src/app/commands/findings';
import { ImportIssuesList, RevertIssuesList, RemoveIssuesList, RestoreIssuesList } from '../../src/app/commands/issuesList';
import '../ui/keptTextSession';
import { deletedIssuesLists as listsOf } from '../../src/app/deletedView';
import type { Finding } from '../../src/domain/model';
import { ResolveConflict } from '../../src/app/commands/conflicts';
import { registry, Undo } from '../../src/app/commands/undo';

class Mem implements Folder {
  files = new Map<string, string>();
  list() { return [...this.files.keys()]; }
  size(n: string) { const t = this.files.get(n); return t == null ? -1 : Buffer.byteLength(t); }
  read(n: string) { return this.files.get(n) ?? null; }
  append(n: string, t: string) { this.files.set(n, (this.files.get(n) ?? '') + t); }
  write(n: string, t: string) { this.files.set(n, t); }
}
function carry(...fs: Mem[]) { for (const a of fs) for (const b of fs) if (a !== b) for (const [n, t] of a.files) { const have = b.files.get(n) ?? ''; if (t.length > have.length) b.files.set(n, t); } }
const COMMANDS: any[] = [CreateDeal, CreateFinding, EditFinding, SetFindingStatus, DeleteFinding, RestoreFinding, ImportIssuesList, RevertIssuesList, RemoveIssuesList, RestoreIssuesList, ResolveConflict, Undo];
for (const c of COMMANDS) registry.set(c.name, c);
let idn = 0;
function pc(label: string, user: string) {
  const shared = new Mem(), local = new Mem(); let tick = 0;
  const now = () => new Date(Date.UTC(2026, 10, 14, 9, 0, 0, 0) + (tick++) * 1000).toISOString();
  const repo = new LogRepository({ shared, local, label, user: () => user, clock: now, newId: () => label.replace(/\W/g, '').toLowerCase() });
  const opts = { latency: [0, 0] as [number, number] };
  const store = new Store({ repo, ai: mockAi(opts), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec,
    session: {
      load: async () => ({ ok: true as const, value: {
        user: { name: user, initials: 'XX' }, lastSeen: now(), models: [{ id: 'm', name: 'M' }], defaultModel: 'm',
      } }),
    },
    local: new MemoryLocal(),
    clock: { now }, ids: { next: (p: string) => `${p}_01HPRBFXXXXXXXXXXXT${String(idn++).padStart(7, '0')}` } } as any, COMMANDS);
  return { repo, shared, local, store, label };
}
type PC = ReturnType<typeof pc>;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
async function syncAll(...ps: PC[]) { carry(...ps.map((p) => p.shared)); for (const p of ps) await p.repo.sync(); await settle(); }
const LIST = 'Issues list (Nov 14).pdf'; const DOC = 'doc_issueslist14';
const points = (titled = 'Title', workstream = 'Legal') => Array.from({ length: 40 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel wrote it.`, title: `${titled} ${k + 1}`, workstream }));
const findingsOf = (p: PC, dealId: string) => Object.values(p.store.get().findings).filter((f) => f.dealId === dealId);
async function twoPcs() {
  const a = pc('PC A', 'aroe'), b = pc('PC B', 'broe');
  const r = await a.store.dispatch(CreateDeal, { name: 'Proseware', folders: [] }); expect(r.ok).toBe(true);
  await syncAll(a, b);
  const dealId = Object.keys(a.store.get().deals)[0]; expect(b.store.get().deals[dealId]).toBeTruthy();
  return { a, b, dealId };
}

/**
 * A 40-point list imported on PC A, removed there, and the removal synced to PC B: `id` is one of its findings in
 * Deleted on both, and `undo` presses Undo on A's removal notice.
 */
async function removedOnA() {
  const { a, b, dealId } = await twoPcs();
  await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() });
  await syncAll(a, b);
  const removal = await a.store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
  if (!removal.ok) throw new Error(removal.error.message);
  await syncAll(a, b);
  const id = Object.values(b.store.get().tombstones).find((t) => t.kind === 'finding' && t.dealId === dealId)!.id;
  const undo = () => a.store.dispatch(Undo, { opId: removal.value.opId });
  return { a, b, dealId, id, undo };
}

describe('the same issues list imported on two PCs before they sync', () => {
  it('holds each point once', async () => {
    const { a, b, dealId } = await twoPcs();
    expect((await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() })).ok).toBe(true);
    expect((await b.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() })).ok).toBe(true);
    await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(40); expect(Object.keys(p.store.get().conflicts).length).toBe(0); }
  });
  it('holds each point once when the model titled and placed it differently on each PC; a title a person wrote counts', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points('aroe title', 'Legal') });
    await b.store.dispatch(ImportIssuesList, {
      dealId,
      doc: DOC,
      list: LIST,
      points: points('broe title', 'Financial'),
    });
    const f = findingsOf(b, dealId).find((x) => x.body[0] === 'Point 1 as counsel wrote it.')!;
    await b.store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'Our own title', workstream: 'Legal',
      body: f.body });
    await syncAll(a, b);
    // the other PC's creation is the same creation: the person's title stands, with no choice to make
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(40); expect(Object.keys(p.store.get().conflicts)).toEqual([]); expect(p.store.get().findings[f.id].title).toBe('Our own title'); }
    // every PC shows the same one of the two titles the model wrote
    const other = findingsOf(a, dealId).find((x) => x.body[0] === 'Point 2 as counsel wrote it.')!;
    expect(findingsOf(b, dealId).find((x) => x.id === other.id)!.title).toBe(other.title);
  });
  it('the same list imported, taken back and imported again on one PC holds each point once', async () => {
    const { a, dealId } = await twoPcs();
    const r = await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() });
    expect((await a.store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId })).ok).toBe(true);
    expect(findingsOf(a, dealId).length).toBe(0);
    expect((await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() })).ok).toBe(true);
    expect(findingsOf(a, dealId).length).toBe(40);
  });
  it('a finding closed on one PC before the sync stays closed on both, with nothing to choose', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points('aroe title') });
    await b.store.dispatch(ImportIssuesList, {
      dealId,
      doc: DOC,
      list: LIST,
      points: points('broe title', 'Financial'),
    });
    const f = findingsOf(a, dealId)[0];
    expect((await a.store.dispatch(SetFindingStatus, {
      dealId, findingId: f.id, status: 'closed', note: 'aroe settled it',
    })).ok).toBe(true);
    const g = findingsOf(b, dealId).find((x) => x.id !== f.id)!;
    await b.store.dispatch(EditFinding, { dealId, findingId: g.id, title: g.title, workstream: g.workstream,
      body: ['broe typed this detail.'] });
    await syncAll(a, b); await syncAll(a, b);
    for (const p of [a, b]) {
      expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(p.store.get().findings[f.id]).toMatchObject({ status: 'closed', note: 'aroe settled it' });
      expect(p.store.get().findings[g.id].body).toEqual(['broe typed this detail.']);
    }
  });
  it('an Undo on one PC before the sync takes back only its own import: the other PC\'s findings stand, and nothing typed is lost', async () => {
    const { a, b, dealId } = await twoPcs();
    const r = await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() });
    expect((await a.store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId })).ok).toBe(true);
    await b.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() });
    const g = findingsOf(b, dealId)[0];
    await b.store.dispatch(EditFinding, { dealId, findingId: g.id, title: g.title, workstream: g.workstream,
      body: ['broe typed this detail.'] });
    await syncAll(a, b); await syncAll(a, b);
    // B's import stands, as it would had the two never met, the one broe changed included, with nothing to choose
    for (const p of [a, b]) {
      expect(findingsOf(p, dealId).length).toBe(40);
      expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(p.store.get().findings[g.id].body).toEqual(['broe typed this detail.']);
    }
  });
  it('a list read in other capitals or without final periods on one PC is still one set of findings, and imported again joins them', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() });
    await b.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points().map((p) => ({ ...p, text: p.text.toUpperCase().replace(/\.$/, '') })) });
    await syncAll(a, b); await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(40); expect(Object.keys(p.store.get().conflicts)).toEqual([]); }
    // the same list again, in the first PC's capitals: every point joins, nothing is made twice or marked twice
    await b.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() });
    expect(findingsOf(b, dealId).length).toBe(40); expect(findingsOf(b, dealId).every((f) => f.onLists?.length === 1)).toBe(true);
  });
});

// a revised list counsel sends under the same file name is its own list. A list is known by its file's id, which every
// PC makes from the file's bytes, so all PCs agree on it, and removing one list never takes the other's findings or marks.
describe('two issues lists saved under the same file name, on three PCs, at 2,000 points', () => {
  const N = 2000, JOINED = 500;
  const FIRST = 'doc_first14', REVISED = 'doc_revised16';
  const first = () => Array.from({ length: N }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel first wrote it.`, title: `First ${k + 1}`, workstream: 'Legal' }));
  // the revised list: its first 500 points repeat the first list's (the model joins them to those findings), the rest are new
  const revised = (of: Finding[]) => Array.from({ length: N }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel revised it.`, title: `Revised ${k + 1}`, workstream: 'Financial',
    ...(k < JOINED ? { join: of.find((f) => f.body[0] === `Point ${k + 1} as counsel first wrote it.`)!.id } : {}) }));
  const lists = (p: PC, dealId: string) => listsOf(p.store.get(), dealId).map((l) => ({ doc: l.doc, list: l.list, made: l.made.length, joined: l.joined.length, kept: l.kept, twin: l.twin })).sort((x, y) => x.doc.localeCompare(y.doc));   // in the order they were brought in, which this test's clocks don't set
  const marksOf = (f: Finding) => (f.onLists ?? []).map((m) => m.doc).sort().join(' ');

  it('each import is its own list on every PC, and Remove takes back only the one chosen, with one Undo', async () => {
    const { a, b, dealId } = await twoPcs(); const c = pc('PC C', 'Cat'); await syncAll(a, b, c);
    expect((await a.store.dispatch(ImportIssuesList, { dealId, doc: FIRST, list: LIST, points: first() })).ok).toBe(true);
    await syncAll(a, b, c);
    // the revised list, under the same name, imported on B and on C before they sync: one set of findings, nothing to choose
    expect((await b.store.dispatch(ImportIssuesList, { dealId, doc: REVISED, list: LIST, points: revised(findingsOf(b, dealId)) })).ok).toBe(true);
    expect((await c.store.dispatch(ImportIssuesList, { dealId, doc: REVISED, list: LIST, points: revised(findingsOf(c, dealId)) })).ok).toBe(true);
    await syncAll(a, b, c); await syncAll(a, b, c);
    const both = [{ doc: FIRST, list: LIST, made: N - JOINED, joined: 0, kept: JOINED, twin: true }, { doc: REVISED, list: LIST, made: N - JOINED, joined: JOINED, kept: 0, twin: true }];
    for (const p of [a, b, c]) { expect(findingsOf(p, dealId).length).toBe(2 * N - JOINED); expect(Object.keys(p.store.get().conflicts)).toEqual([]); expect(lists(p, dealId)).toEqual(both); }
    // the two lists' point 1 are two marks, one from each list
    const one = findingsOf(a, dealId).find((f) => f.body[0] === 'Point 1 as counsel first wrote it.')!;
    expect(one.onLists!.map((m) => [m.doc, m.n])).toEqual([[FIRST, '1'], [REVISED, '1']]);

    // A removes the revised list: only its own findings go, its marks come off the first list's findings, and the first list is whole
    const before = new Map(findingsOf(a, dealId).filter((f) => f.onLists![0].doc === FIRST).map((f) => [f.id, f]));
    const r = await a.store.dispatch(RemoveIssuesList, { dealId, doc: REVISED });
    expect(r.ok).toBe(true); expect(a.store.get().ui.toasts.at(-1)?.text).toBe(`Removed ${(N - JOINED).toLocaleString('en-US')} findings`);
    await syncAll(a, b, c); await syncAll(a, b, c);
    for (const p of [a, b, c]) {
      const left = findingsOf(p, dealId);
      expect(left.length).toBe(N); expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(left.every((f) => before.has(f.id) && marksOf(f) === FIRST && f.title === before.get(f.id)!.title && f.body[0] === before.get(f.id)!.body[0])).toBe(true);
      expect(Object.values(p.store.get().tombstones).filter((t) => t.dealId === dealId).length).toBe(N - JOINED);
      // the 500 the revised list had joined count as changed since the first import, as taking a mark off is a change (#400)
      expect(lists(p, dealId)).toEqual([{ doc: FIRST, list: LIST, made: N - JOINED, joined: 0, kept: JOINED, twin: false }]);
    }

    // its Undo, on A, puts the revised list back as it was, on every PC
    expect((await a.store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId })).ok).toBe(true);
    await syncAll(a, b, c); await syncAll(a, b, c);
    for (const p of [a, b, c]) { expect(findingsOf(p, dealId).length).toBe(2 * N - JOINED); expect(Object.keys(p.store.get().conflicts)).toEqual([]); expect(lists(p, dealId)).toEqual(both); }

    // B now removes the first list. The 500 findings the revised list joined are on both lists: they stay, with both marks
    const r2 = await b.store.dispatch(RemoveIssuesList, { dealId, doc: FIRST });
    expect(r2.ok).toBe(true); expect(b.store.get().ui.toasts.at(-1)?.text).toBe(`Removed ${(N - JOINED).toLocaleString('en-US')} findings · ${JOINED} findings kept, changed since`);
    await syncAll(a, b, c); await syncAll(a, b, c);
    for (const p of [a, b, c]) {
      const left = findingsOf(p, dealId);
      expect(left.length).toBe(N); expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(left.filter((f) => marksOf(f) === `${FIRST} ${REVISED}`).length).toBe(JOINED);
      expect(left.filter((f) => marksOf(f) === REVISED).length).toBe(N - JOINED);
    }
  }, 120_000);

  it('a person\'s work on the other list is untouched: an edit, a close and a delete made since stand after Remove and its Undo', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: FIRST, list: LIST, points: first() });
    await syncAll(a, b);
    await b.store.dispatch(ImportIssuesList, { dealId, doc: REVISED, list: LIST, points: revised(findingsOf(b, dealId)) });
    await syncAll(a, b);
    // on A, a person works on the first list's findings; on B, the revised list is removed before the two sync
    const mine = findingsOf(a, dealId).filter((f) => f.onLists!.length === 1 && f.onLists![0].doc === FIRST).slice(0, 3);
    await a.store.dispatch(EditFinding, {
      dealId,
      findingId: mine[0].id,
      title: 'aroe rewrote this',
      workstream: 'Legal',
      body: ['aroe typed this detail.'],
    });
    await a.store.dispatch(SetFindingStatus, {
      dealId,
      findingId: mine[1].id,
      status: 'closed',
      note: 'aroe settled it',
    });
    await a.store.dispatch(DeleteFinding, { dealId, findingId: mine[2].id });
    const r = await b.store.dispatch(RemoveIssuesList, { dealId, doc: REVISED });
    await syncAll(a, b); await syncAll(a, b);
    for (const p of [a, b]) {
      expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(p.store.get().findings[mine[0].id]).toMatchObject({
        title: 'aroe rewrote this',
        body: ['aroe typed this detail.'],
      });
      expect(p.store.get().findings[mine[1].id]).toMatchObject({ status: 'closed', note: 'aroe settled it' });
      expect(p.store.get().findings[mine[2].id]).toBeUndefined(); expect(p.store.get().tombstones[mine[2].id]).toBeTruthy();
      expect(findingsOf(p, dealId).length).toBe(N - 1);
    }
    await b.store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId });
    await syncAll(a, b); await syncAll(a, b);
    for (const p of [a, b]) {
      expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(p.store.get().findings[mine[0].id]).toMatchObject({
        title: 'aroe rewrote this',
        body: ['aroe typed this detail.'],
      });
      expect(p.store.get().findings[mine[1].id]).toMatchObject({ status: 'closed', note: 'aroe settled it' });
      expect(p.store.get().findings[mine[2].id]).toBeUndefined();
      expect(findingsOf(p, dealId).length).toBe(2 * N - JOINED - 1);
    }
  }, 120_000);

  it('the same file saved under another name on each PC is one list, with nothing to choose', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: 'Issues list (Nov 14).pdf', points: points() });
    await b.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: 'Issues list (Nov 14) (1).pdf', points: points() });
    await syncAll(a, b); await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(40); expect(Object.keys(p.store.get().conflicts)).toEqual([]); expect(listsOf(p.store.get(), dealId).length).toBe(1); }
  });
});

describe('a revised list under the same name, at deal scale', () => {
  const N = 2000;
  const pts = (how: string, from = 0) => Array.from({ length: N }, (_, k) => ({ n: String(k + 1), text: k < from ? `Point ${k + 1} as counsel first wrote it.` : `Point ${k + 1} as counsel ${how} it.`, title: `${how} ${k + 1}`, workstream: 'Legal' }));
  it('points it repeats word for word join their findings with no model, and Remove takes off only its marks', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v1', list: LIST, points: pts('first wrote') }); await syncAll(a, b);
    // the revised list repeats its first 1,500 points as they were, and the comparison names none of them
    const r = await b.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v2', list: LIST, points: pts('revised', 1500) });
    expect(r.ok).toBe(true); expect(b.store.get().ui.toasts.at(-1)?.text).toBe('Imported 500 findings · 1,500 already raised');
    await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(N + 500); expect(Object.keys(p.store.get().conflicts)).toEqual([]); }
    expect((await a.store.dispatch(RemoveIssuesList, { dealId, doc: 'doc_v2' })).ok).toBe(true);
    await syncAll(a, b);
    for (const p of [a, b]) { const left = findingsOf(p, dealId); expect(left.length).toBe(N); expect(left.every((f) => f.onLists!.length === 1 && f.onLists![0].doc === 'doc_v1')).toBe(true); }
  }, 120_000);
  it('a PC that has not yet had the first list never takes it out: Remove of the revision, before or after the sync, leaves the first list whole', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v1', list: LIST, points: pts('first wrote') });
    await b.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v2', list: LIST, points: pts('revised', 1500) });
    await syncAll(a, b); await syncAll(a, b);
    // without the first list, B could not join the repeats: they are findings of their own on the deal (#405)
    const v1 = (p: PC) => findingsOf(p, dealId).filter((f) => f.onLists!.some((m) => m.doc === 'doc_v1'));
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(2 * N); expect(Object.keys(p.store.get().conflicts)).toEqual([]); expect(v1(p).length).toBe(N); }
    expect((await b.store.dispatch(RemoveIssuesList, { dealId, doc: 'doc_v2' })).ok).toBe(true);
    await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(N); expect(v1(p).length).toBe(N); }
  }, 120_000);
  it('Remove before the sync, on a PC that never had the other list, takes nothing of it, nor of another counsel\'s list sharing a point', async () => {
    const { a, b, dealId } = await twoPcs();
    const small = (how: string) => [{ n: '1', text: 'Reserved.', title: 'Reserved', workstream: 'Legal' }, ...Array.from({ length: 199 }, (_, k) => ({ n: String(k + 2), text: k < 150 ? `Point ${k + 2} as counsel first wrote it.` : `Point ${k + 2} as counsel ${how} it.`, title: 'T', workstream: 'Legal' }))];
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_x', list: 'Seller issues.pdf', points: small('first wrote') });
    await b.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_y', list: 'Lender issues.pdf', points: small('revised') });
    expect((await b.store.dispatch(RemoveIssuesList, { dealId, doc: 'doc_y' })).ok).toBe(true);
    await syncAll(a, b); await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(200); expect(findingsOf(p, dealId).every((f) => f.onLists!.map((m) => m.doc).join() === 'doc_x')).toBe(true); }
  }, 120_000);
  it('a point two same-named lists hold joins the finding the dialog named; with none named, every PC picks the same one', async () => {
    const { a, b, dealId } = await twoPcs();
    const p = { n: '3', text: 'Point three.', title: 'T', workstream: 'Legal' };
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v1', list: LIST, points: [p] });
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v2', list: LIST, points: [{ ...p, title: 'Own', own: true }] });   // kept as its own finding
    await syncAll(a, b);
    const [F, G] = findingsOf(a, dealId).map((f) => f.id).sort();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v3', list: LIST, points: [{ ...p, join: G }] });
    expect(a.store.get().findings[G].onLists!.map((m) => m.doc)).toEqual(['doc_v2', 'doc_v3']);
    await b.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v4', list: LIST, points: [p] });
    expect(b.store.get().findings[F].onLists!.map((m) => m.doc)).toEqual(['doc_v1', 'doc_v4']);   // the lowest id, on any PC
  });
  it('the same file saved under other names on two PCs, joining findings already raised, is one version of each', async () => {
    const { a, b, dealId } = await twoPcs();
    for (let k = 0; k < 40; k++) await a.store.dispatch(CreateFinding, { dealId, title: `Finding ${k}`, workstream: 'Legal', body: [`What finding ${k} says.`] }, { quiet: true });
    await syncAll(a, b);
    const had = findingsOf(a, dealId).map((f) => f.id);
    const joining = had.map((id, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel wrote it.`, title: 'T', workstream: 'Legal', join: id }));
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: 'Issues.pdf', points: joining });
    await b.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: 'Issues (1).pdf', points: joining });
    await syncAll(a, b); await syncAll(a, b);
    for (const p of [a, b]) { expect(Object.keys(p.store.get().conflicts)).toEqual([]); expect(findingsOf(p, dealId).every((f) => f.onLists?.length === 1)).toBe(true); expect(listsOf(p.store.get(), dealId).length).toBe(1); }
  });
  it('two same-named lists whose points only joined findings, brought in within one minute, still read apart in Deleted', async () => {
    const { a, b, dealId } = await twoPcs();
    for (let k = 0; k < 5; k++) await a.store.dispatch(CreateFinding, { dealId, title: `Finding ${k}`, workstream: 'Legal', body: [`What finding ${k} says.`] }, { quiet: true });
    const had = findingsOf(a, dealId).map((f) => f.id);
    const joining = (how: string) => had.map((id, k) => ({ n: String(k + 1), text: `Point ${k + 1} as counsel ${how} it.`, title: 'T', workstream: 'Legal', join: id }));
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v1', list: LIST, points: joining('first wrote') });
    await a.store.dispatch(ImportIssuesList, { dealId, doc: 'doc_v2', list: LIST, points: joining('revised') });
    await syncAll(a, b);
    for (const p of [a, b]) {
      const rows = listsOf(p.store.get(), dealId);
      expect(rows.map((l) => [l.made.length, l.raised, l.twin])).toEqual([[0, 5, true], [0, 5, true]]);
      // both within 9:00 AM on Nov 14 by this test's clock: to the second, and apart
      expect(rows.every((l) => /^Nov 14, (2026, )?9:00:\d\d AM$/.test(l.when))).toBe(true); expect(rows[0].when).not.toBe(rows[1].when);
    }
  });
});

describe('an issues list removed on one PC while another changes it', () => {
  it('a finding retitled on the other PC before the sync is in two versions, and the removal\'s Undo still brings back the rest', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() }); await syncAll(a, b);
    const f = findingsOf(b, dealId)[0];
    await b.store.dispatch(EditFinding, { dealId, findingId: f.id, title: 'broe’s title', workstream: f.workstream,
      body: f.body });
    const r = await a.store.dispatch(RemoveIssuesList, { dealId, doc: DOC }); expect(r.ok).toBe(true);
    await syncAll(a, b);
    expect(a.store.get().conflicts[f.id]).toBeTruthy();
    const u = await a.store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId });
    expect(u.ok).toBe(true); expect(a.store.get().ui.toasts.at(-1)?.text).toBe('Undone · Restored 39 findings · 1 finding in two versions, to choose first');
    await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(40); expect(Object.keys(p.store.get().conflicts)).toEqual([f.id]); }   // the 39, and the one in two versions
  });
  it('both PCs remove it before the sync: either one\'s Undo brings it all back', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() }); await syncAll(a, b);
    const r = await a.store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
    expect((await b.store.dispatch(RemoveIssuesList, { dealId, doc: DOC })).ok).toBe(true);
    await syncAll(a, b);
    const u = await a.store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId });
    expect(u.ok).toBe(true);
    await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(40); expect(Object.keys(p.store.get().conflicts).length).toBe(0); }
  });
  it('removed and undone, then removed again on both PCs before the sync: the Undo still brings it all back', async () => {
    const { a, b, dealId } = await twoPcs();
    await a.store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: points() }); await syncAll(a, b);
    const first = await a.store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
    expect((await a.store.dispatch(Undo, { opId: (first as { value: { opId: string } }).value.opId })).ok).toBe(true);
    await syncAll(a, b);
    const r = await a.store.dispatch(RemoveIssuesList, { dealId, doc: DOC });
    expect((await b.store.dispatch(RemoveIssuesList, { dealId, doc: DOC })).ok).toBe(true);
    await syncAll(a, b);
    const u = await a.store.dispatch(Undo, { opId: (r as { value: { opId: string } }).value.opId });
    expect(u.ok).toBe(true);
    await syncAll(a, b);
    for (const p of [a, b]) { expect(findingsOf(p, dealId).length).toBe(40); expect(Object.keys(p.store.get().conflicts).length).toBe(0); }
  });
  it('a finding put back and changed on the other PC before the removal\'s Undo reaches it stays as that PC has it, '
    + 'with nothing to choose (#401)', async () => {
    for (const order of ['undo first', 'edit first'] as const) {
      const { a, b, dealId, id, undo } = await removedOnA();
      if (order === 'undo first') expect((await undo()).ok).toBe(true);
      expect((await b.store.dispatch(RestoreFinding, { dealId, findingId: id })).ok).toBe(true);
      const theirs = { title: 'broe’s title', workstream: 'Legal', body: ['What broe found in the side letter.'] };
      expect((await b.store.dispatch(EditFinding, { dealId, findingId: id, ...theirs })).ok).toBe(true);
      if (order === 'edit first') expect((await undo()).ok).toBe(true);
      await syncAll(a, b);
      await syncAll(a, b);
      for (const p of [a, b]) {
        expect(Object.keys(p.store.get().conflicts)).toEqual([]);
        expect(p.store.get().findings[id]).toMatchObject(theirs);
        expect(findingsOf(p, dealId).length).toBe(40);
      }
    }
  });
  it('the removal\'s Undo and a change made since on each PC to a finding put back on the other are still two '
    + 'versions (#401)', async () => {
    const { a, b, dealId, id, undo } = await removedOnA();
    expect((await b.store.dispatch(RestoreFinding, { dealId, findingId: id })).ok).toBe(true);
    const was = b.store.get().findings[id];
    await b.store.dispatch(EditFinding, { dealId, findingId: id, title: 'broe’s title', workstream: was.workstream,
      body: was.body });
    expect((await undo()).ok).toBe(true);
    await a.store.dispatch(EditFinding, { dealId, findingId: id, title: 'aroe’s title', workstream: was.workstream,
      body: was.body });
    await syncAll(a, b);
    for (const p of [a, b]) expect(p.store.get().conflicts[id]).toBeTruthy();   // two people's words: a person chooses
  });
  it('a finding put back and deleted again on the other PC before the removal\'s Undo reaches it stays in Deleted, '
    + 'with nothing to choose (#401)', async () => {
    const { a, b, dealId, id, undo } = await removedOnA();
    expect((await b.store.dispatch(RestoreFinding, { dealId, findingId: id })).ok).toBe(true);
    expect((await b.store.dispatch(DeleteFinding, { dealId, findingId: id })).ok).toBe(true);
    expect((await undo()).ok).toBe(true);
    await syncAll(a, b);
    await syncAll(a, b);
    for (const p of [a, b]) {
      expect(Object.keys(p.store.get().conflicts)).toEqual([]);
      expect(p.store.get().findings[id]).toBeUndefined();
      expect(p.store.get().tombstones[id]).toBeTruthy();
      expect(findingsOf(p, dealId).length).toBe(39);
    }
  });
});
