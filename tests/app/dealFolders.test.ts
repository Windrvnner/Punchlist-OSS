// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import {
  AddFolders, DeleteDeal, matchesDealName, RecordIndexingProgress, RemoveFolder,
} from '../../src/app/commands/deals';
import {
  addDealFolders, chosenDealFolder, droppedFolderPaths, pickDealFolders,
  readDealFolder, restoreDealFolder, waitingFolderOverlap, type DealForm,
} from '../../src/app/dealFolders';
import { createDealFromForm, findDealTwin, openDeleteDeal } from '../../src/app/dealSetup';
import { matchingDealKinds } from '../../src/app/dupes';
import { initializeKeptText } from '../../src/app/keptText';
import { fail, ok, type Result } from '../../src/domain/result';
import { PORTFOLIO_ASSETS } from '../fixtures/portfolioQuestions';
import { pc } from './pcs';

const root = 'D:/Transactions/Project Lucérne/VDR/';
const debt = { path: root + 'Financing', label: 'Financing', files: 163, size: '2.1 GB' };
const permits = { path: root + 'Permitting', label: 'Permitting', files: 98, size: '1.4 GB' };
const insurance = { path: root + 'Insurance', label: 'Insurance', files: 37, size: '0.4 GB' };
const form: DealForm = {
  name: 'Lucérne', counterparty: 'Northwind Infrastructure', kinds: { sector: 'Renewable power' },
  folders: [], error: '', busy: false,
};

async function fixture() {
  const { store, repo } = pc('Deal folder fixture', 'reviewer');
  await store.boot();
  return { store, repo };
}

beforeAll(() => initializeKeptText(new MemoryLocal()));

describe('folder actions run without a window', () => {
  it('uses the native picker and path service, with the same folder-input and drop fallbacks', async () => {
    const { store } = await fixture();
    const fs = store.services.fs;
    const file = new File([new Uint8Array([7])], 'Interconnection agreement.pdf');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Interconnection/Interconnection agreement.pdf' });
    expect(pickDealFolders(store)).toBeNull();
    expect(chosenDealFolder(store, [file], [])).toEqual({
      path: 'Interconnection', label: 'Interconnection', files: 1, size: '0.0 GB',
    });
    expect(droppedFolderPaths(store, [file], [{ name: 'Due diligence' }])).toEqual(['Due diligence']);
    expect(droppedFolderPaths(store, [file], [])).toEqual([file.name]);
    fs.pickFolders = vi.fn(async () => ok([debt.path, permits.path]));
    fs.pathFor = vi.fn((picked: File) => debt.path + '/' + picked.name);
    await expect(pickDealFolders(store)).resolves.toEqual([debt.path, permits.path]);
    expect(chosenDealFolder(store, [file], [])?.path).toBe(debt.path);
    expect(chosenDealFolder(store, [file], [debt])).toBeUndefined();
    expect(droppedFolderPaths(store, [file], [{ name: 'Due diligence' }])).toEqual([debt.path + '/' + file.name]);
    fs.pickFolders = async () => fail({ kind: 'unreachable', message: 'Folder picker closed' });
    await expect(pickDealFolders(store)).resolves.toEqual([]);
  });

  it('refuses same and nested paths before reading and keeps a late scan with the typed draft', async () => {
    const { store } = await fixture();
    const { keptNewDeal, NewDealDraftSession } = await import('../../src/app/newDealDraft');
    const draft = new NewDealDraftSession(true, () => {});
    const open = { ...form, folders: [debt] };
    draft.open(open);
    store.ui({ newDeal: open });
    let finish!: (value: Result<{ files: number; size: string }>) => void;
    const scan = vi.spyOn(store.services.docs, 'scanFolder').mockImplementation(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    await readDealFolder(store, draft, open, debt.path.toUpperCase() + '/');
    await readDealFolder(store, draft, open, debt.path + '/Lender comments');
    expect(store.get().ui.toasts.at(-1)?.text).toBe('That folder is inside Financing, already on the list');
    await readDealFolder(store, draft, open, root);
    expect(store.get().ui.toasts.at(-1)?.text).toBe('Financing, already on the list, is inside that folder');
    expect(scan).not.toHaveBeenCalled();
    expect(waitingFolderOverlap([debt], { path: root, label: 'Data room' })).toBe(
      'Financing, waiting to be added, overlaps Data room',
    );
    expect(waitingFolderOverlap([debt], permits)).toBeNull();

    const reading = readDealFolder(store, draft, open, permits.path);
    await readDealFolder(store, draft, open, permits.path);
    expect(scan).toHaveBeenCalledExactlyOnceWith(permits.path);
    draft.keep(open, 'D:/Transactions/Still typing');
    store.ui({ newDeal: null });
    draft.close();
    finish(ok({ files: permits.files, size: permits.size }));
    await expect(reading).resolves.toBe(false);
    expect(keptNewDeal()).toMatchObject({
      name: 'Lucérne', path: 'D:/Transactions/Still typing', folders: [debt, permits], reading: [],
    });
  });

  it('indexes committed folders by path, resumes an unfinished restore and skips a complete one', async () => {
    const { store, repo } = await fixture();
    const committed = new Map<string, unknown>();
    const index = vi.spyOn(store.services.docs, 'index').mockImplementation(async (dealId, folders) => {
      const stored = await repo.get('deal', dealId);
      for (const folder of folders) committed.set(folder.path, stored.ok && stored.value?.envelope.data);
      return ok(undefined);
    });
    vi.spyOn(store.services.docs, 'poll').mockResolvedValue(ok({ folders: [], log: [], done: true }));
    const { deal } = await createDealFromForm(store, { ...form, folders: [debt, permits, insurance] });
    expect(deal).toBeDefined();
    const id = deal!.id;
    expect(index.mock.calls.map(([, folders]) => folders.map(({ path }) => path))).toEqual([
      [debt.path, permits.path, insurance.path],
    ]);
    await vi.waitFor(() => expect(committed.get(permits.path)).toMatchObject({
      id, folders: expect.arrayContaining([expect.objectContaining({ path: permits.path })]),
    }));
    await store.dispatch(RemoveFolder, { dealId: id, path: permits.path });
    expect((await addDealFolders(store, id, [permits])).ok).toBe(true);
    expect(store.get().deals[id].folders.map(({ path }) => path)).toEqual([debt.path, permits.path, insurance.path]);
    expect(index.mock.calls[1][1]).toEqual([{ ...permits, indexed: 0, reviewed: 0 }]);
    const nested = { ...debt, path: debt.path + '/Term sheets' };
    const refused = await store.dispatch(AddFolders, { dealId: id, folders: [nested], indexHere: true });
    expect(refused.ok).toBe(false);
    expect(index).toHaveBeenCalledTimes(2);

    const completed = { ...debt, indexed: debt.files, reviewed: 12 };
    const partial = { ...insurance, indexed: 15, reviewed: 2 };
    await store.dispatch(RecordIndexingProgress, { dealId: id, folders: [completed, partial], log: [], done: false });
    await store.dispatch(RemoveFolder, { dealId: id, path: debt.path });
    await store.dispatch(RemoveFolder, { dealId: id, path: insurance.path });
    const [finished, unfinished] = store.get().deals[id].removed;
    expect(await restoreDealFolder(store, id, finished)).toBe(true);
    expect(index).toHaveBeenCalledTimes(2);
    const existing = store.get().deals[id];
    const { NewDealDraftSession } = await import('../../src/app/newDealDraft');
    const draft = new NewDealDraftSession(false, () => {});
    await expect(readDealFolder(store, draft, form, unfinished.path, existing)).resolves.toBe(true);
    expect(index.mock.calls[2][1]).toEqual([partial]);
    expect(store.get().deals[id].removed).toEqual([]);
  });
});

describe('deal checks with the repository and document service', () => {
  it('checks the data room across over 100 deals, and still checks the name after a refused room read', async () => {
    const { store } = await fixture();
    const stages = [
      'Construction Loan', 'Operating Portfolio', 'Refinancing', 'Tax Equity', 'Asset Acquisition',
      'Holdco Loan', 'Sponsor Recapitalization', 'Development Facility', 'Grid Upgrade',
    ];
    for (const asset of PORTFOLIO_ASSETS) {
      for (const stage of stages) {
        const created = await createDealFromForm(store, { ...form, name: `${asset} ${stage}` });
        expect(created.deal).toBeDefined();
      }
    }
    const { deal } = await createDealFromForm(store, form);
    const ids = Object.keys(store.get().deals);
    expect(ids.length).toBeGreaterThan(100);
    const room = { dealId: ids[0], files: 540, matched: 478 };
    const sameRoom = vi.spyOn(store.services.docs, 'sameRoom').mockResolvedValue(ok([room]));
    await expect(findDealTwin(store, { ...form, folders: [debt] })).resolves.toEqual({
      dealId: ids[0], named: false, room,
    });
    expect(sameRoom).toHaveBeenCalledExactlyOnceWith([debt.path], ids);
    sameRoom.mockResolvedValue(fail({ kind: 'unreachable', message: 'The room could not be reached' }));
    await expect(findDealTwin(store, { ...form, folders: [debt] })).resolves.toEqual({ dealId: deal!.id, named: true });
    expect(matchingDealKinds({ product: ' DEBT ', sector: ' ', technology: 'Solar' }, {
      product: 'Debt', sector: '', technology: 'Wind',
    })).toEqual(['product']);
  });

  it('captures what the PC saw when deletion opened and shares its name match with the command', async () => {
    const { store, repo } = await fixture();
    const { deal } = await createDealFromForm(store, form);
    const match = '  Project   Luce\u0301rne  ';
    expect(matchesDealName(match, deal!.name)).toBe(true);
    expect(matchesDealName('project lucérne', deal!.name)).toBe(false);
    const before = await repo.seen();
    const opening = openDeleteDeal(store, deal!.id);
    expect(store.get().ui.deleteDeal).toMatchObject({ dealId: deal!.id, typed: '' });
    store.ui((ui) => ({ deleteDeal: { ...ui.deleteDeal!, typed: match } }));
    await opening;
    expect(store.get().ui.deleteDeal).toMatchObject({ typed: match, seen: before.ok && before.value });
    const wrong = await store.dispatch(DeleteDeal, { dealId: deal!.id, typedName: 'Lucérne' }, { quiet: true });
    expect(wrong.ok).toBe(false);
    expect(store.get().deals[deal!.id]).toBeDefined();
    expect((await store.dispatch(DeleteDeal, { dealId: deal!.id, typedName: match })).ok).toBe(true);
  });
});
