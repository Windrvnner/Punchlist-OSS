// @vitest-environment node
// Reading an issues list: the list is read from its file a page of points at a time, each page checked against the
// file in a call of its own, then every point is titled and compared with the deal's findings and the earlier points in
// one call. At deal scale: a 164-point list against 126 findings, 23 points repeating a finding and 4 repeating an earlier
// point. A reply cut off is asked for again with fewer points.
import { describe, it, expect } from 'vitest';
import { setup, val, Mem, type Call } from './reviewKit';
import { tokensOf, tooLong } from '../../src/backend/limits';

type P = { n: string; text: string };
const isRead = (c: Call) => c.prompt.includes('is an issues list');
const isSort = (c: Call) => c.prompt.startsWith('These are the findings already raised');
const isCheck = (c: Call) => c.prompt.includes('these were read as its points');
const isConfirm = (c: Call) => c.prompt.includes('Each pair below is a point');
const POINTS = Array.from({ length: 164 }, (_, k) => `Clause ${k + 1}.${k % 7} should be changed to the agreed position ${k * 3}.`);
const LIST: P[] = POINTS.map((text, k) => ({ n: String(k + 1), text }));
const FINDINGS = Array.from({ length: 126 }, (_, k) => ({ id: `f${k}`, title: `Finding ${k} on the credit agreement`, text: `What finding ${k} says. [1]` }));
/** point (0-based) → what it repeats: 23 findings and 4 earlier points */
const SAME = new Map<number, string>([...Array.from({ length: 23 }, (_, k) => [k * 7, `F${k * 5 + 1}`] as [number, string]), [60, 'P26'], [79, 'P30'], [103, 'P62'], [141, 'P113']]);
const doc = { doc: 'Issues List – Sponsor counsel (Nov 14).pdf', docId: 'doc_0123456789abcdef01234567' };
const rec = [{ docId: doc.docId, name: doc.doc }] as never;
const UNREAD = 'It could not be read to its end, so nothing was imported';

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
 * The stand-in model for the list L. A page starts after the points read so far (the count in the prompt), or where
 * `shift` says (a model that lost count); `drop` leaves points out of a page, `edit` changes what a page sends, `cap`
 * cuts off any reply asked for more. The check compares the lines it is shown with the true stretch of L and answers
 * truthfully, or as `check` says given the truth.
 */
type Opts = { drop?: (k: number, call: number) => boolean; shift?: (from: number, call: number) => number; edit?: (pts: P[], call: number) => unknown; more?: (got: number[], call: number) => unknown; cap?: number; check?: (truth: { missing: string[]; extra: number[] }) => unknown; sort?: (c: Call) => unknown; confirm?: (c: Call) => unknown };
function stand(L: P[], o: Opts = {}) {
  let call = 0, start = 0, end = 0;
  const key = (n: string, text: string) => `${n}|${text.trim()}`;
  return (c: Call) => {
    if (isCheck(c)) {
      const shown = [...c.prompt.matchAll(/^\d+\. (?:numbered "([^"]*)": )?("(?:[^"\\]|\\.)*")$/gm)].map((m) => `${m[1] ?? ''}|${JSON.parse(m[2])}`);
      const left = L.slice(start, c.prompt.includes('to the end of the list:') ? L.length : end).map((p) => key(p.n, p.text)); const extra: number[] = [];
      shown.forEach((x, k) => { const at = left.indexOf(x); if (at < 0) extra.push(k + 1); else left.splice(at, 1); });
      const truth = { missing: left.map((x) => x.split('|')[0] || x.split('|')[1]), extra };
      return o.check ? o.check(truth) : truth;
    }
    if (isSort(c)) return (o.sort ?? sorter())(c);
    // a join named from opening words or titles is confirmed with both in full: by default, every pair is the same
    if (isConfirm(c)) return o.confirm ? o.confirm(c) : { same: [...c.prompt.matchAll(/^Pair (\d+)$/gm)].map((m) => +m[1]) };
    if (!isRead(c)) return {};
    const most = Number(/at most (\d+)/.exec(c.prompt)![1]);
    if (o.cap && most > o.cap) throw Object.assign(new Error('cut off'), { code: 'cutoff' });
    const me = call++; start = Number(/from the one after point (\d+)/.exec(c.prompt)?.[1] ?? 0);
    const idx: number[] = []; for (let k = o.shift ? o.shift(start, me) : start; k < L.length && idx.length < most; k++) if (!o.drop?.(k, me)) idx.push(k);
    end = idx.length ? idx[idx.length - 1] + 1 : start;
    const pts = idx.map((k) => L[k]); if (!o.edit) return { points: pts, more: o.more ? o.more(idx, me) : (idx[idx.length - 1] ?? L.length) < L.length - 1 };
    // an edited page ends, in truth, at the last of the list's points it sends
    const sent = o.edit(pts, me) as { points?: P[] }; const last = Array.isArray(sent?.points) ? sent.points[sent.points.length - 1] : undefined;
    if (last) end = L.findIndex((p, k) => k >= start && p.n === last.n && p.text === last.text.trim()) + 1;
    return sent;
  };
}
const plain = (len: number, label = (k: number) => `${k + 1}.`) => Array.from({ length: len }, (_, k) => ({ n: label(k), text: `Point ${k + 1} raises clause ${k} of the agreement here.` }));
const ask = (s: ReturnType<typeof setup>) => s.ai.issuesList!({ dealId: 'd1', doc, findings: FINDINGS, workstreams: ['Legal', 'Financial'] });
const read = async (f: (c: Call) => unknown) => {
  const s = setup(f, { d1: rec }, { shared: new Mem(), installId: 'pc' }); const r = await ask(s);
  return { r, s, n: r.ok ? r.value.points.length : r.error.message, reads: s.calls.filter(isRead), checks: s.calls.filter(isCheck).length };
};

describe('reading an issues list', () => {
  it('reads 164 points in pages of 80, checks each page, compares them all with 126 findings in one call, and maps each repeat', async () => {
    // the reader sends the words with stray spaces and a line break, as a file's text often has them
    const { r, s, reads, checks } = await read(stand(LIST, { edit: (pts, call) => ({ points: pts.map((p) => ({ ...p, text: `  ${p.text}\n` })), more: call < 2 }) }));
    const out = val(r);
    expect(reads.length).toBe(3); expect(checks).toBe(3);                                  // 80, 80, and the last 4, each checked
    expect(s.calls.filter((c) => isRead(c) || isCheck(c)).every((c) => c.files.length === 1)).toBe(true);   // the list goes with every read and check, and with nothing else
    expect(s.calls.filter(isSort).length).toBe(1);
    expect(s.calls.filter(isSort)[0].files).toEqual([]);
    expect(out.points.length).toBe(164);
    expect(out.points[0]).toEqual({ n: '1', text: POINTS[0], title: 'Point 1 title', workstream: 'Legal', same: { finding: 'f0' } });
    expect(out.points[1].workstream).toBe('Financial'); expect(out.points[2].workstream).toBe('Legal');                                          // the workstream as the app names it, whatever the case
    expect(out.points.filter((p) => p.same && 'finding' in p.same).length).toBe(23);
    expect(out.points[60].same).toEqual({ point: 25 }); expect(out.points[141].same).toEqual({ point: 112 });
    expect(s.calls.filter(isSort)[0].prompt).toContain('F1: Finding 0 on the credit agreement: What finding 0 says.');   // citation markers left out
    // the last page is checked to the end of the list, the others up to their last point
    expect(s.calls.filter(isCheck)[2].prompt).toContain('these were read as its points after the point numbered "160", beginning "Clause 160.5 should be changed to the agreed", to the end of the list:\n1. numbered "161": "Clause 161.6 should');
    expect(s.calls.filter(isCheck)[0].prompt).toContain('from its first point, up to the point numbered "80"');
  });
  it('asks for fewer points when a page is cut off', async () => {
    const { n, reads } = await read(stand(LIST, { cap: 40 }));
    expect(n).toBe(164);
    expect(reads.map((c) => Number(/at most (\d+)/.exec(c.prompt)![1]))).toEqual([80, 40, 40, 40, 40, 40]);
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
  it('reads on while a page comes back full, whatever it says of more: a 164-point list is never read as 80', async () => {
    for (const said of [undefined, false, 'true', 'yes']) {
      const f = stand(LIST, { edit: (pts, call) => (said === undefined ? { points: pts } : { points: pts, more: call < 2 ? said : false }) });
      expect((await read(f)).n).toBe(164);
    }
  });
  it('fails, bringing in nothing, when the list cannot be read to its end, and reads on while it can', async () => {
    // the same point again and again: each page after the first fails its check, three times
    const same = await read(stand(LIST, { edit: () => ({ points: [LIST[0]], more: true }) }));
    expect(same.n).toBe(UNREAD); expect(same.reads.length).toBe(4); expect(same.s.calls.filter(isSort).length).toBe(0);
    // a model that gives one point a page still gets to the end of a long list: no number of pages is too many
    const slow = await read(stand(plain(300), { edit: (pts) => ({ points: pts.slice(0, 1), more: true }) }));
    expect(slow.n).toBe(300); expect(slow.reads.length).toBe(301);
    // empty pages while points are left
    expect((await read(stand(LIST, { edit: (pts, call) => ({ points: call ? [] : pts, more: true }) }))).n).toBe(UNREAD);
  });
  it('two points with the same words are both read, numbered or not', async () => {
    const sort = (c: Call) => ({ points: [...c.prompt.matchAll(/^P(\d+): /gm)].map((m) => ({ p: +m[1], title: 'A', workstream: 'Legal' })) });
    expect(val((await read(stand([{ n: '', text: 'Please confirm.' }, { n: '', text: 'Please confirm.' }], { sort }))).r).points.map((p) => p.n)).toEqual(['1', '2']);
    // two sections back to back that each hold one point saying the same thing, at a page's edge and inside one
    const L = [...plain(40), { n: '1.', text: 'Not agreed.' }, { n: '1.', text: 'Not agreed.' }, ...plain(30)];
    expect((await read(stand(L, { sort }))).n).toBe(72);
    expect((await read(stand(L, { sort, cap: 41 }))).n).toBe(72);
  });
  it('fails, importing nothing, when no point can be read', async () => {
    expect((await read(stand([]))).n).toBe('No points were found in it');
  });
  it('a page that skips points or starts again at the top is read again, and fails the read if it does so each time', async () => {
    for (const numbered of [true, false]) {
      const L = numbered ? LIST : LIST.map((p) => ({ ...p, n: '' }));
      expect((await read(stand(L, { shift: (f, c) => (c === 1 ? 0 : f) }))).n).toBe(164);
      expect((await read(stand(L, { shift: (f, c) => (c === 1 ? f + 10 : f) }))).n).toBe(164);
      for (const shift of [(f: number, c: number) => (c >= 1 ? 0 : f), (f: number, c: number) => (c >= 1 ? f + 10 : f)]) expect((await read(stand(L, { shift }))).n).toBe(UNREAD);
    }
  });
  it('asks for the next page by the last point read: its number and its opening words', async () => {
    const { reads } = await read(stand(LIST));
    expect(reads[1].prompt).toContain('from the one after point 80 (counting the first as 1). That last point is numbered "80" and begins "Clause 80.2 should be changed to the agreed", at most 80.');
  });
  it('points left out are caught whatever the numbering: "7.", "(7)", "2.10", "4.2(a)", "7a", letters, sections numbered afresh, or none', async () => {
    const labels = [(k: number) => `${k + 1}.`, (k: number) => `(${k + 1})`, (k: number) => `${Math.floor(k / 10) + 1}.${(k % 10) + 1}`, (k: number) => `4.${Math.floor(k / 26) + 1}(${String.fromCharCode(97 + (k % 26))})`,
      (k: number) => `${k + 1}a`, (k: number) => String.fromCharCode(65 + (k % 26)).repeat(Math.floor(k / 26) + 1), (k: number) => `${(k % 8) + 1}.`, () => ''];
    for (const label of labels) {
      const L = plain(300, label);
      expect((await read(stand(L))).n).toBe(300);
      expect((await read(stand(L, { drop: (k, c) => c === 0 && k >= 40 && k < 50 }))).n).toBe(300);          // left out once: read again
      expect((await read(stand(L, { drop: (k) => k >= 40 && k < 50 }))).n).toBe(UNREAD);                    // left out every time
      expect((await read(stand(L, { drop: (k) => k >= 77 && k < 80 }))).n).toBe(UNREAD);                    // just before a page's end
    }
    // a point with no number among numbered ones, just before points left out
    const L = plain(400).map((p, k) => (k === 199 ? { ...p, n: '' } : p));
    expect((await read(stand(L, { drop: (k) => k >= 200 && k < 210 }))).n).toBe(UNREAD);
  });
  it('the end is checked: a model that stops early reads on, and one that always stops fails', async () => {
    expect((await read(stand(plain(300), { drop: (k, c) => c === 3 && k >= 290, more: () => false }))).n).toBe(300);
    expect((await read(stand(plain(60), { drop: (k, c) => c === 0 && k >= 50, more: () => false }))).n).toBe(60);
    expect((await read(stand(plain(300), { drop: (k) => k >= 290, more: () => false }))).n).toBe(UNREAD);
    expect((await read(stand(plain(60), { drop: (k) => k >= 50, more: () => false }))).n).toBe(UNREAD);
  });
  it('a list\'s own gaps are kept, "none" is read as none, and a large list with structure reads whole', async () => {
    // a revised list that keeps its numbers: 100 gaps of its own cost nothing more than the pages
    const revised = await read(stand(plain(300).filter((_, k) => k % 3 !== 2)));
    expect(revised.n).toBe(200); expect(revised.reads.length).toBe(3); expect(revised.checks).toBe(3);
    // nothing missing, in each way a model may say it; no answer at all is not nothing
    const gappy = plain(300).filter((_, k) => k % 15 !== 7);
    for (const b of [[], 'none', ['none'], 'None', ['']]) expect((await read(stand(gappy, { check: (t) => (t.missing.length || t.extra.length ? t : { missing: b, extra: b }) }))).n).toBe(280);
    expect((await read(stand(gappy, { check: () => ({ missing: null }) }))).n).toBe(UNREAD);
    // 2,000 points in sections numbered afresh every 8, or numbered 1.1.1: one check a page
    for (const label of [(k: number) => `${(k % 8) + 1}.`, (k: number) => `${Math.floor(k / 100) + 1}.${Math.floor(k / 10) % 10 + 1}.${(k % 10) + 1}`]) {
      const big = await read(stand(plain(2000, label)));
      expect(big.n).toBe(2000); expect(big.reads.length).toBe(26); expect(big.checks).toBe(26);   // and the empty page after the last full one
    }
  });
  it('past a page read again, the pages are full size again', async () => {
    const once = await read(stand(plain(400), { drop: (k, c) => c === 0 && k >= 40 && k < 45 }));
    expect(once.n).toBe(400); expect(once.reads.map((c) => Number(/at most (\d+)/.exec(c.prompt)![1]))).toEqual([80, 40, 80, 80, 80, 80, 80]);
  });
  it('a point the model sends twice is read again, not kept twice; a stray "more" or an empty reply is asked again', async () => {
    const L = plain(200);
    expect((await read(stand(L, { edit: (p, c) => ({ points: c === 0 ? p.flatMap((x) => (x.n === '10.' ? [x, x] : [x])) : p, more: true }) }))).n).toBe(200);
    // the point a page was asked to start after, sent again at its head
    expect((await read(stand(L, { edit: (p, c) => ({ points: c === 1 ? [L[79], ...p] : p, more: true }) }))).n).toBe(200);
    // the last page says more follows: the empty page after it ends the list
    expect((await read(stand(L, { more: () => true }))).n).toBe(200);
    // every third reply can't be read
    expect((await read(stand(L, { edit: (p, c) => (c % 3 === 1 ? 'no list here' : { points: p, more: (p.length ? +p[p.length - 1].n.slice(0, -1) : 200) < 200 }) }))).n).toBe(200);
    // replies that never can
    expect((await read(stand(L, { edit: () => 'no list here' }))).n).toBe('It could not be read as an issues list');
  });
  it('a point whose words come back cut short, changed, or another point\'s words, fails its page check', async () => {
    // each point is two sentences; points 5 and 6 open with the same eight words
    const L = Array.from({ length: 120 }, (_, k) => ({ n: `${k + 1}.`, text: k === 5 ? 'The sponsor should confirm the position on the fee letter before signing.' : k === 4 ? 'The sponsor should confirm the position on the fee letter and the hedging.' : `Point ${k + 1} raises clause ${k} of the agreement. It should follow the term sheet on item ${k}.` }));
    const cut = (p: P[]) => p.map((x) => ({ ...x, text: x.text.replace(/\. .*$/, '.') }));
    expect((await read(stand(L, { edit: (p, c) => ({ points: c === 0 ? cut(p) : p, more: true }) }))).n).toBe(120);
    expect((await read(stand(L, { edit: (p) => ({ points: cut(p), more: true }) }))).n).toBe(UNREAD);
    const swap = (p: P[]) => p.map((x) => (x.n === '6.' ? { ...x, text: L[4].text } : x));
    expect((await read(stand(L, { edit: (p) => ({ points: swap(p), more: true }) }))).n).toBe(UNREAD);
    const { s } = await read(stand(L));
    // a figure changed mid-point
    const figure = L.map((x, k) => (k === 30 ? { ...x, text: 'The cap should be USD 5 million, not more, as agreed in the term sheet.' } : x));
    expect((await read(stand(figure, { edit: (p) => ({ points: p.map((x) => (x.n === '31.' ? { ...x, text: x.text.replace('USD 5 million, not more', 'USD 50 million, or more') } : x)), more: true }) }))).n).toBe(UNREAD);
    expect((await read(stand(figure))).n).toBe(120);
    // the check is shown each point's words in full
    expect(s.calls.filter(isCheck)[0].prompt).toContain('\n5. numbered "5.": "The sponsor should confirm the position on the fee letter and the hedging."\n');
  });
  it('a call that fails is asked again twice before the read fails', async () => {
    const failing = (when: (call: number) => boolean) => { let call = 0; const f = stand(plain(200)); return (c: Call) => { if ((isRead(c) || isCheck(c)) && when(call++)) throw new Error('The service timed out'); return f(c); }; };
    expect((await read(failing((c) => c === 3 || c === 4))).n).toBe(200);
    const always = await read(failing((c) => c >= 3));
    expect(always.r.ok).toBe(false); expect(always.reads.length + always.checks).toBe(6);       // two pages read and checked, then three tries
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
      expect(r.ok && r.value.points.every((p, k) => p.text === L[k].text && p.title === `Point ${k + 1} title`)).toBe(true);   // every point titled, in its own words
    }
  }, 120_000);
  it('a long list against 5,000 findings is compared with the findings a share at a time, each call within the budget', async () => {
    const L = Array.from({ length: 1200 }, (_, k) => ({ n: String(k + 1), text: `Point ${k + 1}: ${'The borrower shall deliver the executed direct agreement with the offtaker and the EPC contractor before financial close, in a form satisfactory to the lenders. '.repeat(4).trim()}` }));
    const F = Array.from({ length: 5000 }, (_, k) => ({ id: `f${k}`, title: `Finding ${k} on the credit agreement security package`, text: 'The security package does not include an equity pledge over the holding company and the account bank has not signed. '.repeat(3).trim() }));
    let biggest = 0, sent = 0; const base = stand(L);
    const s = setup((c: Call) => { const t = tokensOf(c.prompt); biggest = Math.max(biggest, t); sent += t; if (t > 180_000) throw tooLong('prompt is too long'); return base(c); }, { d1: rec }, { shared: new Mem(), installId: 'pc' });
    const r = await s.ai.issuesList!({ dealId: 'd1', doc, findings: F, workstreams: ['Legal', 'Financial'] });
    expect(r.ok ? r.value.points.length : r.error.message).toBe(1200);
    expect(r.ok && r.value.points.every((p, k) => p.text === L[k].text && p.title === `Point ${k + 1} title`)).toBe(true);
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
  it('a revised point joined to the finding its first version made is confirmed with both in full, since the comparison cuts a finding\'s text short', async () => {
    // a first list made these findings, each holding counsel's whole point; the revised list changes point 4 only after its 240th character
    const words = (k: number, end: string) => `Point ${k + 1}: ${'The borrower shall deliver the executed direct agreement with the offtaker and the EPC contractor before financial close, in a form satisfactory to the lenders. '.repeat(3)}${end}`;
    const F = Array.from({ length: 10 }, (_, k) => ({ id: `f${k}`, title: `Finding ${k}`, text: words(k, 'The lenders bear the cost.') }));
    const L = Array.from({ length: 20 }, (_, k) => ({ n: String(k + 1), text: k === 3 ? words(2, 'The borrower bears the cost.') : `Point ${k + 1} raises clause ${k} of the agreement here.` }));
    expect(F[2].text.slice(0, 240)).toBe(L[3].text.slice(0, 240));
    const sort = (c: Call) => { const shown = [...c.prompt.matchAll(/^P(\d+): /gm)].map((m) => +m[1]); return { points: shown.map((p) => ({ p, title: `T${p}`, workstream: 'Legal', same: p === 4 ? 'F3' : '' })) }; };
    for (const agree of [false, true]) {
      let asked = '';
      const confirm = (c: Call) => { asked += c.prompt; return { same: agree ? [1] : [] }; };
      const s = setup(stand(L, { sort, confirm }), { d1: rec }, { shared: new Mem(), installId: 'pc' });
      const r = await s.ai.issuesList!({ dealId: 'd1', doc, findings: F, workstreams: ['Legal', 'Financial'] });
      expect(s.calls.filter(isSort).length).toBe(1); expect(s.calls.filter(isConfirm).length).toBe(1);   // the fullest form, then the confirmation
      expect(asked).toContain(F[2].text); expect(asked).toContain(L[3].text);                         // both in full
      expect(r.ok && r.value.points[3].same).toEqual(agree ? { finding: 'f2' } : undefined);
    }
  });
});
