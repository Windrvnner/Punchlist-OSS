/**
 * A document's drafts in reading mode. When the open document has drafts, its date sits in
 * the bar beside the page and opens the list of drafts, newest first, each with its folder. An earlier draft is marked so
 * under its name, and a citation of one carries its date. Nothing is explained on screen: the newest is named in tooltips.
 */
import { useEffect } from 'preact/hooks';
import type { DraftRef } from '../ports';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { ChoiceCheck } from './moreMenu';
import { shownDrafts } from '../app/citations';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Apr 15", or with the year "Apr 15, 2026"; a draft whose folder has no date is named by its folder */
export const draftDate = (d: DraftRef, year = false) => {
  const m = d.date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.date) : null;
  return m ? `${MONTHS[+m[2] - 1]} ${+m[3]}${year ? `, ${m[1]}` : ''}` : d.folder.split('/').pop() || d.folder;
};

/** the document's drafts, read the first time it is shown; none until then, and none when it has no family */
export function useDrafts(dealId: string, docId: string): DraftRef[] {
  const store = useStore(); const s = useAppState();
  useEffect(() => { void store.loadDrafts(dealId, docId); }, [dealId, docId]);
  return shownDrafts(s.drafts[`${dealId}|${docId}`]);
}

/** The bar's drafts control: the open draft's date, opening the list. */
export function DraftsButton({ drafts, docId, open, setOpen }: { drafts: DraftRef[]; docId: string; open: boolean; setOpen: (v: boolean) => void }) {
  const cur = drafts.find((d) => d.docId === docId); if (!cur) return null;
  return (
    <button type="button" id="doc-drafts" class={`drafts ${open ? 'on' : ''}`} title={`${drafts.length} drafts`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="stack" size={15} /><span>{draftDate(cur)}</span><Icon name={open ? 'chev' : 'chevup'} size={13} />
    </button>);
}

/** The list of drafts, newest first; the open one is marked. */
export function DraftsMenu({ drafts, docId, pick }: { drafts: DraftRef[]; docId: string; pick: (d: DraftRef) => void }) {
  return (
    <div class="docmenu dm dl" role="menu" aria-label="Drafts">
      {drafts.map((d, i) => (
        <button type="button" role="menuitemradio" aria-checked={d.docId === docId} key={d.docId}
          class={`dm-r ${d.docId === docId ? 'on' : ''}`} onClick={() => pick(d)}>
          <span class="dt">{draftDate(d, true)}</span><span class="fo" title={d.folder}>{d.folder}</span>
          <span class="nw">{i === 0 ? 'Newest' : ''}</span>
          <span class="dtk"><ChoiceCheck on={d.docId === docId} /></span>
        </button>))}
    </div>);
}
