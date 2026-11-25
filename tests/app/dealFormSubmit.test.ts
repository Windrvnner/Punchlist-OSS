// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryLocal } from '../../src/adapters/local';
import { RecordIndexingProgress, RemoveFolder } from '../../src/app/commands/deals';
import { dealFolderRows, readDealFolder, type DealForm } from '../../src/app/dealFolders';
import { createDealFromForm, submitDealForm } from '../../src/app/dealSetup';
import { initializeKeptText } from '../../src/app/keptText';
import type { Store } from '../../src/app/store';
import { ok } from '../../src/domain/result';
import { pc } from './pcs';

const root = 'D:/Transactions/Project Lucérne/VDR/';
const SECTIONS = [
  'Corporate', 'Financing', 'Permitting', 'Insurance', 'Interconnection', 'Land', 'Offtake', 'Tax', 'Environmental',
  'Construction', 'Operations', 'Litigation', 'Employment', 'Real Estate', 'Regulatory', 'IP',
];
/** a data room split into 48 folders, three per section, as an end user's export lays it out */
const ROOM = SECTIONS.flatMap((section, at) => [1, 2, 3].map((part) => ({
  path: `${root}${String(at + 1).padStart(2, '0')} ${section}/${part}`,
  label: `${section} ${part}`, files: 40 + at * 7 + part, size: `${(0.2 + part / 10).toFixed(1)} GB`,
})));
const form: DealForm = {
  name: 'Lucérne', counterparty: 'Northwind Infrastructure', kinds: { sector: 'Renewable power' },
  folders: [], error: '', busy: false,
};

// the draft module makes its kept map when loaded, so it is loaded once kept text is set up
let Session: typeof import('../../src/app/newDealDraft').NewDealDraftSession;
beforeAll(async () => {
  initializeKeptText(new MemoryLocal());
  Session = (await import('../../src/app/newDealDraft')).NewDealDraftSession;
});

async function fixture() {
  const { store } = pc('Deal form fixture', 'reviewer');
  await store.boot();
  vi.spyOn(store.services.docs, 'index').mockResolvedValue(ok(undefined));
  vi.spyOn(store.services.docs, 'poll').mockResolvedValue(ok({ folders: [], log: [], done: true }));
  return store;
}

/** what the dialog passes: the form as it is now, and a read through the form's kept draft */
function submitting(store: Store, typed: string, existing?: Parameters<typeof submitDealForm>[1]['existing']) {
  const draft = new Session(!existing, () => {});
  const nd = store.get().ui.newDeal!;
  const typedTaken = vi.fn();
  const addPath = (path: string) => readDealFolder(store, draft, nd, path, existing);
  return { typedTaken, submit: { form: nd, typed, existing, addPath, typedTaken } };
}

describe('the Folders dialog rows', () => {
  it('joins indexing to 48 folders, keeps removed rows in place and says why each Restore is off', async () => {
    const store = await fixture();
    const { deal } = await createDealFromForm(store, { ...form, folders: ROOM });
    const id = deal!.id;
    const progress = ROOM.slice(0, 30).map((folder, at) => ({ ...folder, indexed: at * 2, reviewed: 0 }));
    await store.dispatch(RecordIndexingProgress, { dealId: id, folders: progress, log: [], done: false });
    for (const folder of [ROOM[4], ROOM[17], ROOM[46]]) {
      await store.dispatch(RemoveFolder, { dealId: id, path: folder.path });
    }
    const saved = store.get().deals[id];
    const { current, removed } = dealFolderRows(store.get(), saved, []);
    expect(current).toHaveLength(45);
    expect(current.map(({ folder }) => folder.path)).toEqual(saved.folders.map(({ path }) => path));
    expect(current.find(({ folder }) => folder.path === ROOM[3].path)?.indexed).toBe(6);
    expect(removed.map(({ gone }) => gone.path)).toEqual([ROOM[4].path, ROOM[17].path, ROOM[46].path]);
    expect(removed.every(({ restoreOff }) => restoreOff === undefined)).toBe(true);

    const waiting = [{ path: ROOM[17].path + '/Lender comments', label: 'Lender comments', files: 9, size: '0.1 GB' }];
    const blocked = dealFolderRows(store.get(), saved, waiting).removed;
    expect(blocked[1].restoreOff).toBe('Lender comments, waiting to be added, overlaps Land 3');
    expect(blocked[0].restoreOff).toBeUndefined();
    const locked = 'Lucérne has two versions. Choose one first';
    expect(dealFolderRows(store.get(), saved, waiting, locked).removed.map(({ restoreOff }) => restoreOff))
      .toEqual([locked, locked, locked]);
  });

  it('turns Restore off for a removed folder that now overlaps a folder on the deal', async () => {
    const store = await fixture();
    const { deal } = await createDealFromForm(store, { ...form, folders: ROOM.slice(0, 6) });
    await store.dispatch(RemoveFolder, { dealId: deal!.id, path: ROOM[2].path });
    const inner = { path: ROOM[2].path + '/Board minutes', label: 'Board minutes', files: 12, size: '0.1 GB' };
    store.ui({ newDeal: { ...form, folders: [inner], forDeal: deal!.id } });
    const added = await submitDealForm(store, submitting(store, '', store.get().deals[deal!.id]).submit);
    expect(added).toEqual({ done: true });
    const [row] = dealFolderRows(store.get(), store.get().deals[deal!.id], []).removed;
    expect(row.restoreOff).toBe('Board minutes, already on this deal, is inside Corporate 3');
  });
});

describe('submitting the deal form', () => {
  it('reads a typed path before creating, so the deal is made with that folder (#36)', async () => {
    const store = await fixture();
    vi.spyOn(store.services.docs, 'scanFolder').mockResolvedValue(ok({ files: 163, size: '2.1 GB' }));
    store.ui({ newDeal: { ...form, folders: ROOM.slice(0, 47) } });
    const { submit, typedTaken } = submitting(store, `  ${ROOM[47].path}  `);
    const created = await submitDealForm(store, submit);
    expect(created.done).toBe(true);
    expect(created.deal!.folders.map(({ path }) => path)).toEqual(ROOM.map(({ path }) => path));
    expect(typedTaken).toHaveBeenCalledOnce();
  });

  it('gives the form back, not busy and with the path still typed, when the typed path cannot be read', async () => {
    const store = await fixture();
    const scan = vi.spyOn(store.services.docs, 'scanFolder')
      .mockResolvedValue({ ok: false, error: { kind: 'unreachable', message: 'Offline' } });
    store.ui({ newDeal: { ...form, folders: ROOM.slice(0, 3) } });
    const { submit, typedTaken } = submitting(store, 'D:/Transactions/Gone');
    expect(await submitDealForm(store, submit)).toEqual({ done: false });
    expect(scan).toHaveBeenCalledOnce();
    expect(typedTaken).not.toHaveBeenCalled();
    expect(store.get().ui.newDeal).toMatchObject({ busy: false, error: 'Couldn’t read D:/Transactions/Gone' });
    expect(Object.keys(store.get().deals)).toHaveLength(0);
  });

  it('takes a typed path already on the list without reading it again', async () => {
    const store = await fixture();
    const scan = vi.spyOn(store.services.docs, 'scanFolder');
    store.ui({ newDeal: { ...form, folders: ROOM.slice(0, 3) } });
    const { submit, typedTaken } = submitting(store, ROOM[1].path.toUpperCase());
    const created = await submitDealForm(store, submit);
    expect(created.deal!.folders).toHaveLength(3);
    expect(scan).not.toHaveBeenCalled();
    expect(typedTaken).toHaveBeenCalledOnce();
  });

  it('asks about a likely twin first, and creates the deal once asked to anyway', async () => {
    const store = await fixture();
    await createDealFromForm(store, form);
    store.ui({ newDeal: { ...form } });
    const asked = await submitDealForm(store, submitting(store, '').submit);
    expect(asked).toEqual({ done: false });
    expect(store.get().ui.newDeal).toMatchObject({ busy: false, twin: { named: true } });
    const anyway = await submitDealForm(store, { ...submitting(store, '').submit, anyway: true });
    expect(anyway.done).toBe(true);
    expect(Object.keys(store.get().deals)).toHaveLength(2);
  });

  it('shows why folders could not be added to a deal and keeps them waiting', async () => {
    const store = await fixture();
    const { deal } = await createDealFromForm(store, { ...form, folders: ROOM.slice(0, 10) });
    const nested = { ...ROOM[4], path: ROOM[4].path + '/Side letters' };
    store.ui({ newDeal: { ...form, folders: [nested], forDeal: deal!.id } });
    const refused = await submitDealForm(store, submitting(store, '', store.get().deals[deal!.id]).submit);
    expect(refused).toEqual({ done: false });
    expect(store.get().ui.newDeal).toMatchObject({ busy: false, folders: [nested] });
    expect(store.get().ui.newDeal!.error).not.toBe('');
    expect(store.get().deals[deal!.id].folders).toHaveLength(10);
  });
});
