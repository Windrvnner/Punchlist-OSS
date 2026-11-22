// Small focus and key helpers shared by the conversation's cards and lists, and the Ask the counterparty card.

/**
 * A ref callback that puts the focus on its element once, when it first appears, and never again on a later render
 * (the element is marked with `data-f`).
 */
export function focusOnce(el: HTMLElement | null, options?: FocusOptions) {
  if (!el || el.dataset.f) return;
  el.dataset.f = '1';
  el.focus(options);
}

/** As focusOnce, without scrolling anything to bring the element into view. */
export const focusOnceInPlace = (el: HTMLElement | null) => focusOnce(el, { preventScroll: true });

/** A keydown handler that calls `close` on Escape, and keeps the key from closing anything under it too. */
export const closeOnEscape = (close: () => void) => (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  close();
};

/** The card scrolls up clear of the composer so its buttons can be reached. */
function scrollClearOfComposer(field: HTMLElement) {
  const card = field.closest('.card');
  const composer = document.getElementById('pcomposer');
  if (!card || !composer) return;
  let scroller = card.parentElement;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const over = card.getBoundingClientRect().bottom - (composer.getBoundingClientRect().top - 12);
  if (scroller && over > 0) scroller.scrollBy({ top: over });
}

/** A card's first field takes the focus, and the card scrolls up clear of the composer. */
export function focusCard(field: HTMLElement | null) {
  if (!field || field.dataset.f) return;
  focusOnce(field);
  requestAnimationFrame(() => scrollClearOfComposer(field));
}
