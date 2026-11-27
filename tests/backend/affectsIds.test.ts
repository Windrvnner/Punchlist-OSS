// @vitest-environment node
// When documents arrive, the fast model sees the new documents, the open findings and the settled checklist items by
// their permanent ids, never by per-prompt labels; a reply naming an id it was not shown is asked again (#1162).
import { describe, expect, it } from 'vitest';
import { tokensOf } from '../../src/backend/limits';
import type { DocRecord } from '../../src/backend/documents';
import { affectsShown, deal, doc, finding, itemsIn, Mem, OK, question, setup, val, type Call } from './reviewKit';

const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'margin'] });
const NOTICE = doc(2, 'Offtake notice.pdf', { summary: 'Notice terminating the offtake agreement.' });
const okAll = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });
const ITEMS = ['The offtake agreement is signed', 'The margin is agreed'].map((text, k) => ({ id: `i${k + 1}`, text }));
const checklist = () => ({ broad: ITEMS, product: [], sector: [] });
const marked = async (repo: any, id: string) => val<any>(await repo.get('finding', id)).envelope.data.updatedWhy;

/** a deal checked once, with one open finding, to which the notice then arrives; `affects` answers the fast model */
async function arrive(affects: (c: Call, n: number) => unknown, more: Parameters<typeof setup>[2] = {}) {
  const s = setup(okAll, { d1: [FA] }, { shared: new Mem(), installId: 'pc', checklist, affects,
    verify: () => ({ stands: false, why: 'The notice ends the offtake.' }), ...more });
  await deal(s.repo);
  val(await s.ai.firstPass('d1'));
  await finding(s.repo, 'f_1', 'Offtake may end early', { sources: [{ doc: FA.name, loc: 'p. 2', docId: FA.docId }] });
  s.recs.d1 = [...s.recs.d1, NOTICE];
  const n = s.calls.length;
  const pass = val(await s.ai.firstPass('d1'));
  return { s, pass, after: s.calls.slice(n) };
}

describe('the fast model names what new documents affect by permanent ids (#1162)', () => {
  it('lists each new document by its docId, each finding by its id and each settled item by its id', async () => {
    const { s } = await arrive(() => ({ affected: [] }));
    const prompt = s.affectCalls[0].prompt;
    const notice = 'vdr/Offtake notice.pdf — Notice terminating the offtake agreement.';
    expect(prompt).toContain(`\n${NOTICE.docId}: ${notice}\n`);
    expect(prompt).toContain('\nf_1: Offtake may end early\n');
    expect(prompt).toContain('\ni1: The offtake agreement is signed\ni2: The margin is agreed\n');
    expect(prompt).not.toMatch(/^[NFC]\d+: /m);
    expect(prompt).toContain('Reply as JSON: {"affected": ["<finding or item id> <document id>"]}');
  });

  it('maps a finding and the new document named beside it back by their ids', async () => {
    const { s, pass } = await arrive(() => ({ affected: [`f_1 ${NOTICE.docId}`] }));
    expect(s.affectCalls.length).toBe(1);
    expect(pass.marked).toEqual(['f_1']);
    expect(await marked(s.repo, 'f_1')).toBe('Offtake notice.pdf arrived');
  });

  it('maps a settled item named by its id back to that item, and looks at it again', async () => {
    const { after } = await arrive(() => ({ affected: [`i1 ${NOTICE.docId}`] }));
    expect(after.map((c) => itemsIn(c).map((it) => it.text))).toEqual([['The offtake agreement is signed']]);
  });

  it('asks again, with the same prompt, when a reply names a label or an id it was not shown', async () => {
    const replies = [['F1 N1'], [`f_1 ${NOTICE.docId}x`], [`f_1 ${NOTICE.docId}`]];
    const { s, pass } = await arrive((_c, n) => ({ affected: replies[n - 1] }));
    expect(s.affectCalls.length).toBe(3);
    expect(s.affectCalls[2].prompt).toBe(s.affectCalls[0].prompt);
    expect(pass.marked).toEqual(['f_1']);
  });

  it('takes nothing from replies that still name an unknown id when the tries run out', async () => {
    const { s, after } = await arrive(() => ({ affected: [`i2 ${NOTICE.docId}x`] }));
    expect(s.affectCalls.length).toBe(3);
    // the item it named is not looked at again: the run goes by shared words instead, as when the model cannot say
    expect(after.flatMap((c) => itemsIn(c).map((it) => it.text))).not.toContain('The margin is agreed');
  });
});

/** `n` new documents, each with a short summary */
const arrivals = (n: number) => Array.from({ length: n }, (_, k) => doc(1000 + k, `Arrival ${k}.pdf`,
  { summary: `Notice number ${k} on the offtake agreement` }));
type Scale = { limit?: number; out?: number; arrived?: DocRecord[]; findings?: number; items?: number;
  affects?: (c: Call, n: number) => unknown };
const findingId = (k: number) => `f_01HZX3K9Q4V7M2B5N8C1D6${String(k).padStart(4, '0')}`;

/** a deal with settled items and open findings, sent to a stand-in model whose input limit is `limit` */
async function dealScale(o: Scale = {}) {
  const items = Array.from({ length: o.items ?? 500 }, (_, k) => ({ id: `i_${String(k).padStart(24, '0')}`,
    text: `Point ${k + 1} of the finance documents is in order and agreed` }));
  const s = setup(okAll, { d1: [FA] }, { shared: new Mem(), installId: 'pc',
    checklist: () => ({ broad: items, product: [], sector: [] }), affects: o.affects ?? (() => ({ affected: [] })),
    verify: () => ({ stands: false, why: 'The notice ends the offtake.' }) });
  if (o.limit) s.svc.inputLimit = () => o.limit!;
  if (o.out) s.svc.outputLimit = () => o.out!;
  await deal(s.repo);
  val(await s.ai.firstPass('d1'));
  const ids = Array.from({ length: o.findings ?? 300 }, (_, k) => findingId(k));
  for (const [k, id] of ids.entries()) await finding(s.repo, id, `Finding ${k + 1} on the credit agreement terms`);
  s.recs.d1 = [...s.recs.d1, ...(o.arrived ?? [NOTICE])];
  const pass = val(await s.ai.firstPass('d1'));
  return { s, pass, items: items.map((it) => it.id), findings: ids };
}

describe('the affects prompt at deal scale (#1162)', () => {
  it('splits 300 findings and 500 items into parts whose prompts stay within the input limit', async () => {
    const LIMIT = 12_000;
    const { s, items, findings } = await dealScale({ limit: LIMIT });
    expect(s.affectCalls.length).toBeGreaterThan(1);
    for (const c of s.affectCalls) expect(tokensOf(c.prompt)).toBeLessThanOrEqual(LIMIT);
    const shown = s.affectCalls.map(affectsShown);
    expect(shown.flatMap((x) => x.findings).sort()).toEqual([...findings].sort());
    expect(shown.flatMap((x) => x.items).sort()).toEqual([...items].sort());
    expect(shown.every((x) => x.docs.join() === NOTICE.docId)).toBe(true);
  }, 60_000);

  it('puts every target against every one of 250 arrivals, with the arrivals counted in each part', async () => {
    const LIMIT = 6500;
    const arrived = arrivals(250);
    const { s, items, findings } = await dealScale({ limit: LIMIT, arrived, findings: 60, items: 100 });
    for (const c of s.affectCalls) expect(tokensOf(c.prompt)).toBeLessThanOrEqual(LIMIT);
    const seen = new Map<string, string[]>();
    for (const x of s.affectCalls.map(affectsShown)) {
      for (const d of x.docs) seen.set(d, [...(seen.get(d) ?? []), ...x.findings, ...x.items]);
    }
    expect([...seen.keys()].sort()).toEqual(arrived.map((r) => r.docId).sort());
    for (const targets of seen.values()) expect(targets.sort()).toEqual([...findings, ...items].sort());
  }, 120_000);

  it('sizes a part by the reply it may bring: each target named with an arrival, by the ids as written', async () => {
    const OUT = 600;
    const { s } = await dealScale({ out: OUT, findings: 30, items: 1 });
    const reply = tokensOf(`${findingId(0)} ${NOTICE.docId}`);
    const room = Math.floor((OUT * 0.6) / reply);
    expect(room).toBeLessThan(30);
    expect(s.affectCalls.length).toBeGreaterThan(1);
    for (const c of s.affectCalls) expect(affectsShown(c).findings.length).toBeLessThanOrEqual(room);
  }, 60_000);

  it('keeps what earlier parts named when a later part cannot be read', async () => {
    const affects = (c: Call, n: number) => {
      const shown = affectsShown(c);
      return { affected: [n === 1 ? `${shown.findings[0]} ${NOTICE.docId}` : `${shown.findings[0]}x ${NOTICE.docId}`] };
    };
    const { s, pass, findings } = await dealScale({ limit: 1500, findings: 60, items: 1, affects });
    expect(s.affectCalls.length).toBeGreaterThan(3);   // a second part, asked three times before it fails
    // the first part's answer stands: of its findings only the one it named is marked; the rest go by shared words
    const first = affectsShown(s.affectCalls[0]).findings;
    expect(pass.marked.filter((id) => first.includes(id))).toEqual([findings[0]]);
    expect(pass.marked.length).toBeGreaterThan(1);
  }, 60_000);

  it('keeps the whole entries of a reply cut off, and asks again for the rest', async () => {
    const affects = (c: Call, n: number) => {
      const [first, second] = affectsShown(c).findings;
      const entry = (id: string) => JSON.stringify(`${id} ${NOTICE.docId}`);
      return n === 1 ? `{"affected": [${entry(first)}, ${entry(second)}, "f_01HZ` : { affected: [] };
    };
    const { pass, findings } = await dealScale({ findings: 5, items: 1, affects });
    expect(pass.marked.sort()).toEqual([findings[0], findings[1]]);
  }, 60_000);
});

/** a deal with two open findings and one answered question tied to neither; `hears` answers the fast model */
async function heard(hears: (c: Call, n: number) => unknown) {
  const s = setup(() => ({}), { d1: [FA] }, { hears, verify: () => ({ stands: false, why: 'settled' }) });
  await deal(s.repo);
  const src = [{ doc: FA.name, loc: 'p. 14', docId: FA.docId }];
  await finding(s.repo, 'f_1', 'Lock-up differs', { sources: src });
  await finding(s.repo, 'f_2', 'Hedging not approved', { sources: src });
  await question(s.repo, 'q_12', 12, 'Which lock-up ratio was agreed?', 'The agreed ratio is 1.25x.');
  return { s, got: await s.ai.responses('d1') };
}

describe('the fast model names the findings a response affects by their ids (#1162)', () => {
  it('lists each open finding by its id and asks for pairs of ids', async () => {
    const { s } = await heard(() => ({ affected: [] }));
    expect(s.hearCalls[0].prompt).toContain('\nf_1: Lock-up differs\nf_2: Hedging not approved\n');
    expect(s.hearCalls[0].prompt).not.toMatch(/^F\d+: /m);
    expect(s.hearCalls[0].prompt).toContain('Reply as JSON: {"affected": ["<finding id> <question id>"]}');
  });

  it('maps a finding and its question back by their ids', async () => {
    const { s, got } = await heard(() => ({ affected: ['f_2 q_12'] }));
    expect(val(got)).toEqual({ heard: ['q_12'], marked: ['f_2'] });
    expect(s.hearCalls.length).toBe(1);
  });

  it('asks again, with the same prompt, when a reply names a label or an id it was not shown', async () => {
    const replies = [['F1 q_12'], ['f_9 q_12'], ['f_1 q_12']];
    const { s, got } = await heard((_c, n) => ({ affected: replies[n - 1] }));
    expect(s.hearCalls.length).toBe(3);
    expect(s.hearCalls[2].prompt).toBe(s.hearCalls[0].prompt);
    expect(val(got).marked).toEqual(['f_1']);
  });
});

describe('the affects prompt size at deal scale (#1162)', () => {
  it('counts the tokens the ids add over per-prompt labels', async () => {
    const { s, items, findings } = await dealScale({ out: 100_000 });
    expect(s.affectCalls.length).toBe(1);
    const prompt = s.affectCalls[0].prompt;
    const labelled = [...findings.map((id, k) => [id, `F${k + 1}`]), ...items.map((id, k) => [id, `C${k + 1}`]),
      [NOTICE.docId, 'N1']].reduce((text, [id, label]) => text.replace(`\n${id}: `, `\n${label}: `), prompt);
    // 300 findings and 500 items: about 15,500 tokens with labels, 21,650 with ids, well within one call's share
    expect([tokensOf(labelled), tokensOf(prompt)]).toEqual([15_502, 21_649]);
  }, 60_000);
});
