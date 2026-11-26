import { markerPieces } from '../domain/cite';
import type { Source } from '../domain/model';

/**
 * The sentences of a draft's own text, each with its trailing citation markers (the split `draft` has always used).
 * The final sentence has no separator after it.
 */
const SENTENCE_END = /(?<=[.!?](?:\s*\[\d+\])*)\s+(?!\[)/;

/**
 * Take the model's credits to earlier responses out of its draft (#286).
 *
 * The model is shown earlier responses only as R1, R2, … and never their question numbers, so a credit can only name
 * one of those handles. A calendar quarter ("Q3 2027") can never be mistaken for one, whatever the words around it.
 * A source that only a dropped sentence cited goes with it and the markers that remain are renumbered; a source the
 * reply listed without any marker stays.
 */
export function withoutDraftCredits(
  reply: { text: string; sources: Source[] },
  handleCount: number,
): { text: string; sources: Source[] } {
  if (!handleCount) return reply;
  const credit = new RegExp(`\\bR(?:${Array.from({ length: handleCount }, (_, k) => k + 1).join('|')})\\b`);
  const sentences = reply.text.split(SENTENCE_END);
  const kept = sentences.filter((sentence) => !credit.test(sentence));
  const text = kept.join(' ').trim();
  if (kept.length === sentences.length) return { text, sources: reply.sources };

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
