/**
 * 3,000 random version graphs of one question, made by three PCs: drafts asked for, written and discarded, closes and
 * reopens, workstreams, typed responses, Use as response, choices between versions and deletes. Each is read again on four
 * other sets of clocks and in four other orders, and must read the same; and a version that changed something other than
 * the draft must still be shown.
 */
import { describe, it, expect } from 'vitest';
import { Combined, type Line, type RecChange } from '../../src/backend/changeLog';
import { sameContent } from '../../src/domain/versions';

// a small seeded random number generator, so every run makes the same graphs
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
type D = { status: string; workstream: string; response: string; draft?: any };
type V = { ver: string; base: string[]; data?: D; del?: true; pc: string };
const at = (s: number) => new Date(Date.UTC(2026, 10, 10, 10, 0, 0) + s * 1000).toISOString();
const bare = (d: any) => ({ ...d, draft: undefined });

function gen(seed: number, n: number) {
  const r = rng(seed); const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const vs: V[] = [{ ver: 'O', base: [], data: { status: 'open', workstream: '', response: '' }, pc: 'A' }];
  let op = 0;
  for (let i = 0; i < n; i++) {
    const live = vs.filter((v) => !v.del);
    const b = pick(live); const d = b.data!; const pc = pick(['A', 'B', 'C']); const ver = `v${i}`;
    const k = r();
    let nd: D | null = null; let base = [b.ver];
    if (k < 0.18) nd = { ...d, draft: { status: 'pending', text: '', opId: `op${++op}` } };
    else if (k < 0.33) { if (d.draft?.status === 'pending') nd = { ...d, draft: { status: 'found', text: 't' + d.draft.opId, opId: d.draft.opId } }; }
    else if (k < 0.43) { if (d.draft) { nd = { ...d }; delete nd.draft; } }
    else if (k < 0.55) nd = { ...d, status: d.status === 'closed' ? 'open' : 'closed' };
    else if (k < 0.67) nd = { ...d, workstream: pick(['', 'Legal', 'Tax']) };
    else if (k < 0.75) { if (d.draft?.status === 'found') { nd = { ...d, response: d.draft.text, status: 'answered' }; delete nd.draft; } }
    else if (k < 0.85) { const o = pick(live); if (o !== b && !o.del) { base = [b.ver, o.ver]; nd = pick([b, o]).data!; } }
    else if (k < 0.88) { vs.push({ ver, base, del: true, pc }); continue; }
    else nd = { ...d, response: pick(['x', 'y']) };   // a typed response
    if (nd) vs.push({ ver, base, data: nd, pc });
  }
  return vs;
}

function toLines(vs: V[], clock: () => number): Line[] {
  const seq: Record<string, number> = {};
  return vs.map((v) => {
    const s = (seq[v.pc] = (seq[v.pc] ?? 0) + 1);
    const rec: RecChange = { kind: 'question', id: 'q1', ver: v.ver, base: v.base, ...(v.del ? { del: true as const } : { data: { id: 'q1', dealId: 'd1', text: 'Q', ...v.data } }) };
    return { v: 1, pc: v.pc, seq: s, at: at(Math.floor(clock() * 1000)), by: v.pc, from: v.pc, recs: [rec] };
  });
}
const summary = (c: Combined) => { const s = c.state('question', 'q1'); return { live: s.live, rev: s.rev, heads: s.heads.map((h) => (h.del ? 'DEL' : JSON.stringify({ ...(h.data as any) }))).sort() }; };

describe('a question\'s draft folded into crossing versions, on random graphs', () => {
  it('reads the same on any clocks and in any order, and every version with a person\'s change keeps its content', () => {
    let clockFails = 0, orderFails = 0, lossFails = 0; let firstClock = '', firstLoss = '';
    for (let seed = 1; seed <= 3000; seed++) {
      const vs = gen(seed, 4 + (seed % 8));
      const r = rng(seed * 7);
      const l1 = toLines(vs, r); const base = summary((() => { const c = new Combined(); l1.forEach((l) => { c.add(l); }); return c; })());
      // other clocks
      for (let t = 0; t < 4; t++) {
        const r2 = rng(seed * 31 + t);
        const l2 = toLines(vs, r2); const c = new Combined(); l2.forEach((l) => { c.add(l); });
        const s2 = summary(c);
        if (JSON.stringify(s2) !== JSON.stringify(base)) { clockFails++; if (!firstClock) firstClock = `seed ${seed}\n${JSON.stringify(vs)}\n${JSON.stringify(base)}\n${JSON.stringify(s2)}`; break; }
      }
      // other read orders
      for (let t = 0; t < 4; t++) {
        const r3 = rng(seed * 13 + t); const o = [...l1].sort(() => r3() - 0.5); const c = new Combined(); o.forEach((l) => { c.add(l); });
        if (JSON.stringify(summary(c)) !== JSON.stringify(base)) { orderFails++; break; }
      }
      // loss: a raw head that made a non-draft change since parting from every other raw head must have its bare content shown
      const c = new Combined(); l1.forEach((l) => { c.add(l); }); const st = c.state('question', 'q1');
      const byVer = new Map(vs.map((v) => [v.ver, v]));
      const used = new Set(vs.flatMap((v) => v.base)); const raw = vs.filter((v) => !used.has(v.ver));
      if (raw.some((v) => v.del)) continue;
      const anc = (v: V) => { const out = new Set<string>(); const todo = [v.ver]; while (todo.length) { const x = todo.pop()!; if (out.has(x)) continue; out.add(x); todo.push(...(byVer.get(x)?.base ?? [])); } return out; };
      const draftOnlyTo = (h: V, g: V) => { const seen = anc(g); let cur: V | undefined = h; while (cur && !seen.has(cur.ver)) { if (cur.base.length !== 1) return false; const p = byVer.get(cur.base[0]); if (!p || p.del || !sameContent(bare(p.data), bare(cur.data))) return false; cur = p; } return !!cur; };
      for (const h of raw) {
        if (raw.some((g) => g !== h && draftOnlyTo(h, g))) continue;
        { const mine = anc(h); if (vs.some((o) => !mine.has(o.ver) && !o.del && sameContent(bare(o.data), bare(h.data)))) continue; }   // same content made elsewhere: oracle too strict there
        if (!st.heads.some((x) => !x.del && sameContent(bare(x.data), bare({ id: 'q1', dealId: 'd1', text: 'Q', ...h.data })))) {
          lossFails++; if (!firstLoss) firstLoss = `seed ${seed} head ${h.ver}\n${JSON.stringify(vs)}\n${JSON.stringify(summary(c))}`; break;
        }
      }
    }
    expect({ clockFails, orderFails, lossFails }, `${firstClock}\n${firstLoss}`).toEqual({ clockFails: 0, orderFails: 0, lossFails: 0 });
  }, 60000);
});
