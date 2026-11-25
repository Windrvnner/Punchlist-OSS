import { findingsRaisedOnItem, checklistView, gapSearches, type ChecklistHeading } from '../app/checklistView';
import { titleStyle } from './titleStyle';
import { Fragment, type ComponentChildren, type RefObject } from 'preact';
import { createPortal } from 'preact/compat';
import { askAbout, itemStanding, versionsWord } from '../app/state';
import type { ItemKind, ItemStanding, State } from '../app/state';
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
import { findingHistory } from '../app/findings';
import { localYmd, type Finding } from '../domain/model';
import { askedAbout, askedAtGap, checklistAsk } from '../app/asking';
import { AskCard, AskedList, STATUS } from './askCounterparty';
import { useChecklistDraft } from './checklistDraft';
import { checklistQuestionTarget } from '../app/checklistQuestion';
import { AddDealItems, SetItemsOff, offeredItems, unlistedItems } from '../app/commands/checklist';

type Kind = ItemKind;
const CHECKLIST_INDEXING_TIP = 'The first pass starts when every folder has been indexed; items appear here as they are checked.';
/** The groups are named for how the item stands. An item whose check raised a finding is flagged: "Findings" is kept for the records on the Findings page. */
const LABEL: Record<Kind, string> = {
  finding: 'Flagged', gone: 'Finding Deleted', gap: 'Gaps', open: 'Not Settled', person: 'Resolved by a Person',
    satisfied: 'Satisfied',
};
const FILTER_LABEL = { all: 'All', ...LABEL, off: 'Turned Off' };
/** the longest filters, worded shorter where the header is narrow, so every filter stays on one row (design: one row of controls) */
const SHORT: Partial<Record<UiState['checklistFilter'], string>> = { person: 'By a Person', gone: 'Deleted' };
/** the same, for one item */
const ONE: Record<Kind, string> = { finding: 'Flagged', gone: 'Finding deleted', gap: 'Gap', open: 'Not settled', person: 'Resolved by a person', satisfied: 'Satisfied' };

/**
 * What a gap rests on: it was not found in the documents read, counted, with their names as the tooltip; a document
 * given for it with no readable text (a scan, most often) is named as not read, so the gap never claims it was checked; and what
 * the check searched for.
 */
function GapRead({ r }: { r: ChecklistRow }) {
  const n = r.docs.length; const un = r.unread ?? []; const names = (xs: { name: string }[]) => xs.map((x) => x.name).join(', ');
  // each search's tooltip says how many documents answered to it
  const said = (n: number) => (n ? `${n.toLocaleString('en-US')} ${n === 1 ? 'document answers' : 'documents answer'} to it` : 'No document answers to it');
  const searched = gapSearches(r);
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
  const view = useMemo(() => checklistView(s, dealId), [
    dealId, s.checklists[dealId], s.items, s.findings, s.conflicts, s.tombstones, s.dealLoad[dealId],
    s.ui.checklistFilter, s.ui.selectedChecklist,
  ]);
  const anyOff = view.counts.off > 0;
  useEffect(() => { if (!anyOff && s.ui.checklistFilter === 'off') store.ui({ checklistFilter: 'all' }); }, [anyOff, s.ui.checklistFilter]);
  // items no longer in the firm's list, marked with an icon (linking design, section 5): worked out again only when the
  // items, the lists or the deal's layers change, not on every move through the list (it reads every wording)
  const unlisted = useMemo(() => (d ? unlistedItems(s, d) : new Set<string>()), [s.items, s.firmList, s.conflicts, dealId, d?.product, d?.sector, d?.technology]);
  if (!d) return null;
  const rows = s.checklists[d.id];
  const { counts, on, shown, selected: sel, byList, offIds, offOpen } = view;
  const filters: [Filter, string][] = view.filters.map((key) => [key, `${FILTER_LABEL[key]} ${counts[key]}`]);
  const wide = !sel;
  const grouped = byList || on === 'all';
  const rises = grouped && counts.all > 0;
  const flaggedAbove = !byList && (on === 'all' || on === 'finding');
  // items are records of their own, so a deal in two versions does not hold them: only a read-only page does
  const locked = inherited;
  // one stop for Tab in the list: the open item, else the first; the arrow keys, Home and End move through the items
  const at = sel?.id ?? shown[0]?.row.id;
  const focusRow = (id: string) => listRef.current?.querySelector<HTMLElement>(`[data-item="${id}"]`)?.focus();
  useItemSearchFocus(listRef, sel?.id, listedNow, s.ui.searchFocus);
  const close = () => { const id = sel?.id; store.ui({ selectedChecklist: null }); if (id) requestAnimationFrame(() => focusRow(id)); };
  const onKey = (e: KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !shown.length) return;
    const activeId = (document.activeElement as HTMLElement | null)?.dataset.item;
    const index = shown.findIndex(({ row }) => row.id === activeId);
    if (index < 0) return;
    e.preventDefault();
    const last = shown.length - 1;
    const step = Math.max(0, Math.min(last, index + (e.key === 'ArrowDown' ? 1 : -1)));
    const next = shown[e.key === 'Home' ? 0 : e.key === 'End' ? last : step].row;
    if (sel) store.ui({ selectedChecklist: next.id });
    focusRow(next.id);
  };
  return (
    <div class="home top wide">
      <PageTop deal={d} route="checklist" placeholder={askAbout(d.name)} />
      <Stalled deal={d} />
      <section class={`brieflet ckpage ${rises ? 'rise' : ''}`}>
        {!inherited && Array.isArray(rows) && <AddThemLine dealId={d.id} />}
        <CkHead filters={filters} on={on} offOpen={offOpen} seg={Array.isArray(rows) && counts.all > 0}
          acts={counts.all > 0} more={counts.all > counts.off ? <CkMore dealId={d.id} /> : null} />
        {rows === 'failed' ? <p class="loadfail">Couldn’t load the checklist. <button type="button" class="tundo" id="ck-retry" onClick={() => void store.refreshChecklist(d.id)}>Retry</button></p>
          : rows === undefined && s.can.checklist ? <div class="ph"><i /><i /><i /><i /></div>
          // with nothing checked yet, the same lines as Overview and Findings: add folders, or how indexing stands
          : !counts.all ? (!d.folders.length ? <NoRoom deal={d} />
            : d.stage === 'indexing' && s.ui.indexStalled.includes(d.id) ? null
            : <p class="emptyline" id="ck-none" title={d.stage === 'indexing' ? CHECKLIST_INDEXING_TIP : undefined}>{d.stage === 'indexing' ? 'Indexing' : 'Nothing has been checked yet.'}</p>)
          : <div class={`md ck ${wide ? 'wide' : ''}`} onKeyDown={(e) => { if (e.key === 'Escape' && sel && !e.defaultPrevented) { e.preventDefault(); close(); } }}>
              <div class={`list ckrows ${grouped ? 'grouped' : ''}`} id="ck-rows" role="listbox"
                aria-label="Checklist items" ref={listRef} onKeyDown={onKey}>
                {shown.map(({ row, groups, heads }) => <Fragment key={row.id}>
                  {heads.map((h) => <div class={GROUP_CLASS[h.level]} aria-hidden="true" key={`${h.level}-${h.key}`}>
                    {headingName(h)}<span class={h.level === 'standing' ? undefined : 'n'}>{h.count}</span>
                  </div>)}
                  <Row key={row.id} r={row} dealId={d.id} wide={wide} flaggedAbove={flaggedAbove}
                    unlisted={unlisted.has(row.id)} on={sel?.id === row.id} off={offIds.has(row.id)} tab={at === row.id}
                    group={groups.map((h) => `${headingName(h)}, ${h.count}`).join(' · ') || undefined}
                    open={() => store.ui({ selectedChecklist: row.id })} />
                </Fragment>)}
              </div>
              {/* drawn afresh for each item, so nothing still saving for one item touches the next one's question */}
              {sel && <Detail key={sel.id} r={sel} dealId={d.id} off={offIds.has(sel.id)}
                locked={locked} onClose={close} />}
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

const headingName = (heading: ChecklistHeading) => heading.level === 'standing' ? LABEL[heading.text] : heading.text;
const GROUP_CLASS = { standing: 'ckgroup', list: 'ckgroup', section: 'cksec', subsection: 'cksub' };
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
  const store = useStore();
  const { can } = useAppState();
  const ro = useContext(ReadOnlyContext);
  const why = ro ?? (can.phrase ? undefined : 'Questions can’t be phrased here');
  const open = (done: () => void) => {
    done();
    store.ui({ dialog: { kind: 'addUnresolved', dealId } });
  };
  return <MoreMenu id="ck-pmore" menuId="ck-menu" wrapClass="ckpmore" items={(done) => (
    <MenuItem id="ck-add-unresolved" why={why} onClick={() => open(done)}>
      Add All Unresolved to Q&amp;A…
    </MenuItem>)} />;
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
  const by = k === 'person' && f ? findingHistory(s, f.id).closedBy : '';
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

/** The result of a check that raised a finding, including the option to restore a deleted finding. */
function FindingResult({ standing, readOnly }: { standing: ItemStanding; readOnly: string | null }) {
  const store = useStore();
  const { finding, versions, gone } = standing;
  let status = '';
  if (versions) status = titleStyle(versionsWord(versions.versions.length));
  else if (finding) status = finding.status === 'open' ? 'Open' : 'Closed';
  else if (gone) status = 'Deleted';

  const restore = () => {
    if (gone) void store.dispatch(RestoreFinding, { dealId: gone.dealId, findingId: gone.id },
      { idempotencyKey: 'restore-' + gone.id });
  };
  return <>
    <div class="lbl">Finding{status && ` · ${status}`}</div>
    <p class="ckp" id="ck-finding">{finding ? <a href={findingHref(finding)}>{finding.title}</a>
      : gone ? <>“{gone.title}” was deleted. <button type="button" class="linkb" id="ck-restore" disabled={!!readOnly}
        title={readOnly ?? undefined} onClick={restore}>Restore it</button></>
      : 'The finding this item raised is no longer here.'}</p>
  </>;
}

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
  const raised = useMemo(
    () => off ? findingsRaisedOnItem(s, dealId, r.id) : [], [off, s.findings, dealId, r.id],
  );
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
  const standing = itemStanding(s, dealId, r);
  const { kind, finding } = standing;
  const d = s.deals[dealId]; const pane = useToSidebarBottom<HTMLDivElement>();
  const draftKey = `${dealId}:${r.id}`;
  const draft = useChecklistDraft(draftKey, finding?.id);
  const { asking, text, setText, kept, findingId, begin, stopAsking, busy } = draft;
  const target = checklistQuestionTarget(s, r, off, findingId, raised[0]);
  const asked = askedAbout(s, dealId, r.id, target.askedFinding);
  const askedAsGap = off ? askedAtGap(s, dealId, r.id) : [];
  const { canAsk, offerAsk } = checklistAsk(standing, off, asked.length, kept);
  const why = ro ?? target.askWhy;
  const logWhy = ro ?? target.why;
  // a document opens in the deal's conversation, which is where a page can be read and asked about; closing it comes back here,
  // with the focus on the link it was opened from (the i-th in the list), or on the item if that link is not shown any more
  const read = (src: { doc: string; docId: string; loc: string }, i: number) => navigate(store, `chat-${dealId}`, { docAside: { doc: src.doc, docId: src.docId, dealId, loc: src.loc, from: 'From the checklist', item: r.text, back: `checklist-${dealId}`, backFocus: [`#ck-sources li:nth-child(${i + 1}) .ckopen`, `#ck-rows [data-item="${r.id}"]`] } });
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
  const log = async () => {
    if (busy || !text.trim() || logWhy) return;
    const trimmed = text.trim();
    await draft.log(trimmed, () => store.dispatch(CreateQuestion, {
      dealId, text: trimmed, askOrigin: { kind: 'checklist', itemId: r.id, findingId: target.links.linkedFinding },
    }, { idempotencyKey: 'ck-q-' + r.id }));
  };
  // the card being typed in keeps one place in the pane, on or off, so turning the item off never takes it away or moves the focus
  // shown whenever a question is being typed, whatever happens to the item or its finding meanwhile; Escape sets it
  // aside only where Ask the counterparty brings it back
  const escapeAsking = () => {
    if (canAsk) stopAsking();
  };
  const card = asking ? <AskCard ids="ck-ask" cls="ckask" counterparty={d?.counterparty ?? ''}
    linked={target.title} text={text} onText={setText} why={logWhy} busy={busy} onLog={() => void log()}
    onCancel={draft.cancel} onEscape={escapeAsking} /> : null;
  return (
    <div class="det ckdet glass" key={r.id} id="ck-detail" ref={pane}>
      <div class="dmeta">
        <span class="n">{off ? 'Turned off' : ONE[kind]}</span>
        <span class="grow" />
        {!off && finding && <a class="btn sm" id="ck-open-finding" href={findingHref(finding)}>Open Finding</a>}
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
      {r.result === 'finding' && <FindingResult standing={standing} readOnly={ro} />}
      {asked.length > 0 && <><div class="lbl">Asked</div><AskedList dealId={dealId} qs={asked} id="ck-asked" /></>}
      {/* why it is off is on the wrapper (a disabled button takes no pointer) and read out with the button */}
      {offerAsk && !asking && <span class="needs" title={why ?? undefined}><button type="button" class="btn sm"
        id="ck-ask" disabled={!!why} aria-description={why ?? undefined}
        onClick={() => begin(kind === 'gap' ? r.need : undefined)}>Ask the Counterparty</button></span>}
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
