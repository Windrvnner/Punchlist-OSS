/** Which encoding a text file is in, and its text: shared by every reader of CSV and plain text files. */
type Encoding = 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom' | 'utf-16le' | 'utf-16be' | 'utf-8' | 'windows-1252' | 'windows-1252-bom';
/**
 * CSV files carry no reliable label for their encoding. Read, in order: a byte-order mark (UTF-8, UTF-16 either way);
 * UTF-16 without a mark, recognized by its zero bytes; valid UTF-8; and otherwise Windows-1252, which is what Excel on
 * Windows writes for "CSV" and in which every byte is a character. Text is never silently decoded as the wrong thing.
 */
export function encodingOf(bytes: Uint8Array): Encoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {   // a UTF-8 mark in front of Windows-1252 text, as some tools write it
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3)); return 'utf-8-bom'; } catch { return 'windows-1252-bom'; }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le-bom';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be-bom';
  const n = Math.min(bytes.length, 4096); let evenZero = 0, oddZero = 0;
  for (let i = 0; i < n; i++) if (bytes[i] === 0) { if (i % 2) oddZero++; else evenZero++; }
  if (n >= 4 && oddZero > n / 8 && evenZero < n / 64) return 'utf-16le';
  if (n >= 4 && evenZero > n / 8 && oddZero < n / 64) return 'utf-16be';
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return 'utf-8'; } catch { return 'windows-1252'; }
}
export function decodeText(bytes: Uint8Array): string {
  const e = encodingOf(bytes); const bom = e.endsWith('-bom') ? (e.startsWith('utf-16') ? 2 : 3) : 0;
  return new TextDecoder(e.replace('-bom', '')).decode(bytes.subarray(bom));
}
