/**
 * What the app writes back into the deal's Q&A log. The log stays the person's own file, in its own
 * format, columns and look, and is kept up to date as an IB Q&A log is: every column it has is filled in
 * from the app. An empty cell takes the app's value, if it has one; nothing is made up. A filled cell the app changed since
 * it last wrote it is updated, but not one someone else changed in the log since: theirs stands, and any difference
 * in the text counts as a change. Questions the log lacks get rows of their own at the end. The app adds no columns.
 */
import type { Question } from './model';
import type { ReadTable, SheetEdit } from './sheets';
import { prepareImport, IMPORT_FIELDS, sameText, type Mapping, type ImportField, type ImportRow } from './importExport';
import { matchQuestions } from './qaMatch';

/** every field the app keeps up to date in the log, where the log has a column for it */
export const FIELDS: ImportField[] = [
  'n', 'text', 'askedBy', 'received', 'workstream', 'priority', 'status', 'response', 'respondedBy', 'responded',
];
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

/** a log's question number as it is written ("Q4", "4.", "#004", "A-4"): what comes before the number, the number, and what after */
export const numberParts = (v: string) => {
  const m = /^\s*(\D*?)0*(\d+)\s*([.)]?)\s*$/.exec(v);
  return m ? { pre: m[1], n: +m[2], post: m[3] } : null;
};
/**
 * Which row of the log stands for each question, by question id: the row's index in `table.rows`. The import's own
 * lookup (`matchQuestions`, #1080), with each row's number as the log writes it ("Q4", "4.", "#004"). After a
 * question's own sender, the sender the app last wrote for it (`sent`) still counts, so a party a person corrects in
 * the app keeps its row.
 */
export function matchRows(table: Pick<ReadTable, 'rows'>, mapping: Mapping, questions: Question[], sent: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map()): Map<string, number> {
  const cell = (r: string[], k: ImportField) => (mapping[k] == null ? '' : String(r[mapping[k]!] ?? ''));
  // a row with no question in it (a heading's spacer, a blank line) stands for none; `at` keeps each row's place
  const at = table.rows.flatMap((r, i) => (cell(r, 'text').trim() ? [i] : []));
  const rows = at.map((i) => {
    const r = table.rows[i];
    return { n: numberParts(cell(r, 'n'))?.n ?? null, text: cell(r, 'text'), askedBy: cell(r, 'askedBy') };
  });
  const lastSent = (q: Question) => sent.get(q.id)?.askedBy ?? '';
  const matched = matchQuestions(rows, [questions], [(q) => q.askedBy, lastSent]);
  return new Map([...matched].map(([idx, id]) => [id, at[idx]]));
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
  const same = (k: ImportField, a: string, b: string) => (k === 'status' || k === 'priority'
    ? a.toLowerCase() === b.toLowerCase()
    : sameText(a, b));
  const sameAs = (k: ImportField, i: number, v: string) => { const r = read.get(i) as ImportRow | undefined; const was = r ? String((r as unknown as Record<string, unknown>)[k] ?? '') : cell(table.rows[i], k); if (k === 'n') return numberParts(cell(table.rows[i], 'n'))?.n === Number(v);
    if ((k === 'received' || k === 'responded') && !was && cell(table.rows[i], k).trim()) return true;   // a date the import could not settle (11/02 either way) is left as the log writes it
    return same(k, was, v) || sameText(cell(table.rows[i], k), v); };
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
      const ours = before[k] !== undefined
        && (sameText(has, before[k]) || (!!readAs(k, i) && same(k, readAs(k, i), before[k])));
      // someone changed it in the log; where the app still holds what it last sent, only the log changed: the app takes it
      if (has.trim() && !ours && before[k] !== undefined && (sameText(v, before[k]) || same(k, v, before[k]))) {
        (out.taken[q.id] ??= {})[k] = has;
        now[k] = has;
        continue;
      }
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
  return k === 'status' || k === 'priority' || k === 'received' || k === 'responded'
    ? app.toLowerCase() === value.trim().toLowerCase()
    : sameText(app, value);
}
