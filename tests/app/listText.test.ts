// A text file's bytes as text, the way Notepad opens it.
import { describe, it, expect } from 'vitest';
import { decodeText } from '../../src/domain/decodeText';

const utf16 = (text: string, bom: [number, number], little: boolean) => {
  const out = [...bom];
  for (const unit of text.split('').map((c) => c.charCodeAt(0))) out.push(...(little ? [unit & 255, unit >> 8] : [unit >> 8, unit & 255]));
  return new Uint8Array(out);
};

describe('decoding a text list', () => {
  it('reads UTF-16 by its byte-order mark, either order', () => {
    expect(decodeText(utf16('1. Site\nLender’s consent', [0xff, 0xfe], true))).toBe('1. Site\nLender’s consent');
    expect(decodeText(utf16('1. Site\nLender’s consent', [0xfe, 0xff], false))).toBe('1. Site\nLender’s consent');
  });
  it('reads UTF-16 without a mark, and Windows-1252 text under a UTF-8 mark', () => {
    expect(decodeText(new Uint8Array([0x41, 0, 0x42, 0, 0x43, 0, 0x44, 0]))).toBe('ABCD');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
  });
  it('reads UTF-8, else Windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('Café – §4'))).toBe('Café – §4');
    expect(decodeText(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
  });
});
