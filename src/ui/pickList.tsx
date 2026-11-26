import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import { useDismiss } from './hooks';
import { Icon } from './icons';
import { ChoiceCheck } from './moreMenu';
import { key } from '../domain/checklist';
import { byName } from '../domain/order';

/** One of the firm's lists for a layer, and how many items it has. */
export type PickName = { name: string; n: number };

/**
 * A scrolling list cut short shows whole rows only: it ends at the foot of the last row that fits. Measured from the rows
 * themselves, in fractions of a pixel, since a row is not a whole number of pixels high (33.5px), and rounding it would
 * leave part of the next row showing above what sits below the list.
 */
export function wholeRows(sc: HTMLElement) {
  if (sc.scrollHeight <= sc.clientHeight) return;
  // the menu may be mid-way through its opening animation, scaled: page distances are divided back to the menu's own
  const box = sc.getBoundingClientRect(); const scale = box.width / sc.offsetWidth || 1; const room = sc.clientHeight + 0.5;
  let foot = 0; for (const r of sc.children) { const b = (r.getBoundingClientRect().bottom - box.top) / scale; if (b > room) break; foot = b; }
  if (foot > 0) sc.style.maxHeight = `${foot}px`;
}

/** A menu with more lists than this opens with a search box. */
export const SEARCH_FROM = 9;

/**
 * A deal's structure, sector or technology, picked from the firm's lists for that layer: a button that opens a menu of
 * them. A value typed before the lists existed stays, shown as not in the firm's lists, until a person picks another.
 * The lists are A to Z, with None last. With many lists the menu opens on a search box: typing narrows
 * it and Enter picks the first match.
 * `float` puts the open menu on the page rather than inside the button's parent, for use in a pop-up, whose scrolling
 * would otherwise cut it off; a float menu closes when what is under it scrolls.
 */
export function PickList({ id, label, names: given, cur, onPick, className, float, end, disabled, title, empty = 'Not set', chev }: {
  id: string; label: string; names: PickName[]; cur: string; onPick: (v: string) => void;
  className: string; float?: boolean; end?: boolean; disabled?: boolean; title?: string; empty?: string;
  /** a drawn chevron after the value, as an editable value that is picked from a list ends in (design.md, Editable values) */
  chev?: boolean;
}) {
  const [open, setOpen] = useState(false); const [q, setQ] = useState('');
  const names = [...given].sort((a, b) => byName(a.name, b.name));
  const menu = useRef<HTMLDivElement>(null); const search = useRef<HTMLInputElement>(null);
  const close = () => setOpen(false);
  const searching = names.length >= SEARCH_FROM;
  const known = names.some((x) => key(x.name) === key(cur));
  const shown = q.trim() ? names.filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase())) : names;
  const pick = (v: string) => { close(); (document.querySelector(`#${id} > button`) as HTMLElement | null)?.focus(); if (key(v) !== key(cur)) onPick(v); };

  // placed under its button and kept inside the window: a long list scrolls inside the menu, the search box and None stay
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const m = menu.current; const b = document.querySelector(`#${id} > button`)?.getBoundingClientRect();
    const top = float && b ? b.bottom + 6 : m.getBoundingClientRect().top;
    if (float && b) { m.style.top = `${top}px`; m.style.left = `${end ? b.right - m.offsetWidth : b.left}px`; }
    m.style.maxHeight = `${Math.max(160, innerHeight - top - 12)}px`;
    // a list cut short shows whole rows only
    const sc = m.querySelector<HTMLElement>('.scroll'); if (sc) wholeRows(sc);
    if (!float) return;
    const off = (e: Event) => { if (!m.contains(e.target as Node)) close(); };
    document.addEventListener('scroll', off, true); addEventListener('resize', close);
    return () => { document.removeEventListener('scroll', off, true); removeEventListener('resize', close); };
  }, [open]);

  // after the sizing above: it focuses the current item (None when nothing is picked, at the menu's foot), and focusing
  // it in a menu not yet sized scrolled the page down to it, so the menu was sized from the wrong place and ran off the page
  useDismiss(open, close, `#${id}, #${id}-menu`);
  useLayoutEffect(() => { if (open && searching) search.current?.focus(); }, [open]);   // with many lists, the search box takes the focus

  const mark = (n: string) => { const t = q.trim(); const at = t ? n.toLowerCase().indexOf(t.toLowerCase()) : -1;
    return at < 0 ? n : <>{n.slice(0, at)}<mark>{n.slice(at, at + t.length)}</mark>{n.slice(at + t.length)}</>; };
  const box = open && (
    <div ref={menu} id={`${id}-menu`} class={`colmenu glass pk-menu ${end ? 'end' : ''} ${float ? 'float' : ''}`} role="menu" aria-label={label}>
      {searching ? <label class="psearch"><Icon name="search" size={14} sw={2} /><input ref={search} class="in" placeholder={`Search ${names.length} ${label.toLowerCase()} lists`} aria-label={`Search the firm’s ${label.toLowerCase()} lists`} autocomplete="off" spellcheck={false} value={q}
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter' && shown.length) { e.preventDefault(); pick(shown[0].name); } }} /></label>
        : <div class="mlbl">The Firm’s {label} Lists</div>}
      <div class="scroll">
        {shown.map((x, i) => {
          const on = key(x.name) === key(cur);
          return <button type="button" key={x.name} class={`mi ${on ? 'on' : ''} ${q.trim() && i === 0 ? 'first' : ''}`}
            data-pick={x.name} onClick={() => pick(x.name)}>
            <span>{mark(x.name)}</span><span class="c">{x.n}</span><ChoiceCheck on={on} />
          </button>;
        })}
        {!shown.length && <div class="mnone">No matches</div>}
      </div>
      {cur && !known && <button type="button" class="mi on" data-pick-own onClick={close}>
        <span>{cur}</span><span class="c">Not in the Firm’s Lists</span><ChoiceCheck on />
      </button>}
      <div class="msep" />
      <button type="button" class={`mi ${cur ? '' : 'on'}`} data-pick="" onClick={() => pick('')}>
        <span>None</span><ChoiceCheck on={!cur} />
      </button>
    </div>);
  return (
    <span class="pickwrap" id={id}>
      <button type="button" class={`${className} ${cur ? '' : 'none'}`} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${cur || empty}`} disabled={disabled} title={title} onClick={() => { setQ(''); setOpen(!open); }}>{chev ? <><span class="pv">{cur || empty}</span><span class="chev"><Icon name="chev" size={13} /></span></> : cur || empty}</button>
      {box && (float ? createPortal(box, document.body) : box)}
    </span>
  );
}
