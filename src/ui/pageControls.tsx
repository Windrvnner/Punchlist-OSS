/**
 * Reading mode's page and zoom controls: a small vertical stack of round buttons at
 * the bottom right of the document, as in Acrobat: page up, page down, then zoom in, zoom out and the zoom, which
 * puts the page back to actual size. It sits just above the reading bar, clear of it, so the bar keeps only the
 * document arrows, the name, place and count, and close. The keys are unchanged.
 */
import { Icon } from './icons';

/** The zoom steps for a page in reading mode */
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const zoomStep = (zoom: number, dir: number) =>
  dir > 0 ? ZOOMS.find((x) => x > zoom + 0.001) ?? zoom : [...ZOOMS].reverse().find((x) => x < zoom - 0.001) ?? zoom;

/** the gap between the stack and the reading bar under it, and between the stack and the page's right edge */
const GAP = 12;

/**
 * Sets the stack where it belongs: its right side `right` px from the panel's right edge, the same 12px in from the
 * page's edge as the bar, and its foot 12px above the bar's top, so the two never overlap whatever the bar holds.
 */
export function placePageControls(panel: HTMLElement, nav: HTMLElement, right: number) {
  const stack = panel.querySelector<HTMLElement>('.pgstack');
  if (!stack) return;
  // from the bar's laid-out place, not its drawn one, which is lifted while the bar animates in
  const above = panel.clientHeight - nav.offsetTop + GAP;
  stack.style.right = `${Math.max(GAP, Math.round(right))}px`;
  stack.style.bottom = `${Math.round(above)}px`;
}

type PageControlsProps = {
  /** the page shown (null while not known) */
  shown: number | null;
  /** how many pages there are (null while not known) */
  total: number | null;
  /** false for a spreadsheet, which has no pages to step through */
  paged: boolean;
  zoom: number;
  turn: (delta: number) => void;
  zoomBy: (dir: -1 | 0 | 1) => void;
};

export function PageControls({ shown, total, paged, zoom, turn, zoomBy }: PageControlsProps) {
  const percent = Math.round(zoom * 100);
  const nextTip = `Next page · Page Down${total ? ` · ${total} pages` : ''}`;
  return (
    <div class="pgstack" role="group" aria-label="Page and zoom">
      {paged && <>
        <button type="button" id="page-prev" title="Previous page · Page Up" aria-label="Previous page"
          disabled={shown === null || shown <= 1} onClick={() => turn(-1)}><Icon name="chevup" size={15} /></button>
        <button type="button" id="page-next" title={nextTip} aria-label="Next page"
          disabled={shown === null || (total !== null && shown >= total)} onClick={() => turn(1)}>
          <Icon name="chev" size={15} />
        </button>
        <i class="pgrule" aria-hidden="true" />
      </>}
      <button type="button" id="zoom-in" title="Zoom in · Ctrl +" aria-label="Zoom in"
        disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => zoomBy(1)}><Icon name="plus" size={13} /></button>
      <button type="button" id="zoom-out" title="Zoom out · Ctrl −" aria-label="Zoom out"
        disabled={zoom <= ZOOMS[0]} onClick={() => zoomBy(-1)}><Icon name="minus" size={13} /></button>
      {/* always in its place, so the buttons above never move; at actual size it is quieter and does nothing */}
      <button type="button" id="zoom-reset" class={zoom === 1 ? 'zoomv off' : 'zoomv'} title="Actual size · Ctrl 0"
        aria-label={zoom === 1 ? 'Actual size' : `Zoomed to ${percent}%, back to actual size`}
        onClick={() => zoomBy(0)}>{percent}%</button>
    </div>
  );
}
