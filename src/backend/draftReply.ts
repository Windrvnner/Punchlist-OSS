import { markerPieces } from '../domain/cite';
import type { Source } from '../domain/model';

/**
 * The sentences of a draft's own text, each with its trailing citation markers (the split `draft` has always used).
 * The final sentence has no separator after it. The split keeps each separator (a space, a line break or a blank line),
 * so a draft's paragraphs stay as the model wrote them.
 */
const SENTENCE_END = /(?<=[.!?](?:\s*\[\d+\])*)(\s+)(?!\[)/;

/**
 * Take the model's credits to earlier responses out of its draft (#286).
 *
 * The model is shown earlier responses only by their questions' ids and never their numbers, so a credit can only name
 * one of those ids (#1105). A calendar quarter ("Q3 2027") can never be mistaken for one, whatever the words around it.
 * A source that only a dropped sentence cited goes with it and the markers that remain are renumbered; a source the
 * reply listed without any marker stays.
 */
export function withoutDraftCredits(
  reply: { text: string; sources: Source[] },
  shownIds: readonly string[],
): { text: string; sources: Source[] } {
  if (!shownIds.length) return reply;
  const parts = reply.text.split(SENTENCE_END);
  const credited = (part: number) => shownIds.some((id) => parts[part].includes(id));
  if (!parts.some((_, part) => part % 2 === 0 && credited(part))) return reply;
  const text = joinSentences(parts, credited);

  const cited = new Set(markerPieces(reply.text, reply.sources.length).map((piece) => piece.ref));
  const used = new Set(markerPieces(text, reply.sources.length).map((piece) => piece.ref));
  const renumber = new Map<number, number>();
  const sources = reply.sources.filter((_, index) => {
    const ref = index + 1;
    if (cited.has(ref) && !used.has(ref)) return false;
    renumber.set(ref, renumber.size + 1);
    return true;
  });
  const renumbered = markerPieces(text, reply.sources.length)
    .map((piece) => (piece.ref === undefined ? piece.text : `[${renumber.get(piece.ref)}]`))
    .join('');
  return { text: renumbered, sources };
}

/**
 * The draft's sentences (even places of `parts`, with the separator after each at the odd place after it) without the
 * ones `dropped` names. A dropped sentence takes the separator after it, so what is left is the model's own text with
 * its own spacing, paragraphs included.
 */
function joinSentences(parts: string[], dropped: (part: number) => boolean): string {
  let out = '';
  for (let at = 0; at < parts.length; at += 2) {
    if (dropped(at)) continue;
    out += parts[at] + (parts[at + 1] ?? '');
  }
  return out.trim();
}
