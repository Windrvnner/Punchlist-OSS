// @vitest-environment node
// Which finding a check's problem belongs to: a finding is matched by the checklist item it was raised on, never by
// its title. An item's open finding is the same finding; one a person closed never takes a new problem (a new finding,
// naming the earlier one); one a person deleted is not raised again by that item. Another item's problem is its own
// finding, however alike the two are worded.
import { describe, it, expect } from 'vitest';
import { setup, val, deal, finding, doc, itemsIn, Mem, checkLines } from './reviewKit';

const DOCS = { d1: [doc(1, 'Credit Agreement.pdf'), doc(2, 'Term sheet.pdf')] };
const SAME = 'Lock-up ratio differs between the credit agreement and the term sheet';
const reply = (c: any) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, result: 'finding', title: SAME, workstream: 'Legal', body: ['They differ. [1]'], next: 'Ask.', sources: [{ doc: 'D1', page: 1 }, { doc: 'D2', page: 1 }] })) });
const LIST = () => ({ broad: [{ id: 'b1', text: 'The lock-up ratio is the same in both documents' }, { id: 'b2', text: 'Distribution conditions are consistent' }], product: [], sector: [] });

describe('a check problem and the findings already there', () => {
  it('two items whose problems are worded alike raise a finding each, and each row is flagged with its own', async () => {
    const shared = new Mem(); const s = setup(reply, DOCS, { checklist: LIST, shared, installId: 'office' }); await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    const found = val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as any);
    expect(found.map((f) => [f.title, f.itemId]).sort()).toEqual([[SAME, 'b1'], [SAME, 'b2']]);
    const byItem = new Map(found.map((f) => [f.itemId, f.id]));
    const rows = val(await s.ai.checklist!('d1')); expect(rows.map((r) => [r.id, r.result, r.findingId])).toEqual([['b1', 'finding', byItem.get('b1')], ['b2', 'finding', byItem.get('b2')]]);
  });
  it('an open finding the item already raised (on another PC, say) is named, not raised again; one of the same title from elsewhere is not taken', async () => {
    const s = setup(reply, DOCS, { checklist: LIST, shared: new Mem(), installId: 'office' }); await deal(s.repo);
    await finding(s.repo, 'f_mine', 'Worded another way by an earlier run', { itemId: 'b1' });
    await finding(s.repo, 'f_person', SAME);                                         // a person's own finding, raised on no item
    val(await s.ai.firstPass('d1'));
    const found = val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as any);
    expect(found.length).toBe(3); const b2 = found.find((f) => f.itemId === 'b2'); expect(b2).toMatchObject({ title: SAME, status: 'open' }); expect(b2.earlier).toBeUndefined();
    expect(val(await s.ai.checklist!('d1')).map((r) => [r.id, r.findingId])).toEqual([['b1', 'f_mine'], ['b2', b2.id]]);
  });
  it('a finding a person closed does not take a new problem from its item: a new finding is raised, naming the earlier one', async () => {
    const s = setup(reply, DOCS, { checklist: LIST, shared: new Mem(), installId: 'office' }); await deal(s.repo);
    await finding(s.repo, 'f_closed', 'Worded another way by an earlier run', { status: 'closed', itemId: 'b1' });
    val(await s.ai.firstPass('d1'));
    const open = val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as any).filter((f) => f.status === 'open');
    const b1 = open.find((f) => f.itemId === 'b1'); const b2 = open.find((f) => f.itemId === 'b2');
    expect(open.length).toBe(2); expect(b1).toMatchObject({ title: SAME, earlier: 'f_closed' }); expect(b2.earlier).toBeUndefined();
    expect(val(await s.ai.checklist!('d1')).map((r) => r.findingId)).toEqual([b1.id, b2.id]);
  });
  it('a finding a person deleted is not raised again by its item; another item\'s problem of the same title still is', async () => {
    const s = setup(reply, DOCS, { checklist: LIST, shared: new Mem(), installId: 'office' }); await deal(s.repo);
    await s.repo.transaction({
      writes: [
        {
          kind: 'tombstone',
          id: 'f_gone',
          data: {
            kind: 'finding',
            dealId: 'd1',
            id: 'f_gone',
            title: SAME,
            at: '2026-11-01T00:00:00.000Z',
            actor: 'adoe',
            snapshot: { itemId: 'b1' },
          },
          expectedRev: null,
        },
      ],
      index: { dealId: 'd1', add: [{ kind: 'tombstone', id: 'f_gone' }] },
    });
    val(await s.ai.firstPass('d1'));
    const found = val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as any);
    expect(found.map((f) => [f.title, f.itemId])).toEqual([[SAME, 'b2']]);
    expect(val(await s.ai.checklist!('d1')).map((r) => [r.id, r.findingId])).toEqual([['b1', undefined], ['b2', found[0].id]]);
  });
});
