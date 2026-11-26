// @vitest-environment node
// Reading an issues list: the list is read from its file in one call, each point in the list's own words, then every
// point is titled and compared with the deal's findings and the earlier points in one call. At deal scale: a 164-point
// list against 126 findings, 23 points repeating a finding and 4 repeating an earlier point, and a 400-point list.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';
import { tokensOf, tooLong, UNREAD_REPLY } from '../../src/backend/limits';

type P = { n: string; text: string };
const isRead = (c: Call) => c.prompt.includes('is an issues list');
const isSort = (c: Call) => c.prompt.startsWith('These are the findings already raised');
const isConfirm = (c: Call) => c.prompt.includes('Each pair below is a point');
const POINTS = Array.from({ length: 164 }, (_, k) => `Clause ${k + 1}.${k % 7} should be changed to the agreed position ${k * 3}.`);
const LIST: P[] = POINTS.map((text, k) => ({ n: String(k + 1), text }));
const FINDINGS = Array.from({ length: 126 }, (_, k) => ({ id: `f${k}`, title: `Finding ${k} on the credit agreement`, text: `What finding ${k} says. [1]` }));
/** point (0-based) → what it repeats: 23 findings and 4 earlier points */
const SAME = new Map<number, string>([...Array.from({ length: 23 }, (_, k) => [k * 7, `F${k * 5 + 1}`] as [number, string]), [60, 'P26'], [79, 'P30'], [103, 'P62'], [141, 'P113']]);
const doc = { doc: 'Issues List – Sponsor counsel (Nov 14).pdf', docId: 'doc_0123456789abcdef01234567' };
const rec = [{ docId: doc.docId, name: doc.doc }] as never;
/** the sorter: titles every point asked about, and says what it repeats */
function sorter(o: { cutSortOver?: number; skip?: number } = {}) {
  return (c: Call) => {
    const named = /For each of points ([P\d, ]+):/.exec(c.prompt); const shown = [...c.prompt.matchAll(/^P(\d+): /gm)].map((m) => +m[1]);
    const asked = named ? named[1].split(', ').map((x) => +x.slice(1)) : shown;
    if (o.cutSortOver && asked.length > o.cutSortOver) throw Object.assign(new Error('cut off'), { code: 'cutoff' });
    return { points: asked.filter((p) => p !== o.skip).map((p) => ({ p, title: `Point ${p} title`, workstream: p % 2 ? 'legal' : 'Financial', same: SAME.get(p - 1) ?? '' })) };
  };
}
/**
 * The stand-in model for the list L. The read gives every point in one reply (`edit` changes what it sends, `cut`
 * cuts it off at the length limit); the sorter titles points; a join named from opening words is confirmed.
 */
type Opts = {
  edit?: (pts: P[]) => unknown;
  cut?: boolean;
  sort?: (c: Call) => unknown;
  confirm?: (c: Call) => unknown;
};
function stand(L: P[], o: Opts = {}) {
  return (c: Call) => {
    if (isSort(c)) return (o.sort ?? sorter())(c);
    // a join named from opening words or titles is confirmed with both in full: by default, every pair is the same
    if (isConfirm(c)) return o.confirm ? o.confirm(c) : { same: [...c.prompt.matchAll(/^Pair (\d+)$/gm)].map((m) => +m[1]) };
    if (!isRead(c)) return {};
    if (o.cut) throw Object.assign(new Error('cut off'), { code: 'cutoff' });
    return o.edit ? o.edit(L) : { points: L };
  };
}
const plain = (len: number, label = (k: number) => `${k + 1}.`) => Array.from({ length: len }, (_, k) => ({ n: label(k), text: `Point ${k + 1} raises clause ${k} of the agreement here.` }));
const ask = (s: ReturnType<typeof setup>) => s.ai.issuesList!({ dealId: 'd1', doc, findings: FINDINGS, workstreams: ['Legal', 'Financial'] });
const read = async (f: (c: Call) => unknown) => {
  const s = setup(f, { d1: rec }, { shared: new Mem(), installId: 'pc' });
  const r = await ask(s);
  return { r, s, n: r.ok ? r.value.points.length : r.error.message, reads: s.calls.filter(isRead) };
};

describe('reading an issues list', () => {
  it('reads the list in one call, then compares its points with 126 findings in one call, and maps each '
    + 'repeat', async () => {
    // the reader's words are kept as given, inner spacing included; only the edges are trimmed
    const wordy = (p: P, k: number) => (k === 1 ? `${p.text}\n  and  more` : `  ${p.text}\n`);
    const spaced = (pts: P[]) => ({ points: pts.map((p, k) => ({ ...p, text: wordy(p, k) })) });
    const { r, s, reads } = await read(stand(LIST, { edit: spaced }));
    const out = val(r);
    expect(reads.length).toBe(1);
    // the list goes with the read, and with nothing else
    expect(reads[0].files.length).toBe(1);
    expect(s.calls.filter(isSort).length).toBe(1);
    expect(s.calls.filter(isSort)[0].files).toEqual([]);
    expect(out.points.length).toBe(164);
    expect(out.points[0]).toEqual({
      n: '1', text: POINTS[0], title: POINTS[0], workstream: 'Legal', same: { finding: 'f0' },
    });
    // inner spacing and line breaks kept
    expect(out.points[1].text).toBe(`${POINTS[1]}\n  and  more`);
    expect(out.points[1].workstream).toBe('Financial');
    expect(out.points[2].workstream).toBe('Legal');   // the workstream as the app names it, whatever the case
    expect(out.points.filter((p) => p.same && 'finding' in p.same).length).toBe(23);
    expect(out.points[60].same).toEqual({ point: 25 });
    expect(out.points[141].same).toEqual({ point: 112 });
    expect(s.calls.filter(isSort)[0].prompt).toContain('F1: Finding 0 on the credit agreement: What finding 0 says.');   // citation markers left out
    expect(s.calls.filter(isSort)[0].prompt).not.toContain('"title"');   // the sorter is not asked for a title
  });
  it('asks for each point in the list\'s own words, never reworded', async () => {
    const { reads } = await read(stand(plain(3)));
    expect(reads[0].prompt).toContain('exactly as written. Never reword, shorten or merge');
    expect(reads[0].prompt).not.toContain('your own words');
  });
  it('asks again, twice, for a reply that cannot be read, then succeeds or fails the import', async () => {
    const unreadable = (until: number) => {
      let tries = 0;
      const answers = stand(LIST);
      return (c: Call) => (isRead(c) && ++tries <= until ? 'Here are the points, in prose.' : answers(c));
    };
    const twice = await read(unreadable(2));
    expect(twice.reads.length).toBe(3);
    expect(twice.n).toBe(164);
    const never = await read(unreadable(9));
    expect(never.reads.length).toBe(3);
    expect(never.r.ok).toBe(false);
  });
  it('reads a 400-point list in one call, whatever its length, with no paging and no check', async () => {
    const { n, reads, s } = await read(stand(plain(400)));
    expect(n).toBe(400);
    expect(reads.length).toBe(1);
    expect(s.calls.length).toBe(2);                                              // the read and the comparison
  });
  it('reads a list whose reply is cut off at the length limit as failed, importing nothing', async () => {
    const { r, reads } = await read(stand(LIST, { cut: true }));
    expect(r.ok).toBe(false);
    expect(reads.length).toBe(1);
  });
  it('fails, importing nothing, when the reply is not a list or has no points', async () => {
    expect((await read(stand(LIST, { edit: () => 'no list here' }))).n).toBe(UNREAD_REPLY);
    expect((await read(stand([]))).n).toBe('No points were found in it');
  });
  it('keeps the points of a list whose own points repeat, numbered or not', async () => {
    const sort = (c: Call) => ({
      points: [...c.prompt.matchAll(/^P(\d+): /gm)].map((m) => ({ p: +m[1], title: 'A', workstream: 'Legal' })),
    });
    const twice = [{ n: '', text: 'Please confirm.' }, { n: '', text: 'Please confirm.' }];
    expect(val((await read(stand(twice, { sort }))).r).points.map((p) => p.n)).toEqual(['1', '2']);
    const sections = [...plain(40), { n: '1.', text: 'Not agreed.' }, { n: '1.', text: 'Not agreed.' }, ...plain(30)];
    expect((await read(stand(sections, { sort }))).n).toBe(72);
    const same = Array.from({ length: 30 }, () => ({ n: '', text: 'See above.' }));
    expect((await read(stand(same, { sort }))).n).toBe(30);
  });
  it('asks again, in halves, about points a reply was cut off for or left out, and fails when one never comes back', async () => {
    const s = await read(stand(LIST, { sort: sorter({ cutSortOver: 100 }) }));
    expect(val(s.r).points.every((p) => p.title)).toBe(true);
    expect(s.s.calls.filter(isSort).length).toBe(3);
    // a point the model leaves out every time fails the whole, rather than coming in with no title
    const t = await read(stand(LIST, { sort: sorter({ skip: 9 }) }));
    expect(t.r.ok).toBe(false);
    expect(t.s.calls.filter(isSort).length).toBe(4);                                     // the whole, then that one point three times
  });
  it('a workstream not the firm’s is left blank, for a person, rather than failing the list', async () => {
    const { r } = await read(stand([{ n: '1', text: 'A point.' }], { sort: () => ({ points: [{ p: 1, title: 'A point', workstream: 'Environmental' }] }) }));
    expect(val(r).points[0].workstream).toBe('');
  });
  it('a call that fails is asked again twice before the read fails', async () => {
    const failing = (when: (call: number) => boolean) => {
      let call = 0;
      const f = stand(plain(200));
      return (c: Call) => {
        if (isRead(c) && when(call++)) throw new Error('The service timed out');
        return f(c);
      };
    };
    expect((await read(failing((c) => c === 0 || c === 1))).n).toBe(200);
    const always = await read(failing(() => true));
    expect(always.r.ok).toBe(false);
    expect(always.reads.length).toBe(3);                                         // the read and two more tries
  });
  it('a long list of long points against many findings is compared in parts that fit the input limit', async () => {
    const long = Array.from({ length: 1200 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1}: ${'The borrower shall deliver the executed direct agreement with the offtaker and the EPC contractor before financial close, in a form satisfactory to the lenders. '.repeat(4).trim()}` }));
    const many = (n: number) => Array.from({ length: n }, (_, k) => ({ id: `f${k}`, title: `Finding ${k} on the credit agreement security package`, text: 'The security package does not include an equity pledge over the holding company and the account bank has not signed. '.repeat(3).trim() }));
    for (const [L, F] of [[long, many(126)], [long.slice(0, 600), many(1500)]] as const) {
      let biggest = 0; const base = stand(L);
      const s = setup((c: Call) => { const t = tokensOf(c.prompt); biggest = Math.max(biggest, t); if (t > 180_000) throw tooLong('prompt is too long'); return base(c); }, { d1: rec }, { shared: new Mem(), installId: 'pc' });
      const r = await s.ai.issuesList!({ dealId: 'd1', doc, findings: F, workstreams: ['Legal', 'Financial'] });
      expect(r.ok ? r.value.points.length : r.error.message).toBe(L.length);
      expect(biggest).toBeLessThanOrEqual(180_000);
      // every point titled with its own words
      expect(r.ok && r.value.points.every((p, k) => p.text === L[k].text && p.title === L[k].text)).toBe(true);
    }
  }, 120_000);
  it('a long list against 5,000 findings is compared with the findings a share at a time, each call within the budget', async () => {
    const L = Array.from({ length: 1200 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1}: ${'The borrower shall deliver the executed direct agreement with the offtaker and the EPC contractor before financial close, in a form satisfactory to the lenders. '.repeat(4).trim()}` }));
    const F = Array.from({ length: 5000 }, (_, k) => ({ id: `f${k}`, title: `Finding ${k} on the credit agreement security package`, text: 'The security package does not include an equity pledge over the holding company and the account bank has not signed. '.repeat(3).trim() }));
    let biggest = 0, sent = 0; const base = stand(L);
    const s = setup((c: Call) => { const t = tokensOf(c.prompt); biggest = Math.max(biggest, t); sent += t; if (t > 180_000) throw tooLong('prompt is too long'); return base(c); }, { d1: rec }, { shared: new Mem(), installId: 'pc' });
    const r = await s.ai.issuesList!({ dealId: 'd1', doc, findings: F, workstreams: ['Legal', 'Financial'] });
    expect(r.ok ? r.value.points.length : r.error.message).toBe(1200);
    expect(r.ok && r.value.points.every((p, k) => p.text === L[k].text && p.title === L[k].text)).toBe(true);
    expect(biggest).toBeLessThanOrEqual(108_000);                                       // the budget: 60% of the 180,000 input limit
    expect(s.calls.filter(isSort).length).toBeLessThan(30); expect(sent).toBeLessThan(3_000_000);   // not one call per point (15 calls, 1.8M tokens)
  }, 120_000);
  it('a join named from opening words or titles is kept only when a call with both in full confirms it', async () => {
    const L = Array.from({ length: 1200 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1}: ${'The borrower shall deliver the executed direct agreement with the offtaker and the EPC contractor before financial close, in a form satisfactory to the lenders. '.repeat(4).trim()}` }));
    const F = Array.from({ length: 126 }, (_, k) => ({ id: `f${k}`, title: `Finding ${k}`, text: 'What it says.' }));
    // the sorter names a finding for point 900 and an earlier point for point 1000; the confirmation says only the first is the same
    const sort = (c: Call) => { const named = /For each of points ([P\d, ]+):/.exec(c.prompt); const asked = named ? named[1].split(', ').map((x) => +x.slice(1)) : [...c.prompt.matchAll(/^P(\d+): /gm)].map((m) => +m[1]);
      return { points: asked.map((p) => ({ p, title: `T${p}`, workstream: 'Legal', same: p === 900 ? 'F3' : p === 1000 ? 'P2' : '' })) }; };
    let pairs = '';
    const confirm = (c: Call) => { pairs += c.prompt; return { same: [...c.prompt.matchAll(/^Pair (\d+)\nA: Point (\d+):/gm)].filter((m) => m[2] === '900').map((m) => +m[1]) }; };
    const { r } = await read(stand(L, { sort, confirm }));
    const pts = r.ok ? r.value.points : [];
    expect(pts[899].same).toEqual({ finding: 'f2' }); expect(pts[999].same).toBeUndefined();   // not confirmed: a finding of its own
    expect(pairs).toContain(`B: the earlier point ${L[1].text}`);                             // both in full
  }, 120_000);
  it('a call the service refuses as too long, though counted to fit, is asked again in a shorter form, not failed', async () => {
    const L = Array.from({ length: 1200 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1}: ${'The borrower shall deliver the executed direct agreement with the offtaker and the EPC contractor before financial close, in a form satisfactory to the lenders. '.repeat(4).trim()}` }));
    const base = stand(L);
    const s = setup((c: Call) => { if (tokensOf(c.prompt) > 60_000) throw tooLong('prompt is too long'); return base(c); }, { d1: rec }, { shared: new Mem(), installId: 'pc' });
    const r = await s.ai.issuesList!({ dealId: 'd1', doc, findings: FINDINGS, workstreams: ['Legal', 'Financial'] });
    expect(r.ok ? r.value.points.length : r.error.message).toBe(1200);
  }, 120_000);
  it('compares each finding by its whole text, so a point differing only past character 400 is joined to the right '
    + 'finding without a confirming call (#1108)', async () => {
    const words = (k: number, end: string) => `Point ${k + 1}: ${'The borrower shall deliver the executed direct agreement with the offtaker and the EPC contractor before financial close, in a form satisfactory to the lenders. '.repeat(3)}${end}`;
    const F = Array.from({ length: 10 }, (_, k) => ({ id: `f${k}`, title: `Finding ${k}`, text: words(k, 'The lenders bear the cost.') }));
    const L = Array.from({ length: 20 }, (_, k) => ({ n: String(k + 1), text: k === 3 ? words(2, 'The borrower bears the cost.') : `Point ${k + 1} raises clause ${k} of the agreement here.` }));
    expect(F[2].text.length).toBeGreaterThan(400);
    const sort = (c: Call) => { const shown = [...c.prompt.matchAll(/^P(\d+): /gm)].map((m) => +m[1]); return { points: shown.map((p) => ({ p, title: `T${p}`, workstream: 'Legal', same: p === 4 ? 'F3' : '' })) }; };
    const s = setup(stand(L, { sort }), { d1: rec }, { shared: new Mem(), installId: 'pc' });
    const r = await s.ai.issuesList!({ dealId: 'd1', doc, findings: F, workstreams: ['Legal', 'Financial'] });
    const sorts = s.calls.filter(isSort);
    expect(sorts.length).toBe(1);
    expect(sorts[0].prompt).toContain(F[2].text);                                // the whole text, past character 240
    expect(s.calls.filter(isConfirm).length).toBe(0);                           // nothing was shown shortened
    expect(r.ok && r.value.points[3].same).toEqual({ finding: 'f2' });
  });
});
