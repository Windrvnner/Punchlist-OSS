// @vitest-environment node
// The fast model's two calls as a checklist is brought in: rewording, and items that ask for the same thing. Rewording
// asks in parts of 120; the duplicate check asks about a list of deal size in one call, and a longer one in parts. These
// check that the model's numbers come back as the right places in the whole list, and that what answered is kept.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';
import { dealList } from './dealList';
import { SERVICE } from '../../src/control';

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);

const lines = (c: { prompt: string }) => c.prompt.split('\n').filter((l) => /^\d+: /.test(l)).map((l) => l.replace(/^\d+: /, ''));
const isReword = (c: Call) => c.prompt.includes('Propose new wording');
const isSame = (c: { prompt: string }) => c.prompt.includes('ask for exactly the same thing');
/** how many items at the top of the call are being asked about, and those items */
const asking = (c: { prompt: string }) => Number(/Items 1 to (\d+)/.exec(c.prompt)![1]);
const mineIn = (c: { prompt: string }) => lines(c).slice(0, asking(c));
const items = (n: number) => Array.from({ length: n }, (_, i) => `Item ${i + 1} is in place`);

describe('rewording a checklist being brought in', () => {
  it('asks in parts of 120 and gives each suggestion its place in the whole list; numbers out of range, unchanged wording and repeats are left out', async () => {
    const s = setup((c) => {
      if (!isReword(c)) return {};
      const shown = lines(c);
      return { items: [{ n: 2, text: `${shown[1]}, signed`, why: 'unclear' }, { n: 2, text: 'again', why: 'repeat' }, { n: 1, text: shown[0], why: 'same' }, { n: shown.length + 1, text: 'out of range' }, { n: 'x', text: 'not a number' }] };
    }, {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.reword!({ items: items(250) }));
    const asked = s.calls.filter(isReword).map((c) => lines(c).length);
    expect(asked).toEqual([120, 120, 10]);
    expect(out.map((r) => [r.at, r.text])).toEqual([[1, 'Item 2 is in place, signed'], [121, 'Item 122 is in place, signed'], [241, 'Item 242 is in place, signed']]);
  });
  it('takes an item split in two as its first item and the rest, and asks for "(if applicable)" only where it fits', async () => {
    const s = setup((c) => (!isReword(c) ? {} : { items: [{ n: 1, texts: ['Wetlands delineation complete (if applicable).', '  Section 404 permit in hand (if applicable).'], why: 'two conditions' }, { n: 2, texts: [], why: 'empty' }] }), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.reword!({ items: ['Wetlands delineation complete; any Section 404 permit in hand', 'Insurance in place'] }));
    expect(out).toEqual([{ at: 0, text: 'Wetlands delineation complete (if applicable).', also: ['Section 404 permit in hand (if applicable).'], why: 'two conditions' }]);
    expect(s.calls.find(isReword)!.prompt).toContain('never to every item');
  });
  it('a reply that cannot be read fails the whole review, so nothing half-asked is shown', async () => {
    const s = setup((c) => (isReword(c) ? 'not JSON at all' : {}), {}, { shared: new Mem(), installId: 'pc' });
    const r = await s.ai.reword!({ items: items(3) });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.kind).toBe('failed');
  });
});

describe('items that ask for the same thing', () => {
  it('asks about the list and the general list in one call, and maps each pair back to its place, once each', async () => {
    const mine = items(130); const general = ['General A is in place', 'General B is in place'];
    const s = setup((c) => (!isSame(c) ? {} : { pairs: [{ a: 1, b: 121, why: 'same' }, { a: 121, b: 1, why: 'same again' }, { a: 2, b: 132, why: 'same' }, { a: 125, b: 131 }, { a: 3, b: 3 }, { a: 999, b: 1 }, { a: 'x', b: 2 }] }), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.sameMeaning!({ items: mine, against: general }));
    expect(s.calls.filter(isSame).map((c) => [asking(c), lines(c).length])).toEqual([[130, 132]]);
    expect(out.pairs.map((p) => [p.a, p.b, p.inAgainst])).toEqual([[0, 120, false], [1, 1, true], [124, 0, true]]);
  });
});

describe('questions for the counterparty on what is unresolved (#2)', () => {
  const isPhrase = (c: Call) => c.prompt.includes('Write one question for the counterparty');
  // each point is asked with a tag of its own: "kqz: [gap] …"
  const TAG = /^([bcdfghjkmnpqrstvwxz]{3}): (\[(?:gap|finding)\] .*)$/;
  const tagged = (c: { prompt: string }) => c.prompt.split('\n').flatMap((l) => { const m = TAG.exec(l); return m ? [{ id: m[1], line: m[2] }] : []; });
  const lines = (c: { prompt: string }) => tagged(c).map((x) => x.line);
  const ids = (c: { prompt: string }) => tagged(c).map((x) => x.id);
  const points = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: (i % 5 ? 'gap' : 'finding') as 'gap' | 'finding', what: `Point ${i + 1}`, need: i % 5 ? `The signed copy ${i + 1}` : '' }));
  it('asks in parts of 120 and gives each question back in the order of the points, whatever order the reply takes', async () => {
    const s = setup((c) => (isPhrase(c) ? { items: lines(c).map((l, n) => ({ id: ids(c)[n], text: `Q for ${l.split(' — ')[0]}` })).reverse() } : {}), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd', items: points(250) }));
    expect(s.calls.filter(isPhrase).map((c) => lines(c).length)).toEqual([120, 120, 10]);
    expect(out.length).toBe(250); expect([out[0], out[1], out[249]]).toEqual(['Q for [finding] Point 1', 'Q for [gap] Point 2', 'Q for [gap] Point 250']);
    expect(lines(s.calls.find(isPhrase)!)[1]).toBe('[gap] Point 2 — needed: The signed copy 2');
  });
  const answer = (c: Call) => ({
    items: tagged(c).map(({ id, line }) => ({ id, text: `Q for ${line.split(' — ')[0]}` })),
  });
  const cut = () => { throw Object.assign(new Error('cut off'), { code: 'cutoff' }); };
  it('a reply cut off above 50 points brings the parts down to what fits, for the rest of the run (parts.ts)', async () => {
    let cuts = 0;
    const s = setup((c) => (!isPhrase(c) ? {} : lines(c).length > 50 ? (cuts++, cut()) : answer(c)), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd', items: points(500) }));
    const sizes = s.calls.filter(isPhrase).map((c) => lines(c).length);
    expect(sizes[0]).toBe(120); expect(cuts).toBeLessThan(4); expect(Math.max(...sizes.slice(cuts * 3))).toBeLessThanOrEqual(50); expect(sizes.length).toBeLessThan(30);
    expect(out).toEqual(points(500).map((p, k) => `Q for [${p.kind}] Point ${k + 1}`));
  });
  it('a reply that leaves points out keeps the questions that came back and asks only for the rest', async () => {
    let first = true;
    const s = setup((c) => { if (!isPhrase(c)) return {}; const r = answer(c); if (first) { first = false; r.items = r.items.slice(0, 70); } return r; }, {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd', items: points(120) }));
    // asked again in parts of each kind: the 40 gaps, then the 10 findings
    const asked = s.calls.filter(isPhrase).map(lines);
    expect(asked.map((l) => l.length)).toEqual([120, 40, 10]);
    expect(asked.slice(1).flat().map((l) => Number(/Point (\d+)/.exec(l)![1])).sort((a, b) => a - b)).toEqual(range(71, 121));
    expect(out).toEqual(points(120).map((p, k) => `Q for [${p.kind}] Point ${k + 1}`));
  });
  it('a point the model leaves out among others is asked once more, then set aside', async () => {
    const s = setup((c) => { if (!isPhrase(c)) return {}; const r = answer(c); return { items: r.items.length > 1 ? r.items.filter((x) => !x.text.endsWith(' Point 1')) : r.items }; }, {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd', items: points(360) }));
    expect(s.calls.filter(isPhrase).map((c) => lines(c).length)).toEqual([120, 120, 120, 1]);      // left out, then asked alone
    expect([out[0], out[1], out[359]]).toEqual(['Q for [finding] Point 1', 'Q for [gap] Point 2', 'Q for [gap] Point 360']);
  });
  it('one point that is always cut off is set aside, named by null, and the rest come back', async () => {
    const bad = (c: Call) => lines(c).some((l) => l.startsWith('[gap] Point 1999 '));
    const s = setup((c) => (!isPhrase(c) ? {} : bad(c) ? cut() : answer(c)), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd', items: points(2000) }));
    expect(out[1998]).toBeNull(); expect(out.filter((t) => t === null).length).toBe(1);
    expect(out[1997]).toBe('Q for [gap] Point 1998'); expect(out[1999]).toBe('Q for [gap] Point 2000');
    expect(s.calls.filter(isPhrase).length).toBeLessThan(45);      // a cut-off with nothing whole in it halves the parts for the rest of the run (parts.ts)
    // another deal still goes 120 to a call
    const before = s.calls.length; val(await s.ai.phrase!({ dealId: 'e', items: points(240) }));
    expect(s.calls.slice(before).filter(isPhrase).map((c) => lines(c).length)).toEqual([120, 120]);
  });
  it('a point the model always leaves out is set aside and the rest are kept, rather than failing the whole Add', async () => {
    const s = setup((c) => (!isPhrase(c) ? {} : { items: answer(c).items.filter((x) => !x.text.endsWith(' Point 777')) }), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd', items: points(2000) }));
    expect(out[776]).toBeNull(); expect(out.filter((t) => t === null).length).toBe(1); expect(out[777]).toBe('Q for [gap] Point 778');
    expect(s.calls.filter(isPhrase).length).toBeLessThan(20);
  });
  it('a service that fails every point after answering is asked down to single points, keeping what came', async () => {
    for (const fail of [() => ({ items: [] }), cut]) {
      let first = true;
      const s = setup((c) => { if (!isPhrase(c)) return {}; if (first) { first = false; return answer(c); } return fail(); }, {}, { shared: new Mem(), installId: 'pc' });
      const r = await s.ai.phrase!({ dealId: 'd', items: points(2000) });
      // what the first call phrased is offered, and the rest are set aside, for the preview to count with Retry
      const v = val(r);
      // each part that brought nothing is split down to single points: at most 2 x 1,880 - 1 asks for the rest (#1109)
      expect(s.calls.filter(isPhrase).length).toBeLessThan(1 + 2 * 1880);
      expect([v.filter((t) => t !== null).length, v.filter((t) => t === null).length, v[0]]).toEqual([120, 1880, 'Q for [finding] Point 1']);
    }
    // every 10th point never answered, among points that are: each is set aside, and the run finishes
    const t = setup((c) => (!isPhrase(c) ? {} : { items: answer(c).items.filter((x) => !/ Point \d*0$/.test(x.text)) }), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await t.ai.phrase!({ dealId: 'd', items: points(2000) }));
    expect(out.filter((x) => x === null).length).toBe(200); expect(out[0]).toBe('Q for [finding] Point 1');
  });
  it('no shape of failing service makes more than 2 x 2,000 - 1 asks in a run (#1109)', async () => {
    const isFinding = (l: string) => l.startsWith('[finding]');
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let calls = 0;
    const phrased = (c: Call, keep: (l: string, n: number) => boolean) =>
      ({ items: answer(c).items.filter((_, n) => keep(lines(c)[n], n)) });
    const most = 2 * 2000 - 1;
    const shapes: [string, (c: Call) => unknown][] = [
      ['findings never phrased, empty', (c) => phrased(c, (l) => !isFinding(l))],
      ['findings never phrased, a findings-only ask cut off',
        (c) => (lines(c).every(isFinding) ? cut() : phrased(c, (l) => !isFinding(l)))],
      ['half never answered', (c) => phrased(c, (l) => /[13579] /.test(`${l.split(' — ')[0]} `))],
      ['empty above 10 points, no word of it', (c) => (lines(c).length > 10 ? { items: [] } : answer(c))],
      ['answers once, then cut off', (c) => (++calls > 1 ? cut() : answer(c))],
      ['70% of calls fail at random', (c) => (rnd() < 0.7 ? cut() : answer(c))],
      ['every 10th point never answered', (c) => phrased(c, (l) => !/ Point \d*0( |$)/.test(l))],
      ['10% of points skipped at random', (c) => phrased(c, () => rnd() >= 0.1)],
      ['30% of points skipped at random', (c) => phrased(c, () => rnd() >= 0.3)],
      ['50% of points skipped at random', (c) => phrased(c, () => rnd() >= 0.5)],
      ['the first half of every reply only', (c) => phrased(c, (_, n) => n < Math.floor(lines(c).length / 2))],
      ['the last half of every reply only', (c) => phrased(c, (_, n) => n >= Math.floor(lines(c).length / 2))],
    ];
    for (const [name, reply] of shapes) {
      calls = 0;
      const s = setup((c) => (isPhrase(c) ? reply(c) : {}), {}, { shared: new Mem(), installId: 'pc' });
      const r = await s.ai.phrase!({ dealId: 'd', items: points(2000) });
      const n = s.calls.filter(isPhrase).length;
      expect([name, n <= most]).toEqual([name, true]);
      if (r.ok) expect(r.value.length).toBe(2000);
    }
    // a cut-off that follows the length of what is asked: short points first, then long ones, cut above 15 short points' worth
    const long = points(2000).map((p, k) => (k < 120 ? p : { ...p, what: `${p.what} ${'x'.repeat(200)}` }));
    const room = lines({ prompt: points(15).map((p) => `bcd: [${p.kind}] ${p.what}${p.need ? ` — needed: ${p.need}` : ''}`).join('\n') }).join('').length * 4;
    let cuts = 0;
    const t = setup((c) => { if (!isPhrase(c)) return {}; if (lines(c).join('').length > room) { cuts++; return cut(); } return { items: lines(c).map((l, n) => ({ id: ids(c)[n], text: `Q ${l.slice(0, 20)}` })) }; }, {}, { shared: new Mem(), installId: 'pc' });
    val(await t.ai.phrase!({ dealId: 'd', items: long }));
    const asked = t.calls.filter(isPhrase).length; console.log('length-based cut-off', asked, cuts);
    expect(asked).toBeLessThanOrEqual(2 * 2000 - 1);
    expect(cuts).toBeLessThan(100);      // parts halve after cut-offs (parts.ts)
    // a passing outage: the first 7 calls are cut off, then every part answers whole; the size comes back up
    for (const m of [3, 7]) {
      let k = 0; const v = setup((c) => (!isPhrase(c) ? {} : ++k <= m ? cut() : answer(c)), {}, { shared: new Mem(), installId: 'pc' });
      val(await v.ai.phrase!({ dealId: 'd', items: points(2000) })); const went = v.calls.filter(isPhrase).length; console.log('outage', m, went);
      expect(went).toBeLessThan(80);
    }
    // a stray item with no tag, or one not of the part, moves nothing; a tag in capitals or with spaces is still its point's
    const w = setup((c) => (!isPhrase(c) ? {} : { items: [{ text: 'Here are the questions' }, { id: 'zzz', text: 'Thank you' }, ...answer(c).items.map((x) => ({ ...x, id: ` ${x.id.toUpperCase()} ` }))] }), {}, { shared: new Mem(), installId: 'pc' });
    expect(val(await w.ai.phrase!({ dealId: 'd', items: points(300) }))).toEqual(points(300).map((p, k) => `Q for [${p.kind}] Point ${k + 1}`));
  });
  it('a limit on the reply\'s length, one that falls, cut-offs at random, and a stray item not read as renumbering', async () => {
    const text = (c: Call) => lines(c).join('\n').length;
    const run = async (f: (c: Call, k: number) => unknown, p: ReturnType<typeof points>) => {
      let k = 0, cuts = 0; const s = setup((c) => { if (!isPhrase(c)) return {}; try { return f(c, k++); } catch (e) { cuts++; throw e; } }, {}, { shared: new Mem(), installId: 'pc' });
      const r = await s.ai.phrase!({ dealId: 'd', items: p }); return { r, calls: s.calls.filter(isPhrase).length, cuts };
    };
    const pad = (n: number, f: (i: number) => number) => points(n).map((x, i) => ({ ...x, what: f(i) ? `${x.what} ${'m'.repeat(f(i))}` : x.what }));
    const want = (p: ReturnType<typeof points>) => p.map((x) => `Q for [${x.kind}] ${x.what}`);
    // a run, then Retry for the points left, as the dialog does: how many runs it took, and the most calls in one
    const retried = async (f: (c: Call, k: number) => unknown, p: ReturnType<typeof points>) => {
      let k = 0; const s = setup((c) => (!isPhrase(c) ? {} : f(c, k++)), {}, { shared: new Mem(), installId: 'pc' });
      const got: (string | null)[] = p.map(() => null); let runs = 0, most = 0;
      for (let ask = range(0, p.length); ask.length && runs < 8; ask = range(0, p.length).filter((j) => got[j] === null)) {
        const before = k; const r = val(await s.ai.phrase!({ dealId: 'd', items: ask.map((j) => p[j]) })); runs++; most = Math.max(most, k - before);
        r.forEach((t, j) => { if (t !== null) got[ask[j]] = t; });
      }
      return { got, runs, most };
    };
    // a short outage, then a limit of 3,000 characters, far below what the limits allow (about 13 points to a reply):
    // the parts come down, and a Retry finishes
    const mixed = pad(2000, (i) => (i * 37) % 300);
    const a = await retried((c, k) => { if (k < 6 || text(c) > 3000) throw cut(); return answer(c); }, mixed);
    expect([a.got, a.runs <= 3, a.most <= bound(2000)]).toEqual([want(mixed), true, true]);
    // every point near the limit alone: each asked alone, over a few runs
    const huge = pad(300, () => 5000);
    const b = await retried((c) => { if (text(c) > 6000) throw cut(); return answer(c); }, huge);
    expect([b.got, b.runs <= 6]).toEqual([want(huge), true]);
    // the limit falls from 6,000 to 1,500 characters after 10 calls: the parts come down, and Retries finish
    const c = await retried((c, k) => { if (text(c) > (k < 10 ? 6000 : 1500)) throw cut(); return answer(c); }, mixed);
    expect([c.got, c.runs <= 8, c.most <= bound(2000)]).toEqual([want(mixed), true, true]);
    // a service that cuts off a third of its replies whatever their length: each run is bounded, and Retry finishes
    let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const d = await retried((c) => { if (rnd() < 1 / 3) throw cut(); return answer(c); }, points(2000));
    expect([d.got, d.runs <= 4, d.most <= bound(2000)]).toEqual([want(points(2000)), true, true]);
    // a stray preface with the last point left out, or the first left out with a stray item after: nothing misplaced.
    // The stray item's id has vowels, so it can never be one of the call's tags, which are drawn at random from
    // consonants only ('xxx' could be drawn, and then the stray item was rightly placed as that point's question).
    // A point asked alone takes the one question of its reply whatever its id (a model that numbers its answers), so
    // these stray forms are given only for parts of more than one point
    type Entry = { id?: string; text: string };
    const preface = (it: Entry[]) => [{ text: 'Here are the questions:' }, ...it.slice(0, -1)];
    const thanks = (it: Entry[]) => [...it.slice(1), { id: 'aei', text: 'Thank you.' }];
    for (const f of [preface, thanks]) {
      const e = await run((c) => ({ items: lines(c).length > 1 ? f(answer(c).items) : answer(c).items }), points(500));
      val(e.r).forEach((t, k) => { expect([null, want(points(500))[k]]).toContain(t); });
    }
  });
  // a run's asks are bounded by the halving: each part that brings nothing is split down to single points (#1109)
  const bound = (n: number) => 2 * n - 1;
  const num = (l: string) => Number(/Point (\d+)/.exec(l)![1]) - 1;
  const holds = (c: Call, p: (j: number) => boolean) => lines(c).some((l) => p(num(l)));
  // a run, then Retry for just the points it could not draft, as the dialog does, until only failing points are left
  // or two Retries in a row fail: the calls of each run, whether it failed, and what is left
  const retrying = async (n: number, f: (c: Call, k: number) => unknown, retries = 8, all = points(n)) => {
    let k = 0; const s = setup((c) => (!isPhrase(c) ? {} : f(c, k++)), {}, { shared: new Mem(), installId: 'pc' });
    const got: (string | null)[] = all.map(() => null); let ask = range(0, n); const runs: { calls: number; ok: boolean; left: number }[] = [];
    for (let run = 0; run <= retries && ask.length; run++) {
      const before = k; const r = await s.ai.phrase!({ dealId: 'd', items: ask.map((j) => all[j]) }); runs.push({ calls: k - before, ok: r.ok, left: ask.length });
      if (!r.ok) { if (runs.length > 1 && !runs.at(-2)!.ok) break; continue; }      // the person presses Retry again after a failure, not after two
      r.value.forEach((t, j) => { if (t !== null) got[ask[j]] = t; }); ask = range(0, n).filter((j) => got[j] === null); runs[run].left = ask.length;
    }
    got.forEach((t, j) => { if (t !== null) expect(t).toBe(`Q for [${all[j].kind}] ${all[j].what}`); });
    return { runs, left: ask };
  };
  it('failing points are set aside without holding up the rest, each run is bounded, and Retry recovers what a run left', async () => {
    // 3 to 300 failing points at the top of the list (cut off, or brought back empty; findings come first, and a model
    // may fail every part holding one): the first run offers most of the rest, Retry the others, and a Retry of only
    // failing points fails within 2 x m - 1 asks, as each part that brought nothing is halved down to single points
    const top = (n: number, f: number) => points(n).map((p, j) => ({ ...p, kind: (j < f ? 'finding' : 'gap') as 'gap' | 'finding' }));
    const ofKind = (c: Call) => lines(c).some((l) => l.startsWith('[finding]'));
    for (const [n, m, finding] of [[2000, 3, false], [2000, 13, false], [2000, 40, false], [2000, 150, true], [2000, 300, true], [5000, 300, true]] as const) for (const fail of [cut, () => ({ items: [] })]) {
      const a = await retrying(n, (c) => ((finding ? ofKind(c) : holds(c, (j) => j < m)) ? fail() : answer(c)), 6, finding ? top(n, m) : points(n));
      const last = a.runs.at(-1)!;
      const first = [a.runs[0].ok, a.runs[0].left <= m + 40];
      const want = [n, m, true, true, range(0, m), false, true];
      expect([n, m, ...first, a.left, last.ok, last.calls <= bound(m)]).toEqual(want);
    }
    // a few points that always fail, spread through 2,000 or 5,000: each run is bounded, and Retry ends with those only
    for (const [n, every] of [[2000, 1000], [2000, 200], [2000, 100], [5000, 1000], [5000, 200], [5000, 100]]) {
      const a = await retrying(n, (c) => (holds(c, (j) => j % every === 3) ? cut() : answer(c)), 10);
      const most = Math.max(...a.runs.map((r) => r.calls));
      const want = [n, every, true, range(0, n).filter((j) => j % every === 3), false];
      expect([n, every, most <= bound(n), a.left, a.runs.at(-1)!.ok]).toEqual(want);
    }
    // a passing trouble (half of all calls cut off for a while, or an outage of 30 calls) beside a few points that always
    // fail: good points that failed alone meanwhile are split from the failing ones on Retry, and all come back (they
    // were once asked only in one part with them, never split, and stayed out for good)
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const [n, trouble] of [[2000, (k: number) => k < 150 && rnd() < 0.5], [5000, (k: number) => k < 300 && rnd() < 0.5], [2000, (k: number) => k >= 20 && k < 50]] as const) {
      const a = await retrying(n, (c, k) => (holds(c, (j) => j % 400 === 17) || trouble(k) ? cut() : answer(c)), 10);
      expect([n, a.left, a.runs.at(-1)!.ok]).toEqual([n, range(0, n).filter((j) => j % 400 === 17), false]);
    }
    // many failing (1 in 20, 1 in 10, every finding): each run is bounded and offers what came back, and each Retry
    // brings more
    const cutEvery = (m: number) => (c: Call) => (holds(c, (j) => j % m === 3) ? cut() : answer(c));
    const noFindings = (c: Call) => (lines(c).some((l) => l.startsWith('[finding]')) ? { items: [] } : answer(c));
    const shapes = [[2000, cutEvery(20)], [2000, cutEvery(10)], [2000, noFindings], [5000, cutEvery(20)]] as const;
    for (const [n, f] of shapes) {
      const a = await retrying(n, f, 4);
      const more = a.runs.every((r, j) => r.calls <= bound(n) && (!r.ok || r.left < (j ? a.runs[j - 1].left : n)));
      expect([n, more]).toEqual([n, true]);
    }
    // two points a reply, far below what the limits allow, then every call fails after 500: each run is bounded and
    // brings more, and once the service is down a Retry fails, bounded by the points it asks for
    for (const fail of [cut, () => ({ items: [] })]) {
      const c = await retrying(2000, (c, k) => (k >= 500 ? fail() : lines(c).length > 2 ? cut() : answer(c)), 8);
      const runs = c.runs;
      const more = runs.every((r, j) => r.calls <= bound(2000) && (!r.ok || r.left < (j ? runs[j - 1].left : 2000)));
      expect([more, runs.at(-1)!.ok, runs.at(-1)!.calls <= bound(runs.at(-1)!.left), 2000 - c.left.length > 800])
        .toEqual([true, false, true, true]);
    }
  });
  it('on a real checklist, a reply that leaves points out, swaps them or numbers them puts no question on the wrong point; a Retry is bounded as the first run', async () => {
    // the first 2,000 items of a deal-scale list, whose neighbors share most of their words: a question is taken only for
    // a tag of its part, so a model that leaves the third (and fourth, or sixth) point out, swaps the third and seventh,
    // reverses the third to sixth, or gives running numbers in place of the tags, places nothing wrongly (retrying checks
    // every question against its point), and all come back
    const real = dealList().items.slice(0, 2000).map((what) => ({ kind: 'gap' as const, what, need: '' }));
    type It = { id?: string; n?: number; text: string };
    const drop = (at: number[]) => (it: It[]) => (it.length <= Math.max(...at) + 1 ? it : it.filter((_, k) => !at.includes(k)));
    const swap = (it: It[]) => (it.length < 8 ? it : it.map((x, k) => (k === 2 ? it[6] : k === 6 ? it[2] : x)));
    const reverse = (it: It[]) => (it.length < 7 ? it : it.map((x, k) => (k >= 2 && k <= 5 ? it[7 - k] : x)));
    const numbered = (it: It[]) => it.map((x, k) => ({ n: k + 1, text: x.text }));
    for (const [name, f, most] of [['as asked', (it: It[]) => it, 1], ['third left out', drop([2]), 3], ['third and fourth left out', drop([2, 3]), 3], ['third and sixth left out', drop([2, 5]), 3], ['third and seventh swapped', swap, 1], ['third to sixth reversed', reverse, 1]] as const) {
      const a = await retrying(2000, (c) => ({ items: f(answer(c).items) }), 10, real);
      const bounded = a.runs.every((r) => r.ok && r.calls <= bound(2000));
      expect([name, a.left, bounded, a.runs.length <= most]).toEqual([name, [], true, true]);
    }
    // a model that gives running numbers in place of the tags is understood only for a point asked alone: slow, as each
    // point takes a call, but nothing lands on the wrong point, each run is bounded, and each brings more
    const n = await retrying(2000, (c) => ({ items: numbered(answer(c).items) }), 4, real);
    expect(n.runs.every((r, j) => r.calls <= bound(2000) && (!r.ok || r.left < (j ? n.runs[j - 1].left : 2000))))
      .toBe(true);
    // spread-out points that bring back an empty reply (1 in 30), and 200 failing points of both kinds at the top, cut
    // off: each run is bounded, and the Retries reach every good point
    for (const [bad, f] of [[(j: number) => j % 30 === 3, () => ({ items: [] })], [(j: number) => j < 200, cut]] as const) {
      const a = await retrying(2000, (c) => (holds(c, bad) ? f() : answer(c)), 10);
      expect([a.left, a.runs.every((r) => r.calls <= bound(2000))]).toEqual([range(0, 2000).filter(bad), true]);
    }
  });
  it('a reply that stops partway with no word from the service is treated as cut off: no half-written question is kept', async () => {
    // the stand-in sends only the first 3,000 characters of a reply and says nothing of it
    const s = setup((c) => (!isPhrase(c) ? {} : JSON.stringify({ items: lines(c).map((l, n) => ({ id: ids(c)[n], text: `Please provide the signed and dated copy for ${l.split(' — ')[0]}` })) }).slice(0, 3000)), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.phrase!({ dealId: 'd', items: points(240) }));
    expect(out).toEqual(points(240).map((p, k) => `Please provide the signed and dated copy for [${p.kind}] Point ${k + 1}`));
  });
  it('words before the JSON, a stray quote in a question, a reply that is no JSON, and a run for part of a deal', async () => {
    const full = (c: Call) => JSON.stringify({ items: lines(c).map((l, n) => ({ id: ids(c)[n], text: `Please provide the signed and dated copy for ${l.split(' — ')[0]}` })) });
    const want = (n: number) => points(n).map((p, k) => `Please provide the signed and dated copy for [${p.kind}] Point ${k + 1}`);
    // brackets in the words before the JSON are not its end: nothing half-written is kept, and the parts come down to what fits
    const s = setup((c) => (!isPhrase(c) ? {} : `Here are the questions for the [gap] and [finding] points:\n\`\`\`json\n${full(c)}`.slice(0, 3000)), {}, { shared: new Mem(), installId: 'pc' });
    expect(val(await s.ai.phrase!({ dealId: 'd', items: points(2000) }))).toEqual(want(2000));
    const sizes = s.calls.filter(isPhrase).map((c) => lines(c).length);
    expect(sizes.length).toBeLessThan(80); expect(Math.max(...sizes.slice(4))).toBeLessThan(120);
    // the same when those words name the field, and the size is kept for the run: far fewer calls than asking 120 each time
    const s2 = setup((c) => (!isPhrase(c) ? {} : `Here is the "items" list you asked for:\n${full(c)}`.slice(0, 3000)), {}, { shared: new Mem(), installId: 'pc' });
    expect(val(await s2.ai.phrase!({ dealId: 'd', items: points(2000) }))).toEqual(want(2000));
    expect(s2.calls.filter(isPhrase).length).toBeLessThan(80);
    // a model that answers only its first 50 points and closes the reply is asked 50 at a time from then on
    const s3 = setup((c) => { if (!isPhrase(c)) return {}; const r = answer(c); r.items = r.items.slice(0, 50); return r; }, {}, { shared: new Mem(), installId: 'pc' });
    val(await s3.ai.phrase!({ dealId: 'd', items: points(2000) }));
    // each call still gets 50 back, the points left out asked again as parts of their own kind
    expect(s3.calls.filter(isPhrase).length).toBeLessThan(70);
    // a whole reply with an unescaped quote in a question is not taken for one cut off
    const t = setup((c) => (!isPhrase(c) ? {} : `{"items":[${lines(c).map((_, n) => `{"id":"${ids(c)[n]}","text":"Please send the 5" pipe spec ${n + 1}"}`).join(',')}]}`), {}, { shared: new Mem(), installId: 'pc' });
    expect(val(await t.ai.phrase!({ dealId: 'd', items: points(3) }))[2]).toBe('Please send the 5" pipe spec 3');
    expect(t.calls.filter(isPhrase).length).toBe(1);
    const t2 = setup((c) => (!isPhrase(c) ? {} : `\`\`\`json\n{"items":[${lines(c).map((_, n) => `{"id":"${ids(c)[n]}","text":"Please send the 5" pipe spec ${n + 1}"}`).join(',')}]}\n\`\`\`\nLet me know if you need more.`), {}, { shared: new Mem(), installId: 'pc' });
    val(await t2.ai.phrase!({ dealId: 'd', items: points(3) })); expect(t2.calls.filter(isPhrase).length).toBe(1);
    // one reply that is no JSON at all, on a run of two points, does not make later runs smaller
    let once = true;
    const u = setup((c) => { if (!isPhrase(c)) return {}; if (once) { once = false; return 'I am not sure what you mean.'; } return answer(c); }, {}, { shared: new Mem(), installId: 'pc' });
    val(await u.ai.phrase!({ dealId: 'd', items: points(2) }));
    const before = u.calls.length; val(await u.ai.phrase!({ dealId: 'e', items: points(2000) }));
    expect(u.calls.slice(before).filter(isPhrase).length).toBe(17);
    // a run for some of a deal's points that succeeds leaves what a failed run (here, a service error) phrased for the others
    const bad = (c: Call) => lines(c).some((l) => l.startsWith('[gap] Point 1999 '));
    const v = setup((c) => { if (!isPhrase(c)) return {}; if (bad(c)) throw new Error('boom'); return answer(c); }, {}, { shared: new Mem(), installId: 'pc' });
    expect((await v.ai.phrase!({ dealId: 'd', items: points(2000) })).ok).toBe(false);
    val(await v.ai.phrase!({ dealId: 'd', items: points(100) }));
    const from = v.calls.filter(isPhrase).length; expect((await v.ai.phrase!({ dealId: 'd', items: points(2000) })).ok).toBe(false);
    // the 100 handed over and the 80 of the part that failed, not all 2,000; the failing part is asked twice more, quietly (Retries)
    expect(v.calls.filter(isPhrase).slice(from).map((c) => lines(c).length)).toEqual([120, 60, 60, 60]);
  });
  it('a run in which no point gets a question fails, saying why; a point left out among answered ones is set aside; another error fails once its retries are used up', async () => {
    const s = setup((c) => (isPhrase(c) ? cut() : {}), {}, { shared: new Mem(), installId: 'pc' });
    const r = await s.ai.phrase!({ dealId: 'd', items: points(3) });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.message).toBe(`${SERVICE}’s reply was cut off, so nothing was added`);
    // the first point cut off is asked alone, cut off again set aside, and so for each (parts.ts)
    expect(s.calls.filter(isPhrase).map((c) => lines(c).length)).toEqual([3, 1, 2, 1, 1]);
    const t = setup((c) => (isPhrase(c) ? 'not JSON at all' : {}), {}, { shared: new Mem(), installId: 'pc' });
    const q = await t.ai.phrase!({ dealId: 'd', items: points(3) });
    expect(q.ok).toBe(false); if (!q.ok) expect(q.error.message).toBe(`${SERVICE}’s reply could not be read, so nothing was added`);
    const v = setup((c) => (isPhrase(c) ? { items: ids(c).slice(1).map((id) => ({ id, text: 'A question' })) } : {}), {}, { shared: new Mem(), installId: 'pc' });
    const w = await v.ai.phrase!({ dealId: 'd', items: points(3) });
    expect(val(w)).toEqual([null, 'A question', 'A question']);
    const x = setup((c) => (isPhrase(c) ? { items: [] } : {}), {}, { shared: new Mem(), installId: 'pc' });
    const y = await x.ai.phrase!({ dealId: 'd', items: points(3) });
    expect(y.ok).toBe(false); if (!y.ok) expect(y.error.message).toBe(`${SERVICE} left a point without a question, so nothing was added`);
    const u = setup((c) => { if (isPhrase(c)) throw new Error('boom'); return {}; }, {}, { shared: new Mem(), installId: 'pc' });
    const e = await u.ai.phrase!({ dealId: 'd', items: points(250) });
    expect(e.ok).toBe(false); expect(u.calls.filter(isPhrase).length).toBe(3);      // asked twice more, quietly (Retries), then the run fails
  });
  describe('sized to the model\'s limits, with the shared quiet retry (#1109)', () => {
    const stage = (reply: (c: Call, k: number) => unknown) => {
      let k = 0;
      return setup((c) => (isPhrase(c) ? reply(c, k++) : {}), {}, { shared: new Mem(), installId: 'pc' });
    };
    const want = (n: number) => points(n).map((p, k) => `Q for [${p.kind}] Point ${k + 1}`);
    it('a point never phrased among 2,000 is offered for Retry, and every other point is phrased', async () => {
      const s = stage((c) => ({ items: answer(c).items.filter((x) => !x.text.endsWith(' Point 777')) }));
      const out = val(await s.ai.phrase!({ dealId: 'd', items: points(2000) }));
      expect(out).toEqual(want(2000).map((q, k) => (k === 776 ? null : q)));
      // Retry asks for that point alone, and it fails again, saying why
      const before = s.calls.filter(isPhrase).length;
      const again = await s.ai.phrase!({ dealId: 'd', items: [points(2000)[776]] });
      const asked = s.calls.filter(isPhrase).slice(before).map(lines);
      expect(asked).toEqual([['[gap] Point 777 — needed: The signed copy 777']]);
      expect(again.ok).toBe(false);
    });
    it('30 empty replies in a row, then good ones, still phrase every point', async () => {
      const s = stage((c, k) => (k < 30 ? { items: [] } : answer(c)));
      expect(val(await s.ai.phrase!({ dealId: 'd', items: points(2000) }))).toEqual(want(2000));
    });
    it('a part whose every reply is empty is halved down to single points: at most 2 x 64 - 1 asks', async () => {
      const s = stage(() => ({ items: [] }));
      const r = await s.ai.phrase!({ dealId: 'd', items: points(64) });
      const asked = s.calls.filter(isPhrase).map((c) => lines(c).length);
      expect(asked[0]).toBe(64);
      expect(asked.length).toBeLessThanOrEqual(127);
      expect(asked.filter((n) => n === 1).length).toBe(64);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.message).toBe(`${SERVICE} left a point without a question, so nothing was added`);
    });
    it('a service that cannot be reached fails the run, and what came back is kept for asking again', async () => {
      const down = () => { throw Object.assign(new Error('offline'), { code: 'unreachable' }); };
      let up = false;
      const s = stage((c, k) => (up || k === 0 ? answer(c) : down()));
      expect((await s.ai.phrase!({ dealId: 'd', items: points(240) })).ok).toBe(false);
      expect(s.calls.filter(isPhrase).length).toBe(2);
      up = true;
      expect(val(await s.ai.phrase!({ dealId: 'd', items: points(240) }))).toEqual(want(240));
      const again = s.calls.filter(isPhrase).slice(2).flatMap(lines).map((l) => Number(/Point (\d+)/.exec(l)![1]));
      expect(again.sort((a, b) => a - b)).toEqual(range(121, 241));
    });
  });
});

describe('the duplicate check on a list of deal size', () => {
  // the stand-in model pairs the list's repeats whenever both are in the call, as a model that reads well would
  const { items: list, repeats } = dealList();
  const judgeOf = (all: string[], twins: [number, number][]) => (c: { prompt: string }) => {
    const at = new Map(all.map((t, k) => [t, k])); const shown = lines(c).map((t) => at.get(t)!); const pos = new Map(shown.map((g, k) => [g, k + 1])); const m = asking(c); const pairs = [];
    for (const [a, b] of twins) { const x = pos.get(a), y = pos.get(b); if (x && y && (x <= m || y <= m)) pairs.push(x <= m ? { a: x, b: y, why: 'same' } : { a: y, b: x, why: 'same' }); }
    return { pairs };
  };
  const judge = judgeOf(list, repeats);
  const sorted = (ps: number[][]) => ps.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  it('asks about 2,400 items and the general list in one call, and finds every repeat', async () => {
    expect(new Set(list).size).toBe(list.length);
    const s = setup((c) => (isSame(c) ? judge(c) : {}), {}, { shared: new Mem(), installId: 'pc' });
    const general = ['Insurance certificates were delivered to lenders', 'The site survey is certified'];
    const out = val(await s.ai.sameMeaning!({ items: list, against: general }));
    const asked = s.calls.filter(isSame);
    expect(asked.length).toBe(1); expect(mineIn(asked[0])).toEqual(list); expect(lines(asked[0]).slice(asking(asked[0]))).toEqual(general);
    expect(out.pairs.map((p) => [p.a, p.b])).toEqual(sorted(repeats.map(([a, b]) => [a, b])));
    expect(out.missed).toBeUndefined();
  });

  it('maps pairs with the general list back to it', async () => {
    // the first 400 items are the general list; a repeat of one of them in the list brought in is a pair with the general list
    const s = setup((c) => (isSame(c) ? judge(c) : {}), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.sameMeaning!({ items: list.slice(400), against: list.slice(0, 400) }));
    const want = repeats.filter(([, b]) => b >= 400).map(([a, b]) => (a < 400 ? [b - 400, a, 1] : [a - 400, b - 400, 0]));
    expect(out.pairs.map((p) => `${p.a}:${p.b}:${Number(p.inAgainst)}`).sort()).toEqual(want.map((w) => w.join(':')).sort());
    expect(want.some((w) => w[2] === 1)).toBe(true);   // the list has pairs with the general list to find
  });

  it('a reply cut off at the length limit is asked for again for half the items at a time; what answered is kept, the rest listed as missed and asked about alone later', async () => {
    const items = list.slice(0, 200); const twins: [number, number][] = [[10, 100], [120, 170]]; const pairsIn = judgeOf(items, twins);
    // the whole list's reply, and every reply asking about item 160, is cut off at the service's length limit
    const cut = () => { throw Object.assign(new Error('cut off'), { code: 'cutoff' }); };
    const s = setup((c) => (!isSame(c) ? {} : asking(c) === 200 || mineIn(c).includes(items[160]) ? cut() : pairsIn(c)), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.sameMeaning!({ items, against: [] }));
    // 0–99 answers, seeing 100–199; 100–149 answers; 150–174 never does; 175–199 answers
    expect(s.calls.filter(isSame).map(asking)).toEqual([200, 100, 100, 50, 50, 25, 25]);
    expect(out.pairs.map((p) => [p.a, p.b])).toEqual([[10, 100], [120, 170]]);
    expect(out.missed).toEqual({ kind: 'failed', at: range(150, 175) });
    // a reply that arrives but cannot be read is asked for again the same way
    const garbled = setup((c) => (!isSame(c) ? {} : asking(c) === 200 ? 'not JSON at all' : pairsIn(c)), {}, { shared: new Mem(), installId: 'pc' });
    expect(val(await garbled.ai.sameMeaning!({ items, against: [] })).pairs.length).toBe(2); expect(garbled.calls.filter(isSame).map(asking)).toEqual([200, 100, 100]);
    // asked again about those, with repeats and places out of range left out: one call, shown every item after the first of them
    const again = setup((c) => (isSame(c) ? pairsIn(c) : {}), {}, { shared: new Mem(), installId: 'pc' });
    const back = val(await again.ai.sameMeaning!({ items, against: [], only: [...out.missed!.at, 150, -1, 5000, 1.5] }));
    const c = again.calls.filter(isSame); expect(c.length).toBe(1);
    expect(mineIn(c[0]).map((t) => items.indexOf(t))).toEqual(range(150, 175)); expect(lines(c[0]).slice(asking(c[0])).map((t) => items.indexOf(t))).toEqual(range(175, 200));
    expect(back.missed).toBeUndefined();
  });

  it('a list too long for one call is asked about in parts, a few at a time; when the service fails one, no more are begun and its items are listed as missed', async () => {
    // 6,200 items: parts of 3,000, 3,000 and 200, each shown the items after it
    const long = [...list, ...list.map((t) => `${t} (second set)`), ...list.slice(0, 1400).map((t) => `${t} (third set)`)];
    const twins: [number, number][] = [[5, 4000], [3500, 6100]]; const pairsIn = judgeOf(long, twins);
    for (const error of [Object.assign(new Error('down'), { code: 'unreachable' }), new Error('refused')]) {
      const s = setup((c) => { if (!isSame(c)) return {}; if (mineIn(c).includes(long[0])) throw error; return pairsIn(c); }, {}, { shared: new Mem(), installId: 'pc', retry: { retries: 0 } });
      const out = val(await s.ai.sameMeaning!({ items: long, against: [] }));
      const asked = s.calls.filter(isSame);
      expect(asked.map((c) => [asking(c), lines(c).length])).toEqual([[3000, 6200], [3000, 3200], [200, 200]]);    // all three begun at once
      expect(out.pairs.map((p) => [p.a, p.b])).toEqual([[3500, 6100]]);
      expect(out.missed).toEqual({ kind: error.message === 'down' ? 'unreachable' : 'failed', at: range(0, 3000) });
    }
    const none = setup((c) => { if (isSame(c)) throw Object.assign(new Error('down'), { code: 'unreachable' }); return {}; }, {}, { shared: new Mem(), installId: 'pc' });
    const r = await none.ai.sameMeaning!({ items: list, against: [] });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.kind).toBe('unreachable');
  }, 30_000);
});

describe('reading a list in, line by line', () => {
  const isRead = (c: Call) => c.prompt.includes('Say what each line not marked "context only" is');
  /** the lines a call asks about, by number, and the context lines shown before them */
  const asked = (c: Call) => c.prompt.split('\n').filter((l) => /^\d+: /.test(l)).map((l) => Number(l.split(':')[0]));
  const context = (c: Call) => c.prompt.split('\n').filter((l) => /^\d+ \(context only\): /.test(l)).map((l) => Number(l.split(' ')[0]));
  const list = ['1. Site', '', '1.1 Title report', 'Page 2 of 6', ...Array.from({ length: 400 }, (_, i) => `1.${i + 2} Item ${i + 2} is in place`)];
  it('asks about every line that is not blank, with the lines before each part for context, and keeps each reading by its line number', async () => {
    const s = setup((c) => (!isRead(c) ? {} : { lines: asked(c).map((n) => (n === 1 ? { n, k: 'section', text: 'Site' } : n === 4 ? { n, k: 'left' } : { n, k: 'item', text: list[n - 1].replace(/^[\d.]+ /, '') })).concat([{ n: 2, k: 'item', text: 'a blank line' } as never, { n: 9999, k: 'item' } as never, { n: 5, k: 'nonsense' } as never]) }), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.readList!({ lines: list }));
    const calls = s.calls.filter(isRead);
    expect(calls.flatMap(asked)).toEqual(list.flatMap((l, i) => (l.trim() ? [i + 1] : [])));
    expect(calls.length).toBeGreaterThan(1);
    // each part after the first shows the six lines before it for context, and asks nothing about them
    for (const c of calls.slice(1)) expect(context(c)).toEqual(range(asked(c)[0] - 6, asked(c)[0]));
    expect(out.length).toBe(403); expect(out.find((r) => r.n === 2)).toBeUndefined();
    expect(out.slice(0, 3)).toEqual([{ n: 1, k: 'section', text: 'Site' }, { n: 3, k: 'item', text: 'Title report' }, { n: 4, k: 'left' }]);
  });
  it('asks about just the lines named, on the thorough model when asked to', async () => {
    const s = setup((c) => (!isRead(c) ? {} : { lines: asked(c).map((n) => ({ n, k: 'left' })) }), {}, { shared: new Mem(), installId: 'pc' });
    const out = val(await s.ai.readList!({ lines: list, only: [4, 50], thorough: true }));
    const calls = s.calls.filter(isRead);
    expect(calls.flatMap(asked)).toEqual([4, 50]); expect(calls.map((c) => c.model)).toEqual(['thorough']);
    expect(out.map((r) => r.n)).toEqual([4, 50]);
  });
  it('a reply that cannot be read fails the read, so half a list is never shown as all of it', async () => {
    const s = setup((c) => (isRead(c) ? 'not JSON at all' : {}), {}, { shared: new Mem(), installId: 'pc' });
    const r = await s.ai.readList!({ lines: list.slice(0, 5) });
    expect(r.ok).toBe(false);
  });
});

describe('model-written text is kept whole up to one Excel cell (#1104)', () => {
  const isPhrase = (c: Call) => c.prompt.includes('Write one question for the counterparty');
  const tagOf = (c: { prompt: string }) => /^([bcdfghjkmnpqrstvwxz]{3}): /m.exec(c.prompt)![1];
  const point = [{ kind: 'gap' as const, what: 'Point 1', need: 'The signed copy' }];
  const stand = { shared: new Mem(), installId: 'pc' };
  const phraseWith = (text: string) => setup(
    (c) => (isPhrase(c) ? { items: [{ id: tagOf(c), text }] } : {}),
    {},
    stand,
  );
  const sentence = 'Please send the signed and dated copy. ';
  const CUT_NOTE = '… [cut: longer than Excel allows in one cell]';
  it('keeps a 2,500-character question whole', async () => {
    const text = 'q'.repeat(2500);
    expect(val(await phraseWith(text).ai.phrase!({ dealId: 'd', items: point }))).toEqual([text]);
  });
  it('cuts a 40,000-character question at a sentence and ends it with the visible note', async () => {
    const text = sentence.repeat(1000);
    const [question] = val(await phraseWith(text).ai.phrase!({ dealId: 'd', items: point }));
    expect(question!.length).toBeLessThanOrEqual(32767);
    expect(question!.endsWith(CUT_NOTE)).toBe(true);
    expect(question!.startsWith(sentence)).toBe(true);
  });
  it('keeps a 700-character reworded item whole', async () => {
    const text = 'Wetlands delineation complete. '.repeat(22).trim();
    const s = setup((c) => (isReword(c) ? { items: [{ n: 1, text, why: 'unclear' }] } : {}), {}, stand);
    expect(val(await s.ai.reword!({ items: ['Wetlands'] }))[0].text).toBe(text);
  });
  it('keeps all eight parts of a split item', async () => {
    const texts = Array.from({ length: 8 }, (_, k) => `Condition ${k + 1} is met`);
    const s = setup((c) => (isReword(c) ? { items: [{ n: 1, texts, why: 'many' }] } : {}), {}, stand);
    const [row] = val(await s.ai.reword!({ items: ['A; B; C; D; E; F; G; H'] }));
    expect([row.text, ...row.also!]).toEqual(texts);
  });
});
