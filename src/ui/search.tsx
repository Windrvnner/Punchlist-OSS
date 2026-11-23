import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { DocName } from './docName';
import { CachedMark } from './cached';
import type { Store } from '../app/store';
import { revealChecklistRow } from './checklist';
import { navigate } from './nav';
import { searchGroups, loadAllForSearch, GROUP_PAGE, type Hit, type HitGroup, type HitKind } from '../app/search';
import { Marked } from './searchMark';

/**
 * Search lives in the rail: one field, and the matches drop down from it as you type, grouped by type.
 * Ctrl K puts the cursor in it. Where the rail is folded away (a finding, a question, a document), Ctrl K
 * brings the same field up beside the rail (`float`) and it goes again when you leave it.
 */
export function SearchBox({ float }: { float?: boolean }) {
  const store = useStore(); const s = useAppState();
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<HitKind[]>([]);
  const [at, setAt] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const input = useRef<HTMLInputElement>(null); const box = useRef<HTMLDivElement>(null); const res = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** a new query, or none: the panel starts again at its first result, every group folded */
  const clear = (query = '') => {
    setQ(query);
    resetSelection();
    setExpanded([]);
  };
  const active = s.ui.palette;
  const open = active && q.trim() !== '';

  useLayoutEffect(() => {                                    // Ctrl K (or the float appearing) puts the cursor here
    if (!active || document.activeElement === input.current) return;
    opener.current = document.activeElement as HTMLElement | null;
    input.current?.focus(); input.current?.select();
  }, [active]);
  useEffect(() => { if (active) void loadAllForSearch(store); }, [active]);   // unvisited deals become searchable as they load
  useLayoutEffect(() => {                                    // the panel hangs from the field, wherever the field is
    if (!open) { setAt(null); return; }
    const place = () => { const r = box.current!.getBoundingClientRect(); const top = r.bottom + 6; setAt({ left: r.left, top, width: Math.min(560, innerWidth - r.left - 16), maxHeight: Math.max(160, innerHeight - top - 16) }); };
    place(); window.addEventListener('resize', place); return () => window.removeEventListener('resize', place);
  }, [open]);

  // worked out again only when the state or the query changes, not on each arrow key (2,000 items a deal, many deals)
  const groups = useMemo(() => (open ? searchGroups(s, q, expanded) : []), [open, s, q, expanded]);
  const items = groups.flatMap(itemsOf);
  const { current: cur, reset: resetSelection, point, onKey: selectByKey } = useSearchSelection(items, res);
  // refocus: back to what had the focus before search took it, or to the page if that was nothing
  const leave = (refocus: boolean) => {
    clear();
    store.ui({ palette: false });
    input.current?.blur();
    if (!refocus) return;
    const was = opener.current;
    const back = was?.isConnected && was !== document.body ? was : document.getElementById('view');
    back?.focus({ preventScroll: true });
  };
  const pick = (item: Item | undefined, keyboard = false) => {
    if (!item) return;
    if ('more' in item) {
      setExpanded([...expanded, item.more.kind]);
      return;
    }
    leave(false);
    openSearchHit(store, item.hit, keyboard);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (q && !float) clear();
      else leave(true);
      return;
    }
    // Ctrl K again takes the cursor out of search, back to where it was (handled here, before the app's own Ctrl K, which only knows to blur)
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); leave(true); return; }
    // the floating field stands where the rail's own field would be, just before the rail's tools: Tab goes on from there to the
    // next stop shown, Shift Tab to the one before (the New deal button where it is shown; on a finding or a question it is not)
    if (e.key === 'Tab' && float) {
      const slot = document.querySelector('.rail .rtools'); if (!slot) return;
      const stops = [...document.querySelectorAll<HTMLElement>('#app a[href], #app button, #app input, #app select, #app textarea, #app [tabindex]')].filter((el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
      const before = (el: HTMLElement) => !!(el.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING);
      const to = e.shiftKey ? stops.filter(before).pop() : stops.find((el) => !before(el));
      if (to) { e.preventDefault(); leave(false); to.focus(); }
      return;
    }
    selectByKey(e, (item) => pick(item, true));
  };
  useLayoutEffect(() => { if (res.current) fitWords(res.current); }, [groups, at]);   // the rows and the panel's size change it; moving through them does not
  const loading = Object.keys(s.deals).some((id) => s.dealLoad[id] === 'loading' || s.dealLoad[id] === undefined);
  let n = 0;   // each group's rows are numbered on from the last group's
  const panel = open && at && createPortal(
    <div class="sdrop palbox" id="pal-drop" style={{ left: at.left, top: at.top, width: at.width, maxHeight: at.maxHeight }} onMouseDown={(e) => e.preventDefault()}>
      <div class="palres" id="pal-res" role="listbox" aria-label="Search results" ref={res}>
        {groups.length ? groups.map((g) => {
          const first = n;
          n += itemsOf(g).length;
          return <ResultGroup key={g.kind} g={g} first={first} cur={cur} query={q}
            onPoint={point} onPick={(index) => pick(items[index])} />;
        })
          : <div class="empty">{loading ? 'Searching' : 'No matches.'}</div>}
      </div>
    </div>, document.body);

  const field = (
    <div class={`rsearch ${float ? 'float' : ''} ${active ? 'on' : ''}`} id="rsearch" ref={box} onMouseDown={(e) => { if (e.target !== input.current) { e.preventDefault(); input.current?.focus(); } }}>
      <Icon name="search" size={14} sw={2} />
      <input id="pal-in" ref={input} placeholder="Search" aria-label="Search deals, findings, checklist items, questions and documents" autocomplete="off" spellcheck={false} role="combobox" aria-expanded={open} aria-controls="pal-res" aria-activedescendant={open && items.length ? `pal-${cur}` : undefined}
        value={q} onInput={(e) => clear((e.currentTarget as HTMLInputElement).value)} onKeyDown={onKey}
        onFocus={() => { if (!store.get().ui.palette) store.ui({ palette: true }); }}
        onBlur={() => { if (store.get().ui.palette) store.ui({ palette: false }); if (float) { setQ(''); } }} />
      {!active && <kbd>Ctrl K</kbd>}
    </div>);
  return <>{float ? createPortal(field, document.body) : field}{panel}</>;
}

// #498: ask a keyboard result's destination to focus once its selected record is rendered.
function openSearchHit(store: Store, hit: Hit, keyboard: boolean) {
  const searchFocus = keyboard ? hit.ui?.selectedQuestion ?? hit.ui?.selectedChecklist ?? null : null;
  if (revealOpenChecklistHit(store, hit)) store.ui({ searchFocus });
  else navigate(store, hit.hash, { ...hit.ui, searchFocus });
}

// #496: choosing the open Checklist item again keeps its filter and brings its row back into view.
function revealOpenChecklistHit(store: Store, hit: Hit): boolean {
  const id = hit.ui?.selectedChecklist;
  if (!id || location.hash !== '#' + hit.hash || store.get().ui.selectedChecklist !== id) return false;
  revealChecklistRow(document.getElementById('ck-rows'), id);
  return true;
}

// When the last page is revealed, its group no longer has a Show More row (#628).
function firstNewRow(moreIndex: number, group: HitGroup): number {
  return moreIndex + group.hits.length + Number(group.more > GROUP_PAGE);
}

type Item = { hit: Hit } | { more: HitGroup };
/** A group's rows in the order they show: its "Show N More" first, on the label's line, then its results. */
const itemsOf = (g: HitGroup): Item[] => [
  ...(g.more ? [{ more: g }] : []),
  ...g.hits.map((hit) => ({ hit })),
];
/** Until the arrows move, the first result is the one Enter opens, never a "Show N More" above it. */
const firstHit = (items: Item[]) => Math.max(0, items.findIndex((it) => 'hit' in it));

/** Keyboard selection scrolls after the result rows render. Pointing only highlights a row (#628). */
function useSearchSelection(items: Item[], results: RefObject<HTMLDivElement | null>) {
  const [index, setIndex] = useState<number | null>(null);
  const current = index === null ? firstHit(items) : Math.min(index, Math.max(0, items.length - 1));
  const reveal = (row: number) => {
    setIndex(row);
    requestAnimationFrame(() => results.current?.querySelector(`#pal-${row}`)?.scrollIntoView({ block: 'nearest' }));
  };
  return {
    current,
    reset: () => setIndex(null),
    point: (row: number) => { if (row !== current) setIndex(row); },
    onKey: (event: KeyboardEvent, pick: (item: Item | undefined) => void) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[current];
        pick(item);
        if (item && 'more' in item) reveal(firstNewRow(current, item.more));
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (items.length) reveal((current + direction + items.length) % items.length);
    },
  };
}

/**
 * One type's results: its label in title style, how many match in all, and
 * "Show N More" at the label line's right end, as Spotlight shows more; then its rows, the typed words in bold.
 * Rows are numbered from `first` in the order they show.
 */
function ResultGroup({ g, first, cur, query, onPoint, onPick }: {
  g: HitGroup; first: number; cur: number; query: string; onPoint: (i: number) => void; onPick: (i: number) => void;
}) {
  const row = (i: number, cls = '') => ({
    id: `pal-${i}`, role: 'option' as const, 'aria-selected': i === cur, tabIndex: -1,
    class: `${cls} ${i === cur ? 'on' : ''}`.trim(),
    onMouseMove: () => onPoint(i), onClick: () => onPick(i),
  });
  const at = g.more ? first + 1 : first;
  return (
    <div class="pgrp" role="group" aria-label={g.label} data-kind={g.kind}>
      <div class="phead">
        <div class="lbl plbl">{g.label}</div>
        <span class="pcount">{(g.hits.length + g.more).toLocaleString('en-US')}</span>
        {g.more > 0 && (
          <button type="button" {...row(first, 'pmore')} data-more={g.kind}>
            Show {Math.min(g.more, GROUP_PAGE)} More
          </button>)}
      </div>
      {g.hits.map((h, k) => (
        <button type="button" key={h.key} {...row(at + k)}>
          <span class="ttl">
            {h.doc
              ? <><DocName name={h.title} /><CachedMark doc={h.doc} /></>
              : <Marked text={h.title} query={query} />}
          </span>
          <Where h={h} />
        </button>))}
    </div>
  );
}

/**
 * The second lines' cuts, which CSS alone can't make. The deal's name keeps at least its first word ("· Project…"), so
 * the line always names the deal; and a counterparty cut by whole words is narrowed to the words it shows, so no gap opens
 * before the " · " that follows it. Measured from the word boxes, which lay out at full width even where they are cut.
 */
function fitWords(root: HTMLElement) {
  const rows = [...root.querySelectorAll<HTMLElement>('.where.parts')]; if (!rows.length) return;
  for (const r of rows) for (const e of r.querySelectorAll<HTMLElement>('.wdeal,.wtwin')) { e.style.minWidth = ''; e.style.maxWidth = ''; }
  const ctx = document.createElement('canvas').getContext('2d'); if (ctx) ctx.font = getComputedStyle(rows[0]).font;
  const ell = Math.ceil(ctx?.measureText('…').width ?? 12);
  const end = (e: HTMLElement, w: Element) => w.getBoundingClientRect().right - e.getBoundingClientRect().left;
  // the floors, then the narrowing, each read for every row before any is written: a write between two reads lays the
  // whole panel out again, once a row, and a panel of many rows froze the app (#2)
  const floors = rows.map((r) => { const d = r.querySelector<HTMLElement>('.wdeal'), first = d?.querySelector('.ww'); return d && first ? [d, Math.min(d.scrollWidth, Math.ceil(end(d, first)) + ell)] as const : null; });
  for (const f of floors) if (f) f[0].style.minWidth = `${f[1]}px`;
  const cuts = rows.map((r) => {
    const t = r.querySelector<HTMLElement>('.wtwin'); if (!t || t.scrollWidth <= t.clientWidth + 0.5) return null;
    const room = t.clientWidth - ell, fit = [...t.querySelectorAll('.ww')].filter((w) => end(t, w) <= room + 0.5).pop();
    return fit ? [t, Math.ceil(end(t, fit)) + ell] as const : null;
  });
  for (const c of cuts) if (c) c[0].style.maxWidth = `${c[1]}px`;
}

/** Text cut by whole words: each word, with the space before it, is one unbreakable box, so the ellipsis never follows a space ("Project Wide World …") */
const Words = ({ text }: { text: string }) => <>{text.split(/(?= )/).map((w, i) => <span class="ww" key={i}>{w}</span>)}</>;
/** A question number or pages ("Q12", "p. 4", "pp. 1120-1185", "pages 3, 7") is never cut; any other place (a sheet cell) is whole or left to the hover. */
const PAGES = /^(Q\d+|(pp?\.|pages?) ?\d[\d,;–—\- ]*)$/i;
/**
 * Where a hit is, on the row's second line. Inside a deal that shares its name, what tells it apart comes first, since
 * that is what the line is for; the deal's name takes what room is left; the place sits at the right, set off by a gap that a
 * screen reader hears as " · " (ui.css). Whole on hover.
 */
function Where({ h }: { h: Hit }) {
  const p = h.place; if (!p) return <span class="where" title={h.tip ?? h.where}>{h.where}</span>;
  const twin = p.twin.replace(/\s+/g, ' ');
  return <span class="where parts" title={h.where}>{twin && <span class="wtwin"><Words text={twin} /></span>}<span class="wdeal">{twin && ' · '}<Words text={p.deal} /></span>{p.at && <><span class="sr-only"> · </span><span class={PAGES.test(p.at) ? 'wat' : 'wat long'}>{p.at}</span></>}</span>;
}
