/**
 * The rows of the Folders dialog (the Folders use of NewDealDialog): each folder is a list
 * row, as in Finder, with the folder icon, its name over its full path, the count and the × (or Restore). The deal's
 * folders, the removed ones and the ones waiting to be added all use the same row.
 */
import type { ComponentChildren } from 'preact';
import { plural } from './counts';
import { Icon } from './icons';
import { showTip, hideTip } from './tip';

/** a path cut at its start, so its end, where folders differ, stays in view; whole on hover */
export function StartCutPath({ path, className }: { path: string; className: string }) {
  return <span class={className} title={path}><bdi>{path}</bdi></span>;
}

/** One folder: icon, name over path, count, then the row's action (× or Restore) */
export function FolderRow({ path, name, count, action, gone }: {
  path: string;
  name: ComponentChildren;
  /** the count column; a removed folder has none, as Restore takes its place */
  count?: ComponentChildren;
  action: ComponentChildren;
  gone?: boolean;
}) {
  return (
    <div class={gone ? 'fdrow gone' : 'fdrow'} data-removed={gone ? '' : undefined}>
      <span class="fdicon"><Icon name="folder" size={16} /></span>
      <span class="fdstack">{name}<StartCutPath path={path} className="p" /></span>
      {count}
      {action}
    </div>
  );
}

/** The quiet count: "1,284 files", or "2,148 of 5,190 indexed" while the folder is still being indexed */
export function FolderCount({ files, indexed }: { files: number; indexed?: number }) {
  if (indexed !== undefined && indexed < files) {
    const words = `${indexed.toLocaleString('en-US')} of ${files.toLocaleString('en-US')} indexed`;
    return <span class="cnt ix" title="Indexing">{words}</span>;
  }
  return <span class="cnt">{plural(files, 'file')}</span>;
}

/** The × that takes a folder off the list */
export function RemoveX({ label, tip, disabled, onClick }: {
  label: string;
  tip?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" class="x" aria-label={label} title={tip} disabled={disabled} onClick={onClick}>
      <Icon name="close" size={12} />
    </button>
  );
}

/**
 * The name, editable in place: "Edit name" in the app's tooltip on hover and on keyboard focus. While the deal's
 * names are read-only the field's own reason shows instead, so no tooltip is added then.
 */
export function NameTip({ readOnly, children }: { readOnly?: boolean; children: ComponentChildren }) {
  if (readOnly) return <span class="fdname-tip">{children}</span>;
  const field = (e: Event) => (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.fdname');
  const show = (e: Event, delayMs?: number) => {
    const el = field(e);
    if (el) showTip(el, 'Edit name', delayMs);
  };
  const hide = (e: Event) => {
    const el = field(e);
    if (el) hideTip(el);
  };
  return (
    <span class="fdname-tip" onMouseEnter={(e) => show(e)} onMouseLeave={hide}
      onFocusIn={(e) => show(e, 0)} onFocusOut={hide}>
      {children}
    </span>
  );
}
