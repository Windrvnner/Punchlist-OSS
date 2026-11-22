// @vitest-environment node
// A folder in the data room that this person may not open: nothing in it leaves the deal, and only the items whose own documents are in it wait, naming the folder. The real backend on real folders, one PC, at deal
// scale; only the model is a stand-in. The tests run with every right, so the folder is closed by making the calls fail.
import { describe, it, expect } from 'vitest';
import { pcApp, newDeal } from './kit';
import { N_ITEMS, N_DOCS, LIST, model, room, val, recs, saidLeft, close } from './awayKit';

describe('a folder in the data room that this person may not open', () => {
  it('a check holds back only the items whose own documents are in it, naming the folder; once it opens they are checked', async () => {
    const { root, vdr } = room(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    const dealId = await newDeal(A, 'Proseware', vdr, 150_000);
    let open = () => {};
    try {
      open = close();
      const r = val(await A.backend.ai.checkAll!({ dealId, deep: true })); await A.backend.idle();
      const rows = val(await A.backend.ai.checklist!(dealId)); const waiting = rows.filter((x) => x.result === 'unsettled');
      // the agreements in Legal D are numbers 3, 15, 27 and on; each item names one agreement (b3 too: its own documents take in Agreement 3).
      // The folders are lettered, not numbered: a folder "10 Legal" would answer to agreement number 10 too. Before the fix every item that
      // shared a batch with one of them waited too (90 of the 2,000).
      expect(waiting.map((x) => x.id)).toEqual(['b3', 'b15', 'b27', 'b39', 'b51', 'b63', 'b75', 'b87', 'b99', 'b111']);
      for (const x of waiting) expect(x.why).toBe('The folder Legal D could not be opened on this PC.');
      expect(r).toMatchObject({ at: null, unchecked: { items: waiting.length } });                        // and the check is not a complete one
      expect(rows.filter((x) => x.result === 'satisfied').length).toBe(N_ITEMS - waiting.length);
      expect(recs(A, dealId).length).toBe(N_DOCS); expect(saidLeft(A)).toBe(false);
    } finally { open(); }
    // it opens: "Check the N left out" checks them
    const r2 = val(await A.backend.ai.checkAll!({ dealId, only: 'left' })); await A.backend.idle();
    expect(r2.unchecked).toEqual({ items: 0, findings: 0 }); expect(val(await A.backend.ai.checklist!(dealId)).every((x) => x.result === 'satisfied')).toBe(true);
    await A.backend.close();
  }, 900000);

});
