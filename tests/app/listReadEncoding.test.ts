// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readListFile } from '../../src/app/listRead';
import { storable } from '../../src/backend/claude';

const utf16le = (text: string) => Uint8Array.from([0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8])]);
const file = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, arrayBuffer: async () => bytes.buffer as ArrayBuffer });

describe('a text list in any encoding a text editor or Excel saves', () => {
  it('reads a UTF-16 text list line by line, not as garbage', async () => {
    const read = await readListFile({} as never, file('Checklist.txt', utf16le('1. Credit agreement\r\n2. Fee letter')));
    expect(read.ok && 'lines' in read.value && read.value.lines).toEqual(['1. Credit agreement', '2. Fee letter']);
  });
  it('reads a Windows-1252 text list with its accents', async () => {
    const read = await readListFile({} as never, file('Checklist.txt', Uint8Array.from([0x43, 0x61, 0x66, 0xe9])));
    expect(read.ok && 'lines' in read.value && read.value.lines).toEqual(['Café']);
  });
});

describe('a CSV sent to the model service', () => {
  it('is sent as UTF-8 when Excel saved it as Windows-1252, and untouched when it is UTF-8', async () => {
    const win = Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0x2c, 0x80]);   // Café,€
    expect(new TextDecoder().decode((await storable({ name: 'Rates.csv', bytes: win })).bytes)).toBe('Café,€');
    const utf8 = new TextEncoder().encode('Café,€');
    expect((await storable({ name: 'Rates.csv', bytes: utf8 })).bytes).toBe(utf8);
  });
  it('still refuses a binary file that is not text', async () => {
    await expect(storable({ name: 'Model.bin', bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x80]) })).rejects.toThrow(/only PDFs, text and spreadsheets/);
  });
});
