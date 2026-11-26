// @vitest-environment node
// When documents arrive, the fast model sees the new documents, the open findings and the settled checklist items by
// their permanent ids, never by per-prompt labels; a reply naming an id it was not shown is asked again (#1162).
import { describe, expect, it } from 'vitest';
import { tokensOf } from '../../src/backend/limits';
import { affectsShown, deal, doc, finding, itemsIn, Mem, OK, setup, val, type Call } from './reviewKit';

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
    expect(prompt).toContain(`\n${NOTICE.docId}: vdr/Offtake notice.pdf — Notice terminating the offtake agreement.\n`);
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
});

/** a deal with 500 settled items and 300 open findings, sent to a stand-in model whose input limit is `limit` */
async function dealScale(limit?: number) {
  const items = Array.from({ length: 500 }, (_, k) => ({ id: `i_${String(k).padStart(24, '0')}`,
    text: `Point ${k + 1} of the finance documents is in order and agreed` }));
  const s = setup(okAll, { d1: [FA] }, { shared: new Mem(), installId: 'pc',
    checklist: () => ({ broad: items, product: [], sector: [] }), affects: () => ({ affected: [] }) });
  if (limit) s.svc.inputLimit = () => limit;
  await deal(s.repo);
  val(await s.ai.firstPass('d1'));
  const ids = Array.from({ length: 300 }, (_, k) => `f_01HZX3K9Q4V7M2B5N8C1D6${String(k).padStart(4, '0')}`);
  for (const [k, id] of ids.entries()) await finding(s.repo, id, `Finding ${k + 1} on the credit agreement terms`);
  s.recs.d1 = [...s.recs.d1, NOTICE];
  val(await s.ai.firstPass('d1'));
  return { s, items: items.map((it) => it.id), findings: ids };
}

describe('the affects prompt at deal scale (#1162)', () => {
  it('splits 300 findings and 500 items into parts whose prompts stay within the input limit', async () => {
    const LIMIT = 12_000;
    const { s, items, findings } = await dealScale(LIMIT);
    expect(s.affectCalls.length).toBeGreaterThan(1);
    for (const c of s.affectCalls) expect(tokensOf(c.prompt)).toBeLessThanOrEqual(LIMIT);
    const shown = s.affectCalls.map(affectsShown);
    expect(shown.flatMap((x) => x.findings).sort()).toEqual([...findings].sort());
    expect(shown.flatMap((x) => x.items).sort()).toEqual([...items].sort());
    expect(shown.every((x) => x.docs.join() === NOTICE.docId)).toBe(true);
  }, 60_000);
});
