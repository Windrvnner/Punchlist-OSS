// @vitest-environment node
// A check while some of the deal's documents cannot be reached: an item is never settled on the part of its
// documents that could be read, and the check is not a complete one. At deal scale: 2,000 items, 120 documents.
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, finding, itemsIn, Mem, OK } from './reviewKit';

const N_ITEMS = 2000, N_DOCS = 120;
const DOCS = Array.from({ length: N_DOCS }, (_, i) => doc(i + 1, `Agreement ${i + 1}.pdf`, { words: ['agreement', 'signed', 'dated'] }));
/** every third document sits in a part of the data room that can drop */
const OUT = new Set(DOCS.filter((_, i) => i % 3 === 0).map((r) => r.docId));
const list = (n = N_ITEMS) => () => ({ broad: Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, text: `Agreement ${i + 1} is signed and dated` })), product: [], sector: [] });
const AWAY = 'The documents chosen for it could not be opened on this PC';
/** the reason, naming the files out of reach: one of those in OUT, at least */
const named = (why: string | undefined) => !!why?.startsWith(`${AWAY}: Agreement `) && /^[^:]*: Agreement \d+\.pdf(, Agreement \d+\.pdf)*( and (Agreement \d+\.pdf|\d+ more))?\.$/.test(why);
const rows = async (s: ReturnType<typeof setup>) => val(await s.ai.checklist('d1'));
const tally = async (s: ReturnType<typeof setup>) => (await rows(s)).reduce((a: Record<string, number>, r) => { a[r.result] = (a[r.result] ?? 0) + 1; return a; }, {});

/**
 * A deal, checked once with everything there. Then `state.away` makes the documents in OUT impossible to send and has the
 * document service say they are out of reach; `state.gone` makes them impossible to send with nothing said (this PC saw
 * them leave its copy). `state.onWanted` is called each time documents are asked for, before they are looked for.
 */
async function kit(items = N_ITEMS) {
  const state = { away: false, gone: false, all: false, onWanted: () => {} };
  const out = (id: string) => state.all || OUT.has(id);
  const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), { d1: DOCS }, {
    shared: new Mem(), installId: 'pc', checklist: list(items),
    wanted: async (_d, ids) => { state.onWanted(); return DOCS.filter((r) => ids.includes(r.docId) && !((state.away || state.gone) && out(r.docId))).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })); },
    away: (_d, ids) => (state.away ? ids : []),                                 // as the document service answers: every one asked about that has not left
  });
  await deal(s.repo); val(await s.ai.firstPass('d1')); expect(await tally(s)).toEqual(items ? { satisfied: items } : {});
  return { s, state };
}

describe('a check while part of the data room cannot be reached', () => {
  it('an item with a chosen document out of reach is left as could not be checked, never settled on the rest; the check is complete only once they are read', async () => {
    const { s, state } = await kit();
    state.away = true;
    const part = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(part.at).toBeNull(); expect(part.unchecked!.items).toBeGreaterThan(N_ITEMS / 2);     // most items had one of those documents among the ones chosen
    const open = (await rows(s)).filter((r) => r.result === 'unsettled');
    expect(open.length).toBe(part.unchecked!.items); expect(open.every((r) => named(r.why))).toBe(true);
    expect(val(await s.ai.checked('d1')).left).toMatchObject({ items: part.unchecked!.items });
    state.away = false;
    const rest = val(await s.ai.checkAll({ dealId: 'd1', only: 'left' }));                    // "Check the N left out"
    expect(rest.items).toBe(part.unchecked!.items); expect(rest.at).not.toBeNull(); expect(rest.unchecked).toEqual({ items: 0, findings: 0 });
    expect(await tally(s)).toEqual({ satisfied: N_ITEMS });
  }, 120000);

  it('documents that drop out of reach after they were chosen, before they are sent, settle nothing, and the model is asked nothing about the rest of them', async () => {
    const { s, state } = await kit(); const n = s.calls.length;
    // the first time documents are asked for they are all there (the choice); from the second (the sending), those in OUT are out of reach
    let asked = 0; state.onWanted = () => { if (++asked === 2) state.away = true; };
    const part = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(asked).toBeGreaterThan(1);
    // no call was made on a part of what was chosen: Check again starts each item from the documents it was settled on,
    // so a handful whose documents are all still there is read, and none that had one out of reach is
    const outNames = new Set(DOCS.filter((r) => OUT.has(r.docId)).map((r) => r.name));
    expect(s.calls.slice(n).every((c) => !(c.files ?? []).some((f: { name: string }) => outNames.has(f.name.split('__').pop()!)))).toBe(true);
    expect(part.at).toBeNull(); expect(part.unchecked!.items).toBeGreaterThan(N_ITEMS / 2);
    expect((await rows(s)).filter((r) => r.result === 'unsettled').every((r) => named(r.why))).toBe(true);
  }, 120000);

  it('a document this PC has seen leave its copy is not out of reach: the check reads the rest and is complete, as before', async () => {
    const { s, state } = await kit();
    state.gone = true;
    const r = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(r.at).not.toBeNull(); expect(r.unchecked).toEqual({ items: 0, findings: 0 }); expect(await tally(s)).toEqual({ satisfied: N_ITEMS });
  }, 120000);

  it('when every document chosen drops out of reach before it is sent, the items say so, and the model is asked nothing', async () => {
    const { s, state } = await kit(); const n = s.calls.length;
    let asked = 0; state.all = true; state.onWanted = () => { if (++asked === 2) state.away = true; };
    const part = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(s.calls.length).toBe(n); expect(part.at).toBeNull(); expect(part.unchecked!.items).toBe(N_ITEMS);
    expect((await rows(s)).every((r) => r.result === 'unsettled' && named(r.why))).toBe(true);
  }, 120000);

  it('a finding is not reassessed, nor judged by a check, on part of its documents while the rest are out of reach', async () => {
    const { s, state } = await kit(0);
    // its sources: one document that can drop and one that cannot
    await finding(s.repo, 'f_1', 'Agreement 1 is not signed', { sources: [{ doc: DOCS[0].name, loc: 'p. 1', docId: DOCS[0].docId }, { doc: DOCS[1].name, loc: 'p. 1', docId: DOCS[1].docId }] });
    state.away = true; const n = s.all.length;
    const r = await s.ai.reassess({ dealId: 'd1', findingId: 'f_1' }); expect(!r.ok && r.error.message).toBe('The documents for this could not be opened on this PC');
    // dropping between the choice and the sending
    state.away = false; let asked = 0; state.onWanted = () => { if (++asked === 2) state.away = true; };
    const c = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(c.at).toBeNull(); expect(c.unchecked).toMatchObject({ findings: 1 });
    expect(s.all.slice(n).filter((x) => /does it still stand as written\?|Reassess this finding/.test(x.prompt))).toEqual([]);
  }, 120000);

  it('a group held back names only the files that could not be sent, though the service is asked about the others too', async () => {
    const { s, state } = await kit(); state.away = true;
    const part = val(await s.ai.checkAll({ dealId: 'd1', deep: true })); expect(part.at).toBeNull();
    const open = (await rows(s)).filter((r) => r.result === 'unsettled');
    const names = new Set(DOCS.filter((r) => OUT.has(r.docId)).map((r) => r.name));
    for (const r of open) for (const m of r.why!.split(': ')[1].replace(/\.$/, '').split(/, | and /)) if (!/^\d+ more$/.test(m)) expect(names.has(m)).toBe(true);
  }, 120000);
});
