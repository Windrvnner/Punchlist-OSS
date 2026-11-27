// @vitest-environment node
// A check while a folder of the data room may not be opened by this person: only the items that use its documents
// wait, naming the folder; the rest of each batch is checked on documents chosen from what can be read, and asking which
// items use it costs no model call. A folder that does not answer still holds back the whole batch.
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, itemsIn, Mem, OK, listed, thingsAsked, type Call } from './reviewKit';
import type { AiDocs } from '../../src/backend/ai';
import type { DocRecord } from '../../src/backend/documents';

/** a document in "Legal", the folder this person may not open, or in an open one; it uses only its own name's words */
const SHUT = (n: number, name: string, extra: Partial<DocRecord> = {}) => doc(n, name, { rel: `Legal/${name}`, words: [name.split(/[ .]/)[0].toLowerCase()], ...extra });
const OPEN = (n: number, name: string, extra: Partial<DocRecord> = {}) => doc(n, name, { rel: `Open/${name}`, words: [name.split(/[ .]/)[0].toLowerCase()], ...extra });
const DROP = (n: number, name: string) => doc(n, name, { rel: `Drive/${name}`, words: [name.split(/[ .]/)[0].toLowerCase()] });
const FOLDER = 'The folder Legal could not be opened on this PC.';

/** what a pick was asked about, and the paths it was offered */
const asked = (c: Call) => ({ what: c.prompt.split('Which of them should be read for this?\n')[1].split('\n\nChoose')[0], rows: listed(c) });
/** what a pick for several items was asked about, one line for each, and the paths it was offered */
const askedEach = (c: Call) => ({ things: thingsAsked(c), rows: listed(c) });
/**
 * A deal whose "Legal" documents cannot be read on this PC, and "Drive" ones are on a drive that dropped. `pick` says which
 * offered paths the fast model picks for a batch (its items' text, one per line), and `own` which it picks for one item when
 * asked for several items' own, each by part of the path.
 */
function kit(DOCS: DocRecord[], items: string[], pick: (what: string, paths: string[]) => string[], own: (what: string, paths: string[]) => string[], o: { core?: string[]; script?: (c: Call, it: { tag: string; text: string }) => object; width?: number } = {}) {
  const where = (id: string) => DOCS.find((r) => r.docId === id)?.rel.split('/')[0];
  const docs: AiDocs = {
    records: () => DOCS,
    wanted: async (_d, ids) => DOCS.filter((r) => ids.includes(r.docId) && where(r.docId) === 'Open').map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })),
    away: (_d, ids) => ids,                                                        // as decided: of those not sent, every one that has not left
    shut: (_d, ids) => new Map(ids.filter((id) => where(id) === 'Legal').map((id) => [id, 'Legal'])),
  };
  const by = (want: string[], rows: ReturnType<typeof listed>) =>
    want.flatMap((w) => rows.filter((r) => r.path.includes(w)).map((r) => r.id));
  return setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...(o.script ? o.script(c, it) : OK(c)) })) }), { d1: DOCS }, {
    shared: new Mem(), installId: 'pc', batch: Math.min(20, items.length), docs, coreFor: () => o.core ?? [],   // which are core is set here, so that the closed folder is the only thing these tests vary
    ...(o.width ? { width: o.width } : {}),
    checklist: () => ({ broad: items.map((text, i) => ({ id: `c${i + 1}`, text })), product: [], sector: [] }),
    pick: (c: Call) => { const { what, rows } = asked(c); return { read: by(pick(what, rows.map((r) => r.path)), rows) }; },
    pickFor: (c: Call) => { const { things, rows } = askedEach(c); return { read: Object.fromEntries(things.map((t) => [t.tag, by(own(t.what, rows.map((r) => r.path)), rows)])) }; },
  } as never);
}
const results = async (s: ReturnType<typeof kit>) => val(await s.ai.checklist('d1')).map((r) => [r.id, r.result, ...(r.result === 'unsettled' ? [r.why] : [])]);
/** each item's own pick: the file named by its first word */
const first = (what: string) => [`/${what.split(' ')[0]}.`];
/** the files a call to the standard model was given */
const filesOf = (c: Call) =>
  [...c.prompt.split('\n\nCheck each of these')[0].matchAll(/^(doc_[0-9a-f]{24}): ([^\n]*)$/gm)].map((m) => m[2]);

describe('a check while a folder may not be opened by this person', () => {
  it('when a closed document is chosen for a batch, each item\'s own documents are asked for in one question: only an item whose own include it waits, naming the folder', async () => {
    const DOCS = [SHUT(1, 'PPA.pdf'), OPEN(2, 'Datum.pdf'), OPEN(3, 'Coho.pdf'), OPEN(4, 'Term sheet.pdf')];
    // the batch's choice takes the closed PPA in; on their own, the offtake item needs it (its words do not name it) and the others do not
    const s = kit(DOCS, ['Datum is signed', 'Coho is signed', 'Offtake term is 20 years'], () => ['PPA', 'Datum', 'Coho'], (w) => (w.startsWith('Offtake') ? ['PPA', 'Term sheet'] : first(w)));
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect(await results(s)).toEqual([['c1', 'satisfied'], ['c2', 'satisfied'], ['c3', 'unsettled', FOLDER]]);
    expect(s.pickForCalls.length).toBe(1);                                                     // three items' own, in one question
  });

  it('a blackline whose clean draft is closed is out of reach too: it is never sent without it', async () => {
    const DOCS = [SHUT(1, 'PPA v2.docx'), OPEN(2, 'Compare.pdf', { cover: 'Comparison of PPA v1 docx and PPA v2 docx' }), OPEN(3, 'Datum.pdf'), OPEN(4, 'Coho.pdf')];
    const s = kit(DOCS, ['Datum is signed', 'Coho is signed'], () => ['Compare', 'Datum', 'Coho'], (w) => (w.startsWith('Datum') ? ['Compare', 'Datum'] : first(w)));
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect(await results(s)).toEqual([['c1', 'unsettled', FOLDER], ['c2', 'satisfied']]);
    for (const c of s.calls) expect(c.files.map((f) => f.name).join(' ')).not.toContain('Compare');
  });

  it('a core document in the closed folder is not offered and holds back no item', async () => {
    const N = 40; const DOCS = [SHUT(1, 'Core.pdf'), ...Array.from({ length: N }, (_, i) => OPEN(i + 2, `Doc${i}.pdf`))];
    const s = kit(DOCS, Array.from({ length: N }, (_, i) => `Doc${i} is signed`), (w, paths) => [...(paths.some((p) => p.includes('Core')) ? ['Core'] : []), ...w.split('\n').map((l) => `/${l.split(' ')[0]}.`)], (w, paths) => [...(paths.some((p) => p.includes('Core')) ? ['Core'] : []), ...first(w)], { core: [DOCS[0].docId] });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect((await results(s)).every((r) => r[1] === 'satisfied')).toBe(true);
    expect(s.pickForCalls.length).toBe(4);                                                     // only the batch that found the folder asks for its items' own; after that the core document is not offered
  });

  it('at deal scale, only items whose own documents are in the closed folder wait, naming it, on this check and the next; the extra questions are one for every five items of a batch that took a closed document in', async () => {
    const N_ITEMS = 2000, N_DOCS = 120; const closed = (i: number) => i % 12 === 3;
    const DOCS = Array.from({ length: N_DOCS }, (_, i) => (closed(i) ? SHUT : OPEN)(i + 1, `Agreement${i}.pdf`));
    const items = Array.from({ length: N_ITEMS }, (_, i) => `Agreement${i % N_DOCS} clause${i} is signed and dated`);
    const s = kit(DOCS, items, (w, paths) => w.split('\n').map((l) => `/${l.split(' ')[0]}.pdf`).filter((x) => paths.some((p) => p.includes(x))), first);
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    // an item about a closed agreement waits when that agreement is chosen for its batch; an item about an open one never does
    const uses = new Set(items.flatMap((_t, i) => (closed(i % N_DOCS) ? [`c${i + 1}`] : [])));
    const waiting = (await results(s)).filter((r) => r[1] === 'unsettled'); const want = waiting.length;
    expect(waiting.every((r) => uses.has(String(r[0])) && r[2] === FOLDER)).toBe(true); expect(want).toBeGreaterThan(uses.size / 2);
    expect(s.pickForCalls.length).toBeLessThanOrEqual((N_ITEMS / 20) * 4);
    // the items not held back are read together, as a batch is: one standard call a batch, and the second looks
    expect(s.calls.length).toBe(N_ITEMS / 20);                                     // every item settles on its batch's read here, so no second look is asked
    const r = val(await s.ai.checkAll({ dealId: 'd1', deep: true }));
    expect(r).toMatchObject({ at: null, unchecked: { items: want } });
  }, 120000);

  it('a drive that drops holds back only the items whose own documents include its file, also once a closed folder has been found', async () => {
    const DOCS = [SHUT(1, 'Shared A.pdf'), DROP(2, 'Drop.pdf'), OPEN(3, 'Datum.pdf'), OPEN(4, 'Coho.pdf'), OPEN(5, 'Lamna.pdf')];
    const s = kit(DOCS, ['Datum is signed', 'Coho is signed', 'Lamna is signed'], () => ['Shared', 'Datum', 'Coho'], (w) => (w.startsWith('Datum') ? ['Datum', 'Drop'] : first(w)));
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    const rows = await results(s); expect(rows.map((r) => r[1])).toEqual(['unsettled', 'satisfied', 'satisfied']); expect(String(rows[0][2])).toMatch(/: Drop\.pdf\.$/);
  });

  it('an item checked on its own documents is still offered, in its second look, a document only another item read', async () => {
    const DOCS = [SHUT(1, 'PPA.pdf'), OPEN(2, 'Datum.pdf'), OPEN(3, 'Coho.pdf'), OPEN(4, 'Lamna.pdf'), OPEN(5, 'Trey.pdf')];
    // two documents to a call, so the items go in two rounds; Datum needs Lamna, which only the Lamna item's round reads
    const s = kit(DOCS, ['Datum is signed', 'Coho is signed', 'Lamna is signed', 'Trey is signed'], () => ['PPA', 'Datum', 'Coho'], (w) => (w.includes('Still needed') ? ['Lamna'] : first(w)),
      { width: 2, script: (c, it) => (it.text.startsWith('Datum') && !filesOf(c).some((f) => f.includes('Lamna')) ? { result: 'more', need: 'gamma' } : OK(c)) });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect((await results(s)).every((r) => r[1] === 'satisfied')).toBe(true);
  });

  it('an item the fast model gives nothing of its own goes by the ranking, and waits if that takes in the closed document', async () => {
    const DOCS = [SHUT(1, 'PPA offtake.pdf'), OPEN(2, 'Datum.pdf'), OPEN(3, 'Coho.pdf')];
    const s = kit(DOCS, ['Datum is signed', 'Coho is signed', 'Offtake term is 20 years'], () => ['PPA', 'Datum', 'Coho'], (w) => (w.startsWith('Offtake') ? [] : first(w)));
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect(await results(s)).toEqual([['c1', 'satisfied'], ['c2', 'satisfied'], ['c3', 'unsettled', FOLDER]]);
  });

  it('a folder that opens again part-way through a check holds nothing back from then on', async () => {
    let closedNow = true;
    const DOCS = [SHUT(1, 'PPA.pdf'), ...Array.from({ length: 4 }, (_, i) => OPEN(i + 2, `Doc${i}.pdf`))];
    const readable = (id: string) => !DOCS.find((r) => r.docId === id)!.rel.startsWith('Legal/') || !closedNow;
    const items = ['Doc0 is signed', 'PPA term is 20 years', 'Doc1 is signed', 'PPA tariff is fixed'];
    const s = setup((c) => { closedNow = false; return { items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }; }, { d1: DOCS }, {
      shared: new Mem(), installId: 'pc', batch: 2,
      docs: { records: () => DOCS, wanted: async (_d: string, ids: string[]) => DOCS.filter((r) => ids.includes(r.docId) && readable(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })),
        away: (_d: string, ids: string[]) => ids, shut: (_d: string, ids: string[]) => new Map(ids.filter((id) => !readable(id)).map((id) => [id, 'Legal'])) },
      checklist: () => ({ broad: items.map((text, i) => ({ id: `c${i + 1}`, text })), product: [], sector: [] }),
      pick: (c: Call) => ({ read: listed(c).filter((r) => /PPA|Doc0|Doc1/.test(r.path)).map((r) => r.id) }),
      pickFor: (c: Call) => {
        const { things, rows } = askedEach(c);
        const own = (what: string) => (what.startsWith('PPA') ? 'PPA' : `/${what.split(' ')[0]}.`);
        const ids = (what: string) => rows.filter((r) => r.path.includes(own(what))).map((r) => r.id);
        return { read: Object.fromEntries(things.map((t) => [t.tag, ids(t.what)])) };
      },
    } as never);
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    // the first batch found the folder closed and held its PPA item; it opened while that batch was read, so the next one is not held
    expect(val(await s.ai.checklist('d1')).map((r) => [r.id, r.result])).toEqual([['c1', 'satisfied'], ['c2', 'unsettled'], ['c3', 'satisfied'], ['c4', 'satisfied']]);
  });

  it('a batch held back by a dropped drive names only the file that could not be sent, not those that could', async () => {
    const DOCS = [DROP(1, 'Drop.pdf'), OPEN(2, 'Datum.pdf'), OPEN(3, 'Coho.pdf')];
    const s = kit(DOCS, ['Datum is signed', 'Coho is signed'], () => ['Drop', 'Datum', 'Coho'], first);
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect(await results(s)).toEqual([['c1', 'unsettled', expect.stringMatching(/: Drop\.pdf\.$/)], ['c2', 'unsettled', expect.stringMatching(/: Drop\.pdf\.$/)]]);
  });

  it('with two closed folders, one that opens part-way through a check holds nothing back from then on, while the other still does', async () => {
    let aOpen = false; const at = (f: string) => (n: number, name: string) => doc(n, name, { rel: `${f}/${name}`, words: [name.split(/[ .]/)[0].toLowerCase()] });
    const DOCS = [at('A')(1, 'Apple.pdf'), at('B')(2, 'Bear.pdf'), ...Array.from({ length: 4 }, (_, i) => at('Open')(i + 3, `Doc${i}.pdf`))];
    const fold = (id: string) => DOCS.find((r) => r.docId === id)!.rel.split('/')[0];
    const readable = (id: string) => fold(id) === 'Open' || (fold(id) === 'A' && aOpen);
    const items = ['Doc0 is signed', 'Bear term', 'Apple term', 'Doc1 is signed', 'Apple tariff', 'Doc2 is signed'];
    const s = setup((c) => { aOpen = true; return { items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }; }, { d1: DOCS }, {
      shared: new Mem(), installId: 'pc', batch: 3,
      docs: { records: () => DOCS, wanted: async (_d: string, ids: string[]) => DOCS.filter((r) => ids.includes(r.docId) && readable(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })),
        away: (_d: string, ids: string[]) => ids, shut: (_d: string, ids: string[]) => new Map(ids.filter((id) => !readable(id)).map((id) => [id, fold(id)])) },
      checklist: () => ({ broad: items.map((text, i) => ({ id: `c${i + 1}`, text })), product: [], sector: [] }),
      pick: (c: Call) => ({ read: listed(c).filter((r) => /Apple|Bear|Doc0|Doc1|Doc2/.test(r.path)).map((r) => r.id) }),
      pickFor: (c: Call) => {
        const { things, rows } = askedEach(c);
        const ids = (what: string) => rows.filter((r) => r.path.includes(what.split(' ')[0])).map((r) => r.id);
        return { read: Object.fromEntries(things.map((t) => [t.tag, ids(t.what)])) };
      },
    } as never);
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    // the first batch was chosen while both were closed; A opened while it was read, so the second batch holds back only the Bear item's kind
    expect(await results(s)).toEqual([['c1', 'satisfied'], ['c2', 'unsettled', 'The folder B could not be opened on this PC.'], ['c3', 'unsettled', 'The folder A could not be opened on this PC.'], ['c4', 'satisfied'], ['c5', 'satisfied'], ['c6', 'satisfied']]);
  });

  it('of two closed folders, one that opens is seen at the next batch though only the other is chosen there', async () => {
    let aOpen = false; const at = (f: string) => (n: number, name: string) => doc(n, name, { rel: `${f}/${name}`, words: [name.split(/[ .]/)[0].toLowerCase()] });
    const DOCS = [at('A')(1, 'Apple.pdf'), at('B')(2, 'Bear.pdf'), ...Array.from({ length: 4 }, (_, i) => at('Open')(i + 3, `Doc${i}.pdf`))];
    const fold = (id: string) => DOCS.find((r) => r.docId === id)!.rel.split('/')[0];
    const readable = (id: string) => fold(id) === 'Open' || (fold(id) === 'A' && aOpen);
    const items = ['Doc0 is signed', 'Bear term', 'Apple term', 'Doc1 is signed', 'Apple tariff', 'Doc2 is signed'];
    const s = setup((c) => { aOpen = true; return { items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }; }, { d1: DOCS }, {
      shared: new Mem(), installId: 'pc', batch: 3,
      docs: { records: () => DOCS, wanted: async (_d: string, ids: string[]) => DOCS.filter((r) => ids.includes(r.docId) && readable(r.docId)).map((r) => ({ docId: r.docId, name: r.name, read: () => new TextEncoder().encode(r.name) })),
        away: (_d: string, ids: string[]) => ids, shut: (_d: string, ids: string[]) => new Map(ids.filter((id) => !readable(id)).map((id) => [id, fold(id)])) },
      checklist: () => ({ broad: items.map((text, i) => ({ id: `c${i + 1}`, text })), product: [], sector: [] }),
      pick: (c: Call) => ({ read: listed(c).filter((r) => /Bear|Doc0|Doc1|Doc2/.test(r.path)).map((r) => r.id) }),
      pickFor: (c: Call) => {
        const { things, rows } = askedEach(c);
        const ids = (what: string) => rows.filter((r) => r.path.includes(what.split(' ')[0])).map((r) => r.id);
        return { read: Object.fromEntries(things.map((t) => [t.tag, ids(t.what)])) };
      },
    } as never);
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    expect(await results(s)).toEqual([['c1', 'satisfied'], ['c2', 'unsettled', 'The folder B could not be opened on this PC.'], ['c3', 'unsettled', 'The folder A could not be opened on this PC.'], ['c4', 'satisfied'], ['c5', 'satisfied'], ['c6', 'satisfied']]);
  });
});
