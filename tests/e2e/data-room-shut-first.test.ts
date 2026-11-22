// @vitest-environment node
// A folder in the data room closed to this person from the deal's first indexing: its files are never recorded, so no
// check counts as complete until it opens and is read. Its own file: two checks of 2,000 items each are as much as one test
// file's memory holds. The real backend on real folders, one PC; only the model is a stand-in.
import { describe, it, expect } from 'vitest';
import { pcApp, newDeal, until } from './kit';
import { N_DOCS, LIST, model, room, val, recs, close } from './awayKit';

describe('a folder in the data room closed from the first indexing', () => {
  it('closed when the deal is first indexed: no check counts as complete until it opens and is read', async () => {
    const { root, vdr } = room(); const A = await pcApp(root, 'Office', { service: model(), checklist: LIST });
    let open = close(); let dealId = '';
    try {
      dealId = await newDeal(A, 'Proseware', vdr, 150_000);
      const r = val(await A.backend.ai.checkAll!({ dealId })); await A.backend.idle();
      expect(recs(A, dealId).length).toBeLessThan(N_DOCS);                                             // its files were never recorded
      expect(r.at).toBeNull(); expect(r.unread).toEqual(['Legal D']);                                  // and says why, naming the folder                                                                          // so the check is not of everything
    } finally { open(); open = () => {}; }
    // it opens: the look at the deal's folders (as before a check) reads it, and the check is complete
    expect(val(await A.backend.docs.freshen!(dealId))).toBe('running'); await until('the folder to be read', async () => { const p = await A.backend.docs.poll(dealId); return p.ok && p.value.done; }); await A.backend.idle();
    const r2 = val(await A.backend.ai.checkAll!({ dealId })); await A.backend.idle();
    expect(recs(A, dealId).length).toBe(N_DOCS); expect(r2.at).not.toBeNull();
    await A.backend.close();
  }, 900000);
});
