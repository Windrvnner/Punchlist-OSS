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
const MAX_STEPS = 2_000_000;

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
function plainReads(char: string): string[] {
  const reads = new Set([char, flattened(char), flattened(char.normalize('NFKC'))]);
  if (isInvisible(char)) reads.add('');
  if (/\s/.test(char)) reads.add(' ');
  return [...reads];
}

/** What each UTF-8 byte of a character outside ASCII may be read as. */
function byteReads(char: string): string[][] {
  return [...new TextEncoder().encode(char)].map((byte) => [
    CP1252.decode(Uint8Array.of(byte)),
    String.fromCharCode(byte),
    '�',
    '?',
  ]);
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

/** The end of the run of lost marks that starts at `at`: the first position that is not one. */
function runEnd(incoming: string, at: number): number {
  let end = at;
  while (LOST.test(incoming[end] ?? '')) end++;
  return end;
}

/** Inclusive ranges of incoming positions, merged so a long run costs one entry instead of one per mark. */
class Ranges {
  private ranges: [number, number][] = [];
  add(low: number, high: number) {
    this.ranges.push([low, high]);
    this.ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of this.ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    this.ranges = merged;
  }
  addAll(other: Ranges) { for (const [low, high] of other.ranges) this.add(low, high); }
  /** The end of each range: the first position after its marks, where an ordinary character may follow. */
  ends(): number[] { return this.ranges.map(([, high]) => high); }
  /** Every position in the ranges, for a literal "?" that may sit among the marks. */
  positions(): number[] {
    return this.ranges.flatMap(([low, high]) => Array.from({ length: high - low + 1 }, (_, offset) => low + offset));
  }
  contains(position: number): boolean { return this.ranges.some(([low, high]) => low <= position && position <= high); }
}

/**
 * Whether the saved text can come back as the incoming text through the channel above. `plain[i]` holds the incoming
 * positions reached after reading chars[0..i) one by one; `lost[i]` those inside a run of marks that began at a
 * character outside ASCII. A run takes one or more characters and one or more marks, in either proportion.
 */
function channelProduces(saved: string, incoming: string): boolean {
  const chars = Array.from(saved);
  const plain = Array.from({ length: chars.length + 1 }, () => new Set<number>());
  const lost = Array.from({ length: chars.length + 1 }, () => new Ranges());
  plain[0].add(0);
  let steps = 0;
  for (const [index, char] of chars.entries()) {
    // Inside a run of marks every mark is lost, so only its end (or a literal "?") can start an ordinary character.
    const starts = new Set([...plain[index], ...lost[index].ends()]);
    if (char === '?') for (const at of lost[index].positions()) starts.add(at);
    for (const at of starts) {
      if (++steps > MAX_STEPS) return false;
      readCharacter(char, incoming, at, plain[index + 1], lost[index + 1]);
    }
    if (!isAscii(char)) lost[index + 1].addAll(lost[index]);
  }
  const last = chars.length;
  return plain[last].has(incoming.length) || lost[last].contains(incoming.length);
}

/** Every way `char` may be read at incoming position `at`: into the next plain positions or the next run of marks. */
function readCharacter(char: string, incoming: string, at: number, plain: Set<number>, lost: Ranges) {
  for (const read of plainReads(char)) if (incoming.startsWith(read, at)) plain.add(at + read.length);
  if (isAscii(char)) return;
  if (LOST.test(incoming[at] ?? '')) lost.add(at + 1, runEnd(incoming, at));
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
