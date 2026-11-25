import { CreateDeal } from './commands/deals';
import { createdRecord } from './createdRecord';
import { addDealFolders, folderListed, patchDealForm, type DealForm } from './dealFolders';
import { likelyTwin, type TwinFound } from './dupes';
import type { Store } from './store';
import type { Deal } from '../domain/model';

/** The data-room comparison is advisory. A refused read still allows the name and counterparty match. */
export async function findDealTwin(store: Store, form: Pick<DealForm, 'name' | 'counterparty' | 'folders'>) {
  const { folders } = form;
  const room = folders.length && store.services.docs.sameRoom
    ? await store.services.docs.sameRoom(folders.map(({ path }) => path), Object.keys(store.get().deals))
    : null;
  const twin = likelyTwin(store.get(), form, room?.ok ? room.value : []);
  if (!twin) return null;
  return { dealId: twin.deal.id, ...(twin.room ? { room: twin.room } : {}), named: twin.named } satisfies TwinFound;
}

export async function createDealFromForm(store: Store, form: DealForm) {
  const { name, folders, kinds, counterparty } = form;
  const result = await store.dispatch(CreateDeal, {
    name, folders, ...kinds, indexHere: true,
    ...(counterparty?.trim() ? { counterparty } : {}),
  }, { idempotencyKey: 'nd-create', quiet: true });
  if (!result.ok) {
    const { error } = result;
    const message = error.kind === 'invalid' ? Object.values(error.fields ?? {})[0] ?? error.message : error.message;
    return { message };
  }
  const deal = createdRecord(store.get(), result.value.opId, 'deals');
  if (deal) return { deal };
  return { message: 'The deal was created but could not be opened. Find it in the list on the left.' };
}

type DealFormSubmit = {
  form: DealForm;
  /** the path field as it stands: a path typed but not yet added is part of the deal */
  typed: string;
  /** the deal the Folders dialog adds to; none on the New deal form */
  existing?: Deal;
  /** the deal-twin ask was answered: create it anyway */
  anyway?: boolean;
  /** reads a path into the form, through its kept draft; false or nothing when it was not added */
  addPath: (path: string) => Promise<boolean | undefined>;
  /** the typed path is now on the form, so its field can be cleared */
  typedTaken: () => void;
};

/**
 * Create, or Add and Index: add the typed path first (#36), then add the folders to the deal, or ask about a
 * likely twin, or create the deal. The form stays busy from the press until the deal is written. Done is false
 * when the form stays open (a failed read, a twin to ask about, or an error it now shows).
 */
export async function submitDealForm(store: Store, submit: DealFormSubmit): Promise<{ done: boolean; deal?: Deal }> {
  const { form, existing, anyway } = submit;
  patchDealForm(store, { busy: true, error: '' });
  if (!(await takeTypedPath(submit))) {
    patchDealForm(store, { busy: false });
    return { done: false };
  }
  const folders = store.get().ui.newDeal?.folders ?? form.folders;
  if (existing) {
    const result = await addDealFolders(store, existing.id, folders);
    if (result.ok) return { done: true };
    patchDealForm(store, { busy: false, error: result.error.message });
    return { done: false };
  }
  if (!anyway) {
    const twin = await findDealTwin(store, { name: form.name, counterparty: form.counterparty, folders });
    if (twin) {
      patchDealForm(store, { busy: false, twin });
      return { done: false };
    }
  }
  const { deal, message } = await createDealFromForm(store, { ...form, folders });
  if (deal) return { done: true, deal };
  patchDealForm(store, { busy: false, error: message });
  return { done: false };
}

/** A typed path already listed needs no read. False when it could not be read, and the form stops. */
async function takeTypedPath({ form, existing, typed, addPath, typedTaken }: DealFormSubmit) {
  const path = typed.trim();
  if (!path) return true;
  const listed = folderListed([...form.folders, ...(existing?.folders ?? [])], path);
  if (!listed && !(await addPath(path))) return false;
  typedTaken();
  return true;
}

/** Keep the snapshot taken at the first confirmation, while later edits can still land on another PC. */
export async function openDeleteDeal(store: Store, dealId: string) {
  store.ui({ deleteDeal: { dealId, typed: '', error: '' } });
  const result = await store.services.repo.seen?.();
  const dialog = store.get().ui.deleteDeal;
  if (result?.ok && dialog?.dealId === dealId && !dialog.seen) {
    store.ui({ deleteDeal: { ...dialog, seen: result.value } });
  }
}
