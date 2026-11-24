import { markerPieces } from '../domain/cite';
import type { Source } from '../domain/model';

const QUESTION_NUMBER = /\bQ(\d+)\b/g;
const QUESTION_LEAD = /\b(?:question|(?:answer|reply|replied|response|responded) to)\s+\(?\s*$/i;
const QUESTION_LABEL = /\bas\s+(?:previously\s+)?answered(?:\s+to\s+[^.!?()]+)?\s+\(\s*$/i;
const QUESTION_ACTION = /^\s+(?:was|is|has been|had been)\s+(?:already\s+)?(?:asked|answered)\b/i;
const ANSWER_CREDIT = /\bas\s+(?:(?:already|previously)\s+)?answered\s+(?:in|under)\s+$/i;
const YEAR_QUALIFIER = new RegExp(
  String.raw`^(?:[-/])?\s*(?:\(\s*|(?:in|of)\s+(?:(?:calendar|fiscal) year\s+)?)?`
  + String.raw`(?:[12]\d{3}|FY\s*(?:[12]\d{3}|\d{2})|['’]\d{2})\b`,
  'i',
);

const MARKERS = String.raw`(?:\s*\[\d+\])*`;
const CLOSERS = String.raw`["'”’)\]]+`;
const PARAGRAPH = String.raw`\r?\n(?:[ \t]*\r?\n)+`;
const PLAIN_END = String.raw`(?<=[.!?]${MARKERS})\s+(?![\s\[])`;
const QUOTED_END = String.raw`(?<=[.!?](?:${CLOSERS}${MARKERS}|${MARKERS}${CLOSERS}))\s+(?![\s\[\p{Ll}])`;
const DRAFT_BREAK = new RegExp(`(${PARAGRAPH}|${PLAIN_END}|${QUOTED_END})`, 'u');
const lineBreaks = (text: string) => text.split('\n').length - 1;

function hasDraftCredit(sentence: string, shown: Set<number>): boolean {
  for (const match of sentence.matchAll(QUESTION_NUMBER)) {
    const number = Number(match[1]);
    if (!shown.has(number)) continue;
    if (number > 4) return true;

    // Q1 through Q4 can be calendar quarters. Remove them only with evidence of a question reference.
    const before = sentence.slice(0, match.index);
    const after = sentence.slice(match.index + match[0].length);
    if (QUESTION_ACTION.test(after) || (QUESTION_LABEL.test(before) && /^\s*\)/.test(after))) return true;
    if (!YEAR_QUALIFIER.test(after) && (QUESTION_LEAD.test(before) || ANSWER_CREDIT.test(before))) return true;
  }
  return false;
}

/** Preserve separators between kept sentences, including paragraph breaks crossed by a removed credit. */
function keepDraftSentences(text: string, shown: Set<number>): string {
  const parts = text.split(DRAFT_BREAK);
  let kept = '';
  let separator = '';
  for (let index = 0; index < parts.length; index += 2) {
    const gap = parts[index - 1] ?? '';
    if (lineBreaks(gap) >= lineBreaks(separator)) separator = gap;
    const sentence = parts[index];
    if (!sentence || hasDraftCredit(sentence, shown)) continue;
    kept += (kept ? separator : '') + sentence;
    separator = '';
  }
  return kept;
}

/** Keep the model's own wording apart from credits to earlier questions (#286). */
export function withoutDraftCredits(
  reply: { text: string; sources: Source[] },
  shownNumbers: number[],
): { text: string; sources: Source[] } {
  if (!shownNumbers.length) return reply;
  const keptText = keepDraftSentences(reply.text, new Set(shownNumbers));
  if (keptText === reply.text) return reply;

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
