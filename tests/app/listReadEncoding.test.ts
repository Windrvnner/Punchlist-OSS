// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readListFile } from '../../src/app/listRead';

const utf16 = (text: string, bigEndian = false) => Uint8Array.from(
  [...text].flatMap((c) => {
    const unit = c.charCodeAt(0);
    return bigEndian ? [unit >> 8, unit & 255] : [unit & 255, unit >> 8];
  }),
);
const marked = (bytes: Uint8Array, mark: number[]) => Uint8Array.from([...mark, ...bytes]);
const file = (name: string, bytes: Uint8Array) => (
  { name, size: bytes.length, arrayBuffer: async () => bytes.buffer as ArrayBuffer }
);
const linesOf = async (name: string, bytes: Uint8Array) => {
  const read = await readListFile({} as never, file(name, bytes));
  return read.ok && 'lines' in read.value && read.value.lines;
};

describe('a plain-text list in any encoding a text editor or Excel saves (#382)', () => {
  const list = '1. Credit agreement\r\n2. Café lease';
  const lines = ['1. Credit agreement', '2. Café lease'];
  it('reads UTF-16 with a byte-order mark, either way round, and without one', async () => {
    expect(await linesOf('Checklist.txt', marked(utf16(list), [0xff, 0xfe]))).toEqual(lines);
    expect(await linesOf('Checklist.txt', marked(utf16(list, true), [0xfe, 0xff]))).toEqual(lines);
    expect(await linesOf('Checklist.md', utf16(list))).toEqual(lines);
  });
  it('reads UTF-8, with or without a mark, and Windows-1252 with its accents', async () => {
    const utf8 = new TextEncoder().encode(list);
    expect(await linesOf('Checklist.txt', utf8)).toEqual(lines);
    expect(await linesOf('Checklist.txt', marked(utf8, [0xef, 0xbb, 0xbf]))).toEqual(lines);
    expect(await linesOf('Checklist.text', Uint8Array.from([0x43, 0x61, 0x66, 0xe9]))).toEqual(['Café']);
  });
});
