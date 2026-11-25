// The queue strip: the rail folded into ticks for stepping through the Findings or Q&A list a record was opened from.
import type { RefObject } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, lastInput } from './hooks';
import type { Store } from '../app/store';
import { Icon } from './icons';
import { scopeHash } from '../app/conversations';
import { queueView, type QueueItem, type QueueScope } from '../app/qaView';

// Dock-style taper: ticks near the current item are full size and shrink with distance; never below 3px, scroll past
// that.
const TICK = { minHeight: 3, maxHeight: 5, minWidth: 11, maxWidth: 16, currentHeight: 8, currentWidth: 26 };
/** How near a tick is to the current one: 1 there, falling toward 0 on a bell curve `spread` ticks wide. */
const nearness = (distance: number, spread: number) => Math.exp(-(distance * distance) / (2 * spread * spread));

function tickHeight(index: number, current: number, spread: number) {
  if (index === current) return TICK.currentHeight;
  const near = nearness(Math.abs(index - current), spread);
  return Math.max(1, Math.round(TICK.minHeight + (TICK.maxHeight - TICK.minHeight) * near));
}

/** The widest gap, then the widest taper, at which every tick fits the room there is; the tightest when none does. */
function fitTaper(count: number, current: number, room: number) {
  for (const gap of [4, 3, 2]) {
    for (const spread of [18, 12, 7]) {
      let total = (count - 1) * gap;
      for (let i = 0; i < count; i++) total += tickHeight(i, current, spread);
      if (total <= room) return { gap, spread };
    }
  }
  return { gap: 2, spread: 7 };
}

/** Open, every tick is a full row: its sizes go back to the style sheet's. */
function openTicks(ticks: HTMLElement[]) {
  for (const tick of ticks) {
    tick.style.height = '';
    tick.style.opacity = '';
    const mark = tick.querySelector('i') as HTMLElement | null;
    if (mark) {
      mark.style.width = '';
      mark.style.height = '';
    }
  }
  return { heights: ticks.map(() => 24), gap: 6 };
}

/** Folded, the ticks taper away from the current one to fit the strip's height. */
function foldTicks(ticks: HTMLElement[], current: number, room: number) {
  const { gap, spread } = fitTaper(ticks.length, current, room);
  const heights = ticks.map((tick, index) => {
    const near = nearness(Math.abs(index - current), spread);
    const height = tickHeight(index, current, spread);
    const tapered = Math.round(TICK.minWidth + (TICK.maxWidth - TICK.minWidth) * near);
    const width = index === current ? TICK.currentWidth : tapered;
    tick.style.height = height + 'px';
    tick.style.opacity = (0.78 + 0.22 * near).toFixed(2);
    const mark = tick.querySelector('i') as HTMLElement | null;
    if (mark) {
      mark.style.width = width + 'px';
      mark.style.height = height + 'px';
    }
    return height;
  });
  return { heights, gap };
}

/** Sizes the ticks and scrolls the strip so the current one sits in its middle. Returns the timer that settles it. */
function layOutTicks(grid: HTMLDivElement, open: boolean) {
  const ticks = [...grid.children] as HTMLElement[];
  if (!ticks.length) return null;
  const current = Math.max(0, ticks.findIndex((tick) => tick.classList.contains('on')));
  const { heights, gap } = open ? openTicks(ticks) : foldTicks(ticks, current, grid.clientHeight);
  grid.style.setProperty('--tg', gap + 'px');
  let top = 0;
  for (let i = 0; i < current; i++) top += heights[i] + gap;
  const max = heights.reduce((sum, height) => sum + height, 0) + (ticks.length - 1) * gap - grid.clientHeight;
  grid.scrollTop = Math.max(0, Math.min(top - (grid.clientHeight / 2 - heights[current] / 2), Math.max(0, max)));
  // once the sizes have eased into place, center the current tick again on where it really ended up
  return window.setTimeout(() => {
    const on = grid.querySelector('.g.on') as HTMLElement | null;
    if (on) grid.scrollTop = Math.max(0, on.offsetTop - (grid.clientHeight / 2 - on.offsetHeight / 2));
  }, 300);
}

/**
 * The strip opens a moment after the pointer comes over it, at once when the keyboard brings the focus in, and folds
 * when the pointer and the focus have both left; folding clears its search.
 */
function useStripOpen(store: Store, queueSearch: string) {
  const [open, setOpen] = useState(false);
  const openTimer = useRef<number | null>(null);
  const stopOpenTimer = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
  };
  const enter = () => {
    stopOpenTimer();
    openTimer.current = window.setTimeout(() => setOpen(true), 180);
  };
  const leave = () => {
    stopOpenTimer();
    if ((document.activeElement as HTMLElement | null)?.id === 'qsearch') return;
    setOpen(false);
    if (queueSearch) store.ui({ queueSearch: '' });
  };
  const focusIn = () => {
    if (lastInput.kind !== 'key') return;
    stopOpenTimer();
    setOpen(true);
  };
  const focusOut = (e: FocusEvent) => {
    const stillIn = (e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null);
    if (stillIn || document.querySelector('#qstrip:hover')) return;
    stopOpenTimer();
    setOpen(false);
    if (store.get().ui.queueSearch) store.ui({ queueSearch: '' });
  };
  const searchBlur = () => {
    if (!document.querySelector('#qstrip:hover')) leave();
  };
  return { open, setOpen, enter, leave, focusIn, focusOut, searchBlur };
}

/** The ticks are laid out again whenever the strip opens or folds, the open item changes, or the search does. */
function useTickLayout(grid: RefObject<HTMLDivElement | null>, open: boolean, redoWhen: unknown[]) {
  const settleTimer = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (!grid.current) return;
    const settle = layOutTicks(grid.current, open);
    if (settle === null) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = settle;
  }, [open, ...redoWhen]);
}

/**
 * The arrow keys, Home and End move the focus within the grid. Returns the tick moved to, or -1 when the key is not
 * one of those or the focus is not on a tick.
 */
function moveFocus(e: KeyboardEvent, grid: HTMLDivElement | null) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return -1;
  const ticks = [...(grid?.children ?? [])] as HTMLElement[];
  const at = ticks.indexOf(document.activeElement as HTMLElement);
  if (at < 0 || !ticks.length) return -1;
  e.preventDefault();
  e.stopPropagation();
  const next = Math.max(0, Math.min(ticks.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
  const to = e.key === 'Home' ? 0 : e.key === 'End' ? ticks.length - 1 : next;
  ticks[to].focus();
  return to;
}

/** The rail, folded into a strip of ticks for stepping through the list the person came from. */
export function QueueStrip({ scope }: { scope: QueueScope }) {
  const store = useStore();
  const state = useAppState();
  const grid = useRef<HTMLDivElement>(null);
  const strip = useStripOpen(store, state.ui.queueSearch);
  const isQuestions = scope.kind === 'question';
  const currentId = isQuestions ? scope.questionId : scope.findingId;
  const { shown, total, position, searchPosition, previousId, nextId } = queueView(state, scope);
  const go = (id: string) => {
    const dealId = scope.dealId;
    location.hash = scopeHash(isQuestions
      ? { kind: 'question', dealId, questionId: id }
      : { kind: 'finding', dealId, findingId: id });
  };
  // the one stop for Tab in the queue: the item the arrow keys last went to, while the same item is open and it is
  // still shown; else the open item, else the first. Kept in state and drawn from it, so there is always exactly one
  // stop, whatever is clicked or searched
  const [roving, setRoving] = useState<{ id: string; on: string } | null>(null);
  const keepRoving = roving && roving.on === currentId && shown.some((item) => item.id === roving.id);
  const tabStop = keepRoving ? roving.id : searchPosition >= 0 ? currentId : shown[0]?.id;

  useLayoutEffect(() => {
    document.body.classList.add('queued');
    return () => document.body.classList.remove('queued', 'qopen');
  }, []);
  useLayoutEffect(() => {
    document.body.classList.toggle('qopen', strip.open);
  }, [strip.open]);
  useTickLayout(grid, strip.open, [currentId, shown.length, state.ui.queueSearch]);

  const label = isQuestions ? 'Q&A' : 'Findings';
  const gridKey = (e: KeyboardEvent) => {
    const to = moveFocus(e, grid.current);
    // the stop for Tab moves with the focus, so Tab leaves the queue from wherever the arrows went, not onto the open
    // item further down it
    if (to >= 0 && shown[to]) setRoving({ id: shown[to].id, on: currentId });
  };
  return (
    <div class="qstrip" id="qstrip" onMouseEnter={strip.enter} onMouseLeave={strip.leave} onFocusIn={strip.focusIn}
      onFocusOut={strip.focusOut}>
      <a href="#deals" class="railx qhome" title="Home" aria-label="Home"><Icon name="home" size={16} /></a>
      <div class="qhead"><span>{label}</span><span>{position + 1} of {total}</span></div>
      {/* one stop for Tab (the item on screen, else the first); the arrow keys, Home and End move within the list.
          Folded away, an item is a few pixels high: a click then opens the list instead of landing on whichever one was
          under the pointer */}
      <div class="qgrid" ref={grid} role="group" aria-label={label} onKeyDown={gridKey}>
        {shown.map((item) => (
          <Tick key={item.id} item={item} current={item.id === currentId} tabStop={item.id === tabStop}
            onClick={() => (strip.open ? go(item.id) : strip.setOpen(true))} />
        ))}
      </div>
      {/* where the open item is in the list as shown; while a search hides it, where it is in the whole queue */}
      <QueueArrows position={searchPosition >= 0 ? searchPosition : position} count={shown.length}
        step={(by) => {
          const id = by < 0 ? previousId : nextId;
          if (id) go(id);
        }} />
      <input id="qsearch" class="qsearch" placeholder="Search this queue…" aria-label={`Search ${label}`}
        tabIndex={strip.open ? 0 : -1} value={state.ui.queueSearch} onBlur={strip.searchBlur}
        onInput={(e) => store.ui({ queueSearch: (e.currentTarget as HTMLInputElement).value })} />
    </div>
  );
}

/** One item in the strip: a tick while folded, a row with its number and title while open. */
function Tick({ item, current, tabStop, onClick }: {
  item: QueueItem; current: boolean; tabStop: boolean; onClick: () => void;
}) {
  return (
    <button type="button" class={`g ${current ? 'on' : ''} ${item.done ? 'done' : ''}`} tabIndex={tabStop ? 0 : -1}
      aria-current={current ? 'true' : undefined} title={item.num ? `${item.num} · ${item.title}` : item.title}
      onClick={onClick}>
      <i />{item.num && <b>{item.num}</b>}<span>{item.title}</span>
    </button>
  );
}

/** Previous and next, which wrap around the list, and where the open item is in it. */
function QueueArrows({ position, count, step }: { position: number; count: number; step: (delta: number) => void }) {
  return (
    <div class="qarrows">
      <button type="button" data-qstep="-1" data-wraps={position <= 0 ? '' : undefined} aria-label="Previous"
        onClick={() => step(-1)}><Icon name="up" size={15} /></button>
      <button type="button" data-qstep="1" data-wraps={position >= count - 1 ? '' : undefined}
        aria-label="Next" onClick={() => step(1)}><Icon name="down" size={15} /></button>
      <span class="qcnt">{position + 1}/{count}</span>
    </div>
  );
}
