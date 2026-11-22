/**
 * A file name that may be long. Always one line. Data-room names often differ only at
 * the end ("… v7 CLEAN.pdf" / "… v7 REDLINE.pdf"), so when there is no room the middle
 * is shortened and both the start and the end stay visible.
 *
 * Hovering a shortened name shows it in full in a tooltip and slides it through once to
 * its end; `playOnShow` does the same once when the name appears (the reading bar). The
 * slide lasts under five seconds, never repeats by itself, stops when the pointer leaves,
 * and does not run when the system asks for reduced motion. Screen readers and copying
 * always get the full name: the shortening is visual only.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { showTip, hideTip } from './tip';

/**
 * File names come from other people's data rooms and are not clean. For display only:
 * line breaks, tabs and control characters become a space (they would otherwise break the
 * single line), and a name that is blank shows as "Unnamed file". The stored name is untouched.
 */
export function displayName(name: string): string {
  const shown = name.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, ' ').trim();
  return shown || 'Unnamed file';
}
/** A document's name as a title, without the file type at its end ("Technical advisor report"). */
export const docTitle = (name: string): string => displayName(name).replace(/\.(pdf|docx?|xlsx?|pptx?)$/i, '');
/** Whole characters as a person sees them, so an accented letter, an emoji or a CJK character is never cut in half. */
export const graphemes = (s: string): string[] => {
  const Seg = (Intl as any)?.Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(s), (x: any) => x.segment as string) : Array.from(s);
};
const END = 18;
/**
 * [start, end] of a name too long to show whole. The end is the last two words when a space or
 * underscore makes that possible and they are short enough (a version and the extension stay
 * together). Names with no such break (one long word, a hash, a script written without spaces)
 * end with their last 18 characters instead. Nothing is ever dropped: start + end is the name.
 */
export function splitName(name: string): [string, string] {
  if (name.length <= 30) return [name, ''];
  const seps: number[] = []; for (let i = name.length - 1; i > 0 && seps.length < 2; i--) if (name[i] === ' ' || name[i] === '_') seps.push(i);
  const fits = (i: number | undefined) => i !== undefined && name.length - i >= 8 && name.length - i <= 28;
  const at = fits(seps[1]) ? seps[1] : fits(seps[0]) ? seps[0] : -1;
  if (at > 0) return [name.slice(0, at), name.slice(at)];
  const g = graphemes(name);
  if (g.length <= END + 8) return [name, ''];
  return [g.slice(0, -END).join(''), g.slice(-END).join('')];
}

const START_MS = 350, HOLD_MS = 700, MAX_SLIDE_S = 3.2;   // 0.35 + 3.2 + 0.7 = 4.25 s at most
const MAX_SPEED = 220;                                    // px per second; faster than this cannot be read, so such a name is left to the tooltip

export function DocName({ name, playOnShow = false }: { name: string; playOnShow?: boolean }) {
  const root = useRef<HTMLSpanElement>(null); const timers = useRef<number[]>([]);
  const shown = displayName(name);
  // the space where the name is split ends the start, not the end: when the start is shortened it goes with it, so "…"
  // sits against the end rather than a space away
  const [start, end] = splitName(shown); const head = end.startsWith(' ') ? start + ' ' : start; const tail = end.startsWith(' ') ? end.slice(1) : end;
  const shortened = () => { const h = root.current?.querySelector<HTMLElement>('.dnh'); return !!h && h.scrollWidth > h.clientWidth + 1; };
  const stop = () => {
    for (const t of timers.current) clearTimeout(t); timers.current = [];
    const el = root.current; if (!el) return;
    el.classList.remove('run'); el.style.width = ''; el.style.removeProperty('--dx'); el.style.removeProperty('--dur');
  };
  const play = () => {
    const el = root.current;
    if (!el || el.classList.contains('run') || !shortened() || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const width = el.getBoundingClientRect().width;
    el.style.width = `${width}px`; el.classList.add('run');                       // full text, clipped to the same box
    const over = el.querySelector<HTMLElement>('.dni')!.getBoundingClientRect().width - width;
    if (over <= 1 || over > MAX_SPEED * MAX_SLIDE_S) { stop(); return; }
    const dur = Math.max(0.6, Math.min(MAX_SLIDE_S, over / 90));
    timers.current.push(window.setTimeout(() => { el.style.setProperty('--dur', `${dur}s`); el.style.setProperty('--dx', `${-over}px`); }, START_MS));
    timers.current.push(window.setTimeout(stop, START_MS + dur * 1000 + HOLD_MS));
  };
  useLayoutEffect(() => {
    const el = root.current;
    const t = playOnShow ? window.setTimeout(play, 600) : 0;
    return () => { clearTimeout(t); stop(); if (el) hideTip(el); };
  }, [name, playOnShow]);
  const enter = () => { const el = root.current; if (!el) return; if (shortened() || el.classList.contains('run')) showTip(el, shown); play(); };
  const leave = () => { if (root.current) hideTip(root.current); stop(); };
  return <span class="docnm" dir="ltr" ref={root} onMouseEnter={enter} onMouseLeave={leave}><span class="dni"><span class="dnh">{head}</span>{tail && <span class="dnt">{tail}</span>}</span></span>;
}
