/**
 * What the app writes back into the deal's Q&A log. The log stays the person's own file, in its own
 * format, columns and look, and is kept up to date as an IB Q&A log is: every column it has is filled in
 * from the app. An empty cell takes the app's value, if it has one; nothing is made up. A filled cell the app changed since
 * it last wrote it is updated, but not one someone else changed in the log since: theirs stands, and any difference
 * in the text counts as a change. Questions the log lacks get rows of their own at the end. The app adds no columns.
 */
import type { Question } from './model';
import type { ReadTable, SheetEdit } from './sheets';
import { prepareImport, IMPORT_FIELDS, type Mapping, type ImportField, type ImportRow } from './importExport';

/** every field the app keeps up to date in the log, where the log has a column for it */
const FIELDS: ImportField[] = ['n', 'text', 'askedBy', 'received', 'workstream', 'priority', 'status', 'response', 'respondedBy', 'responded'];
const STATUS_LABEL: Record<Question['status'], string> = { open: 'Open', answered: 'Answered', closed: 'Closed' };
/** a date field's step says so, so a workbook gets a real date in the column's own format */
const dated = (k: ImportField) => (k === 'received' || k === 'responded' ? { date: true as const } : {});
/** a question's value for a field, as the app writes it */
export function cellValue(q: Question, k: ImportField): string { return k === 'status' ? STATUS_LABEL[q.status] ?? '' : k === 'n' ? String(q.n) : String((q as unknown as Record<string, unknown>)[k] ?? ''); }

export interface LogWrite {
  steps: SheetEdit[];
  /** questions given a row of their own at the end of the log */
  added: number;
  /** log rows given a response they did not have */
  answered: number;
  /** log rows with a cell brought up to date */
  updated: number;
  /** questions with a cell someone changed in the log since the app wrote it: theirs is left as it is */
  kept: number[];
  /** those cells' fields, by question id */
  keptFields: Record<string, ImportField[]>;
  /** what those cells say in the log, by question id and field: what a person is shown, and keeps or takes */
  keptText: Record<string, Record<string, string>>;
  /** what the log holds of the app's after these steps, by question id and field: what was written, a cell that already said
   * the same (as the log writes it), and for a cell kept as someone wrote it, what the app had sent before. The next update's `sent`. */
  sent: Record<string, Record<string, string>>;
  /**
   * Cells only the log changed since the app last wrote them (the app's value is still what it sent): the log's is the
   * latest, so the app takes it. By question id and field, what the log says. Not written, and not in `kept`.
   */
  taken: Record<string, Record<string, string>>;
}

/**
 * A text as a log file holds it: the file keeps a line break as one "\n" and cannot hold control characters, so a writer
 * stores each as a space or leaves it out (xlsx leaves it out). This is how the file stores text, not a repair; every
 * other difference is a real edit.
 */
const asLogHolds = (text: string, controls: string) =>
  text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, controls);
const sameInLog = (a: string, b: string) => a === b || asLogHolds(a, ' ') === asLogHolds(b, ' ') || asLogHolds(a, '') === asLogHolds(b, '');
/** a log's question number as it is written ("Q4", "4.", "#004", "A-4"): what comes before the number, the number, and what after */
const numberParts = (v: string) => { const m = /^\s*(\D*?)0*(\d+)\s*([.)]?)\s*$/.exec(v); return m ? { pre: m[1], n: +m[2], post: m[3] } : null; };
/**
 * Which row of the log stands for each question: the row with the same sender and exact text, the one with the
 * question's own number first; each row stands for one question. By question id, the row's index in `table.rows`.
 * A row or question naming no sender does not conflict with one that does, but the same sender is always tried first. The
 * sender the app last wrote for a question (`sent`) still counts after a person corrects it in the app, after its own.
 */
export function matchRows(table: Pick<ReadTable, 'rows'>, mapping: Mapping, questions: Question[], sent: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map()): Map<string, number> {
  const cell = (r: string[], k: ImportField) => (mapping[k] == null ? '' : String(r[mapping[k]!] ?? ''));
  const taken = new Set<number>(); const rowOf = new Map<string, number>();
  // rows by exact text, in the log's order, so a log of thousands of rows is matched in a moment
  // a text as the log file holds it (a line break as "\n", control characters as a space or gone) is the text it was written as
  const byText = new Map<string, number[]>();
  const addRow = (text: string, i: number) => { const list = byText.get(text); if (list) list.push(i); else byText.set(text, [i]); };
  table.rows.forEach((r, i) => {
    const text = cell(r, 'text'); if (!text.trim()) return;
    for (const form of new Set([text, asLogHolds(text, ' '), asLogHolds(text, '')])) addRow(form, i);
  });
  const rowsOf = (q: Question) => [...new Set([q.text, asLogHolds(q.text, ' '), asLogHolds(q.text, '')])].flatMap((form) => byText.get(form) ?? []).sort((a, b) => a - b);
  // a name is as written, spaces around it aside; each row's and question's is worked out once
  const rowSender = table.rows.map((r) => cell(r, 'askedBy').trim());
  const rowNumber = table.rows.map((r) => numberParts(cell(r, 'n'))?.n);
  const lastSent = (q: Question) => (sent.get(q.id)?.askedBy ?? '').trim();
  const own = (i: number, q: Question) => rowSender[i] === q.askedBy.trim();
  const written = (i: number, q: Question) => !!lastSent(q) && rowSender[i] === lastSent(q);
  const unnamed = (i: number, q: Question) => !rowSender[i] || !q.askedBy.trim();
  const tiers: ((i: number, q: Question) => boolean)[] = [own, written, unnamed];
  for (const fits of tiers) for (const withNumber of [true, false]) for (const q of questions) {
    if (rowOf.has(q.id)) continue;
    const i = rowsOf(q).find((row) => !taken.has(row) && fits(row, q) && (!withNumber || rowNumber[row] === q.n));
    if (i !== undefined) { taken.add(i); rowOf.set(q.id, i); }
  }
  return rowOf;
}

/**
 * What the log holds for each question it has a row for, field by field, as written, where the app already says the same
 * (as logWrite judges it): when a file becomes the deal's log this is recorded as what the app last wrote, so the next
 * update brings those cells up to date with what a person changes in the app. A cell that says something else (a file
 * imported as new questions beside the app's own) is not the app's: it stays theirs, and an update keeps it.
 */
export function logHolds(table: Pick<ReadTable, 'rows'>, mapping: Mapping, questions: Question[]): Record<string, Record<string, string>> {
  const rows = table.rows; const width = Math.max(0, ...rows.map((r) => r.length));
  const w = logWrite({ rows, cols: Array.from({ length: width }, (_, i) => i), lines: rows.map((_, i) => i + 2), lastRow: rows.length + 1 }, mapping, questions);
  const out: Record<string, Record<string, string>> = {};
  for (const [id, i] of matchRows(table, mapping, questions)) {
    const now: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.sent[id] ?? {})) { const c = mapping[k as ImportField]; if (k !== 'n' && c != null && String(rows[i][c] ?? '').trim() && v === String(rows[i][c] ?? '')) now[k] = v; }   // only what the file holds, not what an update would fill in
    out[id] = now;
  }
  return out;
}

/**
 * The steps that bring `questions` into the log `table` was read from. A question is the log's row with the same words,
 * failing that the row with its number; each row stands for one question. `mapping` gives each field's column in `table`.
 * `sent`: what the app last wrote into the log, by question id and field.
 */
export function logWrite(table: Pick<ReadTable, 'rows' | 'lines' | 'cols' | 'lastRow'>, mapping: Mapping, questions: Question[], sent: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map()): LogWrite {
  const col = (k: ImportField) => (mapping[k] == null ? null : table.cols[mapping[k]!] ?? null);
  const cell = (r: string[], k: ImportField) => (mapping[k] == null ? '' : String(r[mapping[k]!] ?? ''));
  const out: LogWrite = { steps: [], added: 0, answered: 0, updated: 0, kept: [], keptFields: {}, keptText: {}, sent: {}, taken: {} };
  const rowOf = matchRows(table, mapping, questions, sent);
  const fresh = questions.filter((q) => !rowOf.has(q.id));
  // new rows are numbered as the log numbers its own: "Q4", "4.", "#4" or plain 4
  const style = table.rows.map((r) => numberParts(cell(r, 'n'))).find((x) => x) ?? { pre: '', post: '' };
  // each row as the import reads it (dates, statuses and priorities in the app's terms), so a cell written another way
  // ("11/12/2026", "Outstanding", "H") that says what the app holds is not taken for a change
  const read = new Map(prepareImport(table.rows, mapping, table.rows.map((_, i) => i)).rows.map((r) => [r.line!, r] as const));
  // a value as the import reads it against the app's: a status or priority in the app's terms, whatever case it is written in
  const same = (k: ImportField, a: string, b: string) => (k === 'status' || k === 'priority' ? a.toLowerCase() === b.toLowerCase() : sameInLog(a, b));
  const sameAs = (k: ImportField, i: number, v: string) => { const r = read.get(i) as ImportRow | undefined; const was = r ? String((r as unknown as Record<string, unknown>)[k] ?? '') : cell(table.rows[i], k); if (k === 'n') return numberParts(cell(table.rows[i], 'n'))?.n === Number(v);
    if ((k === 'received' || k === 'responded') && !was && cell(table.rows[i], k).trim()) return true;   // a date the import could not settle (11/02 either way) is left as the log writes it
    return same(k, was, v) || sameInLog(cell(table.rows[i], k), v); };
  // a log cell's value as the import reads it ("11/12/2026" as 2026-11-12, "Outstanding" as open), else as written
  const readAs = (k: ImportField, i: number) => { const r = read.get(i) as ImportRow | undefined; return r ? String((r as unknown as Record<string, unknown>)[k] ?? '') : ''; };
  for (const q of questions) {
    const i = rowOf.get(q.id); if (i === undefined) continue;
    const r = table.rows[i]; const before = sent.get(q.id) ?? {}; const now: Record<string, string> = {}; let filled = false, changed = false, theirs = false;
    for (const k of FIELDS) {
      const c = col(k); if (c == null) continue; const v = cellValue(q, k); const has = cell(r, k);
      if (k === 'n') { if (has.trim()) now.n = has; continue; }                       // a row keeps the number the log gave it
      // a value the app never wrote is skipped; one it cleared after writing it clears the log's too (#39)
      if (!v.trim() && before[k] === undefined) continue;
      if (sameAs(k, i, v)) { now[k] = has; continue; }                                 // the log says it already, its own way: kept as the log writes it
      // the cell still holds what the app last put there, as written or as the import reads it
      const ours = before[k] !== undefined && (sameInLog(has, before[k]) || (!!readAs(k, i) && same(k, readAs(k, i), before[k])));
      // someone changed it in the log; where the app still holds what it last sent, only the log changed: the app takes it
      if (has.trim() && !ours && before[k] !== undefined && (sameInLog(v, before[k]) || same(k, v, before[k]))) { (out.taken[q.id] ??= {})[k] = has; now[k] = has; continue; }
      if (has.trim() && !ours) { theirs = true; (out.keptFields[q.id] ??= []).push(k); (out.keptText[q.id] ??= {})[k] = has; if (before[k] !== undefined) now[k] = before[k]; continue; }   // someone else's: never overwritten
      // a blank Priority stays blank: the app's High on a question that came in with none is its default, not a value anyone gave
      if (k === 'priority' && !has.trim() && v === 'High' && before[k] === undefined) continue;
      out.steps.push({ kind: 'cell', row: table.lines[i] - 1, col: c, value: v, ...dated(k) }); now[k] = v;
      if (k === 'response' && !has.trim()) filled = true; else changed = true;
    }
    out.sent[q.id] = now;
    if (filled) out.answered++; else if (changed) out.updated++;
    if (theirs) out.kept.push(q.n);
  }
  if (fresh.length) {
    const last = table.lastRow - 1;                                                   // new rows go below the last row the log uses, styled like it
    out.steps.push({ kind: 'rows', after: last, count: fresh.length });
    fresh.sort((a, b) => a.n - b.n).forEach((q, j) => {
      const now: Record<string, string> = {};
      for (const k of FIELDS) { const c = col(k); const v = k === 'n' ? (style.pre || style.post ? `${style.pre}${q.n}${style.post}` : q.n) : cellValue(q, k); if (c != null && v !== '') { out.steps.push({ kind: 'cell', row: last + 1 + j, col: c, value: v, ...dated(k) }); now[k] = String(v); } }
      out.sent[q.id] = now;
    });
    out.added = fresh.length;
  }
  return out;
}

/**
 * A question's cells as the log writes them, in the app's terms, as the import reads them: a status of "Outstanding" as
 * open, a date of 11/20/2026 as 2026-11-20. A cell the import cannot read stays as written. `today` settles a date
 * written without its year, as the import does.
 */
export function readLogCells(q: Question, cells: Record<string, string>, today?: string): Record<string, string> {
  const keys = Object.keys(cells) as ImportField[]; if (!keys.length) return {};
  const cols: ImportField[] = keys.includes('text') ? keys : [...keys, 'text'];   // a row is read only with its question
  const mapping = Object.fromEntries(IMPORT_FIELDS.map(([k]) => [k, cols.indexOf(k) < 0 ? null : cols.indexOf(k)])) as Mapping;
  const read = prepareImport([cols.map((k) => cells[k] ?? q.text)], mapping, [2], today ? { today } : {}).rows[0] as unknown as Record<string, unknown> | undefined;
  return Object.fromEntries(keys.map((k) => [k, read?.[k] == null || read[k] === '' && cells[k].trim() ? cells[k] : String(read[k])]));
}
/** whether a question's field already says `value` (in the app's terms, as readLogCells gives it); the words exactly as written */
export function holds(q: Question, k: string, value: string): boolean {
  const app = String((q as unknown as Record<string, unknown>)[k] ?? '');
  return k === 'status' || k === 'priority' || k === 'received' || k === 'responded' ? app.toLowerCase() === value.trim().toLowerCase() : sameInLog(app, value);
}
