import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { nameDir, useAppState, useStore } from './hooks';
import { Icon } from './icons';
import { DocName, graphemes } from './docName';
import { CachedMark } from './cached';
import type { Store } from '../app/store';
import { revealChecklistRow } from './checklist';
import { navigate } from './nav';
import {
  searchGroups, loadAllForSearch, ownDealsLoading, GROUP_PAGE, type Hit, type HitGroup, type HitKind,
} from '../app/search';
import { TwinLabel } from './dealLabel';
import { bareDealName } from '../app/commands/deals';
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
  const items = useMemo(() => groups.flatMap(itemsOf), [groups]);
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
  const loading = ownDealsLoading(s);
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

type Item = { hit: Hit } | { more: HitGroup };
/** A group's rows in the order they show: its "Show N More" first, on the label's line, then its results. */
const itemsOf = (g: HitGroup): Item[] => [
  ...(g.more ? [{ more: g }] : []),
  ...g.hits.map((hit) => ({ hit })),
];
/** Until the arrows move, the first result is the one Enter opens, never a "Show N More" above it. */
const firstHit = (items: Item[]) => Math.max(0, items.findIndex((it) => 'hit' in it));

// #501: a hit keeps its identity when another deal loads and inserts rows before it.
function itemKey(item: Item): string {
  return 'hit' in item ? JSON.stringify([item.hit.kind, item.hit.hash, item.hit.key]) : `more:${item.more.kind}`;
}

type Selection = string | { kind: HitKind; offset: number } | null;

// Keyboard Show More starts at the first newly revealed hit, even when the More row disappears (#628).
function expandedRow(items: Item[], { kind, offset }: { kind: HitKind; offset: number }): number {
  const first = items.findIndex((item) => 'hit' in item && item.hit.kind === kind);
  const row = first + offset;
  const item = items[row];
  return first >= 0 && item && 'hit' in item && item.hit.kind === kind ? row : -1;
}

/** Keyboard selection scrolls after the result rows render. Pointing only highlights a row (#628). */
function useSearchSelection(items: Item[], results: RefObject<HTMLDivElement | null>) {
  const [selection, select] = useState<Selection>(null);
  const expansion = typeof selection === 'object' && selection;
  const index = expansion ? expandedRow(items, expansion) : items.findIndex((item) => itemKey(item) === selection);
  const current = index < 0 ? firstHit(items) : index;
  const key = items[current] ? itemKey(items[current]) : null;
  const scroll = useRef(false);
  useLayoutEffect(() => {
    if (selection !== key) select(key);
    if (!scroll.current && !expansion) return;
    scroll.current = false;
    results.current?.querySelector(`#pal-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [key, current, selection]);
  return {
    current,
    reset: () => select(null),
    point: (row: number) => select(itemKey(items[row])),
    onKey: (event: KeyboardEvent, pick: (item: Item | undefined) => void) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[current];
        pick(item);
        if (item && 'more' in item) select({ kind: item.more.kind, offset: item.more.hits.length });
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      if (!items.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const row = (current + direction + items.length) % items.length;
      scroll.current = row !== current;
      select(itemKey(items[row]));
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
        <button type="button" key={h.key} {...row(at + k)} aria-description={h.tip ?? h.where}>
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

// #495: reserve the first meaningful part of the deal's name after the common Project prefix.
function dealNameFloor(deal: HTMLElement, ellipsis: number, measure: (text: string) => number) {
  const full = deal.textContent ?? '';
  const name = full.replace(/^ · /, '');
  const bare = bareDealName(name, 'navigation') || name;
  const leading = full.slice(0, full.length - bare.length);
  const firstWord = bare.split(/\s+/)[0];
  const floor = name.length <= 28 ? full : leading + [...firstWord].slice(0, 14).join('');
  return Math.ceil(Math.min(measure(full), measure(floor) + ellipsis));
}

// #790: size an oversized single word to the graphemes and ellipsis it can actually show.
function singleWordWidth(
  label: HTMLElement, ellipsis: number, measure: (text: string) => number, widths: Map<string, number>,
) {
  const word = label.firstElementChild;
  if (!word?.classList.contains('ww') || word.scrollWidth <= word.clientWidth) return null;
  const room = label.getBoundingClientRect().width;
  if (room < ellipsis) return null;
  const text = word.textContent ?? '';
  const key = `${room}:${text}`;
  const saved = widths.get(key);
  if (saved !== undefined) return saved;
  let prefix = '';
  let used = ellipsis;
  for (const letter of graphemes(text)) {
    prefix += letter;
    const next = measure(prefix) + ellipsis;
    if (next > room) break;
    used = next;
  }
  const width = Math.min(room, Math.ceil(used));
  widths.set(key, width);
  return width;
}

/**
 * Measure the floors first, then narrow cut counterparties to their last whole word, so there is no gap
 * before the separator. Read each batch before writing to avoid laying out the full panel once per row (#2).
 */
function fitWords(root: HTMLElement) {
  const rows = [...root.querySelectorAll<HTMLElement>('.where.parts')];
  if (!rows.length) return;
  for (const row of rows) {
    for (const label of row.querySelectorAll<HTMLElement>('.wdeal,.wtwin')) {
      label.style.minWidth = '';
      label.style.maxWidth = '';
    }
  }
  const ctx = document.createElement('canvas').getContext('2d');
  const { fontWeight, fontSize, fontFamily } = getComputedStyle(rows[0]);
  if (ctx) ctx.font = `${fontWeight} ${fontSize} ${fontFamily}`;
  const measure = (value: string) => ctx?.measureText(value).width ?? value.length * 8;
  const ellipsis = measure('…');
  const ell = Math.ceil(ellipsis);
  const end = (label: HTMLElement, word: Element) =>
    word.getBoundingClientRect().right - label.getBoundingClientRect().left;
  const floors = rows.map((row) => {
    const deal = row.querySelector<HTMLElement>('.wdeal');
    return deal ? [deal, dealNameFloor(deal, ell, measure)] as const : null;
  });
  for (const floor of floors) {
    if (!floor) continue;
    const [deal, width] = floor;
    deal.style.minWidth = `${width}px`;
  }
  const wordWidths = new Map<string, number>();
  const cuts = rows.map((row) => {
    const twin = row.querySelector<HTMLElement>('.wtwin');
    if (!twin) return null;
    if (twin.childElementCount === 1) {
      const width = singleWordWidth(twin, ellipsis, measure, wordWidths);
      return width === null ? null : [twin, width] as const;
    }
    if (twin.scrollWidth <= twin.clientWidth + 0.5) return null;
    const room = twin.clientWidth - ell;
    const fit = [...twin.querySelectorAll('.ww')].filter((word) => end(twin, word) <= room + 0.5).pop();
    return fit ? [twin, Math.ceil(end(twin, fit)) + ell] as const : null;
  });
  for (const cut of cuts) {
    if (cut) cut[0].style.maxWidth = `${cut[1]}px`;
  }
}

/** Keep each word with its preceding space so a whole-word ellipsis never follows a space. */
function Words({ text, clipAt }: { text: string; clipAt?: number }) {
  return <>{[...text.matchAll(/ *[^ ]+/g)].map(({ 0: word, index: start }) => {
    const clipped = clipAt !== undefined && start <= clipAt && clipAt < start + word.length;
    return <span class={clipped ? 'ww wlong' : 'ww'} key={start}>{word}</span>;
  })}</>;
}

/** A question number or pages ("Q12", "p. 4", "pp. 1120-1185", "pages 3, 7") is never cut; any other place (a sheet cell) is whole or left to the hover. */
const PAGES = /^(Q\d+|(pp?\.|pages?) ?\d[\d,;–—\- ]*)$/i;
// #490: keep the reading direction within the name, with the separator and reference outside it.
function SearchDealName({ name, hasTwin }: { name: string; hasTwin: boolean }) {
  const bare = bareDealName(name, 'navigation') || name;
  const clipAt = bare.split(/\s+/)[0].length > 15 ? name.length - bare.length : undefined;
  return <span class="wdeal">
    {hasTwin && ' · '}
    {nameDir(name) === 'rtl'
      ? <span class="wrtl" dir="rtl">{name}</span>
      : <Words text={name} clipAt={clipAt} />}
  </span>;
}

/**
 * Where a hit is, on the row's second line. Inside a deal that shares its name, what tells it apart comes first, since
 * that is what the line is for; the deal's name takes what room is left; the place sits at the right, set off by a gap that a
 * screen reader hears as " · " (ui.css). Whole on hover.
 */
function Where({ h }: { h: Hit }) {
  const p = h.place;
  if (!p) return <span class="where" title={h.tip ?? h.where}>
    <TwinLabel text={h.where} focus={h.twinFocus} />
  </span>;
  const twin = p.twin.replace(/\s+/g, ' ');
  return <span class="where parts" title={h.where}>
    {twin && <span class="wtwin">
      <TwinLabel text={twin} focus={p.focus}><Words text={twin} /></TwinLabel>
    </span>}
    <SearchDealName name={p.deal} hasTwin={!!twin} />
    {p.at && <><span class="sr-only"> · </span><span class={PAGES.test(p.at) ? 'wat' : 'wat long'}>{p.at}</span></>}
  </span>;
}
