// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { setup, doc, val, deal, itemsIn, Mem, type Call, OK, nth, affectedAs } from './reviewKit';
import { fromStoreName } from '../../src/backend/storeKeeper';
import { itemId } from '../../src/domain/checklist';
import type { Repository } from '../../src/ports';

const FA = doc(1, 'Credit Agreement.pdf', { words: ['facility', 'agreement', 'lock', 'ratio'] });
const TS = doc(2, 'Term sheet.pdf', { pages: 12, words: ['term', 'sheet', 'lock', 'ratio'] });
const IM = doc(3, 'Information memorandum.pdf', { words: ['project', 'capacity', 'sponsor'] });
const LIST = () => ({ broad: [{ id: 'c1', text: 'The credit agreement is in the data room' }, { id: 'c2', text: 'The lock-up ratio in the credit agreement matches the term sheet' }, { id: 'c3', text: 'A decommissioning bond is in place' }, { id: 'c4', text: 'The sponsor is named in the credit agreement' }], product: [], sector: [] });
const tag = (c: Call, name: string) => nth(c, c.files.findIndex((f) => fromStoreName(f.name)!.name === name) + 1);
// c1 is satisfied, c2 comes to a finding, c3 finds nothing that settles it, c4 gets no usable answer
const script = (c: Call) => ({ items: itemsIn(c).flatMap((it) => (it.text.includes('data room') ? [{ id: it.tag, ...OK(c) }]
  : it.text.includes('lock-up') ? [{ id: it.tag, result: 'finding', title: 'Lock-up ratio differs between the credit agreement and the term sheet', workstream: 'Legal', body: ['The draft sets it at 1.25x. [1]', 'The term sheet has 1.30x. [2]'], next: '', sources: [{ doc: tag(c, FA.name), page: 14 }, { doc: tag(c, TS.name), page: 3 }] }]
  : it.text.includes('decommissioning') ? [{ id: it.tag, result: 'more', need: 'a decommissioning bond' }] : [])) });

/** the deal's own item records, as the firm's list or a person adds them; `rev` is the record's current revision when it exists */
const DK = 'd_01HZZZZZZZZZZZZZZZZZZZZZZZ';    // a deal id of the real shape, which an item record checks
let added = 0;   // each item added a moment after the last, so they list in the order they were added
async function items(repo: Repository, list: { text: string; off?: boolean; rev?: number }[]) {
  val(await repo.transaction({ writes: list.map((x) => { const at = new Date(Date.UTC(2026, 10, 15, 9, 0, added++)).toISOString(); const id = itemId(DK, x.text); return { kind: 'item' as const, id, data: { id, dealId: DK, text: x.text, off: !!x.off, from: [{ layer: 'broad', value: '' }], createdAt: at, updatedAt: at, normV: 1 }, expectedRev: x.rev ?? null }; }), index: { dealId: DK, add: list.filter((x) => x.rev == null).map((x) => ({ kind: 'item' as const, id: itemId(DK, x.text) })) } }));
}

describe('the checklist as it stands', () => {
  it('follows the deal’s own items at once: one turned off leaves it, one added is listed as not checked, with no check run (decisions: a list swap)', async () => {
    const s = setup(script, { [DK]: [FA, TS, IM] }, { shared: new Mem(), installId: 'pc' }); await deal(s.repo, DK);
    const [A, B, C] = ['The credit agreement is in the data room', 'A decommissioning bond is in place', 'The sponsor is named in the credit agreement'];
    await items(s.repo, [{ text: A }, { text: B }]); val(await s.ai.firstPass(DK));
    expect(val(await s.ai.checklist(DK)).map((r) => [r.text, r.result])).toEqual([[A, 'satisfied'], [B, 'gap']]);
    const calls = s.calls.length;
    const revB = val(await s.repo.get('item', itemId(DK, B)))!.rev;
    await items(s.repo, [{ text: B, off: true, rev: revB }, { text: C }]);                            // what a swap does: the old list's item goes off, the new list's comes on
    const rows = val(await s.ai.checklist(DK));
    expect(rows.map((r) => [r.text, r.result])).toEqual([[A, 'satisfied'], [C, 'unchecked']]);
    expect(val(await s.ai.progress(DK)).checklist).toEqual({ items: 2, satisfied: 1, findings: 0, gaps: 0, unsettled: 1 });
    expect(s.calls.length).toBe(calls);                                                               // listing asks no model
  });


  it('lists every item with what it came to, the finding, what a gap needs and the documents read, and agrees with the counts', async () => {
    const recs = { d1: [FA, TS, IM] }; const s = setup(script, recs, { shared: new Mem(), installId: 'pc', checklist: LIST }); await deal(s.repo);
    expect(val(await s.ai.checklist('d1'))).toEqual([]);                                             // nothing recorded yet: nothing listed, as nothing is counted
    val(await s.ai.firstPass('d1'));
    const rows = val(await s.ai.checklist('d1')); const by = Object.fromEntries(rows.map((r) => [r.id, r])); const p = val(await s.ai.progress('d1')).checklist;
    expect(rows.map((r) => [r.id, r.result])).toEqual([['c1', 'satisfied'], ['c2', 'finding'], ['c3', 'gap'], ['c4', 'unsettled']]);
    expect(rows.map((r) => r.text)).toEqual(LIST().broad.map((i) => i.text));
    const stored = val(await s.repo.list('finding', 'd1')); expect(stored.length).toBe(1); expect(by.c2.findingId).toBe((stored[0].envelope.data as { id: string }).id); expect(by.c1.findingId).toBeUndefined();
    expect(by.c3.need).toBe('a decommissioning bond'); expect(by.c1.need).toBeUndefined(); expect(by.c2.need).toBeUndefined();
    expect(by.c1.docs.length).toBeGreaterThan(0); expect(by.c1.docs.every((d) => [FA, TS, IM].some((x) => x.docId === d.docId && x.name === d.name))).toBe(true);
    expect(by.c4.docs).toEqual([]);                                                                   // a check that came to no result read nothing to a result
    expect(p).toEqual({ items: 4, satisfied: 1, findings: 1, gaps: 1, unsettled: 1 });
    // a document the deal no longer has is not named
    const gone = by.c1.docs[0].docId; recs.d1 = recs.d1.filter((r) => r.docId !== gone);
    expect(val(await s.ai.checklist('d1')).find((r) => r.id === 'c1')!.docs.some((d) => d.docId === gone)).toBe(false);
    // once every document it was settled on has gone, Satisfied rests on nothing that opens: it is not settled, and counted so
    const was = new Set([...by.c1.docs.map((d) => d.docId), ...(by.c1.sources ?? []).map((x) => x.docId)]); recs.d1 = recs.d1.filter((r) => !was.has(r.docId));
    const c1 = val(await s.ai.checklist('d1')).find((r) => r.id === 'c1')!;
    expect([c1.result, c1.why, c1.docs, c1.sources]).toEqual(['unsettled', 'The documents it was settled on are no longer in this deal.', [], undefined]);
    expect(val(await s.ai.progress('d1')).checklist).toMatchObject({ satisfied: 0, unsettled: 2 });
  });
  it('a Satisfied item whose cited places have gone is not settled, even while other documents read for it stay', async () => {
    const recs = { d1: [FA, TS, IM] }; const s = setup(script, recs, { shared: new Mem(), installId: 'pc', checklist: LIST }); await deal(s.repo); val(await s.ai.firstPass('d1'));
    const c1 = val(await s.ai.checklist('d1')).find((r) => r.id === 'c1')!; const cited = new Set((c1.sources ?? []).map((x) => x.docId));
    expect(c1.result).toBe('satisfied'); expect(cited.size).toBeGreaterThan(0); expect(c1.docs.some((d) => !cited.has(d.docId))).toBe(true);
    recs.d1 = recs.d1.filter((r) => !cited.has(r.docId));
    const after = val(await s.ai.checklist('d1')).find((r) => r.id === 'c1')!; expect([after.result, after.sources]).toEqual(['unsettled', undefined]);
  });
  it('a gap names apart a document given for it that has no readable text, as not read, and does not count it', async () => {
    const SC = doc(4, 'Decommissioning bond.pdf', { words: [] });                                         // a scan: indexed, but with no text to read
    const s = setup(script, { d1: [FA, TS, IM, SC] }, { shared: new Mem(), installId: 'pc', checklist: LIST }); await deal(s.repo); val(await s.ai.firstPass('d1'));
    const c3 = val(await s.ai.checklist('d1')).find((r) => r.id === 'c3')!; const sent = s.calls.filter((c) => itemsIn(c).some((it) => it.text.includes('decommissioning'))).flatMap((c) => c.files.map((f) => fromStoreName(f.name)!.name));
    expect(c3.result).toBe('gap'); expect(sent).toContain(SC.name);
    expect(c3.unread).toEqual([{ docId: SC.docId, name: SC.name }]); expect(c3.docs.some((d) => d.docId === SC.docId)).toBe(false); expect(c3.docs.length).toBeGreaterThan(0);
  });
  it('a satisfied item says where it was settled: the document, the page and the passage; an "ok" with no place a person can open is sent back, and if it still has none the item is left not settled, with the reason', async () => {
    const one = () => ({ broad: [{ id: 'c1', text: 'The credit agreement is in the data room' }, { id: 'c2', text: 'The sponsor is named in the credit agreement' }, { id: 'c3', text: 'The lock-up ratio is stated' }], product: [], sector: [] });
    // c1: says where at once. c2: says "ok" with no place, then gives one when sent back. c3: never gives a place that can be opened (a page the document does not have, then a document it was not given, then nothing)
    const seen: Record<string, number> = {};
    const s = setup((c) => ({ items: itemsIn(c).map((it) => {
      const n = (seen[it.text] = (seen[it.text] ?? 0) + 1);
      if (it.text.includes('data room')) return { id: it.tag, result: 'ok', where: [{ doc: tag(c, FA.name), page: 2, quote: 'This Credit Agreement is dated March 3.' }, { doc: tag(c, TS.name), page: '7' }] };
      if (it.text.includes('sponsor')) return n === 1 ? { id: it.tag, result: 'ok' } : { id: it.tag, result: 'ok', where: { document: tag(c, FA.name), page: 'p. 9', quote: 'Proseware Energy Holdings (the "Sponsor")' } };
      return n === 1
        ? { id: it.tag, result: 'ok', where: [{ doc: tag(c, TS.name), page: 99 }] }
        : n === 2
          ? { id: it.tag, result: 'ok', where: [{ doc: tag(c, TS.name), cell: 'A1' }] }
          : { id: it.tag, result: 'ok' };
    }) }), { d1: [FA, TS, IM] }, { shared: new Mem(), installId: 'pc', checklist: one }); await deal(s.repo);
    const p = val(await s.ai.firstPass('d1'));
    expect(p.unsettled).toEqual(['c3']); expect(p.gaps).toEqual([]);
    // one call for all three, one more for the two that gave no usable place (each told what was wrong), and the thorough model once for the one still without
    expect(s.calls.map((c) => [c.model, itemsIn(c).map((it) => it.text.split(' ').slice(0, 3).join(' '))])).toEqual([['standard', ['The credit agreement', 'The sponsor is', 'The lock-up ratio']], ['standard', ['The sponsor is', 'The lock-up ratio']], ['thorough', ['The lock-up ratio']]]);
    expect(s.calls[0].prompt).toContain('Add "where"'); expect(s.calls[1].prompt).toContain('As "ok" it needs "where"');
    const rows = val(await s.ai.checklist('d1')); const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(rows.map((r) => [r.id, r.result])).toEqual([['c1', 'satisfied'], ['c2', 'satisfied'], ['c3', 'unsettled']]);
    expect(by.c1.sources).toEqual([{ doc: 'Credit Agreement.pdf', docId: FA.docId, loc: 'p. 2', quote: 'This Credit Agreement is dated March 3.' }, { doc: 'Term sheet.pdf', docId: TS.docId, loc: 'p. 7' }]);
    expect(by.c2.sources).toEqual([{ doc: 'Credit Agreement.pdf', docId: FA.docId, loc: 'p. 9', quote: 'Proseware Energy Holdings (the "Sponsor")' }]);
    expect(by.c3.sources).toBeUndefined(); expect(by.c3.why).toBe('It was found satisfied, but no page that shows it could be pointed to.'); expect(by.c1.why).toBeUndefined();
    expect(by.c1.at).toMatch(/^2026-/); expect(by.c3.at).toMatch(/^2026-/);
    // the documents an item was settled on are among those it was read against
    expect(by.c1.docs.map((d) => d.docId)).toEqual(expect.arrayContaining([FA.docId, TS.docId]));
  });
  it('the fast model’s quick look is not asked for a place, and an item it finds still satisfied keeps the places it was settled on', async () => {
    const list = () => ({ broad: Array.from({ length: 3 }, (_, i) => ({ id: `q${i + 1}`, text: `Point ${i + 1} is dealt with in the credit agreement` })), product: [], sector: [] });
    const recs = { d1: [FA, TS, IM] };
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) }), recs,
      { shared: new Mem(), installId: 'pc', checklist: list, affects: (c) => affectedAs(c, 'C1', 'C2', 'C3') });
    await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    const before = val(await s.ai.checklist('d1')); expect(before.every((r) => r.result === 'satisfied' && r.sources?.length === 1 && r.sources[0].loc === 'p. 1')).toBe(true);
    // a new document arrives that is said to bear on all three: the fast model looks at them again and finds them as they were
    recs.d1 = [...recs.d1, doc(4, 'Side letter.pdf', { words: ['side', 'letter', 'facility'] })];
    const n = s.calls.length; val(await s.ai.firstPass('d1'));
    const quick = s.calls.slice(n); expect(quick.length).toBeGreaterThan(0); expect(quick.every((c) => c.model === 'fast')).toBe(true);
    expect(quick.every((c) => !c.prompt.includes('"where"'))).toBe(true);                                                  // the cheap look stays cheap
    const after = val(await s.ai.checklist('d1'));
    expect(after.map((r) => [r.id, r.result, r.sources])).toEqual(before.map((r) => [r.id, r.result, r.sources]));       // nothing lost by being looked at again
    expect(after.some((r, i) => r.at !== before[i].at)).toBe(true);                                                       // and it was written down again, not skipped
  });
  it('layers merge on the checklist’s own key: wording differing only in quotes, case or a period is one', async () => {
    const list = () => ({
      broad: [{ id: 'b1', text: 'Permits obtained.' }, { id: 'b2', text: 'The “permits” are obtained.' }],
      product: [],
      sector: [
        { id: 's1', text: 'permits obtained' },
        { id: 's2', text: 'The "permits" are obtained' },
        { id: 's3', text: 'Lenders consent is given' },
      ],
    });
    const script = (c: Call) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, ...OK(c) })) });
    const s = setup(script, { d1: [FA, TS, IM] }, { shared: new Mem(), installId: 'pc', checklist: list });
    await deal(s.repo); val(await s.ai.firstPass('d1'));
    const asked = [...new Set(s.calls.flatMap((c) => itemsIn(c).map((it) => it.text)))];
    expect(asked).toEqual(['Permits obtained.', 'The “permits” are obtained.', 'Lenders consent is given']);
  });
  it('an item whose id changes but whose wording does not keeps what was settled: it is not checked again and raises nothing twice', async () => {
    const recs = { d1: [FA, TS, IM] }; let ids = ['c1', 'c2', 'c3', 'c4'];
    const list = () => ({ broad: LIST().broad.map((it, i) => ({ id: ids[i], text: it.text })), product: [], sector: [] });
    const s = setup(script, recs, { shared: new Mem(), installId: 'pc', checklist: list }); await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    const before = val(await s.ai.checklist('d1')); const findings = val(await s.repo.list('finding', 'd1')).length; expect(findings).toBe(1);
    // the checklist is brought in again, say from a spreadsheet, and its items get new ids; nothing else has changed
    ids = ['n1', 'n2', 'n3', 'n4']; const n = s.calls.length;
    const again = val(await s.ai.firstPass('d1'));
    expect(again.written).toEqual([]); expect(val(await s.repo.list('finding', 'd1')).length).toBe(1);                 // no second finding for the same item
    // only the item that was never settled (c4, unsettled) is asked about again; the three that were settled are not
    const askedAgain = s.calls.slice(n).flatMap((c) => itemsIn(c).map((it) => it.text)); expect(askedAgain.length).toBeGreaterThan(0); expect([...new Set(askedAgain)]).toEqual([LIST().broad[3].text]);
    const after = val(await s.ai.checklist('d1'));
    expect(after.map((r) => [r.id, r.result, r.findingId, r.need, r.sources])).toEqual(before.map((r, i) => [ids[i], r.result, r.findingId, r.need, r.sources]));
  });

  it('a reworded item that already has a finding raises no second one: the finding is marked for a person, once, and a closed or deleted finding is left alone', async () => {
    const recs = { d1: [FA, TS, IM] }; let text = 'The lock-up ratio in the credit agreement matches the term sheet';
    const list = () => ({ broad: [{ id: 'c2', text }], product: [], sector: [] });
    // however the item is worded, the model would write the same problem up under another title each time it is asked
    let asked = 0;
    const s = setup((c) => ({ items: itemsIn(c).map((it) => ({ id: it.tag, result: 'finding', title: `Lock-up ratio differs (${++asked})`, workstream: 'Legal', body: ['The draft sets it at 1.25x. [1]', 'The term sheet has 1.30x. [2]'], next: '', sources: [{ doc: tag(c, FA.name), page: 14 }, { doc: tag(c, TS.name), page: 3 }] })) }), recs, { shared: new Mem(), installId: 'pc', checklist: list }); await deal(s.repo);
    val(await s.ai.firstPass('d1'));
    const stored = async () => val(await s.repo.list('finding', 'd1')).map((l) => l.envelope.data as { id: string; title: string; updated?: boolean; updatedWhy?: string; status?: string });
    expect((await stored()).map((f) => [f.title, !!f.updated])).toEqual([['Lock-up ratio differs (1)', false]]); const n = s.calls.length;
    // the item is reworded: same id, new words
    text = 'The lock-up ratio in the credit agreement is the one in the signed term sheet';
    const r = val(await s.ai.firstPass('d1'));
    expect(s.calls.length).toBe(n);                                                                                       // it is not checked again
    expect(r.written).toEqual([]); const f1 = await stored(); expect(f1.length).toBe(1);
    expect(f1[0]).toMatchObject({ title: 'Lock-up ratio differs (1)', updated: true, updatedWhy: 'The checklist item it was raised on has been reworded' }); expect(r.marked).toEqual([f1[0].id]);
    const row = val(await s.ai.checklist('d1'))[0]; expect(row).toMatchObject({ id: 'c2', text, result: 'finding', findingId: f1[0].id });   // the item shows its new words and still points at its finding
    // run again with nothing changed: the mark is not made a second time
    const r2 = val(await s.ai.firstPass('d1')); expect(r2.marked).toEqual([]); expect(s.calls.length).toBe(n);
    // a person closes the finding; the item is reworded once more: a closed finding is not marked, and still nothing is checked or raised
    const got = val(await s.repo.get('finding', f1[0].id))!; val(await s.repo.transaction({ writes: [{ kind: 'finding', id: f1[0].id, data: { ...(got.envelope.data as object), status: 'closed', updated: false, updatedWhy: '' }, expectedRev: got.rev }] }));
    text = 'The lock-up ratio is the same in the credit agreement and the term sheet';
    const r3 = val(await s.ai.firstPass('d1')); const f3 = await stored();
    expect(r3.marked).toEqual([]); expect(r3.written).toEqual([]); expect(s.calls.length).toBe(n); expect(f3.length).toBe(1); expect(f3[0]).toMatchObject({ status: 'closed', updated: false });
    expect(val(await s.ai.checklist('d1'))[0]).toMatchObject({ id: 'c2', text, result: 'finding', findingId: f1[0].id });
  });
});

describe('another deal holding this deal’s documents', () => {
  it('names a deal whose data room holds most of this one’s files, by content, and leaves out small or partial overlaps', async () => {
    const room = Array.from({ length: 40 }, (_, i) => doc(i + 1, `Document ${i + 1}.pdf`));
    const recs = { d1: room, d2: [...room.slice(0, 30), doc(100, 'Only in d2.pdf')], d3: room.slice(0, 12), d4: [doc(200, 'Unrelated.pdf')] };
    const s = setup(script, recs, { shared: new Mem(), installId: 'pc' });
    for (const id of ['d1', 'd2', 'd3', 'd4']) await deal(s.repo, id);
    expect(val(await s.ai.progress('d1')).alsoIn).toEqual([{ dealId: 'd2', docs: 30, of: 40 }]);   // 30 of 40; 12 of 40 is not most of them
    expect(val(await s.ai.progress('d3')).alsoIn).toEqual([{ dealId: 'd1', docs: 12, of: 12 }, { dealId: 'd2', docs: 12, of: 12 }]);   // every one of its 12
    expect(val(await s.ai.progress('d4')).alsoIn).toBeUndefined();
    recs.d1 = room.slice(0, 5); recs.d3 = room.slice(0, 5);                                          // too few documents to say anything
    expect(val(await s.ai.progress('d1')).alsoIn).toBeUndefined();
  });
  it('a precedents folder dozens of deals read never makes them look alike, nor does a folder only two deals share', async () => {
    const own = (k: number) => Array.from({ length: 20 }, (_, i) => doc(k * 100 + i, `Deal ${k} doc ${i}.pdf`));
    const prec = Array.from({ length: 100 }, (_, i) => doc(10_000 + i, `Precedent ${i}.pdf`, { folder: 'precedents' }));
    const forms = Array.from({ length: 50 }, (_, i) => doc(20_000 + i, `Form ${i}.pdf`, { folder: 'forms' }));
    const recs: Record<string, ReturnType<typeof doc>[]> = { x1: [...own(40), ...forms], x2: [...own(41), ...forms] };
    for (let k = 1; k <= 30; k++) recs[`d${k}`] = [...own(k), ...prec];
    const s = setup(script, recs, { shared: new Mem(), installId: 'pc' });
    for (const id of Object.keys(recs)) await deal(s.repo, id);
    for (const id of ['d1', 'd2', 'd30']) expect(val(await s.ai.progress(id)).alsoIn).toBeUndefined();   // 100 of 120 in 29 other deals, all shared
    expect(val(await s.ai.progress('x1')).alsoIn).toBeUndefined();                                   // 50 of 70 in x2, but none of x1's own folder
  });
  it('a small folder of the deal’s own does not hide a copy of its data room', async () => {
    const room = Array.from({ length: 60 }, (_, i) => doc(i + 1, `Document ${i + 1}.pdf`));
    const work = Array.from({ length: 15 }, (_, i) => doc(500 + i, `Draft ${i}.pdf`, { folder: 'work' }));
    const s = setup(script, { d1: [...room, ...work], d2: room }, { shared: new Mem(), installId: 'pc' });
    for (const id of ['d1', 'd2']) await deal(s.repo, id);
    expect(val(await s.ai.progress('d1')).alsoIn).toEqual([{ dealId: 'd2', docs: 60, of: 75 }]);
  });
  it('shows the two best at most', async () => {
    const room = Array.from({ length: 30 }, (_, i) => doc(i + 1, `Document ${i + 1}.pdf`));
    // each document is in two of the three others, so none is shared, and each holds 20 of the 30
    const s = setup(script, { d1: room, d2: room.slice(0, 20), d3: room.slice(10, 30), d4: [...room.slice(0, 10), ...room.slice(20, 30)] }, { shared: new Mem(), installId: 'pc' });
    for (const id of ['d1', 'd2', 'd3', 'd4']) await deal(s.repo, id);
    const also = val(await s.ai.progress('d1')).alsoIn ?? [];
    expect(also).toHaveLength(2); expect(also.every((a) => a.docs === 20 && a.of === 30)).toBe(true);
  });
});
