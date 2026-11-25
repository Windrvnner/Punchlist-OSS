// @vitest-environment node
// The issues list dialog shows what Import will do: over random lists, the new findings it lists are the ones
// ImportIssuesList makes, and every point lands on the finding its row names. The lists mix points a deal already holds
// from an earlier import, repeats of findings (some closed or deleted while the list was read), chains of points
// repeating earlier points, and random "Keep separate" check marks.
import { it, expect } from 'vitest';
import { Store } from '../../src/app/store';
import { memRepo, disk } from '../adapters/memRepo';
import { mockAi, mockDocuments, mockSession } from '../../src/adapters/mocks';
import { CreateDeal } from '../../src/app/commands/deals';
import { CreateFinding, DeleteFinding, SetFindingStatus } from '../../src/app/commands/findings';
import { ImportIssuesList, RevertIssuesList } from '../../src/app/commands/issuesList';
import { registry, Undo } from '../../src/app/commands/undo';
import { csvCodec } from '../../src/adapters/spreadsheet';
import { MemoryLocal } from '../../src/adapters/local';
import { dealFindings } from '../../src/app/state';
import type { Finding } from '../../src/domain/model';
import type { IssuePoint } from '../../src/ports';
import { reviewIssuesList } from '../../src/app/issuesList';
import { issuesListClock, planIssuesListSeed } from './issuesListKit';

const COMMANDS = [CreateDeal, CreateFinding, DeleteFinding, SetFindingStatus, ImportIssuesList, RevertIssuesList];
for (const c of COMMANDS) registry.set(c.name, c);
const clock = issuesListClock();
let seq = 0; const ids = { next: (p: string) => `${p}_01HZZZZZZZZZZZZZZZZ${String(seq++).padStart(7, '0')}` };
const LIST = 'List.pdf'; const DOC = 'doc_0123456789abcdef01234567';
function pointsWithRepeats(
  count: number, makePoint: (index: number) => IssuePoint, findingIds: string[], random: () => number,
): IssuePoint[] {
  return Array.from({ length: count }, (_, index) => {
    const point = makePoint(index);
    const chance = random();
    if (chance < 0.3) point.same = { finding: findingIds[Math.floor(random() * findingIds.length)] };
    else if (chance < 0.6 && index > 0) point.same = { point: Math.floor(random() * index) };
    return point;
  });
}

/** Put the existing findings on disk before opening the deal. */
async function seedFindings(store: Store, dealId: string) {
  const inputs = Array.from({ length: 8 }, (_, index) => ({
    dealId, title: `Finding ${index}`, workstream: 'Legal', body: [`F ${index}.`],
  }));
  const { writes, index } = planIssuesListSeed(store, dealId, clock, inputs);
  const saved = await store.services.repo.transaction({ writes, index });
  if (!saved.ok) throw new Error(saved.error.message);
}

async function changeFindings(store: Store, dealId: string, findings: Finding[], random: () => number) {
  for (const finding of findings) {
    const chance = random();
    const target = { dealId, findingId: finding.id };
    if (chance < 0.15) await store.dispatch(SetFindingStatus, { ...target, status: 'closed' }, { quiet: true });
    else if (chance < 0.3) await store.dispatch(DeleteFinding, target, { quiet: true });
  }
}

const caseName = 'dialog prediction equals the import over random lists, '
  + 'and the rounds included closed and deleted findings';
it(caseName, async () => {
  let seed = 12345;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let closed = 0;
  let deleted = 0;
  for (let round = 0; round < 150; round++) {
    const opts = { latency: [0, 0] as [number, number] }; const repo = memRepo(clock.now, disk());
    const store = new Store({ repo, ai: mockAi(opts, repo), docs: mockDocuments(opts), fs: { pickFolders: null, pathFor: null, save: async () => ({ ok: true as const, value: 'saved' as const }) }, sheets: csvCodec, session: mockSession(opts), local: new MemoryLocal(), clock, ids }, [...COMMANDS, Undo]);
    await store.boot();
    await store.dispatch(CreateDeal, { name: 'K', folders: [] });
    const dealId = Object.values(store.get().deals)[0].id;
    await seedFindings(store, dealId);
    await store.loadDeal(dealId);
    const N = 12;
    const mk = (k: number, n?: string): IssuePoint => ({ n: n ?? String(k + 1), text: `Point ${n ?? k + 1} text.`, title: `Title ${k + 1}`, workstream: 'Legal' });
    // an earlier import of some points (held)
    const first = Array.from({ length: N }, (_, k) => mk(k)).filter(() => random() < 0.4);
    const doc = { docId: DOC, doc: LIST };
    if (first.length) {
      const preview = reviewIssuesList(store.get(), dealId, { doc, points: first }, new Set());
      await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: preview.input });
    }
    const all0 = dealFindings(store.get(), dealId);
    const fids = all0.map((f) => f.id);
    const pts = pointsWithRepeats(N, mk, fids, random);
    await changeFindings(store, dealId, all0, random);
    const remaining = dealFindings(store.get(), dealId);
    closed += remaining.filter((finding) => finding.status === 'closed').length;
    deleted += all0.length - remaining.length;
    const kept = new Set<number>(); for (let k = 0; k < N; k++) if (random() < 0.25) kept.add(k);
    const before = new Set(dealFindings(store.get(), dealId).map((f) => f.id));
    const p = reviewIssuesList(store.get(), dealId, { doc, points: pts }, kept);
    const res = await store.dispatch(ImportIssuesList, { dealId, doc: DOC, list: LIST, points: p.input });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const after = dealFindings(store.get(), dealId); const made = after.filter((f) => !before.has(f.id));
    expect(made.length).toBe(p.fresh.length);
    // where each point is now, by its mark
    const where = (k: number) => after.filter((f) => f.onLists?.some((m) => m.list === LIST && m.n === pts[k].n)).map((f) => f.id);
    const findingOf = (g: Finding | number | undefined, k: number): string => g === undefined ? made.find((f) => f.body[0] === pts[k].text && f.onLists?.[0].n === pts[k].n && !before.has(f.id))!.id : typeof g === 'number' ? findingOf(p.goes[g], g) : g.id;
    for (let k = 0; k < N; k++) {
      const exp = findingOf(p.goes[k], k);
      expect(where(k), `round ${round} point ${k} ${JSON.stringify(pts[k].same)} kept=${kept.has(k)}`).toContain(exp);
    }
  }
  expect(closed).toBeGreaterThan(0);
  expect(deleted).toBeGreaterThan(0);
});
