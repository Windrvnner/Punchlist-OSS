// @vitest-environment node
// Two PCs working on one data room at the same time, on the real backend: they never pay twice for the same work.
// Each indexes its own copy of the data room; the documents map on the sync folder makes one document of each file; the
// checks and the descriptions are claimed there, so only one PC does each.
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, put, pdf, pcApp, until, StandInService } from './kit';
import { isPickAsk, isPickForAsk, isDescribeAsk, itemsIn, listed, nth } from '../backend/reviewKit';
import { CreateDeal } from '../../src/app/commands/deals';
import { startIndexing } from '../../src/app/indexing';

const LIST = () => ({ broad: [{ id: 'b1', text: 'The term sheet is signed' }], product: [{ id: 'p1', text: 'The financial model has been audited' }], sector: [] });
const roots: string[] = []; afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

/** a stand-in model that is slow enough for two PCs to overlap, and counts what it is asked */
function model() {
  const svc = new StandInService(async (c) => {
    await new Promise((r) => setTimeout(r, 40));
    const ref = (name: string) => new RegExp(`^(doc_[0-9a-f]{24}): (?:.*/)?${name}`, 'm').exec(c.prompt)?.[1];
    if (isDescribeAsk(c as any)) return JSON.stringify({ summary: 'A document.', keywords: [] });
    if (isPickAsk(c as any) || isPickForAsk(c as any))
      return JSON.stringify({
        read: listed(c as any)
          .slice(0, 2)
          .map((r) => r.id),
      });
    const items = itemsIn(c as any);
    if (items.length)
      return JSON.stringify({
        items: items.map((it) =>
          /signed/.test(it.text)
            ? c.prompt.includes('Add "where"')
              ? {
                  id: it.tag,
                  result: 'ok',
                  where: [{ doc: ref('Term sheet.pdf') ?? nth(c as any, 1), page: 1, quote: 'signed' }],
                }
              : { id: it.tag, result: 'ok' }
            : { id: it.tag, result: 'more', need: 'The model audit report' },
        ),
      });
    return JSON.stringify({ text: 'ok', sources: [] });
  });
  return svc;
}

describe('two PCs on one data room at once', () => {
  it('both index their own copy; each file is one document in the shared map; the first pass and the descriptions run once, not once per PC', async () => {
    const root = tmp(); roots.push(root); const sync = path.join(root, 'sync');
    const vdrA = path.join(root, 'vdr-office'), vdrB = path.join(root, 'vdr-laptop');          // each PC's own copy of the data room
    for (const v of [vdrA, vdrB]) { put(v, 'Term sheet.pdf', pdf('Term sheet signed by the lenders', 2)); put(v, 'Credit agreement.pdf', pdf('Credit agreement', 3)); put(v, 'Archive/Term sheet copy.pdf', pdf('Term sheet signed by the lenders', 2)); }
    const svcA = model(), svcB = model();
    const A = await pcApp(root, 'Office', { service: svcA, checklist: LIST, user: 'adoe', shared: sync });
    const r = await A.store.dispatch(CreateDeal, { name: 'Wingtip', folders: [{ path: vdrA, label: 'Data room', files: 0, size: '' }] }); expect(r.ok).toBe(true);
    const dealId = Object.keys(A.store.get().deals)[0];
    // on the laptop the deal's folder sits somewhere else: the laptop is told where (the folder pointer kept on that PC)
    fs.mkdirSync(path.join(root, 'local-Laptop'), { recursive: true }); fs.writeFileSync(path.join(root, 'local-Laptop', 'folders.json'), JSON.stringify({ [dealId]: { [vdrA]: vdrB } }));
    const B = await pcApp(root, 'Laptop', { service: svcB, checklist: LIST, user: 'sroe', shared: sync });
    await B.backend.repo.sync!(); await B.store.boot(); expect(B.store.get().deals[dealId]).toBeTruthy();
    // both PCs index at the same moment, each from its own copy of the folder
    await Promise.all([startIndexing(A.store, dealId, A.store.get().deals[dealId].folders), startIndexing(B.store, dealId, B.store.get().deals[dealId].folders)]);
    await until('both to finish indexing', async () => { const a = await A.backend.docs.poll(dealId), b = await B.backend.docs.poll(dealId); return a.ok && a.value.done && b.ok && b.value.done; });
    await Promise.all([A.backend.idle(), B.backend.idle()]);
    // one map: two documents, not three files and not two PCs' worth
    const map = (A.backend.docs as any).records(dealId) as { docId: string; name: string; copies?: unknown[] }[];
    expect(map.length).toBe(2); expect(map.find((d) => d.name === 'Term sheet.pdf' || d.name === 'Term sheet copy.pdf')!.copies?.length).toBe(1);
    expect(((B.backend.docs as any).records(dealId) as unknown[]).length).toBe(2);
    // the checklist was checked once, by one PC; each document read was described once
    const checks = [...svcA.calls, ...svcB.calls].filter((c) => itemsIn(c as any).length).length;
    const one = [...svcA.calls, ...svcB.calls].filter((c) => isDescribeAsk(c as any)).length;
    expect(checks).toBe(1); expect(one).toBeLessThanOrEqual(2);
    // both PCs show the same results
    await A.store.refreshChecklist(dealId); await B.store.refreshChecklist(dealId);
    const rowsOf = (P: typeof A) => { const r = P.store.get().checklists[dealId]; return Array.isArray(r) ? r.map((x) => `${x.id}:${x.result}`).sort() : r; };
    expect(rowsOf(A)).toEqual(['b1:satisfied', 'p1:gap']); expect(rowsOf(B)).toEqual(rowsOf(A));
    A.backend.close(); B.backend.close();
  }, 60000);
});
