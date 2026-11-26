/**
 * An edit kept aside: someone saved the Q&A log in the moment before an update moved it aside, a new file took the
 * log's name meanwhile, and the archive refused a copy of their version, so it stayed in the log's folder under the save's
 * working name. The next update brings it back into the log: a three-way merge, cell by cell, of `kept` (their version)
 * against `base` (the version they edited, which the update put in the archive) into `log` (the log as it is now).
 *
 * - A cell they changed that the log still has as it was takes their value.
 * - A cell the log already has as they wrote it needs nothing.
 * - A cell both changed, each their own way, keeps the log's value and is reported (`clashes`); their version stays in the
 *   archive, so nothing is lost.
 * - A row they added that the log lacks goes at the end of the log, as an update adds questions.
 * - Nothing is ever taken out of the log: a row they removed stays, as does a row only the log has.
 *
 * Rows are lined up by the one Q&A row lookup (lineUp, docs/decisions.md): the same number, text as the file holds it
 * and sender, else the same text and sender. Where the lookup can't tell rows apart, the person places their edit
 * (KeptAsk); a row it places nowhere is never written into. Columns are lined up by their headings; one added since the
 * version they edited counts as empty there. Pure: the tables are as the
 * import reads them (tableFrom), and steps count rows and columns from 0 on the log's sheet.
 */
import type { SheetEdit } from './sheets';
import { formKeys, matchQuestions, type MatchRow } from './qaMatch';
import { numberParts } from './logWrite';

export type KeptTable = { columns: string[]; cols: number[]; rows: string[][]; lines: number[]; lastRow: number };
export interface KeptMerge {
  /** the steps that bring their cells and rows into the log, in order */
  steps: SheetEdit[];
  /** rows of `log` (indexes into its `rows`) with a cell both changed: the log's value stays there */
  clashes: number[];
  /** cells taken from their version, and rows added from it */
  cells: number; added: number;
  /**
   * cells they changed that are neither brought in nor reported as a clash: in a row the log took out, or in a column the
   * log lacks or that can't be told apart (or every change, when the question column can't be lined up). Their version in the archive still has them.
   */
  left: number;
  /** their rows that may be any of several rows that read alike, with nothing to tell which: the person picks */
  ask: KeptAsk[];
}
/**
 * One of their rows that reads like several of the log's, with nothing to tell which it is (a question asked twice, by
 * nobody named): the person says where it goes. Each choice comes worked out; none is taken unasked.
 */
export interface KeptAsk {
  /** the question's words */
  question: string;
  /** the columns they changed, and those the rows differ in, as the log heads them: their value, and each row's in `rows` order */
  cells: { heading: string; theirs: string; rows: string[]; changed: boolean }[];
  /** the log's rows it may be (an index into the log's rows, and its line on the sheet), each with the steps that bring their edit in there, and whether a cell both changed keeps the log's value */
  rows: { row: number; line: number; steps: SheetEdit[]; clash: boolean }[];
  /** or a row of its own below the last: its cells, by column on the sheet */
  add: { col: number; value: string }[];
}

/** a column's key: its heading, spacing and case aside, and which of the columns so headed it is */
const keys = (columns: string[]) => { const seen = new Map<string, number>(); return columns.map((c) => { const h = c.replace(/\s+/g, ' ').trim().toLowerCase(); const k = (seen.get(h) ?? 0) + 1; seen.set(h, k); return `${h}#${k}`; }); };
/** a row that asks a question: a heading or a blank line stands for none, as the log update reads it (logWrite.ts) */
const hasQuestion = (r: string[], text: number) => (r[text] ?? '').trim() !== '';

/**
 * A table's rows by their question, exactly as written. A row with no question (a heading, a note) is never the same
 * as another.
 */
function byQuestion(rows: string[][], text: number): Map<string, number[]> {
  const at = new Map<string, number[]>();
  for (const [i, r] of rows.entries()) {
    if (!hasQuestion(r, text)) continue;
    const list = at.get(r[text]);
    if (list) list.push(i);
    else at.set(r[text], [i]);
  }
  return at;
}

/** the columns of a table the lookup reads: the question's, and the number's and Submitted by's where it has them */
type LookupCols = { text: number; n?: number; by?: number };
/** a row as the lookup reads it: its number as the log update reads it ("Q4", "4."), its question and its sender */
const lookupRow = (r: string[], c: LookupCols): MatchRow => ({
  n: c.n === undefined ? null : numberParts(r[c.n] ?? '')?.n ?? null,
  text: r[c.text] ?? '',
  askedBy: c.by === undefined ? '' : r[c.by] ?? '',
});
/**
 * The columns of two tables the lookup reads: a number or Submitted by column only where both have it (`-1`: one
 * lacks it), so a row is never told from another by a column one side doesn't have.
 */
function lookupCols(text: [number, number], n: [number, number], by: [number, number]): [LookupCols, LookupCols] {
  const both = (c: [number, number], side: 0 | 1) => (c[0] >= 0 && c[1] >= 0 ? c[side] : undefined);
  const side = (s: 0 | 1) => ({ text: text[s], n: both(n, s), by: both(by, s) });
  return [side(0), side(1)];
}
/** a row's keys for the lookup's identity: its text forms, each with its sender and number */
const identityKeys = (row: MatchRow) => formKeys(row.text)
  .map((form) => `${form}\u0000${row.askedBy.trim()}\u0000${row.n ?? ''}`);
/**
 * Rows another row of the list has the same number, text (as the file holds it) and sender as: the lookup can't tell
 * them apart.
 */
function lookalikes(rows: MatchRow[]): boolean[] {
  const count = new Map<string, number>();
  for (const row of rows) for (const key of identityKeys(row)) count.set(key, (count.get(key) ?? 0) + 1);
  return rows.map((row) => identityKeys(row).some((key) => (count.get(key) ?? 0) > 1));
}

/** how many of `rows` (by index in `at`) have each text form */
function formCounts(rows: MatchRow[], at: number[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const k of at) for (const key of formKeys(rows[k].text)) count.set(key, (count.get(key) ?? 0) + 1);
  return count;
}

/** Rows lined up (`out`, -1: none), and rows of `base` whose row is unclear, with the rows of `x` it may be */
type LinedUp = { out: number[]; unclear: Map<number, number[]> };
/**
 * Which row of `x` stands for each row of `base`, by the one Q&A row lookup (`matchQuestions`, docs/decisions.md): the
 * same number, text and sender, else the same text and sender; a row naming no sender matches any, the same sender
 * first. `onlyBase` and `onlyX` narrow the rows looked at. Where its row is unclear, the person places it (KeptAsk,
 * decisions.md:114), so it is lined up with none and listed in `unclear` (#1111): a row of `x` that another of its
 * table has the same number, text and sender as, or a match across senders (one names none) while another row with
 * that text is left over. A row of `base` that another of its own has the same identity as is lined up with none
 * (the caller asks about rows of `base` that read alike). A row not lined up is never written into.
 */
function lineUp(base: string[][], bc: LookupCols, x: string[][], xc: LookupCols,
  onlyBase: (i: number) => boolean = () => true, onlyX: (j: number) => boolean = () => true): LinedUp {
  const at = base.flatMap((r, i) => (hasQuestion(r, bc.text) && onlyBase(i) ? [i] : []));
  const xAt = x.flatMap((r, j) => (hasQuestion(r, xc.text) && onlyX(j) ? [j] : []));
  const rows = at.map((i) => lookupRow(base[i], bc));
  const xRows = xAt.map((j) => lookupRow(x[j], xc));
  const alike = lookalikes(rows);
  const xAlike = lookalikes(xRows);
  const matched = matchQuestions(xRows, [rows.map((row, b) => ({ ...row, id: String(b) }))]);
  const pairs = [...matched].map(([k, id]) => [k, Number(id)] as const);
  const takenX = new Set(pairs.map(([k]) => k));
  const takenB = new Set(pairs.map(([, b]) => b));
  const freeX = formCounts(xRows, xRows.map((_, k) => k).filter((k) => !takenX.has(k)));
  const freeB = formCounts(rows, rows.map((_, b) => b).filter((b) => !takenB.has(b)));
  const out: LinedUp = { out: new Array<number>(base.length).fill(-1), unclear: new Map() };
  for (const [k, b] of pairs) {
    if (alike[b]) continue;
    const others = otherCandidates(rows[b], xRows, k, xAlike[k], freeX, freeB, takenX);
    if (others) out.unclear.set(at[b], [k, ...others].sort((p, q) => p - q).map((c) => xAt[c]));
    else out.out[at[b]] = xAt[k];
  }
  return out;
}
/**
 * The other rows of `x` (by index in `xRows`) the row of `base` matched with `k` may be, or null when its row is clear
 * (#1111): those with the same identity as `k`, or, for a match across senders while another row with that text
 * is left over on either side, the left-over rows of `x` with its text.
 */
function otherCandidates(row: MatchRow, xRows: MatchRow[], k: number, xAlike: boolean,
  freeX: Map<string, number>, freeB: Map<string, number>, takenX: Set<number>): number[] | null {
  if (xAlike) {
    const keys = new Set(identityKeys(xRows[k]));
    return xRows.flatMap((r, c) => (c !== k && identityKeys(r).some((key) => keys.has(key)) ? [c] : []));
  }
  if (row.askedBy.trim() === xRows[k].askedBy.trim()) return null;
  const forms = formKeys(xRows[k].text);
  if (!forms.some((key) => freeX.has(key) || freeB.has(key))) return null;
  const sameText = (r: MatchRow) => formKeys(r.text).some((key) => forms.includes(key));
  return xRows.flatMap((r, c) => (c !== k && !takenX.has(c) && sameText(r) ? [c] : []));
}

/** each table's question column, and the number's and Submitted by's of theirs and the log's (-1: none) */
type MergeCols = { bt: number; kt: number; lt: number; n: [number, number]; by: [number, number] };
/**
 * Their rows not lined up yet (`unused`: added) that the log added too (theirs saved again): by their row, the log's
 * row the one lookup finds (-1: none). Never a row that asks what a row of the version they edited asks, lined up or
 * not: it may be that row, or another party's.
 */
function addedByLog(base: KeptTable, kept: KeptTable, log: KeptTable, c: MergeCols, unused: (j: number) => boolean) {
  const baseTexts = new Set(base.rows.flatMap((r) => (hasQuestion(r, c.bt) ? formKeys(r[c.bt]) : [])));
  const askedBefore = (l: number) => formKeys(log.rows[l][c.lt] ?? '').some((key) => baseTexts.has(key));
  const [keptCols, logCols] = lookupCols([c.kt, c.lt], c.n, c.by);
  return lineUp(kept.rows, keptCols, log.rows, logCols, unused, (l) => !askedBefore(l));
}
/**
 * Their rows with no question (a heading) that hold every cell as one of the version they edited does (`asWas(j, i)`),
 * each row of that version standing for one of theirs: the lookup places no such row, and it is not a row they added,
 * so it is not added again. A copy they added has no row left to stand for it, so it is added (#1111).
 */
function unchangedHeadings(kept: string[][], kt: number, base: string[][], bt: number,
  asWas: (j: number, i: number) => boolean): Set<number> {
  const heading = (r: string[], text: number) => !hasQuestion(r, text) && r.some((v) => v.trim());
  const free = base.flatMap((r, i) => (heading(r, bt) ? [i] : []));
  const out = new Set<number>();
  for (const [j, r] of kept.entries()) {
    if (!heading(r, kt)) continue;
    const at = free.findIndex((i) => asWas(j, i));
    if (at < 0) continue;
    free.splice(at, 1);
    out.add(j);
  }
  return out;
}

/** a cell step with a value as it was read: a plain number as a number, a date (as a date cell reads, YYYY-MM-DD) as a date, anything else as its text (the update makes a row of its own an ask places with it too) */
export const cell = (row: number, col: number, s: string): SheetEdit =>
  /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/.test(s) && String(Number(s)) === s ? { kind: 'cell', row, col, value: Number(s) } : /^\d{4}-\d{2}-\d{2}$/.test(s) ? { kind: 'cell', row, col, value: s, date: true } : { kind: 'cell', row, col, value: s };

/**
 * Their edit (`kept`, made from `base`) brought into `log`. `text`: the heading of the question column, as `log` has it.
 * `fixed(row, col)`: a cell of the log's sheet that must not be written (a formula, a cell under a merge); one they changed
 * counts as both changed. `formula(row, col)`: a cell of their sheet that holds a formula (its text, or true), whose value is never taken for
 * their change, nor written into a row they added. `number`: the heading of the question number column, if the log has one;
 * `by`: of Submitted by. `baseFormula`: as `formula`, for the version they edited.
 */
export function mergeKept(base: KeptTable, kept: KeptTable, log: KeptTable, text: string, fixed: (row: number, col: number) => boolean = () => false, formula: (row: number, col: number) => string | boolean = () => false, number = '', baseFormula?: (row: number, col: number) => string | boolean, by = ''): KeptMerge {
  const out: KeptMerge = { steps: [], clashes: [], cells: 0, added: 0, left: 0, ask: [] };
  const kb = keys(base.columns), kk = keys(kept.columns), kl = keys(log.columns);
  const tk = kl[log.columns.indexOf(text)]; const bt = kb.indexOf(tk), kt = kk.indexOf(tk), lt = kl.indexOf(tk);
  // no question column in common: nothing can be lined up, so whatever they changed is left out
  if (!tk || bt < 0 || kt < 0 || lt < 0) { out.left = JSON.stringify([kept.columns, kept.rows]) === JSON.stringify([base.columns, base.rows]) ? 0 : 1; return out; }
  // The columns they and the log have, by where each is in its table's rows (`b`: in the version they edited, -1 for one
  // added since, which counts as empty there). A heading the three have a different number of (a second "Note" put in) is
  // left out: which of them is which can't be told.
  const head = (k: string) => k.slice(0, k.lastIndexOf('#')); const many = (ks: string[], h: string) => ks.filter((k) => head(k) === h).length;
  const sure = (k: string) => { const h = head(k), n = many(kk, h); return n === many(kl, h) && (n === many(kb, h) || (n === 1 && !many(kb, h))); };
  const both = kk.map((k, c) => ({ k: c, b: kb.indexOf(k), l: kl.indexOf(k) })).filter((c) => c.l >= 0 && (c.k === kt || sure(kk[c.k])));
  const goes = new Set(both.map((c) => c.k));
  const keptWorked = (j: number, c: number) => !!formula(kept.lines[j] - 1, kept.cols[c]), logWorked = (j: number, c: number) => fixed(log.lines[j] - 1, log.cols[c]);
  /**
   * a formula in their cell that they put there: one in a row they added (`i` undefined) or in a column added since, or
   * one the version they edited (row `i`) did not hold; never written, so counted as not brought in. Without the version's
   * formulas (`baseFormula`), a formula is taken to have been there (its value only moved on: days outstanding).
   */
  const typed = (j: number, c: number, i?: number) => {
    const f = formula(kept.lines[j] - 1, kept.cols[c]); if (!f) return false; if (i === undefined) return true;
    const b = kb.indexOf(kk[c]); if (b < 0) return true; if (!baseFormula) return false;
    const bf = baseFormula(base.lines[i] - 1, base.cols[b]); return typeof f === 'string' ? f !== bf : !bf;
  };
  /** their cells of row `j` (made from row `i` of the version they edited, if any) that differ from it and have nowhere to go: all of them (a row the log took out), or those in a column not merged */
  const lost = (j: number, i: number | undefined, all = false) => kk.forEach((k, c) => {
    if (!all && goes.has(c)) return; const b = kb.indexOf(k); const was = i !== undefined && b >= 0 ? base.rows[i][b] ?? '' : '';
    if (keptWorked(j, c) ? typed(j, c, i) : (kept.rows[j][c] ?? '') !== was) out.left++;
  });
  const nkey = number ? kl[log.columns.indexOf(number)] : undefined; const nb = nkey ? kb.indexOf(nkey) : -1, nkk = nkey ? kk.indexOf(nkey) : -1, nll = nkey ? kl.indexOf(nkey) : -1;
  const bkey = by ? kl[log.columns.indexOf(by)] : undefined; const bb = bkey ? kb.indexOf(bkey) : -1, bkk = bkey ? kk.indexOf(bkey) : -1, bll = bkey ? kl.indexOf(bkey) : -1;
  const [baseForKept, keptCols] = lookupCols([bt, kt], [nb, nkk], [bb, bkk]);
  const ks = lineUp(base.rows, baseForKept, kept.rows, keptCols).out;
  const [baseForLog, logCols] = lookupCols([bt, lt], [nb, nll], [bb, bll]);
  const { out: ls, unclear } = lineUp(base.rows, baseForLog, log.rows, logCols);
  const clash = new Set<number>(); const used = new Uint8Array(kept.rows.length); const written = new Map<string, string>();   // the cells written, by "row,col"
  // Rows of the version they edited that read alike (a question asked twice): where nothing tells which is which, the
  // person says where their edit goes (`asks`, made into KeptAsk below)
  const baseBy = byQuestion(base.rows, bt);
  const alike = (w: string) => (baseBy.get(w)?.length ?? 0) > 1;
  // their rows to ask about (`only`: the log's rows they may be, when the lookup found them)
  const asks: { j: number; b?: number; only?: number[] }[] = [];
  const told = new Set<number>();   // rows of the version they edited an ask, or their row as it was, accounts for
  base.rows.forEach((br, i) => {
    const k = ks[i], l = ls[i]; if (k >= 0) used[k] = 1;
    // the log's rows that ask it can't be told apart
    if (k >= 0 && l < 0 && (alike(br[bt]) || unclear.has(i))) {
      asks.push({ j: k, b: i, only: unclear.get(i) });
      told.add(i);
      return;
    }
    if (k < 0 || l < 0) { if (k >= 0) lost(k, i, true); return; }                      // a row they or the log took out: nothing to bring in
    lost(k, i);
    for (const c of both) {
      if (keptWorked(k, c.k)) { if (typed(k, c.k, i)) out.left++; continue; }   // a formula's value is not theirs to bring, nor is a formula written
      const was = c.b >= 0 ? br[c.b] ?? '' : '', theirs = kept.rows[k][c.k] ?? '', now = log.rows[l][c.l] ?? '';
      if (theirs === was || now === theirs) continue;
      const row = log.lines[l] - 1, col = log.cols[c.l];
      if (now === was && !fixed(row, col)) { out.steps.push(cell(row, col, theirs)); out.cells++; written.set(`${row},${col}`, theirs); }
      else clash.add(l);
    }
  });
  // Rows they added. One the log has already (theirs saved again) is the log's row the same lookup finds for it: what
  // they filled in that the log's row lacks goes into it, and a cell both filled in differently is a clash, the log's
  // stays. Any other is added.
  const lp = both.filter((c) => c.k !== kt).map((c) => ({ a: c.k, b: c.l, l: c.l }));
  const byWords = byQuestion(log.rows, lt);
  const fresh: number[] = [];
  /** their row `j` holds every cell as row `i` of the version they edited had it */
  const asWas = (j: number, i: number) => kk.every((k, c) => {
    const b = kb.indexOf(k);
    return (kept.rows[j][c] ?? '') === (b >= 0 ? base.rows[i][b] ?? '' : '');
  });
  // Their rows that read like several of the version they edited and were not lined up: each against the rows of the version
  // they edited not lined up either, in order when as many are left on both sides; one as it was needs nothing, any other
  // is asked about
  for (const [w, bi] of baseBy) {
    if (bi.length < 2) continue;
    const free = bi.filter((i) => ks[i] < 0);
    const kj = kept.rows.map((_, j) => j).filter((j) => !used[j] && (kept.rows[j][kt] ?? '') === w);
    if (!kj.length) continue;
    const rest = [...free]; const pairs: [number, number | undefined][] = free.length === kj.length ? kj.map((j, n) => [j, free[n]]) : kj.map((j) => { const n = rest.findIndex((i) => asWas(j, i)); return [j, n >= 0 ? rest.splice(n, 1)[0] : undefined]; });
    for (const [j, i] of pairs) { used[j] = 1; if (i !== undefined) told.add(i); if (i === undefined || !asWas(j, i)) asks.push({ j, b: i }); }
  }
  const cellsOf = (j: number) => kl.map((k, l) => ({ k: kk.indexOf(k), l })).filter((c) => goes.has(c.k) && !keptWorked(j, c.k)).map((c) => ({ col: log.cols[c.l], value: kept.rows[j][c.k] ?? '' })).filter((c) => c.value !== '');
  /**
   * Their row `a.j` (made from row `a.b` of the version they edited, when that is known) placed by the person: in one of
   * `rows` of the log (by default, those that read so, but another party's), as a row of its own, or left out. Each row
   * comes with what it would take: the cells they changed that the log still has as they were there (as the row of the
   * version they edited lined up with it had them), and whether a cell both changed keeps the log's value.
   */
  const ask = (a: { j: number; b?: number }, only?: number[], counted = false) => {
    const r = kept.rows[a.j]; const w = r[kt] ?? '';
    const was = (c: { b: number }, i = a.b) => (i !== undefined && c.b >= 0 ? base.rows[i][c.b] ?? '' : '');
    const mine = (c: { k: number; b: number }) => !keptWorked(a.j, c.k) && (a.b !== undefined ? (r[c.k] ?? '') !== was(c) : !!(r[c.k] ?? '').trim());
    const changed = both.filter((c) => mine(c));
    if (!counted) { for (const c of both) if (keptWorked(a.j, c.k) && typed(a.j, c.k, a.b)) out.left++; lost(a.j, a.b); }   // a formula is never written, wherever it goes
    if (!changed.length) return;                                                        // nothing of theirs to place
    const rows = only ?? (byWords.get(w) ?? []).filter((l) => bkk < 0 || bll < 0 || (r[bkk] ?? '').trim() === (log.rows[l][bll] ?? '').trim());
    const options = rows.map((l) => {
      const lb = ls.indexOf(l); const at = lb >= 0 ? lb : a.b; const steps: SheetEdit[] = []; let clashed = false;
      for (const c of changed) {
        const theirs = r[c.k] ?? '', row = log.lines[l] - 1, col = log.cols[c.l]; const had = written.get(`${row},${col}`); const now = had ?? log.rows[l][c.l] ?? '';
        if (now === theirs || (at !== undefined && theirs === was(c, at))) continue;    // as they wrote it already, or not changed from what that row had
        if (had === undefined && (at !== undefined ? now === was(c, at) : !now.trim()) && !fixed(row, col)) steps.push(cell(row, col, theirs)); else clashed = true;
      }
      return { row: l, line: log.lines[l], steps, clash: clashed };
    });
    if (a.b === undefined && options.some((o) => !o.steps.length && !o.clash)) return;  // a row they added that the log holds already (saved again)
    // what they changed that tells: a cell no row offered holds as they wrote it (the question, only when they changed its words)
    const shown = changed.filter((c) => (rows.length ? rows.some((l) => (log.rows[l][c.l] ?? '') !== (r[c.k] ?? '')) : c.k !== kt));
    const differ = both.filter((c) => c.k !== kt && !changed.includes(c) && new Set(rows.map((l) => (log.rows[l][c.l] ?? '').trim())).size > 1);
    out.ask.push({ question: r[kt] ?? '', cells: [...shown.map((c) => ({ c, changed: true })), ...differ.map((c) => ({ c, changed: false }))].sort((x, y) => x.c.l - y.c.l).map(({ c, changed: ch }) => ({ heading: log.columns[c.l], theirs: r[c.k] ?? '', rows: rows.map((l) => log.rows[l][c.l] ?? ''), changed: ch })), rows: options, add: cellsOf(a.j) });
  };
  for (const a of asks) ask(a, a.only);
  // the words of rows of the version they edited that their version no longer lines up: one of theirs added at the end with
  // those words is likely that row changed (closed, answered) and can't be told from a new one, so it is counted
  const unlined = new Set(base.rows.filter((r, i) => ks[i] < 0 && !told.has(i) && hasQuestion(r, bt))
    .map((r) => r[bt]));
  // and any row their version doesn't line up (one they reworded, or one of several that read alike): a row they added may
  // be it, so any such addition is counted too
  const reworded = base.rows.some((r, i) => ks[i] < 0 && !told.has(i) && hasQuestion(r, bt));
  const savedAgain = addedByLog(base, kept, log, { bt, kt, lt, n: [nkk, nll], by: [bkk, bll] }, (j) => !used[j]);
  /**
   * A row the log has with the same question that holds all their row has, as the log will be with what is written
   * above (a row of the version they edited they left as it was, their row saved again): it needs nothing.
   */
  const heldAlready = (r: string[]) => {
    if (!kk.every((_, c) => goes.has(c) || !(r[c] ?? '').trim())) return false;
    const now = (l: number, p: { b: number; l: number }) =>
      written.get(`${log.lines[l] - 1},${log.cols[p.l]}`) ?? log.rows[l][p.b] ?? '';
    const holds = (l: number) => lp.every((p) => !(r[p.a] ?? '').trim() || (r[p.a] ?? '').trim() === now(l, p).trim());
    return (byWords.get(r[kt] ?? '') ?? []).some(holds);
  };
  const headingsAsWere = unchangedHeadings(kept.rows, kt, base.rows, bt, asWas);
  kept.rows.forEach((r, j) => {
    if (used[j] || !r.some((v) => v.trim()) || headingsAsWere.has(j)) return;
    const mine = bkk >= 0 ? (r[bkk] ?? '').trim() : ''; const theirsBy = (l: number) => (bll >= 0 ? (log.rows[l][bll] ?? '').trim() : '');
    if (heldAlready(r)) return;
    const same = savedAgain.out[j] >= 0 ? savedAgain.out[j] : undefined;
    lost(j, undefined);
    // a formula they put in a row they added is never written: counted, unless the log's row holds one there too (saved again)
    for (const p of lp) if (keptWorked(j, p.a) && (r[p.a] ?? '').trim() && (same === undefined || !logWorked(same, p.b))) out.left++;
    // the log added it for several parties, or twice: which row it is goes to the person (decisions.md:114, #1111)
    const mayBe = savedAgain.unclear.get(j);
    if (mayBe) { used[j] = 1; ask({ j }, mayBe, true); return; }
    // Added while a row of the version they edited is not lined up in theirs (one they reworded, say): it may be that row,
    // so the person says, among the log's rows for those (a few at most), or it is added and counted
    if (same === undefined && (unlined.has(r[kt] ?? '') || reworded)) {
      const maybe = base.rows.map((_, i) => (ks[i] < 0 && !told.has(i) ? ls[i] : -1)).filter((l) => l >= 0 && (bkk < 0 || bll < 0 || mine === theirsBy(l)));
      if (maybe.length && maybe.length <= 5) { used[j] = 1; ask({ j }, maybe, true); return; }
    }
    if (same === undefined) { fresh.push(j); if (unlined.has(r[kt] ?? '') || reworded) out.left++; return; }
    for (const p of lp) {
      const row = log.lines[same] - 1, col = log.cols[p.l]; const v = r[p.a] ?? '', had = written.get(`${row},${col}`);
      if (!v.trim() || keptWorked(j, p.a)) continue;
      if (had !== undefined) { if (v.trim() !== had.trim()) clash.add(same); continue; }   // they gave this cell already (cleared, it may be)
      const now = log.rows[same][p.b] ?? ''; if (v.trim() === now.trim()) continue;
      if (!now.trim() && !fixed(row, col)) { out.steps.push(cell(row, col, v)); out.cells++; written.set(`${row},${col}`, v); } else clash.add(same);
    }
  });
  if (fresh.length) {
    const last = log.lastRow - 1;                                                       // below the last row the log uses, as an update adds questions
    out.steps.push({ kind: 'rows', after: last, count: fresh.length });
    const cols = kl.map((k, l) => ({ k: kk.indexOf(k), l })).map((c) => (goes.has(c.k) ? c : { k: -1, l: c.l }));
    fresh.forEach((j, i) => { const r = kept.rows[j]; for (const c of cols) { const v = c.k >= 0 && !keptWorked(j, c.k) ? r[c.k] ?? '' : ''; if (v !== '') out.steps.push(cell(last + 1 + i, log.cols[c.l], v)); } });
    out.added = fresh.length;
  }
  out.clashes = [...clash].sort((a, b) => a - b);
  return out;
}
