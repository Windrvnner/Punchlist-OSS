// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { CreateDeal, RemoveFolder } from '../../src/app/commands/deals';
import { addDealFolders, restoreDealFolder } from '../../src/app/dealFolders';
import { createDealFromForm } from '../../src/app/dealSetup';
import { fail, ok } from '../../src/domain/result';
import { pc } from './pcs';

const folder = { path: 'D:/Transactions/Lucerne/Financing', label: 'Financing', files: 163, size: '2.1 GB' };
const name = 'Full Recourse Refinancing';
const form = { name, folders: [folder], busy: false, error: '' };

async function prepare() {
  const { store } = pc('Indexing notice fixture', 'reviewer');
  await store.boot();
  return store;
}

function refuseIndexing(store: Awaited<ReturnType<typeof prepare>>) {
  const atStart = vi.fn();
  const index = vi.spyOn(store.services.docs, 'index').mockImplementation(async () => {
    atStart(store.get().ui.toasts.at(-1));
    return fail({ kind: 'notFound', message: 'The folder could not be opened on this PC' });
  });
  vi.spyOn(store.services.docs, 'poll').mockImplementation(async (dealId) => ok({
    done: true, log: [], folders: store.get().deals[dealId].folders,
  }));
  const refusalShown = new Promise<void>((resolve) => {
    const off = store.subscribe(({ ui }) => {
      if (ui.toasts.at(-1)?.text !== 'Couldn’t start indexing') return;
      off();
      resolve();
    });
  });
  return { atStart, index, refusalShown };
}

it('puts Retry Now ahead of the New Deal success notice even when indexing refuses immediately', async () => {
  const store = await prepare();
  const { atStart, refusalShown } = refuseIndexing(store);
  const created = await createDealFromForm(store, form);
  expect(created.deal?.name).toBe('Project ' + name);
  await refusalShown;
  expect(atStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    text: `Project ${name} created`, glyph: 'done',
  }));
  expect(store.get().ui.toasts.map(({ text }) => text)).toEqual([
    `Project ${name} created`, 'Couldn’t start indexing',
  ]);
  expect(store.get().ui.toasts.at(-1)?.action).toMatchObject({ label: 'Retry Now', run: expect.any(Function) });
});

it('puts Retry Now ahead of the Add Folders success notice', async () => {
  const store = await prepare();
  await store.dispatch(CreateDeal, { name, folders: [] }, { quiet: true });
  const dealId = Object.keys(store.get().deals)[0];
  const { atStart, index, refusalShown } = refuseIndexing(store);
  expect((await addDealFolders(store, dealId, [folder])).ok).toBe(true);
  await refusalShown;
  expect(atStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: '1 folder added' }));
  expect(store.get().ui.toasts.map(({ text }) => text)).toEqual(['1 folder added', 'Couldn’t start indexing']);
  const retry = store.get().ui.toasts.at(-1)?.action;
  expect(retry?.label).toBe('Retry Now');
  retry?.run?.();
  expect(index).toHaveBeenCalledTimes(2);
});

it('puts Retry Now ahead of an unfinished restore and keeps the restore Undo', async () => {
  const store = await prepare();
  await store.dispatch(CreateDeal, { name, folders: [folder] }, { quiet: true });
  const dealId = Object.keys(store.get().deals)[0];
  await store.dispatch(RemoveFolder, { dealId, path: folder.path }, { quiet: true });
  const [removed] = store.get().deals[dealId].removed;
  const { atStart, refusalShown } = refuseIndexing(store);
  expect(await restoreDealFolder(store, dealId, removed)).toBe(true);
  await refusalShown;
  expect(atStart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    text: 'Financing restored', action: { label: 'Undo', opId: expect.any(String) },
  }));
  expect(store.get().ui.toasts.map(({ text }) => text)).toEqual(['Financing restored', 'Couldn’t start indexing']);
  expect(store.get().ui.toasts.at(-1)?.action?.label).toBe('Retry Now');
});
