import { describe, it, expect } from 'vitest';
import { Combined, type Line, type RecChange } from '../../src/backend/changeLog';

// A checklist item's wording, sources and section are bookkeeping: only turning it off or on is a change a person makes
// (linking design, section 5). These are judged on the lines alone, in every order they could be read in.
const at = (s: number) => `2026-11-14T10:00:${String(s).padStart(2, '0')}.000Z`;
const line = (pc: string, seq: number, s: number, recs: RecChange[]): Line => ({ v: 1, pc, seq, at: at(s), by: pc, from: pc, recs });
const ID = 'i_0123456789abcdef01234567';
const item = (ver: string, base: string[], data: Record<string, unknown>): RecChange => ({ kind: 'item', id: ID, ver, base, data: { id: ID, dealId: 'd1', text: 'Insurance is in place', off: false, from: [{ layer: 'broad', value: '' }], ...data } });
function orders<T>(xs: T[]): T[][] { if (xs.length <= 1) return [xs]; return xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])); }
const heads = (lines: Line[]) => { const c = new Combined(); for (const l of lines) c.add(l); return c.state('item', ID).heads.map((h) => (h.data as any).off); };
const everyOrder = (lines: Line[]) => { const want = JSON.stringify(heads(lines)); for (const o of orders(lines)) expect(JSON.stringify(heads(o))).toBe(want); return JSON.parse(want); };

describe('versions of a checklist item', () => {
  const start = line('A', 1, 1, [item('A.1', [], {})]);
  it('two PCs adding it with different case and sources are one version', () => {
    expect(everyOrder([start, line('B', 1, 2, [item('B.1', [], { text: 'INSURANCE is in place.', from: [{ layer: 'deal', value: '' }] })])])).toEqual([false]);
  });
  it('a write of bookkeeping alone folds into a concurrent turn-off', () => {
    expect(everyOrder([start, line('A', 2, 3, [item('A.2', ['A.1'], { off: true })]), line('B', 1, 4, [item('B.1', ['A.1'], { section: 'Insurance' })])])).toEqual([true]);
  });
  it('off on one PC and off then on again on another are two versions', () => {
    expect(everyOrder([start, line('A', 2, 3, [item('A.2', ['A.1'], { off: true })]), line('B', 1, 4, [item('B.1', ['A.1'], { off: true })]), line('B', 2, 5, [item('B.2', ['B.1'], { off: false })])]).sort()).toEqual([false, true]);
  });
  it('other kinds keep every difference', () => {
    const c = new Combined(); c.add(line('A', 1, 1, [{ kind: 'question', id: 'q1', ver: 'A.1', base: [], data: { id: 'q1', text: 'a' } }])); c.add(line('A', 2, 2, [{ kind: 'question', id: 'q1', ver: 'A.2', base: ['A.1'], data: { id: 'q1', text: 'b' } }])); c.add(line('B', 1, 3, [{ kind: 'question', id: 'q1', ver: 'B.1', base: ['A.1'], data: { id: 'q1', text: 'a', note: 'x' } }]));
    expect(c.state('question', 'q1').heads.length).toBe(2);
  });
});

describe('versions of the firm’s list', () => {
  // a list is a record of its own: only its items say anything; the name as typed, the file, its date, and who
  // brought it in and when are bookkeeping
  const L = 'l_0123456789abcdef01234567';
  const list = (by: string, s: number, more: object = {}) => ({ id: L, layer: 'sector', name: 'Storage', items: [{ text: 'Insurance is in place' }], by, at: at(s), file: 'Storage.xlsx', fileDate: '', ...more });
  it('the same items brought in on two PCs are one version, whoever brought them in, when, from which file and however the name is typed', () => {
    const c = new Combined();
    c.add(line('A', 1, 1, [{ kind: 'firmList', id: L, ver: 'A.1', base: [], data: list('adoe', 1) }]));
    c.add(line('B', 1, 2, [{ kind: 'firmList', id: L, ver: 'B.1', base: [], data: list('sroe', 2, { file: 'Storage (1).xlsx', fileDate: '2026-11-01', name: 'storage' }) }]));
    expect(c.state('firmList', L).heads.length).toBe(1);
  });
  it('different items, or the same items in another order, are two versions', () => {
    const c = new Combined();
    c.add(
      line('A', 1, 1, [
        {
          kind: 'firmList',
          id: L,
          ver: 'A.1',
          base: [],
          data: list('adoe', 1, { items: [{ text: 'a' }, { text: 'b' }] }),
        },
      ]),
    );
    c.add(line('B', 1, 2, [{ kind: 'firmList', id: L, ver: 'B.1', base: [], data: list('sroe', 2, { items: [{ text: 'b' }, { text: 'a' }] }) }]));
    expect(c.state('firmList', L).heads.length).toBe(2);
  });
});
