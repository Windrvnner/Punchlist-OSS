import { describe, it, expect, vi } from 'vitest';
import { Combined, type Line, type RecChange } from '../../src/backend/changeLog';

const at = (s: number) => `2026-11-10T10:00:${String(s).padStart(2, '0')}.000Z`;
const who: Record<string, [string, string]> = { A: ['adoe', 'PC A'], B: ['sroe', 'PC B'], C: ['pdoe', 'HC-LT-0412'] };
const line = (pc: string, seq: number, s: number, recs: RecChange[], extra: Partial<Line> = {}): Line => ({ v: 1, pc, seq, at: at(s), by: who[pc][0], from: who[pc][1], recs, ...extra });
const put = (id: string, ver: string, base: string[], text: string): RecChange => ({ kind: 'question', id, ver, base, data: { id, dealId: 'd1', text } });
const del = (id: string, ver: string, base: string[]): RecChange => ({ kind: 'question', id, ver, base, del: true });
const combine = (lines: Line[]) => { const c = new Combined(); for (const l of lines) c.add(l); return c; };
const see = (c: Combined, id: string) => { const s = c.state('question', id); return { live: s.live, rev: s.rev, heads: s.heads.map((h) => (h.del ? 'deleted' : (h.data as any).text)) }; };
/** every order the lines could be read in (few lines), so "does not depend on order" is checked, not assumed */
function orders<T>(xs: T[]): T[][] { if (xs.length <= 1) return [xs]; return xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((r) => [x, ...r])); }
const sameInEveryOrder = (lines: Line[], ids: string[]) => { const want = JSON.stringify(ids.map((id) => see(combine(lines), id))); for (const o of orders(lines)) expect(JSON.stringify(ids.map((id) => see(combine(o), id)))).toBe(want); };

describe('combining change lines', () => {
  it('scans only histories that can clash while retaining 40,000 questions and the real choices', () => {
    const combined = new Combined();
    for (let deal = 0; deal < 20; deal++) {
      const records = Array.from({ length: 2000 }, (_, n) => {
        const id = `q${deal * 2000 + n}`;
        const record = put(id, `A.${deal + 1}.${n}`, [], `Question ${n + 1}`);
        record.data = { ...(record.data as object), dealId: `d${deal + 1}` };
        return record;
      });
      combined.add(line('A', deal + 1, deal, records, {
        index: { dealId: `d${deal + 1}`, add: records.map((record) => ({ kind: 'question', id: record.id })) },
      }));
    }
    combined.add(line('A', 21, 21, [put('q0', 'A.21.0', ['A.1.0'], 'Office edit')]));
    combined.add(line('B', 1, 22, [put('q0', 'B.1.0', ['A.1.0'], 'Home edit')]));
    combined.add(line('A', 22, 23, [del('q-deleted', 'A.22.0', [])]));
    const resolved = vi.spyOn(combined, 'state');
    try {
      expect(combined.attention().clashes.map((record) => record.id)).toEqual(['q0']);
      expect(resolved).toHaveBeenCalledTimes(1);
      expect(resolved.mock.calls).toEqual([['question', 'q0']]);
      expect(combined.index('d1')).toHaveLength(2000);
      const inventory = Array.from({ length: 20 }, (_, i) => combined.index(`d${i + 1}`).length);
      expect(inventory.reduce((n, count) => n + count, 0)).toBe(40000);
      expect(combined.state('question', 'q-deleted').heads.map((head) => head.del)).toEqual([true]);

      combined.add(line('A', 23, 24, [put('q0', 'A.23.0', ['A.21.0', 'B.1.0'], 'Chosen edit')]));
      resolved.mockClear();
      expect(combined.attention().clashes).toEqual([]);
      expect(resolved).toHaveBeenCalledTimes(1);
      expect(resolved.mock.calls).toEqual([['question', 'q0']]);
      expect(see(combined, 'q0').heads).toEqual(['Chosen edit']);
      expect(combined.index('d1')).toHaveLength(2000);
    } finally {
      resolved.mockRestore();
    }
  });

  it('a record edited on one PC after another is one record at the later version', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'first')]), line('B', 1, 2, [put('q1', 'B.1.0', ['A.1.0'], 'second')]), line('A', 2, 3, [put('q1', 'A.2.0', ['B.1.0'], 'third')])];
    expect(see(combine(lines), 'q1')).toEqual({ live: true, rev: 3, heads: ['third'] });
    sameInEveryOrder(lines, ['q1']);
  });

  it('two PCs changing the same version to different things leaves two versions, oldest first, and no winner', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'as written')]), line('B', 1, 5, [put('q1', 'B.1.0', ['A.1.0'], 'home edit')]), line('A', 2, 4, [put('q1', 'A.2.0', ['A.1.0'], 'office edit')])];
    expect(see(combine(lines), 'q1')).toEqual({ live: false, rev: 3, heads: ['office edit', 'home edit'] });          // the number counts every version taken in
    sameInEveryOrder(lines, ['q1']);
  });

  it('if they changed it to the same thing there is one version and no clash', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'as written')]), line('A', 2, 4, [{ kind: 'question', id: 'q1', ver: 'A.2.0', base: ['A.1.0'], data: { id: 'q1', dealId: 'd1', text: 'same edit', rev: 2, updatedAt: at(4) } }]), line('B', 1, 5, [{ kind: 'question', id: 'q1', ver: 'B.1.0', base: ['A.1.0'], data: { text: 'same edit', dealId: 'd1', id: 'q1', rev: 7, updatedAt: at(5) } }])];
    expect(see(combine(lines), 'q1')).toEqual({ live: true, rev: 3, heads: ['same edit'] });
    sameInEveryOrder(lines, ['q1']);
  });

  it('a clash is settled by a version based on every one of them; a third PC can add a third, and the choice must then cover all three', () => {
    const start = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'as written')]), line('A', 2, 4, [put('q1', 'A.2.0', ['A.1.0'], 'office edit')]), line('B', 1, 5, [put('q1', 'B.1.0', ['A.1.0'], 'home edit')])];
    const chosen = line('A', 3, 8, [put('q1', 'A.3.0', ['A.2.0', 'B.1.0'], 'home edit')]);
    expect(see(combine([...start, chosen]), 'q1')).toEqual({ live: true, rev: 4, heads: ['home edit'] });
    const third = line('C', 1, 6, [put('q1', 'C.1.0', ['A.1.0'], 'laptop edit')]);
    expect(see(combine([...start, third]), 'q1').heads).toEqual(['office edit', 'home edit', 'laptop edit']);
    expect(see(combine([...start, third, chosen]), 'q1').heads).toEqual(['laptop edit', 'home edit']);          // the choice did not know of the third: it stands beside what was chosen
    const all = line('A', 4, 9, [put('q1', 'A.4.0', ['A.3.0', 'C.1.0'], 'laptop edit')]);
    expect(see(combine([...start, third, chosen, all]), 'q1')).toEqual({ live: true, rev: 6, heads: ['laptop edit'] });
    sameInEveryOrder([...start, third, chosen, all], ['q1']);
  });

  it('a delete and an edit made without knowledge of each other are two versions, the readable one first; a choice of either settles it; putting the record back after a delete is a new version', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'as written')]), line('A', 2, 4, [del('q1', 'A.2.0', ['A.1.0'])]), line('B', 1, 5, [put('q1', 'B.1.0', ['A.1.0'], 'edited at home')])];
    expect(see(combine(lines), 'q1')).toEqual({ live: false, rev: 3, heads: ['edited at home', 'deleted'] });
    sameInEveryOrder(lines, ['q1']);
    expect(combine(lines).attention().clashes.map((x) => x.id)).toEqual(['q1']);
    const keepEdit = line('A', 3, 7, [put('q1', 'A.3.0', ['B.1.0', 'A.2.0'], 'edited at home')]);
    expect(see(combine([...lines, keepEdit]), 'q1')).toEqual({ live: true, rev: 4, heads: ['edited at home'] });
    const keepDeleted = line('A', 3, 7, [del('q1', 'A.3.0', ['B.1.0', 'A.2.0'])]);
    expect(see(combine([...lines, keepDeleted]), 'q1')).toEqual({ live: false, rev: 0, heads: ['deleted'] });
    // two deletes of the same version are one delete
    const both = [line('A', 1, 1, [put('q2', 'A.1.0', [], 'x')]), line('A', 2, 2, [del('q2', 'A.2.0', ['A.1.0'])]), line('B', 1, 3, [del('q2', 'B.1.0', ['A.1.0'])])];
    expect(see(combine(both), 'q2')).toEqual({ live: false, rev: 0, heads: ['deleted'] });
    const back = line('A', 3, 9, [put('q1', 'A.3.0', ['A.2.0'], 'as written')]);
    expect(see(combine([...lines, back]), 'q1').heads).toEqual(['edited at home', 'as written']);                 // restored on one PC, edited on another before that: a person chooses
  });

  it('judges every record on its own: a clash on one record leaves the others in the same line alone', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'one'), put('q2', 'A.1.1', [], 'two')]), line('A', 2, 4, [put('q1', 'A.2.0', ['A.1.0'], 'office'), put('q2', 'A.2.1', ['A.1.1'], 'two, office')]), line('B', 1, 5, [put('q1', 'B.1.0', ['A.1.0'], 'home'), put('q3', 'B.1.1', [], 'three, new at home')])];
    const c = combine(lines);
    expect(see(c, 'q1').heads).toEqual(['office', 'home']);
    expect(see(c, 'q2')).toEqual({ live: true, rev: 2, heads: ['two, office'] });
    expect(see(c, 'q3')).toEqual({ live: true, rev: 1, heads: ['three, new at home'] });
    expect(c.attention().clashes.map((s) => s.id)).toEqual(['q1']);
    sameInEveryOrder(lines, ['q1', 'q2', 'q3']);
  });

  it('a line built on a version that has not arrived is held back whole, as if it had not arrived, until that version turns up', () => {
    const first = line('A', 1, 1, [put('q1', 'A.1.0', [], 'one')]); const second = line('B', 1, 2, [put('q1', 'B.1.0', ['A.1.0'], 'two')]);
    const third = line('A', 2, 3, [put('q1', 'A.2.0', ['B.1.0'], 'three'), put('q2', 'A.2.1', [], 'new with it')], { index: { dealId: 'd1', add: [{ kind: 'question', id: 'q2' }] } });
    const c = combine([first, third]);
    expect(see(c, 'q1')).toEqual({ live: true, rev: 1, heads: ['one'] });                                       // the older version, editable as usual
    expect(see(c, 'q2').heads).toEqual([]); expect(c.index('d1').map((e) => e.id)).toEqual([]);                // nothing else in the held line shows either
    expect(c.waiting().map((w) => w.missing)).toEqual([['B.1.0']]);
    expect(c.add(second).sort()).toEqual(['question/q1', 'question/q2']);                                      // the held line is taken in with the one it waited for
    expect(see(c, 'q1')).toEqual({ live: true, rev: 3, heads: ['three'] }); expect(c.waiting()).toEqual([]);
    sameInEveryOrder([first, second, third], ['q1', 'q2']);
  });

  it('a chain of held lines is taken in as each link arrives, and a withdrawn version counts as arrived', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'one')]), line('B', 1, 2, [put('q1', 'B.1.0', ['A.1.0'], 'two')]), line('C', 1, 3, [put('q1', 'C.1.0', ['B.1.0'], 'three')]), line('A', 2, 4, [put('q1', 'A.2.0', ['C.1.0'], 'four')])];
    const c = combine([lines[0], lines[3], lines[2]]);
    expect(see(c, 'q1').heads).toEqual(['one']); expect(c.waiting().length).toBe(2);
    c.add(lines[1]); expect(see(c, 'q1').heads).toEqual(['four']); expect(c.waiting()).toEqual([]);
    sameInEveryOrder(lines, ['q1']);
    // a line built on a version that was withdrawn (an undone choice) is not held for it
    const choice = line('A', 3, 5, [put('q1', 'A.3.0', ['A.2.0'], 'chosen')]); const undo = line('A', 4, 6, [], { retract: ['A.3.0'] });
    const after = line('B', 2, 7, [put('q1', 'B.2.0', ['A.3.0'], 'built on the choice')]);
    const d = combine([...lines, undo, after]);
    expect(d.waiting()).toEqual([]); expect(see(d, 'q1').heads).toContain('built on the choice');
    sameInEveryOrder([...lines, choice, undo, after], ['q1']);
  });

  it('a line built on a version in the same line is not held; a line of this PC’s own is never held', () => {
    const both = line('A', 1, 1, [put('q1', 'A.1.0', [], 'one'), put('q1', 'A.1.1', ['A.1.0'], 'one, again')]);
    const c = combine([both]); expect(c.waiting()).toEqual([]); expect(see(c, 'q1').heads).toEqual(['one, again']);
    const mine = line('A', 2, 3, [put('q2', 'A.2.0', ['B.1.0'], 'mine, on a version that has gone')]);
    const d = new Combined(); d.add(mine, true); expect(d.waiting()).toEqual([]); expect(see(d, 'q2').heads).toEqual(['mine, on a version that has gone']);
  });

  it('a wait through a held line names the PC whose change nobody has', () => {
    const b2 = line('B', 2, 2, [put('q1', 'B.2.0', ['D.1.0'], 'home, on the desk PC')]); const c1 = line('C', 1, 3, [put('q1', 'C.1.0', ['B.2.0'], 'laptop, on home')]);
    expect(combine([b2, c1]).waiting().map((w) => [w.line.pc, w.missing])).toEqual([['B', ['D.1.0']], ['C', ['D.1.0']]]);
  });

  it('many lines released one by one are taken in quickly', () => {
    // two PCs taking turns on the same records, one PC's file read whole before the other's: most lines wait, then are released in a chain
    const a: Line[] = [], b: Line[] = []; let last: Record<string, string> = {};
    for (let n = 1; n <= 20000; n++) { const pc = n % 2 ? 'A' : 'B'; const id = `q${n % 7}`; const ver = `${pc}.${n}.0`; (pc === 'A' ? a : b).push(line(pc, n, n % 60, [put(id, ver, last[id] ? [last[id]] : [], `v${n}`)])); last = { ...last, [id]: ver }; }
    const t = performance.now(); const c = combine([...a, ...b]); const ms = performance.now() - t;
    expect(c.waiting()).toEqual([]); expect(ms).toBeLessThan(2000);   // about 7 s when each release looked at every held line
  });

  it('a line read twice counts once, and two copies of a file that went different ways are both kept', () => {
    const one = line('A', 1, 1, [put('q1', 'A.1.0', [], 'one')]);
    const c = combine([one, JSON.parse(JSON.stringify(one)), one]);
    expect(see(c, 'q1')).toEqual({ live: true, rev: 1, heads: ['one'] });
    // an installed copy cloned to a second machine: the same id and line number, different content
    const here = line('A', 2, 4, [put('q1', 'A.2.0', ['A.1.0'], 'on the original')]); const clone = line('A', 2, 5, [put('q1', 'A.2.0x', ['A.1.0'], 'on the clone')]);
    expect(see(combine([one, here, clone]), 'q1').heads).toEqual(['on the original', 'on the clone']);
  });

  it('withdrawing a choice lets the versions it chose between stand again', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'as written')]), line('A', 2, 4, [put('q1', 'A.2.0', ['A.1.0'], 'office edit')]), line('B', 1, 5, [put('q1', 'B.1.0', ['A.1.0'], 'home edit')]), line('A', 3, 8, [put('q1', 'A.3.0', ['A.2.0', 'B.1.0'], 'home edit')])];
    const undo = line('A', 4, 9, [], { retract: ['A.3.0'] });
    const s = see(combine([...lines, undo]), 'q1');
    expect(s.heads).toEqual(['office edit', 'home edit']); expect(s.rev).toBeGreaterThan(3);                      // the number still moves on, so nothing mistakes this for the state before the choice
    sameInEveryOrder([...lines, undo], ['q1']);
  });

  it('an edit made on top of a choice that was then withdrawn stands beside the versions put back, and is never taken as missing', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'as written')]), line('A', 2, 4, [put('q1', 'A.2.0', ['A.1.0'], 'office edit')]), line('B', 1, 5, [put('q1', 'B.1.0', ['A.1.0'], 'home edit')]), line('A', 3, 8, [put('q1', 'A.3.0', ['A.2.0', 'B.1.0'], 'home edit')])];
    const onTop = line('B', 2, 9, [put('q1', 'B.2.0', ['A.3.0'], 'home edit, refined')]); const undo = line('A', 4, 10, [], { retract: ['A.3.0'] });
    expect(see(combine([...lines, onTop, undo]), 'q1')).toMatchObject({ live: false, heads: ['office edit', 'home edit', 'home edit, refined'] });
    sameInEveryOrder([...lines, onTop, undo], ['q1']);
    // the withdrawal can arrive before the choice it withdraws (a later file first): the same, with or without the choice
    expect(see(combine([lines[0], lines[1], lines[2], onTop, undo]), 'q1')).toMatchObject({ heads: ['office edit', 'home edit', 'home edit, refined'] });
  });

  it('a record restored after a delete is listed again whatever time its line carries: a PC whose clock is behind, or one PC whose clock was set back', () => {
    const tomb = (ver: string, base: string[]): RecChange => ({ kind: 'tombstone', id: 'q1', ver, base, data: { id: 'q1', dealId: 'd1', kind: 'question' } });
    const gone = (ver: string, base: string[]): RecChange => ({ kind: 'tombstone', id: 'q1', ver, base, del: true });
    const off = { index: { dealId: 'd1', remove: [{ kind: 'question' as const, id: 'q1' }], add: [{ kind: 'tombstone' as const, id: 'q1' }] } }, on = { index: { dealId: 'd1', add: [{ kind: 'question' as const, id: 'q1' }], remove: [{ kind: 'tombstone' as const, id: 'q1' }] } };
    for (const restorer of ['B', 'A']) {
      const lines = [
        line('A', 1, 1, [put('q1', 'A.1.0', [], 'one')], { index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }),
        line('A', 2, 50, [del('q1', 'A.2.0', ['A.1.0']), tomb('A.2.1', [])], off),                             // deleted at :50 by A's clock
        line(restorer, 3, 20, [put('q1', 'R.3.0', ['A.2.0'], 'one'), gone('R.3.1', ['A.2.1'])], on),            // restored after that, on a clock that says :20
      ];
      for (const o of orders(lines)) expect(combine(o).index('d1')).toEqual([{ kind: 'question', id: 'q1' }]);
      const again = line('B', 4, 10, [del('q1', 'B.4.0', ['R.3.0']), tomb('B.4.1', ['R.3.1'])], off);            // and deleted again, at :10
      for (const o of orders([...lines, again])) expect(combine(o).index('d1')).toEqual([{ kind: 'tombstone', id: 'q1' }]);
    }
    // deleted on one PC and edited on another without knowledge of it: listed both ways until a person has chosen, as before
    const clash = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'one')], { index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }), line('A', 2, 5, [del('q1', 'A.2.0', ['A.1.0']), tomb('A.2.1', [])], off), line('B', 1, 3, [put('q1', 'B.1.0', ['A.1.0'], 'edited')])];
    for (const o of orders(clash)) expect(combine(o).index('d1')).toEqual([{ kind: 'question', id: 'q1' }, { kind: 'tombstone', id: 'q1' }]);
  });

  it('a deal’s list is its index, in the order things were first filed; a purged deal lists nothing and its records are gone', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'one')], { index: { dealId: 'd1', add: [{ kind: 'question', id: 'q1' }] } }), line('B', 1, 2, [put('q2', 'B.1.0', [], 'two')], { index: { dealId: 'd1', add: [{ kind: 'question', id: 'q2' }] } }), line('A', 2, 3, [del('q1', 'A.2.0', ['A.1.0'])], { index: { dealId: 'd1', remove: [{ kind: 'question', id: 'q1' }] } })];
    expect(combine(lines).index('d1')).toEqual([{ kind: 'question', id: 'q2' }]);
    for (const o of orders(lines)) expect(combine(o).index('d1')).toEqual([{ kind: 'question', id: 'q2' }]);
    const purge = line('A', 3, 4, [], { purge: 'd1' }); const late = line('B', 2, 5, [put('q2', 'B.2.0', ['B.1.0'], 'edited without knowing the deal was deleted')]);
    const c = combine([...lines, purge, late]);
    expect(c.index('d1')).toEqual([]); expect(see(c, 'q2')).toEqual({ live: false, rev: 0, heads: [] });
  });

  it('a question two PCs made alike is one question after one PC changed it, in any order; other kinds made again stay a choice', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'imported')]), line('A', 2, 2, [put('q1', 'A.2.0', ['A.1.0'], 'reworded')]), line('B', 1, 3, [put('q1', 'B.1.0', [], 'imported')])];
    expect(see(combine(lines), 'q1')).toEqual({ live: true, rev: 3, heads: ['reworded'] });            // the number counts every version taken in
    sameInEveryOrder(lines, ['q1']);
    const m = (ver: string, base: string[], on: boolean, s: number, pc: string): Line => line(pc, Number(ver.split('.')[1]), s, [{ kind: 'member', id: 'm_d1_alex', ver, base, data: { id: 'm_d1_alex', on } }]);
    const c = combine([m('A.1.0', [], true, 1, 'A'), m('A.2.0', ['A.1.0'], false, 2, 'A'), m('B.1.0', [], true, 3, 'B')]);
    expect(c.state('member', 'm_d1_alex').heads).toHaveLength(2);
  });

  it('an equal version with less history behind it never takes the record’s rev back', () => {
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'High')]), line('A', 2, 5, [put('q1', 'A.2.0', ['A.1.0'], 'Low')]), line('B', 1, 3, [put('q1', 'B.1.0', [], 'Low')])];
    expect(see(combine(lines), 'q1')).toEqual({ live: true, rev: 3, heads: ['Low'] });
    expect(combine(lines).state('question', 'q1').heads[0].ver).toBe('A.2.0');
    sameInEveryOrder(lines, ['q1']);
  });

  it('a question two PCs imported under different numbers is one question at the higher number, in any order', () => {
    const q = (pc: string, s: number, n: number, base: string[] = [], text = 'imported'): Line => line(pc, s, s, [{ kind: 'question', id: 'q1', ver: `${pc}.${s}.0`, base, data: { id: 'q1', dealId: 'd1', text, n } }]);
    const two = [q('A', 1, 201), q('B', 2, 5)];
    expect(see(combine(two), 'q1')).toEqual({ live: true, rev: 2, heads: ['imported'] });
    expect((combine(two).state('question', 'q1').heads[0].data as any).n).toBe(201);
    sameInEveryOrder(two, ['q1']);
    const edited = [q('A', 1, 201), q('B', 2, 5), q('B', 3, 5, ['B.2.0'], 'typed on B')];        // B's edit of its own copy stands, under its number
    expect(see(combine(edited), 'q1')).toEqual({ live: true, rev: 3, heads: ['typed on B'] });
    sameInEveryOrder(edited, ['q1']);
  });

  it('an import’s Undo on one PC never takes back another PC’s import of the same question, edited or not, in any order', () => {
    const undo = (id: string, ver: string, base: string[]): RecChange => ({ kind: 'question', id, ver, base, del: true, undoesImport: true });
    const lines = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'imported'), put('q2', 'A.1.1', [], 'also imported')]), line('A', 2, 2, [put('q2', 'A.2.0', ['A.1.1'], 'answered on A')]),
      line('B', 1, 3, [put('q1', 'B.1.0', [], 'imported'), put('q2', 'B.1.1', [], 'also imported')]), line('B', 2, 4, [undo('q1', 'B.2.0', ['B.1.0']), undo('q2', 'B.2.1', ['B.1.1'])])];
    expect([see(combine(lines), 'q1'), see(combine(lines), 'q2')]).toEqual([{ live: true, rev: 3, heads: ['imported'] }, { live: true, rev: 4, heads: ['answered on A'] }]);
    sameInEveryOrder(lines, ['q1', 'q2']);
    const plain = [lines[0], lines[2], line('B', 2, 4, [del('q1', 'B.2.0', ['B.1.0'])])];          // a person's delete does take it back
    expect(see(combine(plain), 'q1')).toEqual({ live: false, rev: 0, heads: ['deleted'] });
  });

  it('an import Undo’s deletion gives way to the question another PC’s import keeps, and to a person’s deletion, in any order', () => {
    const tomb = (ver: string, undone: boolean, snapText: string): RecChange => ({ kind: 'tombstone', id: 'q1', ver, base: [], data: { kind: 'question', id: 'q1', dealId: 'd1', snapshot: { id: 'q1', text: snapText }, ...(undone ? { undoesImport: true } : {}) } });
    const undo: RecChange = { kind: 'question', id: 'q1', ver: 'B.2.0', base: ['B.1.0'], del: true, undoesImport: true };
    const kept = [line('A', 1, 1, [put('q1', 'A.1.0', [], 'imported')]), line('B', 1, 2, [put('q1', 'B.1.0', [], 'imported')]), line('B', 2, 3, [undo, tomb('B.2.1', true, 'imported')])];
    for (const o of orders(kept)) { const c = combine(o); expect([c.state('question', 'q1').live, c.state('tombstone', 'q1').heads.length]).toEqual([true, 0]); }
    const typed = [line('A', 1, 1, [tomb('A.1.0', false, 'typed on A')]), line('B', 1, 2, [tomb('B.1.0', true, 'imported')])];
    for (const o of orders(typed)) expect(combine(o).state('tombstone', 'q1').heads.map((h) => (h.data as any).snapshot.text)).toEqual(['typed on A']);
  });
});

describe('a question\'s draft crossed by a change made on another PC', () => {
  const q = (id: string, ver: string, base: string[], data: Record<string, unknown>): RecChange => ({ kind: 'question', id, ver, base, data: { id, dealId: 'd1', text: 'What is the cap?', status: 'open', response: '', ...data } });
  const pending = { status: 'pending', text: '', sources: [], forWording: 'w', opId: 'op_A' };
  const found = { status: 'found', text: 'The cap is 20%.', sources: [], forWording: 'w', opId: 'op_A' };
  const made = line('A', 1, 1, [q('q1', 'A.1.0', [], {})]);
  const asked = line('A', 2, 2, [q('q1', 'A.2.0', ['A.1.0'], { draft: pending })]);
  const written = line('A', 3, 4, [q('q1', 'A.3.0', ['A.2.0'], { draft: found })]);
  const closed = line('B', 1, 3, [q('q1', 'B.1.0', ['A.1.0'], { status: 'closed' })]);
  const view = (c: Combined) => { const s = c.state('question', 'q1'); return { live: s.live, rev: s.rev, heads: s.heads.map((h) => (h.del ? 'deleted' : { status: (h.data as any).status, text: (h.data as any).text, draft: (h.data as any).draft?.status ?? null })) }; };

  it('a close that crosses the pending marker, or the draft that replaced it, is one version: the close, carrying the draft', () => {
    expect(view(combine([made, asked, closed]))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: 'pending' }] });
    expect(view(combine([made, asked, written, closed]))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: 'found' }] });
    for (const ls of [[made, asked, closed], [made, asked, written, closed]]) { const want = JSON.stringify(view(combine(ls))); for (const o of orders(ls)) expect(JSON.stringify(view(combine(o)))).toBe(want); }
    expect(combine([made, asked, written, closed]).bases('question', 'q1')).toEqual(['B.1.0', 'A.3.0']);       // a new write supersedes both
  });

  it('a close made after the marker arrived, crossing the draft that replaced it, and one on a question drafted before, are folded too', () => {
    const closedOnMarker = line('B', 1, 5, [q('q1', 'B.1.0', ['A.2.0'], { status: 'closed', draft: pending })]);
    expect(view(combine([made, asked, written, closedOnMarker]))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: 'found' }] });
    const again = line('A', 4, 6, [q('q1', 'A.4.0', ['A.3.0'], { draft: { ...pending, opId: 'op_A2' } })]);
    const closedOnFound = line('B', 1, 7, [q('q1', 'B.1.0', ['A.3.0'], { status: 'closed', draft: found })]);
    const s = combine([made, asked, written, again, closedOnFound]).state('question', 'q1');
    expect(s.live).toBe(true); expect(s.heads[0].data).toMatchObject({ status: 'closed', draft: { status: 'pending', opId: 'op_A2' } });
  });

  it('a response typed or a workstream changed on the other PC, crossing both draft writes, is one version keeping both', () => {
    const typed = line('B', 1, 3, [q('q1', 'B.1.0', ['A.1.0'], { response: 'Typed by B.' })]);
    const moved = line('B', 1, 3, [q('q1', 'B.1.0', ['A.1.0'], { workstream: 'Legal' })]);
    expect(combine([made, asked, written, typed]).state('question', 'q1').heads.map((h) => h.data)).toMatchObject([{ response: 'Typed by B.', draft: { status: 'found' } }]);
    expect(combine([made, asked, written, moved]).state('question', 'q1').heads.map((h) => h.data)).toMatchObject([{ workstream: 'Legal', draft: { status: 'found' } }]);
  });

  it('two closes, one made before the marker arrived and one after, are one version once the draft is folded into both', () => {
    const closedAfter = line('C', 1, 6, [q('q1', 'C.1.0', ['A.2.0'], { status: 'closed', draft: pending })]);
    const ls = [made, asked, written, closed, closedAfter];
    expect(view(combine(ls))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: 'found' }] });
    const want = JSON.stringify(view(combine(ls))); for (const o of orders(ls)) expect(JSON.stringify(view(combine(o)))).toBe(want);
  });

  it('the number moves on when a draft is folded in, and again with the next write, so a write planned before either is turned away', () => {
    const before = combine([made, closed]).state('question', 'q1').rev;
    const folded = combine([made, asked, closed]).state('question', 'q1').rev; expect(folded).not.toBe(before);
    const more = combine([made, asked, written, closed]).state('question', 'q1').rev; expect(more).not.toBe(folded);
    const next = line('A', 4, 5, [q('q1', 'A.4.0', ['B.1.0', 'A.3.0'], { status: 'closed', response: 'The cap is 20%.' })]);
    const after = combine([made, asked, written, closed, next]).state('question', 'q1');
    expect(after.live).toBe(true); expect([before, folded, more]).not.toContain(after.rev);
  });

  it('a change a person made on the drafting PC is not folded: the two still stand for a person to choose', () => {
    const typed = line('A', 3, 4, [q('q1', 'A.3.0', ['A.2.0'], { draft: pending, response: 'Typed here' })]);
    expect(view(combine([made, asked, typed, closed]))).toMatchObject({ live: false, heads: [{ status: 'closed' }, { status: 'open' }] });
    // nor one made before the draft was asked for, that the other PC never saw
    const reworded = line('A', 2, 2, [q('q1', 'A.2.0', ['A.1.0'], { text: 'What is the aggregate cap?' })]);
    const draftAfter = line('A', 3, 2, [q('q1', 'A.3.0', ['A.2.0'], { text: 'What is the aggregate cap?', draft: pending })]);
    expect(view(combine([made, reworded, draftAfter, closed]))).toMatchObject({ live: false, heads: [{ text: 'What is the aggregate cap?', draft: 'pending' }, { status: 'closed', text: 'What is the cap?' }] });
  });

  it('a delete beside a draft is still a choice', () => {
    const gone = line('B', 1, 3, [del('q1', 'B.1.0', ['A.1.0'])]);
    expect(view(combine([made, asked, gone]))).toMatchObject({ live: false, heads: [{ draft: 'pending' }, 'deleted'] });
  });

  it('two drafts that crossed each other stay a choice: the software never picks between them', () => {
    const theirs = line('B', 1, 3, [q('q1', 'B.1.0', ['A.1.0'], { draft: { ...pending, opId: 'op_B' } })]);
    expect(view(combine([made, asked, theirs]))).toMatchObject({ live: false, heads: [{ draft: 'pending' }, { draft: 'pending' }] });
    // a found draft beside a marker another PC set to failed, and a discard beside a new request
    const failed = line('B', 1, 40, [q('q1', 'B.1.0', ['A.2.0'], { draft: { ...pending, status: 'failed' } })]);
    expect(view(combine([made, asked, written, failed]))).toMatchObject({ live: false, heads: [{ draft: 'found' }, { draft: 'failed' }] });
    const discarded = line('A', 4, 20, [q('q1', 'A.4.0', ['A.3.0'], {})]); const again = line('B', 1, 19, [q('q1', 'B.1.0', ['A.3.0'], { draft: { ...pending, opId: 'op_B' } })]);
    expect(view(combine([made, asked, written, discarded, again]))).toMatchObject({ live: false });
  });

  it('a close that also changed the draft is not folded into: a newer request it carries is never replaced by an older discard', () => {
    const again = line('B', 1, 30, [q('q1', 'B.1.0', ['A.3.0'], { draft: { ...pending, opId: 'op_B' } })]);
    const closedThere = line('B', 2, 31, [q('q1', 'B.2.0', ['B.1.0'], { draft: { ...pending, opId: 'op_B' }, status: 'closed' })]);
    const discarded = line('A', 4, 20, [q('q1', 'A.4.0', ['A.3.0'], {})]);
    const s = combine([made, asked, written, again, closedThere, discarded]).state('question', 'q1');
    expect(s.live).toBe(false); expect(s.heads.some((h) => (h.data as any).draft?.opId === 'op_B')).toBe(true);
  });

  it('when the other side is the longer one, the number still moves with each change to the folded draft', () => {
    const typed = line('B', 1, 3, [q('q1', 'B.1.0', ['A.1.0'], { response: 'x' })]); const shut = line('B', 2, 5, [q('q1', 'B.2.0', ['B.1.0'], { response: 'x', status: 'closed' })]);
    const revs = [[made, typed, shut], [made, typed, shut, asked], [made, typed, shut, asked, written]].map((ls) => combine(ls).state('question', 'q1').rev);
    expect(new Set(revs).size).toBe(3);
    const next = line('A', 4, 9, [q('q1', 'A.4.0', ['B.2.0', 'A.3.0'], { response: 'x', status: 'closed', draft: found })]);
    expect(revs).not.toContain(combine([made, typed, shut, asked, written, next]).state('question', 'q1').rev);
  });
  it('two closes, one made without the pending marker and one after it, are one version carrying the draft, in every order and on any clock', () => {
    // B closes on the question as it was; C closes after the marker reached it. Clocks: B's says before the request, C's long after.
    for (const [b, c] of [[1, 59], [59, 1], [3, 3]]) {
      const shutB = line('B', 1, b, [q('q1', 'B.1.0', ['A.1.0'], { status: 'closed' })]);
      const shutC = line('C', 1, c, [q('q1', 'C.1.0', ['A.2.0'], { status: 'closed', draft: pending })]);
      for (const ls of [[made, asked, shutB, shutC], [made, asked, written, shutB, shutC]]) {
        const want = ls.includes(written) ? 'found' : 'pending';
        for (const o of orders(ls)) {
          const s = combine(o).state('question', 'q1');
          expect(view(combine(o))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: want }] });
          expect(s.tips.sort()).toEqual(ls.includes(written) ? ['A.3.0', 'B.1.0', 'C.1.0'] : ['B.1.0', 'C.1.0']);   // a new write supersedes each
        }
      }
    }
  });

  it('a close made after the marker arrived, then the reply written on top of the marker elsewhere, beside a close made without it: the reply is carried', () => {
    const shutC = line('C', 1, 9, [q('q1', 'C.1.0', ['A.2.0'], { status: 'closed', draft: pending })]);
    const ls = [made, asked, written, closed, shutC];
    for (const o of orders(ls)) expect(view(combine(o))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: 'found' }] });
    expect(combine(ls).state('question', 'q1').heads[0].data).toMatchObject({ draft: { text: 'The cap is 20%.' } });
  });

  it('a close and a workstream change made after the marker, beside a close made without it: the closes are one, the workstream is a choice, and both carry the draft', () => {
    const shutC = line('C', 1, 9, [q('q1', 'C.1.0', ['A.2.0'], { status: 'closed', draft: pending })]);
    const movedC = line('C', 2, 8, [q('q1', 'C.2.0', ['A.2.0'], { workstream: 'Legal', draft: pending })]);
    const s = combine([made, asked, closed, shutC, movedC]).state('question', 'q1');
    expect(s.live).toBe(false);
    expect(s.heads.map((h) => h.data)).toMatchObject([{ status: 'closed', draft: { status: 'pending' } }, { workstream: 'Legal', draft: { status: 'pending' } }]);
  });

  it('a draft taken as the response on one PC beside a close made without it is not folded: the response and the draft stay where they were', () => {
    const taken = line('A', 4, 9, [q('q1', 'A.4.0', ['A.3.0'], { status: 'answered', response: 'The cap is 20%.' })]);
    const shutC = line('C', 1, 8, [q('q1', 'C.1.0', ['A.3.0'], { status: 'closed', draft: found })]);
    const s = combine([made, asked, written, taken, shutC]).state('question', 'q1');
    expect(s.live).toBe(false);
    expect(s.heads.map((h) => h.data)).toMatchObject([{ status: 'closed', draft: { status: 'found' } }, { status: 'answered', response: 'The cap is 20%.' }]);
    expect((s.heads[1].data as any).draft).toBeUndefined();
  });

  it('two closes, one carrying a new request made on the closing PC, stay a choice: that request is not the drafting PC\'s', () => {
    const shutC = line('C', 1, 9, [q('q1', 'C.1.0', ['A.2.0'], { status: 'closed', draft: { ...pending, opId: 'op_C' } })]);
    expect(view(combine([made, asked, closed, shutC]))).toMatchObject({ live: false });
  });

  it('two versions that say the same but were reached differently are judged by both histories, on any clock', () => {
    const shut = (s: number) => line('B', 1, s, [q('q1', 'B.1.0', ['A.1.0'], { status: 'closed' })]);
    // C discarded the pending draft, then closed: the same as B's close, but C chose to drop the draft. It stays a choice.
    const discarded = line('C', 1, 5, [q('q1', 'C.1.0', ['A.2.0'], {})]);
    for (const [b, c] of [[6, 30], [30, 6]]) {
      const shutC = line('C', 2, c, [q('q1', 'C.2.0', ['C.1.0'], { status: 'closed' })]);
      const v = view(combine([made, asked, written, discarded, shut(b), shutC]));
      expect(v.live).toBe(false); expect(v.heads.map((h) => JSON.stringify(h)).sort()).toEqual([{ status: 'closed', text: 'What is the cap?', draft: null }, { status: 'open', text: 'What is the cap?', draft: 'found' }].map((h) => JSON.stringify(h)));
    }
    // C closed with the marker, then reopened: the reply written meanwhile is the same as the reopen, but the reopen is C's choice
    const shutC = line('C', 1, 5, [q('q1', 'C.1.0', ['A.2.0'], { status: 'closed', draft: pending })]);
    for (const [a, c] of [[10, 30], [30, 10]]) {
      const reply = line('A', 3, a, [q('q1', 'A.3.0', ['A.2.0'], { draft: found })]); const reopen = line('C', 2, c, [q('q1', 'C.2.0', ['C.1.0'], { draft: pending })]);
      const s = combine([made, asked, shut(3), shutC, reply, reopen]).state('question', 'q1');
      expect(s.live).toBe(false); expect(s.heads.map((h) => (h.data as any).status).sort()).toEqual(['closed', 'open']);
      expect(s.heads.every((h) => (h.data as any).draft?.status === 'found')).toBe(true);
    }
    // a response typed on two PCs, one drafted on and one later changed by its typist: x and y stay a choice
    for (const [a, b] of [[10, 30], [30, 10]]) {
      const ls = [made, line('C', 1, 2, [q('q1', 'v0', ['A.1.0'], { response: 'x' })]), line('B', 1, 2, [q('q1', 'v2', ['A.1.0'], { response: 'x' })]),
        line('B', 2, 3, [q('q1', 'v3a', ['v2'], { response: 'x', draft: { ...pending, opId: 'op_B' } })]), line('A', 2, a, [q('q1', 'v1', ['v0'], { response: 'x', draft: pending })]),
        line('B', 3, b, [q('q1', 'v3', ['v3a'], { response: 'x' })]), line('C', 2, 20, [q('q1', 'v4', ['v2'], { response: 'y' })])];
      const s = combine(ls).state('question', 'q1');
      expect(s.live).toBe(false); expect(s.heads.map((h) => (h.data as any).response).sort()).toEqual(['x', 'y']);
    }
  });

  it('a draft discarded on the drafting PC, beside a close or a typed response made without the draft, is one version', () => {
    const fromReply = line('A', 4, 6, [q('q1', 'A.4.0', ['A.3.0'], {})]); const fromMarker = line('A', 3, 6, [q('q1', 'A.3.0', ['A.2.0'], {})]);
    const typed = line('B', 1, 3, [q('q1', 'B.1.0', ['A.1.0'], { response: 'Typed by B.' })]);
    for (const ls of [[made, asked, written, fromReply, closed], [made, asked, fromMarker, closed]]) for (const o of orders(ls)) expect(view(combine(o))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: null }] });
    expect(combine([made, asked, written, fromReply, typed]).state('question', 'q1').heads.map((h) => h.data)).toMatchObject([{ response: 'Typed by B.' }]);
    // but a discard beside Use as response of the same draft is two people's calls on it: a choice
    const used = line('B', 1, 7, [q('q1', 'B.1.0', ['A.3.0'], { status: 'answered', response: 'The cap is 20%.' })]);
    for (const o of orders([made, asked, written, fromReply, used])) expect(view(combine(o))).toMatchObject({ live: false });
    // nor once a third PC changed something else, keeping the draft: all three stand
    const kept = line('C', 1, 8, [q('q1', 'C.1.0', ['A.3.0'], { workstream: 'Tax', draft: found })]);
    for (const o of orders([made, asked, written, fromReply, used, kept])) expect(combine(o).state('question', 'q1').heads.length).toBe(3);
    // nor when the Use as response is the next write on a question shown folded, which is based on both its versions
    const usedFolded = line('B', 2, 9, [q('q1', 'B.2.0', ['A.3.0', 'B.1.0'], { status: 'closed', response: 'The cap is 20%.' })]);
    for (const o of orders([made, asked, written, closed, usedFolded, fromReply])) expect(view(combine(o))).toMatchObject({ live: false });
    // a person's earlier choice on the closing side does not stop a discard beside the close being one version
    const bEdit = line('B', 1, 3, [q('q1', 'B.1.0', ['A.1.0'], { text: 'cap?' })]); const cEdit = line('C', 1, 3, [q('q1', 'C.1.0', ['A.1.0'], { text: 'the cap?' })]);
    const chose = line('B', 2, 5, [q('q1', 'B.2.0', ['B.1.0', 'C.1.0'], { text: 'cap?' })]); const shutB = line('B', 3, 7, [q('q1', 'B.3.0', ['B.2.0'], { status: 'closed', text: 'cap?' })]);
    expect(view(combine([made, asked, written, fromReply, bEdit, cEdit, chose, shutB]))).toMatchObject({ live: true, heads: [{ status: 'closed', text: 'cap?', draft: null }] });
    // a write that changed nothing, beside a real change, is not a choice either
    const same = line('A', 2, 4, [q('q1', 'A.2.0', ['A.1.0'], {})]);
    expect(view(combine([made, same, closed]))).toMatchObject({ live: true, heads: [{ status: 'closed' }] });
  });

  it('the next write on a question shown folded is judged against what its writer saw, so later crossing draft writes still fold', () => {
    for (const data of [{ status: 'closed', response: 'Typed by B.', draft: pending }, { text: 'What is the aggregate cap?', draft: pending }, { status: 'closed', workstream: 'Tax', draft: pending }]) {
      const next = line('B', 2, 5, [q('q1', 'B.2.0', ['A.2.0', 'B.1.0'], data)]);
      for (const o of orders([made, asked, closed, next, written])) expect(view(combine(o))).toMatchObject({ live: true, heads: [{ draft: 'found' }] });
    }
    const typed = line('B', 2, 5, [q('q1', 'B.2.0', ['A.3.0', 'B.1.0'], { status: 'closed', response: 'Typed by B.', draft: found })]);
    const discarded = line('A', 4, 6, [q('q1', 'A.4.0', ['A.3.0'], {})]);
    for (const o of orders([made, asked, written, closed, typed, discarded])) expect(view(combine(o))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: null }] });
  });

  it('a long history of choices, read fresh, still folds a draft crossing the last write, without running out of stack', () => {
    const ls: Line[] = [made]; let prev = 'A.1.0';
    for (let i = 1; i <= 1500; i++) {                                // 1,500 choices on A, each against a B version made on the original
      ls.push(line('B', i, 5, [q('q1', `B.${i}.0`, ['A.1.0'], { workstream: i % 2 ? 'Tax' : 'Legal' })]));
      ls.push(line('A', i + 1, 5, [q('q1', `A.${i + 1}.0`, [prev, `B.${i}.0`], { workstream: `W${i}` })])); prev = `A.${i + 1}.0`;
    }
    ls.push(line('C', 1, 6, [q('q1', 'C.1.0', ['A.1.0'], { draft: pending })]));
    ls.push(line('A', 1502, 7, [q('q1', 'A.1502.0', [prev, 'C.1.0'], { workstream: 'W1500', status: 'closed', draft: pending })]));
    ls.push(line('C', 2, 8, [q('q1', 'C.2.0', ['C.1.0'], { draft: found })]));
    expect(view(combine(ls))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: 'found' }] });
  }, 60000);

  it('another PC\'s import of the same question, set aside as the same, does not turn a discard beside a close into a choice', () => {
    const discarded = line('A', 3, 5, [q('q1', 'A.3.0', ['A.2.0'], {})]);
    const shutC = line('C', 1, 6, [q('q1', 'C.1.0', ['A.2.0'], { status: 'closed', draft: pending })]);
    for (const s of [0, 9]) {
      const importedB = line('B', 1, s, [q('q1', 'B.1.0', [], {})]);
      for (const o of orders([made, asked, discarded, shutC, importedB])) expect(view(combine(o))).toMatchObject({ live: true, heads: [{ status: 'closed', draft: null }] });
    }
  });

  it('a loop of versions (damaged or copied files) is left as it is, and reading it ends', () => {
    const c = new Combined();
    for (const l of [made, closed, line('C', 1, 5, [q('q1', 'C.1.0', ['C.2.0'], { draft: pending })]), line('C', 2, 6, [q('q1', 'C.2.0', ['C.1.0'], { draft: { ...pending, opId: 'op_2' } })]), line('C', 3, 7, [q('q1', 'C.3.0', ['C.1.0'], { draft: { ...pending, opId: 'op_3' } })])]) c.add(l);
    c.release(() => true);
    expect(c.state('question', 'q1').heads.length).toBeGreaterThan(1);
  });
});
