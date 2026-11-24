import { markerPieces } from '../domain/cite';
import type { Source } from '../domain/model';

const QUARTERS = String.raw`Q[1-4](?:\s*[-–—/]\s*Q[1-4])*`;
const YEAR = String.raw`(?:[12]\d{3}|FY\s*(?:[12]\d{3}|\d{2})|['’]\d{2})\b`;
const DATED_QUARTER = new RegExp(
  String.raw`\b${QUARTERS}\s*(?:\(\s*${YEAR}\s*\)|(?:[-–—/]\s*|of\s+)?${YEAR})`,
  'gi',
);
// A comma can end a credit. In "As answered in Q3, 2027 costs …", the year begins a new clause.
const COMMA_QUARTER = new RegExp(String.raw`\b${QUARTERS},\s*${YEAR}(?=\s*(?:[.,;:!?)]|$))`, 'gi');
const YEAR_FIRST_QUARTER = new RegExp(String.raw`\b${YEAR}\s*(?:[-–—/]\s*)?${QUARTERS}\b`, 'gi');
const SENTENCE_BREAK = /(?<=[.!?]["'”’)\]]*(?:\s*\[\d+\]["'”’)\]]*)*)\s+(?!\[)/;

/** Keep the model's own wording apart from credits to earlier questions (#286). */
export function withoutDraftCredits(
  reply: { text: string; sources: Source[] },
  shownNumbers: number[],
): { text: string; sources: Source[] } {
  const credits = shownNumbers.length ? new RegExp(`\\bQ(?:${shownNumbers.join('|')})\\b`) : null;
  const sentences = reply.text.split(SENTENCE_BREAK);
  const kept = credits ? sentences.filter((sentence) => {
    const withoutDates = sentence.replace(DATED_QUARTER, ' ')
      .replace(COMMA_QUARTER, ' ')
      .replace(YEAR_FIRST_QUARTER, ' ');
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
