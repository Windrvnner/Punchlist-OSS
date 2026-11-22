/**
 * What Combined.foldDrafts remembers about earlier versions stays true: a version that arrives after one built on it (a
 * released or own line), and a very long history read fresh.
 */
import { describe, it, expect } from 'vitest';
import { Combined, type Line, type RecChange } from '../../src/backend/changeLog';
const at = (s: number) => `2026-11-10T10:00:${String(s).padStart(2, '0')}.000Z`;
const line = (pc: string, seq: number, s: number, recs: RecChange[]): Line => ({ v: 1, pc, seq, at: at(s), by: pc, from: pc, recs });
const q = (ver: string, base: string[], data: Record<string, unknown>): RecChange => ({ kind: 'question', id: 'q1', ver, base, data: { id: 'q1', dealId: 'd1', text: 'Q', status: 'open', response: '', ...data } });
const pending = { status: 'pending', text: '', opId: 'op_A' }; const found = { status: 'found', text: 'The cap is 20%.', opId: 'op_A' };
const view = (c: Combined) => { const s = c.state('question', 'q1'); return { live: s.live, heads: s.heads.map((h) => [(h.data as any).status, (h.data as any).response, (h.data as any).draft?.status ?? null]) }; };
const made = line('A', 1, 1, [q('A.1.0', [], {})]);
const asked = line('A', 2, 2, [q('A.2.0', ['A.1.0'], { draft: pending })]);
const written = line('A', 3, 3, [q('A.3.0', ['A.2.0'], { draft: found })]);
const used = line('B', 1, 4, [q('B.1.0', ['A.3.0'], { status: 'answered', response: 'The cap is 20%.' })]);   // Use as response: drops the draft
const discarded = line('C', 1, 5, [q('C.1.0', ['A.2.0'], {})]);                                                  // discard of the pending draft

describe('a draft folded over versions remembered from earlier reads', () => {
  it('fresh read: Use as response beside a discard is a choice', () => {
    const c = new Combined(); for (const l of [made, asked, written, used, discarded]) c.add(l);
    expect(view(c)).toMatchObject({ live: false });
  });
  it('released Use as response read before the draft it was built on arrives, then that draft arrives: same as fresh', () => {
    const c = new Combined(); for (const l of [made, asked, used, discarded]) c.add(l);
    c.release(() => true); const before = view(c);
    c.add(written);
    const fresh = new Combined(); for (const l of [made, asked, written, used, discarded]) fresh.add(l);
    expect(view(c)).toEqual(view(fresh));
  });
  it('same, with the released line not queried until the draft arrives', () => {
    const c = new Combined(); for (const l of [made, asked, used, discarded]) c.add(l);
    c.release(() => true); c.add(written);
    const fresh = new Combined(); for (const l of [made, asked, written, used, discarded]) fresh.add(l);
    expect(view(c)).toEqual(view(fresh));
  });
});
describe('a long history with deletes and restores between choices', () => {
  it('3,000 choices each followed by a delete and a restore, read fresh, finish and fold', () => {
    const ls: Line[] = [made]; let prev = 'A.1.0'; const s: Record<string, number> = { A: 1, B: 0, C: 0 }; const L = (pc: string, t: number, r: RecChange) => line(pc, ++s[pc], t, [r]);
    for (let i = 1; i <= 3000; i++) {
      ls.push(L('B', 5, q(`B${i}`, ['A.1.0'], { workstream: i % 2 ? 'Tax' : 'Legal' })));
      ls.push(L('A', 5, q(`X${i}`, [prev, `B${i}`], { workstream: `W${i}` })));
      ls.push(L('A', 5, { kind: 'question', id: 'q1', ver: `D${i}`, base: [`X${i}`], del: true }));
      ls.push(L('A', 5, q(`R${i}`, [`D${i}`], { workstream: `W${i}` }))); prev = `R${i}`;
    }
    ls.push(L('C', 6, q('C.1.0', ['A.1.0'], { draft: pending })));
    ls.push(L('A', 7, q('TOP', [prev, 'C.1.0'], { workstream: 'W3000', status: 'closed', draft: pending })));
    ls.push(L('C', 8, q('C.2.0', ['C.1.0'], { draft: found })));
    const c = new Combined(); for (const l of ls) c.add(l);
    expect(view(c)).toMatchObject({ live: true, heads: [['closed', '', 'found']] });
  }, 60000);
});
