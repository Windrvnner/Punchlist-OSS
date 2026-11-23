// Reading mode's document panel: the cited page of a PDF or the cited cells of a spreadsheet, beside the conversation,
// with the bar that steps through documents, pages, drafts and zoom.
import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useAppState, useStore, useDismiss } from './hooks';
import type { Store } from '../app/store';
import { Icon } from './icons';
import { CachedMark } from './cached';
import { DocName } from './docName';
import { DocMenu } from './docMenu';
import { useDrafts, newerThan, draftDate, DraftsButton, DraftsMenu } from './drafts';
import { closeDocument } from './nav';
import { loadPage, pageKeyFor, type DocRef } from '../app/conversations';
import type { PageState } from '../app/state';
import type { DraftRef, PageView } from '../ports';
import { docKey } from '../domain/model';
import { PdfPage, dropPdf } from './pdfPage';
import { PageControls, placePageControls, zoomStep } from './pageControls';

type PanelRef = RefObject<HTMLElement | null>;
type SheetView = Extract<PageView, { kind: 'sheet' }>;

/** The page a citation's place names, from its first place */
function pageNo(loc: string) {
  const match = /p\.\s*(\d+)/.exec(loc.split(' · ')[0]);
  return match ? +match[1] : null;
}

const docBody = (panel: PanelRef) => panel.current?.querySelector<HTMLElement>('.docbody');

/** Where the bar's right edge sits, for one window size and conversation width (`key`). */
type NavAnchor = { key: string; right: number };

/**
 * Geometry: the page sits centered in the space right of the conversation column, at most 820px wide; the nav floats
 * centered over its foot.
 */
function placePage(root: HTMLElement, zoom: number, anchor: RefObject<NavAnchor | null>) {
  const stage = root.querySelector<HTMLElement>('.docstage');
  const page = root.querySelector<HTMLElement>('.docstage .page, .docstage .sheet');
  const column = document.querySelector<HTMLElement>('#view .chat');
  if (!stage || !page) return;
  const body = root.querySelector<HTMLElement>('.docbody');
  const width = stage.clientWidth - (body ? parseFloat(getComputedStyle(body).paddingRight) : 0);
  const minLeft = column ? column.offsetWidth : 400;
  const pageWidth = Math.max(420, Math.min(820, width - minLeft - 30));
  // zoomed, the page keeps the same gap on both sides while it fits, and runs off to the right (scrolled to) once it
  // does not
  const zoomedWidth = Math.round(pageWidth * zoom);
  const fits = zoomedWidth <= width - minLeft - 30;
  const left = fits ? minLeft + (width - minLeft - zoomedWidth) / 2 : minLeft + 15;
  page.style.setProperty('--pw', zoomedWidth + 'px');
  page.style.setProperty('--pl', left + 'px');
  page.style.setProperty('--z', String(zoom));
  const nav = root.querySelector<HTMLElement>('.docnav');
  if (nav) placeNav(root, nav, { width, minLeft, pageWidth }, anchor);
}

/**
 * The bar is anchored by its right edge, so close never moves while pages are stepped through or the page is
 * zoomed: a longer place or count only moves its left end. The anchor is set where the bar
 * sits centered over the page at actual size when reading mode opens (or the window changes), 12px in from the page's
 * edges, and the document's name gives way before the bar passes the page's left edge.
 */
function placeNav(root: HTMLElement, nav: HTMLElement, stage: { width: number; minLeft: number; pageWidth: number },
  anchor: RefObject<NavAnchor | null>) {
  const { width, minLeft, pageWidth } = stage;
  const pageLeft = minLeft + (width - minLeft - pageWidth) / 2;
  const lowest = Math.max(pageLeft, minLeft) + 12;
  const highest = pageLeft + pageWidth - 12;
  // one place while reading, whatever the document or citation; a new window size sets it again
  const key = `${width}|${minLeft}`;
  if (anchor.current?.key !== key) {
    nav.style.maxWidth = highest - lowest + 'px';
    const navWidth = nav.getBoundingClientRect().width;
    const centered = pageLeft + pageWidth / 2 + navWidth / 2;
    anchor.current = { key, right: Math.round(Math.min(highest, Math.max(lowest + navWidth, centered))) };
  }
  // placed by its right edge in whole pixels, so the arrows cannot drift by a rounding as the text beside them changes
  const right = anchor.current.right;
  nav.style.maxWidth = right - lowest + 'px';
  nav.style.left = 'auto';
  nav.style.marginLeft = '0';
  nav.style.right = root.clientWidth - right + 'px';
  placePageControls(root, nav, root.clientWidth - highest);
}

/** Places the page and its bar on every render and when the window changes size. */
function usePlacement(panel: PanelRef, zoom: number) {
  const anchor = useRef<NavAnchor | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      if (panel.current) placePage(panel.current, zoom, anchor);
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  });
}

/**
 * A new document or page starts at its top. Page Up while zoomed can turn to the previous page's foot. A change in
 * zoom keeps the same part of the page in view.
 */
function usePageScroll(panel: PanelRef, zoom: number, docIdentity: string, pageAt: number | null, loc: string,
  toFoot: RefObject<boolean>) {
  useLayoutEffect(() => {
    const body = docBody(panel);
    if (body) body.scrollTop = toFoot.current ? body.scrollHeight : 0;
    toFoot.current = false;
  }, [docIdentity, pageAt, loc]);
  const lastZoom = useRef(zoom);
  useLayoutEffect(() => {
    const body = docBody(panel);
    const ratio = zoom / lastZoom.current;
    lastZoom.current = zoom;
    if (body && ratio !== 1) {
      body.scrollTop *= ratio;
      body.scrollLeft *= ratio;
    }
  }, [zoom]);
}

/**
 * Ctrl and the wheel, or a pinch on a touchpad, zoom the page rather than the window; a few small pinch steps make one
 * zoom step. Ctrl + and Ctrl − come from the app's keys (app.tsx) as a zoom event: -1 out, 1 in, 0 back to actual
 * size; Page Up and Page Down as a page-key event, handled by `pageKey`.
 */
function useZoomInput(panel: PanelRef, zoomBy: (direction: -1 | 0 | 1) => void,
  pageKey: RefObject<(dir: 1 | -1) => void>) {
  useEffect(() => {
    const stage = panel.current?.querySelector<HTMLElement>('.docstage');
    if (!stage) return;
    let pinch = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      pinch += e.deltaY;
      if (Math.abs(pinch) < 40) return;
      const direction = pinch < 0 ? 1 : -1;
      pinch = 0;
      zoomBy(direction);
    };
    const onZoomKey = (e: Event) => zoomBy((e as CustomEvent<-1 | 0 | 1>).detail);
    const onPageKey = (e: Event) => pageKey.current((e as CustomEvent<1 | -1>).detail);
    stage.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('page-zoom', onZoomKey);
    document.addEventListener('page-key', onPageKey);
    return () => {
      stage.removeEventListener('wheel', onWheel);
      document.removeEventListener('page-zoom', onZoomKey);
      document.removeEventListener('page-key', onPageKey);
    };
  }, []);
}

/**
 * Pages: the page shown of a PDF, which is the cited one until the page arrows step away from it, and the page
 * count PDF.js found in the file shown (more exact than the one kept at indexing). `setPageAt(null)` goes back to the
 * cited page.
 */
function usePageTurns(store: Store, docs: DocRef[], current: DocRef, page: PageState | undefined) {
  const [pageAt, setPageAt] = useState<number | null>(null);
  const [counted, setCounted] = useState<{ url: string; n: number } | null>(null);
  const pdf = isView(page) && page.kind === 'pdf' ? page : null;
  const pageCount = pdf ? (pdf.url && counted?.url === pdf.url ? counted.n : pdf.pages ?? null) : null;
  const shown = pdf ? (pageAt ?? pdf.page) : null;
  // a document opened at no cited page (from the conversation with no place, or another draft) has no "Not cited":
  // only its page
  const cited = pageNo(current.loc) !== null;
  const offCite = cited && pdf !== null && shown !== pdf.page;
  const place = pdf && (offCite || !cited) ? `p. ${shown}${pageCount ? ` of ${pageCount}` : ''}` : current.loc;
  // the up and down arrows step through the pages; a page the list cites is that citation, so the count says which
  const turn = (delta: number) => {
    if (!pdf || shown === null) return;
    const to = shown + delta;
    if (to < 1 || (pageCount !== null && to > pageCount)) return;
    if (to === pdf.page) {
      setPageAt(null);
      return;
    }
    const citing = docs.findIndex((doc) => docKey(doc) === docKey(current) && pageNo(doc.loc) === to);
    if (citing >= 0) store.ui({ doc: citing, docAside: null });
    else setPageAt(to);
  };
  const countPages = (url: string, n: number) => {
    setCounted((was) => (was?.url === url && was.n === n ? was : { url, n }));
  };
  return { pageAt, setPageAt, pageCount, shown, offCite, place, turn, countPages };
}

/**
 * Page Down and Page Up (app.tsx): on a zoomed page they scroll it a screen at a time first and turn it at its foot
 * or head, as PDF readers do; a page turned back to from its head opens at its foot (`toFoot`). Unzoomed, they turn
 * the page. `pageKey` always holds the handler for the latest render.
 */
function usePageKeys(panel: PanelRef, zoom: number, shown: number | null, turn: (delta: number) => void) {
  const toFoot = useRef(false);
  const pageKey = useRef((_dir: 1 | -1) => {});
  pageKey.current = (dir) => {
    const body = docBody(panel);
    const room = body ? body.scrollHeight - body.clientHeight : 0;
    const canScroll = body && zoom > 1 && (dir > 0 ? body.scrollTop < room - 2 : body.scrollTop > 2);
    if (canScroll) {
      body.scrollTop += dir * Math.max(80, body.clientHeight - 150);   // less the faded foot under the bar
      return;
    }
    if (dir < 0 && zoom > 1 && shown !== null && shown > 1) toFoot.current = true;
    turn(dir);
  };
  return { toFoot, pageKey };
}

/** The bar's two menus, the list of documents and the drafts of this one; one is open at a time. */
function useDocMenus(store: Store, docs: DocRef[], current: DocRef) {
  const [menu, setMenu] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  useDismiss(menu, () => setMenu(false), '.docnav');
  useDismiss(draftsOpen, () => setDraftsOpen(false), '.docnav', '#doc-drafts');
  const closeBoth = () => {
    setMenu(false);
    setDraftsOpen(false);
  };
  const toggleMenu = () => {
    setDraftsOpen(false);
    setMenu(!menu);
  };
  const toggleDrafts = (open: boolean) => {
    setMenu(false);
    setDraftsOpen(open);
  };
  const pickDoc = (picked: number) => {
    if (picked >= 0) store.ui({ doc: picked, docAside: null });
    setMenu(false);
  };
  // a draft the list already cites opens there; another opens on its own, at its first page (drafts are paged
  // differently), and no page of it is cited
  const openDraft = (draft: { doc: string; docId: string }) => {
    const listed = docs.findIndex((doc) => doc.docId === draft.docId);
    setDraftsOpen(false);
    if (listed >= 0) store.ui({ doc: listed, docAside: null });
    else if (draft.docId !== current.docId) store.ui({ docAside: draftAside(draft, current) });
  };
  return { menu, draftsOpen, closeBoth, toggleMenu, toggleDrafts, pickDoc, openDraft };
}

/**
 * The open document, in reading mode. `docs`: the list it steps through; `index`: which of them is open, or null for
 * `aside`, a document opened on its own; `headed`: the list is shown with headings (on a deal's or Home's
 * conversations).
 */
export function DocPanel({ dealId, docs, index, aside, headed }: {
  dealId: string; docs: DocRef[]; index: number | null; aside: DocRef | null; headed: boolean;
}) {
  const store = useStore();
  const state = useAppState();
  const current = aside ?? docs[index ?? 0];
  const drafts = useDrafts(current.dealId ?? dealId, current.docId);
  const menus = useDocMenus(store, docs, current);
  // Zoom stays as it is from one document to the next.
  const [zoom, setZoom] = useState(1);
  const page = state.pages[pageKeyFor(dealId, current)];
  const pages = usePageTurns(store, docs, current, page);
  const docChanged = [dealId, current.doc, current.docId, current.loc];
  useEffect(() => {
    void loadPage(store, dealId, current);
  }, docChanged);
  // a different document closes the list; done with the frame that shows it, so a key pressed straight after is not
  // undone
  useLayoutEffect(() => {
    menus.closeBoth();
    pages.setPageAt(null);
  }, docChanged);
  useEffect(() => () => dropPdf(), []);                // the file PDF.js holds goes when reading mode closes
  // the arrows step through the list; from a document opened on its own they step back into it
  const canStep = aside ? docs.length > 0 : docs.length > 1;
  const step = (delta: number) => {
    if (!canStep) return;
    const from = index ?? 0;
    const to = aside ? (delta > 0 ? 0 : docs.length - 1) : (from + delta + docs.length) % docs.length;
    store.ui({ docAside: null, doc: to });
  };
  const zoomBy = (direction: -1 | 0 | 1) => setZoom((zoomed) => (direction === 0 ? 1 : zoomStep(zoomed, direction)));
  const panel = useRef<HTMLElement>(null);
  const { toFoot, pageKey } = usePageKeys(panel, zoom, pages.shown, pages.turn);
  usePlacement(panel, zoom);
  useEffect(() => {
    docBody(panel)?.querySelector('td.hl')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [index, typeof page]);
  usePageScroll(panel, zoom, `${dealId}|${docKey(current)}`, pages.pageAt, current.loc, toFoot);
  useZoomInput(panel, zoomBy, pageKey);
  const citationCount = !aside && docs.length > 1 ? `Citation ${(index ?? 0) + 1} of ${docs.length}` : null;
  return (
    <aside class="docpanel" aria-label="Document" ref={panel}>
      <div class="docstage"><div class="docbody">
        <DocPage page={page} dealId={dealId} current={current} shown={pages.shown} zoom={zoom}
          onPages={pages.countPages} />
      </div></div>
      <div class="docnav">
        <DocStep id="doc-prev" label="Previous document" tip="Previous document · Left" icon="prev"
          disabled={!canStep} onClick={() => step(-1)} />
        <DocTitle current={current} newer={newerThan(drafts, current.docId)} place={pages.place} offCite={pages.offCite}
          citationCount={citationCount} menu={menus.menu} onClick={menus.toggleMenu} />
        <DraftsButton drafts={drafts} docId={current.docId} open={menus.draftsOpen} setOpen={menus.toggleDrafts} />
        <DocStep id="doc-next" label="Next document" tip="Next document · Right" icon="next"
          disabled={!canStep} onClick={() => step(1)} />
        <button type="button" id="doc-close" aria-label="Close document" onClick={() => closeDocument(store)}>
          <Icon name="close" size={15} />
        </button>
        {menus.menu && <DocMenu docs={docs} index={index} aside={aside} headed={headed} dealId={dealId}
          pick={menus.pickDoc} />}
        {menus.draftsOpen && <DraftsMenu drafts={drafts} docId={current.docId} pick={menus.openDraft} />}
      </div>
      <PageControls shown={pages.shown} total={pages.pageCount} paged={!(isView(page) && page.kind === 'sheet')}
        zoom={zoom} turn={pages.turn} zoomBy={zoomBy} />
    </aside>
  );
}

/**
 * The document's name, which opens the list of documents, with where it is cited (or the page shown) and which
 * citation of the list it is. `newer`: a newer draft of it, when there is one.
 */
function DocTitle({ current, newer, place, offCite, citationCount, menu, onClick }: {
  current: DocRef; newer: DraftRef | null; place: string; offCite: boolean; citationCount: string | null;
  menu: boolean; onClick: () => void;
}) {
  return (
    <button type="button" id="doc-menu" class="docname" aria-haspopup="menu" aria-expanded={menu} onClick={onClick}>
      <span class="dn">
        <b><DocName name={current.doc} playOnShow key={docKey(current)} /><CachedMark doc={current} /></b>
        {newer && <small title={`The newest is ${draftDate(newer, true)}`}>Earlier draft</small>}
      </span>{' '}
      <span class="loc">{place}</span>
      {offCite ? <span class="cnt off" title={`Cited: ${current.loc}`}>Not cited</span>
        : citationCount && <span class="cnt">{citationCount}</span>}
    </button>
  );
}

/** A step to the previous or next document in the list. */
function DocStep({ id, label, tip, icon, disabled, onClick }: {
  id: string; label: string; tip: string; icon: string; disabled: boolean; onClick: () => void;
}) {
  return (
    <button type="button" id={id} title={tip} aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={16} />
    </button>
  );
}

/** A page that has arrived: not loading, not failed and not missing. */
function isView(page: PageState | undefined): page is PageView {
  return !!page && page !== 'loading' && page !== 'failed' && page.kind !== 'missing';
}

/** Another draft of the open document, opened on its own from the same place in the conversation. */
function draftAside(draft: { doc: string; docId: string }, current: DocRef): DocRef {
  return {
    doc: draft.doc, docId: draft.docId, loc: '', from: current.from,
    ...(current.ask ? { ask: current.ask } : {}),
    ...(current.dealId ? { dealId: current.dealId } : {}),
  };
}

/** What the panel shows of the document: a placeholder while it loads, why it could not, or the page or sheet. */
function DocPage({ page, dealId, current, shown, zoom, onPages }: {
  page: PageState | undefined; dealId: string; current: DocRef; shown: number | null; zoom: number;
  onPages: (url: string, n: number) => void;
}) {
  const store = useStore();
  if (!page || page === 'loading') {
    return (
      <article class="page ph-page" aria-busy="true"><div class="ph"><i /><i /><i /><i /><i /><i /></div></article>
    );
  }
  if (page === 'failed' || page.kind === 'missing') {
    const retry = () => {
      store.setPage(pageKeyFor(dealId, current), undefined);
      void loadPage(store, dealId, current);
    };
    return (
      <article class="page"><p class="loadfail" id="doc-error">
        {page === 'failed' ? 'Couldn’t load this page.' : `${page.message}.`}{' '}
        <button type="button" class="tundo" onClick={retry}>Retry</button>
      </p></article>
    );
  }
  if (page.kind === 'sheet') return <SheetGrid page={page} />;
  const pageNumber = shown ?? page.page;
  if (page.url) {
    return <PdfPage url={page.url} page={pageNumber} zoom={zoom} key={page.url + pageNumber} onPages={onPages} />;
  }
  return (
    <article class="page">
      <h4>{current.doc.replace(/\.(pdf|xlsx?)$/i, '')}</h4>
      <p>Preview unavailable for this sample document.</p>
      <div class="pg">Page {pageNumber}</div>
    </article>
  );
}

/** A spreadsheet's cells around the cited one, which is highlighted with its column and row headings. */
function SheetGrid({ page }: { page: Omit<SheetView, 'kind' | 'name'> }) {
  const cited = page.cell ? /^([A-Z]+)(\d+)$/.exec(page.cell) : null;
  const citedColumn = cited ? cited[1] : null;
  const citedRow = cited ? +cited[2] : null;
  const isNumber = (cell: string) => /^[\d.,()%-]+$/.test(cell);
  return (
    <table class="sheet grid">
      <thead><tr><th />{page.cols.map((column) => (
        <th key={column} class={column === citedColumn ? 'hc' : ''}>{column}</th>
      ))}</tr></thead>
      <tbody>{page.rows.map((row) => (
        <tr key={row.r}><th class={row.r === citedRow ? 'hc' : ''}>{row.r}</th>{row.cells.map((cell, i) => {
          const isCited = page.cols[i] === citedColumn && row.r === citedRow;
          return <td key={i} class={`${isNumber(cell) ? 'n' : ''} ${isCited ? 'hl' : ''}`}>{cell}</td>;
        })}</tr>
      ))}</tbody>
    </table>
  );
}
