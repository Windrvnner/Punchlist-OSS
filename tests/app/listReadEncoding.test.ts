// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readListFile } from '../../src/app/listRead';
import { storable } from '../../src/backend/claude';

const markedUtf16 = (text: string) => Uint8Array.from(
  [0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])],
);
const unmarkedUtf16 = (text: string) => markedUtf16(text).subarray(2);
const file = (name: string, bytes: Uint8Array) => (
  { name, size: bytes.length, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
);
const sent = async (name: string, bytes: Uint8Array) => {
  const stored = await storable({ name, bytes });
  return new TextDecoder().decode(stored.bytes);
};

describe('a text list in any encoding a text editor or Excel saves', () => {
  it('reads a UTF-16 text list line by line, not as garbage', async () => {
    const bytes = markedUtf16('1. Credit agreement\r\n2. Fee letter');
    const read = await readListFile({} as never, file('Checklist.txt', bytes));
    const lines = read.ok && 'lines' in read.value && read.value.lines;
    expect(lines).toEqual(['1. Credit agreement', '2. Fee letter']);
  });
  it('reads a Windows-1252 text list with its accents', async () => {
    const read = await readListFile({} as never, file('Checklist.txt', Uint8Array.from([0x43, 0x61, 0x66, 0xe9])));
    expect(read.ok && 'lines' in read.value && read.value.lines).toEqual(['Café']);
  });
});

describe('a CSV sent to the model service', () => {
  it('is sent as UTF-8 when Excel saved it as Windows-1252, and untouched when it is UTF-8', async () => {
    const win = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x80]);   // Café,€
    expect(await sent('Rates.csv', win)).toBe('Café,€');
    const utf8 = new TextEncoder().encode('Café,€');
    expect((await storable({ name: 'Rates.csv', bytes: utf8 })).bytes).toBe(utf8);
  });
  it('is sent as UTF-8 when it is UTF-16, with a byte-order mark or without one', async () => {
    expect(await sent('Rates.csv', markedUtf16('Rate,Value\r\nA,1'))).toBe('Rate,Value\r\nA,1');
    expect(await sent('Rates.csv', unmarkedUtf16('Rate,Value\r\nA,1'))).toBe('Rate,Value\r\nA,1');
  });
  it('still refuses a binary file that is not text', async () => {
    const binary = Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x80]);
    await expect(storable({ name: 'Model.bin', bytes: binary })).rejects.toThrow(/only PDFs, text and spreadsheets/);
  });
});
