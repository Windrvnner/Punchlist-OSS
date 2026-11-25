/**
 * Spreadsheet import and export, as pure functions over plain tables. Reading and
 * writing the file format itself is the SpreadsheetCodec port's job (LibreOffice in the app).
 */
import type { Question, Finding, QuestionStatus } from './model';
import { localYmd, WORKSTREAMS } from './model';
import { splitCited } from './cite';
import { isRealDate } from './model';
import { AI_LABEL } from '../control';

export const IMPORT_FIELDS = [['n', 'Number'], ['text', 'Question'], ['askedBy', 'Submitted by'], ['received', 'Received'], ['workstream', 'Workstream'], ['priority', 'Priority'], ['response', 'Response'], ['respondedBy', 'Responded by'], ['responded', 'Date'], ['status', 'Status']] as const;
export type ImportField = typeof IMPORT_FIELDS[number][0];
export type Mapping = Record<ImportField, number | null>;

/**
 * Which row of a sheet holds the column headings. A log often sits under a title and some padding, so this is the first
 * row (of the first 50) with a heading we recognize as the question column; failing that the first row with two or more
 * filled cells; failing that the first row. It is a starting point only: the dialog shows it and the person can change it.
 */
export function findHeaderRow(table: string[][]): number {
  const limit = Math.min(table.length, 50); const filled = (r: string[]) => r.filter((c) => c.trim()).length;
  for (let i = 0; i < limit; i++) if (suggestMapping(table[i]).text != null) return i;
  for (let i = 0; i < limit; i++) if (filled(table[i]) >= 2) return i;
  return 0;
}

export function suggestMapping(columns: string[]): Mapping {
  const norm = (c: string) => String(c ?? '').toLowerCase().replace(/[^a-z#]/g, '');
  const find = (...keys: string[]) => { const i = columns.findIndex((c) => keys.includes(norm(c))); return i < 0 ? null : i; };
  return {
    n: find('#', 'no', 'number', 'num', 'q', 'qno', 'ref', 'id'), text: find('question', 'questions', 'questiontext', 'query', 'request', 'item'),
    askedBy: find('submittedby', 'from', 'firm', 'askedby', 'raisedby', 'requester', 'source'), received: find('received', 'datereceived', 'dateraised', 'raised', 'asked'),
    workstream: find('workstream', 'category', 'area', 'topic'), priority: find('priority', 'prio', 'urgency'),
    response: find('response', 'answer', 'reply', 'sponsorresponse'), respondedBy: find('respondedby', 'answeredby', 'respondent', 'responder', 'repliedby', 'responseby', 'responsefrom', 'answerby', 'answerfrom', 'replyby', 'replyfrom', 'respondingparty', 'respondingfirm', 'respondentfirm', 'responderfirm'),
    responded: find('date', 'dateresponded', 'responded', 'dateanswered', 'answered', 'responsedate'), status: find('status', 'state'),
  };
}

const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const ymd = (y: number, m: number, d: number) => { const s = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isRealDate(s) ? s : null; };

/** a two-digit year as Excel reads one typed in a cell: 00–29 are 2000–2029, 30–99 are 1930–1999 */
const fullYear = (y: string) => (y.length === 4 ? +y : +y < 30 ? 2000 + +y : 1900 + +y);
/** a time after a date ("12:00:00", "3:30 PM"), as a date-and-time cell reads */
const TIME = /[ T]+([01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:\s*[AaPp]\.?[Mm]\.?)?$/;

/**
 * A date as typed in a spreadsheet cell → YYYY-MM-DD, '' for blank, or null when it is not a real calendar date.
 * Never rolls an impossible date forward. On its own, a numeric date valid both ways gives its month-first reading; in an
 * import, prepareImport settles it from the dates around it (dateReadings). A year written with two digits is read as
 * Excel reads it. A month written as a word may come before or after the day, with an ordinal ("2nd") and with spaces,
 * hyphens or commas between. A date with a time is read as its date. A workbook's real date cell arrives as YYYY-MM-DD
 * (convert.ts), so it is never in doubt. A bare number (a serial date typed as text, or a cell with no date format) is not
 * read: it could as well be a plain number.
 */
export function parseDate(v: unknown): string | null { const c = dateReadings(v); return c.length ? c[0] : null; }

/**
 * Every way a date cell can be read: [''] for blank, [] when it is not a real calendar date, one date, or for a numeric
 * date valid both ways ("02.11.2026") the month-first reading then the day-first one. prepareImport chooses between the two.
 */
export function dateReadings(v: unknown): string[] {
  const one = (d: string | null) => (d === null ? [] : [d]);
  const s0 = String(v ?? '').trim(); if (!s0) return [''];
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(s0))) return one(ymd(+m[1], +m[2], +m[3]));
  const s = s0.replace(TIME, '');
  if ((m = /^(\d{4})([\/.])(\d{1,2})\2(\d{1,2})$/.exec(s))) return one(ymd(+m[1], +m[3], +m[4]));   // year first: 2026/11/02
  if ((m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4}|\d{2})$/.exec(s))) { const a = +m[1], b = +m[2], y = fullYear(m[3]); if (a > 12 && b <= 12) return one(ymd(y, b, a)); if (a <= 12 && b <= 12 && a !== b) return [ymd(y, a, b)!, ymd(y, b, a)!]; return one(ymd(y, a, b)); }
  const day = String.raw`(\d{1,2})(?:st|nd|rd|th)?`; const sep = String.raw`[\s,\-]+`;
  if ((m = new RegExp(`^([A-Za-z]{3,9})\\.?${sep}${day}${sep}(\\d{4}|\\d{2})$`, 'i').exec(s))) { const mo = MON[m[1].slice(0, 3).toLowerCase()]; return one(mo ? ymd(fullYear(m[3]), mo, +m[2]) : null); }
  if ((m = new RegExp(`^${day}${sep}([A-Za-z]{3,9})\\.?${sep}(\\d{4}|\\d{2})$`, 'i').exec(s))) { const mo = MON[m[2].slice(0, 3).toLowerCase()]; return one(mo ? ymd(fullYear(m[3]), mo, +m[1]) : null); }
  return [];
}

export interface ImportRow { /** the row's line in the file, header being line 1 */ line?: number; n: number | null; text: string; askedBy: string; received: string; workstream: string; priority: '' | 'High' | 'Medium' | 'Low'; response: string; respondedBy: string; responded: string; status: QuestionStatus | '' }
export interface Prepared { rows: ImportRow[]; skipped: number; badDates: number; unknownValues: number; /** each date or value counted above, where it is: "Row 14 Received: 31/31/2026" */ unread: string[] }

const PRIORITY: Record<string, ImportRow['priority']> = { high: 'High', medium: 'Medium', low: 'Low' };
const STATUS: Record<string, QuestionStatus> = { open: 'open', outstanding: 'open', answered: 'answered', closed: 'closed' };

/**
 * Apply a column mapping to a raw table. Rows without a question are skipped and counted; so are values that could not be read.
 * The question and response are kept exactly as written, spaces and line breaks included, so the app's own export comes
 * back unchanged. Names and workstream are identities, not prose: "Lender A " is the submitter
 * "Lender A", so the spaces around them go (the text inside is untouched). The values that are read as something else
 * (number, dates, priority, status) ignore the spaces around them too. A question of only spaces is a question, as one
 * made in the app can be.
 * A numeric date valid both ways is settled by context, not by one format per file or column:
 * first the row's other date (a question is received before it is responded to), then the nearest settled dates above
 * and below it in its column (logs mostly run in date order: the reading between them, else the one much nearer them),
 * then no date after today. Unsettled, it is left blank and
 * counted as not read. A workbook's real date cells reach here as YYYY-MM-DD (see convert.ts), so only typed dates are in doubt.
 */
export function prepareImport(table: string[][], mapping: Mapping, lines?: number[], o: { today?: string } = {}): Prepared {
  const today = o.today ?? localYmd(new Date().toISOString());
  // control characters (NUL, BEL, ESC and the like) are never content; tabs and line breaks are
  const get = (r: string[], k: ImportField) => (mapping[k] == null ? '' : String(r[mapping[k]!] ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ''));
  const out: Prepared = { rows: [], skipped: 0, badDates: 0, unknownValues: 0, unread: [] };
  const nameOf = (k: ImportField) => IMPORT_FIELDS.find(([f]) => f === k)?.[1] ?? k;
  type DateCell = { raw: string; readings: string[]; done: (d: string) => void; bad: () => void };
  const cells: Record<'received' | 'responded', DateCell[]> = { received: [], responded: [] };
  for (const [at, r] of table.entries()) {
    const text = get(r, 'text'); if (!text) { out.skipped++; continue; }
    const line = lines?.[at] ?? at + 2; const unread = (k: ImportField, v: string) => out.unread.push(`Row ${line} ${nameOf(k)}: ${v.trim()}`);
    const date = (k: 'received' | 'responded') => { const raw = get(r, k); const c = { raw, readings: dateReadings(raw), done: (d: string) => { row[k] = d; }, bad: () => { out.badDates++; unread(k, raw); } }; cells[k].push(c); return c; };
    const pr = get(r, 'priority').trim(); const st = get(r, 'status').trim(); const nRaw = get(r, 'n').trim().replace(/^q/i, ''); const n = /^\d{1,9}$/.test(nRaw) && +nRaw > 0 ? +nRaw : null;   // the app numbers past Q999999, so a 7-digit number it exported reads back
    const wsRaw = get(r, 'workstream').trim(); const ws = WORKSTREAMS.find((w) => w.toLowerCase() === wsRaw.toLowerCase()) ?? wsRaw;   // the app's spelling where it is one of ours; otherwise kept as written
    if (pr && !PRIORITY[pr.toLowerCase()]) { out.unknownValues++; unread('priority', pr); }
    if (st && !STATUS[st.toLowerCase()]) { out.unknownValues++; unread('status', st); }
    const row: ImportRow = { n, text, askedBy: get(r, 'askedBy').trim(), received: '', workstream: ws, priority: PRIORITY[pr.toLowerCase()] ?? '', response: get(r, 'response'), respondedBy: get(r, 'respondedBy').trim(), responded: '', status: STATUS[st.toLowerCase()] ?? '', line };
    out.rows.push(row);
    const rec = date('received'), res = date('responded');
    // the row's other date: keep the readings that leave received on or before responded
    if (rec.readings.length > 1 || res.readings.length > 1) {
      const fits = (x: string, y: string) => !x || !y || x <= y;
      const a = rec.readings.filter((x) => res.readings.some((y) => fits(x, y))), b = res.readings.filter((y) => rec.readings.some((x) => fits(x, y)));
      if (a.length) rec.readings = a; if (b.length) res.readings = b;
    }
  }
  for (const col of [cells.received, cells.responded]) {
    // the nearest dates above and below that are already settled, as they stood after the row's own check
    const settled = col.map((c) => (c.readings.length === 1 && c.readings[0] ? c.readings[0] : ''));
    for (const [i, c] of col.entries()) {
      if (c.readings.length < 2) continue;
      const above = settled.slice(0, i).reverse().find(Boolean), below = settled.slice(i + 1).find(Boolean);
      const near = c.readings.filter((x) => (!above || above <= x) && (!below || x <= below));
      // both fit (or neither): the one much nearer the dates around it, as a log in date order would have it
      const days = (x: string) => Math.min(...[above, below].filter((y): y is string => !!y).map((y) => Math.abs(Date.parse(x) - Date.parse(y)) / 864e5));
      const [a, b] = (near.length ? near : c.readings).map((x) => ({ x, d: days(x) })).sort((p, q) => p.d - q.d);
      if (near.length === 1) c.readings = near;
      else if (b && (above || below) && a.d * 2 < b.d) c.readings = [a.x];
      else { const past = c.readings.filter((x) => x <= today); if (past.length === 1) c.readings = past; }
    }
    for (const c of col) { if (c.readings.length === 1) c.done(c.readings[0]); else c.bad(); }
  }
  out.unread.sort((x, y) => +x.split(' ')[1] - +y.split(' ')[1]);   // in row order, as the file reads; the sort keeps each row's own order
  return out;
}

/** Two texts that differ at most in how their line breaks are stored (CR LF, CR or LF): a spreadsheet does not keep that difference, so an import does not count it as a change. */
export const sameText = (a: string, b: string) => a === b || a.replace(/\r\n?/g, '\n') === b.replace(/\r\n?/g, '\n');
/** Two texts with the same words, differing at most in their spaces and line breaks. */
export const sameWords = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();

/** How many rows would be new and how many match an existing number, for the preview. */
export function importCounts(rows: ImportRow[], existing: Question[], mode: 'merge' | 'append') {
  const have = new Set(existing.map((q) => q.n)); let add = 0, match = 0; const seen = new Set<number>();
  for (const r of rows) { if (mode === 'merge' && r.n != null && (have.has(r.n) || seen.has(r.n))) match++; else { add++; if (r.n != null) seen.add(r.n); } }
  return { add, match };
}

const longDate = (iso: string) => (iso ? localYmd(iso) : ''); // the local calendar date, written YYYY-MM-DD so it round-trips and sorts in a spreadsheet
const STATUS_LABEL: Record<QuestionStatus, string> = { open: 'Open', answered: 'Answered', closed: 'Closed' };

/**
 * The Q&A log as Export writes it, and as a deal's new log starts. The person in the app who wrote or accepted an answer
 * stays in the app: an accepted draft says when, not by whom. Who responded on the outside (Responded by)
 * is carried as usual.
 */
export function questionsSheet(rows: Question[]): (string | number)[][] {
  const origin = (q: Question) => { const p = q.provenance; if (!p || !q.response) return ''; if (p.origin === 'ai') return `${AI_LABEL} draft, accepted on ${longDate(p.at)}`; if (p.origin === 'chat') return 'From conversation'; return ''; };
  return [['#', 'Workstream', 'Priority', 'Submitted by', 'Question', 'Received', 'Status', 'Response', 'Responded by', 'Date', 'Response origin'],
    ...rows.map((q) => [q.n, q.workstream, q.priority, q.askedBy, q.text, q.received, STATUS_LABEL[q.status], q.response, q.respondedBy, q.responded, origin(q)])];
}
export function findingsSheet(rows: Finding[]): (string | number)[][] {
  // the finding's own words, without the citation markers (the Sources column lists what they point to)
  const detail = (f: Finding) => f.body.map((p) => splitCited(p, f.sources.length).map((x) => x.text).join('')).join('\n\n');
  const origin = (f: Finding) => (f.origin === 'ai' ? AI_LABEL : f.origin === 'chat' ? 'From conversation' : 'Person');
  // no Reviewed by: a person in the app is never named in a spreadsheet
  const sources = (f: Finding) => f.sources.map((s) => s.doc + (s.loc ? ` · ${s.loc}` : '')).join('\n');
  const reviewedOn = (f: Finding) => (f.reviewed ? longDate(f.reviewed.at) : '');
  return [['Title', 'Detail', 'Workstream', 'Status', 'Raised', 'Origin', 'Reviewed on', 'Sources', 'Note'],
    ...rows.map((f) => [
      f.title, detail(f), f.workstream, f.status === 'open' ? 'Open' : 'Closed', longDate(f.raisedAt), origin(f),
      reviewedOn(f), sources(f), f.note,
    ])];
}
/** A name Windows will accept: its nine forbidden characters and control characters go, letters of any language stay. */
export const safeFileName = (name: string) => {
  const n = name.replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120).trim();
  return !n || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n) ? 'export' : n;
};

/** Excel holds at most 32,767 characters in a cell. Longer text is cut to fit, visibly, and counted so the person is told. */
export const EXCEL_CELL_MAX = 32767;
/**
 * Nothing that goes into a cell of the Q&A log or the findings export may be longer than one Excel cell holds, so an
 * export is always whole and comes back unchanged. One rule, checked by the store before anything is
 * saved (see `overLimit`). Typing stops there; the model is told the limit and asked to shorten text that runs over, and
 * only then is its text cut at a sentence (`fitText`, `fitParas`).
 */
export const TEXT_MAX = EXCEL_CELL_MAX;
/** what the model is told, well under the cell, so its text never has to be cut */
export const MODEL_TEXT_MAX = 30_000;
export const TOO_LONG = `Keep it to at most ${TEXT_MAX.toLocaleString('en-US')} characters, the most one Excel cell holds`;
/** the name of the first text in a question or finding that would not fit in its export cell, or null */
export function overLimit(kind: string, r: Record<string, unknown>): string | null {
  if (kind !== 'question' && kind !== 'finding') return null;
  for (const [k, v] of Object.entries(r)) if (typeof v === 'string' && v.length > TEXT_MAX) return k;
  if (kind === 'finding' && Array.isArray(r.body) && r.body.join('\n\n').length > TEXT_MAX) return 'detail';   // the paragraphs share one cell
  return null;
}
/** the note that ends text cut to fit one cell, so a cut is never silent */
const CUT_NOTE = ' … [cut: longer than Excel allows in one cell]';
/** the cut note as a paragraph of its own, dropping the last whole paragraphs if the note would not fit after them */
function noteParagraph(kept: string[]): string[] {
  while (kept.length && kept.join('\n\n').length + 2 + CUT_NOTE.length > TEXT_MAX) kept.pop();
  return [CUT_NOTE.trim()];
}
/**
 * A model's paragraphs cut to fit one cell together: whole paragraphs while they fit; the paragraph that does not fit is
 * cut at a sentence and ends with the cut note; with no room for that, the note is a paragraph of its own.
 */
export function fitParas(paras: string[]): string[] {
  const out: string[] = []; let used = 0;
  for (const p of paras) {
    const room = TEXT_MAX - used - (out.length ? 2 : 0);
    if (p.length <= room) { out.push(p); used += p.length + (out.length > 1 ? 2 : 0); continue; }
    if (room > 200) out.push(fitText(p, room)); else out.push(...noteParagraph(out));
    break;
  }
  return out;
}
/** a model's text cut to fit, at the last sentence end before the limit (or the limit itself), ending with the cut note */
export function fitText(text: string, max = TEXT_MAX): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - CUT_NOTE.length); const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'));
  return `${end > head.length / 2 ? head.slice(0, end + 1) : head}${CUT_NOTE}`;
}
export function fitCells(table: (string | number)[][]): { table: (string | number)[][]; cut: number } {
  let cut = 0;
  const out = table.map((row) => row.map((c) => { if (typeof c !== 'string' || c.length <= EXCEL_CELL_MAX) return c; cut++; return c.slice(0, EXCEL_CELL_MAX - CUT_NOTE.length) + CUT_NOTE; }));
  return { table: out, cut };
}
