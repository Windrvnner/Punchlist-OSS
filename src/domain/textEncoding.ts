/** Which encoding a text file is in, and its text: shared by the readers of CSV files and plain-text lists. */
type Encoding = 'utf-8' | 'utf-8-bom' | 'utf-16le-bom' | 'utf-16be-bom' | 'windows-1252';

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decided by the byte-order mark: UTF-8, or UTF-16 either way. With no mark, the bytes are UTF-8 when they are valid
 * UTF-8, and otherwise Windows-1252, which is what Excel on Windows writes for "CSV" and in which every byte is a
 * character. Nothing else decides it (#382).
 */
export function encodingOf(bytes: Uint8Array): Encoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-bom';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le-bom';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be-bom';
  return isUtf8(bytes) ? 'utf-8' : 'windows-1252';
}

/** what is said of a file whose bytes are not valid in the encoding its byte-order mark names */
export function invalidTextMessage(label: string): string {
  const name = label.toUpperCase();
  return `The file starts with a ${name} byte-order mark but is not valid ${name}`;
}

/** the file's text, without its byte-order mark; throws when the bytes are not valid in the encoding the mark names */
export function decodeText(bytes: Uint8Array): string {
  const encoding = encodingOf(bytes);
  const markLength = !encoding.endsWith('-bom') ? 0 : encoding.startsWith('utf-16') ? 2 : 3;
  const label = encoding.replace('-bom', '');
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes.subarray(markLength));
  } catch {
    throw new Error(invalidTextMessage(label));
  }
}
