// @vitest-environment node
// A data room that drops while a check is under way. Its own file, so that each runs in a worker of its own:
// two checks of 2,000 items on the real backend use more memory than one worker should hold. The real backend on real folders, one PC, at deal scale; only the model is a stand-in.
import { describe, it, expect } from 'vitest';
import { pcApp, newDeal } from './kit';
import { N_ITEMS, N_DOCS, LIST, model, room, drop, back, val, recs, tally, saidLeft } from './awayKit';

describe('a data room that cannot be reached for a while', () => {
  it('a check it drops out of part-way keeps what it had settled, leaves the rest as could not be checked, and is not a complete check', async () => {
    const { root, vdr } = room(); let replies = NaN;                                  // counted from when the check under test starts
    const A = await pcApp(root, 'Office', { service: model(() => { if (++replies === 40) drop(vdr); }), checklist: LIST });
    const dealId = await newDeal(A, 'Proseware', vdr, 150_000);
    expect(await tally(A, dealId)).toEqual({ satisfied: N_ITEMS });
    replies = 0;                                                                             // at the check's 40th reply the drive drops, while the model reads
    const part = val(await A.backend.ai.checkAll!({ dealId, deep: true })); await A.backend.idle(); const left = part.unchecked!.items;
    expect(part.at).toBeNull(); expect(left).toBeGreaterThan(0); expect(left).toBeLessThan(N_ITEMS);
    const now = await tally(A, dealId); expect(now.unsettled).toBe(left); expect(now.satisfied).toBe(N_ITEMS - left);
    expect(recs(A, dealId).length).toBe(N_DOCS); expect(saidLeft(A)).toBe(false);
    back(vdr); replies = NaN;
    const rest = val(await A.backend.ai.checkAll!({ dealId, only: 'left' })); await A.backend.idle();   // "Check the N left out"
    expect(rest.items).toBe(left); expect(rest.at).not.toBeNull(); expect(rest.unchecked).toEqual({ items: 0, findings: 0 });
    expect(await tally(A, dealId)).toEqual({ satisfied: N_ITEMS });
    await A.backend.close();
  }, 600000);
});
