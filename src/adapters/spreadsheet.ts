/**
 * Spreadsheets in the browser stand-in, which has no LibreOffice: it reads and writes CSV only. The app itself reads and
 * writes every spreadsheet through LibreOffice (backend/spreadsheets).
 */
import { readCsv } from '../domain/sheets';
import type { SpreadsheetCodec } from '../ports';
import { ok, fail } from '../domain/result';

const quote = (v: string | number) => { const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export const csvCodec: SpreadsheetCodec = {
  async read(bytes, name, opts) {
    if (!/\.csv$/i.test(name)) return fail({ kind: 'invalid', message: 'The stand-in reads .csv files only; the app reads every spreadsheet through LibreOffice' });
    return readCsv(bytes, opts);
  },
  // with a byte-order mark, so Excel opens it as UTF-8
  async write(_sheet, rows) { return ok({ bytes: new TextEncoder().encode('﻿' + rows.map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n'), ext: 'csv' as const }); },
};
