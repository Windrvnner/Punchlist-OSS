/**
 * One small tooltip for the whole app, used to show a name in full where it has been
 * shortened. It belongs to the element that asked for it and goes when that element
 * does, or on any key press, click, scroll or navigation.
 */
let tip: HTMLDivElement | null = null; let owner: HTMLElement | null = null; let timer = 0; let wired = false;

export function showTip(anchor: HTMLElement, text: string, delayMs = 350) {
  hideTip();
  owner = anchor;
  if (!wired) { wired = true; for (const ev of ['keydown', 'mousedown', 'wheel', 'hashchange', 'blur'] as const) window.addEventListener(ev, () => hideTip(), true); }
  timer = window.setTimeout(() => {
    if (owner !== anchor || !anchor.isConnected) return;
    tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); tip.textContent = text;
    document.body.appendChild(tip);
    const a = anchor.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const left = Math.max(12, Math.min(a.left, innerWidth - t.width - 12));
    const top = a.top - t.height - 8 >= 12 ? a.top - t.height - 8 : a.bottom + 8;
    tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  }, delayMs);
}
/** With an element: only if the tooltip is that element's. */
export function hideTip(of?: HTMLElement) {
  if (of && owner !== of) return;
  clearTimeout(timer); tip?.remove(); tip = null; owner = null;
}
