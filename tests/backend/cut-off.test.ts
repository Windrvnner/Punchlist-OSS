// @vitest-environment node
// Replies cut off at the service's output limit, and requests refused as too long (decisions: Cut-off output).
// A deployment may cut a reply off at a limit the app cannot know, with or without saying so: the stand-in
// here cuts every reply longer than `cap` characters, either flagged as a connector flags it (`code: 'cutoff'`, with the
// text before the cut) or silently (the text before the cut, as if whole). Nothing cut short is shown or written, what came
// back whole is kept, and the rest is asked again in smaller parts. Tested at deal scale.
import { SERVICE } from '../../src/control';
import { describe, it, expect } from 'vitest';
import { setup, doc, deal, finding, itemsIn, OK, Mem, val, type Call, nth } from './reviewKit';
import { cutOff, tooLong, TOO_LONG_REPLY } from '../../src/backend/limits';

const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'borrower', 'lender', 'margin'] });
const TS = doc(2, 'Term sheet.pdf', { pages: 12, words: ['term', 'sheet', 'margin', 'facility'] });
const room = () => ({ d1: [FA, TS] });
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, text: `Checklist point ${i + 1} about the credit agreement` }));
type Mode = 'flagged' | 'silent';
/** every reply to a call `which` picks that is longer than `cap` characters comes back cut at `cap` */
function capped(s: ReturnType<typeof setup>, cap: number, mode: Mode, which: (prompt: string) => boolean = () => true) {
  const orig = s.svc.complete.bind(s.svc); const cut = { n: 0 };
  s.svc.complete = async (input) => {
    const r = await orig(input); if (!which(input.prompt) || r.length <= cap) return r;
    cut.n++; if (mode === 'flagged') throw cutOff('cut off', r.slice(0, cap)); return r.slice(0, cap);
  };
  return cut;
}
const LONG = 'The credit agreement sets the margin at 2.25% while the term sheet sets it at 2.00%, and nothing reconciles the two. [1] [2]';
const isCheck = (p: string) => p.includes('Check each of these checklist items');

describe.each(['flagged', 'silent'] as Mode[])('a reply cut off at the length limit (%s)', (mode) => {
  it('the check keeps what came back whole and asks about the rest in smaller parts: all 240 items settle, findings whole', async () => {
    const shared = new Mem();
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (/point \d*7 /.test(it.text) ? { id: it.tag, result: 'finding', title: `Margin differs (${it.text})`, workstream: 'Legal', body: [LONG], next: 'Ask which applies.', sources: [{ doc: nth(c, 1), page: 3 }, { doc: nth(c, 1), page: 7 }] } : { id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(240), product: [], sector: [] }) });
    await deal(s.repo); const cut = capped(s, 1500, mode, isCheck);       // about six items' replies fit
    const r = val(await s.ai.firstPass('d1')); const p = val(await s.ai.progress('d1'));
    expect(cut.n).toBeGreaterThan(0); expect(r.unsettled).toEqual([]);
    expect(p.checklist).toEqual({ items: 240, satisfied: 216, findings: 24, gaps: 0, unsettled: 0 });
    const fs = await s.repo.list('finding', 'd1'); const bodies = fs.ok ? fs.value.map((l) => (l.envelope.data as { body: string[] }).body) : [];
    expect(bodies.length).toBe(24); for (const b of bodies) expect(b).toEqual([LONG]);                  // never a body cut short
    expect(s.calls.filter((c) => isCheck(c.prompt)).length).toBeLessThan(240 / 2);   // parts shrink once and stay small: not one call per item
  });

  it('an item whose reply is cut off even alone is left unsettled, saying so, and nothing is guessed for it', async () => {
    const shared = new Mem();
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (/point 3 /.test(it.text) ? { id: it.tag, result: 'finding', title: 'Margin differs', workstream: 'Legal', body: [LONG.repeat(30)], next: 'Ask.', sources: [{ doc: nth(c, 1), page: 3 }, { doc: nth(c, 1), page: 7 }] } : { id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(25), product: [], sector: [] }) });
    await deal(s.repo); capped(s, 1500, mode, isCheck);
    const r = val(await s.ai.firstPass('d1')); const rows = val(await s.ai.checklist!('d1'));
    expect(r.unsettled).toEqual(['c3']);
    const cut = 'The AI’s reply on it was cut off at the length limit.';
    expect(rows.find((x) => x.id === 'c3')).toMatchObject({ result: 'unsettled', why: cut });
    expect(rows.filter((x) => x.result === 'satisfied').length).toBe(24); expect(val(await s.repo.list('finding', 'd1'))).toEqual([]);
  });

  it('a whole item before the cut that cites a document it was not given is asked again, not kept without it (#1162)',
    async () => {
      const unsent = `doc_${'f'.repeat(24)}`;
      const long = (c: Call, tag: string) => ({
        id: tag, result: 'finding', title: 'Margin differs', workstream: 'Legal', body: [LONG.repeat(30)], next: 'Ask.',
        sources: [{ doc: nth(c, 1), page: 3 }],
      });
      const reply = (c: Call) => ({
        items: itemsIn(c).map((it) => (/point 1 /.test(it.text)
          ? { id: it.tag, result: 'ok', where: [{ doc: unsent, page: 1, quote: 'As the item requires.' }] }
          : /point 3 /.test(it.text) ? long(c, it.tag) : { id: it.tag, ...OK(c) })),
      });
      const s = setup(reply, room(), { checklist: () => ({ broad: items(5), product: [], sector: [] }) });
      await deal(s.repo);
      capped(s, 1500, mode, isCheck);
      const r = val(await s.ai.firstPass('d1'));
      // never settled on a citation dropped from it: no reply was kept without it, to be asked again for a place
      expect(s.calls.some((c) => c.prompt.includes('As "ok" it needs "where"'))).toBe(false);
      expect(r.unsettled).toContain('c1');
    });

  it('one item cut off even alone does not leave the rest of the check asked one item per call', async () => {
    const shared = new Mem();
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (/point 3 /.test(it.text) ? { id: it.tag, result: 'finding', title: 'Margin differs', workstream: 'Legal', body: [LONG.repeat(300)], next: 'Ask.', sources: [{ doc: nth(c, 1), page: 3 }, { doc: nth(c, 1), page: 7 }] } : { id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(400), product: [], sector: [] }) });
    await deal(s.repo); capped(s, 20000, mode, isCheck);                // 20 items' replies fit; item 3's alone does not
    const r = val(await s.ai.firstPass('d1'));
    expect(r.unsettled).toEqual(['c3']);
    const checks = s.calls.filter((c) => isCheck(c.prompt)); expect(checks.length).toBeLessThan(26);   // 20 parts, and a few for the long item; was 404
    expect(itemsIn(checks[checks.length - 1]).length).toBeGreaterThan(1);
  });

  it('three long items in a row stop asking only for the moment: the items after them are asked again, never marked cut off', async () => {
    const shared = new Mem();
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (/point [345] /.test(it.text) ? { id: it.tag, result: 'finding', title: 'Margin differs', workstream: 'Legal', body: [LONG.repeat(300)], next: 'Ask.', sources: [{ doc: nth(c, 1), page: 3 }, { doc: nth(c, 1), page: 7 }] } : { id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(200), product: [], sector: [] }) });
    await deal(s.repo); capped(s, 20000, mode, isCheck);
    const r = val(await s.ai.firstPass('d1'));
    expect(r.unsettled).toEqual(['c3', 'c4', 'c5']);
    expect(val(await s.ai.progress('d1')).checklist).toMatchObject({ items: 200, satisfied: 197, unsettled: 3 });
  });

  it('when nothing fits in a reply, each look at a handful costs one probe: 2,000 items take about 300 calls, none called a gap', async () => {
    const shared = new Mem();
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(2000), product: [], sector: [] }) });
    await deal(s.repo); capped(s, 50, mode, isCheck);
    val(await s.ai.firstPass('d1')); const p = val(await s.ai.progress('d1'));
    expect(p.checklist).toMatchObject({ items: 2000, gaps: 0, unsettled: 2000 });
    const n = s.calls.filter((c) => isCheck(c.prompt)).length; expect(n).toBeLessThan(400);   // 310; was 1,800 before the probe
  });

  it('a model whose replies were all cut for a while is asked again once the service recovers', async () => {
    const shared = new Mem();
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(2000), product: [], sector: [] }) });
    await deal(s.repo);
    const orig = s.svc.complete.bind(s.svc); let n = 0;
    s.svc.complete = async (input) => { const r = await orig(input); if (!isCheck(input.prompt)) return r; n++; if (n < 30 || n > 60) return r; if (mode === 'flagged') throw cutOff('cut off', r.slice(0, 50)); return r.slice(0, 50); };
    val(await s.ai.firstPass('d1')); const p = val(await s.ai.progress('d1'));
    expect(n).toBeGreaterThan(60); expect(p.checklist.gaps).toBe(0); expect(p.checklist.satisfied).toBeGreaterThanOrEqual(1850);   // 1,958: the rest were asked while every reply was cut, and say so
  });

  it.each([['18|19|20|22'], ['18|19|20|21|22|23'], ['18|19|20|21|22|24|25']])('long items %s: a long item early in the handful after a pause does not send the handful to the thorough model', async (which) => {
    const shared = new Mem(); const long = new RegExp(`point (${which}) `);
    // the thorough model's replies cannot be read: an ordinary item sent to it would end not settled
    const s = setup((c: Call) => (c.model === 'thorough' ? 'not JSON' : { items: itemsIn(c).map((it) => (long.test(it.text) ? { id: it.tag, result: 'finding', title: 'Margin differs', workstream: 'Legal', body: [LONG.repeat(300)], next: 'Ask.', sources: [{ doc: nth(c, 1), page: 3 }, { doc: nth(c, 1), page: 7 }] } : { id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(400), product: [], sector: [] }) });
    await deal(s.repo); capped(s, 20000, mode, isCheck);
    const r = val(await s.ai.firstPass('d1'));
    expect([...r.unsettled].sort()).toEqual(which.split('|').map((n) => `c${n}`).sort());
  });

  it.each([6, 8])('%i long items in a row leave only themselves not settled, not the ordinary items after them', async (run) => {
    const shared = new Mem(); const long = new Set(Array.from({ length: run }, (_, k) => `c${101 + k}`));
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (long.has(/point (\d+) /.exec(it.text) ? `c${/point (\d+) /.exec(it.text)![1]}` : '') ? { id: it.tag, result: 'finding', title: 'Margin differs', workstream: 'Legal', body: [LONG.repeat(300)], next: 'Ask.', sources: [{ doc: nth(c, 1), page: 3 }, { doc: nth(c, 1), page: 7 }] } : { id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(400), product: [], sector: [] }) });
    await deal(s.repo); capped(s, 20000, mode, isCheck);
    const r = val(await s.ai.firstPass('d1'));
    expect([...r.unsettled].sort()).toEqual([...long].sort());
  });

  it('rewording 2,400 items on import finds every suggestion, asking again only after the last whole one', async () => {
    const s = setup((c: Call) => { if (!c.prompt.includes('Propose new wording')) return {}; const lines = c.prompt.split('\n').filter((l) => /^\d+: /.test(l)).map((l) => +/Item (\d+)/.exec(l)![1]);   // every fourth item of the list is unclear, wherever it falls in a part
      return { items: lines.flatMap((g, k) => (g % 4 === 1 ? [{ n: k + 1, text: `Reworded point ${g}, which must be signed and in force`, why: 'unclear' }] : [])) }; }, {}, { shared: new Mem(), installId: 'pc' });
    const cut = capped(s, 2000, mode, (p) => p.includes('Propose new wording'));
    const out = val(await s.ai.reword!({ items: Array.from({ length: 2400 }, (_, i) => `Item ${i + 1} is in place`) }));
    expect(cut.n).toBeGreaterThan(0); expect(out.length).toBe(600); expect(out.every((x) => /in force$/.test(x.text))).toBe(true);
    expect(out.map((x) => x.at)).toEqual(Array.from({ length: 600 }, (_, k) => k * 4));
  });

  it('the duplicate check keeps the pairs that came whole and halves the rest: every pair is found, none listed as missed', async () => {
    const s = setup((c: Call) => { if (!c.prompt.includes('ask for exactly the same thing')) return {}; const m = Number(/Items 1 to (\d+)/.exec(c.prompt)![1]); const shown = c.prompt.split('\n').filter((l) => /^\d+: /.test(l)).map((l) => +/Item (\d+)/.exec(l)![1]); const at = new Map(shown.map((g, k) => [g, k + 1]));
      return { pairs: shown.slice(0, m).filter((g) => g <= 40).map((g) => ({ a: at.get(g)!, b: at.get(g + 100)!, why: 'both ask for the same signed agreement' })).filter((p) => p.b) }; }, {}, { shared: new Mem(), installId: 'pc' });
    const cut = capped(s, 2000, mode, (p) => p.includes('ask for exactly the same thing'));   // about 30 pairs fit
    const r = val(await s.ai.sameMeaning!({ items: Array.from({ length: 200 }, (_, i) => `Item ${i + 1} is in place`), against: [] }));
    expect(cut.n).toBeGreaterThan(0); expect(r.pairs.length).toBe(40); expect(r.missed).toBeUndefined();
  });

  it('a chat answer cut off is asked for once more, shorter; cut off again, it fails saying the reply was too long, and no cut text is shown', async () => {
    const short = 'The credit agreement sets 2.25%; the term sheet 2.00%. [1] [2]';
    const s = setup((c: Call) => ({ text: c.prompt.includes('about half as long') ? short : `${LONG} ${LONG} ${LONG}`, sources: [{ doc: nth(c, 1), page: 3 }, { doc: nth(c, 2), page: 1 }] }), room(), { library: [] });
    await deal(s.repo); capped(s, 300, mode, (p) => !p.includes('It cannot be read as written'));
    const a = val(await s.ai.answer({ dealId: 'd1', message: 'What margin applies under the credit agreement?', history: [], model: 'standard' }));
    expect((a as { text: string }).text).toContain('2.25%; the term sheet 2.00%');
    const t = setup((c: Call) => ({ text: `${LONG} ${LONG} ${LONG}`, sources: [{ doc: nth(c, 1), page: 3 }] }), room(), { library: [] });
    await deal(t.repo); capped(t, 300, mode);
    const b = await t.ai.answer({ dealId: 'd1', message: 'What margin applies under the credit agreement?', history: [], model: 'standard' });
    expect(!b.ok && b.error).toEqual({ kind: 'failed', message: TOO_LONG_REPLY });
  });

  it('a draft cut off is asked for once more, shorter, and never comes back as "the documents do not answer it"', async () => {
    const isDraft = (p: string) => p.includes('Draft a response to this question');
    const s = setup((c: Call) => (isDraft(c.prompt) ? { status: 'found', text: c.prompt.includes('about half as long') ? 'The margin is 2.25%. [1]' : `${LONG} ${LONG}`, sources: [{ doc: nth(c, 1), page: 3 }], reused: [] } : {}), room(), { library: [] });
    await deal(s.repo); capped(s, 200, mode, isDraft);
    const r = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: 'Which margin applies under the credit agreement and the term sheet?' }));
    expect(r).toMatchObject({ status: 'found', text: 'The margin is 2.25%. [1]' });
  });
});

describe('limits the service sets', () => {
  it('the check sizes its parts to the output limit the service reports', async () => {
    const shared = new Mem();
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), room(), { shared, installId: 'pc', checklist: () => ({ broad: items(40), product: [], sector: [] }) });
    await deal(s.repo); s.svc.outputLimit = () => 4000;                  // 60% of 4,000 tokens at 250 a settled item: 9 a call
    val(await s.ai.firstPass('d1'));
    expect(s.calls.filter((c) => isCheck(c.prompt)).map((c) => itemsIn(c).length)).toEqual([9, 9, 2, 9, 9, 2]);
  });

  it('rewording sizes its parts to the input limit the service reports as well', async () => {
    const s = setup((c: Call) => (c.prompt.includes('Propose new wording') ? { items: [] } : {}), {}, { shared: new Mem(), installId: 'pc' });
    s.svc.inputLimit = () => 4000;                                         // 60% of 4,000 tokens at about 12 an item: 200 would fit, so the cap of 120 holds
    val(await s.ai.reword!({ items: Array.from({ length: 240 }, (_, i) => `Item ${i + 1} is in place`) }));
    expect(s.calls.length).toBe(2);
    const t = setup((c: Call) => (c.prompt.includes('Propose new wording') ? { items: [] } : {}), {}, { shared: new Mem(), installId: 'pc' });
    t.svc.inputLimit = () => 4000;                                         // long items, about 104 tokens each: 23 a call
    val(await t.ai.reword!({ items: Array.from({ length: 240 }, (_, i) => `Item ${i + 1}: ${'the executed agreement is in place and in force '.repeat(6)}`) }));
    expect(t.calls.map((c) => c.prompt.split('\n').filter((l) => /^\d+: /.test(l)).length).slice(0, 2)).toEqual([23, 23]);
  });

  it('a request refused as too long is asked again with the likeliest half of the documents', async () => {
    const s = setup((c: Call) => ({ text: 'The margin is 2.25%. [1]', sources: [{ doc: nth(c, 1), page: 3 }] }), room(), { library: [] });
    await deal(s.repo); const orig = s.svc.complete.bind(s.svc);
    s.svc.complete = async (input) => { if ((input.files?.length ?? 0) > 1) throw tooLong('too long', 400); return orig(input); };
    const a = val(await s.ai.answer({ dealId: 'd1', message: 'What margin applies under the credit agreement and the term sheet?', history: [], model: 'standard' }));
    expect((a as { text: string }).text).toContain('2.25%');
    const asked = s.calls.filter((c) => c.prompt.startsWith('Documents:')).map((c) => c.files.length); expect(asked.at(-1)).toBe(1);
  });

  it('a memo rates 150 open findings whatever the output limit, keeping each rating that came back whole', async () => {
    const s = setup(() => ({}), {}, {}); await deal(s.repo);
    for (let k = 0; k < 150; k++) await finding(s.repo, `f_${k}`, `Point ${k} differs`);
    s.svc.script = (c) => (c.prompt.startsWith('Rate each of these open findings') ? JSON.stringify({ ratings: [...c.prompt.matchAll(/^(f_\w+) \(/gm)].map((m) => ({ id: m[1], rating: 'Medium' })) }) : JSON.stringify({ paragraphs: ['A project.'] }));
    const cut = capped(s, 400, 'flagged', (p) => p.startsWith('Rate each'));
    const m = val(await s.ai.memo!('d1'));
    expect(cut.n).toBeGreaterThan(0); expect(Object.keys(m.ratings).length).toBe(150);
  });
});

describe('faults found in the first build', () => {
  it('a whole reply with a stray quote (36" for inches) is read as whole, not as cut off', async () => {
    const isDraft = (p: string) => p.includes('Draft a response to this question');
    const s = setup((c: Call) => (isDraft(c.prompt) ? `{"status": "found", "text": "The pipeline is 36" in diameter. [1]", "sources": [{"doc": "${nth(c, 1)}", "page": 3}], "reused": []}` : {}), room(), { library: [] });
    await deal(s.repo);
    const r = val(await s.ai.draft({ dealId: 'd1', questionId: 'q_new', questionText: 'What is the diameter of the pipeline under the credit agreement?' }));
    expect(r).toMatchObject({ status: 'found' }); expect(s.calls.filter((c) => isDraft(c.prompt)).length).toBe(1);
  });

  it('a check whose requests are refused as too long sends fewer documents first, carries that on, and stays within a few calls a group', async () => {
    const shared = new Mem(); const many = Array.from({ length: 8 }, (_, k) => doc(10 + k, `Credit agreement part ${k + 1}.pdf`, { words: ['facility', 'agreement', 'margin'] }));
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), { d1: many }, { shared, installId: 'pc', checklist: () => ({ broad: items(60), product: [], sector: [] }) });
    await deal(s.repo); const orig = s.svc.complete.bind(s.svc); let refused = 0;
    s.svc.complete = async (input) => { if (isCheck(input.prompt) && (input.files?.length ?? 0) > 2) { refused++; throw tooLong('too long', 400); } return orig(input); };
    const r = val(await s.ai.firstPass('d1'));
    expect(r.unsettled).toEqual([]); expect(refused).toBeLessThanOrEqual(3);                     // 8 → 4 → 2 documents, once for the whole run
    // one document too long even alone: each group is given up after a call or two, never asked item by item
    const t = setup((c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), { d1: many }, { shared: new Mem(), installId: 'pc', checklist: () => ({ broad: items(60), product: [], sector: [] }) });
    await deal(t.repo); const tOrig = t.svc.complete.bind(t.svc); let tRefused = 0;
    t.svc.complete = async (input) => { if (isCheck(input.prompt)) { tRefused++; throw tooLong('too long', 400); } return tOrig(input); };
    const u = val(await t.ai.firstPass('d1'));
    expect(u.unsettled.length).toBe(60); expect(tRefused).toBeLessThanOrEqual(8 * 4);       // each document is refused alone once per model at most, then left out
    expect(val(await t.ai.checklist!('d1'))[0]).toMatchObject({ result: 'unsettled', why: `A document it was to be checked against was too long to send to ${SERVICE}.` });
  });

  it('a check that had to send fewer documents asks the items still open against the ones left out: no item is called a gap on documents it was not shown', async () => {
    const own = [1, 2, 3, 4].flatMap((k) => [doc(100 + 2 * k, `Zeta${k} permit a.pdf`, { words: [`zeta${k}`] }), doc(101 + 2 * k, `Zeta${k} permit b.pdf`, { words: [`zeta${k}`] })]);
    const general = Array.from({ length: 8 }, (_, k) => doc(10 + k, `Credit agreement part ${k + 1}.pdf`, { words: ['facility', 'agreement', 'margin'] }));
    const docsIn = (c: Call) => c.files.map((f) => f.name);
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => { const k = +/point (\d+)/.exec(it.text)![1]; return docsIn(c).some((d) => d.includes(`Zeta${k} `)) ? { id: it.tag, ...OK(c) } : { id: it.tag, result: 'more', need: `zeta${k} permit` }; }) }),
      { d1: [...general, ...own] }, { shared: new Mem(), installId: 'pc', checklist: () => ({ broad: items(4), product: [], sector: [] }), library: [] });
    await deal(s.repo); const orig = s.svc.complete.bind(s.svc);
    s.svc.complete = async (input) => { if (isCheck(input.prompt) && (input.files?.length ?? 0) > 4) throw tooLong('too long', 400); return orig(input); };
    const r = val(await s.ai.firstPass('d1')); const rows = val(await s.ai.checklist!('d1'));
    expect(r.unsettled).toEqual([]); expect(rows.map((x) => x.result)).toEqual(['satisfied', 'satisfied', 'satisfied', 'satisfied']);
  });

  it('one document too long on its own is left out, and the rest of the run goes on at full size with the others', async () => {
    const big = doc(9, 'Credit agreement turbine annex.pdf', { words: ['facility', 'agreement', 'margin', 'turbine'] });
    const others = Array.from({ length: 7 }, (_, k) => doc(10 + k, `Credit agreement part ${k + 1}.pdf`, { words: ['facility', 'agreement', 'margin'] }));
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), { d1: [big, ...others] }, { shared: new Mem(), installId: 'pc', checklist: () => ({ broad: items(200), product: [], sector: [] }) });
    await deal(s.repo); const orig = s.svc.complete.bind(s.svc); let refused = 0;
    s.svc.complete = async (input) => { if (isCheck(input.prompt) && (input.files ?? []).some((id) => /turbine/.test(s.svc.files.get(id)?.name ?? ''))) { refused++; throw tooLong('too long', 400); } return orig(input); };
    const r = val(await s.ai.firstPass('d1')); const answered = s.calls.filter((c) => isCheck(c.prompt));
    expect(r.unsettled).toEqual([]); expect(refused).toBeLessThanOrEqual(4);                     // 8 → 4 → 2 → 1 documents: the long one, found once
    expect(answered.length).toBeLessThanOrEqual(200 / 20 * 3); expect(Math.max(...answered.map((c) => itemsIn(c).length))).toBe(20);
  });

  it('a reply cut after a closing bracket inside its text is still cut off, and a chat repair that is cut is never shown', async () => {
    const cutText = '{"text": "Under clause 4.2] of the draft the borrower must raise it where the borrower';
    const s = setup(() => cutText, room(), { library: [], fix: () => cutText });
    await deal(s.repo);
    const a = await s.ai.answer({ dealId: 'd1', message: 'What margin applies under the credit agreement?', history: [], model: 'standard' });
    expect(!a.ok && a.error.message).toBe(TOO_LONG_REPLY);
  });

  it('an answer whose likeliest document is too long on its own is given from the others', async () => {
    const s = setup((c: Call) => ({ text: 'The margin is as stated. [1]', sources: [{ doc: nth(c, 2), page: 1 }] }), { d1: [FA, TS, doc(3, 'Facility side letter.pdf', { words: ['facility', 'agreement', 'margin', 'lender'] })] }, { library: [] });
    await deal(s.repo); const orig = s.svc.complete.bind(s.svc); let first = ''; let refused = 0;      // whichever document is ranked first is the long one
    s.svc.complete = async (input) => { if (input.prompt.startsWith('Documents:')) { first ||= input.files![0]; if (input.files!.includes(first)) { refused++; throw tooLong('too long', 400); } } return orig(input); };
    const a = val(await s.ai.answer({ dealId: 'd1', message: 'What margin applies under the credit agreement and the term sheet?', history: [], model: 'standard' })) as { text: string; sources: { doc: string }[] };
    expect(refused).toBe(3);                                                                       // three documents, two, then the long one alone
    expect(a.text).toContain('as stated'); expect(a.sources.length).toBe(1);
    expect(s.calls.filter((c) => c.prompt.startsWith('Documents:')).at(-1)!.files.length).toBe(2);   // the two that fit, sent together once the long one was found
  });

  it('a kept chat conversation refused as too long carries on in a new one, compacted, and answers', async () => {
    const s = setup((c: Call) => ({ text: 'The margin is 2.25%. [1]', sources: [{ doc: nth(c, 1), page: 3 }] }), room(), { library: [] });
    await deal(s.repo);
    const first = val(await s.ai.answer({ dealId: 'd1', message: 'What margin applies under the credit agreement?', history: [], model: 'standard' })) as { thread?: import('../../src/ports').ModelThread };
    expect(first.thread?.id).toBeTruthy();
    const orig = s.svc.converse.bind(s.svc); let refused = 0;
    s.svc.converse = async (input) => { if (input.conversation) { refused++; throw tooLong('too long', 400); } return orig(input); };
    const second = await s.ai.answer({ dealId: 'd1', message: 'And under the term sheet?', history: [{ role: 'me', text: 'What margin applies under the credit agreement?' }, { role: 'ai', text: 'The margin is 2.25%. [1]' }], model: 'standard', thread: first.thread });
    expect(second.ok).toBe(true); expect(refused).toBe(1);
  });
});

describe('faults found later', () => {
  const parts = () => Array.from({ length: 8 }, (_, k) => doc(10 + k, `Credit agreement part ${k + 1}.pdf`, { words: ['facility', 'agreement', 'margin'] }));
  const names = (s: ReturnType<typeof setup>, files?: string[]) => (files ?? []).map((id) => s.svc.files.get(id)?.name ?? '');

  it.each(['fails', 'cannot be read'])('an item open after the first handful is never called a gap when the next handful %s: it stays not settled', async (how) => {
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (c.files.some((f) => /part [5-8]/.test(f.name)) ? { id: it.tag, ...OK(c) } : { id: it.tag, result: 'more', need: 'credit agreement part' })) }), { d1: parts() }, { shared: new Mem(), installId: 'pc', checklist: () => ({ broad: items(4), product: [], sector: [] }) });
    await deal(s.repo); const orig = s.svc.complete.bind(s.svc);
    s.svc.complete = async (input) => {
      if (isCheck(input.prompt)) { const n = names(s, input.files); if (n.length > 4) throw tooLong('too long', 400); if (n.some((x) => /part [5-8]/.test(x))) { if (how === 'fails') throw Object.assign(new Error('server error'), { status: 500 }); return 'Sorry, I could not do that.'; } }
      return orig(input);
    };
    const r = val(await s.ai.firstPass('d1'));
    expect(r.gaps).toEqual([]); expect(r.unsettled).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  it('once the overlong document is found, later calls go back to a full handful, and items open meanwhile are asked against the others together', async () => {
    const docs = [doc(9, 'Credit agreement turbine annex.pdf', { words: ['facility', 'agreement', 'margin', 'turbine'] }), ...parts().slice(0, 7)];
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (c.files.some((f) => /part 6/.test(f.name)) && c.files.some((f) => /part 7/.test(f.name)) ? { id: it.tag, ...OK(c) } : { id: it.tag, result: 'more', need: 'credit agreement parts' })) }), { d1: docs }, { shared: new Mem(), installId: 'pc', checklist: () => ({ broad: items(40), product: [], sector: [] }) });
    await deal(s.repo); const orig = s.svc.complete.bind(s.svc); let refused = 0;
    s.svc.complete = async (input) => { if (isCheck(input.prompt) && names(s, input.files).some((x) => /turbine/.test(x))) { refused++; throw tooLong('too long', 400); } return orig(input); };
    const r = val(await s.ai.firstPass('d1'));
    expect(r.unsettled).toEqual([]); expect(r.gaps).toEqual([]); expect(refused).toBeLessThanOrEqual(4);
    expect(s.calls.filter((c) => isCheck(c.prompt)).at(-1)!.files.length).toBe(7);
  });

  it('a document too long for the fast model alone is still read by the standard model', async () => {
    const big = doc(9, 'Credit agreement annex.pdf', { words: ['facility', 'agreement', 'margin'] });
    const s = setup((c: Call) => ({ items: itemsIn(c).map((it) => (c.files.some((f) => /annex/.test(f.name)) ? { id: it.tag, ...OK(c) } : { id: it.tag, result: 'more', need: 'the annex' })) }), { d1: [big, TS] }, { shared: new Mem(), installId: 'pc', checklist: () => ({ broad: items(6), product: [], sector: [] }) });
    await deal(s.repo); val(await s.ai.firstPass('d1')); const orig = s.svc.complete.bind(s.svc);
    s.svc.complete = async (input) => { if (isCheck(input.prompt) && input.model === 'fast' && names(s, input.files).some((x) => /annex/.test(x))) throw tooLong('too long', 400); return orig(input); };
    val(await s.ai.checkAll({ dealId: 'd1' }));
    expect(val(await s.ai.checklist!('d1')).map((x) => x.result)).toEqual(Array(6).fill('satisfied'));
  });
});
