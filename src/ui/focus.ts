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

/** Account for the sticky breadcrumb and overflowing actions when revealing a bounded editor. */
function revealFittedCard(field: HTMLElement, card: HTMLElement, scroller: HTMLElement, composer: HTMLElement) {
  const header = scroller.querySelector('.chathead');
  const inset = header && getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().height : 0;
  card.style.setProperty('--thread-header-height', `${inset}px`);
  const style = getComputedStyle(card);
  const box = card.getBoundingClientRect();
  const actions = card.querySelector('.cacts');
  if (actions) {
    // A short Detail still needs a line. Keep any overflowing actions inside the card and in the thread flow.
    const bottomInset = Number.parseFloat(style.paddingBottom) + Number.parseFloat(style.borderBottomWidth);
    const minimum = actions.getBoundingClientRect().bottom + bottomInset - box.top;
    if (minimum > box.height) card.style.minHeight = `${Math.ceil(minimum)}px`;
  }
  const thread = scroller.getBoundingClientRect();
  const cardBottom = card.getBoundingClientRect().bottom;
  const visibleBottom = Math.min(thread.bottom, composer.getBoundingClientRect().top);
  const over = Math.max(0, cardBottom - (visibleBottom - 12));
  // The enter animation shifts the card down until it settles. Use the final field position.
  const transform = style.transform;
  const slide = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42;
  const room = field.getBoundingClientRect().top - slide - (thread.top + inset + 4);
  const top = Math.min(over, room);
  if (top) scroller.scrollBy({ top });
}

/** The card scrolls up clear of the composer so its buttons can be reached. */
function scrollClearOfComposer(field: HTMLElement, keepFieldVisible: boolean) {
  const card = field.closest('.card');
  const composer = document.getElementById('pcomposer');
  if (!(card instanceof HTMLElement) || !composer) return;
  let scroller = card.parentElement;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  if (!scroller) return;
  if (keepFieldVisible) return revealFittedCard(field, card, scroller, composer);
  const over = card.getBoundingClientRect().bottom - (composer.getBoundingClientRect().top - 12);
  if (over > 0) scroller.scrollBy({ top: over });
}

/** A card's first field takes the focus, and the card scrolls up clear of the composer. */
export function focusCard(field: HTMLElement | null, keepFieldVisible = false) {
  if (!field || field.dataset.f) return;
  focusOnce(field);
  requestAnimationFrame(() => scrollClearOfComposer(field, keepFieldVisible));
}
