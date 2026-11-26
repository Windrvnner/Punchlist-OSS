import type { Deal, Folder } from '../domain/model';
import {
  AddFolders, FOLDER_LABEL_MAX, folderInside, foldersWithRemoved, overlap, RestoreFolder,
} from './commands/deals';
import { windowsPath } from '../domain/sheets';
import { liveFolders } from './indexing';
import type { NewDealDraftSession } from './newDealDraft';
import type { State, UiState } from './state';
import type { Store } from './store';

export type DealForm = NonNullable<UiState['newDeal']>;
type FolderName = Pick<Folder, 'path' | 'label'>;

/** A folder's own name, the last part of its path, whole. */
export function folderName(path: string) {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return (parts.at(-1) || path).trim();
}

/** A folder starts with its own name as its label, which is editable; a name too long for a label is never cut, so it starts with none. */
export function guessLabel(path: string) {
  const name = folderName(path);
  return name.length <= FOLDER_LABEL_MAX ? name : '';
}

export function folderListed(folders: readonly Pick<Folder, 'path'>[], path: string) {
  return folders.some((folder) => windowsPath(folder.path) === windowsPath(path));
}

/** Restoring a folder must leave the folders already waiting to be added usable. */
export function waitingFolderOverlap(waiting: FolderName[], folder: FolderName) {
  const over = waiting.find((entry) => foldersOverlap(entry.path, folder.path));
  return over ? `${over.label || over.path}, waiting to be added, overlaps ${folder.label || folder.path}` : null;
}

function foldersOverlap(first: string, second: string) {
  return folderInside(first, second) || folderInside(second, first);
}

type Removed = Deal['removed'][number];

/**
 * The Folders dialog's rows: the deal's folders with their indexing count, then the removed ones, each with why
 * Restore is off when it is (the deal's details are locked, or the folder overlaps one on the deal or waiting).
 */
export function dealFolderRows(
  state: Pick<State, 'indexing'>, deal: Deal, waiting: FolderName[], locked?: string | false | null,
) {
  const live = liveFolders(state, deal);
  const rows = foldersWithRemoved(deal);
  const current = rows.flatMap(({ f, gone }) => gone ? [] : [{
    folder: f, indexed: live.find((folder) => folder.path === f.path)?.indexed,
  }]);
  const removed = rows.flatMap(({ gone }) => gone
    ? [{ gone, restoreOff: restoreOff(deal, waiting, gone, locked) }] : []);
  return { current, removed };
}

function restoreOff(deal: Deal, waiting: FolderName[], gone: Removed, locked?: string | false | null) {
  return locked || overlap(deal.folders, gone) || waitingFolderOverlap(waiting, gone) || undefined;
}

export async function restoreDealFolder(store: Store, dealId: string, removed: Removed) {
  const { at, ...folder } = removed;
  const result = await store.dispatch(RestoreFolder, { dealId, folder, at, indexHere: true });
  return result.ok;
}

export function addDealFolders(store: Store, dealId: string, folders: DealForm['folders']) {
  return store.dispatch(AddFolders, { dealId, folders, indexHere: true }, { idempotencyKey: 'nd-create', quiet: true });
}

/** A scan that outlives this form can still land in its kept draft. */
export async function readDealFolder(
  store: Store, draft: NewDealDraftSession, form: DealForm, path: string, existing?: Deal,
) {
  path = path.trim();
  if (!path) return;
  const folders = () => [...(store.get().ui.newDeal?.folders ?? form.folders), ...(existing?.folders ?? [])];
  if (folderListed(folders(), path) || draft.isReading(path)) {
    store.toast('That folder is already on the list');
    return;
  }
  const over = folders().find((folder) => foldersOverlap(path, folder.path));
  if (over) {
    store.toast(folderInside(path, over.path) ? `That folder is inside ${over.label || over.path}, already on the list`
      : `${over.label || over.path}, already on the list, is inside that folder`);
    return;
  }
  const removed = existing?.removed.find((folder) => windowsPath(folder.path) === windowsPath(path));
  if (existing && removed) return restoreDealFolder(store, existing.id, removed);

  draft.started(path);
  const result = await store.services.docs.scanFolder(path);
  const folder = result.ok ? { path, label: guessLabel(path), ...result.value } : null;
  if (!draft.finished(path, folder)) return false;
  if (!folder) {
    patchDealForm(store, { error: `Couldn’t read ${path}` });
    return false;
  }
  patchDealForm(store, { error: '' });
  if (!folderListed(folders(), path)) {
    store.ui((ui) => ui.newDeal ? { newDeal: { ...ui.newDeal, folders: [...ui.newDeal.folders, folder] } } : {});
  }
  return true;
}

export function patchDealForm(store: Store, patch: Partial<DealForm>) {
  store.ui((ui) => ({ newDeal: ui.newDeal ? { ...ui.newDeal, ...patch } : null }));
}

/** Null asks the shell to open its file input. An empty selection leaves the form as it was. */
export function pickDealFolders(store: Store) {
  return store.services.fs.pickFolders?.().then((result) => result.ok ? result.value : []) ?? null;
}

export function chosenDealFolder(store: Store, files: File[], folders: DealForm['folders']) {
  if (!files.length) return;
  const first = files[0];
  const real = store.services.fs.pathFor?.(first);
  const root = real ? real.replace(/[\\/][^\\/]*$/, '') : (first.webkitRelativePath || first.name).split('/')[0];
  if (folderListed(folders, root)) {
    store.toast('That folder is already on the list');
    return;
  }
  const bytes = files.reduce((total, file) => total + file.size, 0);
  return { path: root, label: guessLabel(root), files: files.length, size: `${(bytes / 1e9).toFixed(1)} GB` };
}

export function droppedFolderPaths(store: Store, files: File[], entries: { name: string }[]) {
  const fs = store.services.fs;
  if (fs.pathFor) return files.map((file) => fs.pathFor!(file));
  return (entries.length ? entries : files).map(({ name }) => name);
}
