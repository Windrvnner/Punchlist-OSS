/**
 * Locate deal folders: the top folders still missing on this PC, each with Locate…, and those found, with the folder
 * they were pointed at. Pointing at one top folder places every deal folder under it. Nothing is used until "Use These
 * Folders".
 */
import { useAppState, useStore } from './hooks';
import type { ComponentChildren } from 'preact';
import { Icon } from './icons';
import { StartCutPath } from './folderRow';
import { Modal } from './dialogs';
import { closeLocate, locate, locateFoldersView, useLocated } from '../app/relink';

/** "42 folders · Proseware, Wingtip, Alpine and 8 more": the deals named, the full list on hover. A folder still to be
 *  located says why first, in red: "Not found on this PC", or "Files not found" for one that opens empty. */
function Deals({ n, deals, why }: { n: number; deals: string[]; why?: string }) {
  const names = deals.length > 4 ? `${deals.slice(0, 3).join(', ')} and ${deals.length - 3} more` : deals.join(', ');
  const line = `${n.toLocaleString('en-US')} folder${n === 1 ? '' : 's'} · ${names}`;
  return <div class="p" title={deals.join(', ')}>{why && <><span class="lfwhy">{why}</span> · </>}{line}</div>;
}

/** One row: the 16px glyph (the red warning on a folder to locate, the folder icon on one found), the path cut at
 *  its start over the line of deals, and the row's button */
function LocateRow({ top, glyph, path, children, button }: {
  top: string;
  glyph: 'warn' | 'folder';
  path: string;
  children: ComponentChildren;
  button: ComponentChildren;
}) {
  return (
    <div class={glyph === 'warn' ? 'lfrow miss' : 'lfrow'} data-top={top}>
      <span class="lficon"><Icon name={glyph} size={16} /></span>
      <span class="t"><StartCutPath path={path} className="n" />{children}</span>
      <span class="b">{button}</span>
    </div>
  );
}

/**
 * The folders still to locate come first, each saying why in red, with Locate…; then every folder found so far,
 * listed openly under "Found 42", each with Change….
 * The footer says only what went wrong.
 */
export function LocateDialog() {
  const store = useStore(); const s = useAppState(); const l = s.ui.locate; if (!l) return null;
  const close = () => closeLocate(store);
  const { found, missing, located } = locateFoldersView(s);
  const button = (top: string, words: string, label?: string) => (
    <button type="button" class="btn sm" aria-label={label} disabled={l.busy}
      onClick={() => void locate(store, top)}>{words}</button>
  );
  return (
    <Modal onClose={close} label="Locate deal folders" blur className="sdlg imdlg lfdlg">
      <div class="shead"><h2 id="lf-title">Locate Deal Folders</h2><button type="button" class="x" aria-label="Close"
        title="Close (Esc)" onClick={close}><Icon name="close" size={15} /></button></div>
      <div class="lfbody" aria-busy={l.busy}>
        {missing.map((t) => (
          <LocateRow key={t.top} top={t.top} glyph="warn" path={t.top} button={button(t.top, 'Locate…')}>
            <Deals n={t.count} deals={t.deals} why={t.why} />
          </LocateRow>))}
        {located.length > 0 && <div class="lflbl">Found<span class="lfn">{found.toLocaleString('en-US')}</span></div>}
        {located.map((x) => (
          <LocateRow key={x.top} top={x.top} glyph="folder" path={x.picked}
            button={button(x.top, 'Change…', `Change ${x.top}…`)}>
            <Deals n={x.count} deals={x.deals} />
          </LocateRow>))}
      </div>
      <div class="xfoot">
        <span class="lfcount" role="status">{l.error && <span class="err">{l.error}</span>}</span>
        <span class="grow" />
        <span class="needs" title={found ? undefined : 'Locate a folder first'}><button type="button" class="btn sm pri"
          id="lf-use" disabled={!found || l.busy} aria-description={found ? undefined : 'Locate a folder first'}
          onClick={() => void useLocated(store)}>Use These Folders</button></span>
      </div>
    </Modal>
  );
}
