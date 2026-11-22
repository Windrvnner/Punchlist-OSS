import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { useDismiss } from './hooks';
import { Icon } from './icons';

/**
 * A ⋯ button that opens a small menu of actions (design.md, Menus), as the Checklist pane and the deal header have.
 * `items` is given `done`, which puts the focus back on ⋯ and shuts the menu: a dialog an item opens then returns the
 * focus to ⋯ when it closes. While `busy`, ⋯ spins in place of its dots and its tooltip says what is running; it still
 * opens, so the other items stay in reach. `lit` shows ⋯ as on while what an item started is still under way (a
 * rename).
 */
export function MoreMenu({ id, menuId, wrapClass = '', busy, lit, items }: {
  id: string; menuId: string; wrapClass?: string; busy?: string; lit?: boolean;
  items: (done: () => void) => ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), `[data-more="${id}"]`);
  const done = () => {
    button.current?.focus();
    setOpen(false);
  };
  return (
    <span class={`morewrap ${wrapClass}`} data-more={id}>
      <button type="button" ref={button} id={id}
        class={`btn sm ico ${open || lit ? 'on' : ''}`}
        aria-label={busy ? `More, ${busy.toLowerCase()}` : 'More'} title={busy ?? 'More'}
        aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        {busy ? <span class="rsch-spin" aria-hidden="true" /> : <Icon name="more" size={16} />}
      </button>
      {open && <div class="colmenu glass" id={menuId} role="menu">{items(done)}</div>}
    </span>
  );
}

/**
 * The mark of a single choice in a menu: a gray check mark at the row's right end, on a light highlight the row's `on` class
 * gives it (design.md, Menus). Nothing when the row is not chosen.
 */
export function ChoiceCheck({ on }: { on: boolean }) {
  return on ? <span class="mcheck" aria-hidden="true"><Icon name="check" size={14} /></span> : null;
}

/**
 * One item in such a menu. When it cannot be used just now it is off, with `why` on hover: the reason sits on a wrapper
 * as well, since a disabled button takes no pointer. `off` turns it off with no reason given (one already running).
 */
export function MenuItem({ id, why, off, className = '', onClick, children }: {
  id: string; why?: string | null; off?: boolean; className?: string; onClick: () => void; children: ComponentChildren;
}) {
  const tip = why ?? undefined;
  return (
    <span class="needs" title={tip}>
      <button type="button" class={`mi ${className}`} role="menuitem" id={id} disabled={off || !!why} title={tip}
        onClick={onClick}>{children}</button>
    </span>
  );
}
