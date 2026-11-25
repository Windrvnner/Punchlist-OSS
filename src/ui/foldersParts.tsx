/**
 * The parts of the Folders dialog (the Folders use of NewDealDialog) that New deal does not have: the deal's folders
 * and its removed ones, the folders waiting to be added under To Add, and the footer whose one filled action is
 * Choose Folders… until folders wait, then Add and Index. The rows are FolderRow.
 */
import type { ComponentChildren } from 'preact';
import { useAppState, useStore } from './hooks';
import { DropZone } from './fileDrop';
import { EditField, ReadOnlyContext } from './editField';
import { readFolderLabel } from '../app/fieldDrafts';
import { FolderCount, FolderRow, NameTip, RemoveX } from './folderRow';
import { plural } from './counts';
import { EditDeal, FOLDER_LABEL_MAX } from '../app/commands/deals';
import { dealFolderRows } from '../app/dealFolders';
import type { Deal, Folder } from '../domain/model';

type Removed = Deal['removed'][number];
type Waiting = { path: string; label: string; files: number; size: string };

type DealFoldersProps = {
  deal: Deal;
  /** why the names are read-only (the deal is in two versions), if they are */
  locked?: string | false | null;
  restore: (gone: Removed) => void;
  /** the × asks first, in the app's confirm */
  ask: (f: Folder) => void;
};

type FoldersBodyProps = DealFoldersProps & {
  /** the folders waiting under To Add; one that overlaps a removed folder turns its Restore off */
  waiting: Waiting[];
  change: (folders: Waiting[]) => void;
  onDrop: (e: DragEvent) => void;
  pastePath: () => void;
  /** the path field, once "paste a path" was pressed */
  paste: ComponentChildren;
};

/**
 * The dialog's body: the deal's folders, those waiting under To Add, then the drop area. It is the one part that
 * scrolls, so the title, the × and the footer stay in reach and nothing scrolls under them.
 */
export function FoldersBody({ waiting, change, onDrop, pastePath, paste, ...folders }: FoldersBodyProps) {
  return (
    <div class="fdbody">
      <DealFolders {...folders} waiting={waiting} />
      {waiting.length > 0 && <WaitingFolders folders={waiting} change={change} />}
      <DropZone id="nd-drop" compact onDrop={onDrop}>
        Drop folders here, or{' '}
        <button type="button" class="linkb" id="nd-paste" onClick={pastePath}>paste a path</button>
      </DropZone>
      {paste}
    </div>
  );
}

/** The deal's folders, then the removed ones under their own heading, each with Restore */
function DealFolders({ deal, locked, waiting, restore, ask }: DealFoldersProps & { waiting: Waiting[] }) {
  const { current, removed } = dealFolderRows(useAppState(), deal, waiting, locked);
  if (!current.length && !removed.length) return null;
  return (
    <ReadOnlyContext.Provider value={locked || null}>
      <div class="fdlist" id="folders">
        {current.length > 0 && <div class="fdgroup">{current.map(({ folder, indexed }) => (
          <DealFolderRow key={folder.path} deal={deal} folder={folder} indexed={indexed} locked={!!locked} ask={ask} />
        ))}</div>}
        {removed.length > 0 && <div class="fdsec" id="folders-removed" role="heading" aria-level={3}>Removed</div>}
        {removed.length > 0 && <div class="fdgroup">{removed.map(({ gone, restoreOff }) => (
          <FolderRow key={gone.path} path={gone.path} gone name={<span class="fdname">{gone.label}</span>}
            action={<Restore locked={restoreOff} path={gone.path} run={() => restore(gone)} />} />
        ))}</div>}
      </div>
    </ReadOnlyContext.Provider>
  );
}

/** A folder on the deal: its name is changed in place, and its × asks before taking it off */
function DealFolderRow({ deal, folder, indexed, locked, ask }: {
  deal: Deal;
  folder: Folder;
  indexed?: number;
  locked: boolean;
  ask: (f: Folder) => void;
}) {
  const store = useStore();
  const name = (
    <NameTip readOnly={locked}>
      <EditField keep={`${deal.id}:label:${folder.path}`} read={readFolderLabel(deal.id, folder.path)}
        label={`Label for ${folder.path}`} placeholder="Label" className="fdname" maxLength={FOLDER_LABEL_MAX}
        value={folder.label} rev={deal.rev}
        commit={(v, over) => store.dispatch(EditDeal, { dealId: deal.id, folder: { path: folder.path, label: v } },
          { quiet: true, over })} />
    </NameTip>
  );
  return (
    <FolderRow path={folder.path} name={name} count={<FolderCount files={folder.files} indexed={indexed} />}
      action={<RemoveX label={`Remove ${folder.path}`} tip="Remove from this deal" disabled={locked}
        onClick={() => ask(folder)} />} />
  );
}

/** The folders waiting to be added, under To Add: renamed in the row, and taken off by × without asking */
function WaitingFolders({ folders, change }: { folders: Waiting[]; change: (folders: Waiting[]) => void }) {
  const rename = (i: number, label: string) => change(folders.map((f, j) => j === i ? { ...f, label } : f));
  return (
    <div class="fdlist" id="folders-waiting">
      <div class="fdsec" role="heading" aria-level={3}>To Add</div>
      <div class="fdgroup">{folders.map((f, i) => {
        const name = (
          <NameTip>
            <input class="fdname" aria-label="Label" maxLength={FOLDER_LABEL_MAX} value={f.label}
              onInput={(e) => rename(i, (e.currentTarget as HTMLInputElement).value)} />
          </NameTip>
        );
        const count = <span class="cnt">{plural(f.files, 'file')} · {f.size}</span>;
        const drop = () => change(folders.filter((_, j) => j !== i));
        return <FolderRow key={f.path} path={f.path} name={name} count={count}
          action={<RemoveX label={`Remove ${f.path}`} onClick={drop} />} />;
      })}</div>
    </div>
  );
}

/**
 * The footer: one filled action. With nothing waiting it is Choose Folders…; once folders wait, Choose Folders… is
 * plain beside Add and Index. What went wrong is said at its left.
 */
export function FoldersActs({ error, waiting, busy, browse, add }: {
  error: string;
  waiting: boolean;
  busy: boolean;
  browse: () => void;
  add: () => void;
}) {
  return (
    <div class="acts">
      {error && <p class="emptyline err" id="nd-err" role="alert">{error}</p>}
      <button type="button" class={waiting ? 'btn sm' : 'btn sm pri'} id="nd-browse"
        data-autofocus={waiting ? undefined : true} onClick={browse}>Choose Folders…</button>
      {waiting && <button type="button" class="btn sm pri" id="nd-create" disabled={busy}
        onClick={add}>Add and Index</button>}
    </div>
  );
}

/**
 * Restore on a removed folder's row. When it cannot be pressed (the deal is in two versions, or a folder added
 * since overlaps this one), why is on the wrapper, as a disabled button takes no pointer, and read out with it.
 */
function Restore({ locked, path, run }: { locked?: string | false; path: string; run: () => void }) {
  const why = locked || undefined;
  return (
    <span class="needs put" title={why ?? 'Restore to this deal'}>
      <button type="button" class="btn sm" aria-label={`Restore ${path}`} disabled={!!why} aria-description={why}
        onClick={run}>Restore</button>
    </span>
  );
}
