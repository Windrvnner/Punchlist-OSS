import { createContext } from 'preact';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Store } from '../app/store';
import type { State } from '../app/state';
import { PROJECT_WORD } from '../app/commands/deals';

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error('Store missing');
  return s;
}

/**
 * The current state: peer findings on the list share a frame; other changes notify immediately. A component reads the
 * current state when it renders, and subscribes before paint, checking for a change that
 * happened between its first render and the subscription, so no update can be missed.
 */
export function useAppState(): State {
  const store = useStore();
  const [, force] = useState(0);
  const rendered = store.get();
  useLayoutEffect(() => {
    const off = store.subscribe(() => force((n) => n + 1), { peerFrame: true });
    if (store.get() !== rendered) force((n) => n + 1);
    return off;
  }, [store]);
  return rendered;
}

/** Subscribe while a sign-in or folder form is on screen. */
export function useConnectionForm<T>(form: {
  get(): T;
  subscribe(listener: () => void): () => void;
  start(): () => void;
}): T {
  const [, force] = useState(0);
  const rendered = form.get();
  useLayoutEffect(() => {
    const off = form.subscribe(() => force((n) => n + 1));
    if (form.get() !== rendered) force((n) => n + 1);
    return off;
  }, [form]);
  useEffect(form.start, [form]);
  return rendered;
}

export const LOCALE = 'en-US';
/**
 * Which way a deal's name runs. A name in Hebrew or Arabic runs right to left, so a name too long to show is cut at
 * its end, not mid-word at its start. "Project ", which the app puts in front, does not decide it: the name after it
 * does, whatever punctuation follows the word.
 */
const RTL_LETTER = String.raw`[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]`;
const RTL_AFTER_PROJECT = new RegExp(String.raw`^(?:${PROJECT_WORD})?[^\p{L}]*${RTL_LETTER}`, 'iu');
export const nameDir = (name: string): 'rtl' | 'auto' => (RTL_AFTER_PROJECT.test(name) ? 'rtl' : 'auto');
const dateWithoutYear = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateWithYear = new Intl.DateTimeFormat(LOCALE, {
  month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
});

/**
 * Reuse date formatters without retaining this PC's time zone (#324). A cached formatter keeps the zone it was
 * built in, so after a zone change it could show the wrong day; formatting the local calendar day at UTC midnight
 * avoids that.
 */
function formatLocalDate(date: Date, withYear: boolean): string {
  const civil = new Date(0);
  civil.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
  // At Date's range boundary, a valid local day can have no representable UTC midnight.
  if (isNaN(+civil)) {
    return date.toLocaleDateString(LOCALE, {
      month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined,
    });
  }
  return (withYear ? dateWithYear : dateWithoutYear).format(civil);
}

export const fmtDate = (ymd: string) => {
  if (!ymd) return '';
  const d = new Date(ymd + 'T12:00:00');
  return isNaN(+d) ? '' : formatLocalDate(d, d.getFullYear() !== new Date().getFullYear());
};
export { fmtDateTime } from '../domain/dateTime';
export const whenText = (iso: string) => {
  const d = new Date(iso); const h = (Date.now() - +d) / 36e5;
  // "Just now" for the first minute only, then minutes: an hour of "Just now" read as never aging
  if (h < 1 / 60) return 'Just now'; if (h < 1) return `${Math.floor(h * 60)} min ago`; if (h < 24) return `${Math.floor(h)} h ago`;
  const days = Math.round(h / 24); if (days === 1) return 'Yesterday'; if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
};

/**
 * Every menu closes the same way: a click outside it, or Escape. Escape closes only the menu
 * (not whatever is behind it) and returns focus to the button that opened it. `within` is a CSS
 * selector for the element that holds both the button and the menu, or a list of two: the button's
 * holder first, then a menu put elsewhere on the page.
 */
/** `opener`: the button that opened it, when it is not the first one inside `within` that opens something. */
export function useDismiss(open: boolean, close: () => void, within: string, openerSel?: string) {
  const fn = useRef(close); fn.current = close;
  useLayoutEffect(() => {
    if (!open) return;
    const root = document.querySelector<HTMLElement>(within);
    const opener = root?.querySelector<HTMLElement>(openerSel ?? '[aria-haspopup]') ?? null;
    // what can be reached inside the menu, in the order shown
    const menu = () => [...document.querySelectorAll<HTMLElement>(within)].map((el) => el.matches('[role="menu"], [data-menu]') ? el : el.querySelector<HTMLElement>('[role="menu"], [data-menu]')).find(Boolean);
    const items = () => [...(menu()?.querySelectorAll<HTMLElement>('button, input, a[href]') ?? [])].filter((el) => !(el as HTMLButtonElement).disabled && el.getClientRects().length > 0);
    // focus goes into the menu as it opens: to the item that is current, else the first
    const first = items(); (first.find((el) => el.classList.contains('on') || el.hasAttribute('aria-current')) ?? first[0])?.focus();
    const off = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest?.(within)) fn.current(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); fn.current(); opener?.focus(); return; }
      const list = items(); const at = list.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Tab') { if (at >= 0) { opener?.focus(); fn.current(); } return; }       // Tab leaves the menu and carries on from its button
      if ((e.key === 'Home' || e.key === 'End') && (document.activeElement as HTMLElement | null)?.tagName === 'INPUT') return;   // a search box in the menu keeps them for its text
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !list.length || !(document.activeElement as HTMLElement | null)?.closest(within)) return;
      e.preventDefault(); e.stopPropagation();
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      list[j].focus();
    };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', off); document.removeEventListener('keydown', key, true);
      // the menu closed by choosing something in it: the focus that was on the item goes back to the button
      requestAnimationFrame(() => { if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) opener.focus(); });
    };
  }, [open, within, openerSel]);
}

/** How the person last gave input. Focus is moved for them only when they are driving by keyboard. */
export const lastInput: { kind: 'key' | 'pointer' } = { kind: 'pointer' };
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => { if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) lastInput.kind = 'key'; }, true);
  document.addEventListener('mousedown', () => { lastInput.kind = 'pointer'; }, true);
}

/**
 * The open item's pane (Checklist, Q&A) runs from where it starts down to the sidebar's bottom edge, so the two glass
 * panels end on one line (Glass 1). Measured, since where the pane starts differs from page to page.
 * The list beside the pane uses it too, so the two end together. When something above pushes them down, such as a deal
 * in two versions, they get shorter and scroll inside rather than run below the window; only under 120px does the page
 * scroll instead. With `on` false the element is left to its own height.
 */
export function useToSidebarBottom<T extends HTMLElement>(on = true) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const fit = () => { const el = ref.current; if (!el) return; if (!on) { el.style.height = ''; return; } const rail = document.querySelector('.rail')?.getBoundingClientRect(); const bottom = rail ? rail.bottom : innerHeight - 12; el.style.height = Math.max(120, bottom - el.getBoundingClientRect().top) + 'px'; };
    fit(); addEventListener('resize', fit); return () => removeEventListener('resize', fit);
  });
  return ref;
}

/** Re-render once a minute, so a time said as "5 min ago" moves on while the page stays open. */
export function useMinuteTick() {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set((n) => n + 1), 60_000); return () => clearInterval(t); }, []);
}
