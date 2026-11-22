/**
 * Spreadsheets through LibreOffice, shipped in the app: any spreadsheet in (.xlsx, .xlsm, .xls, .xlsb, .ods, .csv),
 * .xlsx out, and the deal memo out as Word and PDF. The app has no spreadsheet library of its own.
 */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pdfLines, type Converter } from './convert';
import type { SpreadsheetCodec } from '../ports';
import { ok, fail } from '../domain/result';
import { exportDocument, tableFrom } from '../domain/sheets';
import { isWorkbook, readCsv, decodeText, encodeLike } from '../adapters/spreadsheet';
import type { SheetEdit } from '../domain/sheets';
import { editCsv } from '../domain/csvEdit';
import { editXlsx } from './xlsxEdit';

export function libreOfficeSheets(convert: Converter): SpreadsheetCodec {
  return {
    async read(bytes, name, opts) {
      if (/\.csv$/i.test(name)) return readCsv(bytes, opts);
      if (!isWorkbook(bytes) || !convert.sheets) return fail({ kind: 'invalid', message: 'That file could not be read as a spreadsheet' });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-import-'));
      try {
        const file = path.join(dir, `import${path.extname(name).toLowerCase() || '.xlsx'}`); fs.writeFileSync(file, bytes);
        const t = tableFrom(await convert.sheets(file), opts);                     // plain values: dates month first, the way the import reads them
        return t ? ok(t) : fail({ kind: 'invalid', message: 'The file has no rows' });
      } catch { return fail({ kind: 'invalid', message: 'That file could not be read as a spreadsheet' }); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    async write(sheetName, rows) {
      if (!convert.workbook) return fail({ kind: 'failed', message: 'Couldn’t build the workbook' });
      try { return ok({ bytes: await convert.workbook(exportDocument(sheetName, rows)), ext: 'xlsx' }); } catch { return fail({ kind: 'failed', message: 'Couldn’t build the workbook' }); }
    },
    // a document's text, for a list brought in from one: a PDF through PDF.js, anything else through LibreOffice
    async text(bytes, name) {
      if (/\.pdf$/i.test(name)) { try { return ok(await pdfLines(bytes)); } catch { return fail({ kind: 'invalid', message: 'That PDF could not be read' }); } }
      // LibreOffice would read any bytes as plain text, so a file that is not what its name says is refused first
      const zip = bytes[0] === 0x50 && bytes[1] === 0x4b; const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf; const rtf = new TextDecoder().decode(bytes.slice(0, 5)) === '{\\rtf';
      const fits = /\.(docx|docm|odt)$/i.test(name) ? zip : /\.doc$/i.test(name) ? ole || rtf : /\.rtf$/i.test(name) ? rtf : false;
      if (!convert.text || !fits) return fail({ kind: 'invalid', message: 'That file could not be read' });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-list-'));
      try { const file = path.join(dir, `list${path.extname(name).toLowerCase()}`); fs.writeFileSync(file, bytes); return ok(await convert.text(file)); }
      catch { return fail({ kind: 'invalid', message: 'That file could not be read' }); }
      finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    ...(convert.document ? { async document(fodt: string) {
      try { return ok(await convert.document!(fodt)); } catch { return fail({ kind: 'failed', message: 'Couldn’t make the deal memo' }); }
    } } : {}),
  };
}

/**
 * A Q&A log with `steps` made in it, as bytes of the same kind of file. An .xlsx or .xlsm is edited directly, so
 * every part but the cells written stays byte for byte; a CSV keeps its lines, quoting and encoding; anything else
 * (.xls, .ods) goes through LibreOffice, which saves the whole workbook again. The file given is never written to.
 */
export async function editLog(convert: Converter, file: string, sheet: string, steps: SheetEdit[]): Promise<Uint8Array> {
  const ext = path.extname(file).toLowerCase(); const bytes = new Uint8Array(fs.readFileSync(file));
  if (ext === '.csv') return encodeLike(editCsv(decodeText(bytes), steps), bytes);
  if ((ext === '.xlsx' || ext === '.xlsm') && bytes[0] === 0x50 && bytes[1] === 0x4b) return editXlsx(bytes, sheet, steps);
  if (!convert.edit) throw new Error('This kind of spreadsheet can’t be written to here');
  return convert.edit(file, sheet, steps);
}
