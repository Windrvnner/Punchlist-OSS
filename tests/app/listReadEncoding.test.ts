// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { LIST_ACCEPT, readListFile } from '../../src/app/listRead';

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
  it('reads UTF-16 with a byte-order mark, either way round', async () => {
    expect(await linesOf('Checklist.txt', marked(utf16(list), [0xff, 0xfe]))).toEqual(lines);
    expect(await linesOf('Checklist.txt', marked(utf16(list, true), [0xfe, 0xff]))).toEqual(lines);
  });
  it('reads UTF-8, with or without a mark, and Windows-1252 with its accents', async () => {
    const utf8 = new TextEncoder().encode(list);
    expect(await linesOf('Checklist.txt', utf8)).toEqual(lines);
    expect(await linesOf('Checklist.txt', marked(utf8, [0xef, 0xbb, 0xbf]))).toEqual(lines);
    expect(await linesOf('Checklist.text', Uint8Array.from([0x43, 0x61, 0x66, 0xe9]))).toEqual(['Café']);
  });
  it('does not guess UTF-16 without a mark: its bytes are read as UTF-8', async () => {
    expect(await linesOf('Checklist.md', utf16('Cafe'))).toEqual(['C\0a\0f\0e\0']);
  });
  it('refuses bytes that are not UTF-8 after a UTF-8 mark, and says so', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x43, 0xe9]);
    const read = await readListFile({} as never, file('Checklist.txt', bytes));
    const message = read.ok ? '' : read.error.message;
    expect(message).toBe('The file starts with a UTF-8 byte-order mark but is not valid UTF-8');
  });
});

describe('checklist source formats', () => {
  it.each(['xlsx', 'XLSM', 'xlsb', 'xls', 'csv', 'ods'])('refuses a .%s before reading it', async (extension) => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const source = { name: `Checklist.${extension}`, arrayBuffer };
    const read = vi.fn(async () => ({ ok: true as const, value: { columns: ['Item'], rows: [['Review the lease']] } }));
    const result = await readListFile({ services: { sheets: { read } } } as never, source);
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(LIST_ACCEPT.split(',')).not.toContain(`.${extension.toLowerCase()}`);
  });

  it.each(['docx', 'odt'])('passes a .%s checklist to the document text reader', async (extension) => {
    const bytes = Uint8Array.of(1, 2);
    const name = `Checklist.${extension}`;
    const text = vi.fn(async () => ({ ok: true as const, value: 'Site control\nReview the signed lease' }));
    const result = await readListFile({ services: { sheets: { text } } } as never, file(name, bytes));
    expect(text).toHaveBeenCalledWith(bytes, name);
    expect(result).toEqual({ ok: true, value: { lines: ['Site control', 'Review the signed lease'] } });
    expect(LIST_ACCEPT.split(',')).toContain(`.${extension}`);
  });
});
