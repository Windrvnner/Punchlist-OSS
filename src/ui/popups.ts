/**
 * Popups over the page (design.md, Glass → Popup glass). Every menu, popover, search result list and the connection
 * card is drawn in the browser's top layer, so:
 *  - its glass blurs the page itself, even when it opens inside a blurred pane (the Q&A panel, the sidebar, the ask box):
 *    a backdrop blur cannot see past a blurred ancestor, and the top layer has none;
 *  - nothing on the page (a pane's overflow, a later stacking context) can cut it off or cover it;
 *  - a menu gets a clear backdrop (`.popshield`, ui.css): the page is neither dimmed nor blurred, but it takes the
 *    pointer, so the rest of the app does not respond while the menu is open, and a press on it closes the menu. It is an
 *    element of its own, shown in the top layer just under the menu: a popover's `::backdrop` cannot take the pointer (the
 *    browser holds it at `pointer-events: none`).
 *
 * The components are unchanged: each still renders its menu where it always has and places it with its own CSS. When one
 * appears, this lifts it to the top layer at the place and width it was laid out at, and keeps it there, beside what it
 * hangs from, while the page scrolls or resizes. A popover (`popover="manual"`) leaves the DOM where it is, so a menu's
 * events, focus and styles work as before. Hover and focus popovers (a source's details, the connection card) and search
 * results are lifted too, but with no backdrop: they never dim the page or take the pointer from it.
 */

/** Menus: glass, over a clear backdrop that takes the pointer (ui.css); the page behind is neither dimmed nor blurred. */
const MENUS = '.colmenu, .docmenu, .pastpop';
/** Glass with no backdrop: shown on hover or focus, or (search) while typing. A source's details (ref.tsx) place
 *  themselves, and go to the top layer with `onTop` as they show. */
const BARE = '.conncard, .sdrop';
const ALL = `${MENUS}, ${BARE}`;

/** where a lifted popup sits: from the button it hangs from when it has one (dx, dy from that button's left and its top, or
 *  its bottom for a popup that opens upward), else from the box it was placed in (x, y) */
type Lifted = { el: HTMLElement; from: HTMLElement | null; x: number; y: number; up: boolean; by: HTMLElement | null; dx: number; dy: number };
const lifted = new Map<HTMLElement, Lifted>();

const canLift = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

function lift(el: HTMLElement) {
  if (lifted.has(el) || !el.isConnected || el.hidden) return;
  // Measured from the layout, not the box on screen: a menu opens with a short lift (a slide and a slight scale), and its
  // box mid-lift is neither where it settles nor as wide.
  const w = el.offsetWidth, h = el.offsetHeight; if (!w && !h) return;
  const from = el.offsetParent as HTMLElement | null;   // the box it is placed in; none for a popup placed on the window (fixed)
  // where it sits, from the outer edge of that box (its top left, as the page shows it, before the box's own scroll)
  const x = el.offsetLeft + (from?.clientLeft ?? 0), y = el.offsetTop + (from?.clientTop ?? 0);
  const at: Lifted = { el, from, x, y, up: false, by: null, dx: 0, dy: 0 };
  // a menu that opens upward (the composer's menus, the reading bar's) keeps its bottom edge as it grows or shrinks: told
  // by its own CSS, as one placed by its bottom edge moves its top when it grows by a pixel
  if (anchoredBelow(el, h)) { at.up = true; at.y = y + h; }
  const menu = el.matches(MENUS);
  el.setAttribute('popover', 'manual'); el.dataset.lift = menu ? 'menu' : 'bare';
  // the width it was laid out at: a width that came from its old container would change in the top layer
  el.style.setProperty('width', `${w}px`); el.style.setProperty('box-sizing', 'border-box');
  // the button it hangs from, so that it follows that button when the page moves under it (another PC's edit, a resize)
  const by = (el.id && document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(el.id)}"]`)) || [...(el.parentElement?.querySelectorAll<HTMLElement>('[aria-expanded="true"]') ?? [])].find((b) => !el.contains(b)) || null;
  if (by) { const o = origin(at), b = by.getBoundingClientRect(); at.by = by; at.dx = o.x - b.left; at.dy = o.y - (at.up ? b.bottom : b.top); }
  lifted.set(el, at); place(at); follow();
  if (menu) guard(true);
  try { el.showPopover(); } catch { lifted.delete(el); el.removeAttribute('popover'); delete el.dataset.lift; if (menu) guard(false); return; }
  if (menu) above();
}

function anchoredBelow(el: HTMLElement, h: number) {
  const s = el.style, was = [s.getPropertyValue('height'), s.getPropertyValue('max-height'), s.getPropertyValue('min-height')], t0 = el.offsetTop;
  s.setProperty('max-height', 'none'); s.setProperty('min-height', '0'); s.setProperty('height', `${h + 1}px`);
  const moved = el.offsetTop !== t0;
  for (const [i, p] of (['height', 'max-height', 'min-height'] as const).entries()) { if (was[i]) s.setProperty(p, was[i]); else s.removeProperty(p); }
  return moved;
}

/** where the popup's corner sits in the window, from the box it was placed in (a scrolled box's offsets are the box's, so
 *  its scroll is taken off): its top left, or for one that opens upward its bottom left */
function origin(at: Lifted) {
  let ox = 0, oy = 0;
  if (at.from) { const a = at.from.getBoundingClientRect(); ox = a.left - at.from.scrollLeft; oy = a.top - at.from.scrollTop; }
  return { x: ox + at.x, y: oy + at.y };
}

/** keeps a lifted popup beside what it hangs from */
function place(at: Lifted) {
  let p = origin(at);
  if (at.by?.isConnected) { const b = at.by.getBoundingClientRect(); p = { x: b.left + at.dx, y: (at.up ? b.bottom : b.top) + at.dy }; }
  const s = at.el.style, set = (k: string, v: string) => { if (s.getPropertyValue(k) !== v) s.setProperty(k, v); };
  set('position', 'fixed'); set('margin', '0'); set('right', 'auto');
  set('left', `${p.x}px`);
  if (at.up) { set('top', 'auto'); set('bottom', `${innerHeight - p.y}px`); }
  else { set('bottom', 'auto'); set('top', `${p.y}px`); }
}

/** while anything is lifted, it is placed again each frame, so it keeps to its button whatever moves the page */
let following = false;
function follow() {
  if (following) return; following = true;
  const tick = () => { if (!lifted.size) { following = false; return; } for (const at of lifted.values()) place(at); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}

/** The backdrop behind an open menu: shown again, it goes to the top of the top layer, just under the menu shown next */
let shield: HTMLElement | null = null;
function guard(on: boolean) {
  if (!shield) { shield = document.createElement('div'); shield.className = 'popshield'; shield.setAttribute('popover', 'manual'); shield.dataset.lift = 'shield'; shield.setAttribute('aria-hidden', 'true'); }
  try {
    if (on) { if (!shield.isConnected) document.body.append(shield); if (shield.matches(':popover-open')) shield.hidePopover(); shield.showPopover(); }
    else if (shield.matches(':popover-open')) shield.hidePopover();
  } catch { /* no backdrop: the menu still opens */ }
}

/** notices and the app's tooltip stay over a menu and its backdrop: shown again, they go to the top of the top layer */
function above() {
  for (const n of document.querySelectorAll<HTMLElement>('.notices, body > .tip')) {
    if (!n.hasAttribute('popover')) { n.setAttribute('popover', 'manual'); n.dataset.lift = 'bare'; }
    try { if (n.matches(':popover-open')) n.hidePopover(); n.showPopover(); } catch { /* not shown: it stays where it was */ }
  }
}

function sweep() {
  for (const [el, at] of lifted) if (!el.isConnected || el.hidden || (at.from && !at.from.isConnected)) {
    lifted.delete(el);
    if (el.isConnected) { try { el.hidePopover(); } catch { /* already hidden */ } el.removeAttribute('popover'); delete el.dataset.lift; for (const p of ['position', 'margin', 'left', 'right', 'top', 'bottom', 'width', 'box-sizing']) el.style.removeProperty(p); }
  }
  for (const el of document.querySelectorAll<HTMLElement>(ALL)) lift(el);
  if (![...lifted.keys()].some((el) => el.dataset.lift === 'menu')) guard(false);
}

/** A press that began on a menu's backdrop: the rest of it (the release, the click) goes nowhere, though the menu, and so
 *  the backdrop, is gone by then and what lay under it would otherwise take them */
let eating = false;

/** A press on a menu's backdrop closes the menu (never a dialog: a dialog's own backdrop is its scrim, which keeps it open). */
function onPress(e: PointerEvent | MouseEvent) {
  if (!e.isTrusted) return;   // the press this sends below
  if (e.type === 'pointerdown') eating = false;
  if (eating || e.target === shield) { e.preventDefault(); e.stopPropagation(); } else return;
  // a press ends in a click, or for another button in auxclick or the context menu; a canceled press ends at once
  if (e.type === 'click' || e.type === 'auxclick' || e.type === 'contextmenu' || e.type === 'pointercancel') eating = false;
  if (e.type !== 'pointerdown') return;
  eating = true;
  // closed as a press anywhere outside it would close it: the menus listen for a press outside, the pick lists for their
  // button losing the focus
  const f = document.activeElement as HTMLElement | null; if (f && f !== document.body) f.blur();
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
}

/** the wheel over a menu's backdrop scrolls nothing: the page under it holds still while the menu is open */
function onWheel(e: WheelEvent) { if (e.target === shield) e.preventDefault(); }

/** For a popup that places itself (fixed, at the place it works out): into the top layer as it shows, out as it goes. */
export function onTop(el: HTMLElement, shown: boolean) {
  if (!canLift) return;
  try {
    if (shown) { if (!el.hasAttribute('popover')) { el.setAttribute('popover', 'manual'); el.dataset.lift = 'bare'; } if (!el.matches(':popover-open')) el.showPopover(); }
    else if (el.hasAttribute('popover')) { if (el.matches(':popover-open')) el.hidePopover(); el.removeAttribute('popover'); delete el.dataset.lift; }
  } catch { /* not shown on top: it stays where the page puts it */ }
}

let installed = false;
export function installPopups() {
  if (installed || !canLift) return; installed = true;
  let queued = false;
  const later = () => { if (queued) return; queued = true; queueMicrotask(() => { queued = false; sweep(); }); };
  new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  const replace = () => { for (const at of lifted.values()) place(at); };
  window.addEventListener('scroll', replace, true); window.addEventListener('resize', replace);
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'contextmenu', 'pointercancel'] as const) document.addEventListener(t, onPress, true);
  document.addEventListener('keydown', () => { eating = false; }, true);   // a key press is never the rest of a pointer press
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  sweep();
}
