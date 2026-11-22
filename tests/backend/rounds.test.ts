// @vitest-environment node
// Rounds, worked out from the check log's lines alone (src/backend/rounds.ts): the state of each round, what each piece
// still needs, the sample, who owns what, fixed finding ids and codes, and liveness by this PC's own clock.
import { describe, it, expect } from 'vitest';
import { view, factsOf, need, undone, sampled, counts, owner, blockOf, unitOf, findingIdFor, docsHash, Observer, type RLine, type RoundDef, type Piece } from '../../src/backend/rounds';

let n = 0; const L = (o: Partial<RLine>, pc = 'a'): RLine => ({ at: '2026-11-12T09:00:00.000Z', n: ++n, pc, ...o });
const item = (id: string, stage: Piece['stage'] = 'check'): Piece => ({ key: `item:${id}`, text: id, reason: 'new', stage });
const plan = (id: string, kind: RoundDef['kind'], pieces: Piece[], more: Partial<RoundDef> = {}): RoundDef => ({ id, kind, by: 'a', docs: 'h', docList: [], core: { key: 'c', ids: [] }, block: 2, pieces, ...more });

describe('the state of a round, from its lines', () => {
  it('an opening ends with its round line, a done that names it, a merge or an abandonment; a round ends done, merged or abandoned', () => {
    const v = view([L({ opening: { id: 'r1', kind: 'first', by: 'a' } }), L({ opening: { id: 'r2', kind: 'quick', by: 'b' } }, 'b'), L({ opening: { id: 'r3', kind: 'first', by: 'a' } }),
      L({ plan: plan('r1', 'first', [item('x')]) }), L({ done: { items: [], opening: 'r2' } }, 'b'), L({ merged: { round: 'r3', into: 'r1', extra: [item('y')] } })]);
    expect([...v.openings.values()].map((o) => o.ended)).toEqual([true, true, true]);
    const r1 = v.rounds.get('r1')!; expect(r1.end).toBeNull(); expect([...r1.ids].sort()).toEqual(['r1', 'r3']); expect(r1.pieces.map((p) => p.key)).toEqual(['item:x', 'item:y']);
    const w = view([...v.lines, L({ abandoned: { round: 'r1' } })]); expect(w.rounds.get('r1')!.end).toEqual({ kind: 'abandoned' });
  });

  it('members join, renew and leave; a member line after `left` is a rejoin', () => {
    const v = view([L({ plan: plan('r', 'first', []) }), L({ member: { round: 'r', pc: 'a', epoch: 1, ok: true } }), L({ member: { round: 'r', pc: 'b', epoch: 1, ok: false } }, 'b'), L({ left: { round: 'r', pc: 'a' } })]);
    const r = v.rounds.get('r')!; expect([...r.members.keys()]).toEqual(['a', 'b']); expect(r.left.has('a')).toBe(true); expect(r.members.get('b')!.ok).toBe(false);
    expect(view([...v.lines, L({ member: { round: 'r', pc: 'a', epoch: 2, ok: true } })]).rounds.get('r')!.left.has('a')).toBe(false);
  });
});

describe('what each piece still needs', () => {
  it('a first pass: an item is done by its result line; one to revisit is looked at first; a finding by the fast model, then the standard where it doubts', () => {
    const P = plan('r', 'first', [item('x'), item('y', 'revisit'), { key: 'finding:f1' }, { key: 'finding:f2' }]);
    const base = [L({ plan: P })]; let v = view(base); let R = v.rounds.get('r')!;
    expect(R.pieces.map((p) => need(R, factsOf(v, R), p))).toEqual(['check', 'glance', 'fast', 'fast']);
    v = view([...base, L({ item: 'x', result: 'ok', round: 'r' }), L({ glanced: { round: 'r', items: [{ item: 'y', same: false, was: 'ok' }] } }), L({ verified: { round: 'r', stage: 'fast', findings: [{ finding: 'f1', stands: true, marked: false }, { finding: 'f2', stands: null, marked: false }] } })]);
    R = v.rounds.get('r')!; expect(R.pieces.map((p) => need(R, factsOf(v, R), p))).toEqual([null, 'check', null, 'standard']);
    v = view([...v.lines, L({ item: 'y', result: 'gap', round: 'r' }), L({ verified: { round: 'r', stage: 'standard', findings: [{ finding: 'f2', stands: false, marked: true }] } })]);
    R = v.rounds.get('r')!; expect(undone(R, factsOf(v, R))).toEqual([]);
  });

  it('a quick check: a look that passes is done unless sampled; a sample waits until every look is in; a skipped piece is done', () => {
    const items = Array.from({ length: 12 }, (_, i) => item(`i${i}`, 'glance')); const P = plan('r', 'quick', [...items, { key: 'finding:f' }], { block: 20 });
    const looks = L({ glanced: { round: 'r', items: items.slice(0, 11).map((p) => ({ item: p.key.slice(5), same: true, was: 'ok' as const })) } });
    let v = view([L({ plan: P }), looks]); let R = v.rounds.get('r')!; let f = factsOf(v, R);
    expect(need(R, f, items[0])).toBe('wait'); expect(sampled(R, f, items[0].key)).toBeNull();                 // one look and the finding's fast answer are not in yet
    v = view([...v.lines, L({ skipped: { round: 'r', key: 'item:i11', why: 'It is no longer on the checklist' } }), L({ verified: { round: 'r', stage: 'fast', findings: [{ finding: 'f', stands: true, marked: false }] } })]);
    R = v.rounds.get('r')!; f = factsOf(v, R);
    const drawn = R.pieces.filter((p) => sampled(R, f, p.key)); expect(drawn.length).toBe(5);                      // twelve passed (eleven items and the finding): a tenth, but at least five
    for (const p of R.pieces) expect(need(R, f, p)).toBe(p.key === 'item:i11' ? null : drawn.includes(p) ? (p.key.startsWith('item:') ? 'sample' : 'standard') : null);
  });

  it('the sample is drawn by hash from the round id: the same on every PC, whoever did the looks; and a different round draws differently', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(`i${i}`, 'glance')); const lines = (id: string, pc: string) => [L({ plan: plan(id, 'quick', items, { block: 30 }) }), L({ glanced: { round: id, items: items.map((p) => ({ item: p.key.slice(5), same: true })) } }, pc)];
    const pick = (id: string, pc: string) => { const v = view(lines(id, pc)); const R = v.rounds.get(id)!; const f = factsOf(v, R); return R.pieces.filter((p) => sampled(R, f, p.key)).map((p) => p.key); };
    expect(pick('r1', 'a')).toEqual(pick('r1', 'b')); expect(pick('r1', 'a').length).toBe(5); expect(pick('r1', 'a')).not.toEqual(pick('r2', 'a'));
  });

  it('the sample is drawn once for a round and its facts, and drawn again when a merge adds pieces to the round', () => {
    const items = Array.from({ length: 60 }, (_, i) => item(`i${i}`, 'glance')); const glanced = (ps: Piece[]) => L({ glanced: { round: 'r', items: ps.map((p) => ({ item: p.key.slice(5), same: true })) } });
    const v = view([L({ plan: plan('r', 'quick', items.slice(0, 50), { block: 60 }) }), glanced(items)]); const R = v.rounds.get('r')!; const f = factsOf(v, R);
    const drawn = () => R.pieces.filter((p) => sampled(R, f, p.key)).map((p) => p.key);
    const before = drawn(); expect(before.length).toBe(5);                                                     // fifty passed: a tenth, five
    for (const p of items.slice(50)) R.pieces.push(p);                                                         // as a merge adds them, on the same round and facts
    const fresh = view([L({ plan: plan('r', 'quick', items, { block: 60 }) }), glanced(items)]); const F = fresh.rounds.get('r')!; const ff = factsOf(fresh, F);
    expect(drawn()).toEqual(F.pieces.filter((p) => sampled(F, ff, p.key)).map((p) => p.key)); expect(drawn().length).toBe(6);   // sixty passed: drawn again, six
    const other = view([L({ plan: plan('r2', 'quick', items, { block: 60 }) }), L({ glanced: { round: 'r2', items: items.map((p) => ({ item: p.key.slice(5), same: true })) } })]).rounds.get('r2')!;
    expect(other.pieces.filter((p) => sampled(other, ff, p.key)).map((p) => p.key)).not.toEqual(drawn());     // another round asked with these facts draws by its own id, not the kept draw
  });
});

describe('two lines for one piece', () => {
  it('the one whose effect was written counts, otherwise the PC whose id sorts first: the same everywhere', () => {
    const ok = L({ item: 'x', result: 'ok', round: 'r' }, 'a'), raised = L({ item: 'x', result: 'finding', finding: 'f', round: 'r' }, 'b'), gap = L({ item: 'x', result: 'gap', round: 'r' }, 'c');
    const eff = (l: RLine) => l.result === 'finding';
    expect(counts(ok, raised, eff)).toBe(raised); expect(counts(raised, ok, eff)).toBe(raised); expect(counts(gap, ok, eff)).toBe(ok); expect(counts(ok, gap, eff)).toBe(ok);
    const v = view([L({ plan: plan('r', 'first', [item('x')]) }), gap, ok]); expect(factsOf(v, v.rounds.get('r')!).get('item:x')!.result).toBe(ok);
    const m = view([L({ plan: plan('r', 'quick', [{ key: 'finding:f' }]) }), L({ verified: { round: 'r', stage: 'standard', findings: [{ finding: 'f', stands: false, marked: false }] } }, 'a'), L({ verified: { round: 'r', stage: 'standard', findings: [{ finding: 'f', stands: false, marked: true }] } }, 'b')]);
    expect(factsOf(m, m.rounds.get('r')!).get('finding:f')!.standard).toMatchObject({ marked: true, pc: 'b' });
  });
});

describe('who owns what', () => {
  it('blocks are cut per first stage, in list order; the owner is the same on every PC and moves only what the leaver had', () => {
    const P = plan('r', 'quick', [item('a', 'glance'), item('b', 'check'), item('c', 'glance'), item('d', 'glance'), { key: 'finding:f' }], { block: 2 });
    const R = view([L({ plan: P })]).rounds.get('r')!; const b = blockOf(R);
    expect(R.pieces.map((p) => unitOf(b, p))).toEqual(['block:glance:0', 'block:check:0', 'block:glance:0', 'block:glance:1', 'finding:f']);
    const units = Array.from({ length: 200 }, (_, i) => `u${i}`); const two = units.map((u) => owner(u, ['pc1', 'pc2'])); const three = units.map((u) => owner(u, ['pc1', 'pc2', 'pc3']));
    expect(two.filter((x) => x === 'pc1').length).toBeGreaterThan(60); expect(two.filter((x) => x === 'pc2').length).toBeGreaterThan(60);           // shared out about evenly
    expect(units.filter((_, i) => three[i] !== 'pc3' && three[i] !== two[i]).length).toBe(0);                                                      // a third PC takes only its own share
  });
});

describe('finding ids', () => {
  it('a fixed id is ULID-shaped and the same for the same deal, documents and item', () => {
    const id = findingIdFor('d1', docsHash(['doc_1', 'doc_2']), 'b1'); expect(id).toMatch(/^f_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(findingIdFor('d1', docsHash(['doc_2', 'doc_1']), 'b1')).toBe(id); expect(findingIdFor('d1', docsHash(['doc_1']), 'b1')).not.toBe(id); expect(findingIdFor('d2', docsHash(['doc_1', 'doc_2']), 'b1')).not.toBe(id);
  });
});

describe('liveness, by this PC\'s own clock', () => {
  it('a PC is live while its lines grow; work in a round is judged by piece lines, not renewals; what was seen is kept across a restart', () => {
    let t = 1000; const kept = { text: null as string | null }; const keep = { read: () => kept.text, write: (s: string) => { kept.text = s; } };
    const ob = new Observer(() => t, keep); const lines: RLine[] = [L({ member: { round: 'r', pc: 'b', epoch: 1, ok: true } }, 'b')];
    ob.observe(lines); expect(ob.live('b', 100)).toBe(true); t += 150; expect(ob.live('b', 100)).toBe(false);
    lines.push(L({ member: { round: 'r', pc: 'b', epoch: 1, ok: true } }, 'b')); ob.observe(lines); expect(ob.live('b', 100)).toBe(true);
    expect(t - ob.lastWork('r', 'b')).toBe(150);                                                                                      // renewals do not count as work
    lines.push(L({ item: 'x', result: 'ok', round: 'r' }, 'b')); ob.observe(lines); expect(ob.lastWork('r', 'b')).toBe(t);
    // after a restart the same lines are not news: a PC quiet before the restart stays quiet
    t += 500; const again = new Observer(() => t, keep); again.observe(lines); expect(again.live('b', 100)).toBe(false); expect(again.quietSince('b')).toBe(1150);
    // out of touch: nobody goes quiet in this PC's eyes
    again.observe(lines, true); expect(again.live('b', 100)).toBe(true);
  });
});
