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

/** The page a citation's place names ("p. 12 · cl. 4" is page 12), or null when it names none ("Ops!F12"). */
export function pageOf(loc: string): number | null {
  const match = /p\.\s*(\d+)/.exec(loc);
  return match ? +match[1] : null;
}

/** A whole answer or finding can cite its sources when none of its sentences cites a particular source. */
export function restsOnAllSources(texts: string[], sourceCount: number, ownWords = false) {
  return sourceCount > 0 && !ownWords
    && !texts.some((text) => splitCited(text, sourceCount).some((part) => part.refs.length));
}
