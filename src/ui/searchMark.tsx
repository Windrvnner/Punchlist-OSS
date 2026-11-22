import type { JSX } from 'preact';
import { fold } from '../app/search';

/**
 * A result's wording with what was typed in bold, so the eye finds why it matched.
 * Matched as search matches, without case, accents or stray spacing, by folding each character on its own and
 * keeping where it came from. A result found only with its hyphens and spaces left out ("lockup" for "Lock-up") shows
 * no bold.
 */
export function Marked({ text, query }: { text: string; query: string }) {
  const q = fold(query);
  if (!q) return <>{text}</>;
  const { folded, from } = foldedWithPlaces(text);
  const out: (string | JSX.Element)[] = [];
  let shown = 0;
  for (let at = folded.indexOf(q); at >= 0; at = folded.indexOf(q, at + q.length)) {
    const start = from[at];
    const end = from[at + q.length - 1] + 1;
    if (start < shown) continue;
    out.push(text.slice(shown, start), <b key={start}>{text.slice(start, end)}</b>);
    shown = end;
  }
  out.push(text.slice(shown));
  return <>{out}</>;
}

/** The text folded as `fold` folds it, with the place in the text each folded character came from. */
function foldedWithPlaces(text: string) {
  let folded = '';
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]);
    if (space && (folded === '' || folded.endsWith(' '))) continue;   // a run of spaces folds to one; leading ones go
    const one = space ? ' ' : text[i].normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
    for (const c of one) {
      folded += c;
      from.push(i);
    }
  }
  return { folded, from };
}
