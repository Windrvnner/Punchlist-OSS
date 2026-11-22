/**
 * A cited phrase with its hover pop: one row per document, with the places in it
 * (document · p. 41, p. 44). The pop is placed in viewport coordinates so it never
 * leaves the window and, inside a draft, sits above the text so it cannot cover the
 * action buttons beneath. Where the whole list can be shown elsewhere (`onMore`),
 * a pop with more than POP_ALL documents shows POP_SHOWN of them and "N more".
 */
import { onTop } from './popups';
import { useRef } from 'preact/hooks';

let seq = 0;
/** the pop's distance below the line box of the line it hangs from */
const GAP = 14;
import type { Source } from '../domain/model';
import { docKey } from '../domain/model';
import { CachedMark } from './cached';
import { DocName } from './docName';
import { showTip, hideTip } from './tip';

/** up to this many documents a pop lists them all; beyond it, with somewhere to send the rest, it lists POP_SHOWN and "N more" */
export const POP_ALL = 4;
/** sources from no more documents than a pop shows: shown in full as chips */
export const fewDocuments = (sources: Source[]) => byDocument(sources).length <= POP_ALL;
export const POP_SHOWN = 3;

/** Sources by document, in the order each document is first cited, with its places joined ("p. 41, p. 44"). */
export function byDocument(sources: Source[]): { doc: Source; places: string; items: Source[] }[] {
  const out = new Map<string, { doc: Source; places: string; items: Source[] }>();
  for (const x of sources) { const g = out.get(docKey(x)); if (g) g.items.push(x); else out.set(docKey(x), { doc: x, places: '', items: [x] }); }
  for (const g of out.values()) g.places = [...new Set(g.items.map((x) => x.loc).filter(Boolean))].join(', ');
  return [...out.values()];
}

/** places cut short to fit show in full in the app's tooltip, as a shortened name does */
const fullPlaces = (e: MouseEvent) => { const el = e.currentTarget as HTMLElement; if (el.scrollWidth > el.clientWidth + 1) showTip(el, el.textContent?.replace(/^ · /, '') ?? ''); };

export function Ref({ text, sources, className = '', above = false, onOpen, openText = 'Open document', onMore }: { text: string; sources: Source[]; className?: string; above?: boolean; onOpen?: () => void; openText?: string; onMore?: () => void }) {
  const docs = byDocument(sources); const capped = !!onMore && docs.length > POP_ALL; const shown = capped ? docs.slice(0, POP_SHOWN) : docs;
  const rb = useRef<HTMLSpanElement>(null); const pop = useRef<HTMLSpanElement>(null); const wrap = useRef<HTMLSpanElement>(null);
  const id = useRef(''); if (!id.current) id.current = `src-${++seq}`;
  const place = () => {
    const p = pop.current, r = rb.current; if (!p || !r) return;
    // measured without the pop's opening lift, whose 10px shift would otherwise be taken for the page's offset and leave the pop that much too high
    p.style.animation = 'none';
    p.style.position = 'fixed'; p.style.left = '0px'; p.style.top = '0px'; p.style.display = 'flex';
    onTop(p, true);   // in the top layer, so its glass blurs the page even inside a blurred column (popups.ts)
    const pr = p.getBoundingClientRect(); const rects = r.getClientRects(); const first = rects[0] ?? r.getBoundingClientRect(); const last = rects[rects.length - 1] ?? first;
    const vw = innerWidth, vh = innerHeight;
    // the pop hangs from the line the pointer leaves from (the phrase's last), clear of its line box and dotted underline
    const lead = Math.max(0, ((parseFloat(getComputedStyle(r).lineHeight) || last.height) - last.height) / 2);
    let top = last.bottom + lead + GAP; let from = last; let up = false;
    if (above || top + pr.height > vh - 10) { const t = first.top - lead - pr.height - GAP; top = t >= 10 ? t : Math.max(10, vh - pr.height - 10); from = first; up = true; }
    const left = Math.max(10, Math.min(from.left, vw - pr.width - 10));
    p.classList.toggle('up', up); p.style.setProperty('--bridge', `${Math.max(0, up ? first.top - (top + pr.height) : top - last.bottom)}px`);
    p.style.left = left + 'px'; p.style.top = top + 'px';
    const got = p.getBoundingClientRect(); p.style.left = (left - (got.left - left)) + 'px'; p.style.top = (top - (got.top - top)) + 'px';
    p.style.animation = '';
  };
  const reset = () => { const p = pop.current; if (p) { onTop(p, false); p.style.position = ''; p.style.left = ''; p.style.top = ''; p.style.display = ''; p.style.removeProperty('--bridge'); p.classList.remove('up'); } };
  // Escape puts the popup away while the phrase keeps the focus; it comes back the next time the phrase is reached
  const away = () => { reset(); wrap.current?.classList.add('nopop'); };
  const back = () => wrap.current?.classList.remove('nopop');
  if (!sources.length) return <span class={className}>{text}</span>;
  return (
    <span class="ref" ref={wrap} onMouseEnter={() => { back(); place(); }} onMouseLeave={reset} onFocusIn={() => { back(); place(); }} onFocusOut={() => { reset(); back(); }}>
      <span ref={rb} class={`rb ${className}`} role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} aria-describedby={id.current} onClick={onOpen ? (e) => { onOpen(); if ((e as MouseEvent).detail > 0) { (e.currentTarget as HTMLElement).blur(); reset(); } } : undefined} onKeyDown={(e) => { if (onOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(); away(); } else if (e.key === 'Escape' && pop.current && getComputedStyle(pop.current).display !== 'none') { e.stopPropagation(); away(); } }}>{text}</span>
      <span ref={pop} class="pop" role="tooltip" id={id.current}>{shown.map((g) => <i key={docKey(g.doc)} class="psrc"><DocName name={g.doc.doc} />{g.places && <span class="loc" onMouseEnter={fullPlaces} onMouseLeave={(e) => hideTip(e.currentTarget as HTMLElement)}> · {g.places}</span>}<CachedMark doc={g.doc} /></i>)}
        {/* the pop's one action, also reachable by pointer: the rest of the sources, or what a click on the phrase opens */}
        {capped ? <u class="pfoot" onClick={() => { away(); onMore!(); }}>{docs.length - POP_SHOWN} more →</u> : onOpen && <u class="pfoot" onClick={() => { away(); onOpen(); }}>{openText} →</u>}</span>
    </span>
  );
}
