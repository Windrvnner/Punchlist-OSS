/**
 * Locate deal folders: the top folders still missing on this PC, each with Locate…, and those found, with the folder
 * they were pointed at. Pointing at one top folder places every deal folder under it. Nothing is used until "Use These
 * Folders".
 */
import { useAppState, useStore } from './hooks';
import type { ComponentChildren } from 'preact';
import { Icon } from './icons';
import { StartCutPath } from './folderRow';
import { bareDealName } from '../app/commands/deals';
import { dealNameKey, dealTwinLabels, type State } from '../app/state';
import { Modal } from './dialogs';
import { closeLocate, locate, stillMissing, useLocated } from '../app/relink';

/** "42 folders · Proseware, Wingtip, Alpine and 8 more": the deals named, the full list on hover. A folder still to be
 *  located says why first, in red: "Not found on this PC", or "Files not found" for one that opens empty. */
function Deals({ n, deals, why }: { n: number; deals: string[]; why?: string }) {
  const names = deals.length > 4 ? `${deals.slice(0, 3).join(', ')} and ${deals.length - 3} more` : deals.join(', ');
  const line = `${n.toLocaleString('en-US')} folder${n === 1 ? '' : 's'} · ${names}`;
  return <div class="p" title={deals.join(', ')}>{why && <><span class="lfwhy">{why}</span> · </>}{line}</div>;
}

type Place = { dealId: string; folder: string };

const folderDealIds = (folders: Place[]) => [...new Set(folders.map(({ dealId }) => dealId))];

/** Choose a distinct label for each deal shown anywhere in Locate (#628). */
function folderDealLabels(state: Pick<State, 'deals'>, folders: Place[]) {
  const twinOf = dealTwinLabels(Object.values(state.deals));
  const counts = new Map<string, number>();
  const names = folderDealIds(folders).map((id) => {
    const deal = state.deals[id];
    const name = deal?.name ?? id;
    const short = bareDealName(name);
    const key = dealNameKey(short);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const twin = deal && twinOf(deal);
    const full = twin ? `${name} (${twin})` : name;
    return { id, full, short, key };
  });
  const fullKeys = new Set(names.map(({ full }) => dealNameKey(full)));
  const used = new Set<string>();
  return new Map(names.map(({ id, full, short, key }) => {
    const canShorten = counts.get(key) === 1 && (key === dealNameKey(full) || !fullKeys.has(key));
    return [id, uniqueFolderDealLabel(canShorten ? short : full, used, fullKeys)];
  }));
}

/** Even a counterparty and date can be shared, or be part of another deal's name. */
function uniqueFolderDealLabel(label: string, used: Set<string>, full: Set<string>) {
  let text = label;
  if (used.has(dealNameKey(text))) {
    let number = 2;
    do {
      text = `${label} (${number++})`;
    } while (used.has(dealNameKey(text)) || full.has(dealNameKey(text)));
  }
  used.add(dealNameKey(text));
  return text;
}

/** why a top folder is still to be located: every folder under it opens empty, or it is not on this PC */
function whyMissing(folders: Place[], empty: Place[]) {
  const isEmpty = (f: Place) => empty.some((e) => e.dealId === f.dealId && e.folder === f.folder);
  return folders.every(isEmpty) ? 'Files not found' : 'Not found on this PC';
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
  const missing = stillMissing(store); const found = l.located.reduce((n, x) => n + x.places.length, 0);
  const places = [...missing.flatMap(({ folders }) => folders), ...l.located.flatMap(({ places }) => places)];
  const labels = folderDealLabels(s, places);
  const dealsIn = (folders: Place[]) => folderDealIds(folders).map((id) => labels.get(id) ?? id);
  const empty = s.ui.missingFolders?.empty ?? [];
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
            <Deals n={t.folders.length} deals={dealsIn(t.folders)} why={whyMissing(t.folders, empty)} />
          </LocateRow>))}
        {l.located.length > 0 && <div class="lflbl">Found<span class="lfn">{found.toLocaleString('en-US')}</span></div>}
        {l.located.map((x) => (
          <LocateRow key={x.top} top={x.top} glyph="folder" path={x.picked}
            button={button(x.top, 'Change…', `Change ${x.top}…`)}>
            <Deals n={x.places.length} deals={dealsIn(x.places)} />
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
