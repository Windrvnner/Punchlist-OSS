/**
 * Writing into an .xlsx or .xlsm by editing the package itself. Only the sheet written into is changed, and in
 * it only the rows given values; an Excel table whose last row is the one new rows go below grows to take them in.
 * Every other part (styles, tables' looks, macros, comments, other sheets) is copied byte for byte. LibreOffice, which
 * saves the whole workbook again, is kept for the formats this cannot open (.xls, .ods).
 */
import type { SheetEdit } from '../domain/sheets';
import { readZip, partText, setPart, writeZip, type ZipPackage } from './zipParts';

const unescapeXml = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** characters XML 1.0 cannot carry */
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;
/**
 * text as a cell holds it: characters XML 1.0 cannot carry go (as the reader's clean() drops them), and "_x0041_",
 * which Excel would read as the character it codes, is escaped so it reads back as typed
 */
const cellText = (text: string) => escapeXml(text.replace(NOT_XML, '').replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_'));
/** a row's start tag for a new row: nothing that hides it (a filter, a collapsed group) or fixes its height */
const shownRow = (open: string) =>
  open.replace(/\s(?:hidden|outlineLevel|collapsed|ht|customHeight|thickBot|thickTop)="[^"]*"/g, '');
const withoutSpans = (open: string) => open.replace(/\sspans="[^"]*"/, '');
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
/** column letters for a 0-based index, and back */
const letters = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : letters(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26));
const colOf = (ref: string) => {
  const columnLetters = [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')];
  return columnLetters.reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
};

type Range = { c0: number; c1: number; r0: number; r1: number };
/** the rows and columns a range such as "C3:D4" covers */
function span(ref: string): Range {
  const [first, last = first] = ref.split(':');
  const row = (cell: string) => Number(/\d+/.exec(cell)?.[0]);
  return { c0: colOf(first), c1: colOf(last), r0: row(first), r1: row(last) };
}
/** the merged ranges of a sheet */
const mergesOf = (xml: string) =>
  [...xml.matchAll(/<(?:\w+:)?mergeCell\b[^>]*\sref="([^"]*)"/g)].map((m) => span(m[1]));
/** whether a merge hides the cell (`row` counted from 1): every cell it covers but its first */
function hiddenByMerge(merge: Range, col: number, row: number): boolean {
  const inside = col >= merge.c0 && col <= merge.c1 && row >= merge.r0 && row <= merge.r1;
  return inside && (col !== merge.c0 || row !== merge.r0);
}

/** the prefix the file's writer put on the sheet's tags, if any ("x:", say) */
const prefixOf = (sheetXml: string) => /<(\w+:)?worksheet\b/.exec(sheetXml)?.[1] ?? '';
const rowTags = (xml: string, prefix: string) =>
  xml.matchAll(new RegExp(`<${prefix}row\\b[^>]*?(?:/>|>[\\s\\S]*?</${prefix}row>)`, 'g'));
const cellTags = (rowXml: string, prefix: string) =>
  rowXml.matchAll(new RegExp(`<${prefix}c\\b[^>]*?(?:/>|>[\\s\\S]*?</${prefix}c>)`, 'g'));
/** a tag's opening, up to (not including) its closing `>` or `/>` */
const openingOf = (tag: string) => /^<[^>]*?(?=\/?>)/.exec(tag)![0];
const holdsFormula = (cell: string, prefix: string) => new RegExp(`<${prefix}f\\b`).test(cell);

/** where a part named in a .rels file lives in the package */
function resolve(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const step of target.split('/')) {
    if (step === '..') parts.pop();
    else if (step !== '.') parts.push(step);
  }
  return parts.join('/');
}
const relsOf = (part: string) => {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
};
/** the targets of a part's relationships, by id */
function rels(zip: ZipPackage, part: string): Map<string, { type: string; target: string }> {
  const out = new Map<string, { type: string; target: string }>();
  for (const m of (partText(zip, relsOf(part)) ?? '').matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (!id || !target || attr(m[0], 'TargetMode') === 'External') continue;
    out.set(id, { type: attr(m[0], 'Type') ?? '', target: resolve(part, unescapeXml(target)) });
  }
  return out;
}

/** the part that holds the sheet named `sheet` */
function sheetPart(zip: ZipPackage, sheet: string): string {
  const workbook = partText(zip, 'xl/workbook.xml');
  if (workbook === null) throw new Error('the file has no workbook');
  for (const m of workbook.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    if (unescapeXml(attr(m[0], 'name') ?? '') !== sheet) continue;
    const id = /\sr:id="([^"]*)"/.exec(m[0])?.[1] ?? /\s\w+:id="([^"]*)"/.exec(m[0])?.[1];
    const target = id && rels(zip, 'xl/workbook.xml').get(id);
    if (target) return target.target;
  }
  throw new Error(`the file has no sheet named ${sheet}`);
}

interface Row { n: number; open: string; cells: Map<number, string>; changed: boolean; raw: string }

/** Excel's built-in date formats */
const BUILT_IN_DATES = [14, 15, 16, 17, 22];
const DAY_MS = 86400000;
interface DateStyles {
  isDate: (style: string | undefined) => boolean;
  serial: (ymd: string) => number;
}
/**
 * Which cell styles show a date, and how the workbook counts days. A style shows a date when its number format is one
 * of Excel's built-in date formats (14 to 17 and 22) or a format of its own with a day or year in it, once its quoted
 * text, bracketed parts ([Red], [$-409]) and escaped characters are left out.
 */
function dateStyles(zip: ZipPackage): DateStyles {
  const styles = [...rels(zip, 'xl/workbook.xml').values()].find((r) => r.type.endsWith('/styles'));
  const xml = (styles && partText(zip, styles.target)) ?? '';
  const ownFormats = new Map(
    [...xml.matchAll(/<(?:\w+:)?numFmt\b[^>]*>/g)].map(
      (m) => [Number(attr(m[0], 'numFmtId')), unescapeXml(attr(m[0], 'formatCode') ?? '')] as const,
    ),
  );
  const ownDate = (id: number) => {
    const code = ownFormats.get(id);
    return code !== undefined && /[dy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ''));
  };
  const dateFormat = (id: number) => BUILT_IN_DATES.includes(id) || ownDate(id);
  const cellXfs = /<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/.exec(xml)?.[1] ?? '';
  const formatOfStyle = [...cellXfs.matchAll(/<(?:\w+:)?xf\b[^>]*>/g)].map((m) => Number(attr(m[0], 'numFmtId') ?? 0));
  const workbook = partText(zip, 'xl/workbook.xml') ?? '';
  const in1904 = /<(?:\w+:)?workbookPr\b[^>]*\sdate1904="(?:1|true)"/.test(workbook);
  // what day 0 is: Excel's 1900 count is off by its Feb 29, 1900, so it starts a day early
  const day0 = in1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  return {
    isDate: (style) => style !== undefined && dateFormat(formatOfStyle[Number(style)] ?? 0),
    serial: (ymd) => {
      const [year, month, day] = ymd.split('-').map(Number);
      return (Date.UTC(year, month - 1, day) - day0) / DAY_MS;
    },
  };
}

/**
 * The sheet's rows, by number. A row or cell may leave out its number ("r"): it is then the one after the one before
 * it, as Excel reads it, and such a row is written out with its numbers.
 */
function readRows(sheetData: string, prefix: string): Map<number, Row> {
  const rows = new Map<number, Row>();
  let previous = 0;
  for (const m of rowTags(sheetData, prefix)) {
    let open = openingOf(m[0]);
    const n = Number(attr(open, 'r') ?? previous + 1);
    previous = n;
    let numbered = attr(open, 'r') !== undefined;
    if (!numbered) open = open.replace(new RegExp(`^<${prefix}row`), `<${prefix}row r="${n}"`);
    const cells = new Map<number, string>();
    let col = -1;
    for (const c of cellTags(m[0], prefix)) {
      const ref = attr(c[0], 'r');
      col = ref ? colOf(ref) : col + 1;
      if (!ref) numbered = false;
      cells.set(col, ref ? c[0] : c[0].replace(new RegExp(`^<${prefix}c`), `<${prefix}c r="${letters(col)}${n}"`));
    }
    rows.set(n, { n, open, cells, changed: !numbered, raw: m[0] });
  }
  return rows;
}

type Table = { type: string; target: string; xml: string | null };
/** a table that ends in a totals row: new questions would land below its total, and Excel would take them for it */
function refuseRowsBelowTotals(steps: SheetEdit[], tables: Table[]) {
  for (const step of steps) {
    if (step.kind !== 'rows') continue;
    for (const table of tables) {
      const ref = /\sref="([^"]*)"/.exec(table.xml ?? '')?.[1];
      if (!ref) continue;
      const totals = Number(attr(table.xml!, 'totalsRowCount') ?? 0) > 0;
      if (totals && span(ref).r1 === step.after + 1) {
        throw new Error('the table ends in a totals row, so new questions can’t go below it');
      }
    }
  }
}

/** New empty rows below `after`, each with the look of row `after` (counted from 0) */
function addRows(rows: Map<number, Row>, step: { after: number; count: number }, prefix: string) {
  const template = rows.get(step.after + 1);
  for (let k = 1; k <= step.count; k++) {
    const n = step.after + 1 + k;
    const had = rows.get(n);
    if (had && [...had.cells.values()].some((c) => /<(\w+:)?(v|is|f)\b/.test(c))) {
      throw new Error(`row ${n} of the sheet is not empty`);
    }
    const open = withoutSpans(shownRow(template?.open ?? `<${prefix}row`).replace(/\sr="\d+"/, ''))
      .replace(new RegExp(`^<${prefix}row`), `<${prefix}row r="${n}"`);
    const cells = new Map<number, string>();
    for (const [col, cell] of template?.cells ?? []) {
      const style = attr(cell, 's');
      cells.set(col, `<${prefix}c r="${letters(col)}${n}"${style ? ` s="${style}"` : ''}/>`);
    }
    rows.set(n, { n, open, cells: had ? had.cells : cells, changed: true, raw: '' });
  }
}

interface CellContext {
  prefix: string;
  merges: Range[];
  dates: DateStyles;
  /** the style of a cell in the column that shows a date, if any cell does */
  columnDate: (col: number) => string | undefined;
}

type CellEdit = Extract<SheetEdit, { kind: 'cell' }>;

/** Write one value into its cell. */
function setCell(rows: Map<number, Row>, step: CellEdit, context: CellContext) {
  const { prefix } = context;
  const n = step.row + 1;
  const row = rows.get(n) ?? { n, open: `<${prefix}row r="${n}"`, cells: new Map(), changed: true, raw: '' };
  rows.set(n, row);
  const old = row.cells.get(step.col);
  const above = rows.get(n - 1)?.cells.get(step.col);
  const ref = `${letters(step.col)}${n}`;
  // a formula is never written over (others may build on it), nor a cell a merge covers, which Excel would not show
  if (old && holdsFormula(old, prefix)) throw new Error(`cell ${ref} holds a formula`);
  if (context.merges.some((merge) => hiddenByMerge(merge, step.col, n))) {
    throw new Error(`cell ${ref} is covered by a merged cell`);
  }
  row.cells.set(step.col, cellXml(step, ref, old, above, context));
  row.changed = true;
  row.open = withoutSpans(row.open);
}

/** The value as a cell, in the look of the cell it replaces, else of the one above. */
function cellXml(
  step: CellEdit,
  ref: string,
  old: string | undefined,
  above: string | undefined,
  context: CellContext,
): string {
  const { prefix, dates } = context;
  const ownStyle = attr(old ?? '', 's');
  let style = ownStyle ?? attr(above ?? '', 's');
  // a date goes in as a date: in the cell's own date format, else, for a cell with no look of its own, in a date format
  // the column uses; otherwise as its text, so a cell styled some other way keeps its look
  const isYmd = step.date && typeof step.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(step.value);
  const ymd = isYmd ? (step.value as string) : '';
  if (ymd && !dates.isDate(style) && ownStyle === undefined) {
    const columnStyle = context.columnDate(step.col);
    if (columnStyle) style = columnStyle;
  }
  if (ymd && dates.isDate(style)) {
    return `<${prefix}c r="${ref}" s="${style}"><${prefix}v>${dates.serial(ymd)}</${prefix}v></${prefix}c>`;
  }
  const styled = style ? ` s="${style}"` : '';
  if (typeof step.value === 'number') {
    return `<${prefix}c r="${ref}"${styled}><${prefix}v>${step.value}</${prefix}v></${prefix}c>`;
  }
  const text = `<${prefix}t xml:space="preserve">${cellText(step.value)}</${prefix}t>`;
  return `<${prefix}c r="${ref}"${styled} t="inlineStr"><${prefix}is>${text}</${prefix}is></${prefix}c>`;
}

/** the rows as the sheet's XML: a row not changed is copied as it was */
function rowsXml(rows: Map<number, Row>, prefix: string): string {
  const rowXml = (row: Row) => {
    if (!row.changed) return row.raw;
    const cells = [...row.cells.entries()].sort((a, b) => a[0] - b[0]).map((c) => c[1]);
    return `${row.open}>${cells.join('')}</${prefix}row>`;
  };
  return [...rows.values()].sort((a, b) => a.n - b.n).map(rowXml).join('');
}

/** where new rows went: below row `after` (counted from 1), `count` of them */
type Grown = { after: number; count: number };

/** a range that ends on a row new rows went below reaches them too, as it would if they were inserted in Excel */
function growRanges(text: string, grown: Grown, pattern: RegExp, close = '') {
  return text.replace(pattern, (whole, start: string, row: string) =>
    Number(row) === grown.after ? `${start}${grown.after + grown.count}${close}` : whole,
  );
}

/** The sheet's own parts that reach the rows new rows went below: color rules, dropdowns and merges. */
function growSheetParts(sheetXml: string, grownRows: Grown[], merges: Range[], prefix: string): string {
  let out = sheetXml;
  // a color rule or a dropdown that ends on that row reaches the new rows too
  const ruleRefs = /(<(?:\w+:)?(?:conditionalFormatting|dataValidation)\b[^>]*\ssqref=")([^"]*)"/g;
  for (const grown of grownRows) {
    out = out.replace(ruleRefs, (_m, start, refs: string) => {
      return `${start}${growRanges(refs, grown, /([A-Z]+\d+:[A-Z]+)(\d+)/g)}"`;
    });
  }
  // a merge across the row new rows copy the look of (two columns that make one) is made on each new row too
  const added: string[] = [];
  for (const grown of grownRows) {
    for (const merge of merges) {
      if (merge.r0 !== grown.after || merge.r1 !== grown.after || merge.c1 <= merge.c0) continue;
      for (let k = 1; k <= grown.count; k++) {
        const row = grown.after + k;
        added.push(`<${prefix}mergeCell ref="${letters(merge.c0)}${row}:${letters(merge.c1)}${row}"/>`);
      }
    }
  }
  if (!added.length) return out;
  const mergeCells = new RegExp(
    `(<${prefix}mergeCells\\b[^>]*?)(?:\\scount="(\\d+)")?([^>]*>)([\\s\\S]*?)(</${prefix}mergeCells>)`,
  );
  return out.replace(mergeCells, (_m, start, count, rest, body, end) => {
    const counted = count ? ` count="${Number(count) + added.length}"` : '';
    return `${start}${counted}${rest}${body}${added.join('')}${end}`;
  });
}

/** Grow only this sheet's qualified references; formulas may also name other sheets or contain quoted text. */
function growNameRanges(body: string, sheet: string, grownRows: Grown[]): string {
  // Numeric entities and bracketed references are outside this matcher; keep their whole definitions unchanged.
  if (body.includes('&#') || body.includes('[')) return body;
  const strings = '(?:"|&quot;)(?:(?:"|&quot;){2}|[^"&]|&(?!quot;))*(?:"|&quot;)';
  const quote = "(?:'|&apos;)";
  const quoted = `${quote}(?:${quote}{2}|[^'&]|&(?!apos;))+${quote}`;
  const qualifier = `(${quoted}|[\\p{L}\\p{N}_][\\p{L}\\p{M}\\p{N}_.]*)`;
  const refs = new RegExp(
    `${strings}|(?<![\\p{L}\\p{M}\\p{N}_.'\\]:])${qualifier}!\\$?[A-Z]+\\$?\\d+:\\$?[A-Z]+\\$?\\d+\\b`,
    'giu',
  );
  return body.replace(refs, (whole, qualified: string | undefined) => {
    if (!qualified) return whole;
    const label = unescapeXml(qualified);
    const name = label.startsWith("'") ? label.slice(1, -1).replace(/''/g, "'") : label;
    if (name.toLowerCase() !== sheet.toLowerCase()) return whole;
    const rangeEnd = /(!\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?)(\d+)\b/gi;
    return grownRows.reduce((text, grown) => growRanges(text, grown, rangeEnd), whole);
  });
}

/** a print area or other name for a range of this sheet that ends on that row reaches the new rows too */
function growNames(zip: ZipPackage, sheet: string, grownRows: Grown[]) {
  const workbook = partText(zip, 'xl/workbook.xml')!;
  const nameTag = /(<(?:\w+:)?definedName\b[^>]*>)([^<]*)(<\/(?:\w+:)?definedName>)/g;
  const names = workbook.replace(nameTag, (_whole, start, body: string, end) =>
    `${start}${growNameRanges(body, sheet, grownRows)}${end}`,
  );
  if (names !== workbook) setPart(zip, 'xl/workbook.xml', names);
}

/** an Excel table that ends on the row new rows go below takes them in, so they keep its banding and filter */
function growTables(zip: ZipPackage, tables: Table[], grownRows: Grown[]) {
  for (const table of tables) {
    if (table.xml === null) continue;
    const ref = /(\sref="[A-Z]+\d+:[A-Z]+)(\d+)"/g;
    const next = grownRows.reduce((xml, grown) => growRanges(xml, grown, ref, '"'), table.xml);
    if (next !== table.xml) setPart(zip, table.target, next);
  }
}

/** the edited workbook's bytes */
export function editXlsx(bytes: Uint8Array, sheet: string, steps: SheetEdit[]): Uint8Array {
  const zip = readZip(bytes);
  const part = sheetPart(zip, sheet);
  const xml = partText(zip, part);
  if (xml === null) throw new Error('the sheet is missing');
  const prefix = prefixOf(xml);
  const sheetData = new RegExp(`<${prefix}sheetData\\b[^>]*?(?:/>|>([\\s\\S]*?)</${prefix}sheetData>)`).exec(xml);
  if (!sheetData) throw new Error('the sheet has no cells');
  const rows = readRows(sheetData[1] ?? '', prefix);
  const dates = dateStyles(zip);
  // the date format a column uses, looked for once per column: an update can write a date into each of 2,000 rows
  const columnDates = new Map<number, string | undefined>();
  const columnDate = (col: number) => {
    if (!columnDates.has(col)) {
      const styles = [...rows.values()].map((row) => attr(row.cells.get(col) ?? '', 's'));
      columnDates.set(col, styles.find((style) => dates.isDate(style)));
    }
    return columnDates.get(col);
  };
  const merges = mergesOf(xml);
  const tables: Table[] = [...rels(zip, part).values()]
    .filter((r) => r.type.endsWith('/table'))
    .map((table) => ({ ...table, xml: partText(zip, table.target) }));
  refuseRowsBelowTotals(steps, tables);
  const grownRows: Grown[] = [];
  for (const step of steps) {
    if (step.kind === 'rows') {
      addRows(rows, step, prefix);
      grownRows.push({ after: step.after + 1, count: step.count });
    } else {
      setCell(rows, step, { prefix, merges, dates, columnDate });
    }
  }
  const newData = `<${prefix}sheetData>${rowsXml(rows, prefix)}</${prefix}sheetData>`;
  let out = xml.slice(0, sheetData.index) + newData + xml.slice(sheetData.index + sheetData[0].length);
  const lastRow = Math.max(0, ...rows.keys());
  const dimension = new RegExp(`(<${prefix}dimension\\b[^>]*\\sref="[A-Z]+\\d+:[A-Z]+)(\\d+)"`);
  out = out.replace(dimension, (whole, start, row) => (Number(row) < lastRow ? `${start}${lastRow}"` : whole));
  setPart(zip, part, growSheetParts(out, grownRows, merges, prefix));
  growNames(zip, sheet, grownRows);
  growTables(zip, tables, grownRows);
  return writeZip(zip);
}

/**
 * Whether a cell of `sheet` (row and column counted from 0) is one an update may not write: one that holds a formula,
 * or one a merged cell covers (editXlsx refuses both). A kept edit's change there is reported rather than written
 *. No cell, when the file can't be read so; editXlsx then says why, when it is written.
 */
export function fixedCells(bytes: Uint8Array, sheet: string): (row: number, col: number) => boolean {
  const formulas = new Set<string>();
  let merges: Range[] = [];
  try {
    const zip = readZip(bytes);
    const xml = partText(zip, sheetPart(zip, sheet)) ?? '';
    const prefix = prefixOf(xml);
    let row = 0;
    for (const m of rowTags(xml, prefix)) {
      row = Number(attr(openingOf(m[0]), 'r') ?? row + 1);
      let col = -1;
      for (const c of cellTags(m[0], prefix)) {
        const ref = attr(c[0], 'r');
        col = ref ? colOf(ref) : col + 1;
        if (holdsFormula(c[0], prefix)) formulas.add(`${row - 1},${col}`);
      }
    }
    merges = mergesOf(xml);
  } catch {
    // not a package this can read
  }
  // a merge is checked as a range: one may cover a whole sheet
  return (row, col) => formulas.has(`${row},${col}`) || merges.some((merge) => hiddenByMerge(merge, col, row + 1));
}
