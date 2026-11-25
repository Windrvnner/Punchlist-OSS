/**
 * Decides whether an incoming Merge cell is the saved cell as a lossy file channel would hand it back (#256).
 *
 * The channel is applied to the saved text one character at a time, in one direction only:
 * - any character may come back as itself or with its quote or dash shape flattened (or its compatibility form);
 * - a run of characters outside ASCII may come back as a run of "?" or "�" of any length (an emoji may vanish);
 * - a character outside ASCII may come back as its UTF-8 bytes read as Windows-1252 or Latin-1, each byte on its
 *   own possibly unreadable.
 * Spacing is compared as a spreadsheet stores it: runs of ASCII whitespace are one space. Other spaces are glyphs.
 *
 * The incoming cell is damage when the saved text can produce it exactly, found by an exhaustive alignment rather
 * than by rules for each kind of damage, so mixed damage in one cell needs no case of its own. The channel never
 * invents characters, so a clean file offered over an already damaged value does not match and still corrects it.
 */

const LOST = /[?�]/;
const CP1252 = new TextDecoder('windows-1252');
/** Safety valve for pathological cells: past this many alignment steps the cell is treated as an edit, which is
 *  listed in the preview and can be undone, rather than silently kept. */
const MAX_STEPS = 20_000_000;

/** Quote and dash shapes a file may flatten (the same shapes the log update treats as one character). */
function flattened(text: string): string {
  return text.replace(/[‘’‚‛′´`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-');
}

/** Runs of ASCII whitespace are one space, and the ends are trimmed. */
function sheetSpacing(text: string): string {
  return text.replace(/[ \t\r\n\f\v]+/g, ' ').replace(/^ | $/g, '');
}

/** The same text with every whitespace run (Unicode spaces too) as one space. */
function anySpacing(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const isAscii = (char: string) => char.charCodeAt(0) < 0x80;
const isInvisible = (char: string) => /^(?:\p{Extended_Pictographic}|‍|︎|️)$/u.test(char);

/** What one saved character may come back as, apart from lost runs and byte misreadings. */
const plainCache = new Map<string, string[]>();
function plainReads(char: string): string[] {
  const cached = plainCache.get(char);
  if (cached) return cached;
  const reads = new Set([char, flattened(char), flattened(char.normalize('NFKC'))]);
  if (isInvisible(char)) reads.add('');
  if (/\s/.test(char)) reads.add(' ');
  const result = [...reads];
  plainCache.set(char, result);
  return result;
}

/** What each UTF-8 byte of a character outside ASCII may be read as. */
const byteCache = new Map<string, string[][]>();
function byteReads(char: string): string[][] {
  const cached = byteCache.get(char);
  if (cached) return cached;
  const reads = [...new TextEncoder().encode(char)].map((byte) => [
    CP1252.decode(Uint8Array.of(byte)),
    String.fromCharCode(byte),
    '�',
    '?',
  ]);
  byteCache.set(char, reads);
  return reads;
}

/** Ends in the incoming text of reading `char` as its misread bytes, from each start. */
function misreadEnds(char: string, incoming: string, starts: Iterable<number>): Set<number> {
  let positions = new Set(starts);
  for (const alternatives of byteReads(char)) {
    const next = new Set<number>();
    for (const at of positions) if (at < incoming.length && alternatives.includes(incoming[at])) next.add(at + 1);
    positions = next;
  }
  return positions;
}

/** For each incoming position, the end of the run of lost marks starting there: the first position that is not one. */
function runEnds(incoming: string): number[] {
  const ends: number[] = new Array(incoming.length + 1);
  ends[incoming.length] = incoming.length;
  for (let at = incoming.length - 1; at >= 0; at--) ends[at] = LOST.test(incoming[at]) ? ends[at + 1] : at;
  return ends;
}

/** Inclusive ranges of incoming positions, merged so a long run costs one entry instead of one per mark. */
class Ranges {
  private ranges: [number, number][] = [];
  private merged = true;
  add(low: number, high: number) {
    const last = this.ranges[this.ranges.length - 1];
    if (last && last[0] <= low && high <= last[1]) return;
    this.ranges.push([low, high]);
    this.merged = false;
  }
  addAll(other: Ranges) { for (const [low, high] of other.all()) this.add(low, high); }
  /** The end of each range: the first position after its marks, where an ordinary character may follow. */
  ends(): number[] { return this.all().map(([, high]) => high); }
  /** The positions of the incoming text inside the ranges that hold a literal "?", which may sit among the marks. */
  questionMarks(incoming: string): number[] {
    const found: number[] = [];
    for (const [low, high] of this.all()) for (let at = low; at <= high; at++) if (incoming[at] === '?') found.push(at);
    return found;
  }
  contains(position: number): boolean { return this.all().some(([low, high]) => low <= position && position <= high); }
  /** Sorted and merged, done once per read rather than once per addition. */
  private all(): [number, number][] {
    if (this.merged) return this.ranges;
    const merged: [number, number][] = [];
    for (const range of this.ranges.sort((a, b) => a[0] - b[0])) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    this.ranges = merged;
    this.merged = true;
    return merged;
  }
}

/**
 * Whether the saved text can come back as the incoming text through the channel above. `plain[i]` holds the incoming
 * positions reached after reading chars[0..i) one by one; `lost[i]` those inside a run of marks that began at a
 * character outside ASCII. A run takes one or more characters and one or more marks, in either proportion.
 */
function channelProduces(saved: string, incoming: string): boolean {
  const chars = Array.from(saved);
  const ends = runEnds(incoming);
  const plain = Array.from({ length: chars.length + 1 }, () => new Set<number>());
  const lost = Array.from({ length: chars.length + 1 }, () => new Ranges());
  plain[0].add(0);
  let steps = 0;
  for (const [index, char] of chars.entries()) {
    for (const at of startsFor(char, incoming, ends, plain[index], lost[index])) {
      if (++steps > MAX_STEPS) return false;
      readCharacter(char, incoming, at, ends, plain[index + 1], lost[index + 1]);
    }
    if (!isAscii(char)) lost[index + 1].addAll(lost[index]);
  }
  const last = chars.length;
  return plain[last].has(incoming.length) || lost[last].contains(incoming.length);
}

/**
 * The incoming positions where `char` may be read, in order. Inside a run of marks every mark is lost, so only its end
 * (or a literal "?") can start an ordinary character. A character outside ASCII starting inside a run already
 * read by an earlier mark of it adds nothing new, so only the first mark of each run is kept.
 */
function startsFor(char: string, incoming: string, ends: number[], plain: Set<number>, lost: Ranges): number[] {
  const starts = new Set([...plain, ...lost.ends()]);
  if (char === '?') for (const at of lost.questionMarks(incoming)) starts.add(at);
  const ordered = [...starts].sort((a, b) => a - b);
  if (isAscii(char)) return ordered;
  let runEnd = -1;
  return ordered.filter((at) => {
    if (at < runEnd) return false;
    if (ends[at] > at) runEnd = ends[at];
    return true;
  });
}

/** Every way `char` may be read at incoming position `at`: into the next plain positions or the next run of marks. */
function readCharacter(char: string, incoming: string, at: number, ends: number[], plain: Set<number>, lost: Ranges) {
  if (!isAscii(char) && LOST.test(incoming[at] ?? '')) {
    // a mark here is the start of a run; reading the character any other way would be a run too
    lost.add(at + 1, ends[at]);
    return;
  }
  for (const read of plainReads(char)) if (incoming.startsWith(read, at)) plain.add(at + read.length);
  if (isAscii(char)) return;
  for (const end of misreadEnds(char, incoming, [at])) plain.add(end);
}

/** The text without glyphs a file may drop altogether, and the spaces that were around them. */
function withoutInvisible(text: string): string {
  return sheetSpacing(Array.from(text).filter((char) => !isInvisible(char)).join(''));
}

/** An incoming Merge cell that only differs from the saved one as a lossy file would: keep the saved text. */
export function damagedImportText(saved: string, incoming: string): boolean {
  // Spacing-only edits are not damage: they keep their existing handling.
  if (anySpacing(saved) === anySpacing(incoming)) return false;
  const read = sheetSpacing(incoming);
  const original = sheetSpacing(saved);
  return channelProduces(original, read) || channelProduces(withoutInvisible(original), read);
}
