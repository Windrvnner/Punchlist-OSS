/**
 * References a question names after a word such as class or clause: "class b", "clause 4.2a", "clause IV. II".
 * Spacing around the points between a reference's parts never changes which reference it is (#778).
 *
 * A part is a number, a numeral, or a single letter. A lone a, i or l is also an ordinary word (an article, the
 * pronoun I, a misread I), so after a point it may begin the next sentence ("each item. I understand"). Such a part is
 * left open: the reference names it only if the other wording names it too, and never as a reason to match.
 */

// Canonical numerals keep prose such as "civil" outside identifier matching.
export const ROMAN_NUMERAL = /^(?=.)m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;

/** words a letter or numeral after them names: Class a, Tranche ii, part e */
export const NAMING_WORDS = new Set(('annex appendix article block class clause exhibit facility item limb lot '
  + 'paragraph part phase rule schedule section series tier tranche unit').split(' '));

const NOT_WORD = String.raw`(?![\p{L}\p{M}\p{N}|])`;
const NAMING_WORD = new RegExp(
  String.raw`(?<![\p{L}\p{M}\p{N}|])(?:${[...NAMING_WORDS].join('|')})${NOT_WORD}`, 'giu');
const SEPARATOR = /\s*\.\s*|[\s:-]+/uy;
const POINT = /\s*\.\s*/uy;
const PART = new RegExp(String.raw`(\p{N}+\p{L}?|\p{L}+)${NOT_WORD}`, 'uy');
const OPEN_LETTER = /^[aAiIl|]$/;
const NAMED_AT_END = /(\p{L}+)[\s\-:]+$/u;

/** A part is a number, a numeral, or one letter; any other word ends the reference. */
const isPart = (word: string) => /^\p{N}/u.test(word) || /^\p{L}$/u.test(word) || ROMAN_NUMERAL.test(word);

interface Reference {
  /** where the first part starts, after the naming word and its separator */
  start: number;
  end: number;
  parts: string[];
  /** the separator before the first part held a point ("class. b") */
  pointFirst: boolean;
  /** the last part is a lone letter after a point: it is spelled set apart, whatever was typed */
  spaced: boolean;
  /** where the last part starts */
  lastAt: number;
}

function readReference(text: string, nameEnd: number): Reference | null {
  SEPARATOR.lastIndex = nameEnd;
  const separator = SEPARATOR.exec(text);
  if (!separator) return null;
  const parts: string[] = [];
  const start = SEPARATOR.lastIndex;
  let position = start;
  let end = start;
  let afterPoint = separator[0].includes('.');
  let spaced = false;
  let lastAt = start;
  for (;;) {
    PART.lastIndex = position;
    const part = PART.exec(text);
    if (!part || !isPart(part[1])) break;
    parts.push(part[1]);
    lastAt = position;
    end = PART.lastIndex;
    spaced = afterPoint && OPEN_LETTER.test(part[1]);
    POINT.lastIndex = end;
    if (!POINT.exec(text)) break;
    position = POINT.lastIndex;
    afterPoint = true;
  }
  return parts.length ? { start, end, parts, pointFirst: separator[0].includes('.'), spaced, lastAt } : null;
}

/** the reference as one spelling: parts joined by a point, an open last part set apart, "class. b" as "class b" */
function spelled(ref: Reference): string {
  const last = ref.spaced ? ref.parts.length - 1 : ref.parts.length;
  const joined = ref.parts.slice(0, last).join('.');
  if (!ref.spaced) return joined;
  return joined ? `${joined}. ${ref.parts[last]}` : `. ${ref.parts[last]}`;
}

function* references(text: string): Generator<{ nameEnd: number; ref: Reference }> {
  for (const name of text.matchAll(NAMING_WORD)) {
    const nameEnd = name.index + name[0].length;
    const ref = readReference(text, nameEnd);
    if (ref) yield { nameEnd, ref };
  }
}

/** the text with every reference's parts in one spelling, whatever space or points were typed around them */
export function normalizeReferences(text: string): string {
  let result = '';
  let done = 0;
  for (const { nameEnd, ref } of references(text)) {
    const separator = text.slice(nameEnd, ref.start);
    const kept = ref.pointFirst ? (ref.spaced && ref.parts.length === 1 ? '' : ' ') : separator;
    result += text.slice(done, nameEnd) + kept + spelled(ref);
    done = ref.end;
  }
  return result + text.slice(done);
}

/**
 * Each lone letter set apart after a point ("class. I", "clause 4. a"), by its offset in normalized text, with the
 * identifier it completes. Alone after the naming word it may be a word ("each item. I understand"): `droppable`.
 * After other parts it names a clause, so it is an ordinary identifier.
 */
export function setApartParts(text: string): Map<number, { id: string; droppable: boolean }> {
  const found = new Map<number, { id: string; droppable: boolean }>();
  for (const { ref } of references(text)) {
    if (ref.spaced) found.set(ref.lastAt, { id: ref.parts.join('.').toLowerCase(), droppable: ref.parts.length === 1 });
  }
  return found;
}

/** whether a token such as "4.b" or "IV.II" is a dotted reference with a letter in it, right after its naming word */
export function isNamedChain(token: string, offset: number, text: string): boolean {
  const parts = token.split('.');
  if (parts.length < 2 || !parts.every(isPart) || parts.every((part) => /^\p{N}+$/u.test(part))) return false;
  const name = NAMED_AT_END.exec(text.slice(Math.max(0, offset - 30), offset))?.[1];
  return !!name && NAMING_WORDS.has(name.toLowerCase());
}
