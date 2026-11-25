/**
 * Spreadsheets in the browser stand-in, which has no LibreOffice: it reads and writes CSV only. The app itself reads and
 * writes every spreadsheet through LibreOffice (backend/spreadsheets).
 */
import { parseCsv, tableFrom } from '../domain/sheets';
import type { SpreadsheetCodec } from '../ports';
import { ok, fail } from '../domain/result';

/**
 * A CSV's text as Excel reads it when the file is opened by double-click: a UTF-8 byte-order mark means UTF-8, a UTF-16
 * mark means UTF-16 (either order), and a file with no mark is in the PC's Windows code page (Windows-1252). The app never
 * guesses past that: UTF-8 text with no mark shows as Excel shows it, so a person sees the same characters in both.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('windows-1252').decode(bytes);
}

/**
 * The character Excel splits a CSV's fields at when it opens the file by double-click: the system's list separator,
 * which Windows sets to a semicolon where a region writes decimals with a comma, and to a comma elsewhere.
 */
export function regionListSeparator(): string {
  const decimal = new Intl.NumberFormat().formatToParts(1.1).find((part) => part.type === 'decimal')?.value;
  return decimal === ',' ? ';' : ',';
}

/**
 * A CSV file's cells as Excel shows them: its text as `decodeText` reads it, split at the delimiter. A first line
 * "sep=;" names the delimiter, as Excel takes it, and is not a row; without one the delimiter is the region's.
 */
export function csvGrid(bytes: Uint8Array, listSeparator: string = regionListSeparator()): string[][] {
  const text = decodeText(bytes);
  const named = /^sep=(.)\r?\n/.exec(text);
  return named ? parseCsv(text.slice(named[0].length), undefined, named[1]) : parseCsv(text, undefined, listSeparator);
}

/** a workbook is a ZIP (.xlsx, .xlsm, .xlsb, .ods) or an OLE container (.xls), whatever it is called */
export const isWorkbook = (b: Uint8Array) => (b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0);

/** A .csv read as text: raw strings, no number or date guessing. One sheet. */
export function readCsv(bytes: Uint8Array, opts?: { sheet?: string; headerRow?: number }) {
  if (isWorkbook(bytes)) return fail({ kind: 'invalid' as const, message: 'That file is a workbook saved with a .csv name. Rename it to .xlsx and try again' });
  const t = tableFrom([{ name: 'Sheet1', grid: csvGrid(bytes) }], opts);
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
