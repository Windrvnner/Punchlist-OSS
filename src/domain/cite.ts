/**
 * Citation markers in generated text. A marker "[n]" refers to the nth source (1-based) and
 * supports the sentence it follows: "The draft sets 1.25x. [1] The term sheet has 1.30x. [2]".
 * A marker before the period ("…sets 1.25x [1].") means the same, and several markers in a
 * row all support that one sentence. A marker in mid-sentence supports the words since the
 * previous marker. Text with no marker after it is not cited.
 *
 * Only a number that names one of the sources is a marker. Any other bracketed number is
 * ordinary text and is left exactly as written: "[2019] App 12", "clause [4]", "[100] m",
 * and every bracket in text that has no sources at all.
 */
import type { Source } from './model';

export interface CitedPart { text: string; refs: number[] }

// "approx. 1.25x", "cl. 27.3", "p. 6": a period after one of these does not end a sentence
const ABBREV = /(?:^|[\s(])(?:approx|cl|cls|para|paras|p|pp|no|nos|art|arts|sec|s|ss|sch|fig|figs|app|vol|ch|pt|reg|r|rr|v|vs|cf|ca|c|e\.g|i\.e|etc|mr|mrs|ms|dr|ltd|inc|co|corp|plc|llc|llp|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i;

/** [uncited text before, the sentence that ends this run]. Leading space belongs to the text before, so a link never starts with a gap. */
function lastSentence(s: string): [string, string] {
  const lead = /^\s*/.exec(s)![0]; const body = s.slice(lead.length).replace(/\s+$/, '');
  // candidate breaks: end punctuation, optional closing quote or bracket, then space
  const re = /[.;!?]["’”)\]]?\s+/g; let cut = -1; let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const end = m.index + m[0].length; const next = body[end] ?? '';
    if (!next) break;
    if (/[a-z]/.test(next)) continue;                                   // a sentence does not start in lower case
    if (body[m.index] === '.' && ABBREV.test(body.slice(0, m.index + 1))) continue;
    cut = end;
  }
  return cut < 0 ? [body ? lead : '', body] : [lead + body.slice(0, cut), body.slice(cut)];
}

/** The same words with the citation markers taken out (for text that leaves the app: a response, a spreadsheet cell). */
export const withoutMarkers = (text: string, sourceCount: number): string => splitCited(text, sourceCount).map((p) => p.text).join('');

/** A marker, with the source it names, or the text between markers. */
export interface MarkerPiece { text: string; ref?: number }

/**
 * The text cut at each marker, the same rule as `splitCited`: only a number naming one of the sources is a marker.
 * Joined back, the pieces are the text exactly as it was (the finding editor's tags, #636).
 */
export function markerPieces(text: string, sourceCount: number): MarkerPiece[] {
  return text.split(/(\[\d+\])/).filter(Boolean).map((piece) => {
    const number = /^\[(\d+)\]$/.exec(piece);
    const ref = number ? Number(number[1]) : 0;
    return ref >= 1 && ref <= sourceCount ? { text: piece, ref } : { text: piece };
  });
}

/** Move a cut inside a complete citation back to its opening bracket (#343). */
export function markerSafeEnd(text: string, end: number, sourceCount: number): number {
  if (!sourceCount) return end;
  let start = 0;
  for (const piece of markerPieces(text, sourceCount)) {
    const next = start + piece.text.length;
    if (next > end) return piece.ref ? start : end;
    start = next;
  }
  return end;
}

/** Keep the fitting prefix of a passage, omitting a citation that the cut divides (#343). */
export function takeMarkerPieces(pieces: MarkerPiece[], room: number): MarkerPiece[] {
  const fitting: MarkerPiece[] = [];
  for (const piece of pieces) {
    if (room <= 0) break;
    if (piece.text.length > room) {
      if (!piece.ref) fitting.push({ text: piece.text.slice(0, room) });
      break;
    }
    fitting.push(piece);
    room -= piece.text.length;
  }
  return fitting;
}

type MarkerSource = Pick<Source, 'docId' | 'loc'>;

/** Number citations for the recipient while keeping the copied passage's literal brackets (#343). */
export function remapMarkerPieces(text: string, original: MarkerSource[], recipient: MarkerSource[]): MarkerPiece[] {
  const remapped: MarkerPiece[] = [];
  for (const piece of markerPieces(text, original.length)) {
    if (!piece.ref) {
      remapped.push(piece);
      continue;
    }
    const source = original[piece.ref - 1];
    const index = recipient.findIndex((candidate) => candidate.docId === source.docId && candidate.loc === source.loc);
    if (index >= 0) {
      remapped.push({ text: `[${index + 1}]`, ref: index + 1 });
      continue;
    }
    // The space before an unavailable citation goes with it.
    const before = remapped.at(-1);
    if (before && !before.ref) before.text = before.text.replace(/[ \t]+$/, '');
  }
  return remapped;
}

/** Typed text to stored paragraphs: one per line, blank lines dropped. */
export const toParagraphs = (text: string): string[] => text.split(/\r?\n+/).map((x) => x.trim()).filter(Boolean);

/** `sourceCount` is how many sources the text can refer to; with none, the text has no markers. */
export function splitCited(text: string, sourceCount: number): CitedPart[] {
  const out: CitedPart[] = [];
  const push = (t: string, refs: number[] = []) => { if (!t) return; const prev = out[out.length - 1]; if (prev && !prev.refs.length && !refs.length) prev.text += t; else out.push({ text: t, refs }); };
  if (!(sourceCount > 0)) { push(text); return out; }
  let run = ''; let pending: { before: string; cited: string; refs: number[] } | null = null;
  const settle = () => { if (!pending) return; push(pending.before); if (pending.cited) push(pending.cited, pending.refs); pending = null; };
  for (const piece of text.split(/(\s*\[\d+\])/)) {
    if (!piece) continue;
    const m = /^\s*\[(\d+)\]$/.exec(piece); const n = m ? +m[1] : 0;
    if (m && n >= 1 && n <= sourceCount) {
      if (!pending) { const [before, cited] = lastSentence(run); pending = { before, cited, refs: [] }; run = ''; }
      if (!pending.refs.includes(n)) pending.refs.push(n);
    } else { settle(); run += piece; }
  }
  settle(); push(run);
  return out;
}
