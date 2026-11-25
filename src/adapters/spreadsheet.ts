/**
 * Spreadsheets in the browser stand-in, which has no LibreOffice: it reads and writes CSV only. The app itself reads and
 * writes every spreadsheet through LibreOffice (backend/spreadsheets).
 */
import { parseCsv, tableFrom } from '../domain/sheets';
import type { SpreadsheetCodec } from '../ports';
import { ok, fail } from '../domain/result';
import { decodeText, encodingOf } from '../domain/textEncoding';

export { decodeText };

/** the characters Windows-1252 puts at 0x80–0x9F; the rest of its range is the same as Unicode */
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
/** `text` in the encoding `like` is in, byte-order mark included; throws when a character has no place in it */
export function encodeLike(text: string, like: Uint8Array): Uint8Array {
  const utf16 = (be: boolean) => [...Array(text.length).keys()].flatMap((i) => { const c = text.charCodeAt(i); return be ? [c >> 8, c & 255] : [c & 255, c >> 8]; });
  switch (encodingOf(like)) {
    case 'utf-8-bom': return new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    case 'utf-8': return new TextEncoder().encode(text);
    case 'utf-16le-bom': return new Uint8Array([0xff, 0xfe, ...utf16(false)]);
    case 'utf-16be-bom': return new Uint8Array([0xfe, 0xff, ...utf16(true)]);
    case 'utf-16le': return new Uint8Array(utf16(false));
    case 'utf-16be': return new Uint8Array(utf16(true));
    case 'windows-1252-bom': return new Uint8Array([0xef, 0xbb, 0xbf, ...cp1252(text)]);
    default: return new Uint8Array(cp1252(text));
  }
}
/** `text` as Windows-1252 bytes */
function cp1252(text: string): number[] {
  return [...text].map((ch) => { const c = ch.codePointAt(0)!; const k = CP1252.indexOf(ch); if (k >= 0) return 0x80 + k; if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) return c; throw new Error(`“${ch}” can’t be written in this CSV log’s encoding (Windows-1252)`); });
}

/** a workbook is a ZIP (.xlsx, .xlsm, .xlsb, .ods) or an OLE container (.xls), whatever it is called */
export const isWorkbook = (b: Uint8Array) => (b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0);

/** A .csv read as text: raw strings, no number or date guessing. One sheet. */
export function readCsv(bytes: Uint8Array, opts?: { sheet?: string; headerRow?: number }) {
  if (isWorkbook(bytes)) return fail({ kind: 'invalid' as const, message: 'That file is a workbook saved with a .csv name. Rename it to .xlsx and try again' });
  const t = tableFrom([{ name: 'Sheet1', grid: parseCsv(decodeText(bytes)) }], opts);
  return t ? ok(t) : fail({ kind: 'invalid' as const, message: 'The file has no rows' });
}

const quote = (v: string | number) => { const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export const csvCodec: SpreadsheetCodec = {
  async read(bytes, name, opts) {
    if (!/\.csv$/i.test(name)) return fail({ kind: 'invalid', message: 'The stand-in reads .csv files only; the app reads every spreadsheet through LibreOffice' });
    return readCsv(bytes, opts);
  },
  // with a byte-order mark, so Excel opens it as UTF-8
  async write(_sheet, rows) { return ok({ bytes: new TextEncoder().encode('﻿' + rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n'), ext: 'csv' as const }); },
};
