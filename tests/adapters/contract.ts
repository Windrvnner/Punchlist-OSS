/**
 * What any storage behind the app must do. Each adapter runs these same checks.
 * `make` gives a fresh store, a way to open a second writer on the same storage (another tab, or another PC),
 * and, where the adapter can simulate it, a way to make storage refuse the second write of the next transaction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { Repository } from '../../src/ports';

export interface Made { repo: Repository; other: () => Repository; refuseSecondWrite?: () => void }

export function contract(name: string, make: () => Made) {
  describe(`Repository contract · ${name}`, () => {
    let repo: Repository; let m: Made;
    beforeEach(() => { m = make(); repo = m.repo; });
    it('creates with rev 1 and refuses a second create', async () => {
      const r = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 1 }, expectedRev: null }] });
      expect(r.ok && r.value.q1).toBe(1);
      const r2 = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 2 }, expectedRev: null }] });
      expect(!r2.ok && r2.error.kind).toBe('conflict');
    });
    it('rejects a stale rev and leaves the record untouched', async () => {
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 1 }, expectedRev: null }] });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 2 }, expectedRev: 1 }] });
      const stale = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 99 }, expectedRev: 1 }] });
      expect(!stale.ok && stale.error.kind).toBe('conflict');
      const g = await repo.get('question', 'q1');
      expect(g.ok && (g.value!.envelope.data as any).a).toBe(2);
      expect(g.ok && g.value!.rev).toBe(2);
    });
    it('is all-or-nothing when storage refuses part-way through a transaction', async () => {
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 1 }, expectedRev: null }] });
      if (!m.refuseSecondWrite) return;
      m.refuseSecondWrite();
      const r = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 2 }, expectedRev: 1 }, { kind: 'question', id: 'q2', data: { b: 1 }, expectedRev: null }] });
      expect(!r.ok && r.error.kind).toBe('storageFull');
      const g1 = await repo.get('question', 'q1'); const g2 = await repo.get('question', 'q2');
      expect(g1.ok && (g1.value!.envelope.data as any).a).toBe(1); expect(g1.ok && g1.value!.rev).toBe(1);
      expect(g2.ok && g2.value).toBeNull();
      // and storage that works again takes the same transaction
      const again = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 2 }, expectedRev: 1 }, { kind: 'question', id: 'q2', data: { b: 1 }, expectedRev: null }] });
      expect(again.ok && again.value).toEqual({ q1: 2, q2: 1 });
    });
    it('maintains a per-deal index and lists through it', async () => {
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: {}, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q2', data: {}, expectedRev: null }], index: { dealId: 'd2', add: [{ kind: 'question', id: 'q2' }] } });
      const l = await repo.list('question', 'd1');
      expect(l.ok && l.value.map((x) => x.id)).toEqual(['q1']);
      await repo.transaction({ deletes: [{ kind: 'question', id: 'q1', expectedRev: 1 }], writes: [], index: { dealId: 'd1', remove: [{ kind: 'question', id: 'q1' }] } });
      const l2 = await repo.list('question', 'd1');
      expect(l2.ok && l2.value.length).toBe(0);
    });
    it('appends audit per record', async () => {
      const a = { at: '2026-11-09T10:00:00.000Z', actor: 'A', kind: 'created' as const, opId: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', recordId: 'q1', dealId: 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ' };
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: {}, expectedRev: null }], audit: [a] });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: {}, expectedRev: 1 }], audit: [{ ...a, kind: 'edited' }] });
      const au = await repo.audit('q1');
      expect(au.ok && au.value.map((x) => x.kind)).toEqual(['created', 'edited']);
    });
    it('writes one record without touching another (two-tab safety)', async () => {
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { t: 'A' }, expectedRev: null }, { kind: 'question', id: 'q2', data: { t: 'B' }, expectedRev: null }] });
      // "tab B" writes q2 only
      const other = m.other();
      await other.transaction({ writes: [{ kind: 'question', id: 'q2', data: { t: 'B2' }, expectedRev: 1 }] });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { t: 'A2' }, expectedRev: 1 }] });
      const g2 = await repo.get('question', 'q2');
      expect(g2.ok && (g2.value!.envelope.data as any).t).toBe('B2');
    });
    it('a deleted record is gone, can be created again, and carries on its rev count, so a copy read before the delete is refused', async () => {
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 1 }, expectedRev: null }] });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 2 }, expectedRev: 1 }] });
      const d = await repo.transaction({ writes: [], deletes: [{ kind: 'question', id: 'q1', expectedRev: 2 }] }); expect(d.ok).toBe(true);
      const g = await repo.get('question', 'q1'); expect(g.ok && g.value).toBeNull();
      const stale = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 3 }, expectedRev: 2 }] }); expect(!stale.ok && stale.error.kind).toBe('conflict');
      // the delete is a version too: created again it is rev 4, and a save from a copy read before the delete names
      // a rev that is no longer the latest
      const back = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 1 }, expectedRev: null }] }); expect(back.ok && back.value.q1).toBe(4);
      const old = await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { a: 9 }, expectedRev: 2 }] }); expect(!old.ok && old.error.kind).toBe('conflict');
    });
    it('removing a deal takes everything filed under it, and its history', async () => {
      const a = { at: '2026-11-09T10:00:00.000Z', actor: 'A', kind: 'created' as const, opId: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', recordId: 'q1', dealId: 'd1' };
      await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { name: 'One' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] }, audit: [a] });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q9', data: { dealId: 'd2' }, expectedRev: null }], index: { dealId: 'd2', add: [{ kind: 'question', id: 'q9' }] } });
      const r = await repo.transaction({ writes: [{ kind: 'tombstone', id: 'd1', data: { kind: 'deal', id: 'd1' }, expectedRev: null }], deletes: [{ kind: 'deal', id: 'd1', expectedRev: 1 }], purgeDeal: 'd1', index: { dealId: '_', remove: [{ kind: 'deal', id: 'd1' }], add: [{ kind: 'tombstone', id: 'd1' }] } });
      expect(r.ok).toBe(true);
      const q = await repo.get('question', 'q1'); const l = await repo.list('question', 'd1'); const au = await repo.audit('q1'); const d = await repo.get('deal', 'd1'); const t = await repo.list('tombstone', '_'); const other = await repo.get('question', 'q9');
      expect(q.ok && q.value).toBeNull(); expect(l.ok && l.value).toEqual([]); expect(au.ok && au.value).toEqual([]); expect(d.ok && d.value).toBeNull();
      expect(t.ok && t.value.map((x) => x.id)).toEqual(['d1']); expect(other.ok && other.value?.rev).toBe(1);
    });
    it('a deal can be deleted and put back with what is filed under it untouched; removing that later takes it all and leaves the note of the deletion', async () => {
      const a = { at: '2026-11-09T10:00:00.000Z', actor: 'A', kind: 'created' as const, opId: 'op_01HZZZZZZZZZZZZZZZZZZZZZZZ', recordId: 'q1', dealId: 'd1' };
      await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { name: 'One' }, expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }] } });
      await repo.transaction({ writes: [{ kind: 'question', id: 'q1', data: { dealId: 'd1' }, expectedRev: null }], index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] }, audit: [a] });
      const del = (rev = 1) => repo.transaction({ writes: [{ kind: 'tombstone', id: 'd1', data: { kind: 'deal', id: 'd1' }, expectedRev: null }], deletes: [{ kind: 'deal', id: 'd1', expectedRev: rev }], index: { dealId: '_', remove: [{ kind: 'deal', id: 'd1' }], add: [{ kind: 'tombstone', id: 'd1' }] } });
      const ids = async (kind: 'deal' | 'question' | 'tombstone', under: string) => { const l = await repo.list(kind, under); return l.ok ? l.value.map((x) => x.id) : null; };
      // deleted, nothing removed: the deal is gone from the list of deals, what is under it is still there
      expect((await del()).ok).toBe(true);
      expect(await ids('deal', '_')).toEqual([]); expect(await ids('tombstone', '_')).toEqual(['d1']); expect(await ids('question', 'd1')).toEqual(['q1']);
      const au = await repo.audit('q1'); expect(au.ok && au.value.length).toBe(1);
      // put back
      const back = await repo.transaction({ writes: [{ kind: 'deal', id: 'd1', data: { name: 'One' }, expectedRev: null }], deletes: [{ kind: 'tombstone', id: 'd1', expectedRev: null }], index: { dealId: '_', add: [{ kind: 'deal', id: 'd1' }], remove: [{ kind: 'tombstone', id: 'd1' }] } });
      expect(back.ok && back.value.d1).toBe(3);   // created, deleted, put back: each a version
      expect(await ids('deal', '_')).toEqual(['d1']); expect(await ids('tombstone', '_')).toEqual([]); expect(await ids('question', 'd1')).toEqual(['q1']);
      const q = await repo.get('question', 'q1'); expect(q.ok && q.value?.rev).toBe(1);
      // deleted again (from rev 3, as put back), and this time what is under it is removed in a later transaction of its own
      expect((await del()).ok).toBe(false); expect((await del(3)).ok).toBe(true);
      const gone = await repo.transaction({ writes: [{ kind: 'tombstone', id: 'd1', data: { kind: 'deal', id: 'd1', again: true }, expectedRev: 'any' }], purgeDeal: 'd1' });
      expect(gone.ok).toBe(true);
      const q2 = await repo.get('question', 'q1'); const au2 = await repo.audit('q1'); const t = await repo.list('tombstone', '_');
      expect(q2.ok && q2.value).toBeNull(); expect(await ids('question', 'd1')).toEqual([]); expect(au2.ok && au2.value).toEqual([]); expect(await ids('deal', '_')).toEqual([]);
      expect(t.ok && t.value.map((x) => [x.id, (x.envelope.data as any).again])).toEqual([['d1', true]]);
    });
  });
}
