// @vitest-environment node
// A first pass whose PCs have all gone, on a deal that has gained documents since, is taken over and finished like
// any other left round, and the new documents are followed by a first pass in the same call.
// Starting it afresh asked the model again about every item it had settled and could raise a second finding
// for an item whose first one had not synced yet. At deal scale: 2,000 checklist items and 300 documents.
import { describe, it, expect } from 'vitest';
import { view, docsHash, findingIdFor } from '../../src/backend/rounds';
import { setup, doc, val, deal, finding, Mem, itemsIn, OK, checkLines, type Call, nth } from './reviewKit';
import { dealList } from './dealList';
import { paths } from './fixtures/relecloudRoom';

type Item = { id: string; text: string };
type Finding = { id: string; itemId?: string; status: string };
const GHOST = 'r_00000000000000000000000000_ghost';
const AT = '2026-11-01T09:00:00.000Z';
const byLine = (a: { n?: number }, b: { n?: number }) => (a.n ?? 0) - (b.n ?? 0);
const roundsIn = (shared: Mem) => view(checkLines(shared).sort(byLine)).rounds;
const allOk = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });
const listOf = (items: Item[]) => () => ({ broad: items, product: [], sector: [] });

/** a data-room document from the Relecloud room, with a few of its path's words to be found by */
function roomDoc(path: string, i: number) {
  const words = path.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3).slice(0, 6);
  return doc(i + 1, path.split('/').pop()!, { rel: path, words });
}

/** a PC that has gone left the deal's first first pass open over `docList`, with `settled` written, and left */
function leftFirst(shared: Mem, items: Item[], docList: string[], settled: object[]) {
  const docs = docsHash(docList);
  const pieces = items.map((it) => ({ key: `item:${it.id}`, text: it.text, reason: 'new', stage: 'check' }));
  const core = { key: 'c', ids: [] };
  const plan = { id: GHOST, kind: 'first', by: 'ghost', label: 'Old laptop', docs, docList, core, block: 20, pieces };
  const ghost = { v: 1, at: AT, pc: 'ghost' };
  const lines: object[] = [
    { ...ghost, n: 9000, plan },
    { ...ghost, n: 9001, member: { round: GHOST, pc: 'ghost', epoch: 1, ok: true } },
  ];
  for (const [i, line] of settled.entries()) {
    lines.push({ ...ghost, n: 9002 + i, run: docs, round: GHOST, docs: [docList[0]], ...line });
  }
  lines.push({ ...ghost, n: 9002 + lines.length, left: { round: GHOST, pc: 'ghost' } });
  shared.append('checks-ghost-d1.jsonl', lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

/** the decommissioning item raises a finding; every other item is settled */
function bondFinding(c: Call) {
  const finding = {
    result: 'finding', title: 'No decommissioning bond', workstream: 'Legal',
    body: ['None is posted. [1]'], next: 'Ask.', sources: [{ doc: nth(c, 1), page: 1 }],
  };
  return {
    items: itemsIn(c).map((it) => {
      if (!it.text.includes('decommissioning')) return { id: it.tag, ...OK(c) };
      return c.model === 'fast' ? { id: it.tag, result: 'more', need: 'the bond' } : { id: it.tag, ...finding };
    }),
  };
}

describe('a first pass whose PCs have all gone, with documents added since', () => {
  it('is finished, not started afresh: nothing it settled is asked again, and the new documents follow', async () => {
    const items = dealList().items.slice(0, 2000).map((t, i) => ({ id: `c${i + 1}`, text: t }));
    const room = paths.slice(0, 300).map(roomDoc);
    const shared = new Mem();
    const recs = { d1: room.slice(0, 280) };
    const affects = () => ({ affected: Array.from({ length: 10 }, (_, i) => `C${i + 1} N1`) });
    const s = setup(allOk, recs, { shared, installId: 'pc', checklist: listOf(items), affects, timing: { watch: 20 } });
    await deal(s.repo);
    // the PC that left had settled half the items
    const settled = items.slice(0, 1000);
    const where = [{ docId: recs.d1[0].docId, loc: 'p. 1' }];
    const lines = settled.map((it) => ({ item: it.id, text: it.text, result: 'ok', where }));
    leftFirst(shared, items, recs.d1.map((r) => r.docId), lines);
    recs.d1 = room;                                                              // 20 documents have arrived since
    const result = val(await s.ai.firstPass('d1'));
    // the left pass is taken over and finished
    const rounds = roundsIn(shared);
    expect(rounds.get(GHOST)?.end?.kind).toBe('done');
    expect(rounds.get(GHOST)?.members.has('pc')).toBe(true);
    // and the same call follows the new documents, so nothing waits on the watcher, which a close would lose
    const after = [...rounds.values()].filter((r) => r.def.id !== GHOST);
    expect(after.map((r) => [r.def.kind, r.def.docList.length, r.end?.kind])).toEqual([['first', 300, 'done']]);
    expect(result.gaps).toEqual([]);
    // each unsettled item goes to the standard model once; of the settled, only what the new documents may affect
    const textsIn = (c: Call) => itemsIn(c).map((it) => it.text);
    const asked = (model: string) => s.calls.filter((c) => c.model === model).flatMap(textsIn);
    const was = new Set(settled.map((it) => it.text));
    expect(asked('standard').filter((t) => was.has(t))).toEqual([]);
    expect(new Set(asked('standard')).size).toBe(asked('standard').length);
    expect(asked('standard').length).toBe(items.length - settled.length);
    expect(asked('fast').length).toBeLessThanOrEqual(10);
    expect(s.affectCalls.length).toBe(1);
    // and the watcher starts nothing more
    await s.ai.settled();
    expect(roundsIn(shared).size).toBe(2);
  }, 120_000);

  it('raises no second finding for an item whose finding has not synced yet (its check line has)', async () => {
    const items = [
      { id: 'c1', text: 'The margin is as in the term sheet' },
      { id: 'c2', text: 'A decommissioning bond is in place' },
      { id: 'c3', text: 'The PPA term runs past maturity' },
    ];
    const shared = new Mem();
    const d1 = doc(1, 'Credit Agreement.pdf');
    const d2 = doc(2, 'Term Sheet.pdf');
    const recs = { d1: [d1] };
    const s = setup(bondFinding, recs, { shared, installId: 'pc', checklist: listOf(items) });
    await deal(s.repo);
    const old = findingIdFor('d1', docsHash([d1.docId]), 'c2');
    leftFirst(shared, items, [d1.docId], [
      { item: 'c1', text: items[0].text, result: 'ok', where: [{ docId: d1.docId, loc: 'p. 1' }] },
      { item: 'c2', text: items[1].text, result: 'finding', finding: old },
    ]);
    recs.d1 = [d1, d2];                                                          // a document has arrived since
    val(await s.ai.firstPass('d1'));
    await s.ai.settled();
    // the left PC's finding arrives through the sync client
    await finding(s.repo, old, 'No decommissioning bond', { itemId: 'c2' });
    const all = val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as Finding);
    const open = all.filter((f) => f.itemId === 'c2' && f.status === 'open');
    expect(open.map((f) => f.id)).toEqual([old]);
  }, 30_000);
});
