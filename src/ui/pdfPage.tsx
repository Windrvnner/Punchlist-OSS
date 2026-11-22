/// <reference types="vite/client" />
// One page of a PDF in reading mode, drawn by PDF.js, which is loaded the first time a PDF is shown.
import type { RefObject } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import workerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

async function loadPdfJs() {
  const library = await import('pdfjs-dist/legacy/build/pdf.mjs');
  library.GlobalWorkerOptions.workerSrc = workerSrc;
  return library;
}

/**
 * The open file, kept while its pages are stepped through so each page is not a fresh read of the whole file; one at a
 * time.
 */
let held: { url: string; doc: Promise<any> } | null = null;
function openPdf(url: string): Promise<any> {
  if (held?.url === url) return held.doc;
  dropPdf();
  const doc = loadPdfJs().then((library) => library.getDocument({ url, isEvalSupported: false }).promise);
  held = { url, doc };
  doc.catch(() => {
    if (held?.doc === doc) held = null;            // a failed open is tried again next time
  });
  return doc;
}
/** Lets go of the file PDF.js holds open. */
export function dropPdf() {
  const was = held;
  held = null;
  was?.doc.then((doc) => doc.destroy(), () => {});
}

/** The parts of a PDF.js page used here. */
type PdfJsPage = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: CanvasRenderingContext2D | null; viewport: { width: number; height: number } }):
    { promise: Promise<void>; cancel: () => void };
};

/** Pixels a drawn page may hold: a zoomed page on a 2x screen would reach 30 million. */
const MAX_PIXELS = 16e6;

/**
 * Draws one page of a PDF on a canvas off screen, as wide as `sheet` leaves it, at the screen's pixel density but never
 * past MAX_PIXELS (past that the browser scales it up). `onTask` is handed the render, so that it can be canceled.
 */
async function drawOffScreen(pdfPage: PdfJsPage, sheet: HTMLElement, onTask: (task: { cancel: () => void }) => void) {
  const style = getComputedStyle(sheet);
  const width = Math.max(200, sheet.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const actual = pdfPage.getViewport({ scale: 1 });
  const wanted = (width / actual.width) * (window.devicePixelRatio || 1);
  const most = Math.sqrt(MAX_PIXELS / (actual.width * actual.height));
  const viewport = pdfPage.getViewport({ scale: Math.min(wanted, most) });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const task = pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport });
  onTask(task);
  await task.promise;
  return canvas;
}

/** Copies a page drawn off screen onto the canvas shown, and frees the copy's memory at once. */
function copyIn(from: HTMLCanvasElement, to: HTMLCanvasElement) {
  to.width = from.width;
  to.height = from.height;
  to.getContext('2d')?.drawImage(from, 0, 0);
  from.width = 0;
  from.height = 0;
}

/** One drawing of a page: `gone` once it is no longer wanted; `task` the render under way, to cancel. */
type DrawJob = { gone: boolean; task: { cancel: () => void } | null };

/**
 * Draws page `page` of the file at `url` off screen and then copies it in, so a zoom swaps the page at once instead of
 * blanking it. False when the page was no longer wanted by the time it was drawn.
 */
async function drawPdfPage(url: string, page: number, sheet: RefObject<HTMLElement | null>,
  canvas: RefObject<HTMLCanvasElement | null>, job: DrawJob, onPages: (url: string, n: number) => void) {
  const doc = await openPdf(url);
  if (!job.gone) onPages(url, doc.numPages);
  const pdfPage = await doc.getPage(Math.min(page, doc.numPages));
  if (job.gone || !sheet.current || !canvas.current) return false;
  const offScreen = await drawOffScreen(pdfPage, sheet.current, (task) => {
    job.task = task;
  });
  if (job.gone || !canvas.current) return false;
  copyIn(offScreen, canvas.current);
  return true;
}

/** One page of a PDF, drawn by PDF.js. `onPages` is told how many pages the file has. */
export function PdfPage({ url, page, zoom, onPages }: {
  url: string; page: number; zoom: number; onPages: (url: string, n: number) => void;
}) {
  const sheet = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(false);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    const job: DrawJob = { gone: false, task: null };
    const draw = async () => {
      try {
        if (!(await drawPdfPage(url, page, sheet, canvas, job, onPages))) return;
        drawn.current = true;
        setState('ready');
      } catch {
        if (!job.gone) setState('failed');
      }
    };
    // a zoom waits for the steps to settle
    const timer = window.setTimeout(() => void draw(), drawn.current ? 120 : 0);
    return () => {
      job.gone = true;
      clearTimeout(timer);
      job.task?.cancel();
    };
  }, [url, page, zoom]);
  if (state === 'failed') {
    return (
      <article class="page">
        <p class="loadfail">Couldn’t display this page.</p><div class="pg">Page {page}</div>
      </article>
    );
  }
  return (
    <article class={`page pdf ${state === 'ready' ? 'ready' : ''}`} ref={sheet}>
      <canvas ref={canvas} /><div class="pg">Page {page}</div>
    </article>
  );
}
