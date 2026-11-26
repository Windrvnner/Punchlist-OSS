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
 * Rows are lined up by their question's words and, among rows that read alike, by their other cells; a row whose words
 * they changed by where it is among the rows lined up around it and its other cells (lineUp). Columns are lined up by their headings; one added since the version they edited counts as empty there. Pure: the tables are as the
 * import reads them (tableFrom), and steps count rows and columns from 0 on the log's sheet.
 */
import type { SheetEdit } from './sheets';

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
/** a question's words as rows are lined up by them */
const words = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

/** the columns other than the question's that two tables both have: each column's place in either's rows */
type Pairs = { a: number; b: number }[];
/**
 * how far two rows agree in those columns: cells both have and that say the same, and cells both have that differ; a cell of
 * the second row that `worked(col)` says holds a formula says nothing of which row it is, and is left out
 */
const agree = (x: string[], y: string[], pairs: Pairs, worked: (col: number) => boolean = () => false) => { let same = 0, differ = 0; for (const p of pairs) { const u = (x[p.a] ?? '').trim(), v = (y[p.b] ?? '').trim(); if (u && v && !worked(p.b)) { if (u === v) same++; else differ++; } } return { same, differ }; };

/**
 * Which row of `x` stands for each row of `base` (-1: none). A row with the same words: the only one, when only one row of
 * each reads so; otherwise (a question asked by several parties, say) the one that agrees with it in the most other cells
 * (number, Submitted by) more than it differs, never one under another number, and none when two agree as well. Then, for a row whose words were changed, the row at its place
 * between the rows lined up above and below it, when as many rows lie between those on both sides and both carry the same
 * question number (none without a number column), as long as that row's words are new (not another row's of `base`), it is not
 * taken, and it agrees with it in another cell (its number, say) more than it differs. In doubt, none: a row not lined up
 * is never written into.
 */
function lineUp(base: string[][], bt: number, x: string[][], xt: number, pairs: Pairs, worked: (row: number, col: number) => boolean, num?: { a: number; b: number }, who?: { a: number; b: number }, byPlace = true): number[] {
  /**
   * another party's row, whatever the cells all parties share say: Submitted by not the same, a blank one against a filled one
   * included (a row given a submitter since may be another party's; their edits to it are then counted, not written)
   */
  const by = (r: string[], c: number) => (r[c] ?? '').trim();
  const other = (r: string[], y: string[]) => !!who && by(r, who.a) !== by(y, who.b);
  /** a cell that tells the row apart, filled in both and the same: its number, or who submitted it */
  const known = (r: string[], y: string[]) => (!!num && !!by(r, num.a) && by(r, num.a) === by(y, num.b)) || (!!who && !!by(r, who.a) && by(r, who.a) === by(y, who.b));
  const at = new Map<string, number[]>(); x.forEach((r, i) => { const w = words(r[xt]); if (w) { const l = at.get(w); if (l) l.push(i); else at.set(w, [i]); } });
  const many = new Map<string, number>(); for (const r of base) { const w = words(r[bt]); if (w) many.set(w, (many.get(w) ?? 0) + 1); }
  const taken = new Uint8Array(x.length); const out = new Array<number>(base.length).fill(-1);
  base.forEach((r, i) => {
    const w = words(r[bt]); const l = at.get(w)?.filter((j) => !taken[j] && !other(r, x[j])); if (!l?.length) return;
    let pick = -1; const no = num ? (r[num.a] ?? '').trim() : '';
    // never one under another question number, nor one that differs from it more than it agrees: the row it stands for may
    // have been taken out, and the one left another party's (a duplicate asked since, say)
    if (l.length === 1 && many.get(w) === 1 && (at.get(w)?.length ?? 0) === 1) {   // (another party's row never gets this far)
      const xn = num ? (x[l[0]][num.b] ?? '').trim() : ''; const g = agree(r, x[l[0]], pairs, (c) => worked(l[0], c));
      if (no && xn ? no === xn : g.differ === 0 || g.same > g.differ) pick = l[0];   // the same number settles it
    } else {
      // never one under another number; and in the log (not their version, made from this one), among rows that read alike,
      // only one that a number or Submitted by shows is the same row, where it has either: the other cells all parties share
      // (Workstream, Status) can't tell another party's from it
      // In the log, a row whose number is another's (filled on one side only, too) or that differs in any cell is not taken
      // either: which of the rows that read alike it is goes to the person (KeptAsk)
      const xno = (j: number) => (num ? (x[j][num.b] ?? '').trim() : '');
      const scored = l.filter((j) => (byPlace ? !no || !xno(j) || xno(j) === no : xno(j) === no) && (byPlace || !(num || who) || known(r, x[j])))
        .map((j) => { const g = agree(r, x[j], pairs, (c) => worked(j, c)); return { j, s: g.same, d: g.differ }; }).filter((p) => p.s > p.d && (byPlace || p.d === 0)).sort((p, q) => q.s - p.s);
      if (scored.length && (scored.length === 1 || scored[1].s < scored[0].s)) pick = scored[0].j;
    }
    if (pick >= 0) { taken[pick] = 1; out[i] = pick; }
  });
  // By place: only between two rows lined up by their words with as many rows between them on both sides, so a row put in
  // or taken out near it never shifts one onto another (a new row put in just above a reworded one)
  const fixedAt = out.map((j, i) => (j >= 0 ? i : -1)).filter((i) => i >= 0); let k = 0;
  base.forEach((r, i) => {
    if (out[i] >= 0) return;
    while (k < fixedAt.length && fixedAt[k] < i) k++;
    const p = k > 0 ? fixedAt[k - 1] : -1, n = k < fixedAt.length ? fixedAt[k] : base.length;
    const xp = p >= 0 ? out[p] : -1, xn = n < base.length ? out[n] : x.length;
    if (xn - xp !== n - p) return;
    const j = xp + (i - p); if (!byPlace || !num || j < 0 || j >= x.length || taken[j] || many.has(words(x[j][xt]))) return;
    // and only when both carry the same question number: other cells alike (Submitted by, Status) can't tell a new row from it
    const no = (r[num.a] ?? '').trim(); if (!no || no !== (x[j][num.b] ?? '').trim() || other(r, x[j])) return;
    const g = agree(r, x[j], pairs, (c) => worked(j, c)); if (g.same === 0 || g.same <= g.differ) return;
    taken[j] = 1; out[i] = j;
  });
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
  const others = both.filter((c) => c.b >= 0 && c.k !== kt);                          // what rows are lined up by: the version they edited has them
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
  const ks = lineUp(base.rows, bt, kept.rows, kt, others.map((c) => ({ a: c.b, b: c.k })), keptWorked, nb >= 0 && nkk >= 0 ? { a: nb, b: nkk } : undefined, bb >= 0 && bkk >= 0 ? { a: bb, b: bkk } : undefined);
  // by place only on their side: a row they reworded is theirs to change; one the log changed in its place may be another question
  const ls = lineUp(base.rows, bt, log.rows, lt, others.map((c) => ({ a: c.b, b: c.l })), logWorked, nb >= 0 && nll >= 0 ? { a: nb, b: nll } : undefined, bb >= 0 && bll >= 0 ? { a: bb, b: bll } : undefined, false);
  const clash = new Set<number>(); const used = new Uint8Array(kept.rows.length); const written = new Map<string, string>();   // the cells written, by "row,col"
  // Rows of the version they edited that read alike (a question asked twice): where nothing tells which is which, the
  // person says where their edit goes (`asks`, made into KeptAsk below)
  const baseBy = new Map<string, number[]>(); base.rows.forEach((r, i) => { const w = words(r[bt]); if (!w) return; const at = baseBy.get(w); if (at) at.push(i); else baseBy.set(w, [i]); });
  const alike = (w: string) => (baseBy.get(w)?.length ?? 0) > 1;
  const asks: { j: number; b?: number }[] = []; const told = new Set<number>();   // rows of the version they edited an ask, or their row as it was, accounts for
  base.rows.forEach((br, i) => {
    const k = ks[i], l = ls[i]; if (k >= 0) used[k] = 1;
    if (k >= 0 && l < 0 && alike(words(br[bt]))) { asks.push({ j: k, b: i }); told.add(i); return; }   // the log's rows that read so can't be told apart
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
  // Rows they added. One the log has already (theirs saved again) is the log's row of the same words and the same number,
  // or, with no number, one whose every cell both have agrees: what they filled in that the log's row lacks goes into it,
  // and a cell both filled in differently is a clash, the log's stays. Any other is added: another party asking a question
  // the log has is a row of its own.
  const lp = both.filter((c) => c.k !== kt).map((c) => ({ a: c.k, b: c.l, l: c.l })); const nl = number ? log.columns.indexOf(number) : -1; const nk = nl >= 0 ? kk.indexOf(kl[nl]) : -1;
  const byWords = new Map<string, number[]>(); log.rows.forEach((x, l) => { const w = words(x[lt]); if (!w) return; const at = byWords.get(w); if (at) at.push(l); else byWords.set(w, [l]); });   // a row with no question (a heading, a note) is never the same as another
  // never a row that asks what a row of the version they edited asks, lined up or not: it may be that row, another party's
  const fresh: number[] = []; const baseWords = new Set(base.rows.map((r) => words(r[bt])).filter(Boolean));
  // where the log has a number or Submitted by column, only a row the cells it fills in show to be the same (as lineUp)
  const tells = (r: string[], y: string[]) => !(nk >= 0 || bkk >= 0) || (nk >= 0 && nl >= 0 && !!(r[nk] ?? '').trim() && (r[nk] ?? '').trim() === (y[nl] ?? '').trim()) || (bkk >= 0 && bll >= 0 && !!(r[bkk] ?? '').trim() && (r[bkk] ?? '').trim() === (y[bll] ?? '').trim());
  // Their rows that read like several of the version they edited and were not lined up: each against the rows of the version
  // they edited not lined up either, in order when as many are left on both sides; one as it was needs nothing, any other
  // is asked about
  for (const [w, bi] of baseBy) {
    if (bi.length < 2) continue;
    const free = bi.filter((i) => ks[i] < 0); const kj = kept.rows.map((_, j) => j).filter((j) => !used[j] && words(kept.rows[j][kt]) === w); if (!kj.length) continue;
    const asWas = (j: number, i: number) => kk.every((k, c) => { const b = kb.indexOf(k); return (kept.rows[j][c] ?? '') === (b >= 0 ? base.rows[i][b] ?? '' : ''); });
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
    const r = kept.rows[a.j]; const w = words(r[kt]);
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
  for (const a of asks) ask(a);
  // the words of rows of the version they edited that their version no longer lines up: one of theirs added at the end with
  // those words is likely that row changed (closed, answered) and can't be told from a new one, so it is counted
  const unlined = new Set(base.rows.filter((_, i) => ks[i] < 0 && !told.has(i)).map((r) => words(r[bt])).filter(Boolean));
  // and any row their version doesn't line up (one they reworded, or one of several that read alike): a row they added may
  // be it, so any such addition is counted too
  const reworded = base.rows.some((r, i) => ks[i] < 0 && !told.has(i) && words(r[bt]));
  kept.rows.forEach((r, j) => {
    if (used[j] || !r.some((v) => v.trim())) return;
    const n = nk >= 0 ? (r[nk] ?? '').trim() : '';
    // a row they added is only ever one the log added too (theirs saved again), never a row of the version they edited
    const mine = bkk >= 0 ? (r[bkk] ?? '').trim() : ''; const theirsBy = (l: number) => (bll >= 0 ? (log.rows[l][bll] ?? '').trim() : '');
    const may = (byWords.get(words(r[kt])) ?? []).filter((l) => !baseWords.has(words(log.rows[l][lt])) && mine === theirsBy(l) && tells(r, log.rows[l])).filter((l) => {
      const ln = nl >= 0 ? (log.rows[l][nl] ?? '').trim() : '';
      return n && ln ? n === ln : agree(r, log.rows[l], lp, (c) => logWorked(l, c)).differ === 0;
    });
    // A row the log has with the same words that holds all it has (a row of the version they edited they left as it was,
    // their row saved again) needs nothing; otherwise, with several that may be it, it is added, never written into one
    // that may be another party's.
    // as the log will be, with what is written above
    const holdsAsWritten = (l: number) => lp.every((p) => {
      const will = written.get(`${log.lines[l] - 1},${log.cols[p.l]}`) ?? log.rows[l][p.b] ?? '';
      return !(r[p.a] ?? '').trim() || (r[p.a] ?? '') === will;
    });
    const wholly = kk.every((_, c) => goes.has(c) || !(r[c] ?? '').trim());
    if (wholly && (byWords.get(words(r[kt])) ?? []).some(holdsAsWritten)) return;
    const same = may.length === 1 ? may[0] : undefined;
    lost(j, undefined);
    // a formula they put in a row they added is never written: counted, unless the log's row holds one there too (saved again)
    for (const p of lp) if (keptWorked(j, p.a) && (r[p.a] ?? '').trim() && (same === undefined || !logWorked(same, p.b))) out.left++;
    // Added while a row of the version they edited is not lined up in theirs (one they reworded, say): it may be that row,
    // so the person says, among the log's rows for those (a few at most), or it is added and counted
    if (same === undefined && (unlined.has(words(r[kt])) || reworded)) {
      const maybe = base.rows.map((_, i) => (ks[i] < 0 && !told.has(i) ? ls[i] : -1)).filter((l) => l >= 0 && (bkk < 0 || bll < 0 || mine === theirsBy(l)));
      if (maybe.length && maybe.length <= 5) { used[j] = 1; ask({ j }, maybe, true); return; }
    }
    if (same === undefined) { fresh.push(j); if (unlined.has(words(r[kt])) || reworded) out.left++; return; }
    for (const p of lp) {
      const row = log.lines[same] - 1, col = log.cols[p.l]; const v = r[p.a] ?? '', had = written.get(`${row},${col}`);
      if (!v.trim() || keptWorked(j, p.a)) continue;
      // they gave this cell already (cleared, it may be)
      if (had !== undefined) { if (v !== had) clash.add(same); continue; }
      const now = log.rows[same][p.b] ?? ''; if (v === now) continue;
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
