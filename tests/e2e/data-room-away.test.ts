// @vitest-environment node
// A data room that cannot be reached for a while: its documents stay the deal's, and no check is taken as complete
// on the part that could be read. The real backend on real folders, one PC, at deal scale; only the model is a stand-in.
import { describe, it, expect } from 'vitest';
import { pcApp, newDeal } from './kit';
import { N_ITEMS, N_DOCS, LIST, model, room, drop, back, val, recs, tally, saidLeft } from './awayKit';

describe('a data room that cannot be reached for a while', () => {
  it('citations opened and a question asked while it is away take no document out of the deal; they open again once it is back', async () => {
    const { root, vdr } = room(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await newDeal(A, 'Proseware', vdr, 150_000); const docs = A.backend.docs;
    expect(recs(A, dealId).length).toBe(N_DOCS);
    const some = recs(A, dealId).filter((_, i) => i % 10 === 0);                         // 12 citations, across the subfolders
    drop(vdr);
    for (const r of some) { const pg = await docs.page(dealId, { doc: r.name, docId: r.docId }, 'p. 1'); expect(!pg.ok && pg.error.kind).toBe('notFound'); }
    await A.backend.ai.answer({ dealId, message: 'Is agreement number 7 signed?', history: [], model: 'standard' });
    expect(recs(A, dealId).length).toBe(N_DOCS); expect(saidLeft(A)).toBe(false);          // nothing is recorded as having left
    back(vdr);
    expect(recs(A, dealId).length).toBe(N_DOCS);
    for (const r of some) expect((await docs.page(dealId, { doc: r.name, docId: r.docId }, 'p. 1')).ok).toBe(true);
    const ans = val(await A.backend.ai.answer({ dealId, message: 'Is agreement number 7 signed?', history: [], model: 'standard' }));
    expect(ans.read).toMatchObject({ of: N_DOCS });
    await A.backend.idle(); await A.backend.close();
  }, 600000);

  it('a check while it is away settles nothing and is not a complete check; once it is back the check reads every document, also after a restart', async () => {
    const { root, vdr } = room(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await newDeal(A, 'Proseware', vdr, 150_000);
    expect(await tally(A, dealId)).toEqual({ satisfied: N_ITEMS });
    drop(vdr);
    const away = val(await A.backend.ai.checkAll!({ dealId, deep: true })); await A.backend.idle();
    expect(away).toMatchObject({ at: null, unchecked: { items: N_ITEMS } });                    // every item "could not be checked"
    expect(await tally(A, dealId)).toEqual({ unsettled: N_ITEMS });
    expect(recs(A, dealId).length).toBe(N_DOCS); expect(saidLeft(A)).toBe(false);
    expect(val(await A.backend.ai.checked!(dealId)).left).toMatchObject({ items: N_ITEMS });
    back(vdr);
    const here = val(await A.backend.ai.checkAll!({ dealId, deep: true })); await A.backend.idle();
    expect(here.at).not.toBeNull(); expect(here.unchecked).toEqual({ items: 0, findings: 0 });
    expect(await tally(A, dealId)).toEqual({ satisfied: N_ITEMS }); expect(recs(A, dealId).length).toBe(N_DOCS);
    await A.backend.close();
    const B = await pcApp(root, 'Office', { service: model(), checklist: LIST }); await B.store.loadDeal(dealId, { gaps: false }); await B.backend.idle();
    expect(recs(B, dealId).length).toBe(N_DOCS);
    await B.backend.close();
  }, 600000);
});
