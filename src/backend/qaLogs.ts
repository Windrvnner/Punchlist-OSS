/**
 * A deal's Q&A log as a file: the team's own file on their NAS or drive, which people edit with or
 * without the app; the app keeps no copy of its own. An update reads the log as it is now, writes the app's steps into it,
 * reads the result back to check that nothing else changed, and saves it over the log, the version it replaces first going
 * to the folder's archive (qaLogFolder).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Converter } from './convert';
import type { QaLogFiles, SpreadsheetCodec } from '../ports';
import { ok, fail, type Result } from '../domain/result';
import {
  parseCsv, writtenAsMeant, withSteps, tableFrom, type Sheet, type SheetEdit, type SheetReadOptions,
} from '../domain/sheets';
import { editLog, libreOfficeSheets } from './spreadsheets';
import { decodeText } from '../domain/textEncoding';
import { saveLog, createLog, sha256, restoreAside, keptEdits, settleKept, type KeptEdit } from './qaLogFolder';
import { fixedCells } from './xlsxEdit';
import { mergeKept, type KeptAsk, type KeptTable } from '../domain/keptMerge';
import { keptLogColumns, logLayoutChanged, resolveLogMapping, selectedUnnamedColumns } from '../domain/qaLogLayout';

const EXT = /^\.(xlsx|xlsm|xls|ods|csv)$/i;

/** a failure that may pass: a file held a moment (an error code), or LibreOffice taking too long, stopping, or saying nothing */
const brief = (e: unknown) => !!(e as NodeJS.ErrnoException).code || /timed? ?out|took too long|^exit -?\d+|nothing was reported/i.test((e as Error)?.message ?? '');

/** A shared archive or working file can change before its local copy is made (#278). */
function copyLogFile(source: string, target: string, hash?: string): string {
  fs.copyFileSync(source, target);
  if (hash && sha256(fs.readFileSync(target)) !== hash) throw new Error('The copied Q&A log bytes changed');
  return target;
}

function copyArchivedBase(base: NonNullable<KeptEdit['base']>, target: string): string {
  try {
    return copyLogFile(base.file, target, base.hash);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // A vanished base cannot be merged, but the kept edit can still be filed as it is (#278).
      throw new Error('The Q&A log archive disappeared', { cause: error });
    }
    throw error;
  }
}

type ReadOptions = Parameters<QaLogFiles['read']>[1];
type SheetTable = Extract<Awaited<ReturnType<SpreadsheetCodec['read']>>, { ok: true }>['value'];

function atLinkedTable(table: SheetTable, { sheet, headerRow }: ReadOptions) {
  return table.sheet === sheet && table.headerRow === headerRow;
}

function keptColumnsForRead(table: SheetTable, opts: ReadOptions): Result<ReadOptions['kept']> {
  if (!opts.layout) return ok(opts.kept);
  if (!atLinkedTable(table, opts)) return fail(logLayoutChanged());
  const mapping = resolveLogMapping(opts.layout, table);
  if (!mapping.ok) return mapping;
  return ok(opts.kept ? keptLogColumns(mapping.value) : undefined);
}

/** Formula cells are neither overwritten nor taken for edits. A CSV contains values only. */
function workbookFormulas(converter: Converter, extension: string, sheet: string) {
  if (/\.csv$/i.test(extension)) return undefined;
  const grid = (sheets: Sheet[]) => sheets.find(({ name }) => name === sheet)?.grid ?? [];
  return async (file: string, values: Sheet[]) => {
    if (!converter.sheets) throw new Error('no spreadsheet reader');
    const formulas = grid(await converter.sheets(file, false, true));
    const shown = grid(values);
    return (row: number, column: number): string | false => {
      const value = formulas[row]?.[column] ?? '';
      return value.startsWith('=') && value !== (shown[row]?.[column] ?? '') ? value : false;
    };
  };
}

/** Keep the retained-edit calculation on the exact bytes whose stamp guards the write (#282). */
async function readKeptLog(
  work: string, extension: string, bytes: Uint8Array, sheet: string, sheets: (file: string) => Promise<Sheet[]>,
  formulas: ReturnType<typeof workbookFormulas>,
) {
  const file = path.join(work, `log${extension}`);
  fs.writeFileSync(file, bytes);
  const snapshot = await sheets(file);
  const formula = await formulas?.(file, snapshot);
  const merged = /\.xlsx$|\.xlsm$/i.test(extension) ? fixedCells(bytes, sheet) : () => false;
  const fixed = (row: number, column: number) => merged(row, column) || !!formula?.(row, column);
  return { snapshot, fixed };
}

/** A kept edit can change the compact indexes by clearing an unnamed column. Follow its sheet position (#282). */
function currentKeptColumns(cols: { text: number; n?: number; by?: number }, read: KeptTable, current: KeptTable) {
  const index = (old: number) => current.cols.indexOf(read.cols[old]);
  return {
    text: index(cols.text), n: cols.n === undefined ? undefined : index(cols.n),
    by: cols.by === undefined ? undefined : index(cols.by),
  };
}

type KeptOutcome = { left: boolean; clashes: number[]; steps?: true };

/** A file without an outcome either could not be merged or was already merged and only needs filing. */
function keptFileResults(files: KeptEdit[], outcomes: Map<KeptEdit, KeptOutcome>) {
  return files.map((file) => {
    const result = outcomes.get(file);
    const left = result ? result.left : !/\.kept$/i.test(file.name);
    return {
      name: file.name, hash: file.hash, ...(left ? { left: true as const } : {}),
      ...(result?.clashes.length ? { clashes: result.clashes } : {}),
      ...(result?.steps ? { steps: true as const } : {}),
    };
  });
}

export function nodeQaLogs(o: { convert?: Converter; now?: () => Date }): QaLogFiles {
  const conv: Converter = o.convert ?? Object.assign(() => Promise.reject(new Error('no converter')), { id: 'none' });   // a CSV log needs none
  /** every sheet of a file, as text */
  const sheets = async (file: string): Promise<Sheet[]> => (/\.csv$/i.test(file) ? [{ name: 'Sheet1', grid: parseCsv(decodeText(new Uint8Array(fs.readFileSync(file)))) }] : o.convert?.sheets ? o.convert.sheets(file) : Promise.reject(new Error('no spreadsheet reader')));
  /** the log's place, or why it can't be used */
  const where = (folder: string, file: string) => {
    if (!EXT.test(path.extname(file))) return fail({ kind: 'invalid' as const, message: 'Only .xlsx, .xlsm, .xls, .ods and .csv logs can be updated' });
    const at = path.join(folder, file); restoreAside(folder, file); return fs.existsSync(at) ? ok(at) : fail({ kind: 'notFound' as const, message: `The Q&A log isn’t at ${at} any more` });
  };
  /**
   * The log (`file`, its `bytes`, as read: `read`) with edits kept aside brought in, each merged against the archive copy
   * it was made from (keptMerge). `kept.files` are the ones to file in the archive once the update is saved: those merged,
   * and those that can never be (no archive copy they were made from, or another sheet or heading row). One that could not
   * be read (damaged, say) is filed as it is. `cols`: the question and number columns, by their places in the table's columns.
   * Each file says what of it the log does not get: `left` when some of their changes are not brought in (none merged, or
   * cells with nowhere to go), and `clashes`, its rows where the log's value stays; and `steps` when some are in `kept.steps`. A `.kept` file was merged at an earlier
   * update and is only filed now, so it says nothing.
   */
  const bringIn = async (
    file: string, bytes: Uint8Array, folder: string, found: KeptEdit[],
    opts: SheetReadOptions & { sheet: string; headerRow: number }, cols: { text: number; n?: number; by?: number },
    read: KeptTable,
  ) => {
    const ext = path.extname(file); const steps: SheetEdit[] = []; const clashes = new Set<number>(); let table = read; const files = found.filter((k) => !k.base);
    const ask: (KeptAsk & { file: string })[] = [];                                     // rows the person says where they go
    const done = new Map<KeptEdit, KeptOutcome>();
    if (files.length === found.length) {
      return { ...read, kept: { files: keptFileResults(files, done), steps, clashes: [], ask } };
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-qalog-kept-'));
    try {
      /** a copy under the log's extension, for the readers (a kept edit's own name ends in .old) */
      const copy = (from: string, name: string, hash?: string) =>
        copyLogFile(from, path.join(work, `${name}${ext}`), hash);
      const formulas = workbookFormulas(conv, ext, opts.sheet);
      const { snapshot, fixed } = await readKeptLog(work, ext, bytes, opts.sheet, sheets, formulas);
      let now = snapshot;
      for (const [i, k] of found.entries()) {
        if (!k.base) continue;
        try {
          const bf = copyArchivedBase(k.base, path.join(work, `base${i}${ext}`));
          const kf = copy(path.join(folder, k.name), `kept${i}`, k.hash);
          const ks = await sheets(kf);
          const bs = await sheets(bf); const base = tableFrom(bs, opts), kept = tableFrom(ks, opts);
          files.push(k);
          if (!base || !kept || !atLinkedTable(base, opts) || !atLinkedTable(kept, opts)) continue;
          const ours = await formulas?.(bf, bs);
          const theirs = await formulas?.(kf, ks);
          const { text, n, by } = currentKeptColumns(cols, read, table);
          const m = mergeKept(base, kept, table, text, fixed, theirs, n, ours, by);
          ask.push(...m.ask.map((a) => ({ ...a, file: k.name })));
          if (!m.steps.length && !m.clashes.length) { done.set(k, { left: m.left > 0, clashes: [], ...(m.ask.length ? { steps: true as const } : {}) }); continue; }
          const next = withSteps(now, opts.sheet, m.steps); const t = next && tableFrom(next, opts); if (!next || !t) continue;
          steps.push(...m.steps); for (const c of m.clashes) clashes.add(c); now = next; table = t; done.set(k, { left: m.left > 0, clashes: m.clashes, ...(m.steps.length || m.ask.length ? { steps: true as const } : {}) });
        } catch (e) {
          // held for a moment (EBUSY), or a reader that timed out: left for the next update; one that can't be read as a
          // spreadsheet at all (damaged) is filed as it is, or it would be tried at every update
          if (brief(e)) { if (files.at(-1) === k) files.pop(); } else if (files.at(-1) !== k) files.push(k);
        }
      }
    } catch { return { ...read, kept: { files: [], steps: [], clashes: [], ask: [] } }; }   // the log itself could not be read so: next time
    finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* left in the temp folder */ } }
    const kept = { files: keptFileResults(files, done), steps, clashes: [...clashes].sort((a, b) => a - b), ask };
    const { columns, cols: positions, rows, lines, lastRow } = table;
    return { columns, cols: positions, rows, lines, lastRow, kept };
  };
  return {
    async read(at, opts) {
      const w = where(at.folder, at.file); if (!w.ok) return w;
      const bytes = new Uint8Array(fs.readFileSync(w.value));
      const { sheet, headerRow, layout } = opts;
      const includeColumns = layout ? selectedUnnamedColumns(layout) : undefined;
      const choice = { sheet, headerRow, includeColumns };
      const r = await libreOfficeSheets(conv).read(bytes, at.file, choice);
      if (!r.ok) return r;
      const t = r.value;
      const kept = keptColumnsForRead(t, opts);
      if (!kept.ok) return kept;
      const read = {
        columns: t.columns, cols: t.cols ?? t.columns.map((_, index) => index), rows: t.rows,
        columnCount: t.columnCount,
        lines: t.lines ?? t.rows.map((_, index) => index + 2), lastRow: t.lastRow ?? t.rows.length + 1,
        stamp: sha256(bytes),
      };
      if (!kept.value) return ok(read);
      const found = keptEdits(at.folder, at.file);
      if (!found.length) return ok(read);
      const merged = await bringIn(w.value, bytes, at.folder, found, choice, kept.value, read);
      return ok({ ...read, ...merged });
    },
    async settle(req) { try { return ok({ gone: settleKept(req.folder, req.file, req.kept) }); } catch (e) { return fail({ kind: 'failed', message: `The kept edits were not filed: ${(e as Error).message}` }); } },
    async save(req) {
      const w = where(req.folder, req.file); if (!w.ok) return w;
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'punchlist-qalog-'));
      try {
        const ext = path.extname(req.file); const base = path.join(work, `base${ext}`); fs.copyFileSync(w.value, base);
        if (sha256(new Uint8Array(fs.readFileSync(base))) !== req.stamp) return ok({ status: 'later' as const });   // someone saved it since it was read
        const { steps } = req;
        // a log whose own content refuses the steps (a formula, a totals row, a read-back that differs) is "rejected": it would
        // refuse them again at every update; a LibreOffice edit that fails may be a moment's trouble, so it is "failed"
        let bytes: Uint8Array;
        try { bytes = await editLog(conv, base, req.sheet, steps); } catch (e) {
          const refused = !brief(e) && ((e as { refused?: boolean }).refused || /\.(xlsx|xlsm|csv)$/i.test(req.file));
          return fail({ kind: refused ? 'rejected' : 'failed', message: `The log was not saved: ${(e as Error).message}` });
        }
        const out = path.join(work, `out${ext}`); fs.writeFileSync(out, bytes);
        const wrong = writtenAsMeant(await sheets(base), await sheets(out), req.sheet, steps);   // nothing is saved unless the new file reads as meant
        if (wrong) return fail({ kind: 'rejected', message: `The log was not saved: in the new version ${wrong}` });
        return ok(saveLog({ folder: req.folder, file: req.file, bytes, was: req.stamp, at: o.now?.() ?? new Date() }));
      } catch (e) { return fail({ kind: 'failed', message: `The log was not saved: ${(e as Error).message}` }); }
      // this PC's own scratch folder: one another program still holds (antivirus) is left, and never fails a save made
      finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* left in the temp folder */ } }
    },
    async create(req) {
      if (!fs.existsSync(req.folder)) return fail({ kind: 'notFound', message: `The folder can’t be reached: ${req.folder}` });
      try { return ok({ file: createLog(req.folder, req.file, req.bytes) }); } catch (e) { return fail({ kind: 'failed', message: `The log could not be made: ${(e as Error).message}` }); }
    },
  };
}
