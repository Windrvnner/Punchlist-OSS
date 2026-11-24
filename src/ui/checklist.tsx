import { titleStyle } from './titleStyle';
import { Fragment, type ComponentChildren, type RefObject } from 'preact';
import { createPortal } from 'preact/compat';
import { askAbout, itemStanding, conflictLabel, versionsWord, offFindingCount } from '../app/state';
import type { ItemKind, State } from '../app/state';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, fmtDate, useToSidebarBottom, useDismiss } from './hooks';
import { Icon } from './icons';
import type { ChecklistRow } from '../ports';
import type { UiState } from '../app/state';
import { PageTop, Stalled, NoRoom } from './deal';
import { findingHref } from './findings';
import { focusSearchResult, navigate } from './nav';
import { ReadOnlyContext } from './editField';
import { MoreMenu, MenuItem, ChoiceCheck } from './moreMenu';
import { CreateQuestion } from '../app/commands/questions';
import { RestoreFinding } from '../app/commands/findings';
import { localYmd, type Finding } from '../domain/model';
import { AskCard, AskedList, askedAbout, STATUS, useLogQuestion } from './askCounterparty';
import { keptDrafts, isText } from './keptDrafts';
import { AddDealItems, SetItemsOff, offeredItems, unlistedItems } from '../app/commands/checklist';

type Kind = ItemKind;
const CHECKLIST_INDEXING_TIP = 'The first pass starts when every folder has been indexed; items appear here as they are checked.';
const ORDER: Kind[] = ['finding', 'gone', 'gap', 'open', 'person', 'satisfied'];           // what is flagged first, what passed last
/** The groups are named for how the item stands. An item whose check raised a finding is flagged: "Findings" is kept for the records on the Findings page. */
const LABEL: Record<Kind, string> = {
  finding: 'Flagged', gone: 'Finding Deleted', gap: 'Gaps', open: 'Not Settled', person: 'Resolved by a Person',
    satisfied: 'Satisfied',
};
/** the longest filters, worded shorter where the header is narrow, so every filter stays on one row (design: one row of controls) */
const SHORT: Partial<Record<UiState['checklistFilter'], string>> = { person: 'By a Person', gone: 'Deleted' };
/** the same, for one item */
const ONE: Record<Kind, string> = { finding: 'Flagged', gone: 'Finding deleted', gap: 'Gap', open: 'Not settled', person: 'Resolved by a person', satisfied: 'Satisfied' };
/** who closed a finding, from its history: the latest closing that was not undone, or nothing until the history is loaded */
const closedBy = (s: Pick<State, 'audit'>, f: Finding): string => {
  const audit = s.audit[f.id] ?? []; const undone = new Set(audit.map((a) => a.undoes).filter(Boolean));
  return [...audit].reverse().find((a) => a.kind === 'status' && a.to === 'closed' && !undone.has(a.opId) && !a.undoes)?.actor.split(' · ')[0] ?? '';
};

/**
 * What a gap rests on: it was not found in the documents read, counted, with their names as the tooltip; a document
 * given for it with no readable text (a scan, most often) is named as not read, so the gap never claims it was checked; and what
 * the check searched for.
 */
function GapRead({ r }: { r: ChecklistRow }) {
  const n = r.docs.length; const un = r.unread ?? []; const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ');
  // what the check's search looked for, each search once, with how many documents answered to it as its tooltip
  const said = (n: number) => (n ? `${n.toLocaleString('en-US')} ${n === 1 ? 'document answers' : 'documents answer'} to it` : 'No document answers to it');
  const searched = [...new Map((r.searched ?? []).map((x) => [x.q.toLowerCase(), x])).values()];
  return <p class="ckp" id="ck-read">
    <span title={names(r.docs) || undefined}>{n ? `Not found in the ${n === 1 ? 'one document' : `${n.toLocaleString('en-US')} documents`} read.` : 'No document could be read for it.'}</span>
    {un.length > 0 && ` ${names(un)} ${un.length === 1 ? 'has' : 'have'} no readable text and ${un.length === 1 ? 'was' : 'were'} not read.`}
    {searched.length > 0 && <> Searched for {searched.map((x, i) => <Fragment key={x.q}>{i ? (i === searched.length - 1 ? ' and ' : ', ') : ''}<span title={said(x.n)} aria-description={said(x.n)}>“{x.q}”</span></Fragment>)}.</>}
  </p>;
}
/**
 * The Checklist header: its filters, on one row beside the label. A row that runs short gives up words first, then puts
 * the filters seldom used (Finding deleted, Resolved by a person, Turned off) in a menu, as the Findings header does, then
 * draws the rest closer; measured, since counts vary and a width breakpoint can't know.
 */
const RARE: UiState['checklistFilter'][] = ['gone', 'person', 'off'];
type Filter = UiState['checklistFilter'];

/** The Checklist's seldom used filters, in the header's menu: the one on is checked (design.md, Menus). */
function FilterMenu({ filters, on, tip, pick }: {
  filters: [Filter, string][]; on: Filter; tip: (k: Filter) => string | null; pick: (k: Filter) => void;
}) {
  return <div class="colmenu fmenu" role="menu">{filters.map(([k, l]) => {
    const t = tip(k);
    return <button type="button" role="menuitemradio" aria-checked={on === k} key={k} data-filter={k}
      class={`mi ${on === k ? 'on' : ''}`} {...(t ? { title: t, 'aria-description': t } : {})} onClick={() => pick(k)}>
      {l}<ChoiceCheck on={on === k} />
    </button>;
  })}</div>;
}
function CkHead({ filters, on, offOpen, seg, acts, more }: { filters: [UiState['checklistFilter'], string][]; on: UiState['checklistFilter']; offOpen: number; seg: boolean; acts: boolean; more: ComponentChildren }) {
  const store = useStore();
  // 0 words · 1 short filter names · 2 and the seldom used in a menu · 3 and the rest drawn closer
  const row = useRef<HTMLDivElement>(null); const [mode, setMode] = useState(0); const [, again] = useState(0); const seen = useRef({ w: -1, sig: '' });
  const sig = filters.map((x) => x[1]).join();
  useLayoutEffect(() => {
    const el = row.current; if (!el) return;
    if (seen.current.sig !== sig || seen.current.w !== el.clientWidth) { seen.current = { w: el.clientWidth, sig }; if (mode !== 0) { setMode(0); return; } }   // something changed: start from words and give up only what does not fit
    if (el.scrollWidth > el.clientWidth && mode < 3) setMode(mode + 1);   // not a pixel over: the last control sits at the edge
  });
  useEffect(() => { const el = row.current; if (!el || typeof ResizeObserver === 'undefined') return; const ro = new ResizeObserver(() => { if (el.clientWidth !== seen.current.w) again((n) => n + 1); }); ro.observe(el); void document.fonts?.ready.then(() => again((n) => n + 1)); return () => ro.disconnect(); }, []);
  const [menu, setMenu] = useState(false); useDismiss(menu, () => setMenu(false), '.ckhead .fwrap');
  const short = mode >= 1; const folded = mode >= 2 ? filters.filter(([k]) => RARE.includes(k)) : [];
  const label = (k: UiState['checklistFilter'], l: string) => (short && SHORT[k] ? l.replace(LABEL[k as Kind], SHORT[k]!) : l);
  const tip = (k: UiState['checklistFilter']) => (k === 'off' && offOpen ? `${offOpen} with an open finding` : null);
  const hidden = folded.some(([k]) => k === on);   // the filter that is on is in the menu
  return <div class="lbl flagsl ckhead" ref={row}><span role="heading" aria-level={2}
    class="sr-only">Checklist</span>{acts && <span class="lblacts">{seg && <span
    class={`seg ${mode >= 3 ? 'tight' : ''}`} id="ck-filter" role="group"
    aria-label="Show">{filters.filter(([k]) => !folded.some(([f]) => f === k)).map(([k, l]) =>
    { const sl = label(k, l); const t = tip(k);
      return <button type="button" key={k} data-filter={k} class={on === k ? 'on' : ''} aria-pressed={on === k} {...(sl !== l ? { title: l, 'aria-label': l } : {})} {...(t ? { title: t, 'aria-description': t } : {})} onClick={() => store.ui({ checklistFilter: k })}>{sl}</button>; })}</span>}
    {seg && folded.length > 0 && <span class="fwrap"><button type="button" class={`btn sm ico ${hidden ? 'on' : ''}`} id="ck-fmore" aria-haspopup="menu" aria-expanded={menu} title={hidden ? 'Filter (on)' : 'Filter'} aria-label={hidden ? 'Filter (on)' : 'Filter'} onClick={() => setMenu(!menu)}><Icon name="filter" size={14} /></button>
      {menu && <FilterMenu filters={folded} on={on} tip={tip} pick={(k) => {
        store.ui({ checklistFilter: k });
        setMenu(false);
      }} />}
    </span>}{more}</span>}</div>;
}

// #496: reselecting a Search hit can reveal the open item without changing the selection.
export function revealChecklistRow(list: HTMLElement | null, itemId: string) {
  const row = list?.querySelector<HTMLElement>(`[data-item="${CSS.escape(itemId)}"]`);
  if (!list || !row || document.activeElement === row) return;
  const viewport = list.getBoundingClientRect();
  const bounds = row.getBoundingClientRect();
  if (bounds.top < Math.max(0, viewport.top) || bounds.bottom > Math.min(innerHeight, viewport.bottom)) {
    row.scrollIntoView({ block: 'center' });
  }
}

// #498: give keyboard Search focus to the selected row once the Checklist has rendered it.
function useItemSearchFocus(
  listRef: RefObject<HTMLDivElement | null>, selectedId: string | undefined, listedNow: boolean,
  searchFocus: string | null,
) {
  const store = useStore();
  useLayoutEffect(() => {
    if (!selectedId || searchFocus !== selectedId) return;
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-item="${CSS.escape(selectedId)}"]`);
    if (row) focusSearchResult(store, selectedId, () => {
      revealChecklistRow(list, selectedId);
      row.focus({ preventScroll: true });
    });
  }, [selectedId, searchFocus, listedNow]);
}

/**
 * Every checklist item of the deal and what its check came to, as a list with the item that is open beside it, like the
 * Q&A log. A line says how the item stands in a few words; opening it shows the whole of it: what a gap needs, the
 * finding a flagged item raised and what has been asked about it, and for a satisfied item the pages it was settled on,
 * each of which opens. Nothing here changes how an item stands: that is the check's doing.
 */
export function ChecklistPage({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState();
  const d = s.deals[dealId];
  useEffect(() => { void store.loadDeal(dealId); void store.refreshChecklist(dealId); }, [dealId]);
  const listRef = useToSidebarBottom<HTMLDivElement>(!!s.ui.selectedChecklist);   // beside the open item's pane, the list ends where the pane does
  // an item opened from elsewhere (search) may be far down a list of 2,000: once it is listed, a row not wholly in sight is
  // brought to the middle of the list, clear of its faded edges. A row chosen in the list itself (clicked, or reached by the
  // arrow keys) has the focus and is left where it is: one cut off at the list's foot is in sight once the pane beside it opens
  const listedNow = Array.isArray(s.checklists[dealId]);
  useEffect(() => {
    const id = s.ui.selectedChecklist; if (!id) return;
    const f = requestAnimationFrame(() => revealChecklistRow(listRef.current, id));
    return () => cancelAnimationFrame(f);
  }, [s.ui.selectedChecklist, listedNow]);
  const inherited = useContext(ReadOnlyContext);
  // with nothing turned off, however that came about (Turn on, an Undo, another PC), Turned off is not left chosen for later
  const anyOff = Object.values(s.items).some((it) => it.dealId === dealId && it.off);
  useEffect(() => { if (!anyOff && s.ui.checklistFilter === 'off') store.ui({ checklistFilter: 'all' }); }, [anyOff, s.ui.checklistFilter]);
  // items no longer in the firm's list, marked with an icon (linking design, section 5): worked out again only when the
  // items, the lists or the deal's layers change, not on every move through the list (it reads every wording)
  const unlisted = useMemo(() => (d ? unlistedItems(s, d) : new Set<string>()), [s.items, s.firmList, s.conflicts, dealId, d?.product, d?.sector, d?.technology]);
  if (!d) return null;
  const rows = s.checklists[d.id]; const checked = Array.isArray(rows) ? rows : [];
  // the deal's own items (linking design, section 5): those turned off stay listed in their place, dimmed, and an item on
  // that the check's rows do not have yet (added, or turned on, a moment ago) is listed at once as not checked
  const own = Object.values(s.items).filter((it) => it.dealId === d.id);
  const offRows: ChecklistRow[] = own.filter((it) => it.off).map((it) => ({ id: it.id, text: it.text, result: 'unchecked', docs: [] }));
  const listed = new Set(checked.map((r) => r.id));
  const list = [...checked.filter((r) => !s.items[r.id]?.off), ...(Array.isArray(rows) ? own.filter((it) => !it.off && !listed.has(it.id)).map((it): ChecklistRow => ({ id: it.id, text: it.text, result: 'unchecked', docs: [] })) : [])];
  // how each item is grouped: as it stands now (itemStanding), so an item whose finding was closed or deleted leaves Flagged for a group of its own
  const kinds = new Map(list.map((r) => [r.id, itemStanding(s, d.id, r).kind])); const kindOf = (r: ChecklistRow) => kinds.get(r.id)!;
  const count = (k: Kind) => list.filter((r) => kindOf(r) === k).length;
  // All lists turned-off items too, in their place; with every item turned off the status filters would show nothing
  const filters: [UiState['checklistFilter'], string][] = [['all', `All ${list.length + offRows.length}`],
    ...(!list.length ? [] : ORDER.filter((k) => (k !== 'open' && k !== 'person' && k !== 'gone')
    || count(k) > 0).map((k) => [k, `${LABEL[k]} ${count(k)}`] as [UiState['checklistFilter'], string])),
    ...(offRows.length ? [['off', `Turned Off ${offRows.length}`] as [UiState['checklistFilter'], string]] : [])];
  const on = filters.some(([k]) => k === s.ui.checklistFilter) ? s.ui.checklistFilter : 'all';
  // how many turned-off items still have an open finding (linking design, section 12), on the Turned off filter's tooltip
  const offOpen = offFindingCount(s, d.id);
  // the open item stays listed, and selected, when the filter would hide it, as on the Findings and Q&A pages
  const offIds = new Set(offRows.map((r) => r.id)); const isOff = (r: ChecklistRow) => offIds.has(r.id);
  const kept = on === 'off' ? [...offRows, ...list.filter((r) => r.id === s.ui.selectedChecklist)]
    : [...list.filter((r) => on === 'all' || kindOf(r) === on || r.id === s.ui.selectedChecklist), ...offRows.filter((r) => on === 'all' || r.id === s.ui.selectedChecklist)];
  // grouped by the firm's list each item comes from, then its section and subsection, in the order the
  // check gives them; a deal with no items from the firm's lists keeps the grouping by how each item stands
  const byList = own.length > 0;
  // a turned-off item keeps its place among the rest: the deal's items are in the order its lists give them
  const ord = new Map(own.map((it, i) => [it.id, i]));
  const placed = byList ? placeRows(s, [...kept].sort((a, b) => (ord.get(a.id) ?? Infinity) - (ord.get(b.id) ?? Infinity))) : null;
  const shown = placed ? placed.map((x) => x.r) : kept.map((r, i) => ({ r, i })).sort((a, b) => ORDER.indexOf(kindOf(a.r)) - ORDER.indexOf(kindOf(b.r)) || a.i - b.i).map((x) => x.r);
  const sel = list.find((r) => r.id === s.ui.selectedChecklist) ?? offRows.find((r) => r.id === s.ui.selectedChecklist) ?? null; const wide = !sel;
  // the list's first heading shares the filters' line, so the list starts a row higher
  const rises = !!(on === 'all' || placed) && (list.length > 0 || offRows.length > 0);
  const flaggedAbove = !placed && (on === 'all' || on === 'finding');   // a heading or the filter already says Flagged
  // items are records of their own, so a deal in two versions does not hold them: only a read-only page does
  const locked = inherited;
  // one stop for Tab in the list: the open item, else the first; the arrow keys, Home and End move through the items
  const at = sel && shown.some((r) => r.id === sel.id) ? sel.id : shown[0]?.id;
  const focusRow = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-item="${id}"]`)?.focus();
  useItemSearchFocus(listRef, sel?.id, listedNow, s.ui.searchFocus);
  const close = () => { const id = sel?.id; store.ui({ selectedChecklist: null }); if (id) requestAnimationFrame(() => focusRow(id)); };
  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !shown.length) return;
    const i = shown.findIndex((r) => r.id === (document.activeElement as HTMLElement | null)?.dataset.item); if (i < 0) return;
    e.preventDefault();
    const next = shown[e.key === 'Home' ? 0 : e.key === 'End' ? shown.length - 1 : Math.max(0, Math.min(shown.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (sel) store.ui({ selectedChecklist: next.id });       // with an item open, moving through the list moves what is open, as in the Q&A log
    focusRow(next.id);
  };
  return (
    <div class="home top wide">
      <PageTop deal={d} route="checklist" placeholder={askAbout(d.name)} />
      <Stalled deal={d} />
      <section class={`brieflet ckpage ${rises ? 'rise' : ''}`}>
        {!inherited && Array.isArray(rows) && <AddThemLine dealId={d.id} />}
        <CkHead filters={filters} on={on} offOpen={offOpen} seg={Array.isArray(rows) && (list.length > 0 || offRows.length > 0)} acts={list.length > 0 || offRows.length > 0} more={list.length > 0 ? <CkMore dealId={d.id} /> : null} />
        {rows === 'failed' ? <p class="loadfail">Couldn’t load the checklist. <button type="button" class="tundo" id="ck-retry" onClick={() => void store.refreshChecklist(d.id)}>Retry</button></p>
          : rows === undefined && store.services.ai.checklist ? <div class="ph"><i /><i /><i /><i /></div>
          // with nothing checked yet, the same lines as Overview and Findings: add folders, or how indexing stands
          : !list.length && !offRows.length ? (!d.folders.length ? <NoRoom deal={d} />
            : d.stage === 'indexing' && s.ui.indexStalled.includes(d.id) ? null
            : <p class="emptyline" id="ck-none" title={d.stage === 'indexing' ? CHECKLIST_INDEXING_TIP : undefined}>{d.stage === 'indexing' ? 'Indexing' : 'Nothing has been checked yet.'}</p>)
          : <div class={`md ck ${wide ? 'wide' : ''}`} onKeyDown={(e) => { if (e.key === 'Escape' && sel && !e.defaultPrevented) { e.preventDefault(); close(); } }}>
              <div class={`list ckrows ${on === 'all' || placed ? 'grouped' : ''}`} id="ck-rows" role="listbox" aria-label="Checklist items" ref={listRef} onKeyDown={onKey}>{shown.map((r, i) => <Fragment key={r.id}>
                {/* a listbox holds only its options, so the headings are not read; each option says which group it is in instead */}
                {placed ? placed[i].heads.map((h) => <div class={h.cls} aria-hidden="true" key={h.key}>{h.text}<span class="n">{h.n}</span></div>)
                  : on === 'all' && (i === 0 || kindOf(shown[i - 1]) !== kindOf(r)) && <div class="ckgroup" aria-hidden="true" key={`g-${kindOf(r)}`}>{LABEL[kindOf(r)]}<span>{count(kindOf(r))}</span></div>}
                <Row key={r.id} r={r} dealId={d.id} wide={wide} flaggedAbove={flaggedAbove}
                  unlisted={unlisted.has(r.id)} on={sel?.id === r.id} off={isOff(r)} tab={at === r.id}
                  group={placed ? placed[i].path : on === 'all' ? `${LABEL[kindOf(r)]}, ${count(kindOf(r))}` :
                  undefined} open={() => store.ui({ selectedChecklist: r.id })} />
              </Fragment>)}</div>
              {/* drawn afresh for each item, so nothing still saving for one item touches the next one's question */}
              {sel && <Detail key={sel.id} r={sel} dealId={d.id} off={isOff(sel)} locked={locked} onClose={close} />}
            </div>}
      </section>
    </div>
  );
}

/**
 * A flagged row's words: under the Flagged heading or filter the row does not say "Flagged" again, only the questions
 * asked about it
 */
function flaggedWords(saidAbove: boolean, asked: string) {
  if (saidAbove) return asked || null;
  return asked ? `Flagged · ${asked}` : 'Flagged';
}

const UNLISTED = 'No longer in the firm’s list';

/**
 * The line above the list while the firm's lists hold items this deal does not (linking design, section 5, "On opening
 * a deal"): "Add them" adds them, as one change with Undo. Nothing is added by itself.
 */
function AddThemLine({ dealId }: { dealId: string }) {
  const store = useStore(); const s = useAppState(); const [busy, setBusy] = useState(false);
  const n = useMemo(() => offeredItems(s, dealId).length, [s.items, s.firmList, s.conflicts, s.deals[dealId], s.dealLoad[dealId]]);
  if (!n) return null;
  // read again on pressing, so it adds what is missing then, never what another PC added meanwhile. The line then goes,
  // and the focus it had goes to the list, not to the page
  const add = async () => {
    if (busy) return; const now = offeredItems(store.get(), dealId); if (!now.length) return; setBusy(true);
    try { const r = await store.dispatch(AddDealItems, { dealId, items: now }, { idempotencyKey: `ck-add-them-${dealId}` }); if (r.ok) requestAnimationFrame(() => { const a = document.activeElement; if (!a || a === document.body || !a.isConnected || a.id === 'view') document.querySelector<HTMLElement>('#ck-rows [tabindex="0"]')?.focus(); }); }
    finally { setBusy(false); }
  };
  return <p class="loadfail qnote" id="ck-add-them" role="status">{n === 1 ? 'One item from the firm’s list is'
    : `${n.toLocaleString('en-US')} items from the firm’s list are`} not on this deal. <button type="button"
    class="tundo" id="ck-add-them-go" disabled={busy} onClick={() => void add()}>Add Them</button></p>;
}

/**
 * The page's ⋯ menu, beside the filter, as on the Q&A page (mock-up link-ck-more): Add all unresolved to Q&A, which
 * opens its preview. Off while the deal is read-only, with the reason on hover.
 */
function CkMore({ dealId }: { dealId: string }) {
  const store = useStore(); const ro = useContext(ReadOnlyContext);
  const why = ro ?? (store.services.ai.phrase ? undefined : 'Questions can’t be phrased here');
  const open = (done: () => void) => {
    done();
    store.ui({ dialog: { kind: 'addUnresolved', dealId } });
  };
  return <MoreMenu id="ck-pmore" menuId="ck-menu" wrapClass="ckpmore" items={(done) => (
    <MenuItem id="ck-add-unresolved" why={why} onClick={() => open(done)}>
      Add All Unresolved to Q&amp;A…
    </MenuItem>)} />;
}

const LAYER_RANK: Record<string, number> = { broad: 0, product: 1, sector: 2, technology: 3, deal: 4 };
type Head = { cls: 'ckgroup' | 'cksec' | 'cksub'; key: string; text: string; n: number };
/**
 * The rows under their headings: the firm's list an item comes from (the first of its lists, general first), then its
 * section, then its subsection. Each heading counts the rows under it that are shown, and comes before its first row.
 * Groups keep the order their first rows come in, which is the firm's list order; a row with no item record goes last.
 */
function placeRows(s: Pick<State, 'items'>, rows: ChecklistRow[]): { r: ChecklistRow; heads: Head[]; path: string }[] {
  const where = (r: ChecklistRow) => {
    const it = s.items[r.id]; const from = it ? [...it.from].sort((a, b) => LAYER_RANK[a.layer] - LAYER_RANK[b.layer])[0] : undefined;
    const list = !from ? 'Other' : from.layer === 'broad' ? 'General' : from.layer === 'deal' ? 'Added on This Deal'
      : from.value;
    return { list, sec: it?.section ?? '', sub: it?.subsection ?? '', last: !from };
  };
  const at = rows.map((r) => ({ r, w: where(r) }));
  // groups in the order they first come, with rows that have no item last
  const firsts = new Map<string, number>(); at.forEach((x, i) => { for (const k of [x.w.list, `${x.w.list}|${x.w.sec}`, `${x.w.list}|${x.w.sec}|${x.w.sub}`]) if (!firsts.has(k)) firsts.set(k, i); });
  const rank = (x: (typeof at)[number]) => [x.w.last ? 1 : 0, firsts.get(x.w.list)!, firsts.get(`${x.w.list}|${x.w.sec}`)!, firsts.get(`${x.w.list}|${x.w.sec}|${x.w.sub}`)!];
  const sorted = at.map((x, i) => ({ ...x, i, k: rank(x) })).sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.k[3] - b.k[3] || a.i - b.i);
  // the rows under each list, section and subsection, counted once: at deal scale (2,000 items) counting per row was slow
  const counts = new Map<string, number>(); for (const x of at) for (const k of [x.w.list, `${x.w.list}|${x.w.sec}`, `${x.w.list}|${x.w.sec}|${x.w.sub}`]) counts.set(k, (counts.get(k) ?? 0) + 1);
  return sorted.map((x, j) => {
    const p = sorted[j - 1]?.w; const heads: Head[] = [];
    const nl = counts.get(x.w.list)!; const ns = counts.get(`${x.w.list}|${x.w.sec}`)!; const nu = counts.get(`${x.w.list}|${x.w.sec}|${x.w.sub}`)!;
    const newList = !p || p.list !== x.w.list; const newSec = newList || p.sec !== x.w.sec;
    if (newList) heads.push({ cls: 'ckgroup', key: `l-${x.w.list}`, text: x.w.list, n: nl });
    if (newSec && x.w.sec) heads.push({ cls: 'cksec', key: `s-${x.w.list}|${x.w.sec}`, text: x.w.sec, n: ns });
    if ((newSec || p.sub !== x.w.sub) && x.w.sub) heads.push({ cls: 'cksub', key: `u-${x.w.list}|${x.w.sec}|${x.w.sub}`, text: x.w.sub, n: nu });
    // the headings it sits under, for a screen reader: "General, 12 · Security, 4"
    const path = [`${x.w.list}, ${nl}`, ...(x.w.sec ? [`${x.w.sec}, ${ns}`] : []), ...(x.w.sub ? [`${x.w.sub}, ${nu}`] : [])].join(' · ');
    return { r: x.r, heads, path };
  });
}

/**
 * One line: the item, and how it stands in as few words as say it. With an item open beside the list there is room for
 * fewer: the questions asked about a finding are left to the pane, so logging one does not widen the column for every row.
 */
function Row({ r, dealId, wide, flaggedAbove, unlisted, on, off, tab, group, open }: { r: ChecklistRow; dealId: string;
  wide: boolean; flaggedAbove: boolean; unlisted: boolean; on: boolean; off: boolean; tab: boolean; group?: string;
    open: () => void }) {
  const store = useStore(); const s = useAppState(); const st = itemStanding(s, dealId, r); const k = st.kind; const f = r.findingId ? s.findings[r.findingId] : undefined;
  const asked = askedAbout(s, dealId, r.id, f).map((q) => `Q${q.n} ${STATUS[q.status]}`).join(' · ');
  useEffect(() => { if (k === 'person' && f) void store.loadAudit(f.id); }, [k, f?.id]);   // who closed its finding
  const by = k === 'person' && f ? closedBy(s, f) : '';
  const first = r.sources?.[0]; const where = first ? `${first.doc}, ${first.loc}${r.sources!.length > 1 ? ` and ${r.sources!.length - 1} more` : ''}` : r.docs.slice(0, 2).map((x) => x.name).join(', ') + (r.docs.length > 2 ? ` and ${r.docs.length - 2} more` : '');
  return (
    <button type="button" class={`li ckrow ${on ? 'on' : ''} ${off ? 'off' : ''}`} role="option" aria-selected={on} data-item={r.id} data-result={off ? 'off' : r.result} tabIndex={tab ? 0 : -1} aria-description={group} onClick={open}>
      <span class={`mk ${off ? 'k-off' : `k-${k}`}`}>{!off && (k === 'satisfied' || k === 'person') && <Icon name="check" size={14} />}</span>
      {unlisted ? <span class="it unl"><span class="tx">{r.text}</span><span class="unli" title={UNLISTED}><Icon name="unlisted" size={16} /></span></span> : <span class="it">{r.text}</span>}
      <span class="sr-only">{unlisted && `, ${UNLISTED}`}, {off ? 'Turned off' : ONE[k]}</span>{/* how it stands in words, which the mark alone says only to the eye */}
      <span class={`oc ${k === 'person' && wide ? 'cl' : ''}`}>{off ? 'Turned off' : k === 'person' && f ? (wide ? <>Raised “<span class="ft">{f.title}</span>” · closed{by && ` by ${by}`}</> : null)
        : st.gone ? (wide ? 'Its finding was deleted' : 'Finding deleted')
        : st.versions ? <>{wide && !flaggedAbove && 'Flagged · '}<span
          class="cf">{versionsWord(st.versions.versions.length)}</span>{wide && asked && <> · {asked}</>}</>
        : r.result === 'finding' ? flaggedWords(flaggedAbove, wide ? asked : '')
        : r.result === 'gap' ? (wide ? <>Gap{asked ? <> · {asked}</> : r.need && <> · <b>{r.need}</b></>}</> : null)
        : r.result === 'unsettled' ? 'Could not be checked'
        : r.result === 'unchecked' ? 'Not checked yet'
        : wide ? <b>{where}</b> : null}</span>
    </button>
  );
}

/** The open item, whole. */
/**
 * Questions half typed in the Checklist pane, by deal and item: moving to another item, closing the pane or pressing
 * Escape keeps the text, and the box comes back with it when the item is opened again. Cancel or logging the question
 * clears it.
 */
const askDrafts = keptDrafts('checklist-ask', isText);   // kept across a restart too
// the finding each kept question was started on, by the same key: it stays the question's finding once the item is turned off
const askOn = keptDrafts('checklist-ask-on', isText);

/**
 * The open item, whole. A turned-off item (`off`) is shown in the same pane, so a question being typed about its finding
 * stays in place, text and focus, when the item is turned off here or on another PC: it shows the findings its checks
 * raised and what has been asked about them, all kept as they were, and Turn on.
 */
function Detail({ r, dealId, off, locked, onClose }: { r: ChecklistRow; dealId: string; off: boolean; locked: string | null; onClose: () => void }) {
  const store = useStore(); const s = useAppState(); const ro = useContext(ReadOnlyContext);
  // only an item the deal holds can be turned off: never deleted, so its findings and questions stay, and Undo turns it on again
  const why2 = locked ?? itemClash(s, r.id);
  const turnOff = async () => { setMore(false); const res = await store.dispatch(SetItemsOff, { dealId, off: [r.id] }, { idempotencyKey: 'ck-off-' + r.id }); if (res.ok) requestAnimationFrame(() => document.getElementById('ck-on')?.focus()); };   // the item stays listed, dimmed, and its pane open on Turn on
  // turned on, the item stays open in this pane, with the focus on its Turn off
  const turnOn = async () => {
    const res = await store.dispatch(SetItemsOff, { dealId, on: [r.id] }, { idempotencyKey: 'ck-on-' + r.id }); if (!res.ok) return;
    requestAnimationFrame(() => { const a = document.activeElement; if (!a || a === document.body) document.getElementById('ck-more')?.focus(); });
  };
  // a turned-off item is not in the check's rows: its findings are the ones raised on it, the open one first
  const raised = off ? Object.values(s.findings).filter((x) => x.dealId === dealId && x.itemId === r.id).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt)) : [];
  // the ⋯ menu is drawn on the page itself, under its button: inside the glass pane, the pane's text paints through it
  const [at, setAt] = useState<{ top: number; right: number } | null>(null); const moreBtn = useRef<HTMLButtonElement>(null); const moreMenu = useRef<HTMLDivElement>(null);
  const setMore = (v: boolean) => { if (!v) { setAt(null); return; } const b = moreBtn.current!.getBoundingClientRect(); setAt({ top: b.bottom + 8, right: window.innerWidth - b.right }); };
  const more = !!at;
  useEffect(() => {   // turned off meanwhile, here or on another PC: the menu goes and does not come back by itself, and the focus it had goes to Turn on
    if (!off || !at) return; setAt(null);
    requestAnimationFrame(() => { const a = document.activeElement; if (!a || a === document.body) document.getElementById('ck-on')?.focus(); });
  }, [off]);
  useLayoutEffect(() => {   // in place before the next key, so an Escape at once closes the menu, not the pane
    if (!at) return;
    const away = (e: Event) => { const t = e.target; if (!(t instanceof Node) || (!moreMenu.current?.contains(t) && !moreBtn.current?.contains(t))) setAt(null); };
    const shut = () => { const had = moreMenu.current?.contains(document.activeElement); setAt(null); if (had) moreBtn.current?.focus(); };   // a resize: the menu would sit away from its button
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setAt(null); moreBtn.current?.focus(); } else if (e.key === 'Tab') { e.preventDefault(); setAt(null); moreBtn.current?.focus(); } };
    document.addEventListener('mousedown', away, true); document.addEventListener('keydown', key, true); window.addEventListener('resize', shut);
    moreMenu.current?.querySelector<HTMLElement>('.mi')?.focus();
    return () => { document.removeEventListener('mousedown', away, true); document.removeEventListener('keydown', key, true); window.removeEventListener('resize', shut); };
  }, [more]);
  const st = itemStanding(s, dealId, r); const k = st.kind; const f = off ? (raised.find((x) => x.id === askOn.get(`${dealId}:${r.id}`) && x.status === 'open') ?? raised[0]) : r.findingId ? s.findings[r.findingId] : undefined;
  const d = s.deals[dealId]; const pane = useToSidebarBottom<HTMLDivElement>();
  const asked = askedAbout(s, dealId, r.id, f);
  // a turned-off item also lists what was asked about it as a gap, apart from its findings' questions
  const askedAsGap = off ? askedAbout(s, dealId, r.id, undefined).filter((q) => !q.linkedFinding) : [];
  // a question can be asked about a flagged item's open finding, or about a gap (linking design, section 6), never about
  // a turned-off item; a gap is offered it only until a question is asked about it (section 7: "Q38 asked", or the need and Ask)
  const canAsk = !off && ((k === 'finding' && !!f) || k === 'gap');
  // a question being typed stays on screen whatever happens meanwhile (lost work first): another PC may ask about the gap,
  // the item may stop being a gap or be turned off; Log question then says why it is off, and Cancel lets it go. Set aside
  // with Escape, it is kept, and Ask stays offered while it is, so it can always be brought back
  const kept = !!askDrafts.get(`${dealId}:${r.id}`);
  const offerAsk = !off && ((canAsk && !(k === 'gap' && asked.length)) || kept);
  // why a question cannot be asked about the finding just now: the deal is read-only, or the finding is in two versions
  const why = ro ?? (st.versions ? `${conflictLabel(s, st.versions)} has ${versionsWord(st.versions.versions.length).toLowerCase()}. Choose one first` : null);
  // a question about a finding can be logged while the finding is open, even once the item is turned off; one
  // about a gap while the item is a gap
  const aboutFinding = r.result === 'finding' || (off && (!!f || !!askOn.get(`${dealId}:${r.id}`)));      // the finding a kept question was started on
  const logWhy = why ?? (aboutFinding ? (!f ? 'Its finding is no longer here' : f.status !== 'open' ? 'Its finding is closed' : null) : off ? 'This item is turned off' : canAsk ? null : 'This item no longer needs a question');
  const draftKey = `${dealId}:${r.id}`;
  const [asking, setAsking] = useState(() => !!askDrafts.get(draftKey));
  const [text, setTextState] = useState(() => askDrafts.get(draftKey) ?? '');
  const setText = (v: string) => { setTextState(v); if (v) { askDrafts.set(draftKey, v); if (!off && r.findingId) askOn.set(draftKey, r.findingId); } else { askDrafts.delete(draftKey); askOn.delete(draftKey); } };
  // a document opens in the deal's conversation, which is where a page can be read and asked about; closing it comes back here,
  // with the focus on the link it was opened from (the i-th in the list), or on the item if that link is not shown any more
  const read = (src: { doc: string; docId: string; loc: string }, i: number) => navigate(store, `chat-${dealId}`, { docAside: { doc: src.doc, docId: src.docId, dealId, loc: src.loc, from: 'From the checklist', item: r.text, back: `checklist-${dealId}`, backFocus: [`#ck-sources li:nth-child(${i + 1}) .ckopen`, `#ck-rows [data-item="${r.id}"]`] } });
  // the question card goes when its question is logged or set aside: the focus goes back to the button that opened it, not to the page
  const stopAsking = () => { setAsking(false); requestAnimationFrame(() => { if (!document.activeElement || document.activeElement === document.body) (document.getElementById('ck-ask') ?? document.getElementById('ck-on') ?? document.getElementById('ck-more') ?? document.getElementById('ck-close'))?.focus(); }); };
  // The pane's body scrolls under its fixed header. While a question is being typed, the box's buttons stay in sight:
  // opening the box, or a line more in it, scrolls the body just enough to show them clear of its bottom fade (22px).
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const b = body.current; if (b) b.style.paddingBottom = ''; const end = b?.querySelector('.ckask .cacts'); if (!b || !end) return;
    const over = end.getBoundingClientRect().bottom + 40 - b.getBoundingClientRect().bottom; if (over > 0) b.scrollTop += over;
    // a paragraph left with its last line or two under the header reads as an orphan word: the body scrolls on past its
    // end, with room added below the box when the body is too short to scroll that far
    const top = b.getBoundingClientRect().top; if (!b.scrollTop) return;
    const cut = [...b.querySelectorAll(':scope > .ckp')].map((c) => c.getBoundingClientRect()).find((x) => x.top < top && x.bottom > top);
    if (!cut || cut.bottom - top >= 48) return;
    const need = cut.bottom - top; const room = b.scrollHeight - b.clientHeight - b.scrollTop;
    if (need > room) b.style.paddingBottom = `${16 + need - room}px`;      // 16px: the body's own bottom padding
    b.scrollTop += need;
  }, [asking, text, asked.length]);      // the Asked list, growing above the box when another PC asks, pushes it down
  // a question about a flagged item, or one kept from before the item was turned off, is asked about its finding
  const onF = (off || k === 'finding') && f ? f : undefined;
  // a logged question's text is let go once it lands, unless more was typed since
  const settle = () => {
    if (askDrafts.get(draftKey)) return;
    setTextState('');
    stopAsking();
  };
  const forget = (currentKey: string) => {
    askDrafts.delete(currentKey);
    askOn.delete(currentKey);
  };
  const { busy, log: logQuestion, cancel } = useLogQuestion(askDrafts, draftKey, forget, settle);
  const log = async () => {
    if (busy || !text.trim() || logWhy) return;
    const linked = { workstream: onF?.workstream ?? '', ...(onF ? { linkedFinding: onF.id } : {}), linkedItem: r.id };
    const input = { dealId, text: text.trim(), ...linked };
    await logQuestion(input.text, () => store.dispatch(CreateQuestion, input, { idempotencyKey: 'ck-q-' + r.id }));
  };
  // the card being typed in keeps one place in the pane, on or off, so turning the item off never takes it away or moves the focus
  // shown whenever a question is being typed, whatever happens to the item or its finding meanwhile; Escape sets it
  // aside only where Ask the counterparty brings it back
  const escapeAsking = () => {
    if (canAsk) stopAsking();
  };
  const card = asking ? <AskCard ids="ck-ask" cls="ckask" counterparty={d?.counterparty ?? ''}
    linked={onF ? onF.title : r.text} text={text} onText={setText} why={logWhy} busy={busy} onLog={() => void log()}
    onCancel={cancel} onEscape={escapeAsking} /> : null;
  return (
    <div class="det ckdet glass" key={r.id} id="ck-detail" ref={pane}>
      <div class="dmeta">
        <span class="n">{off ? 'Turned off' : ONE[k]}</span>
        <span class="grow" />
        {!off && f && <a class="btn sm" id="ck-open-finding" href={findingHref(f)}>Open Finding</a>}
        {off ? <span class="needs" title={why2 ?? undefined}><button type="button" class="btn sm" id="ck-on"
          disabled={!!why2} title={why2 ?? undefined} aria-description={why2 ?? undefined}
          onClick={() => void turnOn()}>Turn On</button></span>
          : s.items[r.id] && <span class="ckmore"><button type="button" ref={moreBtn} class={`btn sm ico ${more ? 'on' : ''}`} id="ck-more" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore(!more)}><Icon name="more" size={16} /></button>
            {at && createPortal(<div ref={moreMenu} class="colmenu railmenu" role="menu"
              style={{ top: `${at.top}px`, right: `${at.right}px` }}><button type="button" class="mi" role="menuitem"
              id="ck-off" aria-disabled={why2 ? true : undefined} title={why2 ?? undefined}
              aria-description={why2 ?? undefined} onClick={() => { if (!why2) void turnOff();
              }}>Turn Off Item</button></div>, document.body)}</span>}
        <button type="button" class="btn sm ico detx" id="ck-close" aria-label="Close" title="Close (Esc)" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      <div class="ckbody" ref={body}>
      <p class="cktitle" role="heading" aria-level={3}>{r.text}</p>
      {off ? <>{raised.map((x) => { const qs = askedAbout(s, dealId, null, x); return <Fragment key={x.id}>
        <div class="lbl">Finding · {x.status === 'open' ? 'Open' : 'Closed'}</div>
        <p class="ckp"><a href={findingHref(x)}>{x.title}</a></p>
        {qs.length > 0 && <><div class="lbl">Asked</div><AskedList dealId={dealId} qs={qs} id="ck-asked" /></>}
      </Fragment>; })}
        {/* and what was asked about the item itself, as a gap */}
        {askedAsGap.length > 0 && <>
          <div class="lbl">Asked</div>
          <AskedList dealId={dealId} qs={askedAsGap} id="ck-asked" />
        </>}
      </> : <>
      {r.result === 'gap' && r.need && <><div class="lbl">What Is Needed</div><p class="ckp"
        id="ck-need">{r.need}</p></>}
      {r.result === 'gap' && <><div class="lbl">Read Against{r.at
        ? ` · checked ${fmtDate(localYmd(r.at))}` : ''}</div><GapRead r={r} /></>}
      {r.result === 'finding' && <>
        <div class="lbl">Finding{st.versions ? ` · ${titleStyle(versionsWord(st.versions.versions.length))}`
          : f ? ` · ${f.status === 'open' ? 'Open' : 'Closed'}` : st.gone ? ' · Deleted' : ''}</div>
        {/* a deleted finding is still in the deal's Deleted list, so it can be put back here, as on its own page */}
        <p class="ckp" id="ck-finding">{f ? <a href={findingHref(f)}>{f.title}</a> : st.gone ? <>“{st.gone.title}” was deleted. <button type="button" class="linkb" id="ck-restore" disabled={!!ro} title={ro ?? undefined} onClick={() => { const g = st.gone!; void store.dispatch(RestoreFinding, { dealId: g.dealId, findingId: g.id }, { idempotencyKey: 'restore-' + g.id }); }}>Restore it</button></> : 'The finding this item raised is no longer here.'}</p>
      </>}
      {asked.length > 0 && <><div class="lbl">Asked</div><AskedList dealId={dealId} qs={asked} id="ck-asked" /></>}
      {/* why it is off is on the wrapper (a disabled button takes no pointer) and read out with the button */}
      {offerAsk && !asking && <span class="needs" title={why ?? undefined}><button type="button" class="btn sm"
        id="ck-ask" disabled={!!why} aria-description={why ?? undefined}
        onClick={() => { if (k === 'gap' && r.need && !text) setText(r.need); setAsking(true);
        }}>Ask the Counterparty</button></span>}
      {r.result === 'unsettled' && r.why && <><div class="lbl">Why</div><p class="ckp" id="ck-why">{r.why}</p></>}
      {r.result === 'unsettled' && !r.why && <p class="ckp" id="ck-why">The check did not come to a result on this item.</p>}
      {r.result === 'unchecked' && <p class="ckp" id="ck-why">No check has reached this item yet.</p>}
      {r.result === 'satisfied' && <>
        <div class="lbl">{r.sources?.length ? 'Settled on' : 'Read against'}{r.at ? ` · checked ${fmtDate(localYmd(r.at))}` : ''}</div>
        {r.sources?.length ? <ul class="cksrc" id="ck-sources">{r.sources.map((x, i) => <li key={i}><button type="button" class="ckopen" data-src={i} title={`${x.doc}, ${x.loc}`} onClick={() => read(x, i)}><span class="cdn">{x.doc}</span><span class="clc">{x.loc}</span></button>{x.quote && <blockquote>{x.quote}</blockquote>}</li>)}</ul>
          : r.docs.length ? <ul class="cksrc" id="ck-sources">{r.docs.map((x, i) => <li key={x.docId}><button type="button" class="ckopen" onClick={() => read({ doc: x.name, docId: x.docId, loc: '' }, i)}><span class="cdn">{x.name}</span></button></li>)}</ul>
          : <p class="ckp">No document is recorded for this item.</p>}
      </>}
      </>}
      {card}
      </div>
    </div>
  );
}

/** why an item cannot be turned off or on just now: it is in two versions (a version cannot be chosen yet, #365) */
const itemClash = (s: Pick<State, 'conflicts'>, id: string): string | null => { const c = s.conflicts[id]; return c ? `This item has ${versionsWord(c.versions.length).toLowerCase()}` : null; };
