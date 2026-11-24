import { markerPieces } from '../domain/cite';
import type { Source } from '../domain/model';

const DATED_QUARTER = /\bQ[1-4](?:\s*[-–—/]\s*Q[1-4])*\s*(?:of\s+|,\s*)?(?:FY\s*)?(?:[12]\d{3}|['’]\d{2})\b/gi;
const YEAR_FIRST_QUARTER = /\b(?:FY\s*)?[12]\d{3}\s+Q[1-4]\b/gi;

/** Keep the model's own wording apart from credits to earlier questions (#286). */
export function withoutDraftCredits(
  reply: { text: string; sources: Source[] },
  shownNumbers: number[],
): { text: string; sources: Source[] } {
  const credits = shownNumbers.length ? new RegExp(`\\bQ(?:${shownNumbers.join('|')})\\b`) : null;
  const sentences = reply.text.split(/(?<=[.!?](?:\s*\[\d+\])*)\s+(?!\[)/);
  const kept = credits ? sentences.filter((sentence) => {
    const withoutDates = sentence.replace(DATED_QUARTER, ' ').replace(YEAR_FIRST_QUARTER, ' ');
    return !credits.test(withoutDates);
  }) : sentences;
  const keptText = kept.join(' ').trim();
  if (kept.length === sentences.length) return { text: keptText, sources: reply.sources };

  const pieces = markerPieces(keptText, reply.sources.length);
  const cited = new Set(markerPieces(reply.text, reply.sources.length).map((piece) => piece.ref));
  const used = new Set(pieces.map((piece) => piece.ref));
  const renumber = new Map<number, number>();
  const sources = reply.sources.filter((_, index) => {
    const ref = index + 1;
    // Only remove sources that had a marker and lost every use when the credits were dropped.
    if (cited.has(ref) && !used.has(ref)) return false;
    renumber.set(ref, renumber.size + 1);
    return true;
  });
  const text = pieces.map((piece) => piece.ref === undefined ? piece.text : `[${renumber.get(piece.ref)}]`).join('');
  return { text, sources };
}
