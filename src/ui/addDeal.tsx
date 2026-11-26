import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useAppState, useStore } from './hooks';
import { Modal } from './dialogs';
import { Icon } from './icons';
import { SetDealMember } from '../app/commands/members';
import { dealTwin, dealLabel } from '../app/state';
import { dealRows } from '../app/dealView';

/**
 * Add deal: every deal in the shared folder, to add to your own list, and New deal beside
 * the search. It is the only way to join a deal. Deals to add come first; the ones already yours come last.
 */
export function AddDealDialog() {
  const store = useStore(); const s = useAppState();
  const [q, setQ] = useState('');
  const close = () => store.ui({ addDeal: false });
  const want = q.trim().toLowerCase();
  const rows = dealRows(s, 'add', q);
  const addToMine = (dealId: string) =>
    store.dispatch(SetDealMember, { dealId, on: true }, { idempotencyKey: `add-${dealId}` });
  const newDeal = () => store.ui({ addDeal: false, newDeal: { name: '', folders: [], error: '', busy: false } });
  return (
    <Modal onClose={close} label="Add deal" blur className="sdlg adddlg">
      <div class="shead"><h2>Add Deal</h2><button type="button" class="x" aria-label="Close" title="Close (Esc)"
        onClick={close}><Icon name="close" size={15} /></button></div>
      <div class="addbar">
        <label class="addfind"><Icon name="search" size={14} /><input id="add-find" value={q} placeholder="Find a deal" aria-label="Find a deal" onInput={(e) => setQ((e.target as HTMLInputElement).value)} /></label>
        <button type="button" class="btn pri" id="add-new" onClick={newDeal}>New Deal</button>
      </div>
      <div class="addlist" role="list" aria-label="Deals">
        {rows.map(({ deal: d, mine }) => (
          <div key={d.id} class={`addrow ${mine ? 'mine' : ''}`} role="listitem" data-deal={d.id}>
            <span class="dwho"><span class="an"><span title={d.name}>{d.name}</span>{d.group === 'closed' && <span class="tag">Closed</span>}</span>{(dealTwin(s, d) || d.counterparty) && <span class="cp">{dealTwin(s, d) || d.counterparty}</span>}</span>
            {mine ? <span class="yours"><Icon name="check" size={13} sw={2} />In your deals</span>
              : <button type="button" class="btn sm" data-add={d.id} title="Add to my deals"
                aria-label={`Add ${d.name} to my deals`} onClick={() => void addToMine(d.id)}>
                Add
              </button>}
          </div>))}
        {want && !rows.length && <p class="emptyline" id="add-none">No deal matches “{q.trim()}”.</p>}
      </div>
    </Modal>
  );
}

/**
 * The faint ⋯ on a deal in the sidebar, shown while the deal is pointed at or its menu is open. Its one item, Remove from
 * my deals, asks first, and the removal has Undo. Nothing is deleted: the deal stays in Add deal.
 */
export function DealMore({ dealId }: { dealId: string }) {
  const store = useStore(); const btn = useRef<HTMLButtonElement>(null); const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => { if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setAt(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setAt(null); btn.current?.focus(); } };
    document.addEventListener('mousedown', away, true); document.addEventListener('keydown', key, true); window.addEventListener('resize', away);
    menu.current?.querySelector<HTMLElement>('.mi')?.focus();
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', away); };
  }, [!!at]);
  // under its button, as the app's menus open; drawn on the page itself, since the sidebar's glass would hold it inside
  const toggle = () => { if (at) { setAt(null); return; } const r = btn.current!.getBoundingClientRect(); setAt({ left: r.left, top: r.bottom + 8 }); };
  return <>
    <button type="button" ref={btn} class={`dmore ${at ? 'open' : ''}`} aria-label="More" title="More" aria-haspopup="menu" aria-expanded={!!at} onClick={toggle}><Icon name="more" size={15} /></button>
    {at && createPortal(<div ref={menu} class="colmenu glass railmenu" role="menu" style={{ left: `${at.left}px`, top: `${at.top}px` }}>
      <button type="button" class="mi" role="menuitem" id="deal-unlist"
        onClick={() => { setAt(null); store.ui({ removeDeal: dealId }); }}>Remove from My Deals</button>
    </div>, document.body)}
  </>;
}

/** "Remove Project X from your deals?" with Keep it (focused) and Remove; the removal itself has Undo. */
export function RemoveDealDialog({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState(); const d = s.deals[dealId];
  const close = () => store.ui({ removeDeal: null });
  const go = async () => {
    const r = await store.dispatch(SetDealMember, { dealId, on: false }, { idempotencyKey: `unlist-${dealId}` });
    close();
    if (r.ok && 'dealId' in store.get().ui.route && (store.get().ui.route as { dealId?: string }).dealId === dealId) location.hash = 'deals';   // off its own pages, which no longer have a place in the sidebar
  };
  if (!d) return null;
  const label = dealLabel(s, d);      // says which of two same-named deals it is (#27)
  return (
    <Modal onClose={close} label={`Remove ${label} from your deals?`} blur className="sdlg dddlg uldlg">
      <div class="shead"><h2>Remove {label} from your deals?</h2><button type="button" class="x" aria-label="Close"
        title="Close (Esc)" onClick={close}><Icon name="close" size={15} /></button></div>
      <div class="xfoot"><span class="grow" /><button type="button" class="btn sm" id="ul-keep" data-autofocus
        onClick={close}>Keep It</button><button type="button" class="btn sm pri" id="ul-go"
        title="It stays in Add deal; nothing is deleted" onClick={() => void go()}>Remove</button></div>
    </Modal>
  );
}
