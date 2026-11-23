/**
 * Every notice at the top of the page is this one base:
 * the same capsule, a glyph, a bold title with its detail in gray, a slot for its
 * buttons and a close ✕, all in the same places. Notices differ only in their words and glyph: a check for something
 * done, a triangle for something that did not happen. No color marks either; the glyphs are gray.
 */
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Icon } from './icons';
import { graphemes } from './docName';

export type Glyph = 'done' | 'warn';
export interface NoticeAction { label: string; run: () => void; id?: string }

// A notice's title or detail can be clipped within the text container (#564).
function noticeTextOverflows(el: HTMLElement): boolean {
  const overflows = (part: Element) => part.scrollWidth > part.clientWidth;
  const shortened = !!el.querySelector('.tcut[data-shortened], .tbody[hidden]');   // a part that gave way to fit (#27)
  return shortened || overflows(el) || Array.from(el.querySelectorAll('.ttitle, .tbody')).some(overflows);
}

/**
 * The base: glyph, words, actions and ✕, on one 24px line inside the capsule. `tip` is shown on hover always; `full`
 * only when the words are cut short.
 */
export function Notice({ glyph, children, actions = [], onClose, id, class: cls = '', role, tip, full }: {
  glyph: Glyph; children: ComponentChildren; actions?: NoticeAction[]; onClose?: () => void;
  id?: string; class?: string; role?: 'alert' | 'status'; tip?: string; full?: string;
}) {
  const showFull = (e: MouseEvent) => {
    if (tip || !full) return;
    const text = e.currentTarget as HTMLElement;
    text.title = noticeTextOverflows(text) ? full : '';
  };
  return (
    <div class={`toast ${cls}`.trim()} id={id} role={role}>
      <span class="tg" aria-hidden="true"><Icon name={glyph === 'warn' ? 'warn' : 'check'} size={16} /></span>
      <span class="ttext" title={tip} onMouseEnter={showFull}>{children}</span>
      {actions.map((a) => (
        <button type="button" class="tundo" id={a.id} key={a.label} onClick={a.run}>{a.label}</button>))}
      {onClose && <button type="button" class="tclose" aria-label="Dismiss" onClick={onClose}>
        <Icon name="close" size={13} />
      </button>}
    </div>
  );
}

/**
 * A notice's words: its first part bold as the title, the rest after " · " in gray. The " · " stays in the text for
 * screen readers and copying, but is not shown. A `cut` part that may be shortened gives way first.
 */
export function NoticeWords({ text, cut }: { text: string; cut?: string }) {
  const at = text.indexOf(' · ');
  const title = at < 0 ? text : text.slice(0, at);
  const body = at < 0 ? '' : text.slice(at + 3);
  return (
    <>
      <b class="ttitle"><Part text={title} cut={cut} /></b>
      {body && <><span class="sr-only"> · </span><Detail><Part text={body} cut={cut} /></Detail></>}
    </>
  );
}

/**
 * The detail gives way first, to an ellipsis; where not even its first word would show, it is left out rather than
 * shown as a stub of letters (#27). The whole text is still on hover and read aloud.
 */
function Detail({ children }: { children: ComponentChildren }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.hidden = false;
      if (el.scrollWidth <= el.clientWidth) return;
      el.hidden = el.clientWidth < firstWordWidth(el);
    };
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  });
  return <span class="tbody" ref={ref}>{children}</span>;
}

/** how wide the first word of an element's text is drawn, with the ellipsis that would follow it */
function firstWordWidth(el: HTMLElement): number {
  const node = el.firstChild;
  if (!(node instanceof Text)) return 0;
  const end = node.data.indexOf(' ');
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, end < 0 ? node.data.length : end);
  return range.getBoundingClientRect().width + 12;      // and room for "…"
}

/** One part of a notice's words, with its `cut` shortened to fit where it holds it. */
function Part({ text, cut }: { text: string; cut?: string }) {
  const at = cut ? text.indexOf(cut) : -1;
  if (!cut || at < 0) return <>{text}</>;
  return (
    <span class="tsplit">
      <span>{text.slice(0, at)}</span><Cut text={cut} /><span>{text.slice(at + cut.length)}</span>
    </span>
  );
}

/** the first words of `words`, from all but the last down to `least`, each ending in "…" after no comma */
const fewerWords = (words: string[], least: number) => {
  const count = Math.max(words.length - least, 0);
  const firstWords = (n: number) => words.slice(0, n).join(' ').replace(/,$/, '');
  return Array.from({ length: count }, (_, i) => `${firstWords(words.length - 1 - i)}…`);
};

/** where the bracket that closes `text` opens, counting brackets inside it, as "Fund IV (Lux)"; -1 if none */
function closingBracketStart(text: string) {
  if (!text.endsWith(')')) return -1;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && --depth === 0) return i;
  }
  return -1;
}

/** a deal's name and the words of its twin line, from "Project Name (Twin)"; null for other text */
function twinParts(text: string): { name: string[]; twin: string[] } | null {
  const open = closingBracketStart(text);
  if (open < 1 || text[open - 1] !== ' ') return null;
  return { name: text.slice(0, open - 1).split(' '), twin: text.slice(open + 1, -1).split(' ') };
}

/**
 * Shorter forms of a part that gives way, longest first, each cut at a whole word. A deal's name with its twin line in
 * brackets, "Project Name (Twin)", gives up words of the name first, down to "Project" and one more, then words of
 * the twin line, so what tells the deal from its twin stays as long as it can (#27). The name may hold brackets of its
 * own: the twin line is the last bracket.
 */
export function shorterForms(text: string): string[] {
  const parts = twinParts(text);
  if (!parts) return fewerWords(text.split(' '), 1);
  const { name, twin } = parts;
  const least = name[0] === 'Project' ? 2 : 1;
  const shortName = name.length > least ? `${name.slice(0, least).join(' ')}…` : name.join(' ');
  return [
    ...fewerWords(name, least).map((n) => `${n} (${twin.join(' ')})`),
    ...fewerWords(twin, 1).map((t) => `${shortName} (${t})`),
  ];
}

/**
 * Where none of the shorter forms fits, the part is cut at a letter: `head` gives way and `tail` stays, so a deal's
 * name gives way and the first word of its twin line still shows (#27).
 */
export function letterCut(text: string): { head: string; tail: string } {
  const parts = twinParts(text);
  if (!parts) return { head: text, tail: '' };
  const first = fewerWords(parts.twin, 1).at(-1) ?? parts.twin[0];
  return { head: parts.name.join(' '), tail: ` (${first})` };
}

/** words that say something did not happen */
const NOT_DONE = /\b(not|couldn’t|couldn't|can’t|can't|cannot|didn’t|didn't|failed|isn’t|wasn’t|unable|full|in use)\b/i;
/**
 * Undo marks completed work. Retry and failure wording in the title mark work that did not finish (#565).
 */
export function glyphOf(text: string, action?: string): Glyph {
  if (action === 'Undo') return 'done';
  if (action === 'Retry' || action === 'Retry Now') return 'warn';
  const [title] = text.split(' · ', 1);
  return NOT_DONE.test(title) ? 'warn' : 'done';
}

/**
 * The part of a notice that gives way when the line does not fit: it is cut at a whole word (see shorterForms), or,
 * where even the shortest of those does not fit, at a whole character (see letterCut), trimmed, and ending in "…"
 * right before the words after it. CSS's own ellipsis leaves a gap there (the room a cut character would
 * have taken, and a space when the cut falls after one), so it is only the fallback. Screen readers get the whole
 * text.
 */
function Cut({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // the span is as wide as its text until there is no more room, so the text fits when it does not overflow the span.
    // Measured to the fraction of a pixel: text over by less than one whole pixel would still be cut again by the
    // style sheet's own ellipsis, which leaves a gap before the words after it (#754).
    const fits = (s: string) => {
      el.textContent = s;
      const text = document.createRange();
      text.selectNodeContents(el);
      return text.getBoundingClientRect().width <= el.getBoundingClientRect().width + 0.01;
    };
    const fit = () => {
      delete el.dataset.shortened;
      if (fits(text)) return;
      el.dataset.shortened = '';
      const byWords = shorterForms(text).find(fits);
      if (byWords) return;                  // fits() has put it in place
      const { head, tail } = letterCut(text);
      const g = graphemes(head);
      const at = (n: number) => `${g.slice(0, n).join('').trimEnd()}…${tail}`;
      let lo = 0;
      let hi = g.length - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (fits(at(m))) lo = m;
        else hi = m - 1;
      }
      el.textContent = at(lo);
    };
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, [text]);
  return <><span class="tcut" ref={ref} aria-hidden="true" /><span class="sr-only">{text}</span></>;
}
