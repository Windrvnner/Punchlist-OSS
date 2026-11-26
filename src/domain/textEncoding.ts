/** Which encoding a text file is in, and its text: shared by every reader of CSV and plain text files. */
type Encoding =
  | 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16le-bom' | 'utf-16be' | 'utf-16be-bom'
  | 'windows-1252' | 'windows-1252-bom';

/** the files read as a spreadsheet program reads a text file: a CSV and plain text */
export const TEXT_FILE = /\.(csv|txt|text|md)$/i;

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** the encoding a byte-order mark names; a UTF-8 mark in front of Windows-1252 text is how some tools write it */
function markedEncoding(bytes: Uint8Array): Encoding | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return isUtf8(bytes.subarray(3)) ? 'utf-8-bom' : 'windows-1252-bom';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le-bom';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be-bom';
  return null;
}

/** UTF-16 without a mark, recognized by its zero bytes: every other byte of ASCII text is zero */
function unmarkedUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length, 4096);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2) oddZero++;
    else evenZero++;
  }
  if (n < 4) return null;
  if (oddZero > n / 8 && evenZero < n / 64) return 'utf-16le';
  if (evenZero > n / 8 && oddZero < n / 64) return 'utf-16be';
  return null;
}

/**
 * CSV files carry no reliable label for their encoding. Read, in order: a byte-order mark (UTF-8, UTF-16 either way);
 * UTF-16 without a mark; valid UTF-8; and otherwise Windows-1252, which is what Excel on Windows writes for "CSV" and
 * in which every byte is a character. Text is never silently decoded as the wrong thing.
 */
export function encodingOf(bytes: Uint8Array): Encoding {
  return markedEncoding(bytes) ?? unmarkedUtf16(bytes) ?? (isUtf8(bytes) ? 'utf-8' : 'windows-1252');
}

export function decodeText(bytes: Uint8Array): string {
  const encoding = encodingOf(bytes);
  const markLength = !encoding.endsWith('-bom') ? 0 : encoding.startsWith('utf-16') ? 2 : 3;
  return new TextDecoder(encoding.replace('-bom', '')).decode(bytes.subarray(markLength));
}

/** a text file's bytes as UTF-8: unchanged when they are UTF-8 already, otherwise decoded as decodeText reads them */
export function utf8Bytes(bytes: Uint8Array): Uint8Array {
  const encoding = encodingOf(bytes);
  if (encoding === 'utf-8' || encoding === 'utf-8-bom') return bytes;
  return new TextEncoder().encode(decodeText(bytes));
}
