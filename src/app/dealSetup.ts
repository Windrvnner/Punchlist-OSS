import { CreateDeal } from './commands/deals';
import { createdRecord } from './createdRecord';
import type { DealForm } from './dealFolders';
import { likelyTwin, type TwinFound } from './dupes';
import type { Store } from './store';

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

/** Keep the snapshot taken at the first confirmation, while later edits can still land on another PC. */
export async function openDeleteDeal(store: Store, dealId: string) {
  store.ui({ deleteDeal: { dealId, typed: '', error: '' } });
  const result = await store.services.repo.seen?.();
  const dialog = store.get().ui.deleteDeal;
  if (result?.ok && dialog?.dealId === dealId && !dialog.seen) {
    store.ui({ deleteDeal: { ...dialog, seen: result.value } });
  }
}
